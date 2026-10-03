/**
 * ZCode（智谱 / Z.AI 的编码代理客户端）产品配置。
 *
 * ## 为什么新建 `ZcodeProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `TraeProduct` /
 * `RaccoonProduct` / `AccioProduct` 的字段全部围绕各自协议设计，对 zcode
 * 无一有意义。zcode 需要的是：一个 zcode 平面基址（登录 / 领取 / 客户端配置）、
 * 一个推理平面基址（OpenAI 兼容）、一个编码套餐业务域（凭证换取）、
 * OAuth 的 `provider` 取值，以及一张静态模型表。
 * 故定义**平行**的接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 这一家是什么
 *
 * ZCode 的「编码套餐」（Coding Plan）可以在客户端里用**订阅登录态**调用，
 * 而不必去开放平台申请 API Key。本插件复刻的正是这条登录态链路：
 *
 * ```text
 *              zcode 平面（登录 / 领取 / 客户端配置）      推理平面
 *   国内版  https://zcode.z.ai                       https://open.bigmodel.cn
 *   国际版  https://zcode.z.ai                       https://api.z.ai
 * ```
 *
 * ## 为什么 zcode 平面两地**相同**、推理平面两地不同
 *
 * 登录与领取都发生在 ZCode 自己的服务端（`zcode.z.ai`），两地客户端用的是
 * **同一个** `zcode.z.ai`（OAuth 的 `provider` 字段区分 `zai` / `bigmodel`）。
 * 而真正跑推理的网关是各自开放平台的编码套餐端点：国内 `open.bigmodel.cn`、
 * 国际 `api.z.ai`。
 *
 * 也就是说「地区」在这一家**只影响推理平面与账号归属**，不影响 zcode 平面 ——
 * 这与 AutoClaw（两地各自一整套域名）不同，是照抄参考实现时最容易搞错的一处。
 *
 * ## 为什么是两个 provider 而不是「一家的一个选项」
 *
 * 与 Cline 的两个额度池、AutoClaw / Accio 的两个地区同一思路：做成「一个
 * provider 上的 `region` 字段」会让地区变成**账号的属性**，界面上混在一起、
 * 「哪个账号走哪个站点」看不出来，账号记录也无法按地区隔离。
 * 按两个 provider 建模之后各自有独立的账号、清单、启停与映射。
 *
 * ## 与预设提供商的关系（别重复建设）
 *
 * 前端预设里已经有 `glm` / `glm-cn` 两个**自定义提供商** —— 那两条路要用户
 * 自己提供 API Key，走开放平台计费。本家补的是**另一条通道**：用 ZCode 的
 * 订阅登录态转发，不需要 API Key。两者可以并存。
 *
 * ## 数据来源
 *
 * 从 Agent2API 的 Rust 实现移植（`providers/zcode/region.rs` + `models.rs`），
 * 其值来自参考实现 `Acankao/zcode-api` 与官方客户端 bundle 的实测记录。
 */

/** 兜底模型目录中的一个条目。 */
export interface ZcodeFallbackModel {
  /** 模型 ID（原样转发给上游，不做任何改名）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 是否支持思考。 */
  supportsReasoning: boolean
}

/** ZCode 产品配置。 */
export interface ZcodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'zcode' | 'zcode-intl'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * OAuth / 领取链路里的 `provider` 取值（参考实现的 `ProviderId`）。
   *
   * ⚠️ 它同时是 `/oauth/cli/init` 请求体里的 `provider`、`/oauth/cli/poll`
   * 响应里那个分支键（`data.zai.access_token` / `data.bigmodel.access_token`）。
   * **不是**我们的 provider id —— 这两个命名空间别混。
   */
  upstreamProvider: 'bigmodel' | 'zai'
  /** zcode 平面基址（登录 / 领取 / 客户端配置；**两地相同**）。 */
  zcodeOrigin: string
  /**
   * 推理平面：OpenAI 兼容基址（**不含**尾斜杠）。
   *
   * 编码套餐的推理走这里：`POST {openaiBaseUrl}/chat/completions`，
   * `Authorization: Bearer <换取后的 API Key>`。
   */
  openaiBaseUrl: string
  /**
   * 编码套餐业务域（凭证换取用）。
   *
   * ⚠️ 国内版是 `bigmodel.cn` 而不是 `open.bigmodel.cn`：参考实现里这两个域
   * 是分开的，而真正跑登录换取的 `resolveCodingPlanCredential` **硬编码**了
   * `https://bigmodel.cn`。两个域实测都能响应 `/api/biz/*`，但既然有实测跑通
   * 的那一个，就没有理由去猜另一个。
   */
  bizHost: string
  /**
   * 账号记录 id 的**前缀**（id 生成用）。
   *
   * 两家都带前缀：同一个人在国内 / 国际两套系统里的 userId 完全可能相同，
   * 撞了的话存储层的撞 id 保护会拒绝写入，而「两地账号并存」正是两个
   * provider 建模的意义之一。
   */
  accountIdPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底目录。 */
  fallbackModels: readonly ZcodeFallbackModel[]
}

