/**
 * 腾讯 CodeBuddy 认证常量、凭据结构与纯解析逻辑
 *
 * 逆向自 CodeBuddy CN IDE (genie 扩展 v4.11.2) 的 external-link-v2 轮询式登录：
 * - fetchAuthState → POST /v2/plugin/auth/state?platform=ide 获取 state + authUrl
 * - openAuthUrl    → 打开浏览器到 https://www.codebuddy.cn/login/?platform=ide&state=...
 * - loopGetToken   → GET /v2/plugin/auth/token?state=... 轮询获取 token（1s 间隔，5min 超时）
 * - getAccount     → GET /v2/plugin/login/account?state=... 轮询获取账户信息
 * - refreshToken   → POST /v2/plugin/auth/token/refresh 刷新 token
 *
 * 与 CodeArts 的 PKCE OAuth + 本地回调服务器不同，CodeBuddy 采用**轮询式**：
 * 客户端不起本地服务器，而是定期轮询后端 API 检查登录状态。
 *
 * 本模块只放常量与纯函数（无网络、无存储），网络流程见 buddy-oauth.ts。
 */

// ── API 端点常量（逆向自 genie 扩展 product.json + index.js） ──

/** 主 API 端点（product.json endpoint）。 */
export const API_ENDPOINT = 'https://copilot.tencent.com'
/** API 路径前缀（product.json authentication.attributes.prefixPath）。 */
export const PREFIX_PATH = '/plugin'
/** 平台标识（product.json authentication.attributes.platform）。 */
export const PLATFORM = 'ide'
/** 登录网站首页（copilot.tencent.com → www.codebuddy.cn 映射）。 */
export const WEBSITE_HOME = 'https://www.codebuddy.cn'

/** 获取 auth state 端点：POST /v2/plugin/auth/state?platform=ide */
export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
/** 轮询 token 端点：GET /v2/plugin/auth/token?state=... */
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
/** 轮询账户端点：GET /v2/plugin/login/account?state=... */
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
/** 刷新 token 端点：POST /v2/plugin/auth/token/refresh */
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
/** 账户列表端点：GET /v2/plugin/accounts */
export const ACCOUNTS_PATH = '/v2/plugin/accounts'
/** 云端配置端点：GET /v3/config（获取模型列表、agents、productFeatures） */
export const CONFIG_PATH = '/v3/config'

// ── 轮询参数 ──

/** 登录轮询总超时（5 分钟，对齐 IDE 的 5*60*1e3）。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 轮询间隔（1 秒，对齐 IDE 的 setTimeout(o,1e3)）。 */
export const POLL_INTERVAL_MS = 1000
/** auth/state 请求超时（5 秒，对齐 IDE 的 timeout:5e3）。 */
export const STATE_REQUEST_TIMEOUT_MS = 5_000
/** 其余控制面请求超时（token/account/refresh/config）。 */
export const REQUEST_TIMEOUT_MS = 60_000

// ── 错误码（逆向自 IDE catch 分支） ──

/** token 尚未就绪（loopGetToken 中 continue 轮询）。 */
export const CODE_TOKEN_NOT_READY = 11217
/** 账户信息尚未完成（getAccount 中 continue 轮询）。 */
export const CODE_ACCOUNT_NOT_READY = 12151

// ── HTTP Header 常量（逆向自 IDE Jd/jM/qM 定义） ──

export const HTTP_HEADER_DOMAIN = 'X-Domain'
export const HTTP_HEADER_ENTERPRISE_ID = 'X-Enterprise-Id'
export const HTTP_HEADER_TENANT_ID = 'X-Tenant-Id'
export const HTTP_HEADER_NO_AUTHORIZATION = 'X-No-Authorization'
export const HTTP_HEADER_NO_USER_ID = 'X-No-User-Id'
export const HTTP_HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
export const HTTP_HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info'
export const HTTP_HEADER_REFRESH_TOKEN = 'X-Refresh-Token'
export const HTTP_HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'
export const HTTP_HEADER_PRODUCT = 'X-Product'
export const HTTP_HEADER_PRODUCT_CODE = 'X-Product-Code'

/**
 * User-Agent 标识（对齐 IDE 的 getUserAgent() → CodeBuddyIDE/${platformVersion}）。
 * platformVersion 来自 IDE product.json version 字段（1.106.1），非 genie 版本。
 */
