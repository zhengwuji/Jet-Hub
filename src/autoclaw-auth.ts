/**
 * AutoClaw 认证服务（两地两套登录方式）。
 *
 * ## 两个地区的登录**形态完全不同**（这是本文件最要紧的一件事）
 *
 * | 维度 | 国内版 `autoclaw` | 国际版 `autoclaw-intl` |
 * |---|---|---|
 * | 方式 | **手机验证码** | **Zai / Google OAuth 网页登录** |
 * | 两步式 `startLogin` | **不适用**（没有可打开的登录页） | 起本地回调口，立即返回 `oauth_url` |
 * | 入口 | `sendSmsCode` / `loginWithSmsCode` | `startLogin` / `loginWithOAuth` |
 *
 * ⚠️ **国内版调 `startLogin` 会抛错**（不是返回空 URL 让前端去猜）：
 * 前端必须按 `product.loginMode` 分流到短信 RPC，否则用户会卡在一个
 * 永远不会成功的弹窗上。错误文案直接给出该走哪两个 RPC。
 *
 * ## 为什么必须两步式（国际版）
 *
 * `window.open` 只在用户手势的短暂窗口内有效。等浏览器授权完成才返回 URL
 * 会让弹窗被拦截器拒绝，前端兜底逻辑随之把**整个设置页**导航到登录页
 * （AGENTS.md 记录过的真实缺陷）。故 `startLogin` 起好回调口、拿到
 * `oauth_url` 就**立即**返回，授权结果在后台的 `result` 里等。
 *
 * ## 两条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `AUTOCLAW_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import { errorDetail } from './http-error.js'
import {
  decodeAutoclawJwtExpMs,
  isAutoclawRefreshable,
  parseAutoclawCredential,
  autoclawSignedHeaders,
  type AutoclawCredential,
  type AutoclawRemoteModel,
} from './autoclaw.js'
import { AUTOCLAW, AUTOCLAW_CALLBACK_PORTS, type AutoclawProduct } from './autoclaw-product.js'

/** 控制面请求超时（毫秒）。 */
export const AUTOCLAW_REQUEST_TIMEOUT_MS = 20_000

/** 网页登录整体超时（毫秒）：用户从点开到在浏览器里点完授权。 */
export const AUTOCLAW_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 远端模型目录缓存 TTL（毫秒）。 */
export const AUTOCLAW_MODELS_CACHE_TTL_MS = 5 * 60 * 1000

/** 签名校验失败的业务码（**本机时钟漂移**，不是凭据问题）。 */
export const AUTOCLAW_SIGN_ERROR_CODE = 400002

/** 续期令牌失效的业务码。 */
export const AUTOCLAW_REFRESH_EXPIRED_CODE = 410000

/** 业务码：成功。 */
const CODE_OK = 0

/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 *
 * ⚠️ `name` 必须恰为 `RefreshTokenExpiredError` ——
 * `src/refresh.ts` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据（这些类跨模块 identity 不同）。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 登录/续期后的结果（与 `RaccoonLoginResult` / `LoomyLoginResult` 同构）。 */
export interface AutoclawLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 是否可续期（取决于是否存在 refresh_token）。 */
  refreshable: boolean
}

/** 只读登录状态。 */
export interface AutoclawLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/** 一次性登录流程的句柄（与 `StartedRaccoonLoginFlow` 同形）。 */
export interface StartedAutoclawLogin {
  /** 弹窗地址。**国内版为空串**（该地区没有可打开的登录页）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<AutoclawCredential>
  /** 主动关闭本地回调服务器。 */
  close: () => Promise<void>
}

/** `startLogin` 的选项。 */
export interface AutoclawStartLoginOptions {
  /** 身份提供方；默认 `zai`（Google 走另一条端点）。 */
  identityProvider?: 'zai' | 'google'
  /** 阿里云验证码令牌（上游 `oauth-captcha-config` 声明 `enabled` 时必需）。 */
  aliCaptchaVerifyParam?: string
  /** 设备指纹；省略时现生成（发码/换码必须沿用同一个值）。 */
  deviceId?: string
  /** 回调等待超时（毫秒）；默认 {@link AUTOCLAW_LOGIN_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
}

/** `loginWithOAuth` 的选项（阻塞式，供测试与探针）。 */
export interface AutoclawOAuthLoginOptions extends AutoclawStartLoginOptions {
  /**
   * 直接给出授权码（跳过回调等待）。
   *
   * 给定时**不会**起本地服务器 —— 但 `navigateUri` 必须与第 ② 步换
   * `oauth_url` 时**逐字相同**（上游按它校验换码请求），故此时通常也要
   * 显式传 `navigateUri`。
   */
  code?: string
  /** 与 `code` 配套的 state。 */
  state?: string
  /** 回调地址；仅在与 `code` 搭配时使用。 */
  navigateUri?: string
}

/** `AutoclawAuth` 的构造选项。 */
export interface AutoclawAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link AUTOCLAW}（国内版）。 */
  product?: AutoclawProduct
  /** 服务名覆盖（默认由产品 id 派生为 `autoclawAuth` / `autoclaw-intlAuth`）。 */
  serviceName?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * AutoClaw 国内版的认证服务。
     *
     * ⚠️ 服务名由产品 id 派生，两个地区各占一个（cordis 的 `Service` 同名
     * 二次注册会抛 `service "..." has been registered`）。
     */
    autoclawAuth: AutoclawAuth
    /**
     * AutoClaw 国际版的认证服务。
     *
     * ⚠️ 属性名带连字符，故**必须**用引号 —— 写成 `autoclaw-intlAuth`
     * 会被解析成减法表达式而报错。
     */
    'autoclaw-intlAuth': AutoclawAuth
  }
}

// ── 纯工具函数 ────────────────────────────────────────────────────────

