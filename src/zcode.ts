/**
 * ZCode（智谱 / Z.AI）协议常量、凭据类型与纯函数。
 *
 * ## 这一家的登录为什么**没有本地回调端口**
 *
 * AutoClaw / Accio / Qoder 的网页登录都在本机起一个回调口（或等设备授权码），
 * ZCode 不是 —— 参考实现把这条链路记为 `startOAuthWithPolling`，并专门写明：
 * 造一个带 localhost `redirect_uri` 的授权地址会被上游拒
 * （`Redirect URI not registered for this client`）。故整条链是：
 *
 * ```text
 *   ① 生成 poll token（32 随机字节的十六进制）
 *   ② POST {zcode}/api/v1/oauth/cli/init        → flow_id / authorize_url / poll_interval_sec
 *   ③ 用户打开授权地址（补了中转页参数）→ 浏览器**不会**回到本机
 *   ④ GET  {zcode}/api/v1/oauth/cli/poll/{flow_id}  直到 status 变 ready
 *   ⑤ 拿 access_token **再换一次**推理凭证（见 `resolveZcodeCodingKey`）
 * ```
 *
 * ## 三个必须记住的坑（全部来自源码实测记录）
 *
 * 1. **第 ⑤ 步不可省**：OAuth 给的 `access_token` **不是**推理凭证，
 *    直接拿去打 `/chat/completions` 必 401（`token expired or incorrect`）。
 * 2. **中转页参数名两地不同**（国际 `redirect_uri` / 国内 `redirect`），且必须
 *    **set 替换**（不是 append）、整体**再编码一次**。写错的症状是 poll 静默
 *    停在 pending 直到超时 —— 最不直观的一种失败。
 * 3. **`app_version` 必须用 ZCode 客户端版本**（默认 `3.14.0`），
 *    用参考项目自己的版本号会得到 `1004 ineligible`，看起来像「账号没资格」。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ZcodeProduct } from './zcode-product.js'

/** 默认客户端版本（`ZCODE_APP_VERSION` 可覆盖）。 */
export const ZCODE_DEFAULT_APP_VERSION = '3.14.0'

/** 单次控制面请求超时（毫秒）。 */
export const ZCODE_REQUEST_TIMEOUT_MS = 15_000

/** 登录轮询的总超时（毫秒）。 */
export const ZCODE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 上游没给 `poll_interval_sec` 时的兜底轮询间隔（秒）。 */
export const ZCODE_DEFAULT_POLL_INTERVAL_SEC = 3

/** 续期提前窗口（毫秒）。本家**不可续期**，此常量仅供展示层判断「即将过期」。 */
export const ZCODE_EXPIRY_WARN_MS = 5 * 60 * 1000

/** 编码套餐业务域认的密钥名（同名复用，避免重复登录堆出一串密钥）。 */
export const ZCODE_API_KEY_NAME = 'zcode-api-key'

/**
 * ZCode 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识（选错字段会让限流记录无法归属账号）。
 *
 * 这里存的是**换取后的推理 API Key**（不是 OAuth 的原始令牌）——
 * 两者的区别见模块头第 1 条。
 */
export interface ZcodeCredential {
  /** 推理凭证（编码套餐的 API Key；国际版形如 `{apiKey}.{secret}`）。 */
  access_token: string
  /**
   * ZCode 套餐令牌（OAuth 响应顶层的 `token`）。
   *
   * 与 `access_token` **不能互相替代**：推理走开放平台的编码套餐端点，
   * 余额 / 领取走 ZCode 自己的 billing 接口，各认各的。只存 `access_token`
   * 会让余额查询直接不可用。
   */
  jwt?: string
  /** 设备标识（UUID v4 形态；跨请求稳定，见 `newZcodeUuid`）。 */
  device_mid?: string
  /** 上游用户 id（OAuth 响应的 `user.user_id`）。 */
  user_id?: string
  /** 过期时间（**毫秒时间戳**）。 */
  expires_at?: number
  /** 展示用昵称。 */
  nickname?: string
  /** 本凭据属于哪个地区（推理平面与账号 id 前缀都由它决定）。 */
  provider?: string
}

