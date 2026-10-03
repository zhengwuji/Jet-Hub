/**
 * ZCode（智谱 / Z.AI）认证服务：CLI 轮询登录 + 编码套餐凭证换取。
 *
 * ## 与其余 provider 的差异
 *
 * | 维度 | zcode | 对照 |
 * |---|---|---|
 * | 登录 | **服务端中介的 CLI 轮询**（无本地回调端口） | AutoClaw / Accio 要起回调口 |
 * | 凭据 | 登录后**再换一次**推理 API Key | 其余家拿到 token 即可用 |
 * | 续期 | **没有**（恒 false） | raccoon / qoder / trae 都有 |
 * | 余额 | 有（套餐 JWT） | — |
 * | 签到 | 无（替代物是限时套餐领取，需 WebView 验证码） | — |
 *
 * ## 两条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `ZCODE_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CreditBalance, CreditPackage } from './credits.js'
import {
  ZCODE_DEFAULT_POLL_INTERVAL_SEC,
  ZCODE_LOGIN_TIMEOUT_MS,
  ZCODE_REQUEST_TIMEOUT_MS,
  applyZcodeInterstitial,
  newZcodePollToken,
  newZcodeUuid,
  parseZcodeCredential,
  resolveZcodeCodingKey,
  zcodeAccountId,
  zcodeAppVersion,
  zcodeCredentialExpiresAtMs,
  zcodeDisplayName,
  zcodeEnvelopeError,
  zcodePlatform,
  zcodeUrlencode,
  isZcodeRefreshable,
  type ZcodeCredential,
} from './zcode.js'
import { ZCODE, type ZcodeProduct } from './zcode-product.js'

/**
 * 本家**不可续期**：上游没有 refresh 端点。
 *
 * 保留这个类是为了与其余 provider 的导入面一致（`src/refresh.ts` 用
 * `error.name` 而非 `instanceof` 作判据，故 `name` 必须恰为
 * `RefreshTokenExpiredError`）—— 手动点「刷新 Token」时据此提示重新登录。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果（与其余 provider 同构）。 */
export interface ZcodeLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 恒 false（本家不可续期）。 */
  refreshable: boolean
}

/** 只读登录状态。 */
export interface ZcodeLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/** `ZcodeAuth` 的构造选项。 */
export interface ZcodeAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `zcodeAuth` / `zcode-intlAuth`）。 */
  serviceName?: string
}

/** 一条已发起的登录流程（`start` 的返回值）。 */
interface ZcodeCliLogin {
  /** 上游流程 id（轮询路径的一部分） */
  flowId: string
  /** 交给用户打开的授权地址（**已补好中转页参数**） */
  authUrl: string
  /** 上游给的截止时间（unix 秒；0 = 上游没给） */
  expiresAt: number
  /** 轮询间隔（秒） */
  pollIntervalSec: number
  /** 本次流程的 poll token（init 与 poll 共用的 Bearer） */
  pollToken: string
  /** 设备标识（随凭证落盘，跨请求稳定） */
  deviceMid: string
}

/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedZcodeLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<ZcodeCredential>
  /** 取消登录（中止轮询）；**幂等**。 */
  close: () => Promise<void>
}

/** 从任意来源解析凭据；形状不对返回 undefined（不抛错）。 */
export function parseZcodeCredentialValue(value: string): ZcodeCredential | undefined {
  return parseZcodeCredential(value)
}

/** 睡眠（可被 signal 中断）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('登录已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('登录已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 是否已取消。
 *
 * 抽成函数而非内联比较：TS 的控制流分析会把「循环开头检查过、为假才进入 try」
 * 带进 catch 块，从而认定 catch 里的同一个比较**恒为假**（报 TS2367）。
 * 用函数调用切断这条收窄路径，同时保留「await 后重新确认」的正确语义。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** ZCode 认证服务。 */
