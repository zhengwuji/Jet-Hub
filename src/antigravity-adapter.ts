/**
 * Antigravity (Google) LlmAdapter —— **路径 A：本机凭据复用**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 协议事实（全部来自本机实测，非推测）
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. **不是 OpenAI 兼容协议**
 *    Antigravity 的 agent 走 Google Cloud Code Private API（CCPA），基址
 *    `https://cloudcode-pa.googleapis.com`，路径形如 `/v1internal:xxx`。
 *    二进制中确认的服务包为
 *    `google.internal.cloud.code.v1internal.JetskiService`。
 *
 * 2. **凭据来源**
 *    从 Antigravity IDE 的 `state.vscdb` 读取 IDE 已登录的 OAuth token
 *    （见 antigravity.ts）。凭据是 Google 官方签发的、带
 *    `experimentsandconfigs` + `cloud-platform` scope 的 token。
 *
 * 3. **端点验证结果（本机实测）**
 *    - `POST /v1internal:loadCodeAssist` → HTTP 200，返回真实 tier：
 *      `allowedTiers: [{ id: "standard-tier", name: "Gemini Code Assist" }]`
 *    - `POST /v1internal:fetchAvailableModels` → HTTP 400（参数 schema 与
 *      预期不同，属正常校验拒绝，证明端点存在）
 *
 * ════════════════════════════════════════════════════════════════════════
 * 防封号约束（每条都对应代码中的强制措施）
 * ════════════════════════════════════════════════════════════════════════
 *
 * ① **单账号、无轮换**
 *    本适配器**不接收 accountPool**，也不进入 `ALL_PRODUCTS`。多账号池与
 *    限流自动切换是 CodeBuddy/WorkBuddy 侧的常规做法，套用到 Google 侧等同于
 *    账号滥用。这里永远只用 IDE 当前登录的那一个身份。
 *
 * ② **串行 + 最小间隔**
 *    所有出站请求经过 SerialGate：同一时刻最多一个在途请求，且两次请求之间
 *    至少间隔 MIN_REQUEST_GAP_MS。IDE 自身也是低频串行交互，插件不应比 IDE
 *    更高频。
 *
 * ③ **不伪造身份标识**
 *    不使用任何自定义 X-* 头、不伪装 UA 为别的客户端。仅发送 Google API
 *    自身所需的 Authorization 与 Content-Type —— 与 IDE 发出的请求同构。
 *    （对比：buddy-adapter 会 `headers.set('User-Agent', product.userAgent)`
 *    来伪装成 IDE 客户端，那是腾讯侧的需要；**这里绝不采用同样手法**。）
 *
 * ④ **续期交给 IDE**
 *    refresh 默认走仓库既有的凭据刷新链路；除非显式配置，不由适配器主动
 *    调用 refreshAntigravityToken。IDE 会自行续期并写回 state.vscdb，而
 *    readAntigravityCredential 每次重新读取，天然拿到最新 token。
 *
 * ⑤ **每次请求重新读取凭据**
 *    不长期缓存 token。IDE 刷新后立即生效，避免拿着过期 token 反复 401 ——
 *    密集的 401 重试本身就是异常流量特征。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  CLOUD_CODE_BASE,
  readAntigravityCredential,
  type AntigravityCredential,
} from './antigravity.js'
import { readWithIdleTimeout, resolveToolPairing } from './sse.js'

/** provider 路由名（注册到 ctx.llm）。 */
export const ANTIGRAVITY_PROVIDER = 'antigravity'

/** 设置页展示名。 */
export const ANTIGRAVITY_DISPLAY_NAME = 'Antigravity (Google)'

/** 展示用凭据 ref（本适配器实际不通过该 ref 存凭据，仅用于设置页标识）。 */
export const ANTIGRAVITY_CREDENTIAL_REF = 'ANTIGRAVITY_REUSE_IDE'