/**
 * 从任意来源解析 ZCode 凭据；形状不对返回 undefined（不抛错）。
 *
 * 参数取 `unknown` 而不是 `string`：调用点常常拿到的已经是解析过的对象
 * （账号池的 `credential`），走这里就不必做一次类型断言 —— 那正是
 * lint 棘轮盯着的双重断言写法。
 */
export function parseZcodeCredential(value: unknown): ZcodeCredential | undefined {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) return undefined
  return {
    access_token: record.access_token,
    ...typeof record.jwt === 'string' ? { jwt: record.jwt } : {},
    ...typeof record.device_mid === 'string' ? { device_mid: record.device_mid } : {},
    ...typeof record.user_id === 'string' ? { user_id: record.user_id } : {},
    ...typeof record.expires_at === 'number' ? { expires_at: record.expires_at } : {},
    ...typeof record.nickname === 'string' ? { nickname: record.nickname } : {},
    ...typeof record.provider === 'string' ? { provider: record.provider } : {},
  }
}

/** 客户端版本号（`ZCODE_APP_VERSION` 可覆盖）。 */
export function zcodeAppVersion(): string {
  const raw = process.env.ZCODE_APP_VERSION
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : ZCODE_DEFAULT_APP_VERSION
}

/**
 * 平台标识（参考实现的 `${process.platform}-${process.arch}`）。
 *
 * 上游把它当「客户端形态」的一部分。未知平台回落到 `win32-x64`。
 */
