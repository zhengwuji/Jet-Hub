/**
 * CatPaw（美团）协议常量与**纯函数**：无网络、无状态。
 *
 * ## 上游不是 OpenAI 协议
 *
 * CatPaw 的上游是一套自有的 **conversation 会话协议**：
 *
 * ```text
 * round(提交消息) → event(running) → turn(SSE 执行) → 工具循环 → event(completed)
 * ```
 *
 * 因此 `round` / `turn` **不接受** OpenAI 的 `messages`，只接受它自己的消息块数组：
 *
 * ```text
 * user:      { type:"user",      messageId, content:[text | image_url], finished }
 * assistant: { type:"assistant", messageId, content:[text | tool_use],  finished }
 * tool:      { type:"tool",      messageId, content:[tool_result],      finished }
 * ```
 *
 * 本模块负责「OpenAI 消息 → 上游消息块」的翻译（纯函数）以及入站参数映射
 * （modelType / effort / context / tools）。**时序**（round / event / turn 的编排）
 * 在 `catpaw-adapter.ts`，会话状态在 `catpaw-registry.ts`。
 *
 * ## 本文件承载的实测坑（逐条都有真实缺陷背景）
 *
 * - **`messageId` 必须非空**：上游 2026-09 起在 round 阶段逐条校验，空串被拒
 *   （`unifyCode=1005010001`）。客户端不传 `id` 时必须补随机 UUID ——
 *   而指纹**不读** `messageId`，所以补随机值不会破坏增量会话（见
 *   {@link catpawMessageFingerprint}）。
 * - **连续 tool 消息必须合并**：上游明确拒绝 tool 消息连续出现（并行工具调用
 *   在 OpenAI 形态下是连续的多条 `role:'tool'`）。
 * - **toolName 必须回填**：客户端回显历史时常常只给 `tool_call_id`，而
 *   `toolName` **进指纹** —— 不回填会让客户端下一轮的这条消息与注册表里的指纹
 *   对不上，误判「历史被改写」而全量重建。
 * - **`kimi-k3` 不支持 `context` 参数**：传了上游直接 400，故静态表里它的
 *   `contextOptions` 是空数组，适配器必须整个不发该字段。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { contentToText } from './openai-compat.js'
import {
  CATPAW_APP_KEY,
  CATPAW_CLIENT_VERSION,
  type CatpawFallbackModel,
} from './catpaw-product.js'

/**
 * 协议层错误（客户端可见中文文案 + 上游业务码）。
 *
 * 单独一个类而不是直接抛 `LlmError`：本模块是**纯函数层**，不应该依赖
 * `@deepseek-ai/dsh-llm` 的运行时；适配器负责把它翻译成 `LlmError`。
 * `failCode` / `unifyCode` 来自上游错误体，进终态上报（`event(failed)`）。
 */
export class CatpawProtocolError extends Error {
  constructor(
    message: string,
    /** 客户端可见的 HTTP 状态码（入站参数错一律 400）。 */
    readonly status: number,
    /** 上游业务码（`code`）。 */
    readonly failCode?: number,
    /** 上游统一错误码（`unifyCode`）。 */
    readonly unifyCode?: number,
  ) {
    super(message)
    this.name = 'CatpawProtocolError'
  }
}

/** 入站参数错误（400）。 */
function badRequest(message: string): CatpawProtocolError {
  return new CatpawProtocolError(message, 400)
}

/**
 * catpaw 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识。上游侧它进 `Cookie: X-Passport-Token=<token>`。
 */
export interface CatpawCredential {
  /** 登录态 token（上游 `X-Passport-Token` 的值）。 */
  access_token: string
  /**
   * 用户 id。
   *
   * ⚠️ 它**不在 token 里**（不是 JWT），必须由账号一起给出 —— 上游要求独立的
   * `user-uid` 请求头。缺失时上游对部分端点仍放行，但账号身份判定会退化为
   * 「无身份」（注册表按空串做相等匹配，不是通配）。
   */
  uid?: string
  /** 登录名（`current-user` 的 `userName`）。 */
  login_name?: string
  /** 展示用昵称。 */
  nickname?: string
  /** 归属 provider（多 provider 共用一个凭据文档时用）。 */
  provider?: string
}

/**
 * 解析凭据（string 或已解析对象都接受）。
 *
 * 参数用 `unknown` 而不是 `string`：调用点既有「凭据存储里的 JSON 文本」，
 * 也有「已经解析好的对象」（账号池的 `getAvailableAccount` 直接给对象）。
 * 用 `unknown` 避免调用方为了满足类型而写双重断言。
 *
 * 形状不对（非对象 / 缺 `access_token` 或非字符串）返回 undefined，**不抛错** ——
 * 凭据可能被手工改坏，那时应当降级成「未配置」，而不是让整个 provider 崩。
 */
export function parseCatpawCredential(value: unknown): CatpawCredential | undefined {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  const record = asRecord(parsed)
  if (record === undefined) return undefined
  if (typeof record.access_token !== 'string') return undefined
  const credential: CatpawCredential = { access_token: record.access_token }
  if (typeof record.uid === 'string') credential.uid = record.uid
  if (typeof record.login_name === 'string') credential.login_name = record.login_name
  if (typeof record.nickname === 'string') credential.nickname = record.nickname
  if (typeof record.provider === 'string') credential.provider = record.provider
  return credential
}

/**
 * 上游请求头（round / event / turn / turn-stop / 模型目录共用）。
 *
 * ## 三条硬规则
 *
 * 1. **`M-TRACEID` 每次请求都是新的随机 UUID（去掉连字符）** —— 上游用它做
 *    链路追踪；复用同一个值会让多条请求在上游侧串成一条。
 * 2. **`Cookie: X-Passport-Token=<token>` 与 `user-uid` 只在非空时才带** ——
 *    带空值的 `Cookie: X-Passport-Token=` 会被上游判成「提供了无效凭证」，
 *    比完全不带更糟。
 * 3. **客户端的 `authorization` / `cookie` 一律不透传** —— 代理凭证与客户端
 *    凭证是两套独立体系，透传会把客户端的 key 泄露给上游。
 *
 * @param credential - 账号凭据。
 * @param options.accept - `Accept` 头（短请求是 `application/json`，turn 是
 *   `text/event-stream`）。
 * @param options.traceId - 仅供单测注入固定值；生产路径省略（随机生成）。
 */
export function catpawRequestHeaders(
  credential: CatpawCredential,
  options: { accept: string; traceId?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: options.accept,
    'Content-Type': 'application/json',
    'M-TRACEID': options.traceId ?? randomUUID().replace(/-/g, ''),
    'M-APPKEY': CATPAW_APP_KEY,
    'gray-set': 'new-agent-sdk',
    enableHeartBeat: 'true',
    'X-Agent-Version': CATPAW_CLIENT_VERSION,
  }
  const token = credential.access_token.trim()
  if (token.length > 0) headers.Cookie = `X-Passport-Token=${token}`
  const uid = credential.uid?.trim() ?? ''
  if (uid.length > 0) headers['user-uid'] = uid
  return headers
}

/**
 * 凭据过期时刻：**恒 undefined**。
 *
 * CatPaw 的凭据里**没有过期时间字段**（token 不是 JWT，也没有 `expires_at`），
 * 上游只在真正失效时回 401。返回 undefined 的语义是「无过期信息」——
 * 各调用方据此**不会**主动判过期，而是照常试一次（服务端会回 401，我们能识别）。
 * 这与 raccoon（解 JWT 的 `exp`）相反，与 Loomy 同型。
 */
export function catpawCredentialExpiresAtMs(_credential: CatpawCredential): number | undefined {
  return undefined
}

/**
 * 凭据是否可静默续期：**恒 false**。
 *
 * ⚠️ 上游**没有 refreshToken、也没有 refresh 端点**（见 `catpaw-auth.ts`）。
 * 凭据失效的唯一恢复路径是用户在桌面端重新登录。恒 false 直接决定
 * `refreshAll()` 不会碰它们 —— 返回 true 会让调度器反复尝试一个不存在的端点。
 */
