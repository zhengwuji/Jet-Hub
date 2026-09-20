/**
 * Qoder 产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * Qoder 的协议与现有四个 provider **都不同源**：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder |
 * |------|----------|-----------------|-----------|-------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码轮询 |
 * | 续期 | refresh_token | refresh_token | refresh_token + 身份字段 | refresh_token + machine_id |
 * | 签名 | HMAC-SHA256 | 无 | 无 | 无（推理） |
 *
 * 且 `BuddyProduct.id` 是字面量联合 `'buddy' | 'workbuddy'`，加值会牵动
 * `productById` / `registerBuddyLlm` 一串调用点。故这里定义**平行**的
 * `QoderProduct` —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * 全部来自本机 Qoder 0.3.4 产物逆向 + 实测，详见
 * `docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 * 逆向目标：
 * - `C:\Users\Jet\AppData\Local\Programs\Qoder\resources\app.asar`
 * - `...\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
 *   （字符串经 `_$d = base64 → XOR("tqrRVttEZQ4G")` 编码）
 */

/** 兜底模型目录中的一个条目（字段口径见下方 `QODER_FALLBACK_MODELS` 的注释）。 */
export interface QoderFallbackModel {
  /** 模型目录 **key**（如 `qfmodel`）。

   * ⚠️ **必须走加密端点** `agent_chat_generation` —— 公开的
   * `/model/v1/chat/completions` 不认这些 key（见 `src/qoder-wasm.ts`）。 */
  id: string
  /** 展示名（取自目录 `display_name`）。 */
  name: string
  /** 上下文窗口（远端 `max_input_tokens` 实测值）。 */
  contextWindow: number
  /** 是否接受图片输入（远端 `is_vl`；实测 17 个全为 true）。 */
  supportsImage?: boolean
  /** 是否支持思考档位（远端 `is_reasoning`）。 */
  supportsThinking?: boolean
  /** 是否免费额度模型（远端 `is_free`）。 */
  isFree?: boolean
  /**
   * 计费倍率（目录 `price_factor`）。
   *
   * ⚠️ 字段名是 **`price_factor`**，不是 `cost_multiplier`（后者不存在于
   * Qoder 目录；`cost_multiplier` 是有道 LobsterAI 的字段，别混淆）。
   *
   * ⚠️ **它是「目录下发那一刻」的生效价，会随错峰窗口变化** ——
   * 窗口内是折后价、窗口外是原价。因此本表存的是**采集时刻的值**，
   * 展示时须结合 {@link QoderModelPromotion} 的窗口**本地推算**当前价
   * （见 `qoderDisplayName`），不要把它当成恒定原价。
   *
   * 实测本机 catalog（2026-09-21，17 个 chat 模型）：
   * `qfmodel`（Qwen3.8-Flash）= **0**、`qmodel` = 0.04、`qmodel_latest`/
   * `dfmodel`/`gfmodel` = 0.1 …… `smodel`（Sonus）= 8。
   *
   * **0 是合法值**（免费），故不能用 `!== undefined && > 0` 过滤 ——
   * 那会把用户最关心的免费模型漏掉。
   */
  priceFactor?: number
  /**
   * 促销前的原价倍率（目录 `original_price_factor` / `before_promotion_price_factor`）。
   *
   * 与 {@link priceFactor} 是**两个独立字段**：实测 `qfmodel` 的
   * `price_factor=0` 而 `original_price_factor=0.1`，即免费额度是在原价
   * 0.1 的基础上打折到 0。只在两者不同时才值得展示。
   */
  originalPriceFactor?: number
  /**
   * 错峰折扣（目录 `promotion`）。
   *
   * ⚠️ **`active` 是「目录下发那一刻」的快照，不可作为长期判据**：
   * 用户长时间不重启客户端时它会过期。真实窗口由 `windowStart`/`windowEnd`
   * 描述且稳定，故展示时**按当前时间本地推算**是否在窗口内
   * （见 `qoderDisplayName` 的 `promotionActiveNow`），`active` 仅作回退。
   *
   * 实测三档（`qfmodel` 无 promotion；`qmodel_38max` 是 4 折、
   * `qmodel_latest` 是 2 折），窗口统一为 22:00–08:00（Asia/Singapore）。
   *
   * 关系式（实测三条全部吻合）：
   * `priceFactor === beforePromotionPriceFactor × discountFactor`
   * —— 故可据原价与折扣推算任意时刻的生效价。
   */
  promotion?: QoderModelPromotion
  /** 可用思考档位（远端 `thinking_config.enabled.efforts` 的键）。 */
  efforts?: readonly string[]
}

