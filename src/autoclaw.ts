/**
 * AutoClaw 协议常量与**纯函数**（不发任何网络请求）。
 *
 * ## 这一家的协议要点
 *
 * AutoClaw 的推理面是 **OpenAI 兼容**（`POST {upstreamBaseUrl}/chat/completions`
 * + 标准 SSE），但它有**两套完全不同的请求头**，且两套头里各有一个
 * 「照抄对方就会踩坑」的字段：
 *
 * | 维度 | 登录/业务（{@link autoclawSignedHeaders}） | 推理（{@link autoclawBrandHeaders}） |
 * |---|---|---|
 * | 鉴权头 | `authorization: Bearer …`（**小写**） | `X-Authorization: Bearer …` |
 * | 版本 | `1.18.5`（登录链） | `1.17.8`（推理链） |
 * | `X-Tm` | `win` / `linux`（**没有 mac**） | `win` / `mac` / `linux` |
 * | 签名 | 有（`X-Auth-Sign`） | 无 |
 * | `X-Harness-Type` | **有**（`zcode`） | **绝不能有** |
 *
 * ## ⚠️ 三个实测坑（都是「静默失败」型，不修就查不出来）
 *
 * 1. **推理请求带 `X-Harness-Type` 会被拒**：LLM 域带上它返回 403 `pay-view`，
 *    或 406 + 空体。而登录链**必须**带它。这不是笔误 —— 两套头由两个函数
 *    分别产出，正是为了让这条差异显式可见。
 * 2. **`X-Tm` 的两个取值域不同**：登录链是照抄源码的刻意行为（只分
 *    win / linux，**没有 mac 分支**，Mac 客户端在该链路上报 `linux`）；
 *    推理链有 mac 分支。把两者「统一」会改掉官方客户端的真实行为。
 * 3. **`X-Authorization` 不是 `Authorization`**：推理链只认前者，写错会 401，
 *    且报错与「凭据过期」完全一样。
 *
 * ## 为什么要做 system 提示词规范化（{@link normalizeAutoclawSystemMessages}）
 *
 * 上游对 system 提示词有**白名单校验**：正文里出现别家 agent 的身份句
 * （`You are ZCode…` / `You are Claude Code…`）会让请求被拒或行为异常。
 * 本插件是宿主侧进程，把 harness 的 system 提示词原样转发时必然带上
 * 「You are an AI agent powered by DeepSeek Harness」这类句子，故出站前
 * 统一改写成中性说法并补上上游期望的身份前缀。这是**能否跑通的关键**，
 * 不是可选的清理。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  AUTOCLAW_APP_ID,
  AUTOCLAW_APP_KEY,
  AUTOCLAW_CLIENT_VERSION,
  AUTOCLAW_INFER_VERSION,
  type AutoclawProduct,
} from './autoclaw-product.js'

/**
 * AutoClaw 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识（选错字段会让限流记录无法归属账号）。
 */
export interface AutoclawCredential {
  /** 访问令牌（服务端下发）。 */
  access_token: string
  /** 续期用（服务端下发）。 */
  refresh_token?: string
  /** 设备指纹（32 字节的 64 位 hex），发码与登录必须沿用同一个值。 */
  device_id?: string
  /** 上游用户 id。 */
  user_id?: string
  /** 绑定邮箱（国际版 OAuth 常见；国内版手机验证码登录通常没有）。 */
  email?: string
  /** 过期时间（毫秒时间戳）。 */
  expires_at?: number
  /** 展示用昵称。 */
  nickname?: string
  /** 本凭据属于哪个地区（`autoclaw` / `autoclaw-intl`）。 */
  provider?: string
}

/**
 * 从任意来源解析 AutoClaw 凭据；形状不对返回 undefined（不抛错）。
 *
 * 参数取 `unknown` 而不是 `string`：调用点常常拿到的已经是解析过的对象
 * （账号池的 `credential`），走这里就不必做**双重类型断言**（先把类型
 * 抹成 unknown 再断言成目标类型）—— 那正是 lint 棘轮盯着的写法，
 * 它会绕过类型检查，历史上让 `entry` 落进 `fetcher` 位置。
 */