/** 32 随机字节 → 64 位 hex（发码与登录必须沿用同一个值）。 */
export function newAutoclawDeviceId(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 归一化手机号（国内版）。
 *
 * 步骤：去空白/连字符 → 剥 `+86` / `86` 国家码 → 校验 11 位且 `1[2-9]` 开头。
 *
 * ⚠️ 剥 `86` **只在剩余长度恰好 11 位时**才做：裸 `startsWith('86')` 会把
 * `18600000000`（合法号码，以 1 开头）之类误伤 —— 实际不会命中，但
 * `86` 开头的 13 位串与 11 位串必须靠长度区分，不能只看前缀。
 *
 * 非法输入**抛错**而不是「原样发出去让上游报错」：上游对非法手机号的
 * 报错文案与「手机号未注册」难以区分，本地判掉能省一轮排查。
 */
export function normalizeAutoclawPhone(phone: string): string {
  const raw = typeof phone === 'string' ? phone.trim() : ''
  let digits = raw.replace(/[\s-]/g, '')
  if (digits.startsWith('+86')) digits = digits.slice(3)
  else if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2)
  if (!/^1[2-9]\d{9}$/.test(digits)) {
    throw new Error(`AutoClaw 手机号格式不正确（需 11 位、1[2-9] 开头）：${raw}`)
  }
  return digits
}

