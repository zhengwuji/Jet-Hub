/**
 * Accio（阿里 Accio Work）协议常量与纯函数。
 *
 * ## 这一家的三处「与其余九家都不同」
 *
 * | 维度 | accio | 对照 |
 * |---|---|---|
 * | 鉴权载体 | **body / query 里的 `token` / `accessToken`** | 其余家一律 `Authorization: Bearer` |
 * | 请求体 | **Gemini 风格 protobuf-JSON 信封**（`contents` / `system_instruction`） | 其余家是 OpenAI Chat 或自家信封 |
 * | 响应 | ADK 自定义 SSE（`content.parts` / `turn_complete`） | 其余家是 OpenAI SSE 或自家 SSE |
 *
 * 前两条决定了「请求体必须转换」，第三条决定了「响应必须自己解析」——
 * 本模块承载全部**纯函数**（可离线单测），网络与持久化在 `accio-auth.ts` /
 * `accio-adapter.ts`。
 *
 * ## 四个必须照抄的点（都是上游的实际约束，不是这里的取舍）
 *
 * 1. **`tool_config` 是 JSON 字符串**（内容是
 *    `{functionCallingConfig:{streamFunctionCallArguments:true}}`）——
 *    工具参数才能流式吐出来。
 * 2. **`function_call.args_json` / `function_response.response_json` 也是
 *    字符串**（里面才是 JSON 本体）。写成本体对象上游认不出参数。
 * 3. **`system_instruction` 是字符串**，不是 `{parts:[…]}` 那种 Content。
 * 4. **思考档位的落点由模型决定**（见 {@link AccioChatOptions.reasoningPlacement}）：
 *    Gemini 系放 `properties` 是**硬 400**（`Unknown name "reasoning_effort"`），
 *    GPT 系只有放 `properties` 才出思考内容。放错一边是报错、另一边是静默失效。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { AccioProduct } from './accio-product.js'

/**
 * 本插件 loopback 回调路径。
 *
 * 与其余走本地回调的 provider 同一约定：路径里带上厂商名，一眼能看出
 * 是哪一家的回调（`/auth/callback-accio`）。
 */
export const ACCIO_CALLBACK_PATH = '/auth/callback-accio'

/** 单次控制面请求超时（毫秒）。 */
export const ACCIO_REQUEST_TIMEOUT_MS = 15_000

/** 登录等待总超时（毫秒）。 */
export const ACCIO_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 续期提前窗口（毫秒）。
 *
 * 上游 token 的有效期在小时级；提前 5 分钟刷新可避免边界失败（与
 * raccoon / qoder / trae 同一量级）。
 */
export const ACCIO_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** 上游没给 `expiresAt` 时的保守默认存活时长（毫秒）。 */
export const ACCIO_DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * Accio 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识（选错字段会让限流记录无法归属账号）。
 *
 * 上游给的是 `accessToken` / `refreshToken` / `expiresAt`（驼峰），本插件
 * 一律落成 snake_case 以与其余九家统一；`parseAccioCredential` 两种写法都认，
 * 因此用户手工粘贴任意一种都能入库。
 */
export interface AccioCredential {
  /** 访问令牌（不透明串，**不是 JWT**，解不出 userId）。 */
  access_token: string
  /** 续期用（上游未给时为空，此时账号不可静默续期）。 */
  refresh_token?: string
  /**
   * 过期时刻（**毫秒时间戳**）。
   *
   * 由上游的 `expiresAt`（秒级数字 / 毫秒级数字 / RFC3339 字符串）归一而来，
   * 见 {@link accioCredentialExpiresAtMs}。
   */
  expires_at?: number
  /** 上游账号标识（`/api/auth/userinfo` 的 `id` / `userId`）。 */
  user_id?: string
  /** 邮箱（展示与多账号消歧用）。 */
  email?: string
  /** 昵称。 */
  nickname?: string
  /** 设备指纹（推理请求头 `utdid`；按账号生成，见 {@link newAccioDeviceId}）。 */
  device_id?: string
  /** 本凭据属于哪个地区（`intl` / `cn`；仅供排障与展示）。 */
  mode?: 'intl' | 'cn'
  /** 本凭据属于哪个 provider（`accio` / `accio-cn`）。 */
  provider?: string
}

/**
 * 从任意来源解析 Accio 凭据；形状不对返回 undefined（不抛错）。
 *
 * 参数取 `unknown` 而不是 `string`：调用点常常拿到的已经是解析过的对象
 * （账号池的 `credential`），走这里就不必做一次双重类型断言 —— 那正是
 * lint 棘轮盯着的写法（基线已顶满，一个新都不能加）。
 *
 * 键名**驼峰与下划线双读**：上游下发的是驼峰（`accessToken`），本插件落的
 * 是下划线；用户手工粘贴两种都可能出现。
 */