/**
 * 剥掉令牌里**可能自带**的 `Bearer ` 前缀（大小写不敏感，允许任意空白）。
 *
 * ## 为什么必须有这个函数（真实故障，2026-10-04）
 *
 * 用户报障「AutoClaw (国内版) 账号管理 积分查询失败」。实测 A/B：
 *
 * ```text
 *   authorization: "Bearer " + "Bearer eyJ…"（未剥离）→ {"code":410000,"msg":"用户未登录，请重新登录"}
 *   authorization: "Bearer " + "eyJ…"      （剥离后）→ {"code":0,"data":{"wallets":[…],"total_balance":16}}
 * ```
 *
 * 也就是说：**上游 `agent-login` 返回的 `access_token` 本身就以 `Bearer ` 开头**，
 * 而本项目的头构造又补一个 `Bearer `，实际发出 `Bearer Bearer eyJ…`，
 * 服务端一律判「未登录」。症状是**所有需要鉴权的业务端点一起失效**
 *（余额、签到、模型目录、续期），而登录本身是成功的 —— 账号看起来完全正常，
 * 只有各功能分别报「查询失败」，极难从表象定位。
 *
 * Rust 参考实现的 `secret()` 里就有这一步（剥离 + 限长 + 拒控制字符），
 * 本项目移植时漏了它。参考实现另有注记：「auth.json 解出的 token 明文自带
 * `Bearer ` 前缀，不 strip 会拼成 `Bearer Bearer eyJ…`」——本机实测证明
 * **短信登录这条链同样如此**，故判据放在解析层（对所有来源生效），
 * 而不只是桌面端导入那条路。
 *
 * ⚠️ 只剥**一次**（与参考实现同口径）：剥完再出现 `Bearer ` 的，视为令牌本体的一部分。
 */
export function stripBearerPrefix(value: string): string {
  const stripped = value.trim().replace(/^Bearer\s+/i, '')
  // 边界：整个值就只有 `Bearer`（没有令牌本体，例如凭据里存了 `"Bearer "`）。
  // trim 之后 `^Bearer\s+` 匹配不上，若不特判就会把 `Bearer` 当成令牌本体，
  // 于是落一条**永远 401** 的账号 —— 正是本函数要消灭的那种静默失败。
  return /^Bearer$/i.test(stripped) ? '' : stripped
}

/**
 * 从任意来源解析 AutoClaw 凭据；形状不对返回 undefined（不抛错）。
 *
 * 参数取 `unknown` 而不是 `string`：调用点常常拿到的已经是解析过的对象
 * （账号池的 `credential`），走这里就不必做**双重类型断言**（先把类型
 * 抹成 unknown 再断言成目标类型）—— 那正是 lint 棘轮盯着的写法，
 * 它会绕过类型检查，历史上让 `entry` 落进 `fetcher` 位置。
 *
 * ⚠️ 令牌在这里统一**剥掉可能自带的 `Bearer ` 前缀**（见
 * {@link stripBearerPrefix}）：解析层是唯一的入口，放这里能同时修复
 * 「已经在库里的旧凭据」，不必让用户重新登录。
 */
export function parseAutoclawCredential(value: unknown): AutoclawCredential | undefined {
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
  const accessToken = stripBearerPrefix(record.access_token)
  if (accessToken.length === 0) return undefined
  return {
    access_token: accessToken,
    // 续期令牌同样可能带前缀，而它是**裸发**进 refresh 请求体的 ——
    // 带前缀会被服务端判成无效的 refresh_token。这里一并剥离。
    ...typeof record.refresh_token === 'string'
      ? { refresh_token: stripBearerPrefix(record.refresh_token) } : {},
    ...typeof record.device_id === 'string' ? { device_id: record.device_id } : {},
    ...typeof record.user_id === 'string' ? { user_id: record.user_id } : {},
    ...typeof record.email === 'string' ? { email: record.email } : {},
    ...typeof record.expires_at === 'number' ? { expires_at: record.expires_at } : {},
    ...typeof record.nickname === 'string' ? { nickname: record.nickname } : {},
    ...typeof record.provider === 'string' ? { provider: record.provider } : {},
  }
}

/**
 * `X-Tm` 的**登录/业务链**取值。
 *
 * ⚠️ **没有 mac 分支是照抄源码的刻意行为**（见模块头第 2 条）：
 * 官方客户端的这条链只区分 win / linux，Mac 客户端上报 `linux`。
 * 不要为了「对称」而补一个 `mac` —— 那会改掉官方客户端的真实行为。
 */
