/**
 * Accio 认证服务：OAuth 授权码 + PKCE 网页登录、refresh_token 静默续期、
 * 模型目录与额度查询。
 *
 * ## 与其余 provider 的差异
 *
 * | 维度 | accio | 对照 |
 * |---|---|---|
 * | 登录 | **本机 loopback 回调 + PKCE(S256)** | Qoder/ZCode 是设备码轮询 |
 * | 续期 | **有** `refresh_token` 轮换，且 **token 在 body 里** | 其余家在 `Authorization` 头 |
 * | 模型目录 | `POST /api/llm/config`（**要鉴权**） | raccoon 的目录也鉴权 |
 * | 额度 | 只有**已用百分比**，没有绝对剩余量 | 其余家给绝对数 |
 * | 签到 | **无**（上游没有那个活动） | 不影响本文件 |
 *
 * ## 三条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `ACCIO_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 * 3. **`startLogin` 必须立即返回 `loginUrl`** —— 浏览器只在用户点击后的短暂
 *    窗口内允许 `window.open`；阻塞式登录会让手势过期，前端退化成导航跳转，
 *    **把整个设置页导航到外部登录页**。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CreditBalance } from './credits.js'
import {
  ACCIO_CALLBACK_PATH,
  ACCIO_DEFAULT_TTL_MS,
  ACCIO_LOGIN_TIMEOUT_MS,
  ACCIO_REQUEST_TIMEOUT_MS,
  accioAccountId,
  accioCredentialExpiresAtMs,
  accioDisplayName,
  buildAccioAuthorizeUrl,
  isAccioExpiring,
  isAccioRefreshable,
  newAccioDeviceId,
  newAccioState,
  parseAccioCredential,
  type AccioCredential,
  type AccioPkcePair,
} from './accio.js'
import { ACCIO, type AccioProduct } from './accio-product.js'

/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 *
 * ⚠️ `name` 必须**恰为** `RefreshTokenExpiredError`：`src/refresh.ts` 的
 * `isRefreshTokenExpired` 按 `error.name` 判定（跨模块 `instanceof` 不可靠）。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 登录/续期后的结果（与其余 provider 同构）。 */
export interface AccioLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 是否可续期（取决于是否存在 refresh_token）。 */
  refreshable: boolean
  /** 展示给用户的登录 URL（`persistLogin` 单独调用时为空串）。 */
  loginUrl: string
}

/** 只读登录状态。 */
export interface AccioLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/**
 * 远端模型条目（已归一）。
 *
 * 字段口径与 `LlmResolvedModelInfo` 对齐，另带三个**适配器内部**要用的键：
 * - `upstreamKey`：发给上游的 `model`（可能是代号，与对外 `id` 不同）；
 * - `reasoningEfforts` / `reasoningPlacement`：思考档位的可选值与落点
 *   （落点放错的后果见 `accio-product.ts` 的对照表）。
 */
export interface AccioRemoteModel {
  /** 对外模型 ID（用户配置与持久化都用它）。 */
  id: string
  /** 展示名（已含倍率后缀，见 {@link accioRemoteDisplayName}）。 */
  name: string
  /** 上下文窗口（0 = 上游没给）。 */
  contextWindow: number
  /** 单次输出上限（上游不给时**不声明**，见 `accio-product.ts`）。 */
  maxTokens?: number
  /** 是否接受图片输入。 */
  supportsImage: boolean
  /** 是否声明了思考档位。 */
  supportsReasoning: boolean
  /** 声明的档位集合。 */
  reasoningEfforts: readonly string[]
  /** 思考档位落点。 */
  reasoningPlacement: 'top' | 'properties'
  /** 发给上游的模型名。 */
  upstreamKey: string
}

/** `AccioAuth` 的构造选项。 */
export interface AccioAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link ACCIO}。 */
  product?: AccioProduct
  /** 服务名覆盖（默认由产品 id 派生为 `accioAuth` / `accio-cnAuth`）。 */
  serviceName?: string
}

/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedAccioLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<AccioCredential>
  /** 取消登录（关掉本地回调服务器）；**幂等**。 */
  close: () => Promise<void>
}

/** 待完成登录的有效期（6 分钟；与 `ACCIO_LOGIN_TIMEOUT_MS` 同量级）。 */
const ACCIO_PENDING_TTL_MS = 6 * 60 * 1000

/** 模型目录缓存有效期（1 小时）。 */
const ACCIO_MODELS_TTL_MS = 60 * 60 * 1000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Accio 国际版的认证服务实例。
     *
     * cordis 的 `Service` 构造时按名称注册，同名第二次注册会抛
     * `service "..." has been registered`，故两个地区各占一个服务名
     *（`accioAuth` / `accio-cnAuth`）。
     */
    accioAuth: AccioAuth
    /** Accio 国内版的认证服务实例（与 `accioAuth` 同一实现，不同产品配置）。 */
    'accio-cnAuth': AccioAuth
  }
}

