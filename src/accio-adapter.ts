/**
 * Accio LLM 适配器（国际版 / 国内版共用一份实现，差异全在产品配置里）。
 *
 * ## 为什么**不能**复用 `openai-compat.ts`
 *
 * 那套件的前提是「请求体是 OpenAI Chat、响应是 OpenAI SSE」，Accio 两条都不满足：
 *
 * | | 其余九家 | accio |
 * |---|---|---|
 * | 请求体 | OpenAI Chat（或自家信封） | **Gemini 风格 protobuf-JSON**（`contents` / `system_instruction` / `tools`） |
 * | 鉴权 | `Authorization: Bearer` | **body 里的 `token` 字段** |
 * | 响应 | OpenAI SSE（`choices[].delta`） | **ADK 自定义帧**（`content.parts` / `turn_complete`） |
 *
 * 故请求体由 `accio.ts` 的 `buildAccioChatBody` 组装、响应由本文件的
 * `consumeAccioSse` 解析。**只复用** `serializeMessages`（消息序列化：工具配对
 * 剔除、历史泄漏清洗 —— 那部分与厂商无关）与 `sse.ts` 的通用件。
 *
 * ## 三个必须真的做到的点
 *
 * 1. **`appKey` 头必带且非空** —— 缺了它上游**不报错**，而是以 HTTP 200 +
 *    正常帧形态回一段「Your app version is no longer supported…」的普通文本，
 *    会被当成模型输出吐给下游（用户看到模型莫名其妙说了句版本提示）。
 * 2. **首帧预读** —— 业务错误藏在帧里（HTTP 200 + `error_code`），必须在产出
 *    任何字节**之前**就能发现并抛出，否则错误文案会被当成正文吐出去。
 * 3. **半行缓冲必须跟着走** —— 首帧预读会把一个 chunk 里的完整行解析掉，
 *    同一 chunk 末尾可能留着半行（`data: {"content":{"pa`）。缓冲区不跟着交给
 *    续传方，那半行就永远丢了（且**只在帧恰好被切在 chunk 边界时复现**，
 *    是最难查的那类静默丢内容）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
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
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  buildAccioChatBody,
  buildAccioGenerateContentUrl,
  isAccioExpiring,
  newAccioSseState,
  openAiToAccioContents,
  openAiToAccioTools,
  parseAccioSseLine,
  type AccioCredential,
  type AccioSseState,
} from './accio.js'
import { ACCIO, type AccioFallbackModel, type AccioProduct } from './accio-product.js'
import { errorDetail, httpErrorCode, isTransportError, serializeMessages, collectImages } from './openai-compat.js'
import {
  createBlankReasoningSuppressor,
  createReasoningLoopDetector,
  hasUsableToolName,
  isReasoningLoopGuardEnabled,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveEmptyResponseReason,
  stripCourseLeakIfEnabled,
} from './sse.js'

/** 本适配器注册的 provider 路由名（等价于 `ACCIO.id`）。 */
export const PROVIDER = 'accio'

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在 `defaultMaxTokens` 的
 * 硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: AccioFallbackModel): AccioRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    // ⚠️ 兜底表**不声明**输出上限（上游没给，见 `accio-product.ts`）。
    supportsImage: model.supportsImage,
    supportsReasoning: model.reasoningEfforts.length > 0,
    reasoningEfforts: model.reasoningEfforts,
    reasoningPlacement: model.reasoningPlacement,
    upstreamKey: model.id,
  }
}

/** 远端模型条目（已归一；与 `AccioAuth.fetchModels` 的产出同形）。 */
export interface AccioRemoteModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  supportsImage: boolean
  supportsReasoning: boolean
  reasoningEfforts: readonly string[]
  /** 思考档位落点（见 `accio-product.ts` 的对照表）。 */
  reasoningPlacement: 'top' | 'properties'
  /** 发给上游的模型名（可能是代号）。 */
  upstreamKey: string
}

/** {@link AccioAdapter} 的构造选项。 */
export interface AccioAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<AccioCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ 与 raccoon 的差别：本家的续期**不看临期窗口**（`force = true`）——
   * 走到这里说明上游已经用 401 明确拒绝了当前 token，而 token 完全可能
   * 「时间上还新但已被服务端失效」，只看窗口会拿回同一个被拒的 token。
   */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<AccioRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link ACCIO}。 */
  product?: AccioProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Accio 模型适配器。 */