function signedPlatform(): string {
  return process.platform === 'win32' ? 'win' : 'linux'
}

/**
 * `X-Tm` 的**推理链**取值。
 *
 * ⚠️ 与 {@link signedPlatform} **刻意不同**：推理链有 mac 分支。
 * 两处不可合并（见模块头第 2 条）。
 */
function brandPlatform(): string {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

/** 计算签名：`md5hex(`${appId}&${tsSeconds}&${appKey}`)`（小写 hex、无填充）。 */
export function autoclawSign(appId: string, tsSeconds: number, appKey: string): string {
  return createHash('md5').update(`${appId}&${tsSeconds}&${appKey}`).digest('hex')
}

/**
 * **登录/业务接口**的请求头集合。
 *
 * 依据官方客户端的签名中间件：
 *
 * ```text
 *   X-Auth-Appid      = 100003
 *   X-Auth-TimeStamp  = 秒级十进制字符串（**不是毫秒**）
 *   X-Auth-Sign       = md5hex(`${appid}&${ts}&${appkey}`)
 *   X-Trace-Id        = 每次请求新 UUID
 * ```
 *
 * ⚠️ `X-Auth-TimeStamp` 是**秒**：本机时钟漂移会让签名校验失败并回
 * `400002`（见 `autoclaw-auth.ts` 的降级重试），故这里每次现取时间，
 * 不缓存、不复用。
 *
 * ⚠️ 鉴权头是**小写** `authorization`（与推理链的 `X-Authorization`
 * 是两回事）。token 为空时**不发这个头**：发一个空 Bearer 会让部分网关
 * 直接判 401，而发码/登录本身是匿名接口。
 */
export function autoclawSignedHeaders(token: string): Record<string, string> {
  const tsSeconds = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Version': AUTOCLAW_CLIENT_VERSION,
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Harness-Type': 'zcode',
    'X-Tm': signedPlatform(),
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'X-Auth-Appid': AUTOCLAW_APP_ID,
    'X-Auth-TimeStamp': String(tsSeconds),
    'X-Auth-Sign': autoclawSign(AUTOCLAW_APP_ID, tsSeconds, AUTOCLAW_APP_KEY),
    'X-Trace-Id': randomUUID(),
  }
  // ⚠️ 必须剥掉令牌**可能自带**的 `Bearer ` 前缀，否则会拼成
  //    `Bearer Bearer eyJ…`，服务端一律判「未登录」（见 stripBearerPrefix）。
  //    解析层已经剥过一次，这里再剥一次是**最后一道防线**：本项目的两条鉴权
  //    链（本函数的 `authorization` 与 `autoclawBrandHeaders` 的 `X-Authorization`）
  //    都要拼 `Bearer `，一旦漏网，症状是各功能分别报「查询失败」而登录看起来
  //    完全正常 —— 极难定位，所以宁可在两处各挡一次。
  const bare = stripBearerPrefix(token)
  if (bare.length > 0) headers.authorization = `Bearer ${bare}`
  return headers
}

/**
 * **推理请求**的请求头集合。
 *
 * ⚠️ **绝不发 `X-Harness-Type`**：在 LLM 域带上它会 403 `pay-view`
 * 或 406 空体（实测）。这条约束正是本函数与
 * {@link autoclawSignedHeaders} 必须分开的原因 —— 共用一个头集合
 * 必然把 `X-Harness-Type` 带进推理链。
 *
 * ⚠️ 鉴权头是 `X-Authorization`（**不是** `Authorization`）。
 *
 * ⚠️ `x_trace_id: autoclaw-desktop` 是**下划线**且是常量：照抄源码，
 * 它不是每请求唯一的追踪 id（唯一性由 `X-Request-Id` 承担）。
 *
 * @param token - 访问令牌。
 * @param routeId - 上游路由 id（{@link resolveAutoclawRoute} 的输出）。
 * @param clientHeaders - 客户端原始头（**小写键**）；只透传下面三个白名单头。
 */
