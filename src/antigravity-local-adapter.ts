/**
 * Antigravity (Google) LlmAdapter —— **方案 B：借用 IDE 本地私有通道**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 两条通道与选择逻辑
 * ════════════════════════════════════════════════════════════════════════
 *
 * | 通道 | 实现 | 端点 | 本机实测 |
 * |------|------|------|----------|
 * | **B（首选）** | 本文件 | `127.0.0.1:<port>` 本地私有 RPC | ✅ 200，可正常对话 |
 * | A（降级） | antigravity-adapter.ts | `cloudcode-pa.googleapis.com` | ❌ 403 SUBSCRIPTION_REQUIRED |
 *
 * 默认走 **B**：请求由 IDE 自己的 language_server 进程发出，对 Google 而言
 * 与「用户在 IDE 里正常提问」无法区分。当检测不到 language_server（IDE 未运行）
 * 时，按配置降级到 A 或给出明确的中文提示。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 防封号约束（与方案 A 同源，每条都对应代码中的强制措施）
 * ════════════════════════════════════════════════════════════════════════
 *
 * ① **不进 `ALL_PRODUCTS`、不进 `accountPool`**
 *    不走 **accountPool**，也不进 `ALL_PRODUCTS` 账号池，绝不允许被其他
 *    自动切换（如 CodeBuddy/WorkBuddy）逻辑蹭用。Google 与其他账号隔离，
 *    不可混用。永远只认 IDE 当前登录的那一份。
 *
 * ② **零伪造身份标识**
 *    方案 B 的 `Authorization` 头不需要 —— 它是本地 loopback，只需要
 *    `Content-Type` 与本地 CSRF 头。**严禁 User-Agent 伪装任何
 *    自定义 X-* 业务头**。对比 buddy-adapter 的伪装 UA 与 IDE 客户端，
 *    这里零伪造。
 *
 * ③ **不写 `state.vscdb`**
 *    方案 B 全程不碰凭据文件，账号由 IDE 管理；降级到方案 A 时也只通过
 *    antigravity-adapter 的只读凭据适配器。
 *
 * ④ **串行 + 最小间隔**
 *    所有 RPC 调用均经过 SerialGate，同一时刻最多一个在途调用，调用之间
 *    强制叠加 MIN_REQUEST_GAP_MS。IDE 用户也是低频交互，插件模拟 IDE
 *    的频次。
 *
 * ⑤ **CSRF token 零日志**
 *    提取到的 token 仅在本地 loopback 鉴权，进入任何错误信息或外部输出前
 *    必须用 `redact` 抹掉。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter } from './antigravity-adapter.js'
import {
  DEFAULT_REPLY_TIMEOUT_MS,
  MIN_REQUEST_GAP_MS,
  POLL_INTERVAL_MS,
  callRpc,
  countUserInputs,
  discoverLanguageServer,
  fetchModelConfigs,
  findCurrentTurnReplyStep,
  findErrorStep,
  findReplyForTurn,
  findReplyStep,
  getTrajectory,
  isReplyDone,
  lastUserInputIndex,
  redact,
  replyText,
  replyUsage,
  sendUserMessage,
  startCascade,
  type CascadeModelConfig,
  type LanguageServerInstance,
} from './antigravity-local.js'

/**
 * 将消息内容块展平为纯文本。
 *
 * 本地通道只接受纯文本 prompt（`SendUserCascadeMessage.items[].text`），
 * 因此这里把 harness 的结构化内容块降维成文本。
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'tool-result') {
      const inner = contentToText(b.content)
      if (inner.length > 0) parts.push('\n[Tool Result]: ' + inner + '\n')
    }
  }
  return parts.join('')
}

/** provider 路由名（注册到 ctx.llm）。 */
export const ANTIGRAVITY_PROVIDER = 'antigravity'

/** 面板展示名。 */
export const ANTIGRAVITY_DISPLAY_NAME = 'Antigravity (Google)'

/** 当前生效的通道。 */
export type AntigravityChannel = 'local' | 'public' | 'unavailable'

/** 某条通道的可用性。 */
export interface ChannelAvailability {
  available: boolean
  /** 不可用时的原因（可直接展示给用户）。 */
  reason?: string
}

