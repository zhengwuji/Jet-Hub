/**
 * CatPaw（美团）LLM 适配器 —— 本插件里**唯一一家上游不是 OpenAI 协议**的 provider。
 *
 * ## 与其余 provider 的本质差别
 *
 * 其余 provider 都是「一次 HTTP 请求 = 一次对话」的无状态上游：把请求头与 body
 * 拼好发出去就够了。CatPaw 不是 —— 它的上游是一套 **conversation 会话协议**：
 *
 * ```text
 * 全新会话    round(全量)  → event(running) → turn(user)      → … → event(completed)
 * 长会话新轮次 round(增量)  → event(running) → turn(user)      → … → event(completed)
 * 工具续接    （不 round、不重复 event(running)）→ turn(tool结果) → …
 * ```
 *
 * 一次 `stream()` 调用可能对应好几个上游请求，中间还要维护
 * 「`options.sessionId` → conversationId」的映射与已同步消息的指纹链（增量提交）。
 * 这些状态与时序**不能**塞进单请求契约里，因此：
 *
 * - 会话状态在 `catpaw-registry.ts`（进程级单例）；
 * - 协议纯函数（消息归一化 / 指纹 / 参数映射）在 `catpaw.ts`；
 * - 本文件只管**编排**：轮次判定 → round → event → turn → SSE → 收尾。
 *
 * ## 三条轮次判定规则（**顺序不可换**）
 *
 * 1. 历史末尾是 `assistant(tool_calls)` + 全部 tool 结果，且 `tool_call_id` 命中
 *    注册表 → **工具续接**：turn 直接提交那条 tool 消息，不 round、不重复
 *    `event(running)`；
 * 2. `options.sessionId` 存在且注册表有映射（且 modelType / accountId / uid 一致）
 *    → **长会话新轮次**：复用 conversationId，round 只提交指纹链定位出的增量；
 * 3. 其余 → **全新会话**：新 conversationId，round 全量。
 *
 * ⚠️ **为什么顺序不能换**：规则 1 判的是「这一轮是不是上一轮的延续」，规则 2 判的
 * 是「这个客户端会话有没有可复用的 conversationId」。工具续接请求**同样带**
 * sessionId，若先判规则 2 就会走成「往同一 conversation 再 round 一条 user 消息」
 * —— 而上游此时还在等 tool 结果，round 与 turn 的历史就串了。
 *
 * ## 三条硬约束（上游行为特性，违反会导致会话卡死或 504）
 *
 * 1. **每个轮次结束必须回报 `event(completed)`**，否则 conversation 停在上游的
 *    「执行中」状态，下一轮 round 被拒（原文「会话正在执行中，无法创建新轮次」）。
 *    失败/打断路径回报 `failed` / `canceled`。
 *    **唯一例外**：本轮返回工具调用时**不报** completed —— 那一轮在上游语义里
 *    还没结束，客户端马上会带着 tool 结果回来续接。
 * 2. **turn 的 SSE 必须消费到服务端关闭连接**（`message.finished === true`
 *    ≠ turn 结束）。因此本适配器**必须起独立后台任务读到底**：客户端断流只表现
 *    为「发送失败」，消费要继续。若直接把上游字节流包成 `Stream` 转发，客户端一
 *    断流就被 drop，上游那次 turn 再没人读完 → 下一轮 round 被拒。
 * 3. 同一 `sessionId` 已有流式请求在跑 → 新请求走**独立 conversation**
 *    （不读也不写会话映射）；`purpose === 'compaction' | 'session-title'` 的辅助
 *    请求**同样不读不写**（它们的历史末尾常是 assistant，与主对话共用映射会互相
 *    覆盖）。
 *
 * ## 上游 SSE → DSH `StreamChunk`（与 OpenAI chunk 契约的对应关系）
 *
 * 本适配器**自己写解析与翻译**（不用 `consumeOpenAiSse`），因为上游的 SSE 帧形状
 * 与 OpenAI 完全不同：
 *
 * | OpenAI chunk 契约（上游客户端形态） | 本适配器的 `StreamChunk` 对应物 |
 * |---|---|
 * | 首帧 `delta:{role:'assistant'}` | 不需要：`BlockAssembler` 由首个 `block-start` 建块 |
 * | `delta.content` 增量帧 | `text-delta` |
 * | `delta.reasoning_content` 增量帧 | `reasoning-delta` |
 * | `delta.tool_calls[]`（首见带 id/name、之后带参数增量） | `block-start` + `tool-call-delta` |
 * | 收尾帧 `delta:{}` + `finish_reason` | `finish`（`tool-calls` / `stop` / `max-tokens`） |
 * | `stream_options.include_usage` 时的一帧 `usage` | `usage`（**总是**在可用时下发：DSH 的记账不靠开关） |
 * | `data: [DONE]` | 迭代器自然结束 |
 * | `{id:'chatcmpl-…'}` 响应 id | 仅用于日志（见 {@link catpawChatCompletionId}） |
 *
 * ⚠️ **上游的 `text` / `reasoningContent` / `toolParams` 是累积全量值，不是增量** ——
 * 必须做**后缀差分**（`startsWith` 判定：新值是旧值的前缀延伸则只发新增部分；
 * 相等则不发帧）。直接把事件里的 text 当 delta 下发会让客户端看到重复内容。
 *
 * ## 错误分类
 *
 * | 场景 | 结果 |
 * |---|---|
 * | 入站参数错（模型名、effort、context、tools） | 400 + 中文文案（**不经 round**） |
 * | 上游 HTTP 4xx | **原样**状态码 |
 * | 上游 HTTP 5xx / 网络 / 序列化 | 502 |
 * | 上游业务码 ∉ {0,200} | 用 `httpStatus`（缺省 502） |
 * | round 文案含「执行中」 | **自愈一次**：作废映射 + 新 conversationId 全量重提 |
 * | 无凭证 | **503**（不是 401：没有凭证不等于凭证被拒） |
 *
 * ## 图片：本仓库**没有图像处理依赖**
 *
 * 上游**不拉取 http(s) 图片**，图片只能以 `data:image/...;base64,` 内联；而大图是
 * round 请求体超限的主因（实测单张 176KB 截图会让请求 504）。原实现用 image crate
 * 做缩放（最长边 1568 → 896、JPEG 质量 80 → 55、目标 ≤120KB）。
 * **本仓库无图像依赖，故降级为如实省略而不是静默超限** —— 超阈值的图片块被替换成
 * 一条说明文本并记 warn。这比发一个必然 504 的请求好：用户立刻知道要压缩，
 * 而不是等一次超时。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  CatpawProtocolError,
  asFingerprintInput,
  catpawFingerprintsFor,
  catpawMessageFingerprint,
  catpawRequestHeaders,
  locateIncrement,
  normalizeCatpawMessages,
  normalizeCatpawTools,
  resolveCatpawContext,
  resolveCatpawModel,
  unwrapCatpawApiData,
  type CatpawContentBlock,
  type CatpawCredential,
  type CatpawNormalizedMessages,
  type CatpawRemoteModel,
  type CatpawUpstreamMessage,
} from './catpaw.js'
import {
  CATPAW,
  CATPAW_MODE,
  CATPAW_PERMISSION_MODE,
  CATPAW_SOURCE,
  CATPAW_TOOL_VERSION,
  type CatpawFallbackModel,
  type CatpawProduct,
} from './catpaw-product.js'
import {
  clearAccount,
  getSession,
  lookupCallId,
  markInflight,
  registerSession,
  releaseInflight,
  type CatpawSessionRecord,
} from './catpaw-registry.js'
import { collectImages, errorDetail, httpErrorCode, isTransportError } from './openai-compat.js'
import {
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveEmptyResponseReason,
} from './sse.js'

/** 本适配器注册的 provider 路由名（等价于 `CATPAW.id`）。 */
export const PROVIDER = 'catpaw'

/** round / event / turn-stop 这类「一问一答」请求的总超时（毫秒）。 */
const SHORT_REQUEST_TIMEOUT_MS = 30_000

/**
 * turn 的 SSE 总超时（毫秒）。
 *
 * 15 分钟而不是更短：带工具循环的长回答可能跑很久，而这是**总超时**，
 * 设短了会把正在推进的长回答掐断 —— 客户端一边收到内容一边被断流。
 */
const TURN_TIMEOUT_MS = 15 * 60 * 1000

/** `turn/stop` 的超时（毫秒）：打断是收尾动作，超时必须短。 */
const STOP_TIMEOUT_MS = 3_000