/**
 * 两次出站请求之间的最小间隔（毫秒）。
 *
 * 取 1000ms 的理由：IDE 与用户的交互本身是秒级节奏，插件以相同节奏发请求
 * 不会形成"比 IDE 更激进"的流量特征。**不要调低** —— 这是防封号的一道
 * 实质性闸门，而不是性能开关。
 */
export const MIN_REQUEST_GAP_MS = 1000

/**
 * 串行闸门：同一时刻最多一个在途请求，且请求之间强制最小间隔。
 *
 * 为什么需要它：并发请求是最容易被判定为自动化滥用的特征。IDE 自身不会
 * 并发调用 CCPA，插件也不应。所有出站请求（含模型列表拉取）都必须经过它。
 */
class SerialGate {
  private tail: Promise<unknown> = Promise.resolve()
  private lastStartedAt = 0

  constructor(private readonly minGapMs: number = MIN_REQUEST_GAP_MS) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.lastStartedAt)
      if (wait > 0) await sleep(wait)
      this.lastStartedAt = Date.now()
      return task()
    })
    // 前一个任务的失败不阻断后续任务，但要在链上消化掉，避免 unhandled rejection。
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}

/**
 * 等待指定毫秒。
 *
 * ⚠️ **这里刻意不使用 `.unref()`**，与仓库其他 sleep 实现不同。
 *
 * `.unref()` 的语义是「不要为了让该定时器触发而保持事件循环存活」。对后台
 * 调度器（如 RefreshScheduler）这是对的——进程该退出时就退出。但本函数服务于
 * **请求限速闸门**：限速窗口等待是请求能否发出的必要前置步骤，一旦定时器被
 * unref，且此刻进程内没有其他 pending 工作，Node 会直接退出/让 await 永久
 * 悬挂（实测表现：`for await` 静默卡死，既不抛错也不结束）。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Antigravity 可用模型目录（兜底）。
 *
 * 数据来源：`language_server.exe` 中出现的模型标识符。远端
 * `fetchAvailableModels` 可用时以其为准，此表仅在远端不可用时兜底。
 *
 * 注意：模型可用性取决于账号 tier（本机实测为 `standard-tier`）。列出的
 * 模型若因 tier 不足而不可用，服务端会明确拒绝，这是正常的权限响应。
 */