export function parseAccioCredential(value: unknown): AccioCredential | undefined {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const record = asRecord(parsed)
  if (record === undefined) return undefined
  const accessToken = pickString(record, ['access_token', 'accessToken', 'token'])
  if (accessToken === undefined) return undefined

  const refreshToken = pickString(record, ['refresh_token', 'refreshToken'])
  // 过期时间**逐键取值**而不是把 record 整体塞进 `accioCredentialExpiresAtMs`：
  // 后者只认 `expires_at`，而上游给的是驼峰 `expiresAt`（还有 `expires` 变体）。
  const expiresAt = timestampMs(
    record['expires_at'] ?? record['expiresAt'] ?? record['expires'],
  )
  const userId = pickString(record, ['user_id', 'userId', 'uid'])
  const email = pickString(record, ['email'])
  const nickname = pickString(record, ['nickname', 'name'])
  const deviceId = pickString(record, ['device_id', 'deviceId'])
  const mode = pickString(record, ['mode'])
  const provider = pickString(record, ['provider'])

  return {
    access_token: accessToken,
    ...refreshToken === undefined ? {} : { refresh_token: refreshToken },
    ...expiresAt === undefined ? {} : { expires_at: expiresAt },
    ...userId === undefined ? {} : { user_id: userId },
    ...email === undefined ? {} : { email },
    ...nickname === undefined ? {} : { nickname },
    ...deviceId === undefined ? {} : { device_id: deviceId },
    ...mode === 'intl' || mode === 'cn' ? { mode } : {},
    ...provider === undefined ? {} : { provider },
  }
}

// ── 通用取值助手（全部接受 unknown，避免调用点做类型断言）──────────────

/** 把 `unknown` 收窄成普通对象（数组与 null 都不算）。 */
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
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 取第一个布尔字段（缺省 false）。 */
function pickBool(source: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (source[key] === true) return true
  }
  return false
}

/**
 * 把 `unknown` 归一成时间戳（毫秒）。
 *
 * 三种形态都接受：
 * - **秒级**数字（`< 100000000000`，即 1970 年起的秒数）→ ×1000；
 * - **毫秒级**数字 → 原样；
 * - **RFC3339 字符串** → `Date.parse`。
 *
 * 解不出（`0` / 负数 / 非法串）返回 undefined，**不抛错** —— 凭据可能被手工
 * 改坏，那时应当降级成「无过期信息」（宁可试一次），而不是让整个 provider 崩。
 */
function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 100_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 100_000_000_000 ? numeric * 1000 : numeric
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

/**
 * 凭据的过期时刻（毫秒）；解不出返回 undefined。
 *
 * ⚠️ 字段读成 `unknown` 再判：类型上它是 `number`，但**手工粘贴的凭据**里
 * 完全可能是 RFC3339 字符串（上游某一版就是这么下发的）。只按 number 判会
 * 让这些凭据的过期时间**恒为 undefined**，于是 `refreshAll` 永远跳过它们 ——
 * 表现为「凭据悄悄过期、续期从不触发」（与 raccoon 踩过的同族静默失效）。
 */
export function accioCredentialExpiresAtMs(credential: AccioCredential): number | undefined {
  const raw: unknown = credential.expires_at
  return timestampMs(raw)
}

/**
 * 凭据是否可静默续期。
 *
 * 判据是 `refresh_token` 非空 —— Accio **有** refresh 端点
 * （`POST /api/auth/refresh_token`）。
 */
export function isAccioRefreshable(credential: AccioCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/**
 * 凭据是否已进入续期窗口（或已过期）。
 *
 * ⚠️ **无过期信息时返回 `true`**（= 需要续期），这与 raccoon 的
 * `isRaccoonExpired` 刻意相反。理由是本家**能**续期，而续期结果一定会补上
 * `expires_at`（见 `accio-auth.ts` 的 `ACCIO_DEFAULT_TTL_MS` 兜底）—— 故这个
 * `true` 是**一次性**的：首次续期之后凭据就有明确有效期了。反过来（返回
 * `false`）会让「手工粘贴的无过期时间凭据」**永远不续期**，直到某天被 401
 * 拒绝为止 —— 那正是 raccoon 记录过的静默失效。
 */
export function isAccioExpiring(credential: AccioCredential): boolean {
  const expiresAt = accioCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return true
  return expiresAt <= Date.now() + ACCIO_REFRESH_MARGIN_MS
}

/**
 * 账号 id（`accounts` 主键）。
 *
 * 取 `user_id || access_token` 的 sha256 前 16 位 hex，前缀由产品给
 * （`accio-intl-` / `accio-cn-`）。两个地区因此天然不相交 —— 同一个人在两套
 * 系统里的 `user_id` 可能相同，撞 id 会让存储层的保护拒绝写入。
 *
 * ⚠️ 用**摘要**而不是原值：账号 id 会落进账号列表与日志，**不该可反推凭据**。
 * 16 位 hex（64 bit）对本用途足够，且比全量短一半。
 */
export function accioAccountId(product: AccioProduct, credential: AccioCredential): string {
  const identity = credential.user_id?.trim()
  const seed = identity !== undefined && identity.length > 0 ? identity : credential.access_token
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)
  return `${product.accountIdPrefix}${digest}`
}

/**
 * 展示名（账号列表里那一列）。
 *
 * 形态：`Accio 国际版 · <昵称|邮箱|user_id>`。三者都没有时只留前半段 ——
 * 不产出「Accio 国际版 · 」这种带孤立分隔符的名字。
 */
export function accioDisplayName(product: AccioProduct, credential: AccioCredential): string {
  const base = product.id === 'accio-cn' ? 'Accio 国内版' : 'Accio 国际版'
  const nickname = credential.nickname?.trim() ?? ''
  if (nickname.length > 0) return `${base} · ${nickname}`
  const email = credential.email?.trim() ?? ''
  if (email.length > 0) return `${base} · ${email}`
  const userId = credential.user_id?.trim() ?? ''
  return userId.length > 0 ? `${base} · ${userId}` : base
}