export function zcodePlatform(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win32-${arch}`
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  return 'win32-x64'
}

/** `X-Os-Category` 的取值（macos / windows / linux，认不出的落 linux）。 */
export function zcodeOsCategory(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

/**
 * RFC 3986 unreserved 之外的字节一律百分号编码。
 *
 * ⚠️ 这是**唯一**一份编码实现：中转页参数要把整个地址当成一个查询值编码
 * （见 `applyZcodeInterstitial`），业务链路的路径段也用它。
 */
export function zcodeUrlencode(value: string): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** 生成一个 UUID v4 形态的随机串（设备标识与逐请求追踪头共用）。 */
export function newZcodeUuid(): string {
  return randomUUID()
}

/** 32 随机字节的十六进制串（poll token）。 */
export function newZcodePollToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 读一个查询参数的值（用于判断上游给的 `redirect` 是什么形态）。
 *
 * 只做最小解析：按 `&` 切段、按第一个 `=` 分键值，值**不做百分号解码**
 * （这里只用来嗅探 `https://` 前缀，解码反而会引入歧义）。
 */
function readQueryParam(url: string, name: string): string | undefined {
  const head = url.indexOf('#') === -1 ? url : url.slice(0, url.indexOf('#'))
  const queryIndex = head.indexOf('?')
  if (queryIndex === -1) return undefined
  const prefix = `${name}=`
  for (const segment of head.slice(queryIndex + 1).split('&')) {
    if (segment.startsWith(prefix)) return segment.slice(prefix.length)
  }
  return undefined
}

/**
 * 把中转页参数补进服务端给的 `authorize_url`。
 *
 * ⚠️ **当前上游（2026-10-04 实测）根本不需要这一步，本函数会原样返回。**
 *
 * ── 实测形态（两个地区都测了）────────────────────────────────
 * ```text
 *   国内版  https://bigmodel.cn/login?appId=zcode
 *             &redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=…
 *   国际版  https://chat.z.ai/api/oauth/authorize?client_id=client_…
 *             &redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai&state=…
 * ```
 * 两地的回调**都已经指向服务端自己的 CLI 回调**
 * （`https://zcode.z.ai/api/v1/oauth/cli/callback/{bigmodel|zai}`）——
 * 浏览器授权完会回到那里，**服务端据此把这次授权记到我们的 `flow_id` 上**，
 * 随后 `poll` 才会从 `pending` 变 `ready`。
 *
 * ── 那为什么不能换掉它（真实故障，用户报障「登录上了但账号不显示」）──
 * 早期实现照抄参考实现的「补中转页」：把 `redirect` 换成
 * `{zcode}/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback`。
 * 那个中转页最终跳向 `zcode://oauth/callback` —— 一条**桌面客户端的自定义协议**。
 * 于是：授权结果被送去一个服务端收不到、我们更收不到的地方，
 * **服务端永远不知道该 flow 已授权** → `poll` 一直 `pending` →
 * 网关轮询到 5 分钟超时后把占位账号删掉。用户看到的就是
 * 「浏览器里明明登录成功，Jet Hub 里却没有账号」。
 *
 * 参考实现之所以要中转页，是因为**它面对的是另一代上游**：那时 `redirect`
 * 是 `zcode://` 自定义协议。**判据按形态走，不按版本猜**：
 * 上游给的 `redirect` 已经是 `http(s)://` → 它就是服务端回调，原样使用；
 * 只有遇到自定义协议（旧形态）时才套中转页兜底。
 *
 * ── 兜底分支的语义（保留，但当前不会走到）────────────────────
 * 语义是「set」不是「append」：同名参数替换，裸拼会留下两个同名参数。
 * 且中转页地址要**整体再编码一次**（`%3A` → `%253A`），否则内层的
 * `&app_version=…` 会被外层查询吃掉。
 */
export function applyZcodeInterstitial(product: ZcodeProduct, authorizeUrl: string): string {
  // 参数名**两地不同**：国际版（zai）是 redirect_uri，国内版（bigmodel）是 redirect。
  const param = product.upstreamProvider === 'zai' ? 'redirect_uri' : 'redirect'

  // 已经是 http(s) 服务端回调 → 原样使用（当前上游形态，见上方实测）。
  const existing = readQueryParam(authorizeUrl, param)
  if (existing !== undefined && /^https?:\/\//i.test(existing)) return authorizeUrl

  const target = zcodeUrlencode(
    `${product.zcodeOrigin}/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback`
    + `&app_version=${zcodeAppVersion()}`,
  )
  const prefix = `${param}=`
  const replacement = `${prefix}${target}`

  // 片段（`#…`）先摘下来：它不参与查询，替换完原样拼回
  const hashIndex = authorizeUrl.indexOf('#')
  const head = hashIndex === -1 ? authorizeUrl : authorizeUrl.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? undefined : authorizeUrl.slice(hashIndex + 1)
  const queryIndex = head.indexOf('?')
  const path = queryIndex === -1 ? head : head.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : head.slice(queryIndex + 1)

  let replaced = false
  const segments: string[] = []
  for (const segment of query.split('&').filter((value) => value.length > 0)) {
    if (segment.startsWith(prefix)) {
      // 重名参数只留一个（与 `set` 一致：它会把同名的全部删掉再放一个）
      if (!replaced) {
        segments.push(replacement)
        replaced = true
      }
      continue
    }
    segments.push(segment)
  }
  if (!replaced) segments.push(replacement)

  let out = `${path}?${segments.join('&')}`
  if (fragment !== undefined) out += `#${fragment}`
  return out
}

/**
 * 上游 `{code, data, msg}` 信封的错误提取：`code` 存在且不为 0 时返回一句人话。
 *
 * `code == 0` 才是成功。`code` 缺失视为成功（部分业务接口直接回数据体）。
 */
export function zcodeEnvelopeError(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const code = record.code
  if (typeof code !== 'number' || code === 0) return undefined
  const raw = typeof record.msg === 'string' ? record.msg
    : typeof record.message === 'string' ? record.message : ''
  const message = raw.trim().length > 0 ? raw.trim() : '上游拒绝'
  return `上游返回 ${code}：${message}`
}

/**
 * 从 JWT 的 payload 段读 `exp`（秒 → **毫秒**）。解不出返回 undefined。
 *
 * 不校验签名：这里只读一个展示用的时间戳，而令牌是上游刚下发的。
 */
export function zcodeJwtExpiresAtMs(token: string): number | undefined {
  const parts = typeof token === 'string' ? token.trim().split('.') : []
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    if (typeof payload !== 'object' || payload === null) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    // 上游若给的是毫秒（少数实现这么干），别再乘一次
    return exp > 1e12 ? exp : exp * 1000
  } catch {
    return undefined
  }
}

/**
 * 凭据的过期时刻（毫秒）。
 *
 * 取值链：`expires_at` → `access_token` 的 JWT `exp` → `jwt` 的 `exp`。
 * 三条都是「有就用」；全解不出返回 undefined（那一列空着，比编一个假时间诚实）。
 */
export function zcodeCredentialExpiresAtMs(credential: ZcodeCredential): number | undefined {
  if (typeof credential.expires_at === 'number' && Number.isFinite(credential.expires_at) && credential.expires_at > 0) {
    return credential.expires_at
  }
  return zcodeJwtExpiresAtMs(credential.access_token) ?? zcodeJwtExpiresAtMs(credential.jwt ?? '')
}

/**
 * ZCode **不可续期**（与 Loomy 同型，与 raccoon / qoder 相反）。
 *
 * 上游没有 refresh 端点：套餐 JWT 只带 `iat` 不带 `exp`，过期只以 401 暴露。
 * 凭据失效的唯一恢复路径是**重新登录**。因此恒返回 false ——
 * 这直接决定 `refreshAll()` 是否会碰它们（不会）。
 */
export function isZcodeRefreshable(_credential: ZcodeCredential): boolean {
  return false
}

/**
 * 账号 id（`accounts` 主键）。
 *
 * 前缀由地区给出（`zcode-user-` / `zcode-intl-user-`），于是两地的记录天然
 * 不相交 —— 同一个人在两套系统里的 user_id 可能相同，撞 id 会让存储层的
 * 保护拒绝写入，而「两地账号并存」正是两个 provider 建模的意义之一。
 *
 * `user_id` 为空时回落到随机后缀：不能落一个固定串（第二个空 id 账号会
 * 覆盖第一个），也不能落空 id（会让后续的 patch / remove 找不到它）。
 */
export function zcodeAccountId(product: ZcodeProduct, userId: string): string {
  const suffix = userId.trim().length > 0 ? userId.trim() : `anon-${randomBytes(6).toString('hex')}`
  return `${product.accountIdPrefix}${suffix}`
}

/** 展示名（账号列表里那一列）。 */
export function zcodeDisplayName(product: ZcodeProduct, credential: ZcodeCredential): string {
  const base = product.id === 'zcode' ? 'ZCode 国内版' : 'ZCode 国际版'
  const id = credential.user_id?.trim() ?? ''
  return id.length > 0 ? `${base} · ${id}` : base
}

/**
 * 推理请求上的「客户端身份头」。
 *
 * 编码套餐的入口是**给官方客户端用的**，上游按客户端形态识别请求。
 * 只发一个光秃秃的 `Authorization` 也能过鉴权，但上游一旦按形态限流或灰度，
 * 缺头就是难查的失败 —— 而这一套头是免费的。
 *
 * ⚠️ **故意不发 `X-Os-Version`**：参考实现取 `os.release()`，Node 侧要为此
 * 多一次系统调用；它是可选头，参考实现取不到时同样省略。
 */
export function zcodeIdentityHeaders(): Record<string, string> {
  const version = zcodeAppVersion()
  return {
    'HTTP-Referer': 'https://zcode.z.ai',
    'User-Agent': `ZCode/${version}`,
    'X-ZCode-App-Version': version,
    'X-Title': 'Z Code@cli',
    'X-Release-Channel': 'production',
    'X-Client-Language': 'unknown',
    'X-Client-Timezone': 'unknown',
    'X-ZCode-Agent': 'glm',
    'X-Platform': zcodePlatform(),
    'X-Os-Category': zcodeOsCategory(),
  }
}

// ── 编码套餐凭证换取（coding key）──────────────────────────────────

/**
 * 编码套餐业务接口的信封解包。
 *
 * 判定与参考实现同序：`code` 缺失视为成功（有的接口直接回数据体），
 * 取值 0 / 200（数字或字符串）都算成功。
 */
function bizCodeOk(code: unknown): boolean {
  if (typeof code === 'number') return code === 0 || code === 200
  if (typeof code === 'string') {
    const trimmed = code.trim()
    return trimmed === '0' || trimmed === '200' || trimmed === ''
  }
  return true
}

/** 一次业务接口调用（返回解包后的 `data`，没有 `data` 就返回整体）。 */
async function zcodeBizRequest(
  fetcher: typeof fetch,
  method: string,
  url: string,
  authorization: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // 空 authorization 表示**不发这个头**（`z/login` 是匿名接口，
  // 发一个空 Authorization 会让部分网关直接判 401）。
  if (authorization.trim().length > 0) headers.Authorization = authorization
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetcher(url, {
      method,
      headers,
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`ZCode 登录换取网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`ZCode 登录换取失败：上游响应不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message = bizEnvelopeError(payload) ?? `HTTP ${response.status}`
    throw new Error(`ZCode 登录换取被拒：${message}`)
  }
  const envelope = bizEnvelopeError(payload)
  if (envelope !== undefined) throw new Error(`ZCode 登录换取被拒：${envelope}`)
  if (typeof payload === 'object' && payload !== null && 'data' in payload) {
    return (payload as Record<string, unknown>).data
  }
  return payload
}

/**
 * 业务接口信封的错误提取：**0 / 200 都算成功**（与 OAuth 平面只认 0 不同）。
 *
 * ⚠️ 这不只是「宽松一点」：业务接口（`getCustomerInfo` / `api_keys` 等）确实
 * 会用 `code: 200` 表达成功。若在这里沿用 OAuth 平面那个「只认 0」的判据，
 * 一次本来成功的换取会被判成失败 —— 而症状是**登录整体失败**
 *（换取在落账号之前，失败即登录失败），排查时很难想到是「200 被当成错误」。
 */
function bizEnvelopeError(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (!('code' in record)) return undefined
  if (bizCodeOk(record.code)) return undefined
  const raw = typeof record.msg === 'string' ? record.msg
    : typeof record.message === 'string' ? record.message : ''
  const message = raw.trim().length > 0 ? raw.trim() : '上游拒绝'
  return `上游返回 ${String(record.code)}：${message}`
}

/** 从候选键里取第一个非空字符串（上游的 id 字段名换过几轮）。 */
function pickId(item: unknown, keys: readonly string[]): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 从对象里取第一个非空字符串（上游的字段名换过几轮）。 */
function pickString(item: unknown, keys: readonly string[]): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 换取编码套餐凭证：把 OAuth 登录拿到的 `accessToken` 换成**能用于推理的
 * API Key**（`apiKey` 或 `apiKey.secret` 两段形式）。
 *
 * ⚠️ **这一步不可省**（曾经漏掉的根因）：OAuth 轮询给的 `access_token`
 * 不是推理凭证，直接拿它去打 `/chat/completions` 会被上游按「OAuth 令牌」
 * 那条路校验并回 401。官方客户端与参考实现都先做一次换取。
 *
 * 三处地区差异都在这里分支：
 * 1. 国际版多一步 `POST {host}/api/auth/z/login`，国内版直接拿 OAuth 令牌当 biz 令牌；
 * 2. 业务接口的 `Authorization` 头：国际版 `Bearer {biz}`，国内版**裸令牌**；
 * 3. 国际版**必须**拿到 secretKey（拿不到就判登录失败 —— 宁可登录失败，
 *    也不要落一条永远签不了名、发出去必 401 的凭证），国内版可退回单段。
 */
export async function resolveZcodeCodingKey(
  product: ZcodeProduct,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const oauthToken = accessToken.trim()
  if (oauthToken.length === 0) throw new Error('ZCode 登录响应里没有可换取推理凭证的登录态')

  const host = product.bizHost
  const isIntl = product.upstreamProvider === 'zai'

  // 国际版：OAuth 令牌 → biz 令牌；国内版：OAuth 令牌直接当 biz 令牌
  let bizToken = oauthToken
  if (isIntl) {
    const payload = await zcodeBizRequest(fetcher, 'POST', `${host}/api/auth/z/login`, '', { token: oauthToken })
    // 响应形状按参考实现取三种可能 —— 上游在不同版本里换过位置
    const token = pickString(payload, ['access_token', 'accessToken'])
      ?? pickString(
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).data
          : undefined,
        ['access_token'],
      )
    if (token === undefined) throw new Error('ZCode 登录换取失败：上游未返回访问令牌')
    bizToken = token
  }
  const authorization = isIntl ? `Bearer ${bizToken}` : bizToken

  // ① 查默认机构与默认项目
  const customer = await zcodeBizRequest(
    fetcher, 'GET', `${host}/api/biz/customer/getCustomerInfo`, authorization,
  )
  const customerRecord = typeof customer === 'object' && customer !== null
    ? customer as Record<string, unknown> : {}
  const orgs = Array.isArray(customerRecord.organizations) ? customerRecord.organizations
    : Array.isArray(customerRecord.orgs) ? customerRecord.orgs : []
  if (orgs.length === 0) throw new Error('ZCode 登录换取失败：该账号下没有可用机构')
  // 优先按名字片段找「默认机构」，找不到退回第一个（与参考实现同序）
  const org = orgs.find((item) => (pickString(item, ['organizationName', 'name']) ?? '').includes('默认机构'))
    ?? orgs[0]
  const orgId = pickId(org, ['organizationId', 'id', 'orgId'])
  if (orgId === undefined) throw new Error('ZCode 登录换取失败：机构缺少标识')

  const orgRecord = typeof org === 'object' && org !== null ? org as Record<string, unknown> : {}
  const projects = Array.isArray(orgRecord.projects) ? orgRecord.projects : []
  if (projects.length === 0) throw new Error('ZCode 登录换取失败：默认机构下没有可用项目')
  const project = projects.find((item) => (pickString(item, ['projectName', 'name']) ?? '').includes('默认项目'))
    ?? projects[0]
  const projectId = pickId(project, ['projectId', 'id'])
  if (projectId === undefined) throw new Error('ZCode 登录换取失败：项目缺少标识')

  // ② 找同名密钥，没有就建一个
  const keysUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`
  let apiKey: string | undefined
  try {
    const listed = await zcodeBizRequest(fetcher, 'GET', keysUrl, authorization)
    if (Array.isArray(listed)) {
      for (const item of listed) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        if (record.name !== ZCODE_API_KEY_NAME) continue
        const key = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
        if (key.length > 0) {
          apiKey = key
          break
        }
      }
    }
  } catch {
    // 列表失败不致命（参考实现同样是 catch 后继续建）：没有列表权限但能建
    // 密钥的账号依然可用。真正的失败留给「建也失败」那一步。
  }
  if (apiKey === undefined) {
    const created = await zcodeBizRequest(fetcher, 'POST', keysUrl, authorization, { name: ZCODE_API_KEY_NAME })
    apiKey = pickString(created, ['apiKey'])
    if (apiKey === undefined) throw new Error('ZCode 登录换取失败：上游未返回新建密钥')
  }

  // ③ 取 secret（失败与「没给 secret」同义，都返回空串）
  let secret = ''
  try {
    const copied = await zcodeBizRequest(
      fetcher, 'GET', `${keysUrl}/copy/${zcodeUrlencode(apiKey)}`, authorization,
    )
    secret = pickString(copied, ['secretKey', 'secret_key']) ?? ''
  } catch {
    secret = ''
  }

  if (isIntl) {
    if (secret.trim().length === 0) {
      throw new Error(
        'ZCode 国际版未返回密钥 secret（无法用于推理），'
        + '请在 z.ai 控制台确认编码套餐已开通后重试',
      )
    }
    return `${apiKey}.${secret}`
  }
  return secret.trim().length === 0 ? apiKey : `${apiKey}.${secret}`
}

/** 计算 `sg_k` 之类的 md5 十六进制（小写、无填充）。 */
export function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex')
}
