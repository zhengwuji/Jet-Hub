/**
 * CatPaw（美团）产品配置。
 *
 * ## 为什么新建 `CatpawProduct` 而不复用既有类型
 *
 * `RaccoonProduct` / `TraeProduct` / `QoderProduct` / `BuddyProduct` 的字段全部
 * 围绕各自协议设计（积分前缀、WASM 签名参数、归属头、refresh 载荷…），对 CatPaw
 * 无一有意义。CatPaw 需要的是：**两个不同的域名**（推理直连域名 + 网关域名）、
 * 一套「客户端身份常量」（source / mode / toolVersion / appKey / permissionMode）
 * 与一张必须实测坐实的静态模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## ⚠️ 两个域名不可混用（本家最容易踩的坑）
 *
 * | 域名 | 用途 | 端点 |
 * |---|---|---|
 * | `inferBase`（`ai.catpaw.meituan.com`） | **推理**（conversation 协议 + 模型目录） | `/api/agent/conversation/*`、`/api/agent/maas/model-types` |
 * | `gatewayBase`（`catx.nocode.cn`） | **登录态与积分** | `/api/gateway/passport/*`、`/api/gateway/credit/balance` |
 *
 * 这两套域名的**凭证头都不同**：推理链路用 `Cookie: X-Passport-Token=<token>` +
 * `user-uid`，而网关的积分端点**只认 `X-Auth-Token`**（`X-Passport-Token` /
 * `Cookie` / `Authorization` 一律 401）。把两者混起来会得到「模型能列、积分
 * 恒 401」这种半死状态。
 *
 * ## 数据来源
 *
 * 上游 conversation 协议的实测结论（`UPSTREAM_PROTOCOL.md` 为唯一权威）；
 * 常量取值与 `catpaw-local-proxy` / `catpaw-upstream-client.mjs` 逐字一致。
 */

/**
 * 上游 `source` 字段的固定取值（客户端身份标识）。
 *
 * round / turn 请求体都要带上。它标识「这是 CatX 客户端发来的轮次」，
 * 改动会让上游按另一套语义解释请求。
 */
export const CATPAW_SOURCE = 'CatX'

/**
 * 上游 `mode` 字段的固定取值（应用形态）。
 *
 * 与 `source` 一起构成「哪个客户端、哪种模式」的身份对，上游按它对模型池与
 * 工具语义分流。
 */
export const CATPAW_MODE = 'CATX_APP'

/**
 * 上游 `toolVersion` 字段（工具协议版本，对应桌面端客户端版本）。
 *
 * ⚠️ 它**不是** `X-Agent-Version`（那是 `CATPAW_CLIENT_VERSION`）。两者是两个
 * 独立字段：前者进请求体、决定上游按哪一版工具语义解释 `toolConfigs`；
 * 后者是请求头、标识客户端版本。混用会让工具定义被按错误语义解析。
 */
export const CATPAW_TOOL_VERSION = '2.0.2'

/** 桌面端客户端版本（`X-Agent-Version` 头）。 */
export const CATPAW_CLIENT_VERSION = '1.0.1'

/** `M-APPKEY` 头的固定值：标识「外部版 CatPaw 客户端」。 */
export const CATPAW_APP_KEY = 'fe_com.sankuai.catpaw.external.front'

/**
 * `permissionMode` 的固定取值。
 *
 * `unsafeBypassPermissions` = 「客户端已自行处理权限确认」。本插件是宿主侧代理，
 * 工具的授权由 harness 侧负责，故对齐桌面端「已授权」形态，否则上游会对每个
 * 工具调用回问权限、整轮卡住。
 */
export const CATPAW_PERMISSION_MODE = 'unsafeBypassPermissions'

/**
 * 静态模型表中的一个条目。
 *
 * ## 为什么必须有这张表（远程目录不是替代品）
 *
 * 上游有远程目录（`POST /api/agent/maas/model-types`），「有哪些模型、叫什么、
 * 倍率多少」由它负责。静态表留着是因为它能提供**远程条目给不出的两样东西**：
 *
 * 1. `modelType` —— 实测坐实的上游**数字** ID。写错一个不会报错，只会让请求
 *    打到另一个模型（静默错答），因此这两个数字必须逐条核对、不能凭名字猜；
 * 2. `contextOptions` / `defaultContext` —— `context` 参数的**合法档位**。
 *    远程把这些藏在 `parameterDefinitions` 的 ENUM 里，形态更难直接消费。
 */