export function isCatpawRefreshable(_credential: CatpawCredential): boolean {
  return false
}

/**
 * 账号 id（账号池主键）。
 *
 * 取值优先级 `uid` → `loginName`；两者都为空时用 `anon-<12位hex>` 兜底 ——
 * 不能落一个固定串（第二个匿名账号会覆盖第一个），也不能落空 id
 * （会让后续的 patch / remove 找不到它）。
 */
export function catpawAccountId(uid: string | undefined, loginName: string | undefined): string {
  const suffix = (uid ?? '').trim().length > 0
    ? (uid ?? '').trim()
    : (loginName ?? '').trim()
  const tail = suffix.length > 0 ? suffix : `anon-${randomBytes(6).toString('hex')}`
  return `catpaw-user-${tail}`
}

/** 展示名（账号列表里那一列）。 */
export function catpawDisplayName(credential: CatpawCredential): string {
  const id = (credential.login_name ?? '').trim().length > 0
    ? (credential.login_name ?? '').trim()
    : (credential.uid ?? '').trim()
  return id.length > 0 ? `CatPaw · ${id}` : 'CatPaw'
}

// ─── 通用小工具 ────────────────────────────────────────────────────

/** 取对象形态；数组与 null 都算「不是对象」。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * JavaScript 真值语义（`x || y`、`if (x)` 的判定）。
 *
 * 归一路径上多处依赖它（`block.image_url || block.imageUrl`、
 * `if (reasoning)`），而 TypeScript 的 `??`（空值合并）只跳过 null/undefined
 * —— `''` 能通过。两处语义不同，故单独一份、逐处标明用的是哪一个。
 */
function jsTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'string') return value.length > 0
  return true
}

/** 键存在（对齐 JS 里「字段给了」与「字段没给」的区别，`undefined` 也算给了）。 */
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** 非空字符串判定（trim 后）。 */
function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 图片 URL / Data URL 的长度上限（8MB，与上游客户端一致）。 */
const MAX_IMAGE_URL_LENGTH = 8 * 1024 * 1024

/** 允许的 `detail` 取值；其它一律回落 `auto`。 */
const IMAGE_DETAILS: readonly string[] = ['auto', 'low', 'high']

/**
 * `data:image/(png|jpeg|jpg|gif|webp|bmp);base64,<正文>` 判定。
 *
 * 类型部分大小写不敏感；正文由 base64 字符集 + 空白构成且**不能为空**。
 * 与「只判 `data:` 前缀」不同：上游对不认识的子类型会拒，提前挡掉能给出
 * 可读的 400 而不是让它变成一次上游报错。
 */
const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i

/** 校验一个 URL 是否是可内联的图片地址（data URL 或 http(s)）。 */
function isAcceptableImageUrl(url: string): boolean {
  if (url.startsWith('data:')) return DATA_URL_PATTERN.test(url)
  return /^https?:\/\//i.test(url)
}

// ─── 消息归一化 ────────────────────────────────────────────────────

/** 文本块（思考内容挂在**首个**文本块上）。 */
export interface CatpawTextBlock {
  type: 'text'
  text: string
  /** 上游字段名是驼峰；只在非空时出现。 */
  reasoningContent?: string
}

/** 图片块（**蛇形 → 驼峰**：`image_url` → `imageUrl`）。 */
export interface CatpawImageBlock {
  type: 'image_url'
  imageUrl: { url: string; detail: string }
}

/** 模型请求的工具调用块。 */
export interface CatpawToolUseBlock {
  type: 'tool_use'
  toolCallId: string
  toolName: string
  /** JSON 文本（原样保留客户端的空白与键序 —— 它进指纹）。 */
  toolParams: string
}

/** 工具结果块。 */
export interface CatpawToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  /** 由 assistant 侧的 `tool_use` 回填；回填**必须写回**（它进指纹）。 */
  toolName?: string
  toolResult: string
}

/** 上游内容块。 */
export type CatpawContentBlock =
  | CatpawTextBlock
  | CatpawImageBlock
  | CatpawToolUseBlock
  | CatpawToolResultBlock

/** 归一化后的上游消息。 */
export interface CatpawUpstreamMessage {
  type: 'user' | 'assistant' | 'tool'
  messageId: string
  content: CatpawContentBlock[]
  finished: boolean
}

/** {@link normalizeCatpawMessages} 的产物。 */
export interface CatpawNormalizedMessages {
  /** 上游消息块数组（**不含** system / developer）。 */
  messages: CatpawUpstreamMessage[]
  /** `system` 抽离的文本（进 `systemPromptContext.systemPromptOverride`）。 */
  systemPromptOverride?: string
  /** `developer` 抽离的文本（进 `rulesMessage`）。 */
  rulesMessage?: string
}

/**
 * 打断未完成工具调用时补的合成 `tool_result` 文案。
 *
 * 这条文案会**提交给上游**（客户端下一轮的历史里它就在那儿），改动会让模型
 * 对「上一轮为什么没结果」的理解发生变化，因此冻结。
 */
export const CATPAW_INTERRUPTED_TOOL_RESULT = '[工具调用被用户中断]'

/** 中间形态：归一化 + 相邻合并后、抽离 system/developer 之前的一条消息。 */
type Stage1 =
  | { kind: 'directive'; role: 'system' | 'developer'; text: string }
  | { kind: 'message'; message: CatpawUpstreamMessage }

/**
 * 把 OpenAI（harness）消息归一化成上游消息块。
 *
 * ## 归一化规则（每条都对应一个上游约束）
 *
 * 1. `system` / `developer` 抽离，**不进** `messages`；且必须位于所有对话消息
 *    之前（顺序错了，模型的「指令 vs 历史」分层就错了）；
 * 2. 连续多条 tool 消息（OpenAI 并行工具调用）**合并**为单条 tool 消息的多个
 *    `tool_result` 块 —— 上游明确拒绝 tool 消息连续出现；
 * 3. 相邻 assistant 消息合并（上游要求 assistant 不带 toolCall 时后一条必须是
 *    user）；两条**都**带 `tool_use` 时无法安全合并，保留原样交给配对校验报错
 *    （硬合并会让两轮的 tool_use/tool_result 配对错位）；
 * 4. assistant 的 `tool_use` 与随后的 tool 结果做**配对校验**，顺带用 assistant
 *    侧的 `toolName` 补齐 tool 消息缺失的 `toolName`（客户端常常只回 id）；
 * 5. 客户端**打断未完成的工具调用**后直接发新 user 消息：补一条合成 tool 消息
 *    保持配对，该合成消息只用于让校验通过；
 * 6. 图片块 `image_url:{url,detail}` → `imageUrl:{url,detail}`；
 * 7. 每条消息的 `messageId` 必须非空：客户端给了就用它的 `id`，没给就生成随机
 *    UUID（上游 2026-09 起逐条校验，空串被拒 `unifyCode=1005010001`）。
 *
 * ⚠️ **本函数不允许多余的尾部 tool_call**（历史以「没人应答的 assistant
 * tool_call」收尾时报 400）。「工具续接」那条路径由适配器自己从原始历史里切出
 * 那条 tool 消息，不经过本函数的末尾校验。
 *
 * @param messages - harness 的 `options.messages`（0.1.6 与 0.1.7 两种形状都认）。
 * @param system - harness 的 `options.system`（独立于 messages 的系统提示）。
 * @param imageUrls - `attachmentId` → 图片 URL（data URL）。缺省表示本次没有图片。
 */
