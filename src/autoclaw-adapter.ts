/**
 * AutoClaw LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST {upstreamBaseUrl}/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy / Raccoon 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder / cline /
 * loomy / raccoon；autoclaw 是第五个消费者。若实测发现字段形态不符，
 * 应在**本文件**内做局部适配，而不是改共享层。
 *
 * ## 与 raccoon 适配器的三处差异（其余逐条照抄）
 *
 * 1. **URL**：`${product.upstreamBaseUrl}/chat/completions`（基址已含 `/autoclaw`）；
 * 2. **请求头**：`autoclawBrandHeaders(...)`（含 `X-Authorization` 与
 *    `X-Request-Model`，且**绝不带 `X-Harness-Type`**，见 `src/autoclaw.ts`）；
 * 3. **模型名与 system 提示词都要改写**：body 的 `model` 用**剥前缀后的
 *    model**，`messages` 先过 `normalizeAutoclawSystemMessages`（上游有
 *    system 白名单校验，这是能否跑通的关键）。
 *
 * ## ⚠️ 本适配器最特殊的一处：SSE 必须**回写模型名**
 *
 * 上游 SSE 的每一帧都带 `model` 字段，而它回的是**上游自己的路由 id**
 * （`zaicoding_glm-5.3`），不是客户端请求时用的目录 id（`glm-5.3`）。
 * DSH 侧会拿帧里的 `model` 与会话里持久化的模型名比对，不一致时会报
 * 「响应模型与请求模型不符」并中断这一轮 —— 表现为「发出去就失败」。
 *
 * `consumeOpenAiSse` **不透传这个能力**（它只解析 delta/usage/tool_calls，
 * 完全不看 `model`），故这里在交给它之前**包一层流**：逐块按行解析，
 * 把每一帧的 `model` 改写成客户端原名，再重新组装成 `Response`。
 *
 * 为什么是「包一层流」而不是「改 `consumeOpenAiSse`」：后者是 qoder / cline /
 * loomy / raccoon 共用的实现，为一家加一条改写逻辑会让另外四家的行为
 * 一起变化（那四家的上游本来就不回 `model`，改了也不会更好，只会多一层风险）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
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
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  autoclawBrandHeaders,
  autoclawCredentialExpiresAtMs,
  normalizeAutoclawSystemMessages,
  resolveAutoclawRoute,
  type AutoclawCredential,
  type AutoclawRemoteModel,
} from './autoclaw.js'
import { AUTOCLAW, type AutoclawFallbackModel, type AutoclawProduct } from './autoclaw-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 本适配器注册的 provider 路由名（等价于 `AUTOCLAW.id`）。 */
export const PROVIDER = 'autoclaw'

/**
 * 远端模型条目的类型**转发**。
 *
 * ⚠️ 类型定义在 `src/autoclaw.ts`（与 `parseAutoclawModelConfig` 同处，
 * 避免「解析函数在一处、类型在另一处」的漂移）。这里转发一份是为了让
 * 调用方既可以从 `autoclaw.js` 也可以从本模块导入同一个类型 ——
 * 接线时少一个「从哪个文件导入」的来回确认。
 */
export type { AutoclawRemoteModel } from './autoclaw.js'

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 兜底表条目转远端形状。
 *
 * `creditConsumptionLevel` 兜底表里没有（它是远端目录才下发的字段），
 * 故这里不填 —— 展示名会退化成纯模型名，这是诚实的表现
 * （**不编造倍率**，见 {@link autoclawModelDisplayName}）。
 */
function fallbackToRemote(model: AutoclawFallbackModel): AutoclawRemoteModel {
  return {
    id: model.id,
    routeId: model.routeId,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
    supportsToolCall: true,
  }
}

/**
 * 最终展示名：有计费档位文案时**原样附在名字后面**。
 *
 * ⚠️ **倍率必须拼进 `name`**（不是 `description`）：composer 的模型切换
 * 菜单只渲染 `name`，`description` 仅用于 `/model` 弹窗
 *（这是被用户报障纠正过的结论，见 `src/raccoon.ts` 的同类注释）。
 *
 * ⚠️ **不要编造数字映射**：上游 `creditConsumptionLevel` 给的是文案
 * （「低」/「中」/「高」），没有可换算的数字。把它映射成 `x1` / `x2` / `x3`
 * 是**凭空发明计费口径**，用户据此做的取舍全是错的。故有文案就原样展示、
 * 没有就不加后缀。
 */