export function autoclawBrandHeaders(
  token: string,
  routeId: string,
  clientHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Tm': brandPlatform(),
    'X-Version': AUTOCLAW_INFER_VERSION,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    // ⚠️ 下划线键名 + 常量值，照抄源码（见上方注释）。
    x_trace_id: 'autoclaw-desktop',
    // ⚠️ 与业务链同理：先剥掉令牌可能自带的 `Bearer ` 前缀再拼，
    //    否则会发出 `Bearer Bearer eyJ…`（见 stripBearerPrefix）。
    'X-Authorization': `Bearer ${stripBearerPrefix(token)}`,
    'X-Request-Id': randomUUID(),
    'X-Request-Model': routeId,
  }
  // 会话/代理身份头：**客户端带了才透传**。凭空造一个会话 id 会让上游
  // 把两次无关的请求归进同一会话（上下文串味），故缺席时宁可不发。
  const sessionId = clientHeaders?.['x-autoclaw-session-id']
  if (sessionId !== undefined && sessionId.length > 0) headers['X-Session-Id'] = sessionId
  const agentId = clientHeaders?.['x-autoclaw-agent-id']
  if (agentId !== undefined && agentId.length > 0) headers['X-Agent-Id'] = agentId
  const invocationId = clientHeaders?.['x-autoclaw-zcode-invocation-id']
  if (invocationId !== undefined && invocationId.length > 0) {
    headers['X-ZCode-Invocation-Id'] = invocationId
  }
  return headers
}

/** 远端模型条目（已归一）。 */
export interface AutoclawRemoteModel {
  /** 目录 id（剥前缀的通用名，DSH 侧标识）。 */
  id: string
  /** 上游路由 id（`X-Request-Model` 的取值）。 */
  routeId: string
  /** 展示名（可能已含倍率文案）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 是否支持工具调用（上游目录不区分，恒 true）。 */
  supportsToolCall: boolean
  /** 计费档位文案（远端 `creditConsumptionLevel`，如「低」/「中」/「高」）。 */
  creditConsumptionLevel?: string
}

/**
 * 已知路由前缀（**顺序有意义**）。
 *
 * ⚠️ 必须**先试 `zaicoding_` 再试 `zai_`**：虽然 `zaicoding_` 并不以
 * `zai_` 开头（差一个下划线），但这条顺序是照抄源码的判定次序，
 * 将来若上游加上 `zai_coding_` 之类的重叠前缀，顺序就是正确性的分界。
 */
const AUTOCLAW_ROUTE_PREFIXES = ['zaicoding_', 'zai_'] as const

/**
 * 合法 route id 的形态。
 *
 * `zaicoding_glm-5.3` / `zai_auto` / `zai_glm-5.3-flash` 都命中；
 * 而用户随手输的 `glm-5.3`（无下划线）不命中 —— 这正是「第 ④ 步只放行
 * 真实路由 id，不把任意字符串透传给上游」的意义。
 */
const AUTOCLAW_ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}$/

/** 全部都不中时的兜底路由（`routeId` 与 `model` 都是它）。 */
export const AUTOCLAW_AUTO_ROUTE = 'zai_auto'