/** 安全读取对象字段（非对象时返回 undefined）。 */
function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 安全读取字符串字段。 */
function readString(source: unknown, key: string): string {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return ''
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/** 安全读取数字字段（含数字字符串）。 */
function readNumber(source: unknown, key: string): number {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return Number.NaN
  const value = (source as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

/** 安全读取布尔字段（严格 `=== true`）。 */
function readBool(source: unknown, key: string): boolean {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false
  return (source as Record<string, unknown>)[key] === true
}

/** 安全读取字符串数组。 */
function readStringArray(source: unknown, key: string): string[] {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return []
  const value = (source as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 从路由 id 里剥掉已知前缀，得到目录 id。 */
function stripRoutePrefix(routeId: string): string {
  for (const prefix of ['zaicoding_', 'zai_']) {
    if (routeId.startsWith(prefix) && routeId.length > prefix.length) return routeId.slice(prefix.length)
  }
  return routeId
}

/** 一次 HTTP 调用的结果。 */
interface AutoclawHttpResult {
  status: number
  /** 解析成功时的 JSON 对象；非 JSON / 空体时为 undefined。 */
  payload: Record<string, unknown> | undefined
  /** 响应原文（用于错误消息；非 JSON 时它就是唯一线索）。 */
  text: string
}

/** 读取响应体：先取文本再尝试解析，非 JSON 时保留原文。 */
async function readHttpResult(response: Response): Promise<AutoclawHttpResult> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return { status: response.status, payload: undefined, text: '' }
  }
  if (text.trim().length === 0) return { status: response.status, payload: undefined, text }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { status: response.status, payload: parsed as Record<string, unknown>, text }
    }
  } catch {
    // 非 JSON（网关 HTML 错误页等）：原文留给调用方做错误文案。
  }
  return { status: response.status, payload: undefined, text }
}

/** 把一次调用整理成一句可读的失败原因。 */
function describeFailure(result: AutoclawHttpResult, fallback: string): string {
  const detail = errorDetail(result.text)
  if (detail.trim().length > 0) return detail.trim()
  return `${fallback}（HTTP ${result.status}）`
}

// ── 网页登录回调服务器 ────────────────────────────────────────────────

/** 回调地址的路径（两地/两种提供方各一条）。 */
function callbackPathFor(identityProvider: 'zai' | 'google'): string {
  return identityProvider === 'google' ? '/auth/callback-google' : '/auth/callback-zai'
}

/**
 * 回调地址**必须用 `localhost`**。
 *
 * ⚠️ 实测：写 `127.0.0.1` 会被 Zai 拒（`redirect_uri` 校验按字面量比对）。
 * 而 `server.listen` 仍绑 `127.0.0.1`（回调只可能来自本机浏览器，
 * 不对外暴露监听面）—— 二者不矛盾，`localhost` 在本机解析到 `127.0.0.1`。
 */
function navigateUriFor(identityProvider: 'zai' | 'google', port: number): string {
  return `http://localhost:${port}${callbackPathFor(identityProvider)}`
}

/** 回调带来的授权参数。 */
interface AutoclawOAuthCallbackParams {
  code: string
  state: string
}

/** 已启动的回调服务器句柄。 */
interface StartedAutoclawOAuthCallback {
  navigateUri: string
  result: Promise<AutoclawOAuthCallbackParams>
  close: () => Promise<void>
  /**
   * 回填上游下发的 `state`（有则校验回调里的 state）。
   *
   * ⚠️ `state` 由**上游**生成（第 ② 步的请求体里没有 state 参数），
   * 故我们只能从 `oauth_url` 里读出来再比对 —— 若上游没给，
   * 就退化为「原样转交」，不能凭空造一个自己的 state 去要求回调带回来。
   */
  setExpectedState: (state: string | undefined) => void
}

/** 在候选端口里依次尝试监听，返回第一个可用的端口。 */
async function listenOnFirstFreePort(
  server: ReturnType<typeof createServer>,
  ports: readonly number[],
): Promise<number> {
  let lastReason = '未知原因'
  for (const port of ports) {
    try {
      return await new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve(port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
  }
  // ⚠️ 不能退到系统分配的随机端口：这几个端口是**注册在 Zai 侧的白名单**，
  //    换端口会在授权页被拒（见 `AUTOCLAW_CALLBACK_PORTS` 的注释）。
  throw new Error(
    `AutoClaw 登录回调端口全部被占用（${ports.join('、')}）：${lastReason}。`
    + '请关闭占用这些端口的程序后重试。',
  )
}

/** 从 `oauth_url` 的查询串里读上游下发的 state（读不到返回 undefined）。 */
function readStateFromOAuthUrl(oauthUrl: string): string | undefined {
  try {
    const value = new URL(oauthUrl).searchParams.get('state')
    return value !== null && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 起本地回调服务器，等 `?code=&state=`。
 *
 * ## 回调必须**幂等**
 *
 * 浏览器会对同一地址发多次请求（预取、刷新、扩展探测）。第二次起若还走
 * 「解析 → 落定」的路径，会与第一次的结果竞争；若走「参数无效」路径，
 * 用户会在已经成功的页面上看到一句失败提示。故这里一旦落定过，
 * 后续请求一律回 200 成功页、不再改结果。
 *
 * ## 超时定时器必须 `unref`
 *
 * 它只是兜底窗口（默认 5 分钟），不该阻止进程正常退出
 * （与 `src/refresh.ts` 的 `timer.unref?.()` 同款处理）。
 */
async function startAutoclawOAuthCallback(
  identityProvider: 'zai' | 'google',
  timeoutMs: number = AUTOCLAW_LOGIN_TIMEOUT_MS,
): Promise<StartedAutoclawOAuthCallback> {
  const path = callbackPathFor(identityProvider)
  let settled = false
  let expectedState: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  let resolveResult!: (value: AutoclawOAuthCallbackParams) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AutoclawOAuthCallbackParams>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 这个 Promise 是手工创建的、要过一会儿才被消费，而回调处理器可能在
  // 「构造完成」与「被 await」之间就把它 reject 掉（浏览器回调极快、
  // 或超时极短）。那一段窗口里 Node 会把它视为**未处理的拒绝**并打印告警。
  // 先挂一个空处理器把「已处理」标记打上即可消除，不影响后续消费者。
  result.catch(() => {})

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    // 幂等：已落定过就只回成功页，不再触碰结果（见函数注释）。
    if (settled) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
      return
    }
    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (code.length === 0) {
      // 缺 code 的探测请求（favicon、扩展扫描）：如实回 400，但**不落定**
      // —— 真正的回调随后就到，提前失败会让整个登录白跑一趟。
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调缺少 code')
      return
    }
    if (expectedState !== undefined && state !== expectedState) {
      // state 不匹配：可能是伪造或串了会话。同样**不落定**（真正的回调
      // 可能只是排在后面），但要让浏览器里看到明确反馈。
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调 state 校验失败')
      return
    }
    settled = true
    if (timer) clearTimeout(timer)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
    resolveResult({ code, state })
  })

  const port = await listenOnFirstFreePort(server, AUTOCLAW_CALLBACK_PORTS)

  timer = setTimeout(() => {
    rejectResult(new Error(
      `AutoClaw 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成授权）`,
    ))
    server.close()
  }, timeoutMs)
  timer.unref?.()

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return {
    navigateUri: navigateUriFor(identityProvider, port),
    result,
    close,
    setExpectedState: (state: string | undefined) => { expectedState = state },
  }
}

// ── 响应解析（纯函数，导出供单测） ────────────────────────────────────

/** 从登录/换码响应的 `data` 里取凭据字段。 */
function credentialFromData(
  data: Record<string, unknown> | undefined,
  deviceId: string,
  productId: string,
): AutoclawCredential {
  const accessToken = readString(data, 'access_token')
  if (accessToken.length === 0) {
    throw new Error('AutoClaw 登录响应缺少 access_token')
  }
  const refreshToken = readString(data, 'refresh_token')
  const userId = readString(data, 'user_id')
  // 昵称字段上游换过名字：`user_name`（OAuth）与 `nickname`（部分业务接口）。
  const nickname = readString(data, 'user_name') || readString(data, 'nickname')
  const email = readString(data, 'email')
  const expMs = decodeAutoclawJwtExpMs(accessToken)
  return {
    access_token: accessToken,
    ...refreshToken.length > 0 ? { refresh_token: refreshToken } : {},
    ...deviceId.length > 0 ? { device_id: deviceId } : {},
    ...userId.length > 0 ? { user_id: userId } : {},
    ...nickname.length > 0 ? { nickname } : {},
    ...email.length > 0 ? { email } : {},
    ...expMs !== undefined ? { expires_at: expMs } : {},
    provider: productId,
  }
}

/**
 * 解析模型目录响应。
 *
 * ⚠️ 该端点的响应**顶层直接是 `{"models":[...]}`，没有 `{code,data}` 信封** ——
 * 照抄其它 provider 的 `code !== 0` 判据会把一份完全正常的目录判成失败
 * （`code` 为 undefined，`undefined !== 0` 成立），表现为「模型目录永远是空的」。
 */
export function parseAutoclawModelConfig(payload: unknown): AutoclawRemoteModel[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const models = (payload as Record<string, unknown>).models
  if (!Array.isArray(models)) return []

  const seen = new Set<string>()
  const out: AutoclawRemoteModel[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    // ⚠️ 条目里的 `id` 是**完整 routeId**（`zaicoding_glm-5.3`），不是通用名。
    const routeId = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (routeId.length === 0) continue
    const id = stripRoutePrefix(routeId)
    if (seen.has(id)) continue
    seen.add(id)

    const input = readStringArray(entry, 'input').map((value) => value.toLowerCase())
    const contextWindow = readNumber(entry, 'contextWindow')
    const maxTokens = readNumber(entry, 'maxTokens')
    // `creditConsumptionLevel` **只认字符串**：数字形态没有文案，
    // 而「不要编造数字映射」是硬约束（见适配器的展示名逻辑）。
    const level = readString(entry, 'creditConsumptionLevel').trim()
    out.push({
      id,
      routeId,
      name: readString(entry, 'name').trim() || id,
      contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 0,
      supportsImage: input.includes('image'),
      // 上游目录不区分工具调用能力；本插件经该通道发的都是 agent 请求，
      // 故恒 true（写死比「缺字段就当不支持」更符合事实）。
      supportsToolCall: true,
      ...level.length > 0 ? { creditConsumptionLevel: level } : {},
    })
  }
  return out
}

/** 把钱包条目归一成一个资源包（字段口径见 `src/credits.ts` 的 `CreditPackage`）。 */
function packageFromWallet(
  name: string,
  unit: string,
  balance: number,
  active: boolean,
): CreditPackage {
  return {
    name,
    unit,
    remaining: balance,
    // 单钱包没有「总额度」概念：把 balance 同时当作 total，
    // UI 因此显示「已用 0 / 共 N」，而不是一个凭空的巨大分母。
    total: balance,
    used: 0,
    active,
    // 三个时间字段上游不下发，如实留空（不编造时间）。
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 解析 `v2/wallets` 响应。
 *
 * ⚠️ 钱包字段是**推测性**的（上游未提供文档），故这里只认能确认语义的几个：
 * `display_name` / `public_wallet_type` / `balance` / `display`，
 * 其余一律按「取不到」处理（填 0 / 空串），**不臆造**。
 *
 * @returns 解析成功时的余额；`code !== 0` 或无 wallets 时返回 null（由调用方回退 v1）。
 */
export function parseAutoclawWalletsV2(payload: unknown): CreditBalance | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const root = payload as Record<string, unknown>
  const code = readNumber(root, 'code')
  if (!Number.isFinite(code) || code !== CODE_OK) return null
  const data = readRecord(root, 'data')
  if (data === undefined) return null
  const wallets = data.wallets
  if (!Array.isArray(wallets) || wallets.length === 0) return null

  const packages: CreditPackage[] = []
  let sum = 0
  for (const raw of wallets) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const wallet = raw as Record<string, unknown>
    const balance = readNumber(wallet, 'balance')
    const amount = Number.isFinite(balance) ? balance : 0
    sum += amount
    const name = readString(wallet, 'display_name').trim() || readString(wallet, 'name').trim() || 'AutoClaw 额度'
    const unit = readString(wallet, 'public_wallet_type').trim() || 'credit'
    // ⚠️ 判据是 `display !== false`（不是「display 为真」）：缺字段时
    //    应当**保留**该钱包，否则一份不带 display 的正常响应会让余额全空。
    packages.push(packageFromWallet(name, unit, amount, wallet.display !== false))
  }
  if (packages.length === 0) return null

  const total = readNumber(data, 'total_balance')
  return {
    total: Number.isFinite(total) ? total : sum,
    packages,
    // 该端点不下发失效包的概念，如实填 0（不臆造）。
    expiredTotal: 0,
  }
}

/**
 * 解析 `v1/wallet-instances` 响应（v2 失败时的回退）。
 *
 * 只取 `status === 'active'` 且 `display` 为真的项，并把
 * `wallet_scope` 去掉 `wallet_scope_` 前缀后**按 scope 累加** ——
 * 同一 scope 下可能有多个实例，逐条列会让 UI 出现一堆同名的 0 额度条目。
 */
export function parseAutoclawWalletInstances(payload: unknown): CreditBalance | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const root = payload as Record<string, unknown>
  const code = readNumber(root, 'code')
  if (!Number.isFinite(code) || code !== CODE_OK) return null
  const data = readRecord(root, 'data')
  if (data === undefined) return null
  const instances = data.wallet_instances ?? data.wallets
  if (!Array.isArray(instances)) return null

  const byScope = new Map<string, { balance: number; unit: string }>()
  for (const raw of instances) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (readString(item, 'status') !== 'active') continue
    if (item.display !== true) continue
    const scopeRaw = readString(item, 'wallet_scope')
    const scope = scopeRaw.startsWith('wallet_scope_') ? scopeRaw.slice('wallet_scope_'.length) : scopeRaw
    const key = scope.length > 0 ? scope : 'credit'
    const balance = readNumber(item, 'balance')
    const amount = Number.isFinite(balance) ? balance : 0
    const unit = readString(item, 'public_wallet_type').trim() || 'credit'
    const existing = byScope.get(key)
    if (existing === undefined) byScope.set(key, { balance: amount, unit })
    else existing.balance += amount
  }
  if (byScope.size === 0) return null

  const packages: CreditPackage[] = []
  let total = 0
  for (const [scope, entry] of byScope) {
    total += entry.balance
    packages.push(packageFromWallet(scope, entry.unit, entry.balance, true))
  }
  return { total, packages, expiredTotal: 0 }
}