export function autoclawModelDisplayName(model: AutoclawRemoteModel): string {
  const level = model.creditConsumptionLevel?.trim() ?? ''
  return level.length > 0 ? `${model.name} · ${level}` : model.name
}

/** 去掉展示名里的计费后缀（`resolveModel` 的 `name` 不带价格）。 */
function bareDisplayName(name: string): string {
  return name.replace(/ · .*$/, '')
}

/** {@link AutoclawAdapter} 的构造选项。 */
export interface AutoclawAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<AutoclawCredential | undefined>
  /** 凭据失效时的处理（AutoClaw 有 refresh 端点，会真续期）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<AutoclawRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link AUTOCLAW}（国内版）。 */
  product?: AutoclawProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 客户端原始请求头（**小写键**）。
   *
   * 只用于透传三个白名单头（会话 id / agent id / 调用 id，见
   * `autoclawBrandHeaders`）。返回 undefined 时一个都不透传 ——
   * 凭空造会话 id 会让上游把两次无关请求归进同一会话。
   */
  clientHeaders?: () => Record<string, string> | undefined
}

/** AutoClaw 模型适配器。 */
export class AutoclawAdapter extends LlmAdapter {
  private readonly product: AutoclawProduct
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, AutoclawFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: AutoclawRemoteModel[] | undefined