export const BUDDY_USER_AGENT = 'CodeBuddyIDE/1.106.1'
/** X-Product-Code 值（对齐 IDE headers 设置）。 */
export const BUDDY_PRODUCT_CODE = 'codebuddy'
/** X-Product 默认值（deploymentType，对齐 ProductEndpointHttpInterceptor）。 */
export const BUDDY_DEPLOYMENT_TYPE = 'SaaS'
/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
export const AUTH_REFRESH_SOURCE = 'ide-main'

/** API 端点的裸域名（X-Domain 头的值）。 */
export const API_DOMAIN = 'copilot.tencent.com'

// ── 凭据数据结构 ──

/**
 * 持久化的 CodeBuddy 凭据。
 *
 * 对齐 IDE 的 auth 对象结构（accessToken/refreshToken/expiresAt/...）
 * 加上 account 对象（uid/nickname/enterpriseId/type）。除两个令牌外的字段
 * 均为可选，以便稳妥解析来自磁盘的旧版/部分凭据。
 */
export interface BuddyCredential {
  /** 访问令牌（Authorization: Bearer <access_token>）。 */
  access_token: string
  /** 刷新令牌（X-Refresh-Token header）。 */
  refresh_token: string
  /** token 过期时间（原始值，可能为毫秒时间戳或 ISO 字符串）。 */
  expires_at?: string
  /** refresh_token 过期时间。 */
  refresh_expires_at?: string
  /** token 类型（"Bearer"）。 */
  token_type?: string
  /** OAuth scope（通常为空）。 */
  scope?: string
  /** API 域名（"copilot.tencent.com"）。 */
  domain?: string
  /** 用户 ID（account.uid）。 */
  user_id?: string
  /** 用户昵称（account.nickname）。 */
  nickname?: string
  /** 企业 ID（account.enterpriseId，个人版为空）。 */
  enterprise_id?: string
  /** 账户类型（"personal" / "enterprise"）。 */
  account_type?: string
}

/** auth/token 与 auth/token/refresh 响应的令牌数据。 */
export interface BuddyToken {
  accessToken: string
  refreshToken: string
  expiresAt: string
  refreshExpiresAt: string
  tokenType: string
  scope: string
  domain: string
}

/** login/account 响应的账户数据。 */
export interface BuddyAccount {
  uid: string
  nickname: string
  enterpriseId: string
  accountType: string
}

/**
 * 从凭据 expires_at 解析毫秒时间戳（兼容毫秒时间戳 / 秒级时间戳 / ISO 8601）。
 * 无法解析或缺失时返回 undefined。
 *
 * 后备来源（e2e 实证 2026-09-11）：CodeBuddy 的 `/v2/plugin/auth/token`
 * **不返回绝对的 `expiresAt`**，只返回相对的 `expiresIn`。若凭据里的
 * `expires_at` 为空（历史写入或后端变更），回退到解析 access_token 这个
 * JWT 的 `exp` 声明——它同样是权威的过期时刻。
 */
export function credentialExpiresAtMs(credential: BuddyCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    // 纯数字：视为时间戳。> 1e12 为毫秒，否则为秒。
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 * 仅做 base64url 解码，不验签——该值只用于展示与续期调度。
 */
export function jwtExpiresAtMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JWT payload 读取 `nickname`（CodeBuddy 的 login/account 响应不含昵称，
 * 昵称只在 access_token 的声明里）。解析失败返回空串。
 */
export function jwtNickname(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const nickname = payload.nickname ?? payload.preferred_username ?? payload.name
    return typeof nickname === 'string' ? stripControlChars(nickname) : ''
  } catch {
    return ''
  }
}

/** 凭据是否已过期；无法解析过期时间时不判定过期（对齐 Rust is_expired）。 */
export function isExpired(credential: BuddyCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** 凭据是否携带可静默续期的 refresh_token。 */
export function isRefreshable(credential: BuddyCredential): boolean {
  return credential.refresh_token.length > 0
}

/** 构造基础请求头（X-Domain + User-Agent + 可选企业头）。 */
export function credentialRequestHeaders(credential: BuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: credential.domain ?? API_DOMAIN,
    'User-Agent': BUDDY_USER_AGENT,
  }
  if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
    headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id
    headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id
  }
  return headers
}