export function normalizeCatpawMessages(
  messages: readonly unknown[],
  system?: string,
  imageUrls?: ReadonlyMap<string, string>,
): CatpawNormalizedMessages {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest('messages 必须是非空数组')
  }
  const stage: Stage1[] = []
  // `options.system` 是独立入参，但它同样属于「指令」层，且必须排在所有对话消息
  // 之前 —— 故作为**第一条** system 记入（与 messages 里的 system 按序合并）。
  if (typeof system === 'string' && system.length > 0) {
    stage.push({ kind: 'directive', role: 'system', text: system })
  }
  for (const [index, raw] of messages.entries()) {
    for (const item of normalizeMessage(raw, index, imageUrls)) stage.push(item)
  }
  return assemble(mergeAdjacent(stage))
}

/**
 * 单条消息归一化。
 *
 * 返回**数组**而不是单条：harness ≤0.1.6 会把工具结果**包裹在 user 消息里**，
 * 而一条 user 消息理论上可以同时带「工具结果」与「普通内容」。两者必须拆成
 * 两条上游消息（tool 消息要紧跟其 assistant tool_call），塞进一条会让上游的
 * 配对校验失败或把用户文本当成工具输出。
 */
function normalizeMessage(
  raw: unknown,
  index: number,
  imageUrls: ReadonlyMap<string, string> | undefined,
): Stage1[] {
  const message = asRecord(raw)
  if (message === undefined) throw badRequest(`messages[${index}] 必须是对象`)
  const role = typeof message.role === 'string' ? message.role : ''
  if (role === 'system' || role === 'developer') return [normalizeDirective(message, index, role)]
  if (role === 'user') return normalizeUser(message, index, imageUrls)
  if (role === 'assistant') return [normalizeAssistant(message, index)]
  if (role === 'tool') return [normalizeToolMessage(message, index)]
  throw badRequest(`不支持的消息角色: ${role}`)
}

/** system / developer：只允许非空文本，不允许携带工具字段。 */
function normalizeDirective(
  message: Record<string, unknown>,
  index: number,
  role: 'system' | 'developer',
): Stage1 {
  if (hasToolFields(message)) {
    throw badRequest(`messages[${index}] 的 ${role} 不允许携带工具字段`)
  }
  const text = contentToText(message.content)
  if (text.trim().length === 0) {
    throw badRequest(`messages[${index}] 的 ${role} 只允许非空文本内容`)
  }
  return { kind: 'directive', role, text }
}

/**
 * user：内容非空；工具结果块**拆成独立消息**。
 *
 * ⚠️ harness 0.1.6 把工具结果**包裹在 user 消息里**（`{type:'tool-result'}` 块），
 * 而 0.1.7 用一等 `role:'tool'` 消息。两条都认：只认一种形态会让另一种形态下的
 * 工具结果被当成普通用户文本下发，模型看到的是「我说了段话，用户回了段工具
 * 输出」，`tool_call_id` 关联整段丢失 —— 与 `message-shape.ts` 记录的真实缺陷同型。
 *
 * 工具结果与普通内容**拆成两条**（顺序：工具结果在前，用户文本在后）：
 * 上游要求 tool 消息紧跟其 assistant tool_call，而把用户文本混进 tool 消息会让
 * 模型把「用户的下一句话」读成工具输出。
 */
function normalizeUser(
  message: Record<string, unknown>,
  index: number,
  imageUrls: ReadonlyMap<string, string> | undefined,
): Stage1[] {
  const blocks = Array.isArray(message.content) ? message.content : []
  const toolResults = blocks.filter(isToolResultBlock)
  const regular = blocks.filter((block) => !isToolResultBlock(block))

  const out: Stage1[] = []
  if (toolResults.length > 0) {
    out.push(normalizeToolResultBlocks(toolResults, message, index))
  }

  const hasRegularContent = regular.length > 0 && contentToText(regular).trim().length > 0
  const hasImage = regular.some(isImageBlock)
  if (hasRegularContent || hasImage) {
    if (hasToolFields(message)) {
      throw badRequest(`messages[${index}] 的 user 不允许携带工具字段`)
    }
    const content = normalizeContentBlocks(regular, index, imageUrls)
    if (content.length > 0) {
      out.push({
        kind: 'message',
        message: {
          type: 'user',
          messageId: messageIdOf(message),
          content,
          finished: finishedFlag(message),
        },
      })
    }
  }

  if (out.length === 0) throw badRequest(`messages[${index}] 的 user 内容不能为空`)
  return out
}

/** 是否为图片块（harness 形态 `image` 或 OpenAI 形态 `image_url`）。 */
function isImageBlock(value: unknown): boolean {
  const block = asRecord(value)
  if (block === undefined) return false
  return block.type === 'image' || block.type === 'image_url' || block.type === 'input_image'
}

/**
 * assistant：文本 + 思考 + `tool_calls`；`reasoning_content` 挂到**首个**文本块上。
 *
 * 挂载位置（与上游一致）：有文本块就写进它的 `reasoningContent`；没有就**追加
 * 一个空 text 块**承载。那个空 text 块在指纹里会被跳过
 * （见 {@link catpawMessageFingerprint}）—— 两处是同一条规则的两半，不能只改一边。
 */
function normalizeAssistant(message: Record<string, unknown>, index: number): Stage1 {
  const blocks = Array.isArray(message.content) ? message.content : []
  const content: CatpawContentBlock[] = []
  const reasoningParts: string[] = []

  // `reasoning_content ?? reasoningContent`：**空值合并**（显式 null 跳过）。
  const topReasoning = message.reasoning_content ?? message.reasoningContent
  if (typeof topReasoning === 'string' && topReasoning.length > 0) reasoningParts.push(topReasoning)

  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block === undefined) {
      if (typeof raw === 'string') {
        if (raw.length > 0) content.push({ type: 'text', text: raw })
        continue
      }
      throw badRequest(`messages[${index}] 的 assistant 内容块必须是对象或字符串`)
    }
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'text' || type === 'output_text') {
      const text = typeof block.text === 'string' ? block.text : ''
      const blockReasoning = block.reasoning_content ?? block.reasoningContent
      if (typeof blockReasoning === 'string' && blockReasoning.length > 0) {
        reasoningParts.push(blockReasoning)
      }
      content.push({ type: 'text', text })
      continue
    }
    if (type === 'reasoning' || type === 'thinking') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length > 0) reasoningParts.push(text)
      continue
    }
    if (type === 'tool-call' || type === 'tool_use') {
      content.push(normalizeToolUse(block, index))
      continue
    }
    throw badRequest(`messages[${index}] 的 assistant 只允许文本、思考与 tool_calls`)
  }

  const reasoning = reasoningParts.join('')
  if (reasoning.length > 0) {
    let target: CatpawTextBlock | undefined
    for (const block of content) {
      if (block.type === 'text') {
        target = block
        break
      }
    }
    if (target !== undefined) target.reasoningContent = reasoning
    else content.push({ type: 'text', text: '', reasoningContent: reasoning })
  }

  return {
    kind: 'message',
    message: {
      type: 'assistant',
      messageId: messageIdOf(message),
      content,
      finished: finishedFlag(message),
    },
  }
}

/** 0.1.7 的一等 `role:'tool'` 消息。 */
function normalizeToolMessage(message: Record<string, unknown>, index: number): Stage1 {
  return normalizeToolResultBlocks([message], message, index)
}

/**
 * 一组工具结果 → 一条 tool 消息（多块）。
 *
 * `tool_call_id` 取值链：顶层 `tool_call_id` → `toolCallId` → `source.callId`
 * （0.1.7 的伴随字段）→ 内层块字段。全都没有时报 400。
 */