// ── 登录链路 ────────────────────────────────────────────────────────

/** PKCE 配对（与 `oauth.ts` 的 `PkcePair` 同形，但本家自己生成，故单列）。 */
export interface AccioPkcePair {
  /** 换码时回传的原像（43 字符 base64url）。 */
  codeVerifier: string
  /** 授权地址里的 S256 挑战。 */
  codeChallenge: string
}

/**
 * RFC 3986 unreserved 之外的字节一律百分号编码。
 *
 * 逐字节处理 UTF-8（`Buffer.from`），而不是按 UTF-16 码元 —— 后者会把中文
 * 编成错的 `%uXXXX` 形态。
 *
 * ⚠️ 这是本家**唯一**一份编码实现：`return_url` / `state` / `code_challenge` /
 * `client_id` 四个参数都用它。少编一个（例如 `code_challenge` 里的 `+`/`/`）
 * 会让服务端解出不同的挑战值，症状是换码时 `invalid_grant` —— 极难定位。
 */
export function accioUrlencode(value: string): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    if (
      (byte >= 0x41 && byte <= 0x5a) // A-Z
      || (byte >= 0x61 && byte <= 0x7a) // a-z
      || (byte >= 0x30 && byte <= 0x39) // 0-9
      || byte === 0x2d // -
      || byte === 0x5f // _
      || byte === 0x2e // .
      || byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * 授权页地址。
 *
 * ```
 * {loginBase}/login?return_url=…&state=…&code_challenge=…
 *                 &code_challenge_method=S256&client_id=accio-work
 * ```
 *
 * ⚠️ `return_url` 必须与换码时的 `redirectUri` **逐字相同**（含端口与路径），
 * 否则上游会判 `redirect_uri` 不匹配。故调用方必须把同一个字符串同时交给
 * 本函数与换码请求（`accio-auth.ts` 的 pending 表就是这么存的）。
 */
export function buildAccioAuthorizeUrl(
  product: AccioProduct,
  pkce: AccioPkcePair,
  state: string,
  returnUrl: string,
): string {
  return `${product.loginBase}/login`
    + `?return_url=${accioUrlencode(returnUrl)}`
    + `&state=${accioUrlencode(state)}`
    + `&code_challenge=${accioUrlencode(pkce.codeChallenge)}`
    + `&code_challenge_method=S256`
    + `&client_id=${accioUrlencode(product.clientId)}`
}

/**
 * 生成一轮登录的 `state`：UUID v4 去掉 `-`（32 位 hex）。
 *
 * 为什么要它：回调落在本机 HTTP 端口上，**任何本机进程都能伪造一次 GET**。
 * `state` 逐字比对是「这次回调是不是本进程刚发起的那一轮」的唯一凭据 ——
 * 没有它，别人可以拿自己那次的 code 把凭证写进你的账号库。
 */
export function newAccioState(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * 生成一个设备指纹（`utdid`）：`desktop-` + UUID 去掉 `-`。
 *
 * ⚠️ **按账号生成**（落进凭据，续期时**不重新生成**）：真实形态是「一台设备
 * 一个指纹」，同一指纹挂十个账号才是可疑形态。它不参与鉴权（缺了也能跑），
 * 但带上更接近真实客户端。
 */
export function newAccioDeviceId(): string {
  return `desktop-${randomUUID().replace(/-/g, '')}`
}

/** 新请求 id（UUID v4）。`request_id` / `message_id` / `sg_k` 都由它派生。 */
export function newAccioRequestId(): string {
  return randomUUID()
}

/**
 * 推理地址：`{gatewayBase}/api/adk/llm/generateContent?sg_k=<md5(requestId)>`。
 *
 * ⚠️ `sg_k` 是**小写 hex 的 md5(requestId)**，是桌面端拼的一个防重放标记
 * （**不是签名**，上游不校验内容与请求体的关系）。写成大写、或写成别的哈希
 * 都不会报错，但会对不上桌面端的形态 —— 而这是唯一能对照的参考。
 */
export function buildAccioGenerateContentUrl(product: AccioProduct, requestId: string): string {
  const sgK = createHash('md5').update(requestId, 'utf8').digest('hex')
  return `${product.gatewayBase}/api/adk/llm/generateContent?sg_k=${sgK}`
}

// ── 请求体构造（OpenAI 形状 → ADK Gemini 信封）───────────────────────

/** `buildAccioChatBody` 的生成参数。 */
export interface AccioChatOptions {
  /** 发给上游的 `model`（**上游发送名**，可能是代号）。 */
  model: string
  /** 采样温度。 */
  temperature?: number
  /** 单次输出上限（上游没给目录值时通常不传）。 */
  maxTokens?: number
  /** 核采样。 */
  topP?: number
  /** 停止序列。 */
  stop?: readonly string[]
  /** DSH 注入的思考档位（`options.reasoningEffort`）。 */
  reasoningEffort?: string
  /** 该模型声明的档位集合（**空 = 不支持思考**，此时一个思考字段都不发）。 */
  reasoningEfforts?: readonly string[]
  /**
   * 思考档位落在哪一层。
   *
   * ⚠️ **放错一边的后果是不对称的**：
   * - Gemini 系放 `properties` → **硬 400**（`Unknown name "reasoning_effort"`），
   *   整轮对话起不来；
   * - GPT 系放顶层 → **不报错但永远不出思考内容**（静默失效，用户以为档位没用）。
   *
   * 缺省 `top`：它是唯一在三种模型上都不会报错的落点（Gemini 系放顶层只是
   * 不产生思考内容 —— 少个功能好过 400）。
   */
  reasoningPlacement?: 'top' | 'properties'
}

/** `buildAccioChatBody` 的产出。 */
export interface AccioChatBody {
  /** 已组装好的请求体（顶层键名全部 snake_case）。 */
  body: Record<string, unknown>
  /** 本次请求 id（`sg_k` 由它算出，日志里对得上）。 */
  requestId: string
  /** 本次是否要求下发思考内容（决定帧里要不要带 reasoning 增量）。 */
  thinking: boolean
}

/** `openAiToAccioContents` 的产出。 */
export interface AccioContents {
  /** ADK `contents` 数组。 */
  contents: Array<Record<string, unknown>>
  /** ADK `system_instruction`（**字符串**，多个 system 消息用 `\n\n` 连接）。 */
  systemInstruction: string
}

/** 思考档位的「关」取值（与其余 provider 同集合）。 */
const EFFORT_OFF_VALUES = new Set(['off', 'none', 'disabled', 'false', '0'])

/** 该档位是否表示「关闭思考」。 */
function isEffortOff(effort: string): boolean {
  return EFFORT_OFF_VALUES.has(effort.trim().toLowerCase())
}

/**
 * 把 OpenAI 形状的消息序列转成 ADK `contents` + `system_instruction`。
 *
 * 输入是 `serializeMessages()`（`openai-compat.ts`）产出的 OpenAI wire 消息
 * —— 与其余 provider 共用同一份序列化（工具配对剔除、历史泄漏清洗都在那里
 * 已经做过），本函数只做**形状翻译**。
 *
 * 参数类型取 `Record<string, unknown>`（而不是带必填 `role` 的结构）：调用点
 * 手里的 `serializeMessages` 产出就是宽对象，写一个更窄的类型会逼调用方做一次
 * 类型断言 —— 而 `role` 的缺失本就在本函数内部有兜底（见下方 `role` 的读法）。
 *
 * 逐条规则（与上游实测一致）：
 * - `system` / `developer` → 抽 text 拼进 `system_instruction`，**不产生
 *   contents 项**（上游要的是一个字符串，不是 Content 对象）；
 * - `user`（及任何未知 role）→ `{role:'user', parts:[…]}`；
 * - `assistant` → `{role:'model', parts:[文本…, {function_call:{…}}]}`；
 * - `tool` / `function` → `{role:'tool', parts:[{function_response:{…}}]}`；
 * - **相邻同 role 合并 parts**（工具轮次尤其常见，合并能少一次无意义的往返）。
 *
 * ⚠️ `function_response.name` **从配对的 `function_call` 反查**：本仓库的
 * `serializeMessages` 产出的 tool 消息**不带 name**（OpenAI 协议里也不需要）。
 * 直接留空会让上游收到一个没有函数名的结果 —— 故这里先扫一遍 assistant 的
 * `tool_calls` 建 id→name 映射。这是本函数唯一超出「逐字段搬运」的逻辑。
 *
 * @param messages - OpenAI 形状消息（`serializeMessages` 的产出）。
 * @param imageUrls - 附件 id → data URL / 远程 URL 的映射；`undefined` 表示无图。
 */
export function openAiToAccioContents(
  messages: readonly Record<string, unknown>[],
  imageUrls?: ReadonlyMap<string, string>,
): AccioContents {
  void imageUrls // 图片已在序列化阶段内联进 content，这里不需要额外映射

  const contents: Array<Record<string, unknown>> = []
  const systemParts: string[] = []
  /** tool_call_id → 函数名（见上方 ⚠️）。 */
  const callNames = new Map<string, string>()
  for (const message of messages) {
    if (message['role'] !== 'assistant') continue
    for (const call of asArray(message['tool_calls'])) {
      const record = asRecord(call)
      if (record === undefined) continue
      const id = pickString(record, ['id'])
      const fn = asRecord(record['function'])
      const name = fn === undefined ? undefined : pickString(fn, ['name'])
      if (id !== undefined && name !== undefined) callNames.set(id, name)
    }
  }

  /**
   * 追加一个 Content，**相邻同 role 时合并 parts**。
   *
   * 空 parts 不建项：上游对空 parts 的行为未定义，而「一条什么都没有的消息」
   * 本来也不该出现在 wire 上。
   */
  const pushContent = (role: string, parts: Array<Record<string, unknown>>): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last !== undefined && last['role'] === role) {
      const existing = last['parts']
      if (Array.isArray(existing)) {
        existing.push(...parts)
        return
      }
    }
    contents.push({ role, parts })
  }

  for (const message of messages) {
    const role = typeof message['role'] === 'string' ? message['role'] : 'user'
    if (role === 'system' || role === 'developer') {
      for (const part of contentToParts(message['content'])) {
        const text = part['text']
        if (typeof text === 'string' && text.length > 0) systemParts.push(text)
      }
      continue
    }
    if (role === 'tool' || role === 'function') {
      const rawId = message['tool_call_id']
      const id = typeof rawId === 'string' ? rawId : ''
      const rawName = message['name']
      const name = callNames.get(id)
        ?? (typeof rawName === 'string' ? rawName : '')
      const content = contentToText(message['content'])
      // ⚠️ 上游认的是**字符串包着的 JSON**（见模块头要点 2）。
      const responseJson = JSON.stringify({ content, is_error: false })
      pushContent('tool', [{
        function_response: {
          id,
          name,
          response_json: responseJson,
        },
      }])
      continue
    }
    if (role === 'assistant') {
      const parts = contentToParts(message['content'])
      for (const call of asArray(message['tool_calls'])) {
        const record = asRecord(call)
        if (record === undefined) continue
        const fn = asRecord(record['function'])
        if (fn === undefined) continue
        const name = pickString(fn, ['name'])
        // 名称为空的调用**不发**：上游会以一个无名的 functionCall 回显，
        // harness 侧则表现为 `unknown tool ""`（与 `sse.ts` 记录的同族污染）。
        if (name === undefined) continue
        const id = pickString(record, ['id']) ?? ''
        const rawArgs = fn['arguments']
        const args = typeof rawArgs === 'string' ? rawArgs : '{}'
        parts.push({ function_call: { id, name, args_json: args } })
      }
      pushContent('model', parts)
      continue
    }
    // user 及任何未知 role：一律按用户消息下发（宁可多给，也不要静默丢内容）
    pushContent('user', contentToParts(message['content']))
  }

  return { contents, systemInstruction: systemParts.join('\n\n') }
}