/** 构造带 Bearer 令牌的认证请求头。 */
export function credentialAuthHeaders(credential: BuddyCredential): Record<string, string> {
  return {
    ...credentialRequestHeaders(credential),
    Authorization: `Bearer ${credential.access_token}`,
  }
}

/**
 * 从 JSON 安全读取字符串字段（兼容后端把时间戳返回为数字）。
 *
 * 会剔除 CR/LF 等控制字符：CodeBuddy 的 `scope` 字段有时返回多行文本
 * （如 "profile\n    offline_access\n    email"）。这些换行会被凭据的
 * JSON 字符串原样携带，并在落盘到 YAML（`.credentials.yaml`）时被当作
 * 多行标量，破坏 JSON 结构 —— 重新读取时 `JSON.parse` 失败，表现为
 * 有效期/昵称等字段"丢失"（实际是整个凭据无法解析）。
 */
function readStringField(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return stripControlChars(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 去掉字符串中的控制字符（含 CR/LF/Tab），并把连续空白折叠为单个空格。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 从 JSON 读取数值字段（兼容后端返回数字型字符串）。 */
function readNumberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 若令牌本身未携带绝对 `expiresAt`，则用相对秒数（`expiresIn`）换算为绝对毫秒时间戳。
 * 换算基准取 access_token 的 JWT `exp`（优先，权威）或当前时刻。
 */
function absoluteExpiryMs(
  record: Record<string, unknown>,
  absoluteKey: string,
  relativeKey: string,
  accessToken: string,
): string {
  const absolute = readStringField(record, absoluteKey)
  if (absolute.length > 0) {
    // 归一化为毫秒时间戳字符串，交由 credentialExpiresAtMs 统一解析。
    const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute)
    if (Number.isFinite(asNumber)) {
      const ms = asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
      return String(ms)
    }
    return absolute
  }
  const relativeSeconds = readNumberField(record, relativeKey)
  if (relativeSeconds === undefined) {
    // 无相对值：交给 JWT exp 兜底（access_token 的 exp 即权威过期时刻）。
    return absoluteKey === 'expiresAt' ? '' : ''
  }
  // 基准：access_token 的签发时刻（iat）优先，缺失时用当前时刻。
  const baseMs = jwtIssuedAtMs(accessToken) ?? Date.now()
  return String(baseMs + relativeSeconds * 1000)
}

/** 从 JWT payload 读取 `iat`（秒）并换算为毫秒。 */
function jwtIssuedAtMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iat?: unknown }
    return typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JSON 解析令牌数据（兼容 camelCase 字段名与数字型时间戳）。
 *
 * e2e 实证（2026-09-11）：`/v2/plugin/auth/token` 实际只返回
 * `expiresIn` / `refreshExpiresIn`（相对秒数），**没有** `expiresAt` /
 * `refreshExpiresAt`。因此这里在绝对字段缺失时用相对秒数换算，
 * 否则凭据的 `expires_at` 会一直是空串（UI 显示"有效期未知"）。
 */
export function parseTokenData(data: unknown): BuddyToken {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const tokenType = readStringField(record, 'tokenType')
  const accessToken = readStringField(record, 'accessToken')
  return {
    accessToken,
    refreshToken: readStringField(record, 'refreshToken'),
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: readStringField(record, 'scope'),
    domain: readStringField(record, 'domain'),
  }
}

/**
 * 从 JSON 解析账户数据。
 *
 * `login/account` 响应不含 `nickname`（e2e 实证：只有 uid/nickname 之外的
 * 字段都为空），昵称实际在 access_token 的 JWT 声明里；调用方通过
 * `buildCredential` 时传入 token 以便回填。
 */
export function parseAccountData(data: unknown): BuddyAccount {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const accountType = readStringField(record, 'type')
  return {
    uid: readStringField(record, 'uid'),
    nickname: readStringField(record, 'nickname'),
    enterpriseId: readStringField(record, 'enterpriseId'),
    accountType: accountType.length > 0 ? accountType : 'personal',
  }
}

/**
 * 组合令牌与账户数据为可持久化的凭据。
 *
 * 昵称回填顺序（e2e 实证 2026-09-11：`login/account` 的 `nickname` 常为空，
 * 真正的昵称只在 access_token 的 JWT 声明里）：
 * account.nickname → JWT.nickname → JWT.preferred_username。
 * 过期时间同理：token.expiresAt 为空时由 credentialExpiresAtMs 从 JWT exp 兜底。
 */