/** 生成 PKCE 配对：verifier 为 32 随机字节的 base64url（43 字符，无填充）。 */
export function generateAccioPkce(): AccioPkcePair {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

/**
 * 续期的**单飞表**（进程级）。
 *
 * ## 为什么必须有
 *
 * 同一个账号可能被多条路径同时续期：定时器的 `refreshAll`、适配器收到 401 后的
 * 重试、用户在账号卡片上点「刷新」。并发发多次续期请求的后果不只是浪费一次
 * 往返 —— 上游是 **refresh_token 轮换**语义，两次并发里后到的那个可能拿着
 * 已被前一次作废的 refresh_token，于是**续期成功之后立刻被判失效**，
 * 用户看到「刚刷新过又要重新登录」。
 *
 * 键含 ref 名 + 两个 token 的指纹（而不是只含 ref）：同一 ref 下的凭据可能
 * 在两次调用之间被换掉（重新登录），那时它们本就是**不同的**续期任务，
 * 不该被合流成一次。
 */
const refreshFlights = new Map<string, Promise<AccioCredential>>()

/** 取一个短指纹（sha256 前 16 位 hex）；**不可反推原值**。 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/** 续期单飞的键。 */
function flightKey(refName: string, credential: AccioCredential): string {
  return [
    refName,
    fingerprint(credential.access_token),
    fingerprint(credential.refresh_token ?? ''),
  ].join(':')
}

/** 把 `unknown` 收窄成普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 取第一个非空字符串字段。 */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 取第一个有限数字字段。 */
function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * 判断业务信封是否表示成功。
 *
 * 上游的 `code` 是**字符串**（`"200"`），也有接口给数字或干脆不给 —— 三种都认。
 * `success === false` 或 `code` 落在失败集合时判失败。
 */
function envelopeOk(record: Record<string, unknown>): boolean {
  if (record['success'] === false) return false
  const code = record['code']
  if (code === undefined || code === null) return true
  if (typeof code === 'number') return code === 0 || code === 200
  if (typeof code === 'string') {
    const trimmed = code.trim()
    return trimmed === '' || trimmed === '0' || trimmed === '200'
  }
  return true
}

/** 信封里的可读错误文案。 */
function envelopeMessage(record: Record<string, unknown>, fallback: string): string {
  return pickString(record, ['message', 'msg', 'error_message', 'errorMessage']) ?? fallback
}

/**
 * 取信封的内层数据。
 *
 * 上游两种形态都见过：`{success, data:{…}}`（业务接口）与**顶层直接是数据**
 * （少数接口）。两种都接受。
 */
function envelopeData(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  return asRecord(record['data']) ?? record
}

/** Accio 认证服务。 */
export class AccioAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: AccioProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 远端模型目录缓存（含拉取时刻；TTL 见 {@link ACCIO_MODELS_TTL_MS}）。 */
  private modelsCache: { models: AccioRemoteModel[]; fetchedAt: number } | undefined
  /** 正在运行的登录流程的关闭句柄（`stop()` 时统一收掉）。 */
  private activeClosers = new Set<() => Promise<void>>()

  constructor(ctx: Context, private readonly options: AccioAuthOptions = {}) {
    const product = options.product ?? ACCIO
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 业务接口的通用请求头（照抄桌面端拦截器里我们认得全的那一组）。 */
  private apiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'en',
      'x-language': 'en',
      'x-platform': 'desktop',
      'x-app-version': this.product.appVersion,
      'x-package-region': this.product.packageRegion,
    }
  }

  // ── 登录 ────────────────────────────────────────────────────────

  /**
   * 启动登录流程并**立即返回 `loginUrl`**（两步式）。
   *
   * 流程：
   * ```
   * ① 生成 PKCE(S256) 与 state
   * ② 在 127.0.0.1 的**随机空闲端口**起一个回调服务器（路径 /auth/callback-accio）
   * ③ loginUrl = {loginBase}/login?return_url=…&state=…&code_challenge=…
   * ④ 浏览器 302 回 ?code=…&state=…  → 逐字比对 state → 换码 → 查资料
   * ```
   *
   * ⚠️ **`return_url` 与换码时的 `redirectUri` 必须逐字相同**（含端口与路径）：
   * 故端口一经确定就冻结进 `returnUrl`，换码时原样回传。
   *
   * ⚠️ **state 逐字比对不可省**：回调落在本机端口上，任何本机进程都能伪造
   * 一次 GET。state 是「这次回调是不是本进程刚发起的那一轮」的唯一凭据。
   */
  async startLogin(): Promise<StartedAccioLoginFlow> {
    const pkce = generateAccioPkce()
    const state = newAccioState()
    const server = createServer()
    const port = await listenOnRandomPort(server)
    const returnUrl = `http://127.0.0.1:${port}${ACCIO_CALLBACK_PATH}`
    const loginUrl = buildAccioAuthorizeUrl(this.product, pkce, state, returnUrl)

    let settleOk!: (credential: AccioCredential) => void
    let settleErr!: (error: unknown) => void
    const result = new Promise<AccioCredential>((resolve, reject) => {
      settleOk = resolve
      settleErr = reject
    })
    // 这个 promise 可能在被消费前就 reject（用户极快取消 / 回调带 error），
    // 那段窗口里 Node 会报「未处理的拒绝」。先挂空处理器，不影响真正的消费者。
    result.catch(() => {})

    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }

    // ⚠️ 关服务器要在**结果落定之后**，且必须幂等（超时、成功、close() 三条
    // 路径都可能先到）。
    let closed = false
    const closeServer = (): Promise<void> => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    const close = async (): Promise<void> => {
      finish(() => settleErr(new Error('accio: 登录流程已关闭')))
      await closeServer()
      this.activeClosers.delete(close)
    }

    server.on('request', (request, response) => {
      void (async (): Promise<void> => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== ACCIO_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Not found')
          return
        }
        const error = url.searchParams.get('error')
        if (error !== null && error.trim().length > 0) {
          const message = `accio: 授权被拒绝（${error}）`
          finish(() => settleErr(new Error(message)))
          writeHtml(response, 400, '登录被拒绝，请回到 Jet Hub 重试。')
          await closeServer()
          return
        }
        const code = (url.searchParams.get('code') ?? '').trim()
        const returnedState = (url.searchParams.get('state') ?? '').trim()
        // ⚠️ state **逐字**比对（不做大小写归一、不 trim 之外的任何处理）。
        if (returnedState !== state) {
          finish(() => settleErr(new Error('accio: 回调 state 不匹配，已拒绝这次登录')))
          writeHtml(response, 400, '登录校验失败，请回到 Jet Hub 重新发起。')
          await closeServer()
          return
        }
        if (code.length === 0) {
          finish(() => settleErr(new Error('accio: 回调没有携带授权码')))
          writeHtml(response, 400, '回调缺少授权码，请回到 Jet Hub 重试。')
          await closeServer()
          return
        }
        try {
          const credential = await this.exchangeCode(code, pkce.codeVerifier, returnUrl)
          finish(() => settleOk(credential))
          writeHtml(response, 200, '登录成功，已返回网关，可以关闭此页面。')
        } catch (caught) {
          finish(() => settleErr(caught))
          writeHtml(
            response,
            500,
            `登录失败：${caught instanceof Error ? caught.message : String(caught)}`,
          )
        }
        await closeServer()
      })().catch(() => {
        // 响应可能已发出；这里只保证不产生未处理的拒绝。
        try {
          response.end()
        } catch {
          // 忽略
        }
      })
    })

    // 服务器错误（端口被抢等）：让结果以失败落定，而不是永远悬挂。
    server.on('error', (error: Error) => {
      finish(() => settleErr(new Error(`accio: 本地回调服务器出错：${error.message}`)))
    })

    const timer = setTimeout(() => {
      finish(() => settleErr(new Error(
        `accio: 登录超时（${Math.round(ACCIO_LOGIN_TIMEOUT_MS / 1000)} 秒内未完成）`,
      )))
      void closeServer()
    }, Math.min(ACCIO_LOGIN_TIMEOUT_MS, ACCIO_PENDING_TTL_MS))
    timer.unref?.()

    this.activeClosers.add(close)
    return { loginUrl, result, close }
  }

  /**
   * 用授权码换凭据（`POST {gatewayBase}/api/oauth/token`）。
   *
   * ⚠️ 换码的 body 键名是**驼峰**（`codeVerifier` / `clientId` / `redirectUri`），
   * 而响应里 token 的键名可能是驼峰也可能是下划线 —— 两种都认。
   *
   * ⚠️ 换回来的 token 是**不透明串**（不是 JWT，解不出 userId），故账号身份
   * 只能靠 `/api/auth/userinfo` 问一次。查资料**失败不阻断登录**：拿不到资料
   * 照常建账号（id 走凭证指纹兜底、名字走默认），只是少一行副标题。
   */
  private async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<AccioCredential> {
    const payload = await this.postJson('/api/oauth/token', {
      code,
      codeVerifier,
      clientId: this.product.clientId,
      redirectUri,
    }, '授权码换令牌')
    const data = envelopeData(payload)
    if (data === undefined) throw new Error('accio: 换码响应缺少数据体')
    const accessToken = pickString(data, ['accessToken', 'access_token', 'token'])
    if (accessToken === undefined) throw new Error('accio: 换码响应缺少 accessToken')
    const refreshToken = pickString(data, ['refreshToken', 'refresh_token'])
    const expiresAt = accioCredentialExpiresAtMs({
      access_token: accessToken,
      // 上游三种键名都见过，逐个别名试一遍（`accioCredentialExpiresAtMs`
      // 只认 `expires_at`，故这里先把别名归一）。
      expires_at: pickNumber(data, ['expiresAt', 'expires_at']),
    })

    let credential: AccioCredential = {
      access_token: accessToken,
      ...refreshToken === undefined ? {} : { refresh_token: refreshToken },
      ...expiresAt === undefined ? {} : { expires_at: expiresAt },
      mode: this.product.id === 'accio-cn' ? 'cn' : 'intl',
      provider: this.product.id,
      device_id: newAccioDeviceId(),
    }

    // 尽力补全身份（id / 邮箱 / 昵称）：失败不影响登录。
    const profile = await this.fetchProfile(accessToken)
    if (profile !== undefined) {
      credential = {
        ...credential,
        ...profile.userId === undefined ? {} : { user_id: profile.userId },
        ...profile.email === undefined ? {} : { email: profile.email },
        ...profile.nickname === undefined ? {} : { nickname: profile.nickname },
      }
    }
    return credential
  }

  /**
   * 查用户资料（`GET /api/auth/userinfo?accessToken=…`）。
   *
   * ⚠️ **失败返回 undefined 而不是抛错**：资料只用于昵称展示与账号消歧，
   * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
   */
  private async fetchProfile(
    accessToken: string,
  ): Promise<{ userId?: string; email?: string; nickname?: string } | undefined> {
    try {
      const url = `${this.product.gatewayBase}/api/auth/userinfo`
        + `?accessToken=${encodeURIComponent(accessToken)}`
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.apiHeaders(),
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const data = envelopeData(await response.json())
      if (data === undefined) return undefined
      // 资料可能在 `data.user` 里，也可能直接铺在 `data` 上（两种都见过）。
      const user = asRecord(data['user']) ?? data
      const userId = pickString(user, ['id', 'userId', 'user_id', 'uid'])
      const email = pickString(user, ['email', 'emailAddress'])
      const nickname = pickString(user, ['nickname', 'name', 'displayName', 'userName'])
      return {
        ...userId === undefined ? {} : { userId },
        ...email === undefined ? {} : { email },
        ...nickname === undefined ? {} : { nickname },
      }
    } catch {
      return undefined
    }
  }

  /**
   * 发一次业务 POST 并校验信封。
   *
   * ⚠️ 401/403 抛 {@link RefreshTokenExpiredError}：调用方据此提示重新登录，
   * 而不是把它当成一次可重试的网络抖动。
   */
  private async postJson(
    path: string,
    body: Record<string, unknown>,
    action: string,
  ): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.gatewayBase}${path}`, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`accio: ${action}请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new RefreshTokenExpiredError('accio: 登录态已失效，请重新登录')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(`accio: ${action}响应不是 JSON（HTTP ${response.status}）`)
    }
    const record = asRecord(payload)
    if (record === undefined) throw new Error(`accio: ${action}响应不是 JSON 对象`)
    if (!response.ok) {
      throw new Error(`accio: ${action}失败（HTTP ${response.status}）：${envelopeMessage(record, '上游拒绝')}`)
    }
    if (!envelopeOk(record)) {
      throw new Error(`accio: ${action}失败：${envelopeMessage(record, '上游拒绝')}`)
    }
    return record
  }

  /**
   * 把登录结果落盘成凭据。
   *
   * 与 `startLogin` 分开：流程编排（本地服务器 + state 校验）在 `startLogin` 里，
   * 本方法只负责「补全默认字段 + 写凭据」。
   */
  async persistLogin(
    credential: AccioCredential,
    flowOptions: { refName?: string } = {},
  ): Promise<AccioLoginResult> {
    const refName = flowOptions.refName ?? this.credentialRefName
    const enriched: AccioCredential = {
      ...credential,
      provider: this.product.id,
      mode: this.product.id === 'accio-cn' ? 'cn' : 'intl',
      // ⚠️ 设备指纹只在**缺失时**补：续期路径不该换掉已有指纹（真实客户端
      // 是一台设备一个指纹，换掉会让风控看到「同一账号换了设备」）。
      ...credential.device_id === undefined || credential.device_id.length === 0
        ? { device_id: newAccioDeviceId() } : {},
    }
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(enriched))
    this.lastRefreshError = undefined
    return {
      access: JSON.stringify(enriched),
      expires: accioCredentialExpiresAtMs(enriched) ?? 0,
      ref,
      refreshable: isAccioRefreshable(enriched),
      loginUrl: '',
    }
  }

  // ── 状态与续期 ──────────────────────────────────────────────────

  /** 只读登录状态。 */
  async status(): Promise<AccioLoginStatus> {
    const credential = await this.resolveCredentialAt(this.credentialRefName)
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = accioCredentialExpiresAtMs(credential)
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === undefined ? {} : { expiresAt },
      refreshable: isAccioRefreshable(credential),
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 解析指定 ref 的凭据；不可用时返回 undefined（不抛错）。 */
  private async resolveCredentialAt(refName: string): Promise<AccioCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
      return resolved === undefined ? undefined : parseAccioCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /**
   * 续期默认单凭据。
   *
   * @param force - `true` 时**不看临期窗口**（适配器收到 401 后的重试走这条：
   *   token 可能时间上还新但已被服务端失效，只看窗口会拿回同一个被拒的 token）。
   * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
   */
  async refresh(force = false): Promise<void> {
    const credential = await this.resolveCredentialAt(this.credentialRefName)
    if (credential === undefined) throw new RefreshTokenExpiredError('凭据未配置，请先登录')
    if (!isAccioRefreshable(credential)) {
      throw new RefreshTokenExpiredError(
        'Accio 账号没有 refreshToken，无法续期，请重新登录或粘贴完整凭证',
      )
    }
    if (!force && !this.isExpiring(credential)) return
    try {
      const next = await this.refreshSingleFlight(this.credentialRefName, credential)
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      throw error
    }
  }

  /**
   * 续期**指定 ref**（账号卡片「刷新」按钮 / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
   * `ACCIO_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
   * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，被多账号操作污染
   * 会让 UI 显示错误的失效提示。
   *
   * ## 参数顺序为什么是 `refName, pool, accountId, force`
   *
   * 前三个是**必给**的（账号池场景），`force` 是可选的行为开关 —— 可选参数
   * 必须排在必给参数之后。这与 raccoon 的 `refreshAccountCredential(refName,
   * pool, accountId)` 同序，接线时多一个末位 `force` 即可（不传 = 看临期窗口）。
   *
   * @param pool - 提供时把新 `expiresAt` / `refreshable` 写回账号池。
   * @param accountId - 账号 id；调用方已知时显式传入（否则按凭据反查）。
   * @param force - `true` 时不看临期窗口（401 后的强制续期）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
    force = false,
  ): Promise<void> {
    const credential = await this.resolveCredentialAt(refName)
    if (credential === undefined) throw new Error('凭据未配置')
    if (!isAccioRefreshable(credential)) {
      throw new RefreshTokenExpiredError(
        'Accio 账号没有 refreshToken，无法续期，请重新登录或粘贴完整凭证',
      )
    }
    if (!force && !this.isExpiring(credential)) return
    const next = await this.refreshSingleFlight(refName, credential)
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(next))
    await this.syncAccountExpiry(pool, refName, accountId, next)
  }

  /**
   * 凭据是否已进入续期窗口（或已过期）。
   *
   * 判据统一在 `accio.ts` 的 `isAccioExpiring`（适配器也要用同一份口径 ——
   * 两处各写一份迟早分叉，而分叉的表现是「适配器认为该续期、认证服务认为
   * 不用」，401 之后永远拿回同一个坏 token）。
   */
  private isExpiring(credential: AccioCredential): boolean {
    return isAccioExpiring(credential)
  }

  /**
   * 单飞续期：同一账号的并发调用只发**一次**请求，其余等同一结果。
   *
   * 见 {@link refreshFlights} 的说明（refresh_token 轮换 + 并发 = 自己把
   * 自己刚拿到的 token 作废）。
   */
  private async refreshSingleFlight(
    refName: string,
    credential: AccioCredential,
  ): Promise<AccioCredential> {
    const key = flightKey(refName, credential)
    const existing = refreshFlights.get(key)
    if (existing !== undefined) return existing
    const flight = this.performRefresh(credential)
      .finally(() => {
        // 只删自己那一格：若期间有新的同键任务（理论上不可能，因为键含 token
        // 指纹），删掉别人的会让它失去合流能力。
        if (refreshFlights.get(key) === flight) refreshFlights.delete(key)
      })
    refreshFlights.set(key, flight)
    return flight
  }

  /**
   * 真正发一次续期请求（`POST /api/auth/refresh_token`）。
   *
   * ⚠️ **token 在 body 里，不是请求头**（本家与其余九家的又一处不同）：
   * body 是 `{accessToken, refreshToken}`。
   *
   * ⚠️ 上游**可能只返回新的 accessToken**（不带新 refreshToken），此时必须
   * **保留旧值** —— 否则续期一次就把账号变成不可续期。
   * ⚠️ 身份与地区**不允许被续期结果改掉**：那意味着串号（换到了另一个账号
   * 的凭证）。
   */
  private async performRefresh(credential: AccioCredential): Promise<AccioCredential> {
    const payload = await this.postJson('/api/auth/refresh_token', {
      accessToken: credential.access_token,
      refreshToken: credential.refresh_token ?? '',
    }, '凭证续期')
    const data = envelopeData(payload)
    if (data === undefined) throw new Error('accio: 续期响应缺少数据体')
    const accessToken = pickString(data, ['accessToken', 'access_token', 'token'])
    if (accessToken === undefined) {
      throw new Error('accio: 续期响应缺少 accessToken，旧凭证未被覆盖')
    }
    const refreshToken = pickString(data, ['refreshToken', 'refresh_token'])
      ?? credential.refresh_token
    // ⚠️ 缺失时给一个**保守的**默认值（1 小时）：它只影响「下次要不要续期」
    // 的判定。给短了会多刷一次（无害），给长了会让一个已失效的 token 留着
    // 不走续期路径（有害）。
    const expiresAt = accioCredentialExpiresAtMs({
      access_token: accessToken,
      expires_at: pickNumber(data, ['expiresAt', 'expires_at']),
    }) ?? Date.now() + ACCIO_DEFAULT_TTL_MS

    return {
      ...credential,
      access_token: accessToken,
      ...refreshToken === undefined ? {} : { refresh_token: refreshToken },
      expires_at: expiresAt,
      // 身份与设备指纹以**原凭据**为准（见上方 ⚠️）。
      ...credential.user_id === undefined ? {} : { user_id: credential.user_id },
      ...credential.device_id === undefined ? {} : { device_id: credential.device_id },
    }
  }

  /**
   * 把续期后的过期时间同步回账号池（供 UI 显示）。
   *
   * ⚠️ **失败只记日志、不上抛**：凭据**已经续期成功**了，此时因为「写索引
   * 失败」而报错，会让用户以为续期失败、甚至触发不必要的重新登录。
   *
   * ⚠️ 反查时第二个参数是**凭据内容**（access_token）而非 ref 名 ——
   * `findAccountIdByCredential` 的语义如此，传 ref 名会**恒匹配失败**（静默）。
   */
  private async syncAccountExpiry(
    pool: AccountPool | undefined,
    refName: string,
    accountId: string | undefined,
    credential: AccioCredential,
  ): Promise<void> {
    if (pool === undefined) return
    try {
      let id = accountId
      if (id === undefined || id.length === 0) {
        id = await pool.findAccountIdByCredential(this.product.id, credential.access_token)
      }
      if (id === undefined || id.length === 0) return
      await pool.updateAccount(id, {
        expiresAt: accioCredentialExpiresAtMs(credential) ?? undefined,
        refreshable: isAccioRefreshable(credential),
      })
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[accio] 续期成功但回写账号池的过期时间失败（不影响使用）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的自动
   * 选号，与「凭据是否需要保持新鲜」无关（AGENTS.md 铁律；早期按 `enabled`
   * 过滤导致停用账号的 refresh_token 在停用期间被放到失效）。
   *
   * 单账号失败**不中断循环**（且必须留日志：曾完全静默的实现让「续期永远
   * 失败但 UI 显示可续期」无法排查）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable。
      if (!entry.refreshable) continue
      try {
        // ⚠️ 必须传 `pool` + `entry.id`：否则续期后不回写 `expiresAt`，
        // UI 会一直显示「已过期」（raccoon 上发生过的真实缺陷）。
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(`[accio] 账号 ${entry.id} 的 refreshToken 已失效，需重新登录`)
        } else {
          this.ctx.logger?.warn?.(
            `[accio] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  // ── 模型目录 ────────────────────────────────────────────────────

  /**
   * 拉取远端模型目录（`POST /api/llm/config`，失败回落 `/api/llm/config/v2`）。
   *
   * ## 为什么 v1 优先、v2 只作回落
   *
   * 两条路径返回**同一个信封**，差别在清单本身：v1 是完整清单，v2 是精简版
   *（实测少了 deepseek / moonshot / zhipu 三家，且每条模型少 `protocol` 字段
   * —— 而 `protocol` 正是思考档位落点的判据）。故 v1 失败才回落一次 v2。
   *
   * ## 为什么 `data` 是**数组**
   *
   * ⚠️ 这是最容易写错的一处：响应是
   * `{success, code, message, data:[{provider, modelList:[…]}, …]}` ——
   * `data` **是 provider 数组，不是 `{providers:[…]}` 对象**。按后者解析会让
   * 清单**恒为空**，而 HTTP 是 200（走不到错误分支），前端只看到「上游目录里
   * 没有可见模型」。两种形态都接受（旧形态保留兼容）。
   *
   * 失败返回**空数组**（适配器据此回退兜底表），不抛错。
   */
  async fetchModels(pool?: AccountPool): Promise<AccioRemoteModel[]> {
    const cached = this.modelsCache
    if (cached !== undefined && Date.now() - cached.fetchedAt < ACCIO_MODELS_TTL_MS) {
      return cached.models
    }
    const credential = await this.resolveForFetchModels(pool)
    if (credential === undefined) return []

    const body = { token: credential.access_token, supportAutoModel: true }
    for (const path of ['/api/llm/config', '/api/llm/config/v2']) {
      try {
        const payload = await this.postJson(path, body, '模型目录')
        const models = parseAccioModelCatalog(payload)
        if (models.length > 0) {
          this.modelsCache = { models, fetchedAt: Date.now() }
          await this.pruneStaleDisabledModels(pool, models)
          return models
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[accio] 模型目录 ${path} 拉取失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return []
  }

  /**
   * 清掉黑名单里**已不对应任何模型**的旧键（改过对外 id 之后留下的残渣）。
   *
   * ## 为什么落在这里
   *
   * 这是**唯一同时握有可信目录与账号池**的位置：目录刚从上游拉到且非空
   * （`models.length > 0` 才走到这里），账号池又在手边。放到读取侧（`model.list`）
   * 做不到 —— 那里拿到的 `listAllModels()` 在**远端拉取失败时会退化成静态兜底表**，
   * 拿兜底表当「有效 id 全集」会把用户真实的关闭项全部误删（破坏性）。
   *
   * ## 这次的残渣是怎么来的（真实故障，2026-10-04）
   *
   * 对外 id 从上游混淆代号（`1Helix-G6aS8tR2qN7m`）改成可读 slug
   * （`gpt-6-astra`）之后，用户此前记在**旧 id** 上的关闭状态就成了孤儿键：
   * 既不对应任何模型，又会把「已隐藏」计数撑到 41（真实只有 7 个）。
   * 用户的选择是「这些模型保持启用、把残渣清掉」，所以这里是**删除**而不是迁移。
   *
   * ⚠️ 失败只记日志、不升级为错误：它是顺手的自愈，不该让拉目录这件事失败。
   * 同理，**绝不**在这里 `throw`。
   */
  private async pruneStaleDisabledModels(
    pool: AccountPool | undefined,
    models: readonly AccioRemoteModel[],
  ): Promise<void> {
    if (pool === undefined) return
    try {
      const removed = await pool.pruneDisabledModels(
        this.product.id,
        models.map((model) => model.id),
      )
      if (removed > 0) {
        this.ctx.logger?.info?.(
          `[accio] 已清理 ${this.product.id} 黑名单里 ${removed} 个不再对应任何模型的旧键`
          + '（模型对外 id 改过一轮，旧键是残渣）',
        )
      }
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[accio] 清理 ${this.product.id} 黑名单残渣失败（忽略）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 取一个可用凭据（先账号池，再默认 ref）。 */
  private async resolveForFetchModels(pool?: AccountPool): Promise<AccioCredential | undefined> {
    if (pool !== undefined) {
      try {
        // ⚠️ 返回类型是 `| null`（不是 undefined）—— 判空必须显式覆盖两者。
        const available = await pool.getAvailableAccount(this.product.id, '')
        if (available !== null && available !== undefined) {
          // 用接受 `unknown` 的解析函数归一，不做类型断言。
          const credential = parseAccioCredential(available.credential)
          if (credential !== undefined) return credential
        }
      } catch {
        // 落到默认 ref
      }
    }
    return this.resolveCredentialAt(this.credentialRefName)
  }

  // ── 额度 ────────────────────────────────────────────────────────

  /**
   * 查询额度（`GET /api/entitlement/quota?accessToken=…`）。
   *
   * ## 为什么 `total` 是「剩余百分比」
   *
   * ⚠️ 上游**不暴露绝对剩余量**，只有一个 `usagePercent`（已用百分比）。
   * 把百分比伪装成积分数会误导（用户看到「还剩 37」不知道是什么单位），
   * 故本家整个 `CreditBalance` 的 `unit` 都是 `'%'`：
   * `total` = `100 - usagePercent`、单项包同值、`used` = `usagePercent`。
   *
   * `refreshCountdownSeconds` 拼进包名（`额度余量 · 3 小时 20 分后重置`）——
   * `CreditPackage` 没有承载倒计时的字段，而**不新增字段**是刻意的：那是
   * 跨 provider 共享的类型（`src/credits.ts`），为一家加字段会牵动全部调用方。
   *
   * ⚠️ **401/403 原样抛出**（不返回 null）：调用方据此走「刷新后重试一次」。
   * 其余失败返回 `null`（卡片显示原因，**不是** 0 —— 0 是「已用光」的语义）。
   */
  async fetchCreditBalance(credential: AccioCredential): Promise<CreditBalance | null> {
    const url = `${this.product.gatewayBase}/api/entitlement/quota`
      + `?accessToken=${encodeURIComponent(credential.access_token)}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.apiHeaders(),
        signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
    } catch {
      return null
    }
    // 401/403 原样抛出：让调用方走刷新重试那条既有链路。
    if (response.status === 401 || response.status === 403) {
      throw new RefreshTokenExpiredError('accio: 凭证已失效，请重新登录')
    }
    if (!response.ok) return null
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return null
    }
    const data = envelopeData(payload)
    if (data === undefined) return null
    const usagePercent = pickNumber(data, ['usagePercent', 'usage_percent'])
    // `usagePercent` 是核心字段：没有它就说明响应形状不对，不编造数字。
    if (usagePercent === undefined) return null

    const used = clamp(usagePercent, 0, 100)
    const remaining = clamp(100 - used, 0, 100)
    const countdown = pickNumber(data, ['refreshCountdownSeconds', 'refresh_countdown_seconds'])
    const suffix = countdown !== undefined && countdown > 0
      ? ` · ${humanizeSeconds(countdown)}后重置`
      : ''

    return {
      total: remaining,
      packages: [{
        name: `额度余量${suffix}`,
        unit: '%',
        remaining,
        total: 100,
        used,
        active: true,
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: '',
      }],
      expiredTotal: 0,
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────

  /** 登出：清除默认单凭据。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
  }

  /**
   * 停止服务：收掉仍在等待回调的登录服务器。
   *
   * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
   */
  stop(): void {
    for (const close of [...this.activeClosers]) {
      void close().catch(() => {})
    }
    this.activeClosers.clear()
  }

  // ── 供接线用的纯转发 ────────────────────────────────────────────

  /** 本产品下某凭据的账号 id（供 RPC 落账号时生成主键）。 */
  accountIdFor(credential: AccioCredential): string {
    return accioAccountId(this.product, credential)
  }

  /** 本产品下某凭据的展示名（供 RPC 落账号时回填昵称）。 */
  displayNameFor(credential: AccioCredential): string {
    return accioDisplayName(this.product, credential)
  }
}

/** 把数值钳到 `[min, max]`。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 秒 → 「3 小时 20 分」这类人话（界面直接显示）。
 *
 * 只到「分」这一级：额度重置倒计时不需要秒级精度，而秒数在卡片上反而更长。
 */
function humanizeSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分`
  return `${total} 秒`
}

/**
 * 在 `127.0.0.1` 的**随机空闲端口**上启动服务器。
 *
 * ⚠️ 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，不对外暴露。
 * 端口用 `listen(0)` 让内核分配 —— 硬编码端口会在多实例 / 端口被占时失败。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('accio: 本地回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/** 写一个 HTML 响应（回调页；用户看到的是这一页）。 */
function writeHtml(
  response: import('node:http').ServerResponse,
  status: number,
  message: string,
): void {
  const body = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Accio 登录</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;
             background:#f5f6f8;color:#1f2329;">
  <div style="background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 4px 24px rgba(0,0,0,.08);
              text-align:center;max-width:360px;">
    <p style="margin:0;font-size:14px;line-height:1.6;">${escapeHtml(message)}</p>
  </div>
</body>
</html>`
  try {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(body)
  } catch {
    // 响应可能已发出（重复回调等），忽略。
  }
}

/** HTML 转义（页面里只嵌我们自己产生的文案，但转义是零成本的正确做法）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── 模型目录解析（纯函数，导出以便单测）──────────────────────────────

/** 非对话模型的操作标记（见 {@link isAccioChatEntry}）。 */
const NON_CHAT_OPERATIONS: readonly string[] = [
  'VIDEO_GENERATION',
  'IMAGE_GENERATION',
  'AUDIO_GENERATION',
]

/**
 * 解析模型目录响应（两种信封都认，见 `fetchModels` 的说明）。
 *
 * 两道过滤：
 * - `visible === false` 丢弃；
 * - `supportedOperationList` 含视频/图像/音频生成标记的丢弃。
 */
export function parseAccioModelCatalog(payload: unknown): AccioRemoteModel[] {
  const record = asRecord(payload)
  if (record === undefined) return []
  const root = record['data'] ?? record
  const providers = Array.isArray(root)
    ? root
    : Array.isArray((asRecord(root) ?? {})['providers'])
      ? (asRecord(root) ?? {})['providers'] as unknown[]
      : undefined
  if (providers === undefined) return []

  const models: AccioRemoteModel[] = []
  for (const rawProvider of providers) {
    const provider = asRecord(rawProvider)
    if (provider === undefined) continue
    const modelList = provider['modelList']
    if (!Array.isArray(modelList)) continue
    for (const rawEntry of modelList) {
      const entry = asRecord(rawEntry)
      if (entry === undefined) continue
      if (entry['visible'] === false) continue
      if (!isAccioChatEntry(entry)) continue
      const model = normalizeAccioModel(entry)
      if (model === undefined) continue
      models.push(model)
    }
  }

  // ── 同名消歧（对外 id 现在来自**展示名**，所以会撞）────────────────
  //
  // 实测国内版目录里有五组重名：`Qwen 3.8 Max` / `Qwen 3.8 Flash` /
  // `DeepSeek V4 Flash` / `Qwen 3 Max` / `Auto` 各两条（上游用不同的
  // `modelCode` 区分，展示名是给人看的，本就不保证唯一）。
  //
  // ⚠️ 撞了必须**两边都改名**，而不是保留先到的那条：
  // 这里的 id 会进模型黑名单与会话记录，撞 id 会让两条模型共用一份开关状态；
  // 而「先到先得 + 丢掉后来的」更糟 —— 那是**静默少一个模型**。
  // 后缀取 `upstreamKey` 的短指纹，确定性且与遍历顺序无关。
  const idCount = new Map<string, number>()
  for (const model of models) idCount.set(model.id, (idCount.get(model.id) ?? 0) + 1)

  const unique: AccioRemoteModel[] = []
  const seen = new Set<string>()
  for (const model of models) {
    const id = (idCount.get(model.id) ?? 0) > 1
      ? `${model.id}-${fingerprint(model.upstreamKey).slice(0, 4)}`
      : model.id
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id === model.id ? model : { ...model, id })
  }
  return unique
}

/**
 * 这条目录条目是不是**对话**模型。
 *
 * ⚠️ **光看 `visible` 不够**（实测）：目录里有专用生成模型（视频生成那一组），
 * 它们的 `visible` 是 **`null` 而不是 `false`** —— 只按 `visible === false`
 * 过滤会漏进来一条 `contextWindow` 也是 null 的条目，它会以「上下文 0」的
 * 形态出现在模型列表里，点它必然失败。
 *
 * 用「点名挡掉已知的非对话操作」而不是「只放行空列表」：上游将来给对话条目
 * 填上这个字段时，宁可多收一个也不要把正常模型挡在门外（少个模型是静默的，
 * 多一个奇怪的模型至少看得见）。
 */
function isAccioChatEntry(entry: Record<string, unknown>): boolean {
  const operations = entry['supportedOperationList']
  if (!Array.isArray(operations)) return true
  return !operations.some((operation) => {
    if (typeof operation !== 'string') return false
    return NON_CHAT_OPERATIONS.some((blocked) => operation.toUpperCase() === blocked)
  })
}

/** 兜底表里「展示名 → 对外 id」的映射（老名字优先，见 {@link stableAccioId}）。 */
function normalizeAccioModel(entry: Record<string, unknown>): AccioRemoteModel | undefined {
  const upstreamKey = pickString(entry, ['modelCode', 'modelName'])
  if (upstreamKey === undefined) return undefined
  const display = pickString(entry, ['modelDisplayName']) ?? upstreamKey
  const contextWindow = pickNumber(entry, ['contextWindow']) ?? 0
  const effortsRaw = entry['reasoningEfforts']
  const efforts = Array.isArray(effortsRaw)
    ? effortsRaw.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const id = stableAccioId(upstreamKey, display)
  const usageMultiple = pickNumber(entry, ['usageMultiple'])

  return {
    id,
    name: accioRemoteDisplayName(display, usageMultiple),
    contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 0,
    supportsImage: entry['multimodal'] === true,
    supportsReasoning: efforts.length > 0,
    reasoningEfforts: efforts,
    // 落点由目录里的 `protocol` 决定，**不按模型名猜**（见 `accio-product.ts`）。
    reasoningPlacement: effortPlacement(entry),
    upstreamKey,
  }
}

/**
 * 思考档位该放哪一层（与 `accio-product.ts` 的对照表同一口径）。
 *
 * | `protocol` | 例子 | 落点 | 依据（实测） |
 * |---|---|---|---|
 * | `responses` | GPT 系 | `properties` | 只有 properties 能出思考内容 |
 * | `openai` | MiniMax | `properties` | 同上（沿同一落点） |
 * | 空 / 其它 | Claude / Gemini 系 | `top` | Gemini 放 properties 是**硬 400** |
 *
 * 兜底取「顶层」：它是唯一在三种模型上都不会报错的落点（Gemini 系放
 * properties 是硬错误，放顶层只是不产生思考内容 —— 少个功能好过 400）。
 */
function effortPlacement(entry: Record<string, unknown>): 'top' | 'properties' {
  const protocol = pickString(entry, ['protocol'])?.toLowerCase() ?? ''
  return protocol === 'responses' || protocol === 'openai' ? 'properties' : 'top'
}

/**
 * 对外模型 id：**能沿用老名字就沿用**。
 *
 * ## 为什么需要这条
 *
 * 上游把目录里的模型名换成了不透明代号（`1Orbit-I9eY7YK8bW1f` 这种），而
 * 用户手上的配置写的是代号之前的名字（`claude-sonnet-4-6`）。若清单直接广告
 * 代号，那些配置会立刻 404。这里按**展示名**把它们接回来：目录里只要有
 * 「Claude Sonnet 4.6」这一条，它就沿用老名字当对外 id（发上游仍用代号）。
 *
 * ⚠️ 按展示名而不是硬编码代号：代号是上游随时会换的不透明串，硬编码进代码
 * 等于把「上游换次代号就失效」写进实现。
 *
 * ⚠️ **只接同一个模型**：版本跃迁（`kimi-k2.5` → `Kimi K2.6`）不接 ——
 * 用户点名 A 却拿到 B 是静默替换，宁可 404 让客户端看到相近候选。
 */
/**
 * 把展示名做成一个**可读且稳定**的对外 id。
 *
 * ## 为什么不直接用上游的 `modelCode`（真实故障）
 *
 * Accio 目录里的 `modelCode` 是**混淆代号**（`1Helix-G6aS8tR2qN7m`、
 * `1Orbit-I9eY7YK8bW1f`、`1Nexus-…`、`1Drift-…`）。早期实现拿它当对外 id，
 * 于是账号管理的「模型列表」每行都长这样：
 *
 * ```text
 *   GPT 6 Astra        1Helix-G6aS8tR2qN7m
 *   Claude Sonnet 4.6  1Orbit-I9eY7YK8bW1f
 * ```
 *
 * 用户报障「模型列表为什么是乱码」—— 名字没错，是 id 列在显示上游的内部代号。
 * 更糟的是这个 id 是**用户要在自己客户端里填的模型名**，让人去填
 * `1Orbit-I9eY7YK8bW1f` 显然不合理。
 *
 * ## 为什么可以换掉它
 *
 * 对外 id **不是**发给上游的名字：适配器发送时取的是 `entry.upstreamKey`
 * （见 `accio-adapter.ts` 的 `const upstreamKey = entry?.upstreamKey ?? options.model`），
 * 所以 id 纯粹是本地的路由/持久化标识与展示名，可以自由可读化。
 *
 * ## 取值顺序
 *
 * 1. **兜底表命中** → 用它的 id（`claude-sonnet-4-6` 这类**已经是可读 slug**，
 *    且是既有账号/会话里可能已经用过的名字，保持不变最稳）；
 * 2. 否则 → 把展示名 slug 化（`GPT 6 Astra` → `gpt-6-astra`）；
 * 3. 展示名 slug 化后为**空**（纯中文名，实测有 `极致` / `专业` 两条）→
 *    退回 `upstreamKey`。中文 id 在部分客户端与命令行里要额外转义，
 *    不如留代号：宁可难读，也不要制造一个会被截断/转义的 id。
 *
 * ⚠️ 同名消歧**不在这里做**：slug 化会让「展示名重复」的条目撞 id
 * （实测 `Qwen 3.8 Max` / `Qwen 3.8 Flash` / `DeepSeek V4 Flash` / `Qwen 3 Max` /
 * `Auto` 各出现两次），那要在能看见整份目录的地方统一处理 ——
 * 见 `parseAccioModelCatalog` 的消歧段。
 */
function stableAccioId(upstreamKey: string, display: string): string {
  const wanted = display.trim().toLowerCase()
  for (const model of ACCIO.fallbackModels) {
    if (model.name.trim().toLowerCase() === wanted) return model.id
  }
  const slug = display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : upstreamKey
}

/**
 * 展示名（含计费倍率）。
 *
 * ⚠️ 倍率必须拼进 `name`（**不是** `description`）：composer 的模型切换菜单
 * 只渲染 `name`。形态照抄 raccoon 的 ` · x…` 后缀。
 *
 * ⚠️ **1 倍也要显示**（raccoon 上被用户报障纠正过的结论）：省略会让该模型
 * 在列表里**看起来没有计费信息**，用户无法区分「它就是 1 倍」与「我们没取到
 * 倍率」。上游没给 `usageMultiple` 时不追加后缀（那才是真的「没取到」）。
 */
export function accioRemoteDisplayName(display: string, usageMultiple: number | undefined): string {
  const name = display.trim().length > 0 ? display.trim() : '未命名模型'
  if (usageMultiple === undefined || !Number.isFinite(usageMultiple) || usageMultiple < 0) {
    return name
  }
  if (usageMultiple === 0) return `${name} · 免费`
  // 最多 4 位小数并去掉尾随 0（服务端实测值最多 2 位，留余量）。
  return `${name} · x${String(Number(usageMultiple.toFixed(4)))}`
}