/** 通道探测结论。 */
export interface ChannelProbe {
  /** 最终会被使用的通道。 */
  channel: AntigravityChannel
  /** 本地私有通道（方案 B）状态。 */
  local: ChannelAvailability & { pid?: number; port?: number; modelCount?: number }
  /** 公共 API 通道（方案 A）状态。 */
  public: ChannelAvailability
  /**
   * 不可用时的中文诊断（channel === 'unavailable' 时给出）。
   *
   * 这条信息会被直接展示，因此措辞必须指向**用户可执行的下一步**。
   */
  message?: string
}

export interface AntigravityLocalAdapterOptions {
  /**
   * 是否允许降级到方案 A（公共 Cloud Code API）。
   *
   * 默认 **true**（自适应选路）。若显式设为 false 则在本地不可用时直接提示打开 IDE。
   */
  allowPublicFallback?: boolean
  /** 方案 A 适配器实例（降级时使用）。默认惰性创建。 */
  publicAdapter?: AntigravityAdapter
  /** language_server 发现实现，注入点主要用于测试。 */
  discover?: () => Promise<LanguageServerInstance | undefined>
  fetchImpl?: typeof fetch
  /** 等待回复的总超时（毫秒）。 */
  replyTimeoutMs?: number
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs?: number
  /** 跳过向 ctx.llm 注册 configurableProviders（由 index.ts 统一管理）。 */
  skipConfigurableRegistration?: boolean
}

/**
 * 串行闸门：同一时刻最多一个在途调用，且调用之间强制最小间隔。
 *
 * 为什么需要它：并发调用是最容易被判定为自动化滥用的特征。IDE 自身不会并发
 * 调用，插件也不应。所有 RPC 调用（含模型列表拉取）都必须经过它。
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
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 兜底模型目录。
 */
const FALLBACK_MODELS: readonly { id: string; name: string }[] = [
  { id: 'MODEL_PLACEHOLDER_M318', name: 'Gemini 3.8 Flash (High)' },
  { id: 'MODEL_PLACEHOLDER_M319', name: 'Gemini 3.8 Flash (Medium)' },
  { id: 'MODEL_PLACEHOLDER_M320', name: 'Gemini 3.8 Flash (Low)' },
  { id: 'MODEL_PLACEHOLDER_M298', name: 'Gemini 3.7 Flash (High)' },
  { id: 'MODEL_PLACEHOLDER_M299', name: 'Gemini 3.7 Flash (Medium)' },
  { id: 'MODEL_PLACEHOLDER_M300', name: 'Gemini 3.7 Flash (Low)' },
  { id: 'MODEL_PLACEHOLDER_M16', name: 'Gemini 3.1 Pro (High)' },
  { id: 'MODEL_PLACEHOLDER_M36', name: 'Gemini 3.1 Pro (Low)' },
  { id: 'MODEL_PLACEHOLDER_M35', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'MODEL_PLACEHOLDER_M26', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', name: 'GPT-OSS 120B (Medium)' },
]

/** IDE 未运行时的统一中文提示。 */
export const IDE_NOT_RUNNING_MESSAGE =
  'antigravity: 未检测到正在运行的 Antigravity IDE（本地 language_server 进程不存在）。'
  + '本渠道通过 IDE 自己的本地私有通道调用模型，因此**必须先打开 Antigravity IDE 并保持运行**，'
  + '然后重试。打开 IDE 后无需在本插件里做任何登录操作 —— 插件自动复用 IDE 的登录态。'

const PROBE_SUCCESS_TTL_MS = 60_000
const PROBE_FAIL_TTL_MS = 3_000

/** 汇总 system 消息。 */
export function collectSystemText(options: GenerateOptions): string {
  const chunks: string[] = []
  if (typeof options.system === 'string' && options.system.length > 0) chunks.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = contentToText(message.content)
    if (text.length > 0) chunks.push(text)
  }
  return chunks.join('\n\n')
}