export function buildCredential(token: BuddyToken, account: BuddyAccount): BuddyCredential {
  const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken)
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0 ? account.uid : jwtSubject(token.accessToken),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

/** 从 JWT payload 读取 `sub`（用户 id）；解析失败返回空串。 */
function jwtSubject(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    return typeof payload.sub === 'string' ? payload.sub : ''
  } catch {
    return ''
  }
}

// ── 模型列表 ──

/** 已知模型 ID → 展示名（/v3/config 不返回展示名，本地兜底映射）。 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'hy4-preview': 'Hy4 Preview',
  'hy4-preview-x': 'Hy4 Preview X',
  'hy3': 'Hy3',
  'hy3-x': 'Hy3 X',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5v-turbo': 'GLM-5V Turbo',
  'kimi-k3-1': 'Kimi K3-1',
  'kimi-k2.7': 'Kimi K2.7',
  'kimi-k2.6': 'Kimi K2.6',
  'minimax-m3': 'MiniMax M3',
}

/** 模型 ID → 人类可读显示名称；未知模型回退为 ID 本身。 */
export function displayNameForModel(id: string): string {
  return MODEL_DISPLAY_NAMES[id] ?? id
}

/** /v3/config 解析出的单个模型：id、展示名与远端声明的能力。 */
export interface BuddyRemoteModel {
  id: string
  name: string
  /** 上下文窗口（data.models[].maxInputTokens，模型自身配置）；远端未下发时缺省。 */
  contextWindow?: number
  /**
   * 单次请求输出上限（data.models[].maxOutputTokens）。
   *
   * ⚠️ 这是**必须消费**的权威字段，不是仅供参考的元数据：适配器早期把它只当
   * 「过滤补全模型」的判据（见 isChatModel），却从不下发到请求体，导致所有
   * buddy / workbuddy 模型都退化成网关默认输出上限（实测 32000），大文件写入
   * 与长回答会被截断成 `finish_reason: 'length'`。
   *
   * 实测（2026-09-19）各端点取值不完全一致：
   * - 中国版 scoped `/console/enterprises/personal/models` → deepseek-v4.1-flash = 128000
   * - 中国版 `/v3/config` → deepseek-v4.1-flash = 131072
   * - 国际版 `/v3/config` → deepseek-v4.1-flash = 128000
   * 与 `maxInputTokens` 同策略：采信实际命中的那个端点，不做跨端点取大。
   */
  maxOutputTokens?: number
  /** 是否接受图片输入（data.models[].supportsImages）。 */
  supportsImages?: boolean
  /**
   * 计费倍率（`data.models[].credits`）。
   *
   * 真实形态是**字符串**且格式不固定：`"x0.29"` / `"x0.03 credits"` / `""`（空）。
   * 归一化后存**纯文本**（如 `"x0.29"`），不存数字——因为它只是展示用，
   * 且带 ` credits` 后缀与空串两种退化形态，转数字会引入无谓的解析失败分支。
   * 远端未下发或解析不出时缺省。
   */
  creditsRate?: string
  /**
   * 促销后的实际倍率（`data.modelPromotions.discount.discountedCredits`）。
   *
   * 与 `creditsRate` 是**同族但独立**的两个字段：促销是全局活动（按模型 id
   * 索引），活动结束后服务端会把它改成 `"0x"` 或移除。存在且非 `0x` 时才带上。
   */
  discountedCreditsRate?: string
  /** 可选思考等级（data.models[].reasoning.supportedEfforts）；无等级可选的模型缺省。 */
  reasoningEfforts?: string[]
  /** 默认思考等级（data.models[].reasoning.defaultEffort）。 */
  defaultReasoningEffort?: string
}

/**
 * 归一化 `data.models[].credits` 为可展示的倍率文本。
 *
 * 真实形态（2026-09-19 实测，**字符串**而非数字）：
 * - `"x0.29"` / `"x1.62"` —— 常态（**x 在前**）
 * - `"x0.03 credits"` —— 早期 scoped 端点会带 ` credits` 后缀
 * - `""` / 字段缺失 —— 无倍率信息（如 `auto` / `codewise-*`）
 *
 * 返回 `"x0.29"` 这类**纯展示文本**（统一成 `x` 前缀，与官方 UI 一致）。
 * 解析不出时返回 undefined，**不回退成 `x1`**：编造倍率比不显示更糟。
 */