/** 目录 `promotion` 字段（错峰折扣）。 */
export interface QoderModelPromotion {
  /**
   * 目录下发时是否处于折扣时段内（远端 `active`）—— **快照值，会过期**。
   *
   * 长期运行的会话里它会与真实时段脱节，故只作回退：
   * `windowStart`/`windowEnd` 齐备时以**本地时间推算**为准。
   */
  active: boolean
  /** 折扣后倍率（远端 `discount_factor`），如 0.4 = 4 折。 */
  discountFactor?: number
  /** 折扣前倍率（远端 `before_promotion_price_factor`）。 */
  beforePromotionPriceFactor?: number
  /** 时段起点（远端 `window_start`，如 `22:00`）。 */
  windowStart?: string
  /** 时段终点（远端 `window_end`，如 `08:00`）。 */
  windowEnd?: string
  /**
   * 中文角标文案（远端 `badge.zh`，如「错峰 4 折」）。
   *
   * ⚠️ **当前不参与展示**：Qoder 的折扣已统一为「原价→折后价」箭头形态
   * （与 TRAE / buddy 一致），角标与箭头信息**冗余**（0.2/0.5 本就是 4 折）。
   * 字段保留是因为它是目录下发的原始数据，重新采集时仍可对照；
   * 若将来要恢复角标，改 `qoderDisplayName` 即可。
   */
  badgeZh?: string
}

/**
 * Qoder 产品配置。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` 平行，字段全部为 Qoder 实际需要的。
 */