/** 归一化用于比较：去空白 + 忽略 ASCII 大小写。 */
function foldForCompare(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * 在候选条目里按「先 id、再 name、再 routeId」的顺序找匹配。
 *
 * 三处比较都做 trim + 忽略 ASCII 大小写：用户从别处复制模型名时
 * 常带尾随空格或首字母大写，严格相等会「明明存在却匹配不上」。
 */
function matchByFields(
  candidates: readonly { id: string; name: string; routeId: string }[],
  target: string,
): { id: string; name: string; routeId: string } | undefined {
  const folded = foldForCompare(target)
  if (folded.length === 0) return undefined
  return candidates.find((item) => foldForCompare(item.id) === folded)
    ?? candidates.find((item) => foldForCompare(item.name) === folded)
    ?? candidates.find((item) => foldForCompare(item.routeId) === folded)
}

/**
 * 把 DSH 回传的模型名解析成上游要的 `routeId` 与 body 里的 `model`。
 *
 * ## 判定顺序**不可换**（每一步都有明确的适用面）
 *
 * ① **静态表**（先 id、再 name、再 routeId）—— 兜底表是产品配置的一部分，
 *    即使远端目录一次都没拉到也必须可用；
 * ② **远程目录**（同口径）—— 远端是权威，但在静态表**之后**：
 *    静态表里的两条是实测确认过的，优先级更高；
 * ③ **已知前缀**（`zaicoding_` / `zai_`）—— 客户端直接把 routeId 当模型名
 *    传来时（老会话里持久化的就是它），原样透传为 routeId、剥前缀为 model；
 * ④ **合法 route id 形态** —— 上游新加了前缀（如 `zaicoding2_*`）时不必
 *    改代码就能用；
 * ⑤ **都不中 → `zai_auto`** —— 交上游自动选模。**不能把裸模型名透传**：
 *    上游不认（会 404），而「自动选模」至少让用户能用上。
 *
 * @returns `routeId`（`X-Request-Model` 头）、`model`（请求体的 `model`）、
 *   `requested`（**客户端原名**，供 SSE 逐帧回写用 —— 见适配器的说明）。
 */
export function resolveAutoclawRoute(
  product: AutoclawProduct,
  model: string,
  remoteModels: readonly AutoclawRemoteModel[] = [],
): { routeId: string; model: string; requested: string } {
  const requested = model

  // ① 静态表
  const staticHit = matchByFields(product.fallbackModels, model)
  if (staticHit !== undefined) {
    return { routeId: staticHit.routeId, model: staticHit.id, requested }
  }

  // ② 远程目录（同口径）
  const remoteHit = matchByFields(remoteModels, model)
  if (remoteHit !== undefined) {
    return { routeId: remoteHit.routeId, model: remoteHit.id, requested }
  }

  const trimmed = model.trim()
  const folded = trimmed.toLowerCase()

  // ③ 已知前缀：原样透传 routeId、剥前缀为 model
  for (const prefix of AUTOCLAW_ROUTE_PREFIXES) {
    if (!folded.startsWith(prefix)) continue
    const bare = trimmed.slice(prefix.length)
    // 剥完是空串说明只是个前缀（`zai_`），不是可用模型名 —— 落到兜底。
    if (bare.length === 0) break
    return { routeId: trimmed, model: bare, requested }
  }

  // ④ 合法 route id 形态：透传（model 与 routeId 同值）
  if (AUTOCLAW_ROUTE_ID_PATTERN.test(trimmed)) {
    return { routeId: trimmed, model: trimmed, requested }
  }

  // ⑤ 兜底：交给上游自动选模
  return { routeId: AUTOCLAW_AUTO_ROUTE, model: AUTOCLAW_AUTO_ROUTE, requested }
}

/**
 * 身份前缀**首句**（幂等判据用：正文已以它开头就不再前置）。
 *
 * 单独导出它是因为幂等判定与拼接用的是同一个字符串 ——
 * 两处各写一份必然分叉，而分叉的症状是「每次请求都多叠一段身份前缀」。
 */
export const AUTOCLAW_IDENTITY_SENTENCE = 'You are a personal assistant running inside OpenClaw.'

/**
 * 出站身份前缀原文（**末尾一个 `\n`**）。
 *
 * 与既有正文拼接时再补一个空行（见 {@link normalizeAutoclawSystemMessages}），
 * 于是最终形态是「前缀 + 空行 + 原正文」。
 */
export const AUTOCLAW_IDENTITY_PREFIX = `${AUTOCLAW_IDENTITY_SENTENCE}

## Tooling
Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.
`

/**
 * 外来身份句 → 中性说法（**逐字**，顺序即替换顺序）。
 *
 * ⚠️ **长句必须排在短句之前**：`You are a coding agent running in the Codex CLI`
 * 是 `You are Codex` 的**超串**不成立，但 `You are ZCode, an interactive coding
 * agent` 与 `You are ZCode` 是包含关系 —— 短句先替换会把长句切碎，留下
 * `, an interactive coding agent` 这类残片。故本表的顺序不可重排。
 */
const AUTOCLAW_IDENTITY_REWRITES: readonly (readonly [string, string])[] = [
  ['You are ZCode, an interactive coding agent', 'You are an interactive coding agent'],
  ['You are a coding agent running in the Codex CLI tool', 'You are a coding agent running in a terminal CLI tool'],
  ['You are a coding agent running in the Codex CLI', 'You are a coding agent running in a terminal CLI'],
  ['You are running as a coding agent in the Codex CLI', 'You are running as a coding agent in a terminal CLI'],
  ['You are Claude Code', 'You are a coding assistant'],
  ['You are ZCode', 'You are an interactive coding agent'],
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI agent powered by a local coding harness'],
  ['You are Codex', 'You are a coding agent'],
]

/** 正则元字符转义（身份句里有 `.` 等字符，直接拼正则会误匹配）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 改写一段文本里的外来身份句。
 *
 * **忽略 ASCII 大小写 + 全量替换**（`gi`）：harness 的提示词大小写稳定，
 * 但用户/插件可能注入变体；漏掉一个变体就等于白名单校验失败。
 * 替换用函数形式，避免 `$&` 之类的替换模式被当作反向引用。
 */
function rewriteIdentitySentences(text: string): string {
  let out = text
  for (const [from, to] of AUTOCLAW_IDENTITY_REWRITES) {
    out = out.replace(new RegExp(escapeRegExp(from), 'gi'), () => to)
  }
  return out
}

/** 是否 system / developer 角色。 */
function isSystemRole(role: unknown): boolean {
  return role === 'system' || role === 'developer'
}

/** 从消息里取出可改写的正文形态（字符串或 text part 数组）；其它形态返回 undefined。 */
function rewriteContent(content: unknown): unknown {
  if (typeof content === 'string') return rewriteIdentitySentences(content)
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (typeof part !== 'object' || part === null) return part
    const record = part as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') return part
    return { ...record, text: rewriteIdentitySentences(record.text) }
  })
}