export function normalizeCreditsRate(value: unknown): string | undefined {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i)
}

/**
 * 归一化 `modelPromotions[].discount.discountedCredits`。
 *
 * ⚠️ 与 {@link normalizeCreditsRate} **形态相反**：实测促销值是 `"0.50x"`
 * （**x 在后**），而模型的 `credits` 是 `"x0.29"`（x 在前）。两者是同一后端
 * 的两套写法，不能共用一个正则 —— 早期版本只认前缀，导致**促销价全部解析
 * 失败且静默丢失**（单测直接暴露了这一点）。
 *
 * 另有一种已结束占位值 `"0x"`，归一化后是 `x0`，由调用方排除。
 */
export function normalizeDiscountedRate(value: unknown): string | undefined {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i)
}

/**
 * 倍率文本的共用解析：先试前缀写法，再试后缀写法，统一输出 `x<数字>`。
 *
 * 两种写法都接受（而非按调用方区分），是为了对上游格式变更更鲁棒：
 * 实测已经出现过同一后端两套写法共存的情况，若将来它们互换，本函数仍正确。
 */
function normalizeRate(value: unknown, prefixed: RegExp, suffixed: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  // 去掉可能存在的单位后缀（如 "x0.03 credits"）。
  const head = text.split(/\s+/)[0] ?? ''
  const match = prefixed.exec(head) ?? suffixed.exec(head)
  return match?.[1] !== undefined ? `x${match[1]}` : undefined
}

/**
 * 从 `data.modelPromotions` 提取「模型 id → 促销价」映射。
 *
 * 真实结构（**数组**，不是对象；每项按 `modelIds` 关联，不是全局）：
 * ```json
 * [{ "kind": "discount", "enabled": true,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough" },
 *    "modelIds": ["deepseek-v4-flash", "deepseek-v4-flash-ioa"] }]
 * ```
 *
 * 三个必须处理的退化情形：
 * - `"0x"` —— 活动已结束占位，**视为无促销**（照显会误导用户以为免费）；
 * - `enabled: false` —— 已停用，跳过；
 * - 同一模型命中多个活动 —— 取 `priority` 最高者（服务端用该字段表达优先级）。
 */
export function parsePromotions(record: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>()
  const promotions = record.modelPromotions
  if (!Array.isArray(promotions)) return result
  // 按 priority 升序排序后依次写入，使高 priority 覆盖低 priority。
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b))
  for (const item of sorted) {
    if (typeof item !== 'object' || item === null) continue
    const promotion = item as Record<string, unknown>
    if (promotion.enabled === false) continue
    const discount = promotion.discount
    if (typeof discount !== 'object' || discount === null) continue
    const rate = normalizeDiscountedRate((discount as Record<string, unknown>).discountedCredits)
    // "0x" 表示活动已结束：normalizeCreditsRate 会得到 "x0"，此处显式排除。
    if (rate === undefined || rate === 'x0') continue
    const modelIds = promotion.modelIds
    if (!Array.isArray(modelIds)) continue
    for (const id of modelIds) {
      if (typeof id === 'string' && id.length > 0) result.set(id, rate)
    }
  }
  return result
}

/** 读取促销项的 priority；缺失或非法时按 0（最低）处理。 */
function priorityOf(item: unknown): number {
  if (typeof item !== 'object' || item === null) return 0
  const priority = (item as Record<string, unknown>).priority
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0
}

/**
 * 组合计费倍率的展示文案：有促销时标出促销价，否则只显示原价。
 *
 * 形态：`"x0.17→x0.50"`；无促销时 `"x0.03"`。
 *
 * 用箭头而非「（促销 x…）」：这段文案会被拼进**模型切换菜单的名字**里
 * （见 buddy-adapter 的 displayNameFor），菜单宽度有限，箭头更短且一眼
 * 看出折扣幅度。
 */
export function formatCreditsRate(
  rate: string | undefined,
  discounted: string | undefined,
): string | undefined {
  if (rate === undefined) return discounted
  return discounted !== undefined ? `${rate}→${discounted}` : rate
}