/**
 * 把 OpenAI 形状的工具声明转成 ADK `tools`。
 *
 * 与 {@link openAiToAccioContents} 同属「一次转换的两半」：消息那半在上面，
 * 工具声明这半在这里（harness 的 `options.tools` 与消息是分开给的，故不塞进
 * 同一个签名里）。
 *
 * ⚠️ `parameters_json` 是**字符串**（见模块头要点 2）。缺 `parameters` 时补
 * 一个空对象 schema，而不是省略该字段 —— 上游对没有参数的函数仍要一份 schema。
 */
export function openAiToAccioTools(
  tools: readonly { name: string; description?: string; parameters?: unknown }[] | undefined,
): Array<Record<string, unknown>> {
  if (tools === undefined) return []
  const out: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (name.length === 0) continue
    const parameters = tool.parameters ?? { type: 'object', properties: {} }
    out.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters_json: JSON.stringify(parameters),
    })
  }
  return out
}

/** 取一个 `unknown` 的数组视图（非数组返回空数组）。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * OpenAI content（字符串或分块数组）→ ADK parts。
 *
 * 媒体两种形态：
 * - `data:…;base64,…` → `inline_data{mime_type,data}`（内联字节）；
 * - 其余 http(s) URL → `file_data{mime_type,file_uri}`（上游自己去取）。
 *
 * ⚠️ **非 base64 的 data URI 丢弃**：上游的 `inline_data.data` 只认 base64，
 * 塞一段百分号编码进去只会得到一次难查的 400。
 */