function normalizeToolResultBlocks(
  sources: readonly unknown[],
  carrier: Record<string, unknown>,
  index: number,
): Stage1 {
  const content: CatpawContentBlock[] = []
  for (const raw of sources) {
    const block = asRecord(raw)
    if (block === undefined) throw badRequest(`messages[${index}] 的 tool 必须是对象`)
    const source = asRecord(carrier.source)
    const callId = nonEmptyText(block.tool_call_id)
      ?? nonEmptyText(block.toolCallId)
      ?? nonEmptyText(carrier.tool_call_id)
      ?? nonEmptyText(carrier.toolCallId)
      ?? nonEmptyText(source?.callId)
    if (callId === undefined) throw badRequest(`messages[${index}] tool_call_id 缺失`)
    // 工具名：`function.name` / `toolName` / `name`（三条都认，trim 后非空才算）。
    const toolName = nonEmptyText(block.toolName)
      ?? nonEmptyText(carrier.name)
      ?? nonEmptyText(block.name)
    const toolResult = toolResultContent(block, carrier, index)
    const result: CatpawToolResultBlock = { type: 'tool_result', toolCallId: callId, toolResult }
    if (toolName !== undefined) result.toolName = toolName
    content.push(result)
  }
  return {
    kind: 'message',
    message: {
      type: 'tool',
      messageId: messageIdOf(carrier),
      content,
      finished: finishedFlag(carrier),
    },
  }
}

/**
 * 工具结果文本。
 *
 * 取值优先级 `content` → `toolResult` → `result`（**空值合并**：`content: ''`
 * 命中空串；显式 null 跳过；三者都缺 → 空串）。
 * 数组形态：全字符串 → `\n` 连接；全是 text 块 → 取各块 `text` 后 `\n` 连接；
 * 其余 → 紧凑 JSON 文本。
 */
function toolResultContent(
  block: Record<string, unknown>,
  carrier: Record<string, unknown>,
  index: number,
): string {
  const value = block.content ?? block.toolResult ?? block.result
    ?? carrier.content ?? carrier.toolResult ?? carrier.result
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    if (value.every((item) => typeof item === 'string')) return value.join('\n')
    const allText = value.every((item) => {
      const inner = asRecord(item)
      if (inner === undefined) return false
      const type = inner.type
      return (type === 'text' || type === 'output_text') && typeof inner.text === 'string'
    })
    if (allText) {
      return value
        .map((item) => (asRecord(item)?.text as string | undefined) ?? '')
        .join('\n')
    }
    return stringifyToolData(value, index)
  }
  throw badRequest(`messages[${index}].content 必须是字符串或 JSON 结构`)
}

/** 任意 JSON 结构 → 紧凑 JSON 文本（含深度与危险键校验）。 */
function stringifyToolData(value: unknown, index: number): string {
  validateJsonValue(value, `messages[${index}].content`, 0)
  const text = JSON.stringify(value)
  if (text === undefined) throw badRequest(`messages[${index}].content 无法序列化为 JSON`)
  return text
}

/** assistant 的 `tool-call` / `tool_use` 块归一化。 */
function normalizeToolUse(block: Record<string, unknown>, index: number): CatpawToolUseBlock {
  const fn = asRecord(block.function)
  const callId = nonEmptyText(block.id)
    ?? nonEmptyText(block.toolCallId)
    ?? nonEmptyText(fn?.id)
  if (callId === undefined) throw badRequest(`messages[${index}] 的 tool_call 缺少 id`)
  const toolName = nonEmptyText(fn?.name)
    ?? nonEmptyText(block.toolName)
    ?? nonEmptyText(block.name)
  if (toolName === undefined) throw badRequest(`messages[${index}] 的 tool_call 缺少 function.name`)
  // `function.arguments ?? toolParams ?? arguments ?? ''` —— **空值合并**
  // （`arguments: ''` 命中空串；显式 null 跳过）。
  const rawArgs = fn?.arguments ?? block.toolParams ?? block.arguments
  const toolParams = typeof rawArgs === 'string'
    ? rawArgs
    : rawArgs === null || rawArgs === undefined
      ? '{}'
      : JSON.stringify(rawArgs)
  return { type: 'tool_use', toolCallId: callId, toolName, toolParams }
}

/** 内容块归一化（user 消息用：text / image_url）。 */
function normalizeContentBlocks(
  blocks: readonly unknown[],
  index: number,
  imageUrls: ReadonlyMap<string, string> | undefined,
): CatpawContentBlock[] {
  const content: CatpawContentBlock[] = []
  for (const raw of blocks) {
    if (typeof raw === 'string') {
      if (raw.length > 0) content.push({ type: 'text', text: raw })
      continue
    }
    const block = asRecord(raw)
    if (block === undefined) throw badRequest(`messages[${index}] 内容块必须是对象或字符串`)
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'text' || type === 'output_text') {
      const text = typeof block.text === 'string' ? block.text : ''
      if (text.length > 0) content.push({ type: 'text', text })
      continue
    }
    if (type === 'image' || type === 'image_url' || type === 'input_image') {
      const image = normalizeImageBlock(block, imageUrls)
      // 解析不到 URL（附件读取失败）时留占位文本，而不是静默吞掉整张图 ——
      // 静默吞掉会让用户以为「图片发过去了」而模型根本没看到。
      content.push(image ?? { type: 'text', text: '[image unavailable]' })
      continue
    }
    // 其余类型（含 legacy 的 tool-result，已在上面分流）静默跳过：上游不认它们，
    // 而报错会让一条含无关块的历史整段发不出去。
  }
  return content
}

/** 图片块归一化（`image_url:{url,detail}` → `imageUrl:{url,detail}`）。 */
function normalizeImageBlock(
  block: Record<string, unknown>,
  imageUrls: ReadonlyMap<string, string> | undefined,
): CatpawImageBlock | undefined {
  let url: string | undefined
  let detail: string | undefined
  // harness 形态：`{type:'image', attachment:{attachmentId}}`
  const attachment = asRecord(block.attachment)
  const attachmentId = nonEmptyText(attachment?.attachmentId)
  if (attachmentId !== undefined) url = imageUrls?.get(attachmentId)
  // OpenAI 形态：`{type:'image_url', image_url:{url,detail}}`（或驼峰 `imageUrl`）
  const source = asRecord(block.image_url) ?? asRecord(block.imageUrl)
  if (url === undefined) {
    if (typeof block.image_url === 'string') url = block.image_url
    else if (typeof source?.url === 'string') url = source.url
    else if (typeof block.url === 'string') url = block.url
  }
  if (source !== undefined && typeof source.detail === 'string') detail = source.detail
  if (url === undefined) return undefined
  const trimmed = url.trim()
  if (trimmed.length === 0) return undefined
  // 超长 URL 直接丢弃（不是报错）：上游对超限的响应是 504，而在归一化阶段挡掉
  // 能让请求照常发出（其余内容仍在），比整条请求失败好。
  if (trimmed.length > MAX_IMAGE_URL_LENGTH) return undefined
  if (!isAcceptableImageUrl(trimmed)) return undefined
  return {
    type: 'image_url',
    imageUrl: {
      url: trimmed,
      detail: detail !== undefined && IMAGE_DETAILS.includes(detail) ? detail : 'auto',
    },
  }
}

/** 相邻消息合并（顺序敏感：先 tool 后 assistant）。 */
function mergeAdjacent(stage: readonly Stage1[]): Stage1[] {
  const merged: Stage1[] = []
  for (const item of stage) {
    if (item.kind !== 'message') {
      merged.push(item)
      continue
    }
    const previous = merged[merged.length - 1]
    if (previous === undefined || previous.kind !== 'message') {
      merged.push(item)
      continue
    }
    const current = item.message
    const before = previous.message
    let mergeable = false
    if (current.type === 'tool' && before.type === 'tool') {
      mergeable = true
    } else if (current.type === 'assistant' && before.type === 'assistant') {
      // ⚠️ 两条**都**带 tool_use 时不合并：硬合并会让两轮的 tool_use/tool_result
      // 配对错位，留到配对校验里报错比静默错位好。
      mergeable = !hasToolUse(before) || !hasToolUse(current)
    }
    if (!mergeable) {
      merged.push(item)
      continue
    }
    // 合并：保留**前一条**的 messageId / finished（后一条只是同一条消息的续写）。
    before.content = [...before.content, ...current.content]
  }
  return merged
}