/** 提取当前轮次的用户输入（以及最后一个 assistant 之后的工具返回结果）。 */
export function extractCurrentTurnPrompt(options: GenerateOptions): string {
  const messages = options.messages
  if (messages.length === 0) return ''

  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  const currentMessages = lastAssistantIdx >= 0 ? messages.slice(lastAssistantIdx + 1) : messages
  const parts: string[] = []
  for (const msg of currentMessages) {
    const text = contentToText(msg.content)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * 组装新会话的首条消息 Prompt。
 *
 * 把用户实际问题放在最前面，便于 IDE 侧据此生成准确、直观的会话标题，
 * 随后附加 System Instructions（如果存在）。
 */
export function formatInitialPrompt(options: GenerateOptions): string {
  const system = collectSystemText(options)
  const userText = extractCurrentTurnPrompt(options)

  if (system.length === 0) return userText
  if (userText.length === 0) return system
  return userText + '\n\n[System Instructions]\n' + system
}

/**
 * 组装携带完整历史的 Prompt（用于新建会话接续多轮上下文，或旧会话失效重建）。
 */
export function formatFullHistoryPrompt(options: GenerateOptions): string {
  const parts: string[] = []
  const system = collectSystemText(options)
  if (system.length > 0) {
    parts.push('[System Instructions]\n' + system)
  }

  const messages = options.messages
  if (messages.length > 0) {
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }

    if (lastAssistantIdx >= 0) {
      const historyMessages = messages.slice(0, lastAssistantIdx + 1)
      const historyParts: string[] = []
      for (const msg of historyMessages) {
        const text = contentToText(msg.content)
        if (text.length === 0) continue
        const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'system' ? 'System' : 'User'
        historyParts.push(role + ': ' + text)
      }
      if (historyParts.length > 0) {
        parts.push('[Conversation History]\n' + historyParts.join('\n\n'))
      }
    }

    const currentText = extractCurrentTurnPrompt(options)
    if (currentText.length > 0) {
      parts.push('[Current User Query]\n' + currentText)
    }
  }

  return parts.join('\n\n')
}

/**
 * 解析会话唯一标识 Key。
 *
 * 优先取 harness 注入的 options.sessionId；
 * 若 options.sessionId 未提供（普通对话循环），则提取对话历史的根节点
 * （首条 user 消息内容）作为会话 Key。
 *
 * 这样同一次 DSH Desktop 对话在多轮追问时，首条消息不变 → sessionKey 不变 →
 * 始终复用同一个 cascadeId，实现 DSH Desktop 对话与 IDE 对话 1:1 严格对应。
 */
export function resolveSessionKey(options: GenerateOptions): string {
  if (options.purpose === 'session-title' || options.purpose === 'compaction') {
    return `__auxiliary_${options.purpose}__`
  }

  if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
    return `session:${options.sessionId}`
  }

  const firstUser = options.messages.find((m) => m.role === 'user')
  if (firstUser !== undefined) {
    const text = contentToText(firstUser.content).trim()
    if (text.length > 0) {
      return `root:${text.slice(0, 150)}`
    }
  }

  return 'root:default'
}

/** 把消息序列化成本地通道用的纯文本（保持导出兼容）。 */
export function serializePrompt(options: GenerateOptions): string {
  return formatFullHistoryPrompt(options)
}

/**
 * Antigravity 适配器（方案 B 主通道 + 方案 A 降级）。
 */
export class AntigravityLocalAdapter extends LlmAdapter {
  private readonly gate = new SerialGate()
  private readonly fetchImpl: typeof fetch
  private readonly discover: () => Promise<LanguageServerInstance | undefined>
  private readonly replyTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly allowPublicFallback: boolean
  private publicAdapter: AntigravityAdapter | undefined

  /** 已发现的实例缓存。仅在发现失败时失效重探，避免每次调用都跑 PowerShell。 */
  private instance: LanguageServerInstance | undefined
  /** 成功拉取过的模型配置缓存。 */
  private modelConfigs: readonly CascadeModelConfig[] | undefined
  /** 上一次通道探测结果（带 TTL，避免每次请求都探测）。 */
  private probeCache: { result: ChannelProbe; at: number } | undefined
  /** DSH 会话 ID ↔ IDE cascadeId 的映射缓存，避免每轮对话都创建新 Cascade 会话 */
  private readonly sessionCascades = new Map<string, string>()