/** 图片降级阈值：**base64 文本长度**超过它就不发（见文件头的说明）。 */
const IMAGE_BASE64_LIMIT = 60 * 1024

/** 图片被省略时的占位文案（如实说明，而不是静默超限）。 */
const IMAGE_OMITTED_TEXT = '[图片过大，已省略：请压缩后重试]'

/** 工具调用 id 前缀（上游 toolCallId 缺失时的兜底，保证块可被组装）。 */
const FALLBACK_TOOL_CALL_PREFIX = 'catpaw_call_'

/** 本家接受的三个思考档位（**由弱到强**；与 `resolveCatpawEffort` 同源）。 */
const CATPAW_EFFORTS: readonly string[] = ['low', 'high', 'max']

/** 队列上限（帧数）。见 {@link CatpawChunkQueue} 的说明。 */
const MAX_QUEUE = 4096

/**
 * 生成一个 `chatcmpl-` 开头的响应 id。
 *
 * 上游客户端契约里每帧 chunk 都带它（`chatcmpl-${uuid 去连字符取前 24}`）。
 * DSH 的 `StreamChunk` 没有这个字段，故本适配器只把它用作**日志里的轮次标识**
 * —— 保留它是因为排障时「一次 turn 对应哪个 id」是第一条要问的信息。
 */
export function catpawChatCompletionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/** 只放行**安全正整数**（远端是外部输入，`0`/负数/`NaN` 会让 DSH 硬校验抛错）。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 后缀差分。
 *
 * `current` 以 `previous` 开头时返回新增部分；否则**整体返回**（上游换了一段完全
 * 不同的内容时的兜底，宁可多发也不能让客户端丢内容）；完全相等返回 undefined
 * （不发帧）。
 */
function suffixAfter(current: string, previous: string): string | undefined {
  if (current === previous) return undefined
  if (current.startsWith(previous)) return current.slice(previous.length)
  return current
}

/** 首 token 空闲超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_CATPAW_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔空闲超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_CATPAW_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

/** 兜底表条目 → 远端形状。 */
function fallbackToRemote(model: CatpawFallbackModel): CatpawRemoteModel {
  return {
    id: model.id,
    name: model.name,
    modelType: model.modelType,
    supportsImages: model.supportsImage,
    supportsReasoning: model.supportsReasoning,
    ...model.contextOptions.length > 0
      ? { maxInputTokens: Math.max(...model.contextOptions) }
      : {},
    ...model.defaultContext === undefined
      ? {}
      : { defaultContextWindow: String(model.defaultContext) },
  }
}

/** {@link CatpawAdapter} 的构造选项。 */
export interface CatpawAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<CatpawCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ 本家**没有 refresh 端点**（见 `catpaw-auth.ts`），该回调的语义是「如实报错
   * 让用户重新登录」。适配器**不主动调用**它 —— 401 时也无可续期，直接报错更诚实。
   * 保留字段是为了与其余 provider 的接线形态一致（`index.ts` 统一注入）。
   */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退静态表。 */
  fetchRemoteModels?: () => Promise<CatpawRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link CATPAW}。 */
  product?: CatpawProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 记一条警告（图片降级、非致命异常）。缺省时静默。 */
  warn?: (message: string) => void
}

