/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { AccountPool } from './account-pool.js'
import { isQoderExpired, type QoderCredential } from './qoder.js'
import { QoderEncryptedInfer, type QoderInferRequest } from './qoder-wasm.js'
import { unwrapQoderEnvelopeStream } from './qoder-envelope.js'
import { QODER, type QoderFallbackModel, type QoderProduct } from './qoder-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export const PROVIDER = 'qoder'

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /** 从凭据存储解析凭据。 */
  resolveCredential: () => Promise<QoderCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 补齐凭据缺失的 **`uid`**（加密推理必需）。
   *
   * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
   * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
   * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
   * `Signature invalid (101)`（真实缺陷，用户报障）。
   *
   * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
   * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
   *
   * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
   */
  resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class QoderAdapter extends LlmAdapter {
  private readonly product: QoderProduct
  private readonly fetchImpl: typeof fetch
  /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, QoderFallbackModel>

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.product = options.product ?? QODER
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model]),
    )
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型接受的输入模态。
   *
   * 按**模型**判定（兜底表的 `supportsImage`），不是按 provider 一刀切。
   * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   *
   * ⚠️ 兜底表是本地估计值，不是远端权威数据 —— 见 `qoder-product.ts` 的说明。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    return this.fallbackIndex.get(model)?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 模型目录。
   *
   * **不发任何网络请求**：Qoder 的模型列表端点需要 WASM 签名
   * （`qoder_auth_wasm`），本插件不实现，故恒用产品兜底表。
   * 见设计文档 §2.6 与 `qoder-product.ts` 的 `fallbackModels` 说明。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const source = this.product.fallbackModels
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。见 qoderDisplayName。
      name: qoderDisplayName(model),
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    // 上下文窗口：兜底表是**本地估计值**。未知模型不编造 context
    // （宁可让 DSH 用默认值，也不要报一个假的窗口大小）。
    if (entry !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
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
    // 图片能力按**模型**判定（兜底表 supportsImage）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `qoder: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('qoder: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
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

    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential()
    if (credential === undefined || isQoderExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('qoder: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 补齐 **uid**（加密推理必需）。
    //
    // ⚠️ `uid` 是后加字段，旧凭据里没有；缺它时 WASM 会产出**签名无效**的
    // 请求，服务端回 `Signature invalid (101)`（真实缺陷，用户报障）。
    // 这里调用注入的钩子补一次（实现会调 userinfo 并回写凭据）。
    credential = await this.ensureUid(credential)

    // 3. 走**加密推理**路径（客户端真实链路，认模型目录 key）。
    //
    // 目录 key（`qfmodel` 等）只有这条路能用；公开端点是另一套通用名。
    const messages = serializeMessages(options.messages, imageUrls)
    const systemText = options.system !== undefined && options.system.length > 0
      ? options.system
      : undefined

    /** 最后一条 user 消息即本轮提问；其余作为历史。 */
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastUser = userMessages.at(-1)
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const history = messages
      .filter((m): m is { role: string; content: string } =>
        typeof m.role === 'string' && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }))

    const fallback = this.fallbackIndex.get(options.model)

    /** 用给定凭据构造一次加密请求（首次与 401 重试共用，避免两处漂移）。 */
    const buildRequest = async (c: QoderCredential): Promise<QoderInferRequest> => {
      const client = await QoderEncryptedInfer.create({
        user: {
          uid: c.uid!,
          securityOauthToken: c.security_oauth_token ?? c.access_token,
        },
        machineId: c.machine_id,
        metadata: { ...this.product.clientMetadata },
        host: this.product.encryptedInferBase,
      })
      return client.prepareInfer({
        modelKey: options.model,
        userText,
        ...(systemText !== undefined ? { systemText } : {}),
        isReasoning: fallback?.supportsThinking ?? false,
        history,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
        // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
        ...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
        ...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
        // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
        //
        // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
        // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
        // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
        // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
        // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
        //
        // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
        // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
        business: { type: 'agent' },
      })
    }

    // 3. 发送（⚠️ 头必须原样透传：Authorization 是 WASM 生成的
    //    `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid）
    let response = await this.sendEncrypted(await buildRequest(credential), options)
    if (response.status === 401 || response.status === 403) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential()
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('qoder: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = await this.ensureUid(refreshed)
      response = await this.sendEncrypted(await buildRequest(credential), options)
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
    }

    // 4. 剥掉加密端点的响应信封，交给统一的 OpenAI SSE 消费器
    yield* consumeOpenAiSse(unwrapQoderEnvelopeStream(response, 'qoder'), { signal: options.signal }, {
      label: 'qoder',
      firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
      chunkTimeoutMs: resolveChunkTimeoutMs(),
    })
  }

  /**
   * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
   *
   * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
   * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
   * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
   */
  private async ensureUid(credential: QoderCredential): Promise<QoderCredential> {
    if (credential.uid !== undefined && credential.uid.length > 0) return credential

    const patched = await this.options.resolveUid?.(credential)
    if (patched?.uid !== undefined && patched.uid.length > 0) return patched

    throw new LlmError(
      'qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）',
      'MISSING_CREDENTIAL',
    )
  }

  /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
  private async sendEncrypted(
    request: { url: string; headers: Record<string, string>; body: string },
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.set('Accept', 'text/event-stream')
    try {
      return await this.fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`qoder: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/**
 * 生成模型选择器里显示的名字：`Qwen3.8-Flash · 免费` / `GLM-5.3 · x0.6`。
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * 展示规则（Qoder 目录的 `price_factor` 语义与腾讯系不同，故单独实现）：
 * - `priceFactor === 0` → **「免费」**，不显示 `x0`（用户关心的是"不要钱"）；
 * - 其余 → `x<值>`（如 `x0.6`）；
 * - 仅在**促销生效中**（`promotion.active === true`）才附折扣角标 ——
 *   `active: false` 表示当前不在错峰时段，显示折扣价会让用户按折扣价预期、
 *   实际被按原价计费。
 */
function qoderDisplayName(model: QoderFallbackModel): string {
  const parts: string[] = []
  if (model.priceFactor === 0) {
    parts.push('免费')
  } else if (model.priceFactor !== undefined) {
    parts.push(`x${model.priceFactor}`)
  }
  if (model.promotion?.active === true && model.promotion.badgeZh !== undefined) {
    parts.push(model.promotion.badgeZh)
  }
  return parts.length > 0 ? `${model.name} · ${parts.join(' ')}` : model.name
}

/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到
 * `qoder` / `llm-qoder`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因
 * 未注册 namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 */
export function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): void {
  const product = options.product ?? QODER
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([product.id], new QoderAdapter(options))
}