/** 抽离 system/developer + 工具配对校验 + 合成打断消息。 */
function assemble(merged: readonly Stage1[]): CatpawNormalizedMessages {
  const conversation: CatpawUpstreamMessage[] = []
  const systemParts: string[] = []
  const developerParts: string[] = []
  /** 已出现过的 tool_call_id：重复出现说明客户端把同一轮工具调用塞了两次。 */
  const knownToolCalls: string[] = []
  /** 待响应工具调用：`{id, name}`（assistant 声明、等 tool 结果）。 */
  let pending: Array<{ id: string; name: string }> = []

  for (const [index, item] of merged.entries()) {
    if (item.kind === 'directive') {
      if (conversation.length > 0) {
        throw badRequest(`messages[${index}] 的 ${item.role} 必须位于所有对话消息之前`)
      }
      if (item.role === 'system') systemParts.push(item.text)
      else developerParts.push(item.text)
      continue
    }
    const message = item.message
    if (message.type === 'assistant') {
      if (pending.length > 0) {
        throw badRequest(`messages[${index}] 前缺少 assistant tool_call 对应的 tool 结果`)
      }
      const calls = collectToolUse(message)
      for (const call of calls) {
        if (knownToolCalls.includes(call.id)) {
          throw badRequest(`messages[${index}] 重复的 tool_call_id: ${call.id}`)
        }
        knownToolCalls.push(call.id)
      }
      pending = calls
      conversation.push(message)
      continue
    }
    if (message.type === 'tool') {
      conversation.push(resolveToolMessage(message, index, pending))
      pending = pending.filter((call) => !resolvedCallIds(message).includes(call.id))
      continue
    }
    // user：若有未响应的工具调用，补一条合成 tool 消息保持配对。
    if (pending.length > 0) {
      conversation.push(synthesizeInterruptMessage(pending))
      pending = []
    }
    conversation.push(message)
  }

  if (pending.length > 0) {
    throw badRequest('最后一条 assistant tool_call 缺少对应的 tool 结果')
  }

  const result: CatpawNormalizedMessages = { messages: conversation }
  const systemPromptOverride = joinDirectives(systemParts)
  if (systemPromptOverride !== undefined) result.systemPromptOverride = systemPromptOverride
  const rulesMessage = joinDirectives(developerParts)
  if (rulesMessage !== undefined) result.rulesMessage = rulesMessage
  return result
}

/** 多条指令文本用空行连接；全空时返回 undefined（对应「字段不出现」）。 */
function joinDirectives(parts: readonly string[]): string | undefined {
  const joined = parts.filter((part) => part.length > 0).join('\n\n')
  return joined.length > 0 ? joined : undefined
}

/**
 * 一条 tool 消息的配对校验 + `toolName` 回填。
 *
 * 回填是**必须的**而非可选优化：客户端回显历史时常常只给 `tool_call_id`
 * （toolName 丢了），而 toolName 在指纹里 —— 不回填会让客户端下一轮的这条消息
 * 与注册表里的指纹对不上，误判历史被改写。
 *
 * ⚠️ 这里**不**移除 `pending`（由调用方按 `resolvedCallIds` 统一过滤）：
 * 一处改两件事容易漏，且调用方还要用它算「本次实际响应了哪些 id」。
 */
function resolveToolMessage(
  message: CatpawUpstreamMessage,
  index: number,
  pending: readonly { id: string; name: string }[],
): CatpawUpstreamMessage {
  const content: CatpawContentBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'tool_result') {
      content.push(block)
      continue
    }
    const expected = pending.find((call) => call.id === block.toolCallId)
    if (expected === undefined) {
      throw badRequest(`messages[${index}] 的 tool_call_id 没有待响应的 assistant tool_call`)
    }
    const actual = (block.toolName ?? '').length > 0 ? block.toolName : undefined
    if (actual !== undefined && actual !== expected.name) {
      throw badRequest(`messages[${index}] 的 tool name 与 assistant tool_call 不一致`)
    }
    content.push({ ...block, toolName: expected.name })
  }
  return { ...message, content }
}

/** 一条 tool 消息实际响应了哪些 tool_call_id。 */
function resolvedCallIds(message: CatpawUpstreamMessage): string[] {
  return message.content
    .filter((block): block is CatpawToolResultBlock => block.type === 'tool_result')
    .map((block) => block.toolCallId)
}

/** 合成「工具调用被用户中断」的 tool 消息。 */
function synthesizeInterruptMessage(pending: readonly { id: string; name: string }[]): CatpawUpstreamMessage {
  return {
    type: 'tool',
    messageId: randomUUID(),
    content: pending.map((call) => ({
      type: 'tool_result' as const,
      toolCallId: call.id,
      toolName: call.name,
      toolResult: CATPAW_INTERRUPTED_TOOL_RESULT,
    })),
    finished: true,
  }
}

/** 消息是否含 `tool_use` 块。 */
function hasToolUse(message: CatpawUpstreamMessage): boolean {
  return message.content.some((block) => block.type === 'tool_use')
}

/** 收集 assistant 的 `tool_use` 块为 `{id, name}`（按出现顺序）。 */
function collectToolUse(message: CatpawUpstreamMessage): Array<{ id: string; name: string }> {
  return message.content
    .filter((block): block is CatpawToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.toolCallId, name: block.toolName }))
}

/** 是否携带工具字段（system/developer/user 三种角色都不允许）。 */
function hasToolFields(message: Record<string, unknown>): boolean {
  // 真值判定：空数组在 JS 里是**真值**，所以 `"tool_calls": []` 也会被拒。
  return ['tool_calls', 'toolCalls', 'tool_call_id', 'toolCallId']
    .some((key) => hasOwn(message, key) && jsTruthy(message[key]))
}

/** 是否为 ≤0.1.6 形态的 `tool-result` 包裹块。 */
function isToolResultBlock(value: unknown): boolean {
  const block = asRecord(value)
  return block?.type === 'tool-result'
}

/**
 * `messageId` 取值：非空字符串用它（**原样，不 trim**），否则生成随机 UUID。
 *
 * 上游 2026-09 起在 round 阶段逐条校验：空串与缺失一样被拒
 * （`unifyCode=1005010001`）。补随机 UUID **不会**影响增量会话 ——
 * 指纹不读 `messageId`，同一条历史消息在两次请求里拿到不同 id 也不会被上游
 * 判成「历史被改写」。
 */
function messageIdOf(message: Record<string, unknown>): string {
  const id = message.id
  if (typeof id === 'string' && id.trim().length > 0) return id
  return randomUUID()
}

/** `finished: message.finished !== false`（只有显式 `false` 才是未完成）。 */
function finishedFlag(message: Record<string, unknown>): boolean {
  return message.finished !== false
}

// ─── 工具归一化 ────────────────────────────────────────────────────