/**
 * 编码套餐的模型表（**静态表**，两地共用一份）。
 *
 * ## 为什么是静态表而不是远程目录
 *
 * 上游没有「列模型」的公开接口：编码套餐的可用模型由**客户端内置的目录**
 * 决定，参考实现同样把它硬编码成常量表。因此本家**不提供远程刷新** ——
 * 那会假装刷了一次。
 *
 * ## 两地清单为什么逐字相同
 *
 * 参考实现的两处注记都写着 zai 与 bigmodel 的目录条目**完全一致**。差异在
 * **账号能用到哪些**（套餐档位决定），而那是上游按套餐判的（用不到的模型会回
 * `502 exceed quota limit`），本机无法预先枚举。所以两地共用一份清单，
 * 把「用不到」留给上游如实报错。
 *
 * ## `glm-5.3-flash` 为什么要广告出来
 *
 * 它是**体验套餐（周末套餐）**被领到之后实际可用的那一档 —— 参考实现为此
 * 专门加了一条注记。不广告它，用户领到套餐后在模型列表里看不到能用的模型，
 * 会以为领取失败。
 *
 * 顺序 = 展示顺序：能力由强到弱、同代相邻，便于管理页阅读。
 */
const ZCODE_FALLBACK_MODELS: readonly ZcodeFallbackModel[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 128_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 64_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000, maxTokens: 64_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImage: false, supportsReasoning: true },
  { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 200_000, maxTokens: 131_072, supportsImage: false, supportsReasoning: true },
  { id: 'glm-4.6', name: 'GLM-4.6', contextWindow: 200_000, maxTokens: 131_072, supportsImage: false, supportsReasoning: true },
  { id: 'glm-4.5-air', name: 'GLM-4.5 Air', contextWindow: 131_072, maxTokens: 98_304, supportsImage: false, supportsReasoning: true },
  // 视觉两档：**不支持思考**，能力位与其它档不同（目录里要如实标出来，
  // 否则客户端会按「支持思考」去发 thinking，上游直接拒）。
  { id: 'glm-4.6v', name: 'GLM-4.6V', contextWindow: 131_072, maxTokens: 32_768, supportsImage: true, supportsReasoning: false },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', contextWindow: 200_000, maxTokens: 131_072, supportsImage: true, supportsReasoning: false },
]

/** ZCode 国内版（智谱开放平台）。 */
export const ZCODE: ZcodeProduct = {
  id: 'zcode',
  displayName: 'ZCode (国内版)',
  upstreamProvider: 'bigmodel',
  zcodeOrigin: 'https://zcode.z.ai',
  openaiBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  bizHost: 'https://bigmodel.cn',
  accountIdPrefix: 'zcode-user-',
  defaultCredentialRef: 'ZCODE_ACCESS_TOKEN',
  fallbackModels: ZCODE_FALLBACK_MODELS,
}

/** ZCode 国际版（Z.AI）。 */
export const ZCODE_INTL: ZcodeProduct = {
  id: 'zcode-intl',
  displayName: 'ZCode (国际版)',
  upstreamProvider: 'zai',
  zcodeOrigin: 'https://zcode.z.ai',
  openaiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  bizHost: 'https://api.z.ai',
  accountIdPrefix: 'zcode-intl-user-',
  defaultCredentialRef: 'ZCODE_INTL_ACCESS_TOKEN',
  fallbackModels: ZCODE_FALLBACK_MODELS,
}

/**
 * 全部 ZCode 产品配置。
 *
 * 国内版在前：与注册表顺序一致，也决定模型目录合并时同名模型先归谁家。
 */
export const ALL_ZCODE_PRODUCTS: readonly ZcodeProduct[] = [ZCODE, ZCODE_INTL]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `qoderProductById` 分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function zcodeProductById(id: string): ZcodeProduct | undefined {
  return ALL_ZCODE_PRODUCTS.find((product) => product.id === id)
}