/** CatPaw 模型适配器。 */
export class CatpawAdapter extends LlmAdapter {
  private readonly product: CatpawProduct
  /** 静态表索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, CatpawFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: CatpawRemoteModel[] | undefined

  constructor(private readonly options: CatpawAdapterOptions) {
    super()
    this.product = options.product ?? CATPAW
    this.fallbackIndex = new Map(this.product.models.map((model) => [model.id, model]))
  }

  /**
   * 注入的 fetch（测试用）；默认为全局 fetch。
   *
   * ⚠️ 必须是 getter 而非构造期赋值：构造期求值会把 `globalThis.fetch` 冻结成
   * 当时的引用，使运行时装上的 fetch 补丁（上下文压缩代理即靠此接管模型流量）
   * 对本适配器发出的请求失效 —— 表现为压缩静默不生效。与其余适配器一致。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 记一条警告（经注入的回调；缺省静默）。 */
  private warn(message: string): void {
    this.options.warn?.(`[catpaw] ${message}`)
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.models.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: displayNameOf(model) }))
  }

  /** 取（并缓存）远端模型目录；失败时回退静态表。 */
  private async loadModels(): Promise<CatpawRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退静态表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.models.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: CatpawRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImages === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider 分组
    // 隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的 failures，
    // 界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: displayNameOf(model),
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  /**
   * 解析模型元数据。
   *
   * ⚠️ **这里刻意宽松**：`resolveModel` 是**目录播报**路径，DSH 会对每个已持久化
   * 的模型调它；表外名字在这里抛错会让整个模型列表不可用。严格的「表外名字 400」
   * 判定放在 {@link CatpawAdapter.stream} 里（那才是真正要发请求的地方）。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // name **不带倍率**（与其余适配器一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = positiveInt(entry?.maxInputTokens)
      ?? (fallback !== undefined && fallback.contextOptions.length > 0
        ? Math.max(...fallback.contextOptions)
        : undefined)
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // 思考档位：本家只认 low / high / max（上游枚举），与 `resolveCatpawEffort` 同源。
    resolved.reasoning = {
      efforts: CATPAW_EFFORTS.map((id) => ({ id: ReasoningEffortId(id), name: id })),
      defaultEffort: ReasoningEffortId('high'),
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本基类
   * 尚未提供该方法。与其余适配器同款 shim。
   */
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

  /**
   * 一次会话式请求的入口。
   *
   * 分两段：
   * 1. **入站准备**（本函数体）：模型 / 档位 / 工具 / 图片 / 消息归一化 —— 这一段的
   *    任何错误都是**客户端入参错误**，直接 400，**不经 round**（不能在上游留下一个
   *    刚创建就被判失败的 conversation）；
   * 2. **上游时序**（{@link CatpawTurn}）：round → event → turn → SSE → 收尾，
   *    由**独立后台任务**执行，帧通过队列交给本生成器。
   *
   * ⚠️ 第 2 段必须独立于本生成器的生命周期：客户端断流时生成器被 dispose，
   * 但上游那次 turn **必须继续读到底**（硬约束 2），否则上游卡在「执行中」，
   * 下一轮 round 被拒。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ── 凭据 ──────────────────────────────────────────────────────
    const credential = await this.options.resolveCredential()
    if (credential === undefined || credential.access_token.trim().length === 0) {
      // ⚠️ **503 而不是 401**：没有凭证不等于凭证被拒。401 会让上层走「续期重试」
      // 那条链，而本家根本没有可续期的东西（见 catpaw-auth.ts）。
      throw new LlmError(
        'catpaw: 没有可用的登录凭证，请在 Jet Hub 添加账号后重试',
        'MISSING_CREDENTIAL',
        { status: 503 },
      )
    }

    const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
    /**
     * 辅助请求（标题 / 摘要）**不读不写**会话映射。
     *
     * 它们的历史末尾常是 assistant，与主对话共用映射会互相覆盖 conversationId 与
     * 指纹链 —— 于是主对话的下一轮 round 拿到一份错误的历史（或误判「历史被改写」
     * 而全量重建）。
     */
    const auxiliary = options.purpose === 'compaction' || options.purpose === 'session-title'

    // ── 模型与入站参数（**全部在 round 之前校验**）─────────────────
    const remoteModels = await this.loadModels()
    let resolution: ReturnType<typeof resolveCatpawModel>
    try {
      resolution = resolveCatpawModel(options.model, remoteModels, this.product.models)
    } catch (error) {
      throw toLlmError(error)
    }
    const effort = this.resolveEffortFromOptions(options)
    const body = options as GenerateOptions & { tool_choice?: unknown }
    let context: string | undefined
    let tools: ReturnType<typeof normalizeCatpawTools>
    try {
      context = resolveCatpawContext(body, resolution)
      tools = normalizeCatpawTools(options.tools, body.tool_choice)
    } catch (error) {
      throw toLlmError(error)
    }

    // ── 图片：收集附件字节并内联为 data URL ───────────────────────
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      const entry = remoteModels.find((item) => item.id === resolution.displayName)
        ?? remoteModels.find((item) => item.id === options.model)
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`catpaw: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('catpaw: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让归一化产出 `[image unavailable]` 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // ── 消息归一化 ────────────────────────────────────────────────
    let normalized: CatpawNormalizedMessages
    try {
      normalized = normalizeCatpawMessages(options.messages, options.system, imageUrls)
    } catch (error) {
      throw toLlmError(error)
    }
    const messages = this.omitOversizedImages(normalized.messages)
    if (messages.length === 0) {
      throw new LlmError(
        'catpaw: system/developer 之外至少需要一条对话消息',
        'INVALID_REQUEST',
        { status: 400 },
      )
    }

    // ── 轮次判定与占用 ────────────────────────────────────────────
    const accountId = await this.resolveAccountId(credential)
    const uid = (credential.uid ?? '').trim()
    let persistent = false
    if (sessionId.length > 0 && !auxiliary) {
      // ⚠️ 判断与登记必须在同一次「加锁」里完成（见 catpaw-registry 的说明）。
      persistent = markInflight(sessionId, { accountId, uid })
      if (!persistent) {
        this.warn('同一 sessionId 已有流式请求在跑，本次走独立 conversation（不读不写会话映射）')
      }
    }

    const turn = new CatpawTurn({
      fetchImpl: this.fetchImpl,
      warn: (message: string) => { this.warn(message) },
      product: this.product,
      credential,
      options,
      sessionId,
      persistent,
      auxiliary,
      accountId,
      uid,
      resolution,
      messages,
      ...normalized.systemPromptOverride === undefined
        ? {}
        : { systemPromptOverride: normalized.systemPromptOverride },
      ...normalized.rulesMessage === undefined ? {} : { rulesMessage: normalized.rulesMessage },
      ...effort === undefined ? {} : { effort },
      ...context === undefined ? {} : { context },
      tools,
      chatId: catpawChatCompletionId(),
    })

    const queue = new CatpawChunkQueue()
    // 后台任务：**独立**把整个 turn 消费到底（客户端断流也继续）。
    void turn.execute(queue).catch((error: unknown) => {
      queue.fail(toLlmError(error))
    })

    try {
      yield* queue.drain()
    } finally {
      // 客户端提前断开：上游那次 turn 仍在后台读到底，但我们主动打断它，
      // 免得白烧额度、且让上游尽早回到可建新轮次的状态。
      turn.onConsumerGone()
    }
  }

  /** 从 `options.reasoningEffort` 取档位（**宽松**：不在枚举内就忽略）。 */
  private resolveEffortFromOptions(options: GenerateOptions): string | undefined {
    const raw = options.reasoningEffort
    if (typeof raw !== 'string') return undefined
    const value = raw.trim().toLowerCase()
    // ⚠️ 这里**不**抛 400：`reasoningEffort` 是 DSH 注入的（可能来自旧会话的持久化
    // 值），与客户端在 body 里显式传 `reasoning_effort` 是两回事。一个过时的档位
    // 不该让整轮对话起不来 —— 忽略它，用上游默认档位。
    if (!CATPAW_EFFORTS.includes(value)) {
      this.warn(`忽略不受支持的思考档位 "${raw}"（本家仅支持 ${CATPAW_EFFORTS.join(' / ')}）`)
      return undefined
    }
    return value
  }

  /**
   * 反查当前凭据属于哪个账号（供注册表的账号维度判定）。
   *
   * 查不到时返回空串 —— 空串是**显式身份**（只匹配空），不会与真实账号的记录串用。
   */
  private async resolveAccountId(credential: CatpawCredential): Promise<string> {
    const pool = this.options.accountPool
    if (pool === undefined) return ''
    try {
      return await pool.findAccountIdByCredential(this.product.id, credential.access_token)
    } catch {
      return ''
    }
  }

  /**
   * 把超阈值的内联图片替换为说明文本。
   *
   * ⚠️ **本仓库没有图像处理依赖**（没有 sharp / jimp），因此**不做真正的缩放**，
   * 只做体积判定：base64 文本长度超过阈值的图片块替换成
   * `{type:'text', text:'[图片过大，已省略…]'}` 并记一条 warn。
   *
   * 原实现用 image crate 做缩放（最长边 1568 → 896、JPEG 质量 80 → 55、
   * 目标 ≤120KB），本仓库无此依赖，故**降级为如实省略而不是静默超限** ——
   * 发一个必然 504 的请求比让用户立刻知道「要压缩」糟得多。
   */
  private omitOversizedImages(messages: CatpawUpstreamMessage[]): CatpawUpstreamMessage[] {
    let omitted = 0
    const out = messages.map((message) => {
      if (!message.content.some((block) => block.type === 'image_url')) return message
      const content: CatpawContentBlock[] = []
      for (const block of message.content) {
        if (block.type !== 'image_url') {
          content.push(block)
          continue
        }
        const url = block.imageUrl.url
        // 阈值按 **base64 文本长度**（逗号之后的部分）算，与上游客户端的口径一致。
        const comma = url.indexOf(',')
        const base64Length = url.startsWith('data:') && comma !== -1 ? url.length - comma - 1 : 0
        if (base64Length > IMAGE_BASE64_LIMIT) {
          omitted += 1
          content.push({ type: 'text', text: IMAGE_OMITTED_TEXT })
          continue
        }
        content.push(block)
      }
      return { ...message, content }
    })
    if (omitted > 0) {
      this.warn(
        `已省略 ${omitted} 张超过 ${Math.round(IMAGE_BASE64_LIMIT / 1024)}KB 的内联图片`
        + '（本仓库无图像处理依赖，无法缩放；请压缩后重试）',
      )
    }
    return out
  }
}

/** 模型展示名：远端目录的 `credits` 拼进 name（composer 的切换菜单只渲染 name）。 */
function displayNameOf(model: CatpawRemoteModel): string {
  const credits = typeof model.credits === 'string' ? model.credits.trim() : ''
  return credits.length > 0 ? `${model.name} · ${credits}` : model.name
}

/** 把协议层/传输层错误统一翻译成 `LlmError`。 */
function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof CatpawProtocolError) {
    return new LlmError(`catpaw: ${error.message}`, 'INVALID_REQUEST', { status: error.status })
  }
  if (isTransportError(error)) {
    return new LlmError(
      `catpaw: transport error: ${error instanceof Error ? error.message : String(error)}`,
      'TRANSPORT',
      { status: 502, cause: error instanceof Error ? error : undefined },
    )
  }
  return new LlmError(
    `catpaw: ${error instanceof Error ? error.message : String(error)}`,
    'SERVER',
    { status: 502 },
  )
}

// ─── 一轮 turn 的编排 ──────────────────────────────────────────────

/** {@link CatpawTurn} 的构造参数（由适配器装配）。 */
interface CatpawTurnInit {
  product: CatpawProduct
  credential: CatpawCredential
  options: GenerateOptions
  sessionId: string
  persistent: boolean
  auxiliary: boolean
  accountId: string
  uid: string
  resolution: ReturnType<typeof resolveCatpawModel>
  messages: CatpawUpstreamMessage[]
  systemPromptOverride?: string
  rulesMessage?: string
  effort?: string
  context?: string
  tools: ReturnType<typeof normalizeCatpawTools>
  chatId: string
  /**
   * 出网用的 fetch 与日志回调。
   *
   * 由适配器**传值**而不是让本类反向持有适配器：反向引用会把适配器的全部私有面
   * 暴露给状态机，也会让「谁负责出网」这条边界糊掉（getter 语义必须与适配器一致，
   * 否则运行时装上的 fetch 补丁会对本链路静默失效）。
   */
  fetchImpl: typeof fetch
  warn: (message: string) => void
}

/** 轮次模式（对应三条判定规则）。 */
type TurnMode = 'tool-continuation' | 'session-round' | 'new-round'

/** 终态取值。 */
type TurnStatus = 'completed' | 'failed' | 'canceled'

/**
 * 一轮 turn 的状态机：round → event(running) → turn(SSE) → 收尾。
 *
 * 它同时承担「**收尾责任**」：无论成功、失败还是客户端断开，都必须
 * ①释放注册表占用、②回报一个终态（除非本轮返回了工具调用）。
 */
class CatpawTurn {
  private readonly init: CatpawTurnInit
  private mode: TurnMode = 'new-round'
  /**
   * 本轮使用的 conversationId。
   *
   * ⚠️ 显式标注 `string`：`randomUUID()` 的返回类型是模板字面量
   * （`` `${string}-${string}-…` ``），让 TS 推断会把字段钉死成那个类型，
   * 后续赋值一个普通字符串就编译不过（自愈重试要换成新的 conversationId）。
   */
  private conversationId: string = randomUUID()
  private readonly turnRequestId: string = randomUUID()
  /** 要提交给 round 的消息（undefined = 工具续接，不 round）。 */
  private roundMessages: CatpawUpstreamMessage[] | undefined
  /** 工具续接时提交的那条 tool 消息。 */
  private continuation: CatpawUpstreamMessage | undefined
  /** 命中的会话记录（决定收尾时怎么写回注册表）。 */
  private session: CatpawSessionRecord | undefined
  /** 本轮**实际提交**的消息指纹（写回指纹链用）。 */
  private submitted: string[] = []
  /** 复用会话时的旧指纹链前缀。 */
  private prefix: string[] = []
  /** round + event(running) 是否都成功过（决定要不要报终态）。 */
  private active = false
  /** 是否已报终态（幂等）。 */
  private closed = false
  /** 是否已交接（报了终态，或「返回工具调用」这条例外路径）。 */
  private settled = false
  /** 当前 turn 的请求控制器（打断时 abort）。 */
  private controller: AbortController | undefined

  constructor(init: CatpawTurnInit) {
    this.init = init
  }

  /** 执行整轮（**必须由独立后台任务调用**，见适配器的说明）。 */
  async execute(queue: CatpawChunkQueue): Promise<void> {
    try {
      this.decide()
      await this.runRound()
      await this.reportRunning()
      this.active = true
      const response = await this.requestTurn(this.buildTurnBody())
      await this.consume(response, queue)
    } catch (error) {
      const failure = toLlmError(error)
      // 失败路径必须回报终态（硬约束 1）：上游可能已经 round 过，不报会让
      // conversation 卡在「执行中」，下一轮 round 被拒。
      await this.close(this.active ? 'failed' : 'canceled', failure)
      throw failure
    }
  }

  /**
   * 客户端断流时的处理：后台消费继续，但主动打断上游轮次并回报 `canceled`。
   *
   * ⚠️ 这是**用户行为**（他取消了这一轮），不是上游故障 —— 所以报 `canceled`
   * 而不是 `failed`。上游收到 `canceled` 后才会把 conversation 从「执行中」
   * 放出来，下一轮 round 才建得起来。
   */
  onConsumerGone(): void {
    if (this.settled) return
    void (async () => {
      await this.stopTurn()
      await this.close('canceled')
    })().catch(() => {})
  }

  // ── 判定（三条规则，顺序不可换）────────────────────────────────

  private decide(): void {
    const messages = this.init.messages

    // ── 规则 1：工具续接（按 tool_call_id 命中注册表）──────────────
    const pending = pendingCallIds(this.init.options.messages)
    if (pending.length > 0) {
      const hits: CatpawSessionRecord[] = []
      for (const callId of pending) {
        const record = lookupCallId(callId)
        if (record === undefined) continue
        if (!hits.some((hit) => hit.conversationId === record.conversationId)) hits.push(record)
      }
      if (hits.length > 1) {
        // 同一批 tool_call_id 命中了两条不同的 conversation：客户端把两轮工具调用
        // 的结果混在一起了，续接到哪一条都是错的。
        throw new LlmError(
          'catpaw: tool_call_id 命中多个待处理工具会话',
          'INVALID_REQUEST',
          { status: 400 },
        )
      }
      const hit = hits[0]
      if (hit !== undefined) {
        this.mode = 'tool-continuation'
        this.conversationId = hit.conversationId
        this.session = hit
        this.continuation = this.buildContinuation(hit)
        this.submitted = [catpawMessageFingerprint(asFingerprintInput(this.continuation))]
        return
      }
    }

    // ── 规则 2：长会话新轮次（sessionId 命中注册表）────────────────
    if (this.init.persistent && this.init.sessionId.length > 0) {
      const record = getSession(this.init.sessionId)
      if (record !== undefined
        && record.modelType === this.init.resolution.modelType
        && record.accountId === this.init.accountId
        && record.uid === this.init.uid) {
        const located = locateIncrement(record.fingerprintChain, messages)
        if (!located.mismatch) {
          this.mode = 'session-round'
          this.conversationId = record.conversationId
          this.session = record
          this.prefix = record.fingerprintChain
          this.roundMessages = messages.slice(located.start)
          this.submitted = catpawFingerprintsFor(this.roundMessages)
          return
        }
        // 客户端压缩/改写了历史：旧 conversation 无法增量续接，作废后全量重建。
        // ⚠️ **不报错**：压缩是客户端的**正常行为**，报错会把一件合理的事变成
        // 用户可见的失败。作废映射、全量重开一轮，用户无感（只是多传一次历史）。
        this.init.warn('指纹不匹配（客户端压缩/改写历史），作废会话映射并全量重建')
      } else if (record !== undefined) {
        // 模型 / 账号 / 用户变了：conversationId 属于另一个上游上下文，必须重建。
        this.init.warn('模型或账号身份已变化，作废会话映射并全量重建')
      }
    }

    // ── 规则 3：全新会话（全量 round）──────────────────────────────
    this.mode = 'new-round'
    this.conversationId = randomUUID()
    this.roundMessages = messages
    this.submitted = catpawFingerprintsFor(messages)
  }

  /**
   * 工具续接要提交的那条 tool 消息。
   *
   * 用**完整归一化管线**处理 `messages[start..]`（assistant tool_call + 后续 tool
   * 结果），于是配对校验与 `toolName` 回填都是现成的 —— 回填是**必须的**：
   * toolName 进指纹，缺了会让客户端下一轮回显的 tool 消息与注册表指纹对不上，
   * 误判「历史被改写」而全量重建。
   */
  private buildContinuation(session: CatpawSessionRecord): CatpawUpstreamMessage {
    const raw = this.init.options.messages
    const start = pendingToolCallStart(raw)
    if (start === undefined) {
      throw new LlmError(
        'catpaw: 工具结果续接请求缺少对应的 assistant tool_calls',
        'INVALID_REQUEST',
        { status: 400 },
      )
    }
    let normalized: CatpawNormalizedMessages
    try {
      normalized = normalizeCatpawMessages(raw.slice(start))
    } catch (error) {
      throw toLlmError(error)
    }
    // ⚠️ 取**最后一条** tool 消息而不是 `messages[length-1]`：harness ≤0.1.6 把工具
    // 结果包裹在 user 消息里，归一化会把它拆成「tool 消息 + user 文本」两条，
    // 此时最后一条不是 tool。同时要求除它之外没有 assistant —— 保证这条续接片段
    // 只包含当前 tool_call 的结果。
    const toolMessage = normalized.messages.filter((message) => message.type === 'tool').pop()
    const hasAssistant = normalized.messages.some((message) => message.type === 'assistant')
    if (toolMessage === undefined || hasAssistant) {
      throw new LlmError(
        'catpaw: 工具结果续接请求只能包含当前 tool_call 对应的 tool 结果',
        'INVALID_REQUEST',
        { status: 400 },
      )
    }
    const seen = toolMessage.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block.type === 'tool_result' ? block.toolCallId : ''))
    if (session.pendingCallIds.length !== seen.length
      || session.pendingCallIds.some((id) => !seen.includes(id))) {
      throw new LlmError(
        'catpaw: tool_result 与待处理的 assistant tool_calls 不一致',
        'INVALID_REQUEST',
        { status: 400 },
      )
    }
    return toolMessage
  }

  // ── 上游请求 ───────────────────────────────────────────────────

  /** round：提交消息（工具续接时不调用）。 */
  private async runRound(): Promise<void> {
    const messages = this.roundMessages
    if (messages === undefined) return

    // 上一轮的工具调用被打断时 conversation 仍停在上游「执行中」，必须先停掉旧
    // 轮次（对齐桌面端的 turn_stop），否则新 round 被拒。
    const session = this.session
    if (session !== undefined && session.pendingCallIds.length > 0) {
      await this.stopTurnFor(session.conversationId)
      await this.reportTerminalFor(session.conversationId, 'canceled')
    }

    try {
      await this.postRound(messages)
      return
    } catch (error) {
      if (this.mode !== 'session-round' || !isBusyError(error)) throw error
      // ── 自愈一次 ──────────────────────────────────────────────
      // 上游原文「会话正在执行中，无法创建新轮次」：注册表记的 conversationId 在
      // 上游仍处于 running，而我们拿不到它的 turnRequestId（进程重启、TTL 淘汰都
      // 会让它丢失），那条旧轮次就再也停不掉。此时作废映射、改成**全新会话全量
      // round**，客户端这一次请求就能走通。
      this.init.warn('上一轮仍在上游执行中，作废会话映射并改为全新会话全量重提一次')
      clearAccount(this.init.accountId)
      this.conversationId = randomUUID()
      this.mode = 'new-round'
      // ⚠️ **指纹链必须清空前缀换成全量**：旧指纹链对新 conversation 毫无意义
      //（它没见过那些消息）。若保留，下一轮 `locateIncrement` 会以为上游已见过
      // 整段历史，增量从末尾开始，新 conversation 就只看到一段断层的历史。
      this.prefix = []
      this.session = undefined
      this.submitted = catpawFingerprintsFor(this.init.messages)
      await this.postRound(this.init.messages)
    }
  }

  /** 发一次 round 请求。 */
  private async postRound(messages: readonly CatpawUpstreamMessage[]): Promise<void> {
    const body: Record<string, unknown> = {
      conversationId: this.conversationId,
      source: CATPAW_SOURCE,
      messages,
      modelType: this.init.resolution.modelType,
      mode: CATPAW_MODE,
      permissionMode: CATPAW_PERMISSION_MODE,
      toolVersion: CATPAW_TOOL_VERSION,
    }
    this.applyDirectives(body)
    const declarative: Record<string, unknown> = {}
    if (this.init.effort !== undefined) declarative.effort = this.init.effort
    if (this.init.context !== undefined) declarative.context = this.init.context
    if (Object.keys(declarative).length > 0) {
      // **空值整键不出现**：上游对「给了空 declarativeParams」与「没给」的语义不同。
      body.requestContext = { modelParams: { declarativeParams: declarative } }
    }
    await this.postJson('/api/agent/conversation/round', body, SHORT_REQUEST_TIMEOUT_MS)
  }

  /** event(running)（工具续接**不重复报**）。 */
  private async reportRunning(): Promise<void> {
    if (this.roundMessages === undefined) return
    await this.postJson(
      '/api/agent/conversation/event',
      {
        conversationId: this.conversationId,
        eventType: 'conversation',
        data: { status: 'running' },
      },
      SHORT_REQUEST_TIMEOUT_MS,
    )
  }

  /** 构造 turn 请求体。 */
  private buildTurnBody(): Record<string, unknown> {
    const message = this.mode === 'tool-continuation'
      ? this.continuation
      : this.init.messages[this.init.messages.length - 1]
    if (message === undefined) {
      throw new LlmError('catpaw: 没有可提交的轮次消息', 'INVALID_REQUEST', { status: 400 })
    }
    // 持久会话要求轮次以 user 结尾；工具续接（tool 消息）与辅助请求除外。
    if (this.mode !== 'tool-continuation' && message.type !== 'user' && this.init.persistent) {
      // 走到这里说明客户端提交的历史与映射对不上（例如上一轮工具会话已失效），
      // 作废映射让它下一轮全量重来。
      clearAccount(this.init.accountId)
      throw new LlmError('catpaw: 工具会话已失效，请重新发起当前回合', 'INVALID_REQUEST', { status: 400 })
    }
    const body: Record<string, unknown> = {
      conversationId: this.conversationId,
      turnRequestId: this.turnRequestId,
      source: CATPAW_SOURCE,
      action: 'turn',
      message,
      modelType: this.init.resolution.modelType,
      mode: CATPAW_MODE,
      permissionMode: CATPAW_PERMISSION_MODE,
      toolVersion: CATPAW_TOOL_VERSION,
      toolConfigs: this.init.tools.toolConfigs,
      availableTools: this.init.tools.availableTools,
    }
    this.applyDirectives(body)
    return body
  }

  /** 把 system / developer 抽离出来的两个字段补进请求体（空值整键不出现）。 */
  private applyDirectives(body: Record<string, unknown>): void {
    if (this.init.systemPromptOverride !== undefined) {
      body.systemPromptContext = { systemPromptOverride: this.init.systemPromptOverride }
    }
    if (this.init.rulesMessage !== undefined) body.rulesMessage = this.init.rulesMessage
  }

  /** 发 turn 请求（SSE；**不读响应体**，交给消费循环）。 */
  private async requestTurn(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => { controller.abort() }, TURN_TIMEOUT_MS)
    timer.unref?.()
    try {
      return await this.init.fetchImpl(`${this.init.product.inferBase}/api/agent/conversation/turn`, {
        method: 'POST',
        headers: catpawRequestHeaders(this.init.credential, { accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      this.controller = undefined
      throw error
    }
  }

  /** 一个短请求：发 JSON → 读体 → 校验 HTTP → 解包业务码。 */
  private async postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response
    let payload: string
    try {
      response = await this.init.fetchImpl(`${this.init.product.inferBase}${path}`, {
        method: 'POST',
        headers: catpawRequestHeaders(this.init.credential, { accept: 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      payload = await response.text()
    } catch (error) {
      if (isTransportError(error)) {
        // 网络失败 → 502（不是上游 4xx）。
        throw new LlmError(
          `catpaw: 上游请求失败: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { status: 502, cause: error instanceof Error ? error : undefined },
        )
      }
      throw error
    }
    if (!response.ok) {
      // HTTP 4xx **原样**状态码，5xx 归 502。`httpErrorCode` 同时负责
      // 「400 里是不是上下文超限」的判定 —— 那决定 DSH 会不会自动压缩上下文
      // 并重试，只回一个裸 INVALID_REQUEST 会让长会话越过窗口时直接失败。
      throw new LlmError(
        `catpaw: ${path} HTTP ${response.status}: ${errorDetail(payload)}`,
        httpErrorCode(response.status, payload),
        { status: response.status < 500 ? response.status : 502 },
      )
    }
    if (payload.trim().length === 0) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      // 序列化/解析失败 → 502（不是客户端错误）。
      throw new LlmError(`catpaw: ${path} 响应不是合法 JSON`, 'SERVER', { status: 502 })
    }
    const unwrapped = unwrapCatpawApiData(parsed)
    if (!unwrapped.ok) {
      // 业务码 ∉ {0,200}：用 `httpStatus`（缺省 502）。
      throw new LlmError(
        `catpaw: ${path} ${unwrapped.message}`,
        httpErrorCode(unwrapped.status, JSON.stringify(parsed)),
        { status: unwrapped.status },
      )
    }
    return unwrapped.data
  }

  /** `turn/stop`（尽力而为：失败只记 warn）。 */
  private async stopTurn(): Promise<void> {
    await this.stopTurnFor(this.conversationId)
  }

  /** 按指定 conversation 打断（自愈与旧会话清理共用）。 */
  private async stopTurnFor(conversationId: string): Promise<void> {
    try {
      await this.postJson(
        '/api/agent/conversation/turn/stop',
        { conversationId, turnRequestId: this.turnRequestId },
        STOP_TIMEOUT_MS,
      )
    } catch (error) {
      this.init.warn(
        `turn/stop 失败（不影响结果）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 终态上报（**吞掉失败**：客户端已经拿到回答了，不该因上报失败变成失败）。 */
  private async reportTerminalFor(
    conversationId: string,
    status: TurnStatus,
    error?: LlmError,
  ): Promise<void> {
    if (conversationId.length === 0) return
    const data: Record<string, unknown> = { status }
    if (error !== undefined) {
      data.failReason = error.message
      if (typeof error.failure.status === 'number') data.failCode = error.failure.status
    }
    try {
      await this.postJson(
        '/api/agent/conversation/event',
        { conversationId, eventType: 'conversation', data },
        SHORT_REQUEST_TIMEOUT_MS,
      )
    } catch (failure) {
      this.init.warn(
        `终态 ${status} 上报失败: ${failure instanceof Error ? failure.message : String(failure)}`,
      )
    }
  }

  // ── SSE 消费（硬约束 2 的落点）─────────────────────────────────

  /**
   * 消费 turn 的 SSE 到**服务端关闭连接**，边读边把增量帧推进队列。
   *
   * ⚠️ `message.finished === true` **不代表 turn 结束** —— 必须读到流自然结束。
   */
  private async consume(response: Response, queue: CatpawChunkQueue): Promise<void> {
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `catpaw: turn HTTP ${response.status}: ${errorDetail(text)}`,
        httpErrorCode(response.status, text),
        { status: response.status < 500 ? response.status : 502 },
      )
    }
    if (response.body === null) {
      throw new LlmError('catpaw: 上游 turn 没有响应体', 'SERVER', { status: 502 })
    }

    const translator = new CatpawTurnTranslator(queue, this.init.tools)
    const reader = response.body.getReader()
    const sse = new CatpawSseReader()
    let firstToken = false
    let streamError: unknown
    try {
      for (;;) {
        let result: { done: boolean; value: Uint8Array | undefined }
        try {
          result = await readWithIdleTimeout(
            reader,
            firstToken ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs(),
            'catpaw',
            this.controller?.signal,
            firstToken ? 'chunk' : 'first-token',
          )
          if (!result.done) firstToken = true
        } catch (error) {
          streamError = error
          break
        }
        if (result.done) break
        try {
          for (const event of sse.push(result.value ?? new Uint8Array())) {
            translator.consume(event)
          }
        } catch (error) {
          streamError = error
          break
        }
      }
      if (streamError === undefined) {
        try {
          const last = sse.finish()
          if (last !== undefined) translator.consume(last)
        } catch (error) {
          streamError = error
        }
      }
    } finally {
      reader.releaseLock()
    }

    // ── 收尾 ────────────────────────────────────────────────────
    if (streamError !== undefined) {
      translator.abort()
      await this.close(this.active ? 'failed' : 'canceled', toLlmError(streamError))
      throw streamError
    }
    translator.finish()
    // 注册表写回 + 终态上报
    this.writeBack(translator)
    if (translator.hasToolCalls()) {
      // ⚠️ **例外**：返回工具调用时**不报 completed** —— 上游语义里这一轮还没结束，
      // 客户端马上带着 tool 结果回来续接。报了会让上游以为本轮已完，续接失败。
      this.init.warn(
        `轮次 ${this.init.chatId} 返回 ${translator.toolCallCount()} 个工具调用，`
        + '等待客户端续接（不报 completed）',
      )
      this.release()
      return
    }
    await this.close('completed')
  }

  // ── 收尾 ───────────────────────────────────────────────────────

  /**
   * 成功轮次后的状态写回。
   *
   * | 有没有工具调用 | 是不是长会话 | 写什么 |
   * |---|---|---|
   * | 有 | 任意 | 「等工具结果」记录（`pendingCallIds` → call 索引） |
   * | 无 | 长会话 | 覆盖登记长会话记录（指纹链前移、清空待响应） |
   * | 无 | 无状态/并发冲突/辅助请求 | **不登记** |
   *
   * 指纹链 = **旧链** + 本轮**实际提交**的消息指纹 + 上游返回的那条消息指纹。
   * 「实际提交的」必须与发出去的一致：长会话只提交增量、工具续接只提交那条 tool
   * 消息 —— 多算会让下一次 `locateIncrement` 在客户端历史里定位到错误的位置。
   */
  private writeBack(translator: CatpawTurnTranslator): void {
    const pending = translator.toolCallIds()
    // 并发冲突时走的是独立 conversation：**不写映射**（写进去会让下一个同 session
    // 请求错误地续接到这条并行历史），与辅助请求同待遇。
    const sessionId = this.init.persistent && !this.init.auxiliary ? this.init.sessionId : ''
    if (sessionId.length === 0 && pending.length === 0) return

    const upstreamConversation = translator.conversationId()
    const chain = [
      ...this.prefix,
      ...this.submitted,
      catpawMessageFingerprint(asFingerprintInput(translator.responseMessage())),
    ]
    registerSession(sessionId, {
      conversationId: upstreamConversation.length > 0 ? upstreamConversation : this.conversationId,
      fingerprintChain: chain,
      modelType: this.init.resolution.modelType,
      accountId: this.init.accountId,
      uid: this.init.uid,
      pendingCallIds: pending,
      lastSequence: 0,
    })
  }

  /** 报一个终态并收尾（幂等）。 */
  private async close(status: TurnStatus, error?: LlmError): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.settled = true
    if (this.active) await this.reportTerminalFor(this.conversationId, status, error)
    this.release()
  }

  /** **只**释放占用并标记「已交接」（「返回工具调用」那条例外路径用）。 */
  private release(): void {
    this.settled = true
    if (this.init.persistent && this.init.sessionId.length > 0) {
      releaseInflight(this.init.sessionId)
    }
  }
}

/** 上游「会话正在执行中」的判定（文案匹配：该拒绝没有稳定的业务码）。 */
function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('执行中')
}

/** 从事件里取 `conversationId`。 */
function conversationIdOf(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  const value = event.conversationId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ─── 上游 SSE 读取（**按字节缓冲**）─────────────────────────────────

/**
 * 上游 SSE 逐行读取器。
 *
 * ## ⚠️ 为什么按**字节**缓冲而不是按字符串
 *
 * TCP 分片不会按行对齐，而思考内容里中文占大头（一个汉字 3 字节）—— 按 `String`
 * 逐段拼接时若分片正好落在字符中间，`TextDecoder` 会产生 U+FFFD（内容损坏）。
 * 因此这里只在**拿到完整行之后**才解码：半行留在 `tail` 里等下一个 chunk。
 *
 * 只认 `data:` 行；`[DONE]` / 空行 / 非法 JSON 一律忽略（上游偶尔混入心跳帧）。
 * 每帧过 `unwrapCatpawApiData`：业务码非 0/200 时**当场抛错**，不能静默跳过
 * （那会把上游的拒绝当成「流没内容」处理）。
 */
class CatpawSseReader {
  private tail = Buffer.alloc(0)

  /** 吃一段上游字节，吐出这一批能解析出的事件（已解包）。 */
  push(chunk: Uint8Array): unknown[] {
    const buffer = Buffer.from(chunk)
    this.tail = this.tail.length === 0 ? buffer : Buffer.concat([this.tail, buffer])
    const events: unknown[] = []
    for (;;) {
      const index = this.tail.indexOf(0x0a)
      if (index === -1) break
      const line = this.tail.subarray(0, index).toString('utf8')
      this.tail = this.tail.subarray(index + 1)
      const event = parseSseLine(line)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /**
   * 流结束：处理可能没有换行结尾的最后一行。
   *
   * 与「透传帧」的实现不同（那边要丢弃半行，否则客户端解析失败）：这里是**自己
   * 解析**，最后一行是完整 JSON 时能用上，残缺时 JSON 解析失败自然丢弃。
   */
  finish(): unknown | undefined {
    const line = this.tail.toString('utf8')
    this.tail = Buffer.alloc(0)
    return parseSseLine(line)
  }
}

/** 解析一行 SSE；非 `data:` 行 / 空行 / `[DONE]` / 非法 JSON 都返回 undefined。 */
function parseSseLine(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  const raw = trimmed.slice(5).trim()
  if (raw.length === 0 || raw === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // 无法解析的行忽略（上游偶尔混入心跳/注释帧）。
    return undefined
  }
  const unwrapped = unwrapCatpawApiData(parsed)
  if (!unwrapped.ok) {
    throw new LlmError(
      `catpaw: ${unwrapped.message}`,
      httpErrorCode(unwrapped.status, raw),
      { status: unwrapped.status },
    )
  }
  return unwrapped.data
}

// ─── 流式翻译（累积值 → 增量）──────────────────────────────────────

/**
 * 一轮 turn 的流式翻译状态机。
 *
 * ## 三处必须做**后缀差分**的地方（正文、思考、每个工具的参数）
 *
 * 上游每个事件的 `content[].text` / `reasoningContent` / `toolParams` 都是
 * 「到目前为止的全部内容」，不是增量。直接下发会让客户端看到重复内容。
 */
class CatpawTurnTranslator {
  /** 累积正文。 */
  private text = ''
  /** 累积思考。 */
  private reasoning = ''
  /** `toolCallId` → 累积参数与名字、块 index。 */
  private readonly tools = new Map<string, { args: string; name: string; index: number }>()
  /** tool_call 首见顺序（决定块 `index` 与写回注册表的待响应 id）。 */
  private readonly order: string[] = []
  /** 正文块 / 思考块的 `StreamChunk` index（懒创建）。 */
  private textIndex: number | undefined
  private reasoningIndex: number | undefined
  private nextIndex = 0
  /** 上游最后一条 assistant 消息（指纹链与工具调用提取用）。 */
  private message: unknown
  /** 是否收到过 `message.finished === true`。 */
  private completed = false
  /** 已发出的块数量（零块响应判据）。 */
  private blockCount = 0
  /** 是否已收尾（防止重复发 finish）。 */
  private finished = false

  constructor(
    private readonly queue: CatpawChunkQueue,
    private readonly selection: ReturnType<typeof normalizeCatpawTools>,
  ) {}

  /** 消费一个上游事件。 */
  consume(event: unknown): void {
    if (!isRecord(event)) return
    const error = responseError(event)
    if (error !== undefined) throw error
    const message = responseMessage(event)
    if (message === undefined) return
    this.emitDelta(message)
    if (message.finished === true) this.completed = true
    this.message = message
  }

  /** 把一条上游消息的累积值差分成增量帧。 */
  private emitDelta(message: Record<string, unknown>): void {
    const blocks = Array.isArray(message.content)
      ? message.content.filter(isRecord)
      : []
    const textBlocks = blocks.filter((block) => block.type === 'text')
    const text = textBlocks
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('')
    const reasoning = textBlocks
      .map((block) => (typeof block.reasoningContent === 'string' ? block.reasoningContent : ''))
      .join('')

    const textDelta = suffixAfter(text, this.text)
    const reasoningDelta = suffixAfter(reasoning, this.reasoning)
    this.text = text
    this.reasoning = reasoning

    if (textDelta !== undefined) {
      if (this.textIndex === undefined) {
        this.textIndex = this.nextIndex++
        this.queue.push({ type: 'block-start', index: this.textIndex, blockType: 'text' })
      }
      this.queue.push({ type: 'text-delta', index: this.textIndex, text: textDelta })
    }
    if (reasoningDelta !== undefined) {
      if (this.reasoningIndex === undefined) {
        this.reasoningIndex = this.nextIndex++
        this.queue.push({ type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' })
      }
      this.queue.push({ type: 'reasoning-delta', index: this.reasoningIndex, text: reasoningDelta })
    }
    this.emitToolDeltas(blocks)
  }

  /**
   * tool_use 块的增量差分。
   *
   * 上游客户端的形态是「首见发一帧 `{index,id,type,function:{name,arguments:''}}`，
   * 再另发一帧参数增量」；本适配器把这两帧合成一条 `tool-call-delta`
   * （带 `id` / `name` / `argumentsDelta`）—— 对 `BlockAssembler` 的效果完全相同，
   * 且少一次入队。
   *
   * ⚠️ **名称为空的 tool_call 一个 chunk 都不发**：`BlockAssembler` 会把没有
   * `block-end` 的 partial 也组装成 `name:''`，污染会话后让下游端点以 400 拒绝请求
   * （本仓库在 qoder 上踩过：整条会话报废）。
   */
  private emitToolDeltas(blocks: readonly Record<string, unknown>[]): void {
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const name = typeof block.toolName === 'string' ? block.toolName : ''
      if (name.length === 0) continue
      const rawId = typeof block.toolCallId === 'string' ? block.toolCallId : ''
      const id = rawId.length > 0 ? rawId : `${FALLBACK_TOOL_CALL_PREFIX}${this.order.length}`
      const args = typeof block.toolParams === 'string' ? block.toolParams : ''
      const previous = this.tools.get(id)
      if (previous === undefined) {
        const index = this.nextIndex++
        this.order.push(id)
        this.tools.set(id, { args, name, index })
        this.blockCount += 1
        this.queue.push({ type: 'block-start', index, blockType: 'tool-call' })
        this.queue.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(id),
          name,
          argumentsDelta: args,
        })
        continue
      }
      const argsDelta = suffixAfter(args, previous.args)
      const effectiveName = previous.name.length > 0 ? previous.name : name
      this.tools.set(id, { args, name: effectiveName, index: previous.index })
      if (argsDelta !== undefined) {
        this.queue.push({
          type: 'tool-call-delta',
          index: previous.index,
          id: ToolCallId(id),
          name: effectiveName,
          argumentsDelta: argsDelta,
        })
      }
    }
  }

  /** 是否返回了工具调用。 */
  hasToolCalls(): boolean {
    return this.tools.size > 0
  }

  /** 工具调用数量。 */
  toolCallCount(): number {
    return this.tools.size
  }

  /** 待响应的工具调用 id（写回注册表用）。 */
  toolCallIds(): string[] {
    return [...this.order]
  }

  /** 上游事件里的 conversationId。 */
  conversationId(): string {
    return conversationIdOf(this.message) ?? ''
  }

  /** 上游最后一条 assistant 消息（指纹链用）。 */
  responseMessage(): unknown {
    return this.message ?? {}
  }

  /** 流中出错：不再发任何帧（后台任务会报终态）。 */
  abort(): void {
    this.finished = true
  }

  /**
   * 收尾：`tool_choice` 校验 → 块收尾 → usage → finish。
   *
   * ## 收尾校验（都是 502：上游没按约定返回，属上游数据问题）
   *
   * - 重复 `toolCallId`；
   * - `tool_choice: 'none'` 却返回 tool_call；
   * - `'required'` 未返回；
   * - 指定 function 未返回。
   */
  finish(): void {
    if (this.finished) return
    this.finished = true
    const toolCalls = this.toolCallIds()

    // 重复 toolCallId：上游一条消息里出现同名 id 会让客户端的 tool_use/tool_result
    // 配对错乱，属于上游数据问题，不能静默接受。
    if (new Set(toolCalls).size !== toolCalls.length) {
      throw new LlmError('catpaw: 上游返回重复的 tool_call_id', 'SERVER', { status: 502 })
    }
    const mode = this.selection.mode
    if (mode === 'none' && toolCalls.length > 0) {
      throw new LlmError('catpaw: tool_choice=none 时上游仍返回了 tool_call', 'SERVER', { status: 502 })
    }
    if (mode === 'required' && toolCalls.length === 0) {
      throw new LlmError('catpaw: tool_choice=required 时上游未返回 tool_call', 'SERVER', { status: 502 })
    }
    if (mode === 'named') {
      const wanted = this.selection.named ?? ''
      const matched = this.order.some((id) => this.tools.get(id)?.name === wanted)
      if (!matched) {
        throw new LlmError(
          `catpaw: tool_choice 要求调用 ${wanted}，但上游未返回该工具`,
          'SERVER',
          { status: 502 },
        )
      }
    }

    // 残缺参数：与 `openai-compat` 同策 —— 报 max-tokens（不完整、可重试），
    // 而不是把残缺 JSON 补成 `{}` 伪造出合法外观。
    let truncated = false
    for (const id of this.order) {
      const entry = this.tools.get(id)
      if (entry !== undefined && isTruncatedArguments(entry.args)) truncated = true
    }

    // 块收尾（`block-end` 是**权威覆盖**：即便前面发过全部 delta，这里才是落块内容）。
    if (this.textIndex !== undefined && this.text !== '') {
      this.blockCount += 1
      this.queue.push({ type: 'block-end', index: this.textIndex, block: { type: 'text', text: this.text } })
    }
    if (this.reasoningIndex !== undefined && this.reasoning.trim() !== '') {
      this.blockCount += 1
      this.queue.push({
        type: 'block-end',
        index: this.reasoningIndex,
        block: { type: 'reasoning', text: this.reasoning },
      })
    }
    for (const id of this.order) {
      const entry = this.tools.get(id)
      if (entry === undefined) continue
      this.queue.push({
        type: 'block-end',
        index: entry.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(id),
          name: entry.name,
          // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**。
          arguments: isTruncatedArguments(entry.args) ? entry.args : normalizeToolArguments(entry.args),
        },
      })
    }

    // usage（**口径修正**）：上游 `prompt_tokens` 只是本轮增量输入、`total_tokens`
    // 是**会话累计**占用，而客户端要的是「本次请求的完整输入」。
    const usage = usageFromEvent(this.message)
    if (usage !== undefined) this.queue.push({ type: 'usage', usage })

    let reason: FinishReason
    if (toolCalls.length > 0) reason = { kind: 'tool-calls' }
    else if (!this.completed) {
      // ⚠️ 上游 SSE 在消息完成前结束：内容可能被截断。与 `openai-compat` 的
      // `truncatedStream` 同策 —— 报 `max-tokens`（不完整、可重试），而不是
      // 报 `stop`（那等于告诉 harness「模型正常答完了」，静默结束）。
      reason = { kind: 'max-tokens' }
    } else if (truncated) reason = { kind: 'max-tokens' }
    else reason = { kind: 'stop' }
    this.queue.push({ type: 'finish', reason: resolveEmptyResponseReason(reason, this.blockCount) })
  }
}

/** 事件里的 assistant 消息（`message` / `data.message` / `result.message`）。 */
function responseMessage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(event.message)) return event.message
  for (const key of ['data', 'result']) {
    const nested = event[key]
    if (isRecord(nested) && isRecord(nested.message)) return nested.message
  }
  return undefined
}

/** 事件里的错误对象（`error` / `data.error` / `result.error`）→ `LlmError`。 */
function responseError(event: Record<string, unknown>): LlmError | undefined {
  let error: unknown = event.error
  if (error === undefined) {
    for (const key of ['data', 'result']) {
      const nested = event[key]
      if (isRecord(nested) && nested.error !== undefined) {
        error = nested.error
        break
      }
    }
  }
  if (error === undefined) return undefined
  const record = isRecord(error) ? error : undefined
  const message = typeof record?.message === 'string' && record.message.length > 0
    ? record.message
    : typeof record?.msg === 'string' && record.msg.length > 0
      ? record.msg
      : `上游返回错误 code=${String(record?.code ?? 'unknown')}`
  const rawStatus = typeof record?.httpStatus === 'number' ? record.httpStatus : 502
  const status = rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 502
  return new LlmError(`catpaw: ${message}`, httpErrorCode(status, JSON.stringify(event)), { status })
}

/**
 * 事件里的 usage（`usage` / `contextInfo.usage`），已按本家口径修正。
 *
 * ```text
 * 上游：prompt 只算本轮增量、total 是会话累计
 * 输出：input  = max(prompt, total - completion)   （完整输入）
 *       total  = input + completion
 *       cache_read_tokens 恒空（上游无此数据，不估算）
 * ```
 */
function usageFromEvent(event: unknown): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} | undefined {
  if (!isRecord(event)) return undefined
  let usage: unknown = event.usage
  if (!isRecord(usage)) {
    const contextInfo = event.contextInfo
    if (isRecord(contextInfo)) usage = contextInfo.usage
  }
  if (!isRecord(usage)) return undefined
  const prompt = readNumber(usage.prompt_tokens) ?? readNumber(usage.promptTokens) ?? 0
  const completion = readNumber(usage.completion_tokens) ?? readNumber(usage.completionTokens) ?? 0
  const upstreamTotal = readNumber(usage.total_tokens) ?? readNumber(usage.totalTokens) ?? 0
  // `max` 的意义：上游若在某次实现里让 total 小于 completion（异常/钳位），
  // `total - completion` 会是负数或偏小值，取 prompt 原值比取负数稳。
  const inputTokens = upstreamTotal > 0 ? Math.max(prompt, upstreamTotal - completion) : prompt
  return { inputTokens, outputTokens: completion, totalTokens: inputTokens + completion }
}

/** 数字字段（浮点形态也收；其余给 undefined）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 对象判定。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── 帧队列（把「读到底」与「客户端消费」解耦）──────────────────────

/**
 * 一个最小的异步队列。
 *
 * ## 为什么需要它
 *
 * 硬约束 2 要求「turn 的 SSE 必须消费到服务端关闭连接」，而客户端随时可能断流。
 * 若把上游消费写成一个 async generator 直接 `yield` 给调用方，客户端一断流
 * 生成器就被 dispose，上游那次 turn 再没人读完 → 上游停在「执行中」，下一轮
 * round 被拒。故消费跑在**独立后台任务**里，帧经本队列交给调用方。
 *
 * ⚠️ 队列有**上限**（{@link MAX_QUEUE}）：客户端长时间不消费时不能让内存无界
 * 增长。超出上限的帧被丢弃 —— 那只可能发生在「客户端已经不要了」的场景，
 * 而后台任务仍在把上游读到底（这才是硬约束要保证的事）。
 */
class CatpawChunkQueue {
  private readonly items: Array<{ chunk?: StreamChunk; error?: unknown }> = []
  private waiter: (() => void) | undefined

  push(chunk: StreamChunk): void {
    if (this.items.length >= MAX_QUEUE) return
    this.items.push({ chunk })
    this.wake()
  }

  fail(error: unknown): void {
    this.items.push({ error })
    this.wake()
  }

  /** 唤醒挂起的消费者。 */
  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** 逐项取出；`error` 项抛出（并结束迭代）。 */
  async *drain(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.items.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve
        })
      }
      const item = this.items.shift()
      if (item === undefined) continue
      if (item.error !== undefined) throw item.error
      if (item.chunk !== undefined) yield item.chunk
    }
  }
}

// ─── 工具续接的原始历史探测 ────────────────────────────────────────

/**
 * 取一条 assistant 消息声明的工具调用 id 列表。
 *
 * ⚠️ **两种形态都要认**：
 * - DSH 原生形态：`content` 里的 `{type:'tool-call', id}` 块；
 * - OpenAI wire 形态：顶层的 `tool_calls: [{id}]` 数组。
 *
 * 只认后者会让原生形态下的工具续接**永远判不出来**，于是每轮都走「全新会话全量
 * 重提」（功能不受影响但多传历史、且上游会看到重复的历史）。
 */
function toolCallIdsOfMessage(message: unknown): string[] {
  if (!isRecord(message)) return []
  const ids: string[] = []
  const calls = message.tool_calls
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (isRecord(call) && typeof call.id === 'string' && call.id.length > 0) ids.push(call.id)
    }
  }
  const content = message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type !== 'tool-call' && block.type !== 'tool_use') continue
      const id = typeof block.id === 'string' && block.id.length > 0
        ? block.id
        : typeof block.toolCallId === 'string' ? block.toolCallId : ''
      if (id.length > 0) ids.push(id)
    }
  }
  return ids
}

/**
 * 历史末尾那段「待响应的 assistant tool_call」的起点下标。
 *
 * 从后往前走，找最近一条「带非空 tool_calls 的 assistant」，再要求它之后的消息
 * **全是 tool 且把每个 tool_call_id 都覆盖到**：
 * - 覆盖完整 → 这就是待响应集合（返回它的下标）；
 * - 全是 tool 但没覆盖完 → 本轮**不是**工具续接（返回 undefined）；
 * - 中间混了别的角色 → 继续往前找。
 */
function pendingToolCallStart(messages: readonly unknown[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'assistant') continue
    const remaining = toolCallIdsOfMessage(message)
    if (remaining.length === 0) continue
    let valid = true
    for (const item of messages.slice(index + 1)) {
      if (!isToolResultMessage(item)) {
        valid = false
        break
      }
      const callId = toolCallIdOf(item)
      if (callId !== undefined) {
        const position = remaining.indexOf(callId)
        if (position !== -1) remaining.splice(position, 1)
      }
    }
    if (!valid) continue
    return remaining.length === 0 ? index : undefined
  }
  return undefined
}

/** 历史末尾待响应工具调用的 id 列表。 */
function pendingCallIds(messages: readonly unknown[]): string[] {
  const start = pendingToolCallStart(messages)
  if (start === undefined) return []
  return toolCallIdsOfMessage(messages[start]).map((id) => id.trim()).filter((id) => id.length > 0)
}

/** 是否为工具结果消息（两种 harness 形态都认）。 */
function isToolResultMessage(message: unknown): boolean {
  if (!isRecord(message)) return false
  if (message.role === 'tool') return true
  if (message.role !== 'user') return false
  const content = message.content
  if (!Array.isArray(content)) return false
  return content.some((block) => isRecord(block) && block.type === 'tool-result')
}

/** 取一条工具结果消息的 `tool_call_id`（四种来源）。 */
function toolCallIdOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) return message.toolCallId
  if (typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0) return message.tool_call_id
  const content = message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (typeof block.toolCallId === 'string' && block.toolCallId.length > 0) return block.toolCallId
      if (typeof block.tool_call_id === 'string' && block.tool_call_id.length > 0) return block.tool_call_id
    }
  }
  const source = message.source
  if (isRecord(source) && typeof source.callId === 'string' && source.callId.length > 0) return source.callId
  return undefined
}

// ─── 注册 ──────────────────────────────────────────────────────────

/**
 * 在 `ctx.llm` 上注册 catpaw provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerCatpawLlm(ctx: Context, options: CatpawAdapterOptions): CatpawAdapter {
  const product = options.product ?? CATPAW
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new CatpawAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}

/** 供调用方在账号切换时作废会话映射（导出以免调用方直接依赖注册表模块）。 */
export { clearAccount as clearCatpawAccountSessions }