function contentToParts(content: unknown): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  if (typeof content === 'string') {
    if (content.length > 0) parts.push({ text: content })
    return parts
  }
  for (const raw of asArray(content)) {
    const block = asRecord(raw)
    if (block === undefined) continue
    const type = typeof block['type'] === 'string' ? block['type'] : ''
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = typeof block['text'] === 'string' ? block['text'] : ''
      if (text.length > 0) parts.push({ text })
      continue
    }
    if (type === 'image_url' || type === 'input_image') {
      const part = imagePart(imageUrlOf(block))
      if (part !== undefined) parts.push(part)
    }
  }
  return parts
}

/**
 * 从图片块里取 URL。
 *
 * OpenAI 有**两种**形态都要认（实测两种都出现过）：
 * `{image_url:{url}}` 与 `{image_url:'…'}`；另有部分实现给顶层 `url`。
 */
function imageUrlOf(block: Record<string, unknown>): string {
  const raw = block['image_url']
  if (typeof raw === 'string') return raw
  const nested = asRecord(raw)
  if (nested !== undefined) {
    const url = nested['url']
    if (typeof url === 'string') return url
  }
  const direct = block['url']
  return typeof direct === 'string' ? direct : ''
}

/** 图片 URL → ADK part（data URI 走 inline_data，其余走 file_data）。 */
function imagePart(url: string): Record<string, unknown> | undefined {
  const trimmed = url.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith('data:')) {
    return { file_data: { mime_type: 'image/png', file_uri: trimmed } }
  }
  const rest = trimmed.slice('data:'.length)
  const comma = rest.indexOf(',')
  if (comma === -1) return undefined
  const meta = rest.slice(0, comma)
  const data = rest.slice(comma + 1)
  // 只处理 base64 内联；其它编码（理论上不存在）放弃。
  if (!meta.toLowerCase().includes('base64')) return undefined
  const mime = meta.split(';')[0]
  return {
    inline_data: {
      mime_type: mime !== undefined && mime.length > 0 ? mime : 'image/png',
      data,
    },
  }
}