// ── 认证服务 ──────────────────────────────────────────────────────────

/**
 * AutoClaw 认证服务。
 *
 * 国内版走手机验证码，国际版走网页 OAuth —— 两条链路的公开方法互不重叠，
 * 调用方按 `product.loginMode` 分流（见模块头）。
 */
export class AutoclawAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: AutoclawProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 远端模型目录缓存（含时间戳，见 `fetchModels`）。 */
  private modelsCache: AutoclawRemoteModel[] | undefined
  private modelsCacheAt = 0
  /**
   * 待处理的发码会话：`device_id` 必须与登录时**逐字相同**。
   *
   * ⚠️ 只记 `device_id`、**不记手机号**：手机号是用户在表单里输入的，
   * 拿服务端记住的旧值去覆盖用户的新输入会让「改号码重发」失效。
   */
  private smsDeviceId: string | undefined

  constructor(ctx: Context, private readonly options: AutoclawAuthOptions = {}) {
    const product = options.product ?? AUTOCLAW
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 当前待处理会话的 `device_id`（发码时生成）。
   *
   * 暴露它是为了让调用方在 `login.sendSms` 与 `login.submitSms` 两次 RPC
   * 之间能拿到**同一个值**；正常链路直接给 `loginWithSmsCode` 传空串即可，
   * 服务会自动沿用（见该方法的注释）。
   */
  get pendingSmsDeviceId(): string | undefined {
    return this.smsDeviceId
  }

  /** 发一次带签名的 POST。 */
  private async signedPost(
    path: string,
    body: unknown,
    token = '',
    signal?: AbortSignal,
  ): Promise<AutoclawHttpResult> {
    const response = await this.fetchImpl(`${this.product.userapiBaseUrl}${path}`, {
      method: 'POST',
      headers: autoclawSignedHeaders(token),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })
    return readHttpResult(response)
  }

  /** 发一次带签名的 GET。 */
  private async signedGet(
    path: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<AutoclawHttpResult> {
    const response = await this.fetchImpl(`${this.product.userapiBaseUrl}${path}`, {
      method: 'GET',
      headers: autoclawSignedHeaders(token),
      signal: signal ?? AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
    })
    return readHttpResult(response)
  }

  // ── 国内版：手机验证码 ──────────────────────────────────────────────

  /**
   * 下发短信验证码（国内版）。
   *
   * 端点：`POST {userapi}/userapi/v1/agent-send-code`
   * body：`{phone, source_id:'autoclaw', device_id}`
   * 判据：`code === 0 && data.result === true`
   *
   * ⚠️ **只看 `code === 0` 是不够的**：实测该端点在「号码被风控/超频」时
   * 依然回 `code:0` 而 `data.result:false` —— 只判 code 会让前端进入
   * 「等验证码」状态，而短信根本没发出去。
   *
   * ⚠️ `device_id` 在此生成并**记住**，登录时必须沿用同一个值。
   */
  async sendSmsCode(phone: string): Promise<void> {
    const normalized = normalizeAutoclawPhone(phone)
    const deviceId = newAutoclawDeviceId()
    const result = await this.signedPost('/userapi/v1/agent-send-code', {
      phone: normalized,
      source_id: 'autoclaw',
      device_id: deviceId,
    })
    const code = readNumber(result.payload, 'code')
    const data = readRecord(result.payload, 'data')
    if (code !== CODE_OK || data?.result !== true) {
      throw new Error(`AutoClaw 发送验证码失败：${describeFailure(result, '发送验证码失败')}`)
    }
    // ⚠️ 只有**成功**才记住 device_id：失败时记住它会让用户重试登录时
    // 带一个从未发过码的设备号（上游会回 400001，与「验证码错误」同码，
    // 极难排查）。
    this.smsDeviceId = deviceId
  }

  /**
   * 用短信验证码登录（国内版）。
   *
   * 端点：`POST {userapi}/userapi/v1/agent-login/`（**结尾斜杠必须**）
   * body：`{phone, code:<JSON 数字>, platform:'web', source_id:'autoclaw', device_id}`
   *
   * ⚠️ **`code` 必须是 JSON 数字**。传字符串会被上游回 `400001`，
   * 而该码的文案是「验证码错误」—— 于是「明明验证码是对的却报验证码错误」
   * 这条排查路径会把人带偏（真实坑，见模块头与 `code` 的类型转换）。
   *
   * @param deviceId - 设备指纹。**正常链路传空串**：服务会自动沿用
   *   `sendSmsCode` 时生成的那一个（这是「发码与登录必须同一个值」的落地方式）。
   *   只有跨进程 / 测试（没有待处理会话）时才需要显式传入。
   * @returns 完整凭据（含 `device_id`，供后续续期使用）。
   */
  async loginWithSmsCode(phone: string, code: string, deviceId: string): Promise<AutoclawCredential> {
    const normalized = normalizeAutoclawPhone(phone)
    const trimmedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : ''
    // 优先用**发码时**记住的那个：验证码是发给它的，换一个必然失败。
    const effectiveDeviceId = this.smsDeviceId
      ?? (trimmedDeviceId.length > 0 ? trimmedDeviceId : newAutoclawDeviceId())

    const codeText = typeof code === 'string' ? code.trim() : ''
    const numericCode = Number(codeText)
    if (codeText.length === 0 || !Number.isFinite(numericCode)) {
      throw new Error('AutoClaw 验证码必须是数字')
    }

    const result = await this.signedPost('/userapi/v1/agent-login/', {
      phone: normalized,
      // ⚠️ 数字，不是字符串。`Number()` 已把 `"123456"` 转成 `123456`；
      // 这里显式取整只是为了让「它确实是整数」这一事实写在代码里 ——
      // 上游对该字段的类型判定是严格的（字符串直接 400001）。
      code: Math.trunc(numericCode),
      platform: 'web',
      source_id: 'autoclaw',
      device_id: effectiveDeviceId,
    })
    const envelopeCode = readNumber(result.payload, 'code')
    if (envelopeCode !== CODE_OK) {
      throw new Error(`AutoClaw 短信登录失败：${describeFailure(result, '短信登录失败')}`)
    }
    const credential = credentialFromData(
      readRecord(result.payload, 'data'),
      effectiveDeviceId,
      this.product.id,
    )
    // 登录成功：发码会话已完成，清掉以免被下一次登录误用。
    this.smsDeviceId = undefined
    this.lastRefreshError = undefined
    return credential
  }

  // ── 国际版：网页 OAuth ──────────────────────────────────────────────

  /**
   * 两步式登录：**立即返回 `loginUrl`**，授权结果在 `result` 里等。
   *
   * ⚠️ **国内版会抛错**：它没有可打开的登录页（入口是两个短信 RPC）。
   * 返回空 URL 会让前端走到「后端未返回登录地址」的分支，用户看不出
   * 真正原因 —— 抛错并把该走哪两个 RPC 写进文案，才是可执行的反馈。
   */
  async startLogin(options: AutoclawStartLoginOptions = {}): Promise<StartedAutoclawLogin> {
    if (this.product.loginMode !== 'oauth') {
      throw new Error('AutoClaw 国内版请用手机验证码登录（login.sendSms / login.submitSms）')
    }
    const identityProvider = options.identityProvider ?? 'zai'
    const deviceId = options.deviceId ?? newAutoclawDeviceId()
    const callback = await startAutoclawOAuthCallback(identityProvider, options.timeoutMs)

    let oauthUrl: string
    try {
      oauthUrl = await this.requestOAuthUrl({
        identityProvider,
        deviceId,
        navigateUri: callback.navigateUri,
        ...options.aliCaptchaVerifyParam === undefined
          ? {}
          : { aliCaptchaVerifyParam: options.aliCaptchaVerifyParam },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      // 拿不到授权地址：立刻关掉回调口，否则会一直占着白名单端口。
      await callback.close()
      throw error
    }
    callback.setExpectedState(readStateFromOAuthUrl(oauthUrl))

    const result = callback.result
      .then((params) => this.exchangeOAuthCode({
        identityProvider,
        deviceId,
        code: params.code,
        state: params.state,
        // ⚠️ 与第 ② 步**逐字相同**（上游按它校验换码请求）。
        navigateUri: callback.navigateUri,
      }))
      .finally(() => callback.close())
    // 结果可能早于调用方 await 而落定，先挂空处理器避免「未处理的拒绝」告警。
    result.catch(() => {})

    return { loginUrl: oauthUrl, result, close: callback.close }
  }

  /**
   * 阻塞式网页登录（起回调口 → 拿授权地址 → 等回调 → 换码）。
   *
   * 供测试与探针使用；`startLogin` 是它的两步式版本。
   *
   * 传 `code` 时跳过回调等待（直接换码）—— 但那时 `navigateUri` 必须与
   * 换 `oauth_url` 时用的值**逐字相同**。
   */
  async loginWithOAuth(options: AutoclawOAuthLoginOptions = {}): Promise<AutoclawCredential> {
    const identityProvider = options.identityProvider ?? 'zai'
    const deviceId = options.deviceId ?? newAutoclawDeviceId()

    if (options.code !== undefined && options.code.length > 0) {
      return this.exchangeOAuthCode({
        identityProvider,
        deviceId,
        code: options.code,
        state: options.state ?? '',
        navigateUri: options.navigateUri ?? navigateUriFor(identityProvider, AUTOCLAW_CALLBACK_PORTS[0]),
      })
    }

    const callback = await startAutoclawOAuthCallback(identityProvider, options.timeoutMs)
    try {
      const oauthUrl = await this.requestOAuthUrl({
        identityProvider,
        deviceId,
        navigateUri: callback.navigateUri,
        ...options.aliCaptchaVerifyParam === undefined
          ? {}
          : { aliCaptchaVerifyParam: options.aliCaptchaVerifyParam },
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      callback.setExpectedState(readStateFromOAuthUrl(oauthUrl))
      const params = await callback.result
      return await this.exchangeOAuthCode({
        identityProvider,
        deviceId,
        code: params.code,
        state: params.state,
        navigateUri: callback.navigateUri,
      })
    } finally {
      await callback.close()
    }
  }

  /**
   * 取 OAuth 授权地址。
   *
   * ① `POST {userapi}/userapi/overseasv1/oauth-captcha-config` body `{}`
   *    → `data { enabled, region, prefix, scene_id, captcha_supplier }`
   * ② `POST {userapi}/userapi/overseasv1/{zai|google}-oauth-url`
   *    body `{source_id:'autoclaw', device_id, navigate_uri, ali_captcha_verify_param}`
   *    → `data.oauth_url`
   *
   * ⚠️ 第 ① 步不能省：上游用它声明**是否需要阿里云验证码**。声明需要而
   * 我们没带令牌时，第 ② 步会失败（或给出一个打不开的地址），
   * 而这里的**显式报错**能让调用方知道该去接验证码组件 ——
   * 宿主侧 Node 进程没有 DOM，铸不出验证码令牌。
   */
  private async requestOAuthUrl(options: {
    identityProvider: 'zai' | 'google'
    deviceId: string
    navigateUri: string
    aliCaptchaVerifyParam?: string
    signal?: AbortSignal
  }): Promise<string> {
    const configResult = await this.signedPost(
      '/userapi/overseasv1/oauth-captcha-config',
      {},
      '',
      options.signal,
    )
    const configCode = readNumber(configResult.payload, 'code')
    if (configCode !== CODE_OK) {
      throw new Error(`AutoClaw 获取验证码配置失败：${describeFailure(configResult, '获取验证码配置失败')}`)
    }
    const captchaConfig = readRecord(configResult.payload, 'data')
    const captchaEnabled = readBool(captchaConfig, 'enabled')
    const captchaParam = options.aliCaptchaVerifyParam?.trim() ?? ''
    if (captchaEnabled && captchaParam.length === 0) {
      const sceneId = readString(captchaConfig, 'scene_id')
      const prefix = readString(captchaConfig, 'prefix')
      throw new Error(
        'AutoClaw 国际版登录需要先完成阿里云验证码（上游 captcha-config 声明 enabled=true）；'
        + `请提供 ali_captcha_verify_param（scene_id=${sceneId || '未知'}、prefix=${prefix || '未知'}）`,
      )
    }

    const urlResult = await this.signedPost(
      `/userapi/overseasv1/${options.identityProvider}-oauth-url`,
      {
        source_id: 'autoclaw',
        device_id: options.deviceId,
        navigate_uri: options.navigateUri,
        ali_captcha_verify_param: captchaParam,
      },
      '',
      options.signal,
    )
    const urlCode = readNumber(urlResult.payload, 'code')
    if (urlCode !== CODE_OK) {
      throw new Error(`AutoClaw 获取授权地址失败：${describeFailure(urlResult, '获取授权地址失败')}`)
    }
    const oauthUrl = readString(readRecord(urlResult.payload, 'data'), 'oauth_url').trim()
    if (oauthUrl.length === 0) {
      throw new Error('AutoClaw 获取授权地址失败：上游未返回 oauth_url')
    }
    return oauthUrl
  }

  /**
   * 用授权码换凭据。
   *
   * `POST {userapi}/userapi/overseasv1/{zai|google}-oauth-login`
   * body `{source_id:'autoclaw', device_id, code, state, navigate_uri}`
   * → `data { access_token, refresh_token, user_id, user_name, first_login }`
   *
   * ⚠️ `navigate_uri` 必须与换 `oauth_url` 时**逐字相同**：上游把它当作
   * 换码请求的一部分做一致性校验，差一个字符就会换码失败。
   */
  private async exchangeOAuthCode(options: {
    identityProvider: 'zai' | 'google'
    deviceId: string
    code: string
    state: string
    navigateUri: string
  }): Promise<AutoclawCredential> {
    const result = await this.signedPost(
      `/userapi/overseasv1/${options.identityProvider}-oauth-login`,
      {
        source_id: 'autoclaw',
        device_id: options.deviceId,
        code: options.code,
        state: options.state,
        navigate_uri: options.navigateUri,
      },
    )
    const code = readNumber(result.payload, 'code')
    if (code !== CODE_OK) {
      throw new Error(`AutoClaw 换取登录态失败：${describeFailure(result, '换取登录态失败')}`)
    }
    const credential = credentialFromData(
      readRecord(result.payload, 'data'),
      options.deviceId,
      this.product.id,
    )
    this.lastRefreshError = undefined
    return credential
  }

  // ── 凭据落库与状态 ──────────────────────────────────────────────────

  /**
   * 把登录结果落盘成凭据。
   *
   * 与 `loginWithSmsCode` / `loginWithOAuth` 分开：那两个方法只负责
   * 「拿到凭据」，写库（以及后续由 `index.ts` 登记的账号池条目）走这里。
   *
   * ⚠️ 过期时间**先按 JWT 重算**再写：上游的登录响应不带 `expires_at`，
   * 不补的话账号卡片会一直显示「无有效期」，续期调度也没有触发点。
   */
  async persistLogin(
    credential: AutoclawCredential,
    flowOptions: { refName?: string } = {},
  ): Promise<AutoclawLoginResult> {
    const refName = flowOptions.refName ?? this.credentialRefName
    const expMs = autoclawExpiryOf(credential)
    const stored: AutoclawCredential = {
      ...credential,
      provider: this.product.id,
      ...expMs === undefined ? {} : { expires_at: expMs },
    }
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(stored))
    this.lastRefreshError = undefined
    return {
      access: JSON.stringify(stored),
      expires: expMs ?? 0,
      ref,
      refreshable: isAutoclawRefreshable(stored),
    }
  }

  /** 只读登录状态。 */
  async status(): Promise<AutoclawLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = autoclawExpiryOf(credential)
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === undefined ? {} : { expiresAt },
      refreshable: isAutoclawRefreshable(credential),
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 解析默认 ref 的凭据。 */
  private async resolveDefaultCredential(): Promise<AutoclawCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      return resolved === undefined ? undefined : parseAutoclawCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  // ── 续期 ────────────────────────────────────────────────────────────

  /**
   * 续期默认单凭据。
   *
   * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new RefreshTokenExpiredError('凭据未配置，请先登录')
    if (!isAutoclawRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const next = await this.refreshCredential(credential)
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * 续期**指定 ref**（账号卡片「刷新」按钮 / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
   * `AUTOCLAW_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
   * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，
   * 被多账号操作污染会让 UI 显示错误的失效提示。
   */
  async refreshAccountCredential(refName: string): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseAutoclawCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isAutoclawRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    const next = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(next))
  }

  /**
   * 对一份凭据执行一次续期（不触碰存储）。
   *
   * 端点：`POST {userapi}/userapi/v1/refresh`
   * body：`{refresh_token, source_id:'autoclaw', device_id?}`
   *
   * ⚠️ **`400002` 必须降级重试一次 `agent-refresh`**：该码是
   * **签名校验失败**（本机时钟漂移 → `X-Auth-TimeStamp` 与服务器差太多），
   * 与凭据无关。两个端点走的是两套签名中间件，其中一个对时间更宽容 ——
   * 不降级的话，用户会因为「系统时间慢了 5 分钟」而反复被判「需要重新登录」。
   *
   * ⚠️ 终态判定只看 `401` / `410000`（refresh_token 失效）；其余非 0 一律
   * 抛普通 Error（可重试），避免一次网络抖动就让账号被判死。
   */
  private async refreshCredential(credential: AutoclawCredential): Promise<AutoclawCredential> {
    const body = {
      refresh_token: credential.refresh_token ?? '',
      source_id: 'autoclaw',
      ...credential.device_id === undefined || credential.device_id.length === 0
        ? {}
        : { device_id: credential.device_id },
    }

    // ⚠️ 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
    //    用普通 Error 让调用方（账号卡片 / 定时器）安排重试。
    let result: AutoclawHttpResult
    try {
      result = await this.signedPost('/userapi/v1/refresh', body)
    } catch (error) {
      throw new Error(`AutoClaw 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let code = readNumber(result.payload, 'code')
    if (code === AUTOCLAW_SIGN_ERROR_CODE) {
      // 签名校验失败（时钟漂移）：换另一个签名中间件的端点再试一次。
      try {
        result = await this.signedPost('/userapi/v1/agent-refresh', body)
      } catch (error) {
        throw new Error(`AutoClaw 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
      }
      code = readNumber(result.payload, 'code')
    }

    if (result.payload === undefined) {
      throw new Error(`AutoClaw 续期响应无法解析（HTTP ${result.status}）：${errorDetail(result.text)}`)
    }
    if (result.status === 401 || code === 401 || code === AUTOCLAW_REFRESH_EXPIRED_CODE) {
      throw new RefreshTokenExpiredError('AutoClaw 登录态已失效，请重新登录')
    }
    if (code !== CODE_OK) {
      throw new Error(`AutoClaw 续期失败：${errorDetail(result.text)}`)
    }
    const data = readRecord(result.payload, 'data')
    const accessToken = readString(data, 'access_token')
    if (accessToken.length === 0) {
      throw new Error('AutoClaw 续期响应缺少 access_token')
    }
    // ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
    // 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
    const nextRefresh = readString(data, 'refresh_token')
    const next: AutoclawCredential = {
      ...credential,
      access_token: accessToken,
      ...nextRefresh.length > 0 ? { refresh_token: nextRefresh } : {},
    }
    // `exp` 按**新 JWT** 重算；解不出时**删掉旧值**（旧 expires_at 属于旧令牌，
    // 留着会让 `refreshAll` 每个周期都判它已过期并反复续期）。
    const expMs = decodeAutoclawJwtExpMs(accessToken)
    if (expMs === undefined) delete next.expires_at
    else next.expires_at = expMs
    return next
  }

  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的
   * 自动选号，与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致
   * 停用账号的 refresh_token 在停用期间被放到失效（真实缺陷，见 AGENTS.md）。
   *
   * 单账号失败**不中断循环**，但必须留日志 —— 曾完全静默的实现让
   * 「续期永远失败但 UI 显示可续期」无法排查。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        const credential = parseAutoclawCredential(resolved.value)
        if (credential === undefined || !isAutoclawRefreshable(credential)) continue
        const next = await this.refreshCredential(credential)
        await this.ctx.credentials.set(ref, JSON.stringify(next))
        // 回写账号池：UI 读的是账号池的 `expiresAt`，不写会让它一直显示
        // 续期前的旧值（本插件在 raccoon 上踩过的真实缺陷）。
        await pool.updateAccount(entry.id, {
          expiresAt: autoclawExpiryOf(next) ?? undefined,
          refreshable: isAutoclawRefreshable(next),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(`[autoclaw] 账号 ${entry.id} 的 refresh_token 已失效，需重新登录`)
        } else {
          this.ctx.logger?.warn?.(
            `[autoclaw] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /** 登出：清除默认单凭据与待处理的发码会话。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
    this.smsDeviceId = undefined
  }

  /**
   * 停止认证服务生命周期。
   *
   * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
   * AutoClaw 的续期由统一调度器驱动，自身没有独立定时器；这里只清掉
   * 进程内缓存与待处理会话，不碰已落盘的凭据。
   */
  stop(): void {
    this.modelsCache = undefined
    this.modelsCacheAt = 0
    this.smsDeviceId = undefined
  }

  // ── 模型目录 ────────────────────────────────────────────────────────

  /**
   * 拉取远端模型目录。
   *
   * 端点：`GET {userapi}/autoclaw-proxy/proxy/autoclaw-model-config`
   *
   * ⚠️ **是同 host 的 `/proxy/` 一级，不是 `/proxy/autoclaw`** ——
   * 推理基址的尾缀是 `.../proxy/autoclaw`，目录端点是 `.../proxy/autoclaw-model-config`。
   * 把推理基址拿来拼目录会 404（两处只差一段路径，最容易照抄错）。
   *
   * ⚠️ **必须带 `X-Version: 1.18.5`**（`autoclawSignedHeaders` 已带）：
   * 这是**版本门控**，不带或带错版本会**少返回模型**而不报错。
   *
   * ## 缓存语义（5 分钟 + 失败保留上一份）
   *
   * - 命中 TTL 内缓存直接返回，不重复打网络；
   * - 失败（网络异常 / 非 200 / 解析不出）时返回**上一份成功结果**，
   *   且**不刷新时间戳** —— 下一个调用点会立刻重试，而不是再等 5 分钟。
   */
  async fetchModels(pool?: AccountPool): Promise<AutoclawRemoteModel[]> {
    const now = Date.now()
    if (this.modelsCache !== undefined && now - this.modelsCacheAt < AUTOCLAW_MODELS_CACHE_TTL_MS) {
      return this.modelsCache
    }
    const credential = await this.resolveForFetchModels(pool)
    if (credential === undefined) return this.modelsCache ?? []
    try {
      const result = await this.signedGet(
        '/autoclaw-proxy/proxy/autoclaw-model-config',
        credential.access_token,
      )
      if (result.status >= 400 || result.payload === undefined) return this.modelsCache ?? []
      const models = parseAutoclawModelConfig(result.payload)
      // 空目录按失败处理（保留上一份）：正常响应不会一份模型都没有，
      // 而把空数组写进缓存会让模型选择器**整个 provider 消失**。
      if (models.length === 0) return this.modelsCache ?? []
      this.modelsCache = models
      this.modelsCacheAt = now
      return models
    } catch {
      return this.modelsCache ?? []
    }
  }

  /** 取一个可用凭据（先账号池，再默认 ref）。 */
  private async resolveForFetchModels(pool?: AccountPool): Promise<AutoclawCredential | undefined> {
    if (pool !== undefined) {
      try {
        // ⚠️ 返回类型是 `| null`（不是 undefined）—— 判空必须用 `!= null` 或显式 null。
        const available = await pool.getAvailableAccount(this.product.id, '')
        if (available !== null && available !== undefined) {
          // `parseAutoclawCredential` 接受 `unknown`，故无需类型断言
          //（lint 棘轮盯着的双重类型断言正是要避免的写法）。
          const credential = parseAutoclawCredential(available.credential)
          if (credential !== undefined) return credential
        }
      } catch {
        // 落到默认 ref
      }
    }
    return this.resolveDefaultCredential()
  }

  // ── 积分 ────────────────────────────────────────────────────────────

  /**
   * 查询积分余额（供 Jet Hub 账号卡片）。
   *
   * ① `GET {userapi}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
   *    → `data.wallets[]` + `data.total_balance`
   * ② `code != 0` 或无 wallets 时回退
   *    `GET {userapi}/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all`
   *
   * 超时 20 秒。查不到返回 `null`（与「余额为 0」区分开，
   * 不要把网络故障显示成 0 积分）。
   *
   * ⚠️ 参数取 `unknown` 并在内部归一：账号池给的 `credential` 是宽类型，
   * 走 `parseAutoclawCredential` 就不必做类型断言。
   */
  async fetchCreditBalance(credential: unknown): Promise<CreditBalance | null> {
    const parsed = parseAutoclawCredential(credential)
    if (parsed === undefined) return null
    const signal = AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS)

    try {
      const result = await this.signedGet(
        '/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw',
        parsed.access_token,
        signal,
      )
      const balance = parseAutoclawWalletsV2(result.payload)
      if (balance !== null) return balance
    } catch {
      // 落到 v1
    }

    try {
      const fallback = await this.signedGet(
        '/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all',
        parsed.access_token,
        AbortSignal.timeout(AUTOCLAW_REQUEST_TIMEOUT_MS),
      )
      return parseAutoclawWalletInstances(fallback.payload)
    } catch {
      return null
    }
  }

  /**
   * 每日签到（领取积分）。
   *
   * `POST {userapi}/autoclaw-proxy/proxy/autoclaw-task-complete`
   * body `{task_id:'daily_signin'}`
   *
   * ## 幂等判据是**响应体字段**，不是 HTTP 状态码
   *
   * `claimed = reward_points > 0 || (success === true && already_completed === false)`
   * `already_completed === true` 一律算「今天已签到」。
   *
   * ⚠️ HTTP 200 + `success:false` 是**正常幂等返回** —— 只看状态码会把
   * 「今天已领过」显示成失败，用户会反复点。
   *
   * ⚠️ 参数取 `unknown`（同 `fetchCreditBalance`），内部归一。
   */
  async claimDailyCheckin(credential: unknown): Promise<ClaimOutcome> {
    const parsed = parseAutoclawCredential(credential)
    if (parsed === undefined) {
      return { kind: 'failed', code: -1, message: 'AutoClaw 凭据解析失败' }
    }
    let result: AutoclawHttpResult
    try {
      result = await this.signedPost(
        '/autoclaw-proxy/proxy/autoclaw-task-complete',
        { task_id: 'daily_signin' },
        parsed.access_token,
      )
    } catch (error) {
      return {
        kind: 'failed',
        code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }

    const code = readNumber(result.payload, 'code')
    const message = readString(result.payload, 'msg') || readString(result.payload, 'message')
    if (Number.isFinite(code) && code !== CODE_OK) {
      return { kind: 'failed', code, message: message.length > 0 ? message : 'AutoClaw 签到失败' }
    }

    // 数据可能在 `data` 里，也可能直接在顶层（该端点两种形态都出现过）。
    const data = readRecord(result.payload, 'data') ?? result.payload
    const alreadyCompleted = readBool(data, 'already_completed')
    if (alreadyCompleted) {
      return { kind: 'already-claimed', message: message.length > 0 ? message : '今天已签到' }
    }
    const rewardPoints = readNumber(data, 'reward_points')
    const success = readBool(data, 'success')
    const claimed = (Number.isFinite(rewardPoints) && rewardPoints > 0) || (success && !alreadyCompleted)
    if (claimed) {
      const streakDays = readNumber(data, 'streak_days')
      return {
        kind: 'claimed',
        credit: Number.isFinite(rewardPoints) ? rewardPoints : 0,
        streakDays: Number.isFinite(streakDays) ? streakDays : 0,
        isStreakDay: readBool(data, 'is_streak_day'),
      }
    }
    if (success === false) {
      // HTTP 200 + success:false 是正常返回：今天没有可领的（或活动未开启）。
      return { kind: 'inactive', message: message.length > 0 ? message : '今天暂无可领取的签到奖励' }
    }
    return {
      kind: 'failed',
      code: Number.isFinite(code) ? code : -1,
      message: message.length > 0 ? message : 'AutoClaw 签到失败',
    }
  }
}

/**
 * 凭据的过期时刻：显式 `expires_at` 优先，否则按 JWT 的 `exp` 重算。
 *
 * 单独抽出来是因为「落库」与「回写账号池」两处都要它 ——
 * 两处各写一份必然分叉，而分叉的症状是 UI 与凭据本身对不上。
 */
function autoclawExpiryOf(credential: AutoclawCredential): number | undefined {
  const expMs = decodeAutoclawJwtExpMs(credential.access_token)
  if (expMs !== undefined) return expMs
  const raw = credential.expires_at
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined
}
