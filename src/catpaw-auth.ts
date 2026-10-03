/**
 * CatPaw（美团）认证服务：passport 会话 + loopback 回调（**两步式**）。
 *
 * ## 登录协议（逆向自桌面端，逐条已实测）
 *
 * ```text
 * ① GET  {gateway}/api/gateway/passport/login-config        （无需鉴权）
 *      → data.loginEntryUrl
 * ② 把 loginEntryUrl 拼上三个 query 参数交给浏览器打开：
 *      ?state=<本地随机>&redirect=<loopback 地址>&sid=<本地随机>
 *    上游 302 → 美团 passport 登录 → settoken → login-callback
 * ③ 登录完成后，上游页面把 {token, state} **POST 到 redirect 地址**
 * ④ 我们校验 state 后把 token 落账号
 * ```
 *
 * ## ⚠️ 两条通道都要做（`Promise.race` 的服务端等价物）
 *
 * 官方客户端是 `Promise.race([loopback, poll-token])` —— 两条通道赛跑，谁先到
 * 用谁。只做 loopback 是**不够的**：那次 POST 是**从公网页面发往本机 127.0.0.1
 * 的跨源请求**，浏览器会做私有网络检查（PNA）。因此我们**必须**在回调响应里
 * 回 `Access-Control-Allow-Origin: *` 与 `Access-Control-Allow-Private-Network:
 * true`，否则 POST 被浏览器挡在门外：用户看到上游的「登录成功」页、窗口一直
 * 不关、网关永远等不到凭证。
 *
 * 即便如此仍保留 **poll-token 兜底**：它走**服务端到服务端**，不经浏览器，
 * 因此不受任何 CORS / PNA 策略影响。两条通道共用一把任务锁：先到的落账号并置
 * done，后到的那条看到 done 就静默退出（不会重复落账号，也不会把成功盖成失败）。
 *
 * ## ⚠️ 本家**无法续期**（与 Loomy 同型，与 raccoon / trae 相反）
 *
 * 上游**没有 refreshToken、也没有 refresh 端点**。凭据过期（上游回 401）的
 * 唯一恢复路径是**用户在桌面端重新登录**。因此：
 *
 * - `isCatpawRefreshable` 恒 false；
 * - `refresh()` / `refreshAccountCredential()` 的语义是「**如实报错让用户重新
 *   登录**」而不是「去换一个新 token」—— 假装能续期只会让调度器反复打一个不
 *   存在的端点；
 * - `refreshAll()` 只按 `refreshable` 过滤（**绝不看 `enabled`**，见 AGENTS.md），
 *   并把误标的 `refreshable: true` 纠正为 false。
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CreditBalance, CreditPackage } from './credits.js'
import {
  catpawCredentialExpiresAtMs,
  catpawRequestHeaders,
  isCatpawRefreshable,
  parseCatpawCredential,
  unwrapCatpawApiData,
  type CatpawCredential,
  type CatpawRemoteModel,
} from './catpaw.js'
import { CATPAW, type CatpawProduct } from './catpaw-product.js'

/** 默认凭据 ref 名称（与 `CatpawProduct.defaultCredentialRef` 一致）。 */
export const CATPAW_CREDENTIAL_REF = 'CATPAW_ACCESS_TOKEN'

/** 回调路径（挂在本进程的临时 loopback 服务器上）。 */
export const CATPAW_CALLBACK_PATH = '/api/session/login/catpaw-callback'

/** 登录整体超时（毫秒）。 */
export const CATPAW_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 短请求超时（毫秒）：登录入口 / 当前用户 / 模型目录。 */
const REQUEST_TIMEOUT_MS = 20_000

/** poll-token 单拍超时（毫秒）：轮询口本身是轻查询，给太长会把 1 秒间隔拖长。 */
const POLL_TIMEOUT_MS = 5_000

/** poll-token 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 1_000

/** 模型目录缓存有效期（毫秒）。 */
const MODELS_TTL_MS = 15 * 60 * 1000