/** 把 content 展平成纯文本（工具结果用）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = asRecord(item)
        if (block === undefined) return ''
        const text = block['text']
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  // 非字符串非数组：如实字符串化（与 Rust 侧 `other.to_string()` 同取向，
  // 宁可给一段可读的 JSON，也不要静默变成空）。
  try {
    return JSON.stringify(content) ?? ''
  } catch {
    return ''
  }
}

/**
 * 组装 `generateContent` 请求体（ADK Gemini 风格 protobuf-JSON 信封）。
 *
 * 顶层字段**逐字**照抄桌面端（`@ali/accio-adk-ts` 的 `camelCase → snake_case`
 * 映射结果）：
 *
 * ```
 * model, tenant, iai_tag, empid, request_id, message_id, token,
 * contents, system_instruction, tools, tool_config,
 * temperature, max_output_tokens, top_p, stop_sequences,
 * include_thoughts, reasoning_effort, properties
 * ```
 *
 * ## 两个字段是「缺了就 400」的
 *
 * - **`token`**：本家的鉴权就在这里（**不在 `Authorization` 头**）。
 * - **`message_id`**：缺了它上游回
 *   `{"error_code":"400","error_message":"invalid params"}`，而且这是
 *   **HTTP 200 的帧**（不是状态码）—— 只有首帧预读才能发现。
 *
 * ## `properties` 恒含 `normalized_response`
 *
 * 桌面端每个请求都带 `{"normalized_response":"true"}`（客户端的归一化开关）。
 * 少发它是否被拒未验证，但它是**免费**的 —— 照抄。
 */
export function buildAccioChatBody(
  product: AccioProduct,
  credential: AccioCredential,
  options: AccioChatOptions,
  contents: Array<Record<string, unknown>>,
  systemInstruction: string,
  tools: Array<Record<string, unknown>>,
): AccioChatBody {
  const requestId = newAccioRequestId()

  /** `properties`：map<string,string>，值必须是**字符串**。 */
  const properties: Record<string, string> = { normalized_response: 'true' }

  const body: Record<string, unknown> = {
    model: options.model,
    tenant: product.tenant,
    iai_tag: product.iaiTag,
    empid: '',
    request_id: requestId,
    // ⚠️ **必填**（见上方注释）：形态不限，这里与 request_id 同源。
    message_id: `msg-${requestId}`,
    // ⚠️ 鉴权在 body 里，不在请求头。
    token: credential.access_token,
    contents,
    system_instruction: systemInstruction,
  }

  if (tools.length > 0) {
    body['tools'] = tools
    // ⚠️ 是**字符串**（见模块头要点 1）：它让上游把工具参数**分片**流式下发。
    body['tool_config'] = JSON.stringify({
      functionCallingConfig: { streamFunctionCallArguments: true },
    })
  }

  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    body['temperature'] = options.temperature
  }
  const maxTokens = options.maxTokens
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    body['max_output_tokens'] = maxTokens
  }
  if (typeof options.topP === 'number' && Number.isFinite(options.topP)) {
    body['top_p'] = options.topP
  }
  const stop = options.stop?.filter((value) => typeof value === 'string' && value.length > 0) ?? []
  if (stop.length > 0) body['stop_sequences'] = [...stop]

  // ── 思考档位 ────────────────────────────────────────────────────
  //
  // 判据是**模型自己声明的档位集合**（`reasoningEfforts`）：集合为空说明该模型
  // 不支持思考，此时一个思考字段都不发（发了要么被忽略、要么 400）。
  let thinking = false
  const efforts = options.reasoningEfforts ?? []
  const effort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort.trim() : ''
  if (efforts.length > 0 && effort.length > 0 && !isEffortOff(effort)) {
    thinking = true
    body['include_thoughts'] = true
    if ((options.reasoningPlacement ?? 'top') === 'properties') {
      // GPT 系 / MiniMax：**只有** properties 能出思考内容。
      properties['reasoning_effort'] = effort
    } else {
      // Gemini / Claude / GLM / Qwen 系：顶层。放 properties 对 Gemini 是硬 400。
      body['reasoning_effort'] = effort
    }
  }

  // `properties` 总是要发（normalized_response 在里面），故放在最后插入 ——
  // 上面的 reasoning_effort 可能又往里加了一条。
  body['properties'] = properties

  return { body, requestId, thinking }
}

// ── 响应解析（ADK SSE → 增量）───────────────────────────────────────

/** 累积中的工具调用。 */
export interface AccioToolCallState {
  /** 上游给的调用 id（可能为空：分片可能不带 id）。 */
  id: string
  /** 函数名。 */
  name: string
  /** 已累积的参数（JSON 字符串，可能只是半截）。 */
  args: string
  /** 是否已经对外播报过（首帧要带 id/name，之后只带参数）。 */
  announced: boolean
}

/** {@link parseAccioSseLine} 的**跨行状态**（同一流内复用一个实例）。 */
export interface AccioSseState {
  /** 已累积的工具调用，顺序即 index 顺序。 */
  toolCalls: AccioToolCallState[]
}

/** 新建一个流解析状态。 */
export function newAccioSseState(): AccioSseState {
  return { toolCalls: [] }
}

/** 一帧里解析出的工具调用增量。 */
export interface AccioToolCallDelta {
  /** 与累积表下标一致（OpenAI chunk 的 `index`）。 */
  index: number
  /** 仅首次播报时给出。 */
  id?: string
  /** 仅首次播报时给出。 */
  name?: string
  /** 本次新增的参数片段。 */
  argumentsDelta: string
}

/** 归一后的用量（字段口径与 `openai-compat.ts` 一致）。 */
export interface AccioUsage {
  /** **未命中缓存**的输入 token（缓存命中单列，见 DSH 的 TokenUsage 契约）。 */
  inputTokens: number
  /** 输出 token（**含思考**：思考也是模型产出的 token）。 */
  outputTokens: number
  /** 上游给的总额；没给时由 prompt + completion + thoughts 推出。 */
  totalTokens?: number
  /** 缓存命中的输入 token。 */
  cacheReadTokens?: number
  /** 思考 token（计入 `outputTokens`）。 */
  reasoningTokens?: number
}