/** 从消息正文里取纯文本（仅用于幂等判定，不改写）。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

/**
 * **出站 system 提示词规范化**（上游白名单校验，能否跑通的关键）。
 *
 * ## 做三件事
 *
 * 1. **改写外来身份句**：遍历所有 `role === 'system' || 'developer'` 的消息，
 *    把别家 agent 的身份句换成中性说法（见
 *    {@link AUTOCLAW_IDENTITY_REWRITES}）；
 * 2. **保证首条是 system/developer 且正文以身份句开头**：不是 system 时在
 *    `messages[0]` **插入**一条只带前缀的 system；是 system 但正文不以
 *    身份句开头时**前置**前缀（前缀 + 空行 + 原正文）；
 * 3. **幂等**：正文已以身份句开头时**只改写、不再前置**。
 *
 * ## 明确的边界（不做的事）
 *
 * - **不动** user / assistant / tool 消息（改写用户输入等于篡改用户的话）；
 * - **不重排、不删改**其它消息，也不碰除 `content` 之外的任何字段；
 * - 只动 `content` 的**文本**部分，非文本 part 原样保留。
 *
 * @param messages - 已序列化的 wire 消息（`serializeMessages` 的输出）。
 * @param system - DSH 注入的 system 提示词；非空时作为**首条 system** 前置。
 *   它与 `messages` 里已有的 system 消息**不会互相覆盖** —— 两条都保留，
 *   各自改写（上游按条校验，丢一条就是丢上下文）。
 * @returns 新的消息数组（输入不被修改）。
 */
export function normalizeAutoclawSystemMessages(
  messages: readonly Record<string, unknown>[],
  system?: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []

  // DSH 的 system 提示词先落成一条消息（与其余适配器的前置行为一致）。
  //
  // ⚠️ **它必须与 messages 里的 system 一起改写** —— 而且它才是最要紧的那一条：
  // 「You are an AI agent powered by DeepSeek Harness」正是 DSH 自己注入的
  // 身份句，漏改它等于白名单校验这一关没过（真实缺陷：早期只改 messages
  // 里的 system，DSH 的 system 原样出站）。
  if (system !== undefined && system.trim().length > 0) {
    out.push({ role: 'system', content: rewriteIdentitySentences(system) })
  }

  for (const message of messages) {
    if (isSystemRole(message.role)) {
      // 只重建 content 字段：其它字段（如 developer 的附加属性）原样保留。
      out.push({ ...message, content: rewriteContent(message.content) })
      continue
    }
    out.push(message)
  }

  // ── 首条必须是 system/developer，且正文以身份句开头 ──
  const head = out[0]
  if (head === undefined || !isSystemRole(head.role)) {
    // 首条不是 system：**插入**一条只带前缀的 system（不重排、不删改其它消息）。
    out.unshift({ role: 'system', content: AUTOCLAW_IDENTITY_PREFIX })
    return out
  }

  const text = contentText(head.content)
  if (text.trimStart().toLowerCase().startsWith(AUTOCLAW_IDENTITY_SENTENCE.toLowerCase())) {
    // 幂等：已以身份句开头 → 只改写（上面已做），不再前置。
    return out
  }

  // 前置前缀 + **一个空行**（前缀自身末尾已有一个 `\n`）。
  const nextContent = typeof head.content === 'string'
    ? `${AUTOCLAW_IDENTITY_PREFIX}\n${head.content}`
    : Array.isArray(head.content)
      ? [{ type: 'text', text: `${AUTOCLAW_IDENTITY_PREFIX}\n` }, ...head.content]
      : `${AUTOCLAW_IDENTITY_PREFIX}\n`
  out[0] = { ...head, content: nextContent }
  return out
}