/**
 * 从 /v3/config 响应解析可用的对话模型。
 *
 * 响应结构：{data: {agents: [{name: "craft", models: ["auto", ...]}, ...],
 *                     models: [{id, name, maxInputTokens, supportsImages, reasoning: {...}}],
 *                     productFeaturesConfig?: {ModelTrialBanner: {banners: [{targetModelId}]}}}}
 *
 * 解析策略（顺序即优先级）：
 * 1. **craft agent 引用的模型** —— 主对话模型，排在最前（中国版由它列出
 *    hy4-preview / glm-5.3 等具体 id）。
 * 2. **data.models 中剩余的可对话模型** —— 国际版的 craft 只引用 5 个抽象别名
 *    （default-model/fast-model/…），其余可用模型（如 o4-mini）只出现在
 *    data.models 里；若只取 craft，这些模型会在选择器中消失。
 * 3. **试用模型**（productFeaturesConfig.ModelTrialBanner）—— 例如国际版的
 *    hy4-preview：它既不在 craft 列表也不在 data.models，仅由试用横幅下发，
 *    但实测可正常调用，故一并加入。
 *
 * 过滤规则：跳过 `auto`（自动选择，非真实模型）、非对话用途的模型
 * （`text-to-image` 标签）与补全/NES 等专用模型（id 前缀 nes- / completion-）。
 * 解析失败时返回空数组，调用方回退内置列表。
 */
export function parseModelsFromConfig(body: unknown): BuddyRemoteModel[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>

  // data.models: id → 远端声明的模型元数据
  const metaById = new Map<string, Record<string, unknown>>()
  if (Array.isArray(record.models)) {
    for (const model of record.models as unknown[]) {
      if (typeof model !== 'object' || model === null) continue
      const entry = model as Record<string, unknown>
      if (typeof entry.id === 'string') metaById.set(entry.id, entry)
    }
  }

  // 促销折扣是**独立于 data.models 的全局活动表**，故先解析成 id → 促销价映射，
  // 再在 push 时按 id 关联（见 parsePromotions 的注释）。
  const promotions = parsePromotions(record)

  const parsed: BuddyRemoteModel[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (id === 'auto' || seen.has(id) || !isChatModel(id, metaById.get(id))) return
    seen.add(id)
    const meta = metaById.get(id)
    // 显示名优先用服务端下发的 name（如 `GPT-5.6-Sol`、`GLM-5.3`）；
    // 静态表只在服务端未给 name 时兜底 —— 新模型不在静态表里，
    // 而静态表对老模型的叫法可能已过时（如 kimi-k2.6 旧名 Kimi K2.6）。
    const remoteName = typeof meta?.name === 'string' && meta.name.length > 0 ? meta.name : undefined
    const rate = normalizeCreditsRate(meta?.credits)
    const discounted = promotions.get(id)
    parsed.push({
      id,
      name: remoteName ?? displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== undefined ? { creditsRate: rate } : {},
      ...discounted !== undefined ? { discountedCreditsRate: discounted } : {},
    })
  }

  // 1. 主对话 agent 引用的模型优先。
  //
  // 两个端点用不同的 agent 名承载「输入框可选的模型」：
  // - 企业模型端点（/console/enterprises/{scope}/models）用 `cli`；
  // - /v3/config 用 `craft`。
  // 取先出现的那个（两者不会同时存在）。
  for (const agentName of PREFERRED_AGENT_NAMES) {
    let found = false
    const agents = record.agents
    if (!Array.isArray(agents)) break
    for (const agent of agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const agentRecord = agent as Record<string, unknown>
      if (agentRecord.name !== agentName) continue
      if (Array.isArray(agentRecord.models)) {
        for (const model of agentRecord.models) {
          if (typeof model === 'string') push(model)
        }
      }
      found = true
      break
    }
    if (found) break
  }

  // 2. 补齐 data.models 里其余可对话模型（含企业端点独有的模型）
  for (const id of metaById.keys()) push(id)

  // 3. 追加试用模型（试用横幅下发的 targetModelId）
  for (const id of trialModelIds(record)) {
    if (id === 'auto' || seen.has(id)) continue
    seen.add(id)
    const meta = metaById.get(id)
    const rate = normalizeCreditsRate(meta?.credits)
    const discounted = promotions.get(id)
    parsed.push({
      id,
      name: displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== undefined ? { creditsRate: rate } : {},
      ...discounted !== undefined ? { discountedCreditsRate: discounted } : {},
    })
  }

  return parsed
}