const FALLBACK_MODELS: readonly { id: string; name: string; contextWindow?: number }[] = [
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', contextWindow: 1_000_000 },
  { id: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash', contextWindow: 1_000_000 },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000 },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000 },
]

export interface AntigravityAdapterOptions {
  /**
   * 读取凭据。默认使用 readAntigravityCredential（直读 IDE 状态库）。
   * 注入点主要用于测试。
   */
  readCredential?: () => AntigravityCredential | undefined
  /**
   * 可选的显式续期实现。
   *
   * **默认不提供**：正常路径应让 IDE 自己续期（见文件头约束 ④）。
   * 仅在 IDE 长期未运行、库中 token 明确失效时才需要配置。
   * 提供时它接收当前 refresh_token 并返回新的 access_token。
   */
  refresh?: (refreshToken: string) => Promise<string>
  fetchImpl?: typeof fetch
  /** 跳过向 ctx.llm 注册 configurableProviders（由 index.ts 统一管理）。 */
  skipConfigurableRegistration?: boolean
}

/** 从错误体提取可读信息。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as {
      error?: { message?: string; status?: string; code?: number }
      message?: string
    }
    const parts = [
      data.error?.status,
      data.error?.message,
      data.message,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body.slice(0, 400)
}

/** HTTP 状态码 → harness 错误码。 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 把 Google 端的拒绝原因翻译成用户可执行的中文提示。
 *
 * 为什么需要这一层：Antigravity 的账号状态与 IDE 可用性**不是一回事**。
 * 实测（本机，2026-09）IDE 自身 agent 可正常对话（走本地 language_server
 * 私有通道），但同一份凭据调用**公共 Cloud Code API** 会被三种彼此无关的
 * 原因拒绝。若只抛原始英文 JSON，用户会误以为是插件坏了。
 *
 * 三种拒绝原因（均已实测确认，附原始错误特征）：
 *
 * 1. `SUBSCRIPTION_REQUIRED`（403）
 *    该账号没有 Gemini Code Assist 订阅。最典型的形态：`loadCodeAssist`
 *    返回 200，但 `ineligibleTiers[].reasonCode = UNSUPPORTED_CLIENT`，
 *    且 `generateContent` 全部 403。
 * 2. `RESOURCE_PROJECT_INVALID`（400）
 *    端点可达但缺少 GCP project。日志证据：language_server 反复报
 *    `missing project file: C:/Users/<u>/.gemini/config/projects/.json`。
 * 3. `ACCESS_TOKEN_SCOPE_INSUFFICIENT`（403）
 *    凭据 scope 不含该 API 所需项（该 token 只有 cloud-platform /
 *    experimentsandconfigs / cclog / userinfo.*）。
 *
 * 三种情况都**不是**本插件的实现缺陷，而是账号侧未开通对应公共 API。
 * 因此提示一律指向"账号授权"而非"重新登录插件"。
 */
function diagnoseRejection(status: number, body: string): string | undefined {
  const probes: Array<[RegExp, string]> = [
    [
      /SUBSCRIPTION_REQUIRED/,
      '该 Google 账号没有 Gemini Code Assist 订阅，公共 Cloud Code API 拒绝提供服务'
        + '（reason=SUBSCRIPTION_REQUIRED）。注意：Antigravity IDE 自身仍然可用——'
        + '它走本地 language_server 私有通道，与这条公共 API 是不同的授权体系。'
        + '如需经本插件调用，请确认该账号已开通对应订阅，或改用 AiStudio/Vertex 等有授权的渠道。',
    ],
    [
      /RESOURCE_PROJECT_INVALID/,
      '请求缺少可用的 GCP project（reason=RESOURCE_PROJECT_INVALID）。'
        + 'Antigravity 从 ~/.gemini/config/projects/ 读取项目配置，本机该目录不存在。'
        + '请在 Antigravity IDE 内完成首次项目初始化后重试。',
    ],
    [
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT/,
      '凭据 scope 不足（reason=ACCESS_TOKEN_SCOPE_INSUFFICIENT）。'
        + 'IDE 登录态持有的 scope 不包含该公共 API 所需项。',
    ],
    [
      /UNSUPPORTED_CLIENT/,
      '服务端判定当前客户端不受支持（reasonCode=UNSUPPORTED_CLIENT）：'
        + 'Gemini Code Assist 个人免费层已停用，官方要求迁移到 Antigravity 产品线。',
    ],
  ]
  for (const [pattern, message] of probes) {
    if (pattern.test(body)) return message
  }
  if (status === 403) {
    return '凭据被 Google 拒绝（HTTP 403），但未匹配到已知原因码。请打开 Antigravity IDE 确认登录状态。'
  }
  return undefined
}

/** 传输级错误判定（与 buddy-adapter 一致）。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/** 将消息内容块展平为纯文本。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/** SSE 读超时（毫秒），可由环境变量覆盖以便测试。 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_ANTIGRAVITY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_ANTIGRAVITY_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 把 harness 消息序列化为 CCPA 的 `contents` 结构。
 *
 * CCPA 沿用 Gemini 的 `contents` / `parts` 词汇（role 为 `user` / `model`），
 * 而非 OpenAI 的 `messages`。这里做形态转换：
 * - assistant → role: 'model'
 * - user / tool-result → role: 'user'（工具结果转为 functionResponse part）
 * - system 单独走 `systemInstruction`（不混入 contents）
 *
 * 孤儿工具调用同样会被剔除（复用 sse.ts 的 resolveToolPairing），理由与
 * buddy-adapter 相同：无法配对的 tool_call 会让后端持续 400，整条会话报废。
 */
function serializeContents(
  messages: readonly { role: string; content: unknown }[],
): Array<Record<string, unknown>> {
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)
  const contents: Array<Record<string, unknown>> = []

  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = []
      const text = contentToText(message.content)
      if (text.length > 0) parts.push({ text })
      for (const block of blocks) {
        if (typeof block !== 'object' || block === null) continue
        const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
        if (b.type !== 'tool-call') continue
        if (!keepCallIds.has(String(b.id))) continue
        let args: unknown = {}
        try {
          args = JSON.parse(String(b.arguments ?? '{}'))
        } catch {
          // 参数残缺：给空对象，避免整个请求因解析失败而 400
        }
        parts.push({ functionCall: { name: String(b.name), args } })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    if (message.role === 'system') {
      // system 由调用方汇总进 systemInstruction，此处跳过。
      continue
    }

    // user 角色：正文 + 工具结果
    const parts: Array<Record<string, unknown>> = []
    const text = contentToText(message.content)
    if (text.length > 0) parts.push({ text })
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as { type?: unknown; toolCallId?: unknown; name?: unknown; content?: unknown }
      if (b.type !== 'tool-result') continue
      if (!keepResultIds.has(String(b.toolCallId))) continue
      const output = contentToText(b.content) || '(no output)'
      parts.push({ functionResponse: { name: String(b.name ?? 'tool'), response: { output } } })
    }
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  return contents
}