/** 入站工具定义（DSH 的 `ToolSchema` 结构上兼容；`strict` 是本家额外认的字段）。 */
export interface CatpawToolInput {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

/** 上游 `toolConfigs[]` 的一个条目。 */
export interface CatpawToolConfig {
  name: string
  enable: boolean
  description?: string
  inputSchema: Record<string, unknown>
  fromClient: boolean
}

/** `tool_choice` 归一后的模式。 */
export type CatpawToolChoiceMode = 'none' | 'required' | 'named' | 'auto'

/** {@link normalizeCatpawTools} 的产物。 */
export interface CatpawNormalizedTools {
  /** 本轮实际下发给上游的工具集（已按 `tool_choice` 裁剪）。 */
  toolConfigs: CatpawToolConfig[]
  /** 工具名列表（进 turn 请求体的 `availableTools`）。 */
  availableTools: string[]
  /** 归一后的模式（收尾校验「上游有没有按 choice 返回」用）。 */
  mode: CatpawToolChoiceMode
  /** `tool_choice` 指定的函数名（`mode === 'named'` 时有值）。 */
  named?: string
}

/** 工具描述的截断上限（字符）。 */
const TOOL_DESCRIPTION_LIMIT = 8000

/** 工具名允许的字符集。 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * `tools` / `tool_choice` → 上游 `toolConfigs`。
 *
 * ## 字段映射
 *
 * | OpenAI 入站 | 上游 `toolConfigs[]` |
 * |---|---|
 * | `function.name` | `name` |
 * | `function.description` | `description`（截 8000 字符） |
 * | `function.parameters` | `inputSchema`（缺省 `{type:'object',properties:{}}`） |
 * | — | `enable: true` / `fromClient: true`（常量：客户端工具一律启用） |
 *
 * ## `strict: true` 一律拒绝（400）
 *
 * 上游没有「强制按 schema 输出」的开关。声称支持等于骗客户端 ——
 * 客户端以为拿到了结构性保证，实际没有。`strict: false` 是默认行为，放行。
 *
 * ## 校验
 *
 * `name` ≤128 且仅 `[A-Za-z0-9_.-]`；重名报 400；`inputSchema` 的 JSON 深度
 * ≤12 且不含 `__proto__` / `constructor` / `prototype`（上游是 JS 生态，
 * 原型污染是真实攻击面）。
 *
 * ## `tool_choice` → 下发的工具集
 *
 * | 取值 | 下发的工具集 |
 * |---|---|
 * | `none` | 空（并已在收尾断言「不许返回 tool_call」） |
 * | `auto` / `required` | 全部 |
 * | `{type:'function',function:{name}}` | 只含那一个（不存在则 400） |
 *
 * @param tools - DSH 的 `options.tools`（可能缺席）。
 * @param toolChoice - `tool_choice`（DSH 不传；适配器从 body 透传时用）。
 */
export function normalizeCatpawTools(
  tools: readonly CatpawToolInput[] | undefined,
  toolChoice?: unknown,
): CatpawNormalizedTools {
  const mode = resolveToolChoice(toolChoice)
  const all: CatpawToolConfig[] = []
  const names: string[] = []
  if (tools !== undefined && tools.length > 0) {
    for (const [index, tool] of tools.entries()) {
      const name = typeof tool.name === 'string' ? tool.name : ''
      if (name.length === 0 || name.length > 128 || !TOOL_NAME_PATTERN.test(name)) {
        throw badRequest(`tools[${index}].function.name 无效`)
      }
      if (names.includes(name)) throw badRequest(`tools[${index}] 重复的工具名称: ${name}`)
      names.push(name)
      if (tool.strict === true) throw badRequest(`tools[${index}].function.strict=true 暂不支持`)
      if (tool.strict !== undefined && typeof tool.strict !== 'boolean') {
        throw badRequest(`tools[${index}].function.strict 必须是布尔值`)
      }
      // `parameters ?? { type:'object', properties:{} }` —— **空值合并**
      // （显式 null 也落到默认值；空对象 `{}` 是合法 schema，原样用）。
      const schema = tool.parameters ?? { type: 'object', properties: {} }
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        throw badRequest(`tools[${index}].function.parameters 必须是 JSON Schema 对象`)
      }
      validateJsonValue(schema, `tools[${index}].function.parameters`, 0)
      const config: CatpawToolConfig = {
        name,
        enable: true,
        inputSchema: schema,
        fromClient: true,
      }
      if (typeof tool.description === 'string' && tool.description.length > 0) {
        config.description = tool.description.slice(0, TOOL_DESCRIPTION_LIMIT)
      }
      all.push(config)
    }
  }

  if (mode.mode === 'none') {
    return { toolConfigs: [], availableTools: [], mode: 'none' }
  }
  if (mode.mode === 'required') {
    if (all.length === 0) throw badRequest('tool_choice 要求至少提供一个 function 工具')
    return { toolConfigs: all, availableTools: all.map((tool) => tool.name), mode: 'required' }
  }
  if (mode.mode === 'named') {
    const selected = all.filter((tool) => tool.name === mode.named)
    if (selected.length === 0) {
      throw badRequest(`tool_choice 指定的工具不存在: ${mode.named ?? ''}`)
    }
    return {
      toolConfigs: selected,
      availableTools: selected.map((tool) => tool.name),
      mode: 'named',
      named: mode.named,
    }
  }
  return { toolConfigs: all, availableTools: all.map((tool) => tool.name), mode: 'auto' }
}

/** 解析 `tool_choice`。`undefined` / `null` / `'auto'` 都归 `auto`。 */
function resolveToolChoice(
  value: unknown,
): { mode: CatpawToolChoiceMode; named?: string } {
  if (value === undefined || value === null) return { mode: 'auto' }
  if (value === 'auto') return { mode: 'auto' }
  if (value === 'none') return { mode: 'none' }
  if (value === 'required') return { mode: 'required' }
  const record = asRecord(value)
  if (record !== undefined) {
    const kind = record.type
    const name = nonEmptyText(asRecord(record.function)?.name)
    if (kind === 'function' && name !== undefined) return { mode: 'named', named: name }
  }
  throw badRequest('tool_choice 只支持 auto、none、required 或指定 function')
}

/**
 * JSON 值合法性校验：嵌套深度 ≤12、对象内不允许
 * `__proto__` / `constructor` / `prototype` 三个键。
 *
 * 深度口径：从 0 起算，`> 12` 判超限（与上游实现一致）。
 */
function validateJsonValue(value: unknown, path: string, depth: number): void {
  if (depth > 12) throw badRequest(`${path} 嵌套过深`)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateJsonValue(item, `${path}[${index}]`, depth + 1)
    }
    return
  }
  const record = asRecord(value)
  if (record === undefined) return
  for (const [key, item] of Object.entries(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw badRequest(`${path} 包含不允许的字段 ${key}`)
    }
    validateJsonValue(item, `${path}.${key}`, depth + 1)
  }
}

// ─── 指纹与增量定位 ────────────────────────────────────────────────

/**
 * 上游 assistant 消息（或任意消息对象）→ 指纹输入。
 *
 * 归一化产物天然符合 `CatpawFingerprintInput`，但**上游返回的消息是外部输入**：
 * 直接传给 `catpawMessageFingerprint` 会在类型上要求调用方做断言。这里做一次
 * 结构收窄，把「不是对象」的情形变成空对象（指纹恒为「空消息」的哈希，
 * 不会崩、也不会与任何真实消息撞）。
 */
export function asFingerprintInput(value: unknown): CatpawFingerprintInput {
  return asRecord(value) ?? {}
}

/** 指纹计算的输入（只读三个字段；归一化产物与手写消息都兼容）。 */
export interface CatpawFingerprintInput {
  type?: unknown
  role?: unknown
  content?: unknown
}

/**
 * 单条**归一化后**消息的指纹（64 位十六进制小写）。
 *
 * ## 为什么要指纹
 *
 * 上游是**有状态**协议：同一客户端会话（`x-session-id`）复用同一个
 * conversationId，后续轮次的 round 只提交「增量消息」。代理要回答的问题是：
 * **客户端这次提交的历史里，哪一段上游已经见过了？** 办法是给每条归一化后的
 * 消息算一个稳定指纹，把「已同步过的指纹」按序存在会话注册表里。
 *
 * ## 序列化方式（必须逐字对齐，不要「顺手优化」）
 *
 * 先摊平成一个**字符串数组** `parts`，再对数组做 `JSON.stringify` 后取 SHA-256
 * —— 不是对消息对象做 `JSON.stringify`（那会把字段顺序、`messageId` 都卷进来）。
 *
 * `parts` 的组装顺序：
 * 1. `message.type || message.role || ''`；
 * 2. 每个块：跳过「text 且 text 与 reasoningContent 皆空」的块；然后依次 push
 *    块的 `type`（假值 → 空串）、`text`（**存在即 push**）、`toolCallId`（真值才
 *    push）、`toolName`（真值才 push）、`toolParams`（存在即 push）、
 *    `toolResult`（存在即 push，先 `String()`）。
 *
 * ## 参与 / 不参与
 *
 * 参与：消息的 `type` / `role`、每个块的 `type` / `text` / `toolCallId` /
 * `toolName` / `toolParams` / `toolResult`。
 * **不参与**：`messageId`（归一化时对缺失 id 的消息会生成随机 UUID，塞进去等于
 * 每条消息都不稳定 —— 反过来说，正是因为它不参与，归一化那边才可以放心用随机
 * UUID 兜底）、`finished`、`reasoningContent`、图片块的 `imageUrl`
 * （图片块只贡献字面量 `image_url`）。
 *
 * 空 text 块整体跳过 —— 上游返回的纯工具调用消息常带一个空 text 块，而客户端
 * 回显时会把它丢掉（content 为 null），保留会导致同一条消息两边指纹不同、
 * 误判历史被改写。
 *
 * **必须确定性**：同一份归一化消息任何时候都必须得到同一个指纹，否则同一会话
 * 在两轮之间会误判「客户端改写了历史」而被作废重建（全量 round）。
 */
