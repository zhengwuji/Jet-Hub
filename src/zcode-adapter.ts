/**
 * ZCode LLM 适配器（无状态、OpenAI 兼容、按地区参数化）。
 *
 * ## 实现是**一套**，实例按地区给
 *
 * `ZcodeAdapter` 持有一个 `ZcodeProduct`，两个实例（国内版 / 国际版）由
 * `index.ts` 各注册一次 —— 与 autoclaw / accio 同一手法（两个地区是两个
 * provider、同一份实现）。
 *
 * ## 上游协议
 *
 * 推理走 **OpenAI 兼容**端点：`POST {openaiBaseUrl}/chat/completions`，
 * `Authorization: Bearer {token}`，body 原样透传（与 raccoon 同构）。
 * 因此本家**没有任何要改写的字段**：不做模型改名、不注入思考档位
 * （后者是「没证据就不注入」的正确默认 —— 源码里本家没有实现档位注入）。
 *
 * ## 为什么只做 `coding-plan` 通道（**刻意的取舍，不是漏做**）
 *
 * 上游同一份订阅登录态可以走**两条互不相通的通道**：
 *
 * | 通道 | 端点 | 鉴权 | 协议 |
 * |---|---|---|---|
 * | `coding-plan`（本实现） | `{openaiBaseUrl}/chat/completions` | `accessToken` | OpenAI Chat |
 * | `start-plan` | `{zcode}/api/v1/zcode-plan/anthropic/v1/messages` | 套餐 `jwt` | Anthropic Messages |
 *
 * `start-plan` **每条请求**都要一枚阿里云验证码令牌（缺了回 `400 {"code":3007}`），
 * 而那枚令牌**只能由桌面端 WebView 铸造**（阿里云侧有铸造风控，Node 侧无 DOM
 * 铸不出来），再经 `POST /api/zcode/captcha` 入池。本插件是**宿主侧 Node 进程**，
 * 没有 WebView，因此该通道**在本插件里不可用**。
 *
 * 与其做一个「每次请求都 3007」的假通道，不如如实只提供 `coding-plan` ——
 * 与 AGENTS.md「不支持的 provider 必须如实返回 null 状态，不得臆造」同一取舍。
 * 编码套餐到期的用户会看到上游如实报的 `429 套餐已到期`，而不是一个
 * 永远说不清的 3007。
 *
 * ## 令牌来源与续期
 *
 * 本适配器只从账号池读 `access_token`（与 raccoon 同一取法），
 * **没有**续期：`refresh` 会如实报错让用户重新登录（见 `isZcodeRefreshable`）。
 * 这不是偷懒而是事实：上游没有 refresh 端点，套餐 JWT 只带 `iat` 不带 `exp`。
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
  zcodeCredentialExpiresAtMs,
  zcodeIdentityHeaders,
  type ZcodeCredential,
} from './zcode.js'
import { ZCODE, type ZcodeFallbackModel, type ZcodeProduct } from './zcode-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 远端模型条目（已归一）。 */
export interface ZcodeRemoteModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

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

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: ZcodeFallbackModel): ZcodeRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
  }
}

/** {@link ZcodeAdapter} 的构造选项。 */
export interface ZcodeAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<ZcodeCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ 本家**不可续期**：这里的语义是「如实报错让用户重新登录」，
   * 而不是「换个新令牌」。见模块头。
   */
  refresh: () => Promise<void>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** ZCode 模型适配器。 */
export class ZcodeAdapter extends LlmAdapter {
  private readonly product: ZcodeProduct
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, ZcodeFallbackModel>
  /** 模型清单（本家是静态表，无远程刷新，故构造期即可确定）。 */
  private readonly models: ZcodeRemoteModel[]

  constructor(private readonly options: ZcodeAdapterOptions) {
    super()
    this.product = options.product ?? ZCODE
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    this.models = this.product.fallbackModels.map(fallbackToRemote)
  }

  /**
   * 注入的 fetch（测试用）；默认为全局 fetch。
   *
   * ⚠️ 必须是 getter 而非构造期赋值：构造期求值会把 `globalThis.fetch` 冻结成
   * 当时的引用，使运行时装上的 fetch 补丁对本适配器发出的请求失效。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 描述本适配器拥有的 provider 路由。 */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.models.map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(model: ZcodeRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? this.models
      : this.models.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 本家目录不给倍率（上游无该字段），故 name 就是纯展示名。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.models.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? fallback?.name ?? model,
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
    const entry = this.models.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`zcode: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('zcode: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
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

    // 1. 取凭据。⚠️ 本家**不可续期**，故这里不做「过期则先续期」——
    //    那只会得到一句「请重新登录」。凭据是否可用交给上游的 401 如实表达。
    let credential = await this.options.resolveCredential()
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('zcode: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /** 前置 system 消息（若有）。 */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /** 构造请求体（**原样透传**：上游就是 OpenAI 协议，本家没有要改写的字段）。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠️ tools 必须真的下发到请求体**顶层**：漏发会让模型在正文里臆造
      // XML 工具调用，harness 认不出 → 任务终止。
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

    const headers = (): Record<string, string> => ({
      Accept: '*/*',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      // 客户端身份头：上游按客户端形态识别请求（见 zcodeIdentityHeaders）。
      ...zcodeIdentityHeaders(),
    })

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(`${this.product.openaiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          body: buildBody(),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `zcode: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    let response = await send()
    // 401/403：调一次 refresh（本家是「如实报错」语义），再取一次凭据重试。
    // ⚠️ 与其余 provider 的差别：这里**不会**拿到新令牌，但保留这条路径是为了
    // 让账号卡片上手动刷新过的凭据有机会被重新读到。
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential()
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('zcode: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await send()
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      // 400 必须看**响应体**才能区分「上下文超限」与「普通请求错误」：前者归为
      // CONTEXT_WINDOW_EXCEEDED 才会触发 DSH 的 context-overflow 自动压缩恢复。
      // 该判定已统一在 `src/http-error.ts`（与其余 openai-compat 家族同一份实现）。
      //
      // ⚠️ 上游的 401 是**空体**（实测 Content-Length: 0），故 401 要给一句
      // 可执行的话，而不是「上游错误」四个字。
      const detail = errorDetail(errorText)
      const message = response.status === 401
        ? 'ZCode 凭证被上游拒绝（编码套餐认访问令牌）：请在账号页重新登录该账号'
        : detail
      throw new LlmError(`zcode: ${message}`, httpErrorCode(response.status, errorText), { status: response.status })
    }

    // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理。
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'zcode',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
    })
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_ZCODE_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_ZCODE_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 zcode provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`。
 * `ctx.llm` 不透传自定义方法，故须由调用方持有引用并在 `index.ts` 的
 * `modelAdapters` 里登记。
 */
export function registerZcodeLlm(ctx: Context, options: ZcodeAdapterOptions): ZcodeAdapter {
  const product = options.product ?? ZCODE
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new ZcodeAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