/** 汇总全部 system 消息为单一 systemInstruction。 */
function collectSystem(messages: readonly { role: string; content: unknown }[], extra?: string): string {
  const chunks: string[] = []
  if (extra !== undefined && extra.length > 0) chunks.push(extra)
  for (const message of messages) {
    if (message.role !== 'system') continue
    const text = contentToText(message.content)
    if (text.length > 0) chunks.push(text)
  }
  return chunks.join('\n\n')
}

/**
 * Antigravity (Google) 模型适配器。
 *
 * 凭据来自本机 IDE 的只读复用，请求发往 Google Cloud Code 官方端点。
 */
export class AntigravityAdapter extends LlmAdapter {
  private readonly gate = new SerialGate()
  private readonly fetchImpl: typeof fetch
  private readonly readCredential: () => AntigravityCredential | undefined
  private readonly refreshImpl: ((refreshToken: string) => Promise<string>) | undefined
  /** 远端模型缓存（成功拉取一次后填充）。 */
  private remoteModels: readonly LlmModelInfo[] | undefined
  /** 最近一次成功续期得到的 token（仅在配置了 refresh 时使用）。 */
  private refreshedToken: { token: string; obtainedAt: number } | undefined

  constructor(private readonly options: AntigravityAdapterOptions = {}) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readCredential = options.readCredential ?? readAntigravityCredential
    this.refreshImpl = options.refresh
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : ANTIGRAVITY_PROVIDER
    return { id, name: ANTIGRAVITY_DISPLAY_NAME }
  }

  /**
   * 取得当前可用的 access token。
   *
   * 优先使用刚续期得到的 token（仅在配置了 refresh 且尚未过期时），否则
   * **重新读取 IDE 状态库** —— 见文件头约束 ⑤：不长期缓存，IDE 续期后立即生效。
   */
  private async resolveAccessToken(): Promise<string> {
    // 显式续期得到且未超过 55 分钟的 token 优先复用（有效期 3599s，留足余量）
    if (this.refreshedToken !== undefined) {
      const age = Date.now() - this.refreshedToken.obtainedAt
      if (age < 55 * 60 * 1000) return this.refreshedToken.token
    }
    const credential = this.readCredential()
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError(
        'antigravity: 未找到本机 Antigravity 登录凭据。请先打开 Antigravity IDE 并完成 Google 账号登录，'
        + '然后重试（插件复用 IDE 的凭据，不提供独立登录）。',
        'MISSING_CREDENTIAL',
      )
    }
    return credential.access_token
  }

  /**
   * 401 时的显式续期。
   *
   * 默认不配置 refresh 实现：此时直接抛错并提示用户在 IDE 中重新登录，
   * 而不是由插件主动换 token（见文件头约束 ④）。
   */
  private async tryRefresh(): Promise<boolean> {
    if (this.refreshImpl === undefined) return false
    const credential = this.readCredential()
    if (credential === undefined || credential.refresh_token.length === 0) return false
    const token = await this.refreshImpl(credential.refresh_token)
    this.refreshedToken = { token, obtainedAt: Date.now() }
    return true
  }

  /** 发一次 CCPA 请求（经串行闸门）。 */
  private async call(
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    accessToken: string,
  ): Promise<Response> {
    return this.gate.run(async () => {
      const headers = new Headers(attributionHeaders())
      headers.set('Authorization', `Bearer ${accessToken}`)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', 'text/event-stream')
      // 注意：此处**不设置** User-Agent 伪装、不设置任何自定义 X-* 头。
      // 见文件头防封号约束 ③。
      try {
        return await this.fetchImpl(`${CLOUD_CODE_BASE}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          ...signal !== undefined ? { signal } : {},
        })
      } catch (error) {
        if (signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `antigravity: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    })
  }

  /**
   * 拉取远端可用模型。
   *
   * 实测该端点的请求 schema 与最初的猜测不同（返回 400 Unknown name），
   * 故这里**失败即回退到内置目录**，不把探测失败暴露为错误 —— 模型列表
   * 是 advisory 的，缺失不应影响对话。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined) return
    try {
      const accessToken = await this.resolveAccessToken()
      const response = await this.call('/v1internal:fetchAvailableModels', {}, undefined, accessToken)
      if (!response.ok) return
      const body = await response.json() as { models?: unknown }
      const models: LlmModelInfo[] = []
      if (Array.isArray(body.models)) {
        for (const entry of body.models) {
          if (typeof entry !== 'object' || entry === null) continue
          const record = entry as Record<string, unknown>
          const id = typeof record.id === 'string' ? record.id : undefined
          if (id === undefined || id.length === 0) continue
          models.push({
            provider: ANTIGRAVITY_PROVIDER,
            id,
            name: typeof record.displayName === 'string' && record.displayName.length > 0
              ? record.displayName
              : id,
            inputModalities: ['text', 'image'],
          })
        }
      }
      if (models.length > 0) this.remoteModels = models
    } catch {
      // 远端不可用：保持 undefined，调用方回退内置目录
    }
  }

  /**
   * 探测该账号是否被授予公共 Cloud Code API 的调用权限。
   *
   * 用途：**自适应通道选择**。当 IDE 未运行、插件需要决定能否退回公共 API 时，
   * 用它来判断——而不是靠硬编码的「本机实测 403」结论。
   *
   * 判据是 `loadCodeAssist`：
   * - **200** → 凭据认证通过且账号在 Code Assist 体系内 → 通道可用
   * - **401** → 凭据本身失效（IDE 里的 token 过期，需要打开 IDE 让它续期）
   * - **403** → 账号无对应订阅（`SUBSCRIPTION_REQUIRED` 等）
   *
   * ⚠️ **只探认证，不发推理请求** —— 探测不应该消耗任何配额。
   * ⚠️ 结果**不做长期缓存**：token 会过期、订阅会开通，必须每次实测。
   */
  async probeAccess(): Promise<{ available: boolean; reason?: string }> {
    let accessToken: string
    try {
      accessToken = await this.resolveAccessToken()
    } catch (error) {
      return {
        available: false,
        reason: `读不到本机 IDE 凭据：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    let response: Response
    try {
      response = await this.call(
        '/v1internal:loadCodeAssist',
        {
          metadata: {
            ideType: 'ANTIGRAVITY',
            platform: 'WINDOWS_AMD64',
            pluginVersion: '1.0.0',
          },
        },
        undefined,
        accessToken,
      )
    } catch (error) {
      return {
        available: false,
        reason: `公共 API 不可达：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (response.ok) return { available: true }

    // 一次性读取响应体：**不要用 response.clone()**（见文件头说明）。
    const detail = await response.text().catch(() => '')
    if (response.status === 401) {
      return {
        available: false,
        reason: 'IDE 中的 OAuth 凭据已失效（HTTP 401）。请在 Antigravity IDE 中重新登录，'
          + '或直接打开 IDE —— 插件走本地私有通道时不需要这份凭据。',
      }
    }
    if (response.status === 403) {
      const diagnosis = diagnoseRejection(response.status, detail)
      return {
        available: false,
        reason: diagnosis
          ?? `账号未被授予公共 Cloud Code API 权限（HTTP 403）。${errorDetail(detail)}`,
      }
    }
    return {
      available: false,
      reason: `公共 API 返回 HTTP ${response.status}：${errorDetail(detail)}`,
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? FALLBACK_MODELS.map((model) => ({
      provider: ANTIGRAVITY_PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'] as const,
    }))
    return source
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const fallback = FALLBACK_MODELS.find((entry) => entry.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: fallback?.name ?? model,
      inputModalities: ['text', 'image'],
    }
    const contextWindow = fallback?.contextWindow
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // Antigravity 的思考强度由模型自身决定，未在协议中暴露可枚举等级，
    // 故不声明 reasoning —— UI 会显示"当前模型未提供推理等级"。
    return resolved
  }

  /** 与 buddy-adapter 同款 shim：绑定模型解析与分发到同一实例。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let accessToken = await this.resolveAccessToken()

    const contents = serializeContents(options.messages)
    const systemInstruction = collectSystem(options.messages, options.system)

    const payload: Record<string, unknown> = {
      model: options.model,
      request: {
        contents,
        ...systemInstruction.length > 0 ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {},
        ...options.temperature !== undefined
          ? { generationConfig: { temperature: options.temperature } }
          : {},
      },
    }

    let response = await this.call('/v1internal:generateContent', payload, options.signal, accessToken)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      // 一次性读取响应体：**不要用 response.clone()**。
      // clone() 会让原 response 的 body 进入「被派生」状态，之后任何读取
      // 都可能永久挂起（实测：会静默卡在 for-await 上，既不抛错也不结束）。
      const firstDetail = await response.text().catch(() => '')
      const earlyDiagnosis = diagnoseRejection(response.status, firstDetail)

      // 403 且已能判定原因（订阅/项目/scope）→ 属于账号授权问题，续期无用，
      // 直接给出诊断，避免多打一次 token 请求。
      if (response.status === 403 && earlyDiagnosis !== undefined) {
        throw new LlmError(`antigravity: ${earlyDiagnosis}`, 'AUTH', { status: response.status })
      }

      const refreshed = await this.tryRefresh()
      if (!refreshed) {
        throw new LlmError(
          `antigravity: 凭据被拒绝（HTTP ${response.status}）。`
          + `${earlyDiagnosis ?? ''}`
          + '请打开 Antigravity IDE 确认仍在登录状态，插件会自动复用其最新凭据。'
          + `${errorDetail(firstDetail)}`,
          'AUTH',
          { status: response.status },
        )
      }
      accessToken = await this.resolveAccessToken()
      response = await this.call('/v1internal:generateContent', payload, options.signal, accessToken)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // 优先给出可执行的中文诊断；未命中已知原因时回退到原始错误体。
      const diagnosis = diagnoseRejection(response.status, detail)
      throw new LlmError(
        `antigravity: ${diagnosis ?? errorDetail(detail)}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    yield* this.consumeSse(response, options)
  }

  /**
   * 消费 CCPA 的 SSE 响应。
   *
   * CCPA 的流式响应是 Gemini 风格而非 OpenAI 风格：
   * 事件体形如 `{"candidates":[{"content":{"parts":[{"text":"..."}],"role":"model"}}]}`
   * 工具调用以 `functionCall` part 形式出现（**完整给出 args，不分片**），
   * 这与 OpenAI 逐字符分片拼 JSON 的方式不同，因此无需参数拼接与截断修复。
   */
  private async *consumeSse(response: Response, options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('antigravity: empty model response body', 'EMPTY_RESPONSE')

    let buffer = ''
    let streamEnded = false
    let firstTokenReceived = false
    let nextIndex = 0
    let textBlockIndex: number | undefined
    let text = ''
    let sawToolCall = false

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'antigravity', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(
              `antigravity: sse transport error: ${error instanceof Error ? error.message : String(error)}`,
              'TRANSPORT',
              { cause: error as Error },
            )
          }
          throw error
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })

        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { streamEnded = true; break }

          let data: {
            error?: { message?: string }
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> }
            }>
            usageMetadata?: {
              promptTokenCount?: number
              candidatesTokenCount?: number
              cachedContentTokenCount?: number
              thoughtsTokenCount?: number
            }
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          if (data.error !== undefined) {
            throw new LlmError(`antigravity: ${data.error.message ?? 'unknown error'}`, 'SERVER')
          }

          const parts = data.candidates?.[0]?.content?.parts ?? []
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              if (textBlockIndex === undefined) {
                textBlockIndex = nextIndex++
                yield { type: 'block-start', index: textBlockIndex, blockType: 'text' }
              }
              text += part.text
              yield { type: 'text-delta', index: textBlockIndex, text: part.text }
            }
            if (part.functionCall !== undefined) {
              sawToolCall = true
              const index = nextIndex++
              const id = `call_${index}`
              const argsJson = JSON.stringify(part.functionCall.args ?? {})
              yield { type: 'block-start', index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index,
                id: ToolCallId(id),
                name: part.functionCall.name ?? '',
                argumentsDelta: argsJson,
              }
              yield {
                type: 'block-end',
                index,
                block: {
                  type: 'tool-call',
                  id: ToolCallId(id),
                  name: part.functionCall.name ?? '',
                  arguments: argsJson,
                },
              }
            }
          }

          if (data.usageMetadata !== undefined) {
            const cached = data.usageMetadata.cachedContentTokenCount ?? 0
            const prompt = data.usageMetadata.promptTokenCount ?? 0
            yield {
              type: 'usage',
              usage: {
                inputTokens: cached > 0 ? Math.max(prompt - cached, 0) : prompt,
                outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
                ...cached > 0 ? { cacheReadTokens: cached } : {},
                ...(data.usageMetadata.thoughtsTokenCount ?? 0) > 0
                  ? { reasoningTokens: data.usageMetadata.thoughtsTokenCount as number }
                  : {},
              },
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (textBlockIndex !== undefined) {
      yield { type: 'block-end', index: textBlockIndex, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
}

/**
 * 在 ctx.llm 上注册 Antigravity provider 路由。
 *
 * **不注册 configurableProviders 之外的任何账号池相关能力** —— 见文件头
 * 防封号约束 ①。settingsNs 必须与 index.ts 的 registerProviderSettings 保持
 * 一致，否则模型设置页会因未注册 namespace 崩溃。
 */
export function registerAntigravityLlm(ctx: Context, options: AntigravityAdapterOptions = {}): void {
  if (!options.skipConfigurableRegistration) {
    ctx.llm.registerConfigurableProviders([
      {
        provider: ANTIGRAVITY_PROVIDER,
        displayName: ANTIGRAVITY_DISPLAY_NAME,
        settingsNs: `llm-${ANTIGRAVITY_PROVIDER}`,
        settingsPath: [],
      },
    ])
  }
  ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], new AntigravityAdapter(options))
}

/** 供 index.ts 使用：本 provider 使用的凭据 ref（仅用于设置页展示）。 */
export function antigravityCredentialRef(): CredentialRef {
  return ANTIGRAVITY_CREDENTIAL_REF as CredentialRef
}