export class ZcodeAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: ZcodeProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次操作失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；stop() 置 false，防止在途流程回写。 */
  private active = true

  constructor(ctx: Context, private readonly options: ZcodeAuthOptions = {}) {
    const product = options.product ?? ZCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  // ── 登录 ────────────────────────────────────────────────────────

  /**
   * 发起登录：拿到 `flow_id` 与**可直接交给用户打开**的授权地址。
   *
   * 登录时机还没有任何账号上下文，因此**直连**（与其余各家的登录链路同一
   * 取舍：账号级代理是给转发长请求准备的出口）。
   */
  private async initLogin(): Promise<ZcodeCliLogin> {
    const pollToken = newZcodePollToken()
    const url = `${this.product.zcodeOrigin}/api/v1/oauth/cli/init`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${pollToken}`,
          'content-type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ provider: this.product.upstreamProvider }),
        signal: AbortSignal.timeout(ZCODE_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`ZCode 登录发起失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('ZCode 登录发起：上游响应不是 JSON')
    }
    const envelope = zcodeEnvelopeError(payload)
    if (envelope !== undefined) throw new Error(`ZCode 登录发起失败：${envelope}`)
    if (!response.ok) throw new Error(`ZCode 登录发起失败（HTTP ${response.status}）`)

    const data = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).data : undefined
    if (typeof data !== 'object' || data === null) throw new Error('ZCode 登录发起：响应缺少 data')
    const record = data as Record<string, unknown>
    const flowId = typeof record.flow_id === 'string' ? record.flow_id.trim() : ''
    const authorizeUrl = typeof record.authorize_url === 'string' ? record.authorize_url.trim() : ''
    if (flowId.length === 0) throw new Error('ZCode 登录响应缺少 flow_id')
    if (authorizeUrl.length === 0) throw new Error('ZCode 登录响应缺少 authorize_url')

    // expires_at / poll_interval_sec 缺失时给兜底值而不是报错：
    // 它们是「调度建议」而非凭证本身，为它们失败会让一次本可成功的登录白跑
    //（本地已有 5 分钟总超时兜底，不会因此无限轮询）。
    const expiresAt = typeof record.expires_at === 'number' ? record.expires_at : 0
    const rawInterval = typeof record.poll_interval_sec === 'number' ? record.poll_interval_sec : 0
    const pollIntervalSec = rawInterval > 0 ? rawInterval : ZCODE_DEFAULT_POLL_INTERVAL_SEC

    return {
      flowId,
      authUrl: applyZcodeInterstitial(this.product, authorizeUrl),
      expiresAt,
      pollIntervalSec,
      pollToken,
      deviceMid: newZcodeUuid(),
    }
  }

  /**
   * 轮询一次。
   *
   * 返回 `undefined` = 还没授权完，继续等；返回凭据 = 成功；
   * 抛错 = **致命**失败（语义见下）。
   *
   * 错误语义（照抄参考实现，别自己发明）：
   * - 5xx / 网络错误 / 200 但响应体畸形 → 当 pending（「这次没问成」）；
   * - 408 / 429 → 也当 pending（同属「这次没问成」）；
   * - 其余 4xx、信封 `code != 0`、`status: failed` → **致命**。
   */
  private async pollOnce(login: ZcodeCliLogin): Promise<ZcodeCredential | undefined> {
    const url = `${this.product.zcodeOrigin}/api/v1/oauth/cli/poll/${login.flowId}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${login.pollToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(ZCODE_REQUEST_TIMEOUT_MS),
      })
    } catch {
      // 网络错误当 pending：一次没问成不是「被拒」
      return undefined
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) return undefined

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      // 200 但响应体畸形 → pending
      return undefined
    }
    const envelope = zcodeEnvelopeError(payload)
    if (envelope !== undefined) throw new Error(`ZCode 登录失败：${envelope}`)
    if (response.status >= 400) {
      throw new Error(`ZCode 登录轮询被拒（HTTP ${response.status}）`)
    }

    const data = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).data : undefined
    if (typeof data !== 'object' || data === null) return undefined
    const record = data as Record<string, unknown>
    const status = typeof record.status === 'string' ? record.status : ''
    if (status === 'failed') throw new Error('ZCode 授权被拒绝或已失效，请重新发起登录')
    if (status !== 'ready') {
      // pending / 其它认不出的 status：参考实现把「认不出的 status」记为致命，
      // 这里从宽当 pending —— 上游将来可能新增中间态，把中间态当失败会让登录
      // 在升级后的上游上整体不可用；而本地有 5 分钟总超时，不会无限等。
      return undefined
    }

    // `status: "ready"`：三个字段来自三个位置
    const providerKey = this.product.upstreamProvider
    const providerNode = record[providerKey]
    const accessToken = typeof providerNode === 'object' && providerNode !== null
      ? (providerNode as Record<string, unknown>).access_token : undefined
    const oauthToken = typeof accessToken === 'string' ? accessToken.trim() : ''
    if (oauthToken.length === 0) {
      throw new Error(`ZCode 登录响应缺少 ${providerKey}.access_token`)
    }
    const jwt = typeof record.token === 'string' ? record.token.trim() : ''
    const userNode = record.user
    const userId = typeof userNode === 'object' && userNode !== null
      ? (userNode as Record<string, unknown>).user_id : undefined

    // ⚠️ **必须再换一次推理凭证**：OAuth 的 access_token 不是推理凭证，
    // 直接拿去打 /chat/completions 必 401。换取失败即登录失败，不落半条账号。
    const inferenceKey = await resolveZcodeCodingKey(this.product, oauthToken, this.fetchImpl)

    const credential: ZcodeCredential = {
      access_token: inferenceKey,
      ...jwt.length > 0 ? { jwt } : {},
      device_mid: login.deviceMid,
      ...typeof userId === 'string' && userId.trim().length > 0 ? { user_id: userId.trim() } : {},
      provider: this.product.id,
    }
    const expiresAt = zcodeCredentialExpiresAtMs(credential)
    return expiresAt === undefined ? credential : { ...credential, expires_at: expiresAt }
  }

  /**
   * **两步式登录**：立即返回登录 URL，由调用方先打开窗口。
   *
   * ⚠️ **不得改回阻塞式**（等用户授权完才返回）—— 那时浏览器手势早已过期，
   * `window.open` 必被拦截，且前端会退化成导航跳转，**把整个设置页导航到
   * 外部登录页**（AGENTS.md 记录的真实缺陷）。
   */
  async startLogin(): Promise<StartedZcodeLoginFlow> {
    this.active = true
    const login = await this.initLogin()
    const controller = new AbortController()

    const result = (async (): Promise<ZcodeCredential> => {
      const intervalMs = Math.max(1, login.pollIntervalSec) * 1000
      // 总超时取「本地 5 分钟」与「上游 expires_at」的较小者：
      // 上游到点后会直接作废这个 flow，继续轮询只是白跑。
      const upstreamDeadline = login.expiresAt > 0 ? login.expiresAt * 1000 : Number.POSITIVE_INFINITY
      const deadline = Math.min(Date.now() + ZCODE_LOGIN_TIMEOUT_MS, upstreamDeadline)
      while (Date.now() < deadline) {
        if (isAborted(controller.signal)) throw new Error('登录已取消')
        const credential = await this.pollOnce(login)
        if (credential !== undefined) return credential
        await sleep(intervalMs, controller.signal)
      }
      throw new Error('ZCode 登录等待已超时，请重新发起登录')
    })()
    // 这个 Promise 是手工创建的、要过一会儿才交给调用方消费，期间可能已被
    // reject。先挂空处理器避免 Node 报「未处理的拒绝」，不影响真正的消费者。
    result.catch(() => {})

    let closed = false
    return {
      loginUrl: login.authUrl,
      result,
      close: async (): Promise<void> => {
        if (closed) return
        closed = true
        controller.abort()
      },
    }
  }

  /**
   * 把登录结果落盘成凭据。
   *
   * ⚠️ 与其余 provider 的差别：本家**没有**登录后自动领奖的步骤
   * （套餐领取需要桌面端 WebView 铸造的验证码令牌，宿主侧做不到）。
   */
  async persistLogin(
    credential: ZcodeCredential,
    flowOptions: { refName?: string } = {},
  ): Promise<ZcodeLoginResult> {
    const refName = flowOptions.refName ?? this.credentialRefName
    const enriched: ZcodeCredential = { ...credential, provider: this.product.id }
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(enriched))
    this.lastRefreshError = undefined
    return {
      access: JSON.stringify(enriched),
      expires: zcodeCredentialExpiresAtMs(enriched) ?? 0,
      ref,
      loginUrl: '',
      // ⚠️ 恒 false：本家无续期端点。
      refreshable: false,
    }
  }

  // ── 状态与续期 ──────────────────────────────────────────────────

  /** 只读登录状态。 */
  async status(): Promise<ZcodeLoginStatus> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return { configured: false, refreshable: false }
    const credential = parseZcodeCredential(resolved.value)
    if (credential === undefined) return { configured: false, refreshable: false }
    return {
      configured: true,
      source: this.credentialRefName,
      ...zcodeCredentialExpiresAtMs(credential) === undefined
        ? {} : { expiresAt: zcodeCredentialExpiresAtMs(credential) },
      refreshable: isZcodeRefreshable(credential),
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 续期默认单凭据。
   *
   * ⚠️ 本家**不可续期**：如实报错让用户重新登录，而不是留一个「刷新了但没变」
   * 的假实现 —— 后者会让编排层的「401 后刷新重试一次」变成「用同一个坏 token
   * 再打一次」。
   */
  async refresh(): Promise<void> {
    this.lastRefreshError = 'ZCode 的登录态无法自动续期，请重新登录该账号'
    throw new RefreshTokenExpiredError(this.lastRefreshError)
  }

  /**
   * 按凭据 ref 处理**指定账号**。
   *
   * ⚠️ 本家没有续期端点，故这里的语义是「**有效性探测 + 如实报错**」
   * （与 Loomy 同型，与 raccoon 的「真续期」相反）。仍须只读写传入的 ref ——
   * 否则「刷新这个账号」实际刷的是另一个凭据。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseZcodeCredential(resolved.value)
    if (credential === undefined) throw new Error('凭据解析失败')
    if (credential.access_token.trim().length === 0) {
      throw new RefreshTokenExpiredError('凭据缺少访问令牌，请重新登录')
    }
    // 本家无 refresh 端点：如实告知，不假装续了一次。
    throw new RefreshTokenExpiredError('ZCode 的登录态无法自动续期，请重新登录该账号')
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * ⚠️ 本家恒不可续期，故这里是**空操作**。保留方法只为与其余 provider 形态
   * 一致 —— 否则 `refreshAllCredentials()` 得为它加特例分支。
   *
   * ⚠️ 仍只按 `refreshable` 过滤（不碰 `enabled`），理由见 AGENTS.md。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      // 本家无续期端点：把「可续期」这个错误标记纠正掉，避免调度器每轮白试。
      try {
        await pool.updateAccount(entry.id, { refreshable: false })
      } catch {
        // 忽略：标记纠正失败不影响其它账号
      }
    }
  }

  /** 移除已存储的凭据。 */
  async logout(): Promise<void> {
    this.active = false
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /** 停止（不清理凭据）。 */
  stop(): void {
    this.active = false
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供 e2e 探针与 `account-probe` 使用。
   */
  async resolveStoredCredential(): Promise<ZcodeCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    return resolved === undefined ? undefined : parseZcodeCredential(resolved.value)
  }

  /** 本产品下某凭据的展示名（供 RPC 落账号时回填昵称）。 */
  displayNameFor(credential: ZcodeCredential): string {
    return zcodeDisplayName(this.product, credential)
  }
  /** 本产品下某凭据的账号 id（供 RPC 落账号时生成主键）。 */
  accountIdFor(credential: ZcodeCredential): string {
    return zcodeAccountId(this.product, credential.user_id ?? '')
  }

  /** 登录会话是否仍活跃（供在途流程自查）。 */
  isActive(): boolean {
    return this.active
  }

  /**
   * 查询套餐余额（`GET {zcode}/api/v1/zcode-plan/billing/balance`）。
   *
   * ⚠️ 走的是**套餐 JWT + X-Device-Mid**，与推理用的 `access_token` 不是一套
   * 凭证：缺 JWT 时返回 `null`（由 UI 显示「积分查询失败」而不是编一个 0 ——
   * 0 是「已用光」的语义）。
   *
   * 归一成 Jet Hub 的 {@link CreditBalance}：**逐桶一项**（不合并），
   * 剩余取值链 `remaining_units` → `total - used` → `available_units`。
   */
  async fetchCreditBalance(credential: ZcodeCredential): Promise<CreditBalance | null> {
    const jwt = credential.jwt?.trim() ?? ''
    if (jwt.length === 0) return null

    const query = `?app_version=${zcodeUrlencode(zcodeAppVersion())}&platform=${zcodeUrlencode(zcodePlatform())}`
    const url = `${this.product.zcodeOrigin}/api/v1/zcode-plan/billing/balance${query}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
    }
    // ⚠️ 缺 X-Device-Mid 或值非 UUID 形态 → 400 {"code":3001}，故「有值才发」。
    const deviceMid = credential.device_mid?.trim() ?? ''
    if (deviceMid.length > 0) headers['X-Device-Mid'] = deviceMid

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(ZCODE_REQUEST_TIMEOUT_MS),
      })
    } catch {
      return null
    }
    if (!response.ok) return null
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return null
    }
    if (zcodeEnvelopeError(payload) !== undefined) return null

    const data = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).data : undefined
    if (typeof data !== 'object' || data === null) return null
    const record = data as Record<string, unknown>
    const serverTime = typeof record.server_time === 'number' ? record.server_time : Date.now() / 1000

    // 已过期套餐的桶要整条丢掉：它们的 `status` 可能仍是 `active`，
    // 但 `ends_at` 已过（上游不主动改状态）。
    const expiredPlans = new Set<string>()
    const plans = Array.isArray(record.plans) ? record.plans : []
    for (const item of plans) {
      if (typeof item !== 'object' || item === null) continue
      const plan = item as Record<string, unknown>
      const status = typeof plan.status === 'string' ? plan.status : ''
      const endsAt = typeof plan.ends_at === 'number' ? plan.ends_at : 0
      if (status === 'active' && endsAt > 0 && endsAt <= serverTime) {
        const key = typeof plan.user_plan_id === 'string' ? plan.user_plan_id
          : typeof plan.plan_id === 'string' ? plan.plan_id : ''
        if (key.length > 0) expiredPlans.add(key)
      }
    }

    const packages: CreditPackage[] = []
    let total = 0
    const balances = Array.isArray(record.balances) ? record.balances : []
    for (const item of balances) {
      if (typeof item !== 'object' || item === null) continue
      const bucket = item as Record<string, unknown>
      const owner = typeof bucket.user_plan_id === 'string' ? bucket.user_plan_id
        : typeof bucket.plan_id === 'string' ? bucket.plan_id : ''
      // 认不出归属的桶保留（宁可多显示一项，也不要吞掉用户的额度）
      if (owner.length > 0 && expiredPlans.has(owner)) continue

      const totalUnits = typeof bucket.total_units === 'number' ? bucket.total_units : 0
      const usedUnits = typeof bucket.used_units === 'number' ? bucket.used_units : 0
      const remaining = typeof bucket.remaining_units === 'number' ? bucket.remaining_units
        : totalUnits > 0 ? totalUnits - usedUnits
        : typeof bucket.available_units === 'number' ? bucket.available_units : 0
      const showName = typeof bucket.show_name === 'string' && bucket.show_name.length > 0
        ? bucket.show_name
        : typeof bucket.bucket_id === 'string' ? bucket.bucket_id : '额度'
      const unit = typeof bucket.unit_type === 'string' && bucket.unit_type.length > 0
        ? bucket.unit_type : 'credit'
      packages.push({
        name: showName,
        unit,
        remaining,
        total: totalUnits,
        used: usedUnits,
        active: true,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '',
      })
      total += remaining
    }

    if (packages.length === 0) {
      // 无桶 = 「无额度」，如实给 0 与空明细（不是查询失败）。
      return { total: 0, packages: [], expiredTotal: 0 }
    }
    return { total, packages, expiredTotal: 0 }
  }
}