export interface QoderProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'qoder'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 登录与 OAuth 基址。 */
  authBase: string
  /** OpenAPI 基址（轮询、续期、userinfo 都走它）。 */
  openApiBase: string
  /**
   * 推理基址（**公开的 OpenAI 兼容端点**）。
   *
   * ⚠️ **不是** `environments.prod.inferBaseUrl`（那是 `https://api2.qoder.sh`）。
   * 推理实际走独立的 model server host `api2-v2.qoder.sh`
   * （源码 `Sja = { prod: "api2-v2.qoder.sh", ... }`）。
   *
   * ⚠️ 该端点只认**通用模型名**（`qwen-flash` 等），**不认目录 key**
   * （`qfmodel` → `Unsupported model`）。要按目录 key 推理必须走
   * `encryptedInferBase`。
   */
  inferBase: string
  /**
   * **加密推理**基址（`agent_chat_generation` 端点所在 host）。
   *
   * ⚠️ 与 `inferBase` **不是同一个 host**：加密端点走 `api2.qoder.sh`
   * （即源码里的 `environments.prod.inferBaseUrl`），实测写错会 404。
   * 请求体由 `src/qoder-wasm.ts` 加密，该端点**认模型目录 key**。
   */
  encryptedInferBase: string
  /**
   * OAuth client id —— **prod 环境用的那一个**（源码 `J_a` 解码值）。
   *
   * ⚠️ 两个 client id 的对应关系**容易读反**，这里记录正确语义：
   *
   * ```js
   * async function __a(A, e, t, i = true, n, r) {   // i 是第 4 参
   *   ...client_id: i ? J_a : G_a
   * }
   * // 调用点（loginWithDeviceFlow）：
   * ({authUrl, pollForCompletion} = await A(o, s, i, n(), r.signal, a))
   * //                                          ↑ n() = isProd()
   * // $Oa(){return "prod"===db()}
   * ```
   *
   * 即第 4 参是 **`isProd()`（布尔）**：prod → `true` → **`J_a`**；
   * 非 prod（daily/test）→ `false` → `G_a`。
   *
   * **真实缺陷**（用户报障）：早期把第 4 参误读成「useIdeClientId」，
   * 于是 prod 用了 `G_a`，GitHub 授权回调后被服务端拒绝，页面报
   * 「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」。
   */
  clientId: string
  /**
   * 非 prod 环境（daily / test）用的 client id（源码 `G_a`）。
   *
   * 仅作记录 —— 本插件只支持 prod，**不要**拿它当 prod 的 client id。
   */
  testClientId: string
  /** 请求体 `metadata.context` 的客户端标识（源码 `Fp()` 的 CLI 默认值）。 */
  clientMetadata: {
    client_type: string
    business_product: string
    business_type: string
    scene: string
  }
  /** `User-Agent` 头取值前缀（源码拼 `qoder/{version}`）。 */
  userAgentPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 模型列表不可用时的兜底模型目录（本插件不发远端请求，恒用它）。
   *
   * ⚠️ **只有模型列表需要 WASM 签名**，不要据此推断其它端点：
   * 推理（`model/v1/chat/completions`）、用户信息（`api/v1/userinfo`）、
   * **积分余额（`sash/api/v2/me/usage`）** 都只需 Bearer。
   * 早期因「模型列表要签名」而误以为余额也要，把积分能力误登记为 false
   * （见 `src/qoder-credits.ts` 的模块注释）。
   */
  fallbackModels: readonly QoderFallbackModel[]
}

/**
 * 模型目录（**实测数据**，2026-09-20）。
 *
 * ## `id` 是目录 key，且**必须走加密端点**
 *
 * 这些 key（`qfmodel` / `dmodel` / …）是 Qoder 客户端的**真实模型标识**，
 * 但公开的 `/model/v1/chat/completions` **不认它们**：
 *
 * ```
 * {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\""}
 * ```
 *
 * 客户端真实推理走**加密端点**（见 `src/qoder-wasm.ts`）：
 * ```
 * POST {host}/algo/api/v2/service/pro/sse/agent_chat_generation
 *      ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * body: <WASM 加密>
 * ```
 * 该端点**认这些 key**（实测 17 个全部可用）。
 *
 * ⚠️ 但请求体**必须带 `business` 字段**（见 `src/qoder-adapter.ts`）：
 * 缺了服务端会把请求路由到故障节点 `oa_qwen-plus-2025-04-28` 并返回
 * `[FAIL]node:... msg:Execution failed`。`qfmodel` 曾因此被误判为
 * 「服务端故障」（而 IDE 里同一模型完全正常）。
 *
 * ## ⚠️ 两套名字不可混用（踩过两次的坑）
 *
 * | 名字来源 | 示例 | 用途 |
 * |---|---|---|
 * | **目录 key**（本表） | `qfmodel` / `dmodel` | **加密端点**的 `model` 字段 |
 * | 通用名 | `qwen-flash` / `qwen-plus` | 公开端点的 `model` 字段（**不是**同一批模型） |
 *
 * 早期误把目录 key 发给公开端点 → `Unsupported model`；
 * 又误以为只有 11 个可用 → 表里换成通用名，结果拿到的是 Qwen3.5/2.5
 * 而非 Qwen3.8 系列（用户报障）。
 *
 * ## 数据来源
 *
 * 从本机 Qoder 的 `~/.qoder/.models/{uid}/catalog-v6` 解密取得
 * （`model_cache_decrypt`），字段逐项实测。
 *
 * ## 字段口径
 *
 * - `contextWindow`：目录 `max_input_tokens`。
 * - `supportsImage`：目录 `is_vl`（实测全为 true）。
 * - `supportsThinking`：目录 `is_reasoning`。
 * - `isFree`：目录 `is_free`（仅 Qwen3.8-Max / Qwen3.8-Flash）。
 * - `priceFactor`：目录 `price_factor`（**实测 2026-09-21，逐条对照本机
 *   catalog-v6 的 `chat` 场景**）。注意 `qfmodel` 的值是 **0**（免费），
 *   0 是合法值不能当缺失处理。
 * - `originalPriceFactor`：目录 `original_price_factor`（仅部分模型下发）。
 * - `promotion`：目录 `promotion`（错峰折扣，三档实测）。
 * - `efforts`：目录 `thinking_config.enabled.efforts` 的键。
 */