export function catpawMessageFingerprint(message: CatpawFingerprintInput): string {
  const parts: unknown[] = []
  const record = asRecord(message) ?? {}
  // `message.type || message.role || ''`
  const head = jsTruthy(record.type) ? record.type : jsTruthy(record.role) ? record.role : ''
  parts.push(head)

  const blocks = Array.isArray(record.content) ? record.content : []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block === undefined) {
      // 非对象块：JS 里 `block?.type` 与 `block.text` 都是 undefined，
      // 最终只往 parts 里贡献一个空串。
      parts.push('')
      continue
    }
    if (isBlankTextBlock(block)) continue
    parts.push(jsTruthy(block.type) ? block.type : '')
    if (hasOwn(block, 'text')) parts.push(block.text)
    if (hasOwn(block, 'toolCallId') && jsTruthy(block.toolCallId)) parts.push(block.toolCallId)
    if (hasOwn(block, 'toolName') && jsTruthy(block.toolName)) parts.push(block.toolName)
    if (hasOwn(block, 'toolParams')) parts.push(block.toolParams)
    if (hasOwn(block, 'toolResult')) parts.push(String(block.toolResult))
  }

  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** 空 text 块判定：`type === 'text' && !text && !reasoningContent`。 */
function isBlankTextBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'text') return false
  return !jsTruthy(block.text) && !jsTruthy(block.reasoningContent)
}

/** 一串归一化消息的指纹链。 */
export function catpawFingerprintsFor(
  messages: readonly CatpawFingerprintInput[],
): string[] {
  return messages.map((message) => catpawMessageFingerprint(message))
}

/** {@link locateIncrement} 的结果。 */
export interface CatpawIncrement {
  /** 增量起点（归一化消息数组的下标）。 */
  start: number
  /** 指纹对不上（客户端压缩/改写了历史）→ 调用方需作废映射、全量重建。 */
  mismatch: boolean
}

/**
 * 在客户端本次的归一化消息里定位增量起点。
 *
 * ## 算法（**只取最后一条已同步指纹做 lastIndexOf**，不是前缀比对）
 *
 * 注册表存的 `syncedChain` 是「已提交给上游的指纹」序列，其**末元素**就是
 * 「上游最后见过的那条消息」；客户端历史里它的位置之后即为增量。
 *
 * ⚠️ **不做逐条前缀比对**：客户端压缩/改写历史是**正常行为**（上下文过长时
 * 客户端会自行删旧消息）。只要最后一条能对上，中间的任何差异都会被「整段增量
 * 重新提交」覆盖掉 —— 逐条比对反而会把这种可续接的会话判成失效。
 *
 * ## 三种返回
 *
 * - 命中 → `{start: index + 1, mismatch: false}`；
 * - 命中的是**最后一条**（`start === messages.length`）→ 只提交末尾那条
 *   （`start = messages.length - 1`）：客户端没带新消息（重发同一轮）时，
 *   round 不能提交空数组，而上游要求 turn 有一条消息可执行；
 * - 找不到 → `{start: 0, mismatch: true}`（全量重建）。
 *
 * 链为空（全新映射）时返回 `{start: 0, mismatch: false}` —— 没有「已同步指纹」
 * 不等于「历史被改写」，全量提交即可。
 */
export function locateIncrement(
  syncedChain: readonly string[],
  messages: readonly CatpawFingerprintInput[],
): CatpawIncrement {
  const lastSynced = syncedChain.length > 0 ? syncedChain[syncedChain.length - 1] : undefined
  if (lastSynced === undefined || lastSynced.length === 0) {
    return { start: 0, mismatch: false }
  }
  const fingerprints = catpawFingerprintsFor(messages)
  const index = fingerprints.lastIndexOf(lastSynced)
  if (index === -1) return { start: 0, mismatch: true }
  let start = index + 1
  // 命中末尾：只提交末尾那条（不能提交空数组）。
  if (start >= messages.length) start = Math.max(0, messages.length - 1)
  return { start, mismatch: false }
}

// ─── 模型 / 档位 / 上下文映射 ──────────────────────────────────────

/** 远端目录条目（已归一，见 `catpaw-auth.ts` 的 `fetchModels`）。 */
export interface CatpawRemoteModel {
  id: string
  name: string
  /** 上游数字 `modelType`（转发必须用；缺失的条目不会被广告）。 */
  modelType?: number
  /** 倍率文本（如 `x0.94 credits`）。 */
  credits?: string
  supportsImages?: boolean
  supportsReasoning?: boolean
  /** `context` 参数的最大档位（`parameterDefinitions` 的 ENUM 最大值）。 */
  maxInputTokens?: number
  /**
   * `context` 参数的默认档位。
   *
   * ⚠️ 保持上游的**字符串**形态（`"1024000"`）：`resolveCatpawContext` 的产物就是
   * 字符串（上游认字符串），转成数字再转回来只会多两次可能出错的转换。
   */
  defaultContextWindow?: string
}

/** {@link resolveCatpawModel} 的结果。 */
export interface CatpawModelResolution {
  /** 上游数字 `modelType`（建会话的必要条件）。 */
  modelType: number
  /** 客户端可见的模型名（静态表命中时用表里的规范 id）。 */
  displayName: string
  /** 命中的静态表条目（未命中为 undefined）。 */
  spec?: CatpawFallbackModel
}

/**
 * 模型名归一化：小写 + 空白/下划线/点 → 连字符。
 *
 * 用途是容忍客户端写 `GLM 5.3 Flash` / `glm_5.3_flash` 这类变体。
 */
function normalizeModelName(value: string): string {
  let out = ''
  for (const char of value.trim()) {
    if (/\s/.test(char) || char === '_' || char === '.') out += '-'
    else out += char.toLowerCase()
  }
  return out
}

/**
 * 把客户端请求的 `model` 解析成上游数字 ID。**三档判定**：
 *
 * 1. **静态表**命中（按 id 或 name，大小写/空白/下划线/点归一化后比）→
 *    用它实测过的数字 ID 与 context 档位（最可靠）；
 * 2. **远程目录**命中 → 用它自带的 `modelType`。没有这一档就会出现
 *    「目录里列着、请求却报 400」的自相矛盾 —— 远程目录会广告静态表里没有的模型；
 * 3. **纯数字** → 原样当上游 ID（`spec` 为 undefined，context 校验会据此拒绝）。
 *
 * ⚠️ **表外名字直接抛 400，不回落**：上游必须先知道数字 ID 才能建 conversation；
 * 回落成「不带数字 ID」时上游会用它自己的默认模型 —— 客户端要的模型与实际跑的
 * 不是同一个，属于**静默错答**。报错比猜测好。
 */