/**
 * 从 JWT 的 payload 段读 `exp`（秒 → **毫秒**）。解不出返回 undefined。
 *
 * 不校验签名：这里只读一个用于「何时该续期」的时间戳，签名由服务端校验。
 * 任何解析失败都返回 undefined 而**不抛错** —— 凭据可能被手工改坏，
 * 那时应当降级成「无过期信息」（宁可试一次），而不是让整个 provider 崩。
 */
export function decodeAutoclawJwtExpMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    // JWT 用 base64url；Node 的 base64 解码器接受 base64url 字符集。
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

/**
 * 凭据的过期时刻（毫秒）。
 *
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**。
 *
 * ⚠️ **回退到 JWT 是必需的，不是锦上添花**：`expires_at` 是可选字段，
 * 老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定
 * **恒为 false**，于是 `refreshAll` 永远跳过这些账号 —— 表现为
 * 「凭据悄悄过期、续期从不触发」，与 AGENTS.md 里「续期按 enabled 过滤」
 * 那次缺陷是同一类（静默失效，无任何报错）。
 *
 * ⚠️ `expires_at` 的**单位按量级判定**：`>= 1e12` 视为毫秒（2001 年之后
 * 的毫秒时间戳都满足），`>= 1e9` 视为秒（否则会被当成 1970 年而立刻判过期），
 * 更小的值视为垃圾数据并回退 JWT。服务端换过单位这件事没有文档，
 * 只能靠量级自证 —— 而写错单位的后果是「所有账号一登录就显示已过期」。
 */
export function autoclawCredentialExpiresAtMs(credential: AutoclawCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    if (raw >= 1e12) return raw
    if (raw >= 1e9) return raw * 1000
  }
  return decodeAutoclawJwtExpMs(credential.access_token)
}

/**
 * 凭据是否可静默续期。
 *
 * 判据是 `refresh_token` 非空 —— AutoClaw **有** refresh 端点
 * （`POST {userapi}/userapi/v1/refresh`），与 Loomy / ZCode（恒 false）不同。
 */
export function isAutoclawRefreshable(credential: AutoclawCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/**
 * 账号 id（`accounts` 主键）。
 *
 * 前缀由地区给出（`user-` / `intl-user-`），于是两地的记录天然不相交 ——
 * 同一个人在两套系统里的 user_id 完全可能相同，撞 id 会让存储层的保护
 * 拒绝写入，而「两地账号并存」正是两个 provider 建模的意义之一。
 *
 * `userId` 为空时回落到随机后缀：不能落一个固定串（第二个空 id 账号会
 * 覆盖第一个），也不能落空 id（会让后续的 patch / remove 找不到它）。
 */
export function autoclawAccountId(product: AutoclawProduct, userId: string): string {
  const suffix = userId.trim().length > 0 ? userId.trim() : `anon-${randomBytes(6).toString('hex')}`
  return `${product.accountIdPrefix}${suffix}`
}

/**
 * 展示名（账号列表里那一列）。
 *
 * 优先 `user_id`，其次 `email`：国内版手机验证码登录**没有 email**，
 * 而国际版 OAuth 两者都有 —— 用 `user_id` 优先能让同一账号在两地
 * 各有一行且互不重名。
 */
export function autoclawDisplayName(
  product: AutoclawProduct,
  credential: AutoclawCredential,
): string {
  const base = product.id === 'autoclaw' ? 'AutoClaw 国内版' : 'AutoClaw 国际版'
  const userId = credential.user_id?.trim() ?? ''
  if (userId.length > 0) return `${base} · ${userId}`
  const email = credential.email?.trim() ?? ''
  return email.length > 0 ? `${base} · ${email}` : base
}