export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, AccioFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: AccioRemoteModel[] | undefined

  constructor(private readonly options: AccioAdapterOptions) {
    super()
    this.product = options.product ?? ACCIO
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 注入的 fetch（测试用）；默认为全局 fetch。
   *
   * ⚠️ 必须是 getter 而非构造期赋值：构造期求值会把 `globalThis.fetch` 冻结成
   * 当时的引用，使运行时装上的 fetch 补丁（billion-context 上下文压缩代理即靠
   * 此接管模型流量）对本适配器发出的请求失效 —— 表现为压缩静默不生效。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
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
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<AccioRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: AccioRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
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
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与其余 provider 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️ 上游不给输出上限 → 不声明（`positiveMaxTokens` 只是防御远端给了非法值）。
    // 兜底表**没有** `maxTokens` 字段（上游没给，见 `accio-product.ts`），故只读远端。
    const maxTokens = positiveMaxTokens(entry?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    // 思考档位：这是「思考强度」选择器出现在模型选择里的唯一入口。
    const efforts = entry?.reasoningEfforts ?? fallback?.reasoningEfforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
        // ⚠️ **刻意不声明 `defaultEffort`**：Accio 没有「默认档位」这个概念
        // （桌面端不指定就不发 `reasoning_effort`，由上游自己决定）。声明一个
        // 会凭空改变上游行为，而不声明时 DSH 也不会注入任何值 —— 正是我们要的。
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      // ⚠️ 复用共享件而不是本地重写：它**递归**处理 `tool-result` 内层
      // （收集侧是任意深度，序列化侧若只走一层，深层图片会被收进 refs 却在
      // 序列化时静默丢弃）。本家与其余四个 provider 在这一处的需求完全相同。
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`accio: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('accio: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让序列化层产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential()
    if (credential === undefined || isAccioExpiring(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('accio: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 消息序列化（复用共享件：工具配对剔除、历史泄漏清洗都在那里做过）
    const messages = serializeMessages(options.messages, imageUrls)
    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进数组**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     * 这里的 `wireMessages` 只用于转换，故直接构造成 ADK 信封的两个字段。
     */
    const wireMessages: Array<Record<string, unknown>> = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : [...messages]

    const converted = openAiToAccioContents(wireMessages)
    const tools = openAiToAccioTools(options.tools)
    const upstreamKey = entry?.upstreamKey ?? options.model

    // 3. 组装 ADK 信封。⚠️ 思考档位的**落点**由模型决定（见 `accio-product.ts`）。
    const built = buildAccioChatBody(
      this.product,
      credential,
      {
        model: upstreamKey,
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.stop === undefined ? {} : { stop: options.stop },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        reasoningEfforts: entry?.reasoningEfforts ?? [],
        reasoningPlacement: entry?.reasoningPlacement ?? 'top',
      },
      converted.contents,
      converted.systemInstruction,
      tools,
    )

    const url = buildAccioGenerateContentUrl(this.product, built.requestId)
    const headers = (): Record<string, string> => ({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-language': 'en',
      'x-app-version': this.product.appVersion,
      'x-package-region': this.product.packageRegion,
      // ⚠️ **必带非空**：缺了它上游以 HTTP 200 回一段「版本不再支持」的普通
      // 文本，形态与正常回答一样，会被当成模型输出吐给下游。
      appKey: this.product.appKey,
      // 设备指纹（可选，缺省也能跑；带上更接近真实客户端）。
      ...credential?.device_id === undefined || credential.device_id.length === 0
        ? {} : { utdid: credential.device_id },
      version: this.product.appVersion,
      // ⚠️ **刻意不带 `Authorization`**：本家的鉴权全在 body 的 `token` 里，
      // 多一个上游没见过的头只会徒增风控面。
    })

    /** 发送一次推理请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(built.body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `accio: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send()
    // 401/403 时强制续期一次并重试（本家有 refresh_token 轮换）。
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential()
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('accio: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await send()
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      // 400 必须看**响应体**才能区分「上下文超限」与「普通请求错误」：前者归为
      // CONTEXT_WINDOW_EXCEEDED 才会触发 DSH 的 context-overflow 自动压缩恢复。
      // 该判定统一在 `src/http-error.ts`（与其余 provider 同一份实现）。
      throw new LlmError(
        `accio: ${errorDetail(errorText)}`,
        httpErrorCode(response.status, errorText),
        { status: response.status },
      )
    }

    // ⚠️ 业务失败以 HTTP 200 + 帧内 `error_code` 返回，由 consumeAccioSse
    // 的**首帧预读**拦在产出任何字节之前。
    yield* this.consumeAccioSse(response, options)
  }

  /**
   * 消费 ADK SSE 流，转成 `StreamChunk`。
   *
   * ## 首帧预读（**不可省**）
   *
   * 上游的业务错误**不体现在 HTTP 状态码上**（常是 200 + 帧里的 `error_code`）。
   * 若边读边发，第一帧的错误文案可能已经被当成正文吐出（下游看到的是
   * `[400] invalid params` 这种「模型说的话」）。故先把第一个**有内容或结束**
   * 的帧拦在返回之前：是错误帧就抛错，此刻一个字节都还没下发。
   *
   * ## 半行缓冲为什么不会丢
   *
   * SSE 的 `data:` 行可能被切在**任意**位置，因此逐 chunk 解码后必须先拼进
   * 一个跨 chunk 的缓冲、再按 `\n` 切完整行。本实现把「读一个 chunk → 切行」
   * 抽成闭包 `readChunk`，缓冲 `buffer` 是**整个流共享的闭包变量** ——
   * 预读阶段留下的半行（`data: {"content":{"pa`）因此天然被主循环接着用。
   *
   * ⚠️ 这正是「把缓冲拼回流头」要防的那个坑：若预读另起一套缓冲、或把剩余
   * 半行丢掉，续传方会把后半截当成一条新行去 JSON 解析 → 解析失败 →
   * **这一帧的内容静默丢掉**，且只在「帧恰好被切在 chunk 边界」时复现。
   */
  private async *consumeAccioSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    /** 思考死循环检测（见 `createReasoningLoopDetector`）。 */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /** 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。 */
    const suppressor = createBlankReasoningSuppressor()
    /** 上游工具调用的累积状态（分片聚合；跨帧共享，故由 `accio.ts` 持有）。 */
    const sseState: AccioSseState = newAccioSseState()
    /**
     * 已播报的工具调用块：上游累积表下标 → 本地块信息。
     *
     * ⚠️ 两张表**下标一一对应**（同一个 `delta.index`），故收尾时用下标直接取
     * 参数。`Map` 的遍历顺序是插入顺序（= 上游下标顺序），因此收尾遍历它
     * 就得到了与上游一致的调用顺序，不需要另存一个 `toolOrder` 数组。
     */
    const toolBlocks = new Map<number, { index: number; callId: string; name: string; announced: boolean }>()
    /** 已播报（名字可用）的调用数（决定收尾的 finish reason）。 */
    let announcedCalls = 0
    let finishReason: string | undefined
    let turnComplete = false
    let sawAnyFrame = false
    let rawSnippet = ''

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let firstTokenReceived = false

    /**
     * 处理一帧；返回本帧产出的 chunk。
     *
     * 抽成闭包是为了让「首帧预读」与「主循环」共用**同一套**翻译逻辑 ——
     * 两处各写一份迟早分叉（Rust 侧的 `prefetch_stream_head` 与
     * `drive_stream` 正是共用同一个 `Translator`）。
     */
    const consumeFrame = (frame: ReturnType<typeof parseAccioSseLine>): StreamChunk[] => {
      if (frame === undefined) return []
      const out: StreamChunk[] = []
      if (frame.finishReason !== undefined) finishReason = frame.finishReason
      if (frame.usage !== undefined) {
        out.push({
          type: 'usage',
          usage: {
            inputTokens: frame.usage.inputTokens,
            outputTokens: frame.usage.outputTokens,
            ...frame.usage.totalTokens === undefined ? {} : { totalTokens: frame.usage.totalTokens },
            ...frame.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: frame.usage.cacheReadTokens },
            ...frame.usage.reasoningTokens === undefined ? {} : { reasoningTokens: frame.usage.reasoningTokens },
          },
        })
      }
      if (frame.text !== undefined && frame.text.length > 0) {
        let block = blocks.find((candidate) => candidate.kind === 'text')
        if (block === undefined) {
          block = { index: nextIndex++, kind: 'text', text: '' }
          blocks.push(block)
          out.push({ type: 'block-start', index: block.index, blockType: 'text' })
        }
        block.text += frame.text
        out.push({ type: 'text-delta', index: block.index, text: frame.text })
      }
      if (frame.reasoning !== undefined && frame.reasoning.length > 0) {
        if (loopGuard !== undefined) {
          if (loopGuard.observe(frame.reasoning)) loopDetected = true
        }
        if (!loopDetected) {
          // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，于是
          // 既不建块、也不消耗 `nextIndex`（见 helper 注释）。
          const emit = suppressor.feed(frame.reasoning)
          if (emit !== undefined) {
            let block = blocks.find((candidate) => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              out.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
            }
            // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本。
            block.text = suppressor.text()
            out.push({ type: 'reasoning-delta', index: block.index, text: emit })
          }
        }
      }
      for (const delta of frame.toolCalls ?? []) {
        const accumulated = sseState.toolCalls[delta.index]
        const callId = delta.id !== undefined && delta.id.length > 0
          ? delta.id
          : accumulated !== undefined && accumulated.id.length > 0
            ? accumulated.id
            : `call_${delta.index}`
        let block = toolBlocks.get(delta.index)
        if (block === undefined) {
          block = { index: nextIndex++, callId, name: '', announced: false }
          toolBlocks.set(delta.index, block)
        }
        block.callId = callId
        if (delta.name !== undefined && delta.name.length > 0) block.name = delta.name
        // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` / `trae-adapter.ts`
        // 同因同修）：只跳过收尾的 `block-end` 不够 —— `BlockAssembler` 会把没有
        // `block-end` 的 partial 也组装成 `name:''`，污染会话后让下游端点 400。
        if (!block.announced) {
          if (!hasUsableToolName(block.name)) continue
          block.announced = true
          announcedCalls += 1
          // 下标一一对应（见 `toolBlocks` 的说明），故上游累积的参数直接取。
          const accumulatedArgs = sseState.toolCalls[delta.index]?.args ?? delta.argumentsDelta
          out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
          out.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(callId),
            name: block.name,
            argumentsDelta: accumulatedArgs,
          })
          continue
        }
        if (delta.argumentsDelta.length === 0) continue
        out.push({
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(callId),
          ...block.name.length > 0 ? { name: block.name } : {},
          argumentsDelta: delta.argumentsDelta,
        })
      }
      return out
    }

    /** 帧内业务错误 → `LlmError`（额度类带 429、鉴权类带 401）。 */
    const frameError = (frame: NonNullable<ReturnType<typeof parseAccioSseLine>>): LlmError => {
      const parts = [
        frame.errorCode === undefined ? '' : `[${frame.errorCode}]`,
        frame.errorMessage ?? '',
      ].filter((value) => value.length > 0)
      const text = parts.join(' ')
      const lower = text.toLowerCase()
      const auth = lower.includes('unauthorized') || lower.includes('not logged in')
        || lower.includes('invalid token') || lower.includes('token expired')
      const quota = lower.includes('quota') || lower.includes('insufficient')
        || lower.includes('exceeded') || lower.includes('积分') || lower.includes('余额')
        || lower.includes('额度') || lower.includes('limit reached')
      if (auth) return new LlmError(`accio: 上游错误：${text}`, 'AUTH', { status: 401 })
      if (quota) return new LlmError(`accio: 上游错误：${text}`, 'RATE_LIMIT', { status: 429 })
      return new LlmError(`accio: 上游错误：${text}`, 'SERVER')
    }

    /** 读一个 chunk 并切出完整行（把新行交给回调）。 */
    const readChunk = async (): Promise<{ done: boolean; lines: string[] }> => {
      let result
      try {
        const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
        const phase = firstTokenReceived ? 'chunk' : 'first-token'
        result = await readWithIdleTimeout(reader, timeoutMs, 'accio', options.signal, phase)
        if (!result.done) firstTokenReceived = true
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof LlmError) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `accio: sse transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
      if (result.done || result.value === undefined) return { done: true, lines: [] }
      const decoded = decoder.decode(result.value, { stream: true })
      if (rawSnippet.length < RAW_SNIPPET_LIMIT) {
        rawSnippet = (rawSnippet + decoded).slice(0, RAW_SNIPPET_LIMIT)
      }
      buffer += decoded
      const lines: string[] = []
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
      return { done: false, lines }
    }

    /**
     * **已切好但尚未消费的行队列**。
     *
     * ⚠️ 这个队列不是可选的优化，它是「半行缓冲」在**两个阶段之间**的正确交接：
     * 首帧预读会把一个 chunk 里的**全部**完整行一次切出来，然后在第一条有内容
     * 的帧处停下 —— 那时 `lines` 里**后面那些行还没被解析**。若直接丢弃它们
     * （早期实现的写法），那几条帧的内容就**静默消失**，而表现与「半行丢内容」
     * 完全一样：只在帧恰好落在 chunk 边界时复现。
     *
     * 于是两个阶段共享**同一个** `pendingLines`：预读只消费到它停下的那一条，
     * 剩下的留给主循环按序消费。`buffer` 同理（它是「还没成行的尾巴」）。
     */
    const pendingLines: string[] = []

    /**
     * 解析并消费一条行；返回 `true` 表示本轮该停（结束 / 预读命中）。
     *
     * @param duringPrefetch - 预读阶段：错误帧**抛出**（此刻零字节已下发，
     *   换号无损）；主循环阶段：错误帧同样抛出（上游已中途出错，没有更晚的
     *   补救点）。
     */
    const consumeLine = (line: string, duringPrefetch: boolean): { stop: boolean; chunks: StreamChunk[] } => {
      const frame = parseAccioSseLine(line, sseState)
      if (frame === undefined) return { stop: false, chunks: [] }
      sawAnyFrame = true
      if (frame.errorCode !== undefined || frame.errorMessage !== undefined) {
        throw frameError(frame)
      }
      const chunks = consumeFrame(frame)
      if (frame.turnComplete || frame.done) {
        turnComplete = true
        return { stop: true, chunks }
      }
      if (!duringPrefetch) return { stop: false, chunks }
      // 预读阶段：第一条**有内容**的帧即停（它之后的帧还在 `pendingLines` 里，
      // 由主循环接手）。
      const hasContent = frame.text !== undefined || frame.reasoning !== undefined
        || (frame.toolCalls !== undefined && frame.toolCalls.length > 0)
      return { stop: hasContent, chunks }
    }

    /** 已预读、待补发的 chunk（首帧预读产出）。 */
    const prefetched: StreamChunk[] = []

    try {
      // ── 首帧预读：把第一个有内容 / 结束 / 错误的帧拦在产出任何字节之前 ──
      let prefetchDone = false
      while (!prefetchDone) {
        // 先消费队列里剩下的行（上一轮 chunk 切出来但没来得及解析的）。
        while (pendingLines.length > 0) {
          const line = pendingLines.shift()
          if (line === undefined) break
          const outcome = consumeLine(line, true)
          prefetched.push(...outcome.chunks)
          if (outcome.stop) {
            prefetchDone = true
            break
          }
        }
        if (prefetchDone) break
        const { done, lines } = await readChunk()
        if (done) break
        pendingLines.push(...lines)
      }

      for (const chunk of prefetched) yield chunk

      // ── 主循环 ──────────────────────────────────────────────────
      while (!turnComplete) {
        // 预读阶段留下的行优先消费（见 `pendingLines` 的说明）。
        if (pendingLines.length === 0) {
          const { done, lines } = await readChunk()
          if (done) break
          pendingLines.push(...lines)
        }
        let stopped = false
        while (pendingLines.length > 0) {
          const line = pendingLines.shift()
          if (line === undefined) break
          const outcome = consumeLine(line, false)
          for (const chunk of outcome.chunks) yield chunk
          if (outcome.stop) {
            stopped = true
            break
          }
        }
        if (stopped) break
        // ★ 止损：命中思考死循环后**中止上游**，否则输出额度照烧。
        // ⚠️ 只 cancel **reader**，绝不 abort `options.signal`：后者是调用方信号，
        // abort 会被上层报成「用户取消」而非「标记为不完整」的 max-tokens。
        if (loopDetected) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 一个 data: 帧都没有 = 这根本不是 SSE（网关直接回了一段 JSON 错误体）。
    // 若被静默忽略，就又是一次「没有任何报错就中断」。
    if (!sawAnyFrame) {
      const snippet = rawSnippet.trim()
      throw new LlmError(
        snippet.length > 0
          ? `accio: 响应不是 SSE（没有任何 data: 帧），原文片段：${snippet}`
          : 'accio: 上游返回空响应（没有任何 SSE 帧）',
        'SERVER',
      )
    }

    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、或被清洗
     * 成空串的块。用 `blocks.length` 会把「零块响应」误判成「有块」，于是静默
     * 结束的缺陷原样保留。
     */
    let blockCount = 0
    const textBlock = blocks.find((block) => block.kind === 'text')
    // ⚠️ 遍历 `toolBlocks` 而不是另存一个 `toolOrder` 数组：`Map` 的插入顺序
    // 就是上游下标顺序，两处各存一份迟早分叉（曾出现「收尾漏发已播报的块」）。
    for (const [upstreamIndex, block] of toolBlocks) {
      // 未播报（名字始终为空）的块**不发** —— 它会污染会话，让下游端点 400。
      if (!block.announced || !hasUsableToolName(block.name)) continue
      const raw = sseState.toolCalls[upstreamIndex]?.args ?? ''
      blockCount += 1
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId),
          name: block.name,
          // 仅把「无参数工具下发的空分片」补成 `{}`；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试（补成 `{}` 会伪造出合法外观）。
          arguments: isTruncatedArguments(raw) ? raw : normalizeToolArguments(raw),
        },
      }
    }
    if (textBlock !== undefined) {
      const cleaned = stripCourseLeakIfEnabled(textBlock.text)
      // ⚠️ 空块会污染会话，且 DSH 的 `EMPTY_RESPONSE` 契约禁止产出空内容块。
      if (cleaned !== '') {
        blockCount += 1
        yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: cleaned } }
      }
    }
    const reasoningBlock = blocks.find((block) => block.kind === 'reasoning')
    // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
    if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
      const suppressed = suppressor.text()
      // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是**权威
      // 覆盖**：即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可。
      const reasoningText = loopDetected && loopGuard?.cutAt !== undefined
        ? suppressed.slice(0, loopGuard.cutAt)
        : suppressed
      const cleaned = stripCourseLeakIfEnabled(reasoningText)
      if (cleaned !== '') {
        blockCount += 1
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: cleaned } }
      }
    }

    // ── finish reason ──────────────────────────────────────────────
    //
    // 三种「不完整」都必须报告 max-tokens 而非 tool-calls：
    // - `MAX_TOKENS`：被显式截断；
    // - 未收到 `turn_complete`：连接被中途掐断，参数必然是半截 JSON；
    // - 参数无法解析：分片丢失（并行工具调用时偶发）。
    // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，模型收到莫名
    // 错误后陷入重试循环；报告 max-tokens 则丢弃并重试。
    const argsTruncated = [...sseState.toolCalls].some((entry) => isTruncatedArguments(entry.args))
    const droppedUnnamedCalls = [...toolBlocks.values()].some((block) => !block.announced)
    const upstream = (finishReason ?? '').toLowerCase()
    const reason = loopDetected
      ? { kind: 'max-tokens' as const }
      : upstream.includes('max_tokens') || upstream.includes('length')
        || !turnComplete
        || argsTruncated
        // 丢弃了无名 tool-call、且**没有**任何可用调用留下来时，本步否则会以
        // `stop` 收场 —— 模型本意要调工具、harness 却认为「正常答完了」。
        || (droppedUnnamedCalls && announcedCalls === 0)
        ? { kind: 'max-tokens' as const }
        : upstream.includes('tool_calls') || upstream.includes('tool_use') || announcedCalls > 0
          ? { kind: 'tool-calls' as const }
          : { kind: 'stop' as const }
    // 零内容块响应否则会以 `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令
    // 禁止的静默结束（helper 只在 `kind === 'stop'` 时改写）。
    yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) }
  }
}

/** 诊断用原始文本上限（字符）。 */
const RAW_SNIPPET_LIMIT = 400

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_ACCIO_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_ACCIO_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 accio provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerAccioLlm(ctx: Context, options: AccioAdapterOptions): AccioAdapter {
  const product = options.product ?? ACCIO
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new AccioAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