export interface CatpawFallbackModel {
  /** 模型 ID（也是发给适配器的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上游数字 `modelType`。
   *
   * ⚠️ **证据（不要凭名字猜）**：
   * - `83 = Kimi-K3`：长连接日志里 `model:83` 会话自述 Moonshot/Kimi，
   *   且真实客户端图片请求成功；
   * - `91 = GLM-5.3-Flash`：`model:91` 会话自述 Z.ai GLM、真实图片请求成功，
   *   且桌面端持久化选择为
   *   `{"modelId":91,"modelParams":{"context":"1024000","effort":"max"}}`。
   *
   * 两个 ID 都经过 `agent_start`、图片与 `reasoningContent` 实测。
   */
  modelType: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 是否支持思考（reasoning）。 */
  supportsReasoning: boolean
  /**
   * 该模型支持的 `context` 档位（**空数组 = 不支持 context 参数**）。
   *
   * ⚠️ 空数组不是「还没填」而是**实测结论**：`kimi-k3` 在原表里没有
   * `contextWindows` 字段，传了 `context` 上游直接 400。所以适配器必须
   * 对空档位的模型**整个不发** `context` 字段。
   */
  contextOptions: readonly number[]
  /** 未显式请求 context 时的默认档位；无则不发该字段。 */
  defaultContext?: number
}

/**
 * 静态模型表（2 条，逐字）。
 *
 * 顺序照抄原表，不重排 —— 重排会让「与上游对比」这类排查失去可比性。
 */
const CATPAW_MODELS: readonly CatpawFallbackModel[] = [
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    modelType: 83,
    supportsImage: true,
    supportsReasoning: true,
    // ⚠️ 空 = 不支持 context 参数（传了上游 400）。见 CatpawFallbackModel 的说明。
    contextOptions: [],
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    modelType: 91,
    supportsImage: true,
    supportsReasoning: true,
    contextOptions: [204_800, 512_000, 1_024_000],
    defaultContext: 1_024_000,
  },
]

/** CatPaw 产品配置。 */
export interface CatpawProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'catpaw'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * 推理基址（conversation 协议 + 模型目录）。
   *
   * ⚠️ 与 `gatewayBase` **不是同一个域名**，凭证头也不同（见文件头）。
   */
  inferBase: string
  /**
   * 网关基址（登录态与积分）。
   *
   * ⚠️ 该域名下的积分端点**只认 `X-Auth-Token`**。
   */
  gatewayBase: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 账号 id 前缀（多账号并存时避免与其它 provider 撞 id）。 */
  accountIdPrefix: string
  /** 静态模型表（远端目录不可用或需要数字 ID / 档位时的唯一真相源）。 */
  models: readonly CatpawFallbackModel[]
}

/** CatPaw provider 配置。 */
export const CATPAW: CatpawProduct = {
  id: 'catpaw',
  // 与其余 provider 的标签长度一致（`Raccoon (商汤)` / `TRAE (字节)` / …）：
  // 过长的词组会在 Jet Hub 的 provider Tab 里触发换行（用户报障过）。
  displayName: 'CatPaw (美团)',
  inferBase: 'https://ai.catpaw.meituan.com',
  gatewayBase: 'https://catx.nocode.cn',
  defaultCredentialRef: 'CATPAW_ACCESS_TOKEN',
  accountIdPrefix: 'catpaw-user-',
  models: CATPAW_MODELS,
}

/** 全部 CatPaw 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_CATPAW_PRODUCTS: readonly CatpawProduct[] = [CATPAW]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `raccoonProductById` / `traeProductById` 分开：各自返回**不同类型**，
 * 合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function catpawProductById(id: string): CatpawProduct | undefined {
  return ALL_CATPAW_PRODUCTS.find((product) => product.id === id)
}