/** 一帧 `data:` 行解析后的形态。 */
export interface AccioSseFrame {
  /** 是否为结束帧 `data: [DONE]`。 */
  done: boolean
  /** 正文增量。 */
  text?: string
  /** 思考增量（`{thought:true, text}` 的 part）。 */
  reasoning?: string
  /** 工具调用增量（**已按分片规则聚合**，见 {@link accumulateAccioToolCall}）。 */
  toolCalls?: readonly AccioToolCallDelta[]
  /** 上游宣告本轮结束。 */
  turnComplete: boolean
  /** 结束原因原文（`STOP` / `MAX_TOKENS` / `TOOL_CALLS` …）。 */
  finishReason?: string
  /** 业务错误码（⚠️ **HTTP 常是 200**，错误藏在帧里）。 */
  errorCode?: string
  /** 业务错误文案。 */
  errorMessage?: string
  /** 用量。 */
  usage?: AccioUsage
}

/**
 * 解析一行 SSE。
 *
 * ## 键名双读
 *
 * 客户端自己的 `fromJSON` 就是 camelCase / snake_case 双读的，我们**不能假设
 * 网关只会给一种**（实测两种都出现过）。
 *
 * ## 工具参数会分片
 *
 * 因为请求体里发了 `tool_config` 的 `streamFunctionCallArguments`，同名同 id 的
 * `function_call` part 可能各带一段参数。聚合判据见
 * {@link accumulateAccioToolCall}。
 *
 * ## 返回 `undefined` 的三种情形
 *
 * 非 `data:` 行、空行、以及**解析不出 JSON** 的心跳/控制帧 —— 与客户端
 * `processFrame` 的「空帧返回 null」同一取向：静默跳过而不是中断整条流。
 *
 * @param line - 一行原始文本（可带 `data:` 前缀与首尾空白）。
 * @param state - 跨行累积状态（工具调用分片要用）。
 */