/**
 * 承载「可选对话模型」清单的 agent 名，按优先级排列。
 *
 * - `cli`：企业模型端点（/console/enterprises/{scope}/models）使用；
 * - `craft`：/v3/config 使用。
 */
const PREFERRED_AGENT_NAMES = ['cli', 'craft'] as const

/** 从 productFeaturesConfig.ModelTrialBanner 提取试用模型 id。 */
function trialModelIds(data: Record<string, unknown>): string[] {
  const features = data.productFeaturesConfig
  if (typeof features !== 'object' || features === null) return []
  const banner = (features as Record<string, unknown>).ModelTrialBanner
  if (typeof banner !== 'object' || banner === null) return []
  const banners = (banner as Record<string, unknown>).banners
  if (!Array.isArray(banners)) return []
  const ids: string[] = []
  for (const item of banners) {
    if (typeof item !== 'object' || item === null) continue
    const target = (item as Record<string, unknown>).targetModelId
    if (typeof target === 'string' && target.length > 0) ids.push(target)
  }
  return ids
}

/**
 * 判断 data.models 中的条目是否为「可供用户选择的对话模型」。
 *
 * 排除三类非对话/不可用模型（判定依据来自真实的 /v3/config 响应与调用实测）：
 * - 补全/NES 专用模型：id 以 `nes-` / `completion-` 开头，或带 `supportsExtra`
 *   标记（codewise-completions / codewise-rewrite / codewise-jump），或
 *   `codewise-` 前缀（codewise-default-model-v2 实测返回
 *   `code 11102 model service info not found`，即后端未开放）；
 * - 输出上限过小的模型（≤256 tokens 的都是补全用途，对话模型普遍 ≥24000）；
 * - 带 `text-to-image` 标签的生成式模型（如 hunyuan-image-alpha）。
 *
 * 这些模型列进选择器会让用户选了之后报错，故一律过滤。
 */
function isChatModel(id: string, meta: Record<string, unknown> | undefined): boolean {
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.supportsExtra === true) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  const tags = meta?.tags
  if (Array.isArray(tags) && tags.some((tag) => tag === 'text-to-image')) return false
  return true
}

/**
 * 提取单个 data.models[] 条目的上下文窗口与对话能力。
 *
 * 上下文窗口只保留正数（与 Rust 端一致）。能力字段只在远端**显式**下发时保留：
 * 缺失即 undefined，交由适配器的静态兜底表决定，而不是猜成 false。
 */
function parseModelMeta(record: Record<string, unknown> | undefined): Omit<BuddyRemoteModel, 'id' | 'name'> {
  if (record === undefined) return {}
  const meta: Omit<BuddyRemoteModel, 'id' | 'name'> = {}
  const limit = record.maxInputTokens
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) meta.contextWindow = limit
  // 单次输出上限：与上下文窗口同样「只保留正数」，缺失即 undefined
  // （不猜默认值——猜错会要么截断用户输出、要么被服务端 400 拒绝）。
  const maxOutput = record.maxOutputTokens
  if (typeof maxOutput === 'number' && Number.isFinite(maxOutput) && maxOutput > 0) {
    meta.maxOutputTokens = maxOutput
  }
  if (typeof record.supportsImages === 'boolean') meta.supportsImages = record.supportsImages
  const reasoning = record.reasoning
  if (typeof reasoning === 'object' && reasoning !== null) {
    const fields = reasoning as Record<string, unknown>
    // supportedEfforts 是**可枚举**的等级列表，只在模型真正支持多等级时下发；
    // 只有单一默认 effort 的模型（glm-5.1/kimi-*）此处缺省，不暴露等级选择器。
    if (Array.isArray(fields.supportedEfforts)) {
      const efforts = fields.supportedEfforts.filter((e): e is string => typeof e === 'string' && e.length > 0)
      if (efforts.length > 0) meta.reasoningEfforts = efforts
    }
    if (typeof fields.defaultEffort === 'string' && fields.defaultEffort.length > 0) {
      meta.defaultReasoningEffort = fields.defaultEffort
    }
  }
  return meta
}