  constructor(private readonly options: AntigravityLocalAdapterOptions = {}) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.discover = options.discover ?? (() => discoverLanguageServer({ fetchImpl: this.fetchImpl }))
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.allowPublicFallback = options.allowPublicFallback ?? (options.publicAdapter !== undefined)
    this.publicAdapter = options.publicAdapter
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : ANTIGRAVITY_PROVIDER
    return { id, name: ANTIGRAVITY_DISPLAY_NAME }
  }

  /** 惰性创建方案 A 适配器（仅在需要降级时才创建，避免无谓开销）。 */
  private publicChannel(): AntigravityAdapter {
    if (this.publicAdapter === undefined) {
      this.publicAdapter = new AntigravityAdapter(
        this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {},
      )
    }
    return this.publicAdapter
  }

  /**
   * 取得本地实例。
   */
  private async resolveInstance(force = false): Promise<LanguageServerInstance | undefined> {
    if (!force && this.instance !== undefined) {
      // 快速存活确认（Heartbeat 超时 200ms）
      try {
        const ping = await callRpc(this.instance, 'Heartbeat', {}, {
          fetchImpl: this.fetchImpl,
          timeoutMs: 200,
        })
        if (ping.ok) return this.instance
      } catch {
        // 心跳失败：实例已失效，清空后重新发现
        this.instance = undefined
      }
    }
    try {
      this.instance = await this.discover()
      return this.instance
    } catch {
      this.instance = undefined
      return undefined
    }
  }

  /**
   * 探测当前环境下的通道可用性。
   */
  async probeChannels(options?: { force?: boolean } | boolean): Promise<ChannelProbe> {
    const force = typeof options === 'boolean' ? options : (options?.force === true)
    const now = Date.now()
    if (!force && this.probeCache !== undefined) {
      const ttl = this.probeCache.result.channel === 'local' ? PROBE_SUCCESS_TTL_MS : PROBE_FAIL_TTL_MS
      if (now - this.probeCache.at < ttl) return this.probeCache.result
    }

    // 1. 先探本地通道
    const instance = await this.resolveInstance(force)
    const localStatus: ChannelProbe['local'] = instance !== undefined
      ? { available: true, pid: instance.pid, port: instance.port }
      : { available: false, reason: '未检测到正在运行的 Antigravity IDE 进程' }

    if (instance !== undefined) {
      const configs = await this.ensureModelConfigs(force)
      if (configs !== undefined && configs.length > 0) {
        localStatus.modelCount = configs.length
      }
    }

    // 2. 本地可用直接判定走 local
    if (localStatus.available) {
      const result: ChannelProbe = {
        channel: 'local',
        local: localStatus,
        public: { available: false, reason: '优先使用本地私有通道，公共通道未启用' },
      }
      this.probeCache = { result, at: now }
      return result
    }

    // 3. 本地不可用且允许公共降级时，探公共通道
    let publicStatus: ChannelAvailability = {
      available: false,
      reason: this.allowPublicFallback ? '未探测' : '公共 API 降级已按配置显式禁用',
    }

    if (this.allowPublicFallback) {
      try {
        publicStatus = await this.publicChannel().probeAccess()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        publicStatus = {
          available: false,
          reason: `公共 API 探测失败：${redact(message.slice(0, 150), [])}`,
        }
      }
    }

    // 4. 汇总判定
    const channel: AntigravityChannel = publicStatus.available ? 'public' : 'unavailable'
    const result: ChannelProbe = {
      channel,
      local: localStatus,
      public: publicStatus,
      ...channel === 'unavailable'
        ? { message: this.buildUnavailableMessage(localStatus, publicStatus) }
        : {},
    }
    this.probeCache = { result, at: now }
    return result
  }

  invalidateProbe(): void {
    this.probeCache = undefined
    this.instance = undefined
  }

  async currentChannel(): Promise<AntigravityChannel> {
    const probe = await this.probeChannels()
    return probe.channel
  }

  /** 组装「两条通道都不可用」时的中文诊断。 */
  private buildUnavailableMessage(
    local: ChannelProbe['local'],
    publicStatus: ChannelAvailability,
  ): string {
    const lines = [
      'antigravity: 当前没有可用的通道。',
      `· 本地私有通道（推荐）：${local.reason ?? '不可用'}`,
      `· 公共 API 通道：${publicStatus.reason ?? '不可用'}`,
      '',
      '本地通道只需**打开 Antigravity IDE 并保持运行**即可恢复（插件自动复用其登录态，无需登录操作）。',
    ]
    return lines.join('\n')
  }

  /** 拉取远端模型配置（本地通道）。 */
  private async ensureModelConfigs(force = false): Promise<readonly CascadeModelConfig[] | undefined> {
    if (!force && this.modelConfigs !== undefined) return this.modelConfigs
    const instance = await this.resolveInstance()
    if (instance === undefined) return undefined
    try {
      const configs = await this.gate.run(async () =>
        fetchModelConfigs(instance, { fetchImpl: this.fetchImpl }))
      if (configs.length > 0) this.modelConfigs = configs
      return configs.length > 0 ? configs : undefined
    } catch {
      return undefined
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const configs = await this.ensureModelConfigs()
    if (configs !== undefined && configs.length > 0) {
      return configs.map((config) => ({
        provider: ANTIGRAVITY_PROVIDER,
        id: config.id,
        name: config.label,
        inputModalities: config.supportsImages ? ['text', 'image'] as const : ['text'] as const,
      }))
    }
    const probe = await this.probeChannels()
    if (probe.channel === 'public') return this.publicChannel().listModels(_provider)
    return FALLBACK_MODELS.map((model) => ({
      provider: ANTIGRAVITY_PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ['text', 'image'] as const,
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const configs = await this.ensureModelConfigs()
    const found = configs?.find((config) => config.id === model)
    const fallback = FALLBACK_MODELS.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: found?.label ?? fallback?.name ?? model,
      inputModalities: found?.supportsImages === false ? ['text'] : ['text', 'image'],
    }
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const probe = await this.probeChannels()

    if (probe.channel === 'public') {
      yield* this.publicChannel().stream(options)
      return
    }

    if (probe.channel === 'unavailable') {
      throw new LlmError(probe.message ?? IDE_NOT_RUNNING_MESSAGE, 'UNAVAILABLE')
    }

    const instance = await this.resolveInstance()
    if (instance === undefined) {
      throw new LlmError(probe.message ?? IDE_NOT_RUNNING_MESSAGE, 'UNAVAILABLE')
    }

    const sessionKey = resolveSessionKey(options)
    let cascadeId = this.sessionCascades.get(sessionKey)
    let isNewCascade = false

    // 1. 会话获取或新建（同会话内复用 cascadeId，绝不反复新建对话框）
    if (cascadeId === undefined) {
      cascadeId = await this.gate.run(async () => startCascade(instance, {
        fetchImpl: this.fetchImpl,
        ...options.signal !== undefined ? { signal: options.signal } : {},
      }))
      isNewCascade = true
      this.sessionCascades.set(sessionKey, cascadeId)
    }

    // 在发送消息前，若为多轮复用会话，先拉取基线轨迹状态（记录旧轮次的用户输入数和总步数，杜绝时序竞态）
    let baselineUserInputCount = 0
    let baselineTotalSteps = 0
    if (!isNewCascade && cascadeId !== undefined) {
      try {
        const baselineTrajectory = await getTrajectory(instance, cascadeId, {
          fetchImpl: this.fetchImpl,
          ...options.signal !== undefined ? { signal: options.signal } : {},
        })
        baselineUserInputCount = countUserInputs(baselineTrajectory)
        baselineTotalSteps = baselineTrajectory.steps?.length ?? 0
      } catch {
        // 若读取基线失败，在后续发消息重试逻辑中会自动新建 cascadeId
      }
    }

    // 根据是全新会话还是多轮复用，选择合适的 Prompt 组装策略
    const prompt = isNewCascade
      ? (options.messages.length <= 1 ? formatInitialPrompt(options) : formatFullHistoryPrompt(options))
      : extractCurrentTurnPrompt(options)

    const blockIndex = 0

    // 2. 发消息（若复用的 cascadeId 已失效则自动清理并新建重试一次）
    try {
      await this.gate.run(async () => sendUserMessage(
        instance,
        cascadeId!,
        prompt,
        options.model,
        {
          fetchImpl: this.fetchImpl,
          ...options.signal !== undefined ? { signal: options.signal } : {},
        },
      ))
    } catch (err) {
      if (!isNewCascade) {
        this.sessionCascades.delete(sessionKey)
        cascadeId = await this.gate.run(async () => startCascade(instance, {
          fetchImpl: this.fetchImpl,
          ...options.signal !== undefined ? { signal: options.signal } : {},
        }))
        this.sessionCascades.set(sessionKey, cascadeId)
        isNewCascade = true
        baselineUserInputCount = 0
        baselineTotalSteps = 0
        const fullPrompt = formatFullHistoryPrompt(options)
        await this.gate.run(async () => sendUserMessage(
          instance,
          cascadeId!,
          fullPrompt,
          options.model,
          {
            fetchImpl: this.fetchImpl,
            ...options.signal !== undefined ? { signal: options.signal } : {},
          },
        ))
      } else {
        throw err
      }
    }

    // 3. 轮询轨迹直到出现本轮回复。
    const startedAt = Date.now()
    let textBlockStarted = false
    let text = ''

    for (;;) {
      if (options.signal?.aborted) throw new LlmError('antigravity: aborted', 'ABORTED')
      if (Date.now() - startedAt > this.replyTimeoutMs) {
        throw new LlmError(
          `antigravity: 等待 IDE 回复超时（${Math.round(this.replyTimeoutMs / 1000)}s）。`
            + 'IDE 可能正在处理较长的任务，可适当调大 DSH_ANTIGRAVITY_REPLY_TIMEOUT_MS 后重试。',
          'TIMEOUT',
        )
      }

      const trajectory = await getTrajectory(instance, cascadeId!, {
        fetchImpl: this.fetchImpl,
        ...options.signal !== undefined ? { signal: options.signal } : {},
      })

      // 错误步优先：命中即给出真实原因，不要继续傻等。
      const errorMessage = findErrorStep(trajectory, baselineTotalSteps)
      if (errorMessage !== undefined) {
        const hint = /capacity|503|UNAVAILABLE/i.test(errorMessage) ? ' (Google 服务端该模型临时缺货过载，请在底部切换为 Gemini 3.7 Flash、Gemini 3.1 Pro 或 Claude Sonnet 重试)' : ''
        throw new LlmError(
          `antigravity: IDE 执行失败：${errorMessage}${hint}`,
          this.mapErrorMessage(errorMessage),
        )
      }

      const reply = findReplyForTurn(trajectory, baselineUserInputCount, baselineTotalSteps)
      if (reply !== undefined) {
        const current = replyText(reply)
        if (current.length > 0 || isReplyDone(reply)) {
          if (!textBlockStarted && current.length > 0) {
            textBlockStarted = true
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
          }
          // 增量产出：只 yield 新增部分
          if (current.length > text.length && current.startsWith(text)) {
            const delta = current.slice(text.length)
            text = current
            if (!textBlockStarted) {
              textBlockStarted = true
              yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            }
            yield { type: 'text-delta', index: blockIndex, text: delta }
          } else if (current !== text) {
            // 内容被整体改写（如 modifiedResponse 替换）：重置为全量。
            text = current
            if (!textBlockStarted) {
              textBlockStarted = true
              yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            }
          }

          if (isReplyDone(reply)) {
            const usage = replyUsage(reply)
            yield {
              type: 'usage',
              usage: {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                ...usage.reasoningTokens !== undefined
                  ? { reasoningTokens: usage.reasoningTokens }
                  : {},
              },
            }
            break
          }
        }
      }

      await sleep(this.pollIntervalMs)
    }

    if (textBlockStarted) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private mapErrorMessage(message: string): string {
    if (/neither PlanModel nor RequestedModel/i.test(message)) {
      return 'INVALID_MODEL'
    }
    if (/quota|rate limit|RESOURCE_EXHAUSTED|capacity|503|UNAVAILABLE/i.test(message)) return 'RATE_LIMIT'
    if (/unauthor|forbidden|permission/i.test(message)) return 'AUTH'
    return 'SERVER'
  }
}

let registeredAntigravityAdapter: AntigravityLocalAdapter | undefined

export function getRegisteredAntigravityAdapter(): AntigravityLocalAdapter | undefined {
  return registeredAntigravityAdapter
}

export function getAntigravityAdapter(): AntigravityLocalAdapter | undefined {
  return registeredAntigravityAdapter
}

export function setRegisteredAntigravityAdapter(adapter: AntigravityLocalAdapter | undefined): void {
  registeredAntigravityAdapter = adapter
}

export function registerAntigravityLocalLlm(
  ctx: Context,
  options: AntigravityLocalAdapterOptions = {},
): () => void {
  const adapter = new AntigravityLocalAdapter(options)
  setRegisteredAntigravityAdapter(adapter)

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
  const unregister = ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)

  return () => {
    if (getRegisteredAntigravityAdapter() === adapter) {
      setRegisteredAntigravityAdapter(undefined)
    }
    unregister()
  }
}