export function parseAccioSseLine(line: string, state: AccioSseState): AccioSseFrame | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith('data:')) return undefined
  // 兼容 `data: {…}` 与 `data:{…}`（部分上游实测无空格）。
  const payload = trimmed.slice('data:'.length).trim()
  if (payload === '[DONE]' || payload === '[done]') {
    return { done: true, turnComplete: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  if (record === undefined) return undefined

  const frame: AccioSseFrame = {
    done: false,
    turnComplete: pickBool(record, ['turnComplete', 'turn_complete']),
  }

  const finishReason = pickString(record, ['finishReason', 'finish_reason'])
  if (finishReason !== undefined) frame.finishReason = finishReason
  const errorCode = pickString(record, ['errorCode', 'error_code'])
  if (errorCode !== undefined) frame.errorCode = errorCode
  const errorMessage = pickString(record, ['errorMessage', 'error_message'])
  if (errorMessage !== undefined) frame.errorMessage = errorMessage

  const usage = asRecord(record['usageMetadata'] ?? record['usage_metadata'])
  if (usage !== undefined) {
    const mapped = parseAccioUsage(usage)
    if (mapped !== undefined) frame.usage = mapped
  }

  const content = asRecord(record['content'])
  const parts = content === undefined ? [] : asArray(content['parts'])
  const toolDeltas: AccioToolCallDelta[] = []
  for (const raw of parts) {
    const part = asRecord(raw)
    if (part === undefined) continue
    const functionCall = asRecord(part['functionCall'] ?? part['function_call'])
    if (functionCall !== undefined) {
      const id = pickString(functionCall, ['id']) ?? ''
      const name = pickString(functionCall, ['name']) ?? ''
      const args = readArgsText(functionCall)
      const delta = accumulateAccioToolCall(state, id, name, args)
      if (delta !== undefined) toolDeltas.push(delta)
      continue
    }
    const text = part['text']
    if (typeof text !== 'string' || text.length === 0) continue
    if (part['thought'] === true) {
      frame.reasoning = (frame.reasoning ?? '') + text
    } else {
      frame.text = (frame.text ?? '') + text
    }
  }
  if (toolDeltas.length > 0) frame.toolCalls = toolDeltas

  return frame
}

/**
 * 读 `function_call` 里的参数字符串。
 *
 * 三种形态都见过：`argsJson`（字符串包 JSON）、`args_json`、以及客户端高层
 * API 的 `args`（**对象**）。取到哪个算哪个 —— 对象形态要序列化回字符串，
 * 因为下游的累积判据是按「字符串是不是合法 JSON」做的。
 */
function readArgsText(functionCall: Record<string, unknown>): string {
  const direct = functionCall['argsJson'] ?? functionCall['args_json']
  if (typeof direct === 'string') return direct
  if (direct !== undefined && direct !== null) {
    try {
      return JSON.stringify(direct) ?? ''
    } catch {
      return ''
    }
  }
  const args = functionCall['args']
  if (typeof args === 'string') return args
  if (args !== undefined && args !== null) {
    try {
      return JSON.stringify(args) ?? ''
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * 把一次 `function_call` part 并进累积表，返回**需要下发的增量**。
 *
 * ## 分片与「一次一个」怎么区分（这是本函数存在的全部理由）
 *
 * 上游开了 `streamFunctionCallArguments`，参数**可能分片到达**（同名同 id 的
 * 多个 part 各带一段，如 `{"path":"` + `a.txt"}`）。但上游**也可能一次给全**
 * （尤其并行发起的多个调用，每个都是完整 JSON）。
 *
 * 判据（与 Rust 侧实现一致，实测两种形态都能正确聚合）：
 *
 * ```
 * id/name 与上一条相同
 *   且 已有内容是合法 JSON
 *   且 新片段也是完整 JSON
 *   ⇒ 那是**新调用**，开一条
 * 否则 ⇒ 续写拼上去
 * ```
 *
 * 只看 id/name 相同就续写会让「并行发起两个同名工具」被拼成一个坏 JSON；
 * 只看「新片段是不是完整 JSON」又会让分片的**最后一片**被误判成新调用
 * （`a.txt"}` 恰好是合法 JSON 字符串字面量吗？不是，但形如 `{"x":1}` 的
 * 尾片在别的工具上可能是）。两条合起来才无歧义。
 *
 * @returns 需要下发的增量；**无变化时返回 undefined**（例如空参数分片）。
 */
function accumulateAccioToolCall(
  state: AccioSseState,
  id: string,
  name: string,
  args: string,
): AccioToolCallDelta | undefined {
  const last = state.toolCalls[state.toolCalls.length - 1]
  const canExtend = last !== undefined && canExtendCall(last, id, name, args)

  if (canExtend) {
    // `canExtend` 为真蕴含 `last !== undefined`（见上面的合取），但 TS 不会把
    // 布尔变量的真假带进收窄，故这里再判一次而不是用非空断言。
    const entry = last
    if (entry !== undefined) {
      if (entry.id.length === 0 && id.length > 0) entry.id = id
      if (entry.name.length === 0 && name.length > 0) entry.name = name
      entry.args += args
      const index = state.toolCalls.length - 1
      // 首帧即使参数为空也要发：否则客户端拿不到这个工具调用的**名字**。
      if (!entry.announced) {
        entry.announced = true
        return {
          index,
          ...entry.id.length > 0 ? { id: entry.id } : {},
          ...entry.name.length > 0 ? { name: entry.name } : {},
          argumentsDelta: entry.args,
        }
      }
      if (args.length === 0) return undefined
      return { index, argumentsDelta: args }
    }
  }

  const created: AccioToolCallState = { id, name, args, announced: true }
  state.toolCalls.push(created)
  return {
    index: state.toolCalls.length - 1,
    ...id.length > 0 ? { id } : {},
    ...name.length > 0 ? { name } : {},
    argumentsDelta: args,
  }
}

/** 判断一次 `function_call` part 能否续写进已有的累积项。 */
function canExtendCall(
  entry: AccioToolCallState,
  id: string,
  name: string,
  args: string,
): boolean {
  if (id.length > 0 && entry.id.length > 0 && id !== entry.id) return false
  if (name.length > 0 && entry.name.length > 0 && name !== entry.name) return false
  const previousComplete = entry.args.length > 0 && isJsonText(entry.args)
  const incomingComplete = args.length > 0 && isJsonText(args)
  // 两边都是完整 JSON ⇒ 不是续写，是新调用。
  return !(previousComplete && incomingComplete)
}

/** 该文本是否是合法 JSON。 */
function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * 用量归一。
 *
 * ⚠️ **思考 token 计入输出**（与 OpenAI 口径一致：思考也是模型产出的 token），
 * 而 `candidates_token_count` **不含**思考 —— 故输出取二者之和。这一点与
 * AGENTS.md 里「`reasoning_tokens` 计入 `completion_tokens`」同一条约定。
 *
 * 上游没给任何字段时返回 undefined（不产出一个全 0 的用量帧：那会让 token
 * 记账显示成「本次 0 token」，比缺失更容易误导）。
 */
function parseAccioUsage(usage: Record<string, unknown>): AccioUsage | undefined {
  const prompt = pickNumber(usage, ['promptTokenCount', 'prompt_token_count'])
  const completion = pickNumber(usage, ['candidatesTokenCount', 'candidates_token_count'])
  const thoughts = pickNumber(usage, ['thoughtsTokenCount', 'thoughts_token_count'])
  const total = pickNumber(usage, ['totalTokenCount', 'total_token_count'])
  const cached = pickNumber(usage, ['cachedContentTokenCount', 'cached_content_token_count'])
  if (prompt === undefined && completion === undefined && thoughts === undefined) return undefined

  const promptTokens = prompt ?? 0
  const completionTokens = completion ?? 0
  const thoughtTokens = thoughts ?? 0
  const cachedTokens = cached ?? 0
  const outputTokens = completionTokens + thoughtTokens
  const explicitTotal = total ?? 0

  return {
    // ⚠️ 只计**未命中缓存**的部分，命中部分单列 `cacheReadTokens`，
    // 否则缓存命中率显示会偏大（与 `openai-compat.ts` 同一口径）。
    inputTokens: cachedTokens > 0 ? Math.max(0, promptTokens - cachedTokens) : promptTokens,
    outputTokens,
    totalTokens: explicitTotal > 0 ? explicitTotal : promptTokens + outputTokens,
    ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
    ...thoughtTokens > 0 ? { reasoningTokens: thoughtTokens } : {},
  }
}