const QODER_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  // ⚠️ 全部数值逐条对照本机 catalog-v6 实测（2026-09-21）。早期版本多处为
  // 手工估值，与真实值**大范围不符**（14 个模型有偏差，如 `smodel` 写 3.2
  // 实际 8、`qmodel_38max` 写 0.5 实际 0.2），用户据此报障。
  // 改动本表时必须重新对照 catalog，不要凭印象填。
  //
  // 字段顺序：id, 展示名, 上下文, vl, reasoning, free, 倍率
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
  // ⚠️ `is_reasoning: false` 但 `thinking_config.enabled` 为真 —— 上游确实
  // 提供档位选择，故 `efforts` 保留；而请求体的 `isReasoning` 取 `is_reasoning`。
  { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
  { id: 'efficient', name: 'Efficient', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
  { id: 'smodel', name: 'Sonus', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
  { id: 'cmodel', name: 'Cantus', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'] },
  // 免费额度模型（is_free=true）：e2e 探针默认用它们以免消耗积分。
  // ⚠️ `priceFactor` 是**采集时刻的生效价**（窗口内为折后价），原价在
  // `promotion.beforePromotionPriceFactor`；展示时本地推算当前价。
  {
    id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 180_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'],
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
  },
  {
    // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失 —— 见接口注释。
    id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 180_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'],
  },
  {
    id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
    priceFactor: 0.1, originalPriceFactor: 0.5,
    promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 2 折' },
  },
  {
    id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
    priceFactor: 0.04,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
  },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 180_000, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ['high', 'low', 'max'] },
  // ⚠️ 该模型**未下发 `max_input_tokens`**，此处取 `context_config` 里
  // `is_default: true` 的那档（200K）。
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ['high', 'low', 'max'] },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 180_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'] },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'] },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'] },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'] },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 180_000, supportsImage: true, supportsThinking: false, priceFactor: 0.2 },
]

/** Qoder provider 配置（国际版）。 */
export const QODER: QoderProduct = {
  id: 'qoder',
  displayName: 'Qoder',
  authBase: 'https://qoder.com',
  openApiBase: 'https://openapi.qoder.sh',
  inferBase: 'https://api2-v2.qoder.sh',
  encryptedInferBase: 'https://api2.qoder.sh',
  clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  testClientId: 'e93fe488-5778-4c35-a6fc-0f54ed7b3139',
  clientMetadata: {
    client_type: '5',
    business_product: 'cli',
    business_type: 'agent',
    scene: 'assistant',
  },
  userAgentPrefix: 'qoder',
  defaultCredentialRef: 'QODER_ACCESS_TOKEN',
  fallbackModels: QODER_FALLBACK_MODELS,
}

/** 全部 Qoder 产品配置（当前只有一个，保留数组以便将来扩展中国版）。 */
export const ALL_QODER_PRODUCTS: readonly QoderProduct[] = [QODER]

/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 分开：
 * 三者返回**不同类型**，合并会让调用方拿到联合类型后不得不做类型收窄。
 */
export function qoderProductById(id: string): QoderProduct | undefined {
  return ALL_QODER_PRODUCTS.find((product) => product.id === id)
}