  constructor(private readonly options: AutoclawAdapterOptions) {
    super()
    this.product = options.product ?? AUTOCLAW
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 注入的 fetch（测试用）；默认为全局 fetch。
   *
   * ⚠️ 必须是 getter 而非构造期赋值：构造期求值会把 `globalThis.fetch` 冻结成
   * 当时的引用，使运行时装上的 fetch 补丁（上下文压缩代理即靠此接管模型
   * 流量）对本适配器发出的请求失效 —— 表现为压缩静默不生效。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串，直接回退到本产品的 id。
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
    return source.map((model) => ({ id: model.id, name: autoclawModelDisplayName(model) }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<AutoclawRemoteModel[]> {
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

  private inputModalitiesFor(model: AutoclawRemoteModel | undefined): readonly ('text' | 'image')[] {
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
      // 计费档位文案拼进 name（不是 description）：composer 的模型切换菜单
      // 只渲染 name。文案**原样展示**，不做数字映射（见 autoclawModelDisplayName）。
      name: autoclawModelDisplayName(model),
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带计费后缀**（与 qoder/trae/loomy/raccoon 一致）：
    // 价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? bareDisplayName(autoclawModelDisplayName(entry)) : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️ 远端非法值必须过滤（见 positiveMaxTokens）：不声明就让 DSH 用默认值。
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
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
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`autoclaw: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('autoclaw: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential()
    if (credential === undefined || isExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('autoclaw: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 路由解析：把 DSH 回传的**目录 id** 映射成上游要的 routeId / model。
    const route = resolveAutoclawRoute(this.product, options.model, all)

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 出站 system 规范化（**上游有白名单校验，这一步决定能否跑通**）。
     *
     * ⚠️ 顺序不能反：必须先拼 DSH 的 `system`（拼在 `messages` 之前），
     * 再整段过 `normalizeAutoclawSystemMessages` —— 该函数会保证**首条**
     * 是 system 且以身份句开头，而「首条」在拼之前还不存在。
     */
    const wireMessages = normalizeAutoclawSystemMessages(
      messages,
      options.system !== undefined && options.system.length > 0 ? options.system : undefined,
    )

    /** 构造请求体（`model` 用**剥前缀后的** model，不是目录 id）。 */
    const buildBody = (): string => JSON.stringify({
      model: route.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
    })

    const clientHeaders = this.options.clientHeaders?.()

    const headers = (): Record<string, string> => autoclawBrandHeaders(
      credential?.access_token ?? '',
      route.routeId,
      clientHeaders,
    )

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(`${this.product.upstreamBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: buildBody(),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `autoclaw: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send()
    // 401/403 时续期一次并重试（AutoClaw 有 refresh_token 轮换）。
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential()
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('autoclaw: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await send()
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      // 400 必须看**响应体**才能区分「上下文超限」与「普通请求错误」：前者归为
      // CONTEXT_WINDOW_EXCEEDED 才会触发 DSH 的 context-overflow 自动压缩恢复。
      // 该判定统一在 `src/http-error.ts`（openai-compat 家族共同导入）。
      throw new LlmError(
        `autoclaw: ${errorDetail(errorText)}`,
        httpErrorCode(response.status, errorText),
        { status: response.status },
      )
    }

    // ⚠️ **SSE 逐帧回写模型名**（见模块头）：上游回的是它自己的路由 id，
    // 与客户端请求的目录 id 不同，DSH 会因此判「响应模型不符」而中断。
    const rewritten = rewriteSseModel(response, route.requested)

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(rewritten, { signal: options.signal }, {
      label: 'autoclaw',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
    })
  }
}

/** 凭据是否已过期（无过期信息时视为不过期）。 */
function isExpired(credential: AutoclawCredential): boolean {
  const expiresAt = autoclawCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/**
 * 把 SSE 流里每帧的 `model` 改写成客户端请求时的名字。
 *
 * ## 为什么必须自己包一层
 *
 * `consumeOpenAiSse` 完全不看 `model` 字段，而 DSH 会拿帧里的 `model` 与
 * 会话持久化的模型名比对 —— 上游回的是路由 id（`zaicoding_glm-5.3`），
 * 客户端用的是目录 id（`glm-5.3`），不一致会让这一轮被判失败。
 *
 * ## 实现要点（三处都是踩过的坑）
 *
 * 1. **按行处理，不按块**：一个网络块可能只含半行，也可能含多行。
 *    必须自己维护跨块的**残行缓冲**，否则半行会被当成完整帧解析失败而丢弃。
 * 2. **只改 `model` 字段，其余字节原样透传**：重新 `JSON.stringify` 整帧
 *    会改变键序与空白（对解析无影响，但会让「抓包对比原始帧」这类排查
 *    失去可比性）；这里做的是**定点替换**。
 * 3. **`data:` 前缀后的可选空格要保留**：`data: {...}` 与 `data:{...}`
 *    两种形态上游都出现过，改写时按原样保留前缀文本。
 *
 * 非 `data:` 行、`[DONE]`、非 JSON 帧一律**原样透传** —— 它们没有 `model`
 * 字段可改，而丢掉它们会让 `consumeOpenAiSse` 的「这不是 SSE」诊断
 * 失去原文片段。
 */
export function rewriteSseModel(response: Response, requested: string): Response {
  if (response.body === null) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let carry = ''

  /** 改写一行；无法解析或无 model 字段时原样返回。 */
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:')) return line
    const payload = line.slice(5)
    const trimmed = payload.trim()
    if (trimmed.length === 0 || trimmed === '[DONE]') return line
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return line
      const record = parsed as Record<string, unknown>
      if (!('model' in record) || record.model === requested) return line
      // 定点替换：只换 `"model":"…"` 这一段，其余字节不动。
      record.model = requested
      const rewritten = JSON.stringify(record)
      // 保留 `data:` 与负载之间的原始空白（可能没有空格）。
      const prefixLength = payload.length - payload.trimStart().length
      return `data:${payload.slice(0, prefixLength)}${rewritten}`
    } catch {
      return line
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // ⚠️ **必须循环到「要么入队、要么关闭」为止**（实测踩到的死锁）：
      // ReadableStream 只在「有新的读请求」或「上一轮 pull 期间又被要求 pull」
      // 时才重新调用 `pull`。若某次 pull 读到一个**不含换行**的网络块
      // （半行 —— 首块几乎必然如此），却空手返回，消费者那个**已经挂起**的
      // 读请求就再也没人满足它，整个流永久卡住。
      //
      // 症状极具迷惑性：上游在发、适配器在收，但 DSH 一个 chunk 都拿不到，
      // 最终报首 token 超时 —— 看起来像「上游不响应」。
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          // 收尾：残行没有换行符时也要处理（部分上游最后一帧不带 `\n`）。
          if (carry.length > 0) {
            controller.enqueue(encoder.encode(rewriteLine(carry)))
            carry = ''
          }
          controller.close()
          return
        }
        const text = carry + decoder.decode(value, { stream: true })
        const lines = text.split('\n')
        // 最后一段可能是半行：留到下一块（与 `consumeOpenAiSse` 的缓冲同策）。
        carry = lines.pop() ?? ''
        // 本块还没凑出完整行：继续读，**不能空手返回**（见上方注释）。
        if (lines.length === 0) continue
        controller.enqueue(encoder.encode(lines.map(rewriteLine).join('\n') + '\n'))
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(stream, { status: response.status, headers: response.headers })
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_AUTOCLAW_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_AUTOCLAW_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 autoclaw provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerAutoclawLlm(ctx: Context, options: AutoclawAdapterOptions): AutoclawAdapter {
  const product = options.product ?? AUTOCLAW
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new AutoclawAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