export function resolveCatpawModel(
  model: unknown,
  remoteModels: readonly CatpawRemoteModel[] = [],
  specs: readonly CatpawFallbackModel[] = [],
): CatpawModelResolution {
  const requested = typeof model === 'number'
    ? String(model)
    : typeof model === 'string'
      ? model.trim()
      : ''

  // ① 静态表（数字入参也走这条：静态表里有该 modelType 就用它）
  const spec = findSpec(requested, specs)
  if (spec !== undefined) {
    return { modelType: spec.modelType, displayName: spec.id, spec }
  }

  // ② 远程目录
  if (requested.length > 0) {
    const wanted = normalizeModelName(requested)
    const remote = remoteModels.find((item) => {
      return normalizeModelName(item.id) === wanted || normalizeModelName(item.name) === wanted
    })
    if (remote !== undefined && typeof remote.modelType === 'number') {
      // `displayName` 取**目录里的规范 id**：客户端可能传的是展示名，
      // 而回写与日志该用规范名。
      return { modelType: remote.modelType, displayName: remote.id }
    }
  }

  // ③ 纯数字
  if (requested.length > 0 && /^\d+$/.test(requested)) {
    const modelType = Number(requested)
    if (Number.isSafeInteger(modelType)) return { modelType, displayName: requested }
  }

  const known = [...specs.map((item) => item.id), ...remoteModels.map((item) => item.id)].join('、')
  throw badRequest(
    `CatPaw 上游不支持模型 ${requested.length === 0 ? '(未指定)' : requested}（可用: ${known}）`,
  )
}

/** 静态表里按 id / name 找条目（归一化后比）。 */
function findSpec(
  requested: string,
  specs: readonly CatpawFallbackModel[],
): CatpawFallbackModel | undefined {
  if (requested.length === 0) return undefined
  const wanted = normalizeModelName(requested)
  return specs.find((item) => {
    return normalizeModelName(item.id) === wanted || normalizeModelName(item.name) === wanted
  })
}

/**
 * `reasoning_effort` → `declarativeParams.effort`。
 *
 * 取值链 `reasoning_effort ?? reasoningEffort ?? effort`（**空值合并**：
 * 空串也会命中并报错，不会被跳过）。
 *
 * ⚠️ 只允许 `low` / `high` / `max`（上游枚举），其余**报 400** ——
 * 静默忽略会让「客户端以为调了思考等级、实际没生效」无从发现。
 * 这与其它 provider 的「未知档位回落」有意不同：本家的上游对未知值的反应是
 * 硬拒绝，而回落等于把用户的意图悄悄换掉。
 *
 * @returns 归一后的小写档位；三个键都没给时 undefined（不发该字段）。
 */
export function resolveCatpawEffort(body: unknown): string | undefined {
  const record = asRecord(body) ?? {}
  const raw = record.reasoning_effort ?? record.reasoningEffort ?? record.effort
  if (raw === null || raw === undefined) return undefined
  const value = (typeof raw === 'string' ? raw : String(raw)).trim().toLowerCase()
  if (value !== 'low' && value !== 'high' && value !== 'max') {
    throw badRequest('reasoning_effort 仅支持 low / high / max')
  }
  return value
}

/** 上下文档位别名（`200k` / `1m` 这类人类可读写法 → 上游认的数字串）。 */
const CONTEXT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['200k', '204800'],
  ['204800', '204800'],
  ['500k', '512000'],
  ['512000', '512000'],
  ['1m', '1024000'],
  ['1024k', '1024000'],
  ['1024000', '1024000'],
])

/**
 * 解析 `context` 档位。
 *
 * 取值链（**顺序即优先级**）：`context_window` / `contextWindow` /
 * `context_length` / `contextLength` / `model_params.context` /
 * `modelParams.context` / `request_context.modelParams.declarativeParams.context` /
 * `requestContext.…`。
 *
 * 规则：
 * - 有显式值 → 必须在别名表里，**且该模型支持这个档位**，否则 400；
 * - 无显式值 → 用模型的默认档位；没有默认档位则返回 undefined（不发该字段）。
 *
 * ⚠️ **模型不支持 `context` 参数时（`contextOptions` 为空）必须整个不发** ——
 * `kimi-k3` 就是这种：传了上游直接 400。这不是「保守起见」，是实测结论。
 */
export function resolveCatpawContext(
  body: unknown,
  model: CatpawModelResolution,
): string | undefined {
  const record = asRecord(body) ?? {}
  const candidates: unknown[] = [
    record.context_window,
    record.contextWindow,
    record.context_length,
    record.contextLength,
    readPath(record, ['model_params', 'context']),
    readPath(record, ['modelParams', 'context']),
    readPath(record, ['request_context', 'modelParams', 'declarativeParams', 'context']),
    readPath(record, ['requestContext', 'modelParams', 'declarativeParams', 'context']),
  ]
  const explicit = candidates.find((value) => {
    if (value === null || value === undefined) return false
    return String(value).trim().length > 0
  })

  const spec = model.spec
  const supported = spec?.contextOptions ?? []

  if (explicit === undefined) {
    // 没有显式值：用模型默认档位；模型不支持 context 时不发。
    if (supported.length === 0 || spec?.defaultContext === undefined) return undefined
    return String(spec.defaultContext)
  }

  const text = String(explicit).trim().toLowerCase()
  if (text.length === 0) return undefined
  const normalized = CONTEXT_ALIASES.get(text)
  if (normalized === undefined) {
    throw badRequest('context_window 仅支持 200K / 500K / 1M')
  }
  if (supported.length === 0) {
    throw badRequest(`模型 ${model.displayName} 不支持 context_window 参数`)
  }
  if (!supported.some((value) => String(value) === normalized)) {
    throw badRequest(`模型 ${model.displayName} 不支持请求的上下文长度`)
  }
  return normalized
}

/** 按路径读嵌套字段（任一层不是对象就返回 undefined）。 */
function readPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    const next = asRecord(current)
    if (next === undefined) return undefined
    current = next[key]
  }
  return current
}

// ─── 上游响应解包 ──────────────────────────────────────────────────

/** {@link unwrapCatpawApiData} 的结果。 */
export type CatpawUnwrapped =
  | { ok: true; data: unknown }
  | { ok: false; message: string; status: number; failCode?: number; unifyCode?: number }

/**
 * 上游响应解包（`unwrapApiData`）。
 *
 * ## 判定
 *
 * 1. `code` 是**数字**且 ∉ `{0, 200}` → 上游业务错误：
 *    - 文案取 `msg` → `message` → 兜底 `上游 API 返回错误 code=N`；
 *    - 状态码取 `httpStatus`（缺省 502，非法值钳到 502）；
 *    - `code` → `failCode`，`unifyCode` → `unifyCode`（进终态上报）。
 * 2. 否则若有 `data` **成员**则取出（**显式 null 也取** —— 那表示「没有数据」，
 *    与「响应里没有 data 字段」是两件事）。
 * 3. 其余原样返回。
 *
 * ⚠️ **`code` 非数字时按成功处理**：字符串 `"0"` 严格不等于数字 `0`，
 * 而把它判成错误会在上游给出畸形 `code` 时误报。极端情形下「尽力继续」比
 * 「误报上游错误」更不容易把正常流打断。
 */
export function unwrapCatpawApiData(payload: unknown): CatpawUnwrapped {
  const record = asRecord(payload)
  if (record === undefined) return { ok: true, data: payload }

  const code = record.code
  if (typeof code === 'number' && Number.isFinite(code) && code !== 0 && code !== 200) {
    const message = nonEmptyText(record.msg)
      ?? nonEmptyText(record.message)
      ?? `上游 API 返回错误 code=${code}`
    const rawStatus = record.httpStatus
    const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus)
      && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : 502
    const result: { ok: false; message: string; status: number; failCode?: number; unifyCode?: number } = {
      ok: false,
      message,
      status,
      failCode: code,
    }
    if (typeof record.unifyCode === 'number' && Number.isFinite(record.unifyCode)) {
      result.unifyCode = record.unifyCode
    }
    return result
  }

  if (hasOwn(record, 'data')) return { ok: true, data: record.data }
  return { ok: true, data: payload }
}