/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface CatpawLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（**恒 0**：本家没有过期时间字段）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 恒为 `false`（本家无续期机制）。 */
  refreshable: boolean
}

/** 只读登录状态。 */
export interface CatpawLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 恒为 `false`（本家无续期机制）。 */
  refreshable: boolean
  refreshError?: string
}

/** `startLogin` 的选项。 */
export interface CatpawStartLoginOptions {
  /** 覆盖落盘用的凭据 ref 名。 */
  refName?: string
}

/** 一次登录流程的句柄。 */
export interface StartedCatpawLoginFlow {
  /** 弹窗地址（上游登录入口 + 三个 query 参数）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<CatpawCredential>
  /** 主动关闭本地回调服务器。 */
  close: () => Promise<void>
}

/** `CatpawAuth` 的构造选项。 */
export interface CatpawAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link CATPAW}。 */
  product?: CatpawProduct
  /** 服务名覆盖（默认 `catpawAuth`）。 */
  serviceName?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CatPaw 的认证服务实例。 */
    catpawAuth: CatpawAuth
  }
}

/**
 * CatPaw 认证服务：passport 登录 + 只读状态 + **不可续期**的诚实报错。
 */
export class CatpawAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: CatpawProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次续期/探测失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 模型目录缓存（**含空结果**，避免未登录时反复打上游）。 */
  private modelsCache: { models: CatpawRemoteModel[]; at: number } | undefined

  constructor(ctx: Context, private readonly options: CatpawAuthOptions = {}) {
    const product = options.product ?? CATPAW
    super(ctx, options.serviceName ?? 'catpawAuth')
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  // ─── 登录 ────────────────────────────────────────────────────────

  /**
   * 启动登录：起本地回调服务器并**立即返回 `loginUrl`**。
   *
   * ⚠️ **不得改回阻塞式**（等用户授权完才返回）—— 那时浏览器手势早已过期，
   * `window.open` 必被拦截，且前端会退化成导航跳转，把整个设置页导航到外部
   * 登录页。这是 AGENTS.md 的硬性约定。
   */
  async startLogin(options: CatpawStartLoginOptions = {}): Promise<StartedCatpawLoginFlow> {
    // ① 取登录入口地址（无需鉴权）
    const loginEntryUrl = await this.fetchLoginEntry()

    // ② 本地回调服务器：端口用本进程的一个空闲端口
    const state = randomHex()
    const sid = randomHex()
    let resolveResult!: (value: CatpawCredential) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<CatpawCredential>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快失败/立刻关闭），
    // 那一段窗口里 Node 会报 unhandled rejection。
    result.catch(() => {})

    let settled = false
    const settleOk = (credential: CatpawCredential): void => {
      if (settled) return
      settled = true
      resolveResult(credential)
    }
    const settleErr = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectResult(error)
    }

    const server = createServer((request, response) => {
      void this.handleCallback(request, response, state, settleOk).catch((error: unknown) => {
        try {
          response
            .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // 响应可能已发出，忽略
        }
      })
    })
    const port = await listenOnRandomPort(server)
    const redirect = `http://127.0.0.1:${port}${CATPAW_CALLBACK_PATH}`

    // ③ 拼 loginEntryUrl + query（**顺序即此**：state → redirect → sid）
    const url = new URL(loginEntryUrl)
    url.searchParams.append('state', state)
    url.searchParams.append('redirect', redirect)
    url.searchParams.append('sid', sid)

    // ④ poll-token 兜底通道（服务端到服务端，不受 CORS / PNA 影响）
    void this.runPollToken(sid, settleOk, () => settled)

    let closed = false
    const closeServer = async (): Promise<void> => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    const close = async (): Promise<void> => {
      // 尚未落定则先 reject，避免调用方拿到一个永远悬挂的 promise。
      settleErr(new Error('catpaw: 登录流程已关闭'))
      await closeServer()
    }

    const timer = setTimeout(() => {
      settleErr(new Error('CatPaw 网页登录超时，请重新发起'))
    }, CATPAW_LOGIN_TIMEOUT_MS)
    timer.unref?.()

    void result
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        void closeServer()
      })

    return { loginUrl: url.toString(), result, close }
  }

  /** 取登录入口地址（`login-config`，无需鉴权）。 */
  private async fetchLoginEntry(): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.gatewayBase}/api/gateway/passport/login-config`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(
        `无法连接 CatPaw 登录服务: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) throw new Error(`CatPaw 登录服务返回 HTTP ${response.status}`)
    const payload = await response.json().catch(() => undefined) as unknown
    const unwrapped = unwrapCatpawApiData(payload)
    if (!unwrapped.ok) throw new Error(unwrapped.message)
    const data = typeof unwrapped.data === 'object' && unwrapped.data !== null
      ? unwrapped.data as Record<string, unknown>
      : {}
    const entry = data.loginEntryUrl
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('CatPaw 登录服务未返回登录入口地址')
    }
    return entry.trim()
  }

  /**
   * 处理 loopback 回调（POST `application/x-www-form-urlencoded`，兼容 JSON）。
   *
   * ⚠️ **必须回 `Access-Control-Allow-Origin: *` 与
   * `Access-Control-Allow-Private-Network: true`** —— 见模块头：这是公网页面 →
   * `127.0.0.1` 的跨源 POST，缺这两个头会被浏览器的私有网络检查（PNA）拦掉。
   */
  private async handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
    expectedState: string,
    settleOk: (credential: CatpawCredential) => void,
  ): Promise<void> {
    // PNA 预检：浏览器可能先发一个 OPTIONS。必须放行，否则真正的 POST 不会发出。
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders()).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Method not allowed')
      return
    }
    const body = await readRequestBody(request)
    const params = parseCallbackBody(body, request.headers['content-type'] ?? '')
    const token = params.token?.trim() ?? ''
    const state = params.state?.trim() ?? ''
    if (token.length === 0 || state.length === 0 || state !== expectedState) {
      // state 逐字比对：回调落在本机 HTTP 端口上，任何本机进程都能伪造一个 POST，
      // 不校验就等于「用别人的 token 写进你的账号库」。
      response.writeHead(400, { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' })
        .end('登录校验失败：state 不匹配或缺少 token')
      return
    }
    settleOk({ access_token: token })
    response
      .writeHead(200, { ...corsHeaders(), 'Content-Type': 'text/html; charset=utf-8' })
      .end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<title>登录成功</title></head><body>登录成功，已返回网关，可以关闭此页面。</body></html>')
  }

  /**
   * poll-token 兜底通道（每 1 秒问一次，直到落定或超时）。
   *
   * 契约为客户端 `pollForToken` 的同一份（已实测）：
   * - 未就绪 → `{code:0, data:null}`，继续等；
   * - 就绪 → `data` **直接是 token 字符串**（不再包一层结构）；
   * - 网络错误单拍忽略（客户端也是 `try/catch` 后继续）。
   *
   * ⚠️ **落定判定必须与 loopback 共用**（`isSettled`）：两条通道都可能在等，
   * 先到者落账号，后到者看到 done 就静默退出。
   */
  private async runPollToken(
    sid: string,
    settleOk: (credential: CatpawCredential) => void,
    isSettled: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + CATPAW_LOGIN_TIMEOUT_MS
    for (;;) {
      if (isSettled()) return
      if (Date.now() >= deadline) return
      await delay(POLL_INTERVAL_MS)
      if (isSettled()) return
      let response: Response
      try {
        response = await this.fetchImpl(
          `${this.product.gatewayBase}/api/gateway/passport/poll-token?sid=${encodeURIComponent(sid)}`,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
          },
        )
      } catch {
        continue // 单拍网络错误忽略继续（客户端同）
      }
      if (!response.ok) continue
      const payload = await response.json().catch(() => undefined) as unknown
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined
      const token = record?.data
      if (typeof token !== 'string' || token.trim().length === 0) continue
      settleOk({ access_token: token.trim() })
      return
    }
  }

  /**
   * 把登录结果落盘成凭据（并尽力补 uid / 昵称）。
   *
   * `current-user` 失败**不算登录失败**：token 本身已经到手，uid 缺失时账号 id
   * 会回落到 loginName 或匿名串，最坏情况是备注名稍差一点，不该因此把一次成功
   * 登录判死。
   */
  async persistLogin(
    credential: CatpawCredential,
    options: { refName?: string } = {},
  ): Promise<CatpawLoginResult> {
    const refName = options.refName ?? this.credentialRefName
    let enriched = credential
    if (credential.uid === undefined || credential.login_name === undefined) {
      const profile = await this.fetchCurrentUser(credential.access_token)
      enriched = {
        ...credential,
        ...profile.uid !== undefined && credential.uid === undefined ? { uid: profile.uid } : {},
        ...profile.userName !== undefined && credential.login_name === undefined
          ? { login_name: profile.userName } : {},
        ...profile.userName !== undefined && credential.nickname === undefined
          ? { nickname: profile.userName } : {},
        provider: credential.provider ?? this.product.id,
      }
    }
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(enriched))
    this.lastRefreshError = undefined
    // 新凭据落地 → 作废模型缓存，让新登录的账号立刻能列出模型
    this.modelsCache = undefined
    return {
      access: JSON.stringify(enriched),
      expires: catpawCredentialExpiresAtMs(enriched) ?? 0,
      ref,
      refreshable: isCatpawRefreshable(enriched),
    }
  }

  /**
   * 补 uid / 昵称（`current-user`）。
   *
   * 头是 **`X-Auth-Token`**（不是 `X-Passport-Token`）：网关域下只有它认。
   * 失败返回空对象（**不算登录失败**，见 `persistLogin`）。
   */
  private async fetchCurrentUser(token: string): Promise<{ uid?: string; userName?: string }> {
    try {
      const response = await this.fetchImpl(
        `${this.product.gatewayBase}/api/gateway/passport/current-user`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Auth-Token': token },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      )
      if (!response.ok) return {}
      const payload = await response.json().catch(() => undefined) as unknown
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined
      const data = typeof record?.data === 'object' && record.data !== null
        ? record.data as Record<string, unknown>
        : undefined
      if (data === undefined) return {}
      const out: { uid?: string; userName?: string } = {}
      // `userId` 可能是数字或字符串，两种都收（客户端也做 String() 转换）。
      const rawUid = data.userId
      const uid = typeof rawUid === 'string'
        ? rawUid.trim()
        : typeof rawUid === 'number' && Number.isFinite(rawUid)
          ? String(rawUid)
          : ''
      if (uid.length > 0 && uid !== 'null') out.uid = uid
      if (typeof data.userName === 'string' && data.userName.trim().length > 0) {
        out.userName = data.userName.trim()
      }
      return out
    } catch {
      return {}
    }
  }

  // ─── 状态与续期 ──────────────────────────────────────────────────

  /** 只读登录状态。 */
  async status(): Promise<CatpawLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = catpawCredentialExpiresAtMs(credential)
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === undefined ? {} : { expiresAt },
      refreshable: false,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 解析默认 ref 的凭据。 */
  private async resolveDefaultCredential(): Promise<CatpawCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      return resolved === undefined ? undefined : parseCatpawCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /**
   * 「续期」默认单凭据 —— ⚠️ **本家没有可续期的东西**。
   *
   * 语义是**如实报错让用户重新登录**（与 Loomy 同型）：上游没有 refreshToken、
   * 没有 refresh 端点，凭据过期的唯一恢复路径是用户在桌面端重新登录。
   *
   * @throws {RefreshTokenExpiredError} 恒抛（除凭据未配置时抛普通错误）。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new Error('CatPaw 凭据未配置，请先登录')
    const message = 'CatPaw 登录态无法自动续期：上游没有刷新端点，请在客户端重新登录后重新导入'
    this.lastRefreshError = message
    throw new RefreshTokenExpiredError(message)
  }

  /**
   * 「续期」**指定 ref**（账号卡片「刷新」按钮 / 定时器）。
   *
   * ⚠️ **只读写传入的 ref**，不碰默认单凭据 ref —— 账号池里的是
   * `CATPAW_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
   *
   * 语义同 {@link refresh}：本家不可续期，如实报错。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('CatPaw 凭据未配置')
    const credential = parseCatpawCredential(resolved.value)
    if (credential === undefined) throw new Error('CatPaw 凭据解析失败')
    throw new RefreshTokenExpiredError(
      'CatPaw 登录态无法自动续期：上游没有刷新端点，请在客户端重新登录后重新导入',
    )
  }

  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**（AGENTS.md 铁律：停用只影响
   * 账号池的自动选号，与「凭据是否需要保持新鲜」无关）。
   *
   * 本家的 `refreshable` 恒为 false，因此这个方法实际做的事是**把误标的
   * `refreshable: true` 纠正为 false**（历史数据或手工导入可能标错），
   * 免得 UI 一直显示一个永远不会生效的「可续期」。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    let accounts: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      accounts = await pool.listAccounts(this.product.id)
    } catch {
      return
    }
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        await pool.updateAccount(entry.id, { refreshable: false })
        this.ctx.logger?.info?.(
          `[catpaw] 账号 ${entry.id} 被标记为可续期，但本家无刷新端点，已纠正为不可续期`,
        )
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[catpaw] 纠正账号 ${entry.id} 的续期标记失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /** 登出：清除默认单凭据。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
    this.modelsCache = undefined
  }

  /**
   * 停止认证服务生命周期。
   *
   * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
   * 本家没有独立的定时器（续期恒不可用），故实现为空。
   */
  stop(): void {
    // 无独立定时器：登录用的临时服务器由 `startLogin` 的 result 自行关闭。
  }

  // ─── 模型目录 ────────────────────────────────────────────────────

  /**
   * 拉取远端模型目录（`POST {inferBase}/api/agent/maas/model-types`）。
   *
   * ⚠️ 请求体是 **POST JSON**（`tenant/scene/env` 不是 query 参数 —— 早期把它当
   * GET 的 query 看，于是得出了「上游没有目录接口」的错误结论）。域名是**桌面端
   * 直连域名** `ai.catpaw.meituan.com`（不是网关域名）。
   *
   * 三条契约：
   * - **TTL 15 分钟**（上游桌面端自己用 5 分钟；我们比客户端更频地打上游没有收益，
   *   而这一列信息变化极慢）；
   * - **失败保留旧清单**（不清空，与 AutoClaw / 小浣熊同一取向）；
   * - **无凭证返回空数组（非错误）**：未登录是常见情形，报错会制造噪声。
   */
  async fetchModels(pool?: AccountPool): Promise<CatpawRemoteModel[]> {
    const cached = this.modelsCache
    if (cached !== undefined && Date.now() - cached.at < MODELS_TTL_MS) return cached.models

    const credential = await this.resolveForFetchModels(pool)
    if (credential === undefined || credential.access_token.trim().length === 0) {
      // 无凭证：返回空数组（**不是错误**），但**不写缓存** —— 否则登录后要等
      // 15 分钟才能看到模型。
      return []
    }

    try {
      const response = await this.fetchImpl(
        `${this.product.inferBase}/api/agent/maas/model-types`,
        {
          method: 'POST',
          headers: catpawRequestHeaders(credential, { accept: 'application/json' }),
          body: JSON.stringify({ tenant: 'CatDesk', scene: 'CATX_APP', env: 'EXTERNAL' }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        this.warn(`fetchModels: HTTP ${response.status} ${response.statusText}`)
        return this.modelsCache?.models ?? []
      }
      const payload = await response.json().catch(() => undefined) as unknown
      const unwrapped = unwrapCatpawApiData(payload)
      if (!unwrapped.ok) {
        this.warn(`fetchModels: ${unwrapped.message}`)
        return this.modelsCache?.models ?? []
      }
      const entries = Array.isArray(unwrapped.data) ? unwrapped.data : []
      const models = entries
        .map((entry) => normalizeRemoteModel(entry))
        .filter((model): model is CatpawRemoteModel => model !== undefined)
      this.modelsCache = { models, at: Date.now() }
      return models
    } catch (error) {
      this.warn(`fetchModels: ${error instanceof Error ? error.message : String(error)}`)
      return this.modelsCache?.models ?? []
    }
  }

  /** 取一个可用凭据（先账号池，再默认 ref）。 */
  private async resolveForFetchModels(pool?: AccountPool): Promise<CatpawCredential | undefined> {
    if (pool !== undefined) {
      try {
        const available = await pool.getAvailableAccount(this.product.id, '')
        if (available !== null && available !== undefined) {
          const credential = parseCatpawCredential(available.credential)
          if (credential !== undefined) return credential
        }
      } catch {
        // 落到默认 ref
      }
    }
    return this.resolveDefaultCredential()
  }

  /** 记录一条警告（经 `ctx.logger`，**仅失败路径**调用）。 */
  private warn(message: string): void {
    this.ctx.logger?.warn?.(`[catpaw] ${message}`)
  }

  // ─── 积分余额 ────────────────────────────────────────────────────

  /**
   * 查询积分余额（客户端自己的网关 API）。
   *
   * ## ⚠️ 头**只认 `X-Auth-Token`**
   *
   * 实测 `X-Passport-Token` / `Cookie` / `Authorization` 在这个域名下**全部 401**。
   * 这是本家最容易写错的一处：转发链路（推理）用的是 `Cookie: X-Passport-Token`，
   * 而积分端点认的是另一个头 —— 照抄转发链路的头会得到「模型能用、积分恒 401」。
   *
   * ## ⚠️ 返回类型是 Jet Hub 的 `CreditBalance`
   *
   * `{ total, packages, expiredTotal }` —— **不是** Rust 侧的
   * available/unit/wallets 形状。上游只给一个 `availableCredits`（数字字符串），
   * 因此按上游实际字段尽力映射，缺的填 0 / `''`。
   *
   * @throws 凭证失效（HTTP 401 或 `code ∈ {4010, 4011}`）时抛出带「重新登录」文案
   *   的错误；其余失败返回 `null`（卡片显示原因，**不是** 0）。
   */
  async fetchCreditBalance(credential: CatpawCredential): Promise<CreditBalance | null> {
    const token = credential.access_token.trim()
    if (token.length === 0) return null
    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.gatewayBase}/api/gateway/credit/balance`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Auth-Token': token,
          'gray-set': 'new-agent-sdk',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
    const payload = await response.json().catch(() => undefined) as unknown
    const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined
    const code = typeof record?.code === 'number' ? record.code : undefined
    // 两条凭证失效路径（实测）：4010 = 没带 token，4011 = token 无效。
    // HTTP 401 也同样处理。
    if (response.status === 401 || code === 4010 || code === 4011) {
      throw new Error('积分查询凭证已失效，请在客户端重新登录后重新导入登录态')
    }
    if (!response.ok || record === undefined) return null
    const data = typeof record.data === 'object' && record.data !== null
      ? record.data as Record<string, unknown>
      : undefined
    if (data === undefined) return null

    const available = readNumber(data.availableCredits)
    // `availableCredits` 是核心字段：没有它就说明响应形状不对，不编造数字。
    if (available === undefined) return null

    const userPlan = typeof data.userPlan === 'object' && data.userPlan !== null
      ? data.userPlan as Record<string, unknown>
      : undefined
    const expireTime = typeof userPlan?.expireTime === 'string' ? userPlan.expireTime : ''
    const planName = typeof userPlan?.planName === 'string' && userPlan.planName.trim().length > 0
      ? userPlan.planName.trim()
      : ''

    const packages: CreditPackage[] = [{
      name: planName.length > 0 ? planName : '可用积分',
      unit: 'credits',
      remaining: available,
      total: available,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: expireTime,
      expiredTime: expireTime,
    }]

    return { total: available, packages, expiredTotal: 0 }
  }
}

// ─── 模块内助手 ────────────────────────────────────────────────────

/** 跨源 + PNA 响应头（见模块头：缺这两个头浏览器会拦掉回调 POST）。 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

/** 读请求体（上限 64KB，避免被塞爆）。 */
async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > 64 * 1024) throw new Error('回调请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * 解析回调体：`application/x-www-form-urlencoded`（`token=…&state=…`），
 * **兼容 JSON**（`{token, state}`）。
 *
 * 上游页面实测用表单编码；JSON 兼容是为「客户端换了提交方式」留的后路 ——
 * 那时若解析不出来，用户看到的是「登录成功但网关一直等」，极难排查。
 */
function parseCallbackBody(body: string, contentType: string): Record<string, string> {
  const text = body.trim()
  if (text.length === 0) return {}
  if (contentType.toLowerCase().includes('json') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') out[key] = value
        }
        return out
      }
    } catch {
      // 落到表单解析
    }
  }
  const params = new URLSearchParams(text)
  const out: Record<string, string> = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

/** 32 位小写 hex 随机串（state / sid）。 */
function randomHex(): string {
  return randomBytes(16).toString('hex')
}

/** 延迟（毫秒）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，不对外暴露。
 * 端口用 `listen(0)` 让内核分配，再从 `address()` 取 —— 避免与其它进程抢固定端口。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('catpaw: 本地回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/** 数字字段（字符串与数字两种形态都收；缺失/非数字给 undefined）。 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 远端目录条目归一化。
 *
 * ## 字段映射
 *
 * | 上游字段 | 归一后 |
 * |---|---|
 * | `modelTypeName` | `id`（**不是** `id` / `catPawModelType` —— 那两个不是名字） |
 * | `extendedInfo.modelCaptionZhCN` → `description` → `id` | `name` |
 * | `extendedInfo.rateMultiplier` | `credits` = `x{值} credits`（**保留字符串尾零**） |
 * | `supportImage` | `supportsImages` |
 * | `supportThinking`（缺省看 `parameterDefinitions` 是否含 `effort`） | `supportsReasoning` |
 * | `parameterDefinitions[context]` 的 ENUM 最大值 | `maxInputTokens` |
 * | 同上参数的 `defaultValue` | `defaultContextWindow` |
 * | `modelTypeId` | `modelType` |
 *
 * ## 两条过滤
 *
 * - `provider === 'USER_CUSTOM'`：用户自建模型依赖客户端本地 apiKey，网关既没有
 *   凭证也不该转发 —— 列出来会让客户端以为能请求；
 * - `extendedInfo.isAuto`：那是 UI 的「自动选择」档位入口，**不是真实模型**
 *   （实测没有 `rateMultiplier`、没有 `parameterDefinitions`）。列进目录会让
 *   客户端拿一个转不了发的名字。
 *
 * ## 最后一道闸
 *
 * **没有数字 `modelType` 的条目一律不广告**：建会话必须先有数字 ID，广告一个
 * 转不了的模型会造出「目录里有、请求却报 400」的自相矛盾。
 */
function normalizeRemoteModel(entry: unknown): CatpawRemoteModel | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const extended = typeof record.extendedInfo === 'object' && record.extendedInfo !== null
    ? record.extendedInfo as Record<string, unknown>
    : undefined

  // auto 伪模型：`isAuto` 可能是布尔或字符串 `"true"`（上游两种都给过）。
  if (jsTruthy(extended?.isAuto)) return undefined
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  if (provider.toLowerCase() === 'user_custom') return undefined

  const id = typeof record.modelTypeName === 'string' ? record.modelTypeName.trim() : ''
  if (id.length === 0) return undefined

  const caption = typeof extended?.modelCaptionZhCN === 'string' ? extended.modelCaptionZhCN.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const name = caption.length > 0 ? caption : description.length > 0 ? description : id

  const modelType = readNumber(record.modelTypeId)
  // 最后一道闸：没有数字 modelType 的条目不广告。
  if (modelType === undefined) return undefined

  const model: CatpawRemoteModel = {
    id,
    name,
    modelType,
    supportsImages: jsTruthy(record.supportImage),
  }

  const credits = rateText(extended?.rateMultiplier)
  if (credits.length > 0) model.credits = credits

  const definitions = Array.isArray(record.parameterDefinitions) ? record.parameterDefinitions : []
  // 思考能力：顶层布尔缺省时看参数佐证 —— 带 `effort` 枚举的模型一定支持思考档位，
  // 拿它当兜底比直接判 false 更不容易错（把一个能思考的模型报成不能，会让客户端
  // 自己禁用思考相关的请求参数）。
  const supportsReasoning = record.supportThinking === undefined
    ? definitions.some((definition) => readDefinitionId(definition) === 'effort')
    : jsTruthy(record.supportThinking)
  model.supportsReasoning = supportsReasoning

  const maxWindow = enumMax(definitions, 'context')
  if (maxWindow !== undefined) model.maxInputTokens = maxWindow
  const defaultWindow = enumDefault(definitions, 'context')
  if (defaultWindow !== undefined) model.defaultContextWindow = defaultWindow

  return model
}

/** `extendedInfo.rateMultiplier` → 倍率文本（**保留字符串尾零**）。 */
function rateText(value: unknown): string {
  const plain = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : ''
  if (plain.length === 0) return ''
  // 非数字文本不拼（避免产出 `xabc credits` 这种噪声）。
  if (!Number.isFinite(Number(plain))) return ''
  return `x${plain} credits`
}

/** 取参数定义的 `id`。 */
function readDefinitionId(definition: unknown): string {
  if (typeof definition !== 'object' || definition === null) return ''
  const id = (definition as Record<string, unknown>).id
  return typeof id === 'string' ? id : ''
}

/** `parameterDefinitions[]` 里某个 ENUM 参数的档位上限（数值最大的一项）。 */
function enumMax(definitions: readonly unknown[], id: string): number | undefined {
  const values = enumValues(definitions, id)
  let best: number | undefined
  for (const value of values) {
    const parsed = readNumber(value)
    if (parsed === undefined) continue
    if (best === undefined || parsed > best) best = parsed
  }
  return best
}

/** `parameterDefinitions[]` 里某个 ENUM 参数的默认档位。 */
function enumDefault(definitions: readonly unknown[], id: string): string | undefined {
  for (const definition of definitions) {
    if (readDefinitionId(definition) !== id) continue
    const defaultValue = (definition as Record<string, unknown>).defaultValue
    if (typeof defaultValue === 'string' && defaultValue.trim().length > 0) return defaultValue.trim()
    const parsed = readNumber(defaultValue)
    if (parsed !== undefined) return String(parsed)
    return undefined
  }
  return undefined
}

/** 取某个参数定义的 `values[]`。 */
function enumValues(definitions: readonly unknown[], id: string): unknown[] {
  for (const definition of definitions) {
    if (readDefinitionId(definition) !== id) continue
    const values = (definition as Record<string, unknown>).values
    return Array.isArray(values) ? values.map(readEnumValue) : []
  }
  return []
}

/** 取一个 ENUM 候选项的 `value`（对象形态）或它本身。 */
function readEnumValue(item: unknown): unknown {
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    return (item as Record<string, unknown>).value
  }
  return item
}

/** JS 真值判定（`Boolean(x)`）：null/false/0/"" 为假，其余为真。 */
function jsTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'string') return value.length > 0
  return true
}
