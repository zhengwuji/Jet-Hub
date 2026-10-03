/**
 * Accio（阿里 Accio Work）产品配置：国际版 `accio` / 国内版 `accio-cn`。
 *
 * ## 为什么新建 `AccioProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `TraeProduct` /
 * `RaccoonProduct` / `ZcodeProduct` 的字段全部围绕各自协议设计，对 accio
 * 无一有意义。accio 需要的是：一个**登录站点**（两地不同）、一个**业务网关**
 * （两地相同）、`x-package-region` 取值、桌面端身份常量（`clientId` /
 * `appKey` / `appVersion` / `tenant` / `iaiTag`），以及一张兜底模型表。
 * 故定义**平行**的接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 两个地区 = 两家 provider（与 Qoder / ZCode 同一处置）
 *
 * 两地**共用同一个业务网关**（`phoenix-gw.alibaba.com`），差别只在
 * 登录站点、`x-package-region` 与账号归属。做成「一家上的一个 `region`
 * 字段」会让地区变成账号的属性，界面上混在一起、「哪个账号走哪个站点」
 * 看不出来，账号记录也无法按地区隔离。按两个 provider 建模之后各自有
 * 独立的账号、清单与启停 —— 与 AGENTS.md 的「区域版各占一个 provider」
 * 完全一致。
 *
 * ## 数据来源
 *
 * 全部来自 Accio Work 桌面端安装包的 `app.asar` 逆向 + 实测，与
 * `agent2api` 的 Rust 实现（`providers/accio/*.rs`）互为佐证。要点：
 * - 网关：`https://phoenix-gw.alibaba.com`（国际 / 国内同一个）；
 * - 登录站点：国际 `www.accio.com` / 国内 `www.accio-ai.com`；
 * - `client_id` 两地**逐字相同**（`accio-work`）：桌面端两个构建共用它；
 * - **token 不进 `Authorization` 头**：业务接口的 GET 把 `accessToken`
 *   拼进 query、POST 放进 JSON body；推理接口把 `token` 放进 body。
 *   这一点与本插件其余九家都不同（见 `accio.ts` 与 `accio-auth.ts`）。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ## 为什么没有 `maxOutputTokens`
 *
 * ⚠️ **上游没给单次输出上限**：目录条目的字段里既没有 `maxOutputTokens`
 * 也没有等价物。DSH 对 `defaultMaxTokens` 有硬校验，**编造一个数值**比
 * 「不声明」危险得多（偏大被上游 400、偏小无谓截断用户输出）。故本表
 * **刻意不输出该字段**，由 DSH 用它自己的默认值。
 *
 * ## `reasoningPlacement` 为什么必须逐条写死
 *
 * ⚠️ 这是**Gemini 系硬 400 与 GPT 系「永远不出思考」的分水岭**，不是风格问题：
 *
 * | 模型族 | 落点 | 实测后果（放错时） |
 * |---|---|---|
 * | Gemini 系 | `top`（顶层 `reasoning_effort`） | 放 `properties` 是**硬 400**：`Unknown name "reasoning_effort"` |
 * | GPT 系 | `properties`（`properties.reasoning_effort`） | 放顶层**不报错但永不出思考内容**（静默失效） |
 * | Claude / GLM / Qwen / MiniMax 系 | 见下 | 同上二者之一 |
 *
 * 远程目录里这个信息由上游的 `protocol` 字段给出（`responses` / `openai` →
 * `properties`，其余 → `top`，见 `accio-auth.ts` 的归一）。静态表没有
 * `protocol` 可读，故按同一批实测**逐条**标注，两条路都不再按模型名猜
 * （上游会把模型名换成不透明代号，`contains('gpt')` 这类判据会整体失效）。
 */
export interface AccioFallbackModel {
  /** 对外模型 ID（用户配置与持久化都用它）。 */
  id: string
  /** 展示名（远端 `modelDisplayName`）。 */
  name: string
  /** 上下文窗口（远端 `contextWindow`）。 */
  contextWindow: number
  /** 是否接受图片输入（远端 `multimodal`）。 */
  supportsImage: boolean
  /** 该模型声明的思考档位（远端 `reasoningEfforts`）；空数组 = 不支持思考。 */
  reasoningEfforts: readonly string[]
  /** 思考档位落在哪一层（见接口上方对照表）。 */
  reasoningPlacement: 'top' | 'properties'
}

/** Accio 产品配置。 */
export interface AccioProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'accio' | 'accio-cn'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * 登录站点（OAuth 授权页所在域）。
   *
   * ⚠️ **这是两地唯一的端点差异**（业务网关是同一个）。国际版
   * `www.accio.com` → 区域 `GLOBAL`；国内版 `www.accio-ai.com` → 区域 `CN`。
   */
  loginBase: string
  /**
   * 业务网关基址（**两地共用**）。
   *
   * 承载 `/api/oauth/token`、`/api/auth/refresh_token`、`/api/auth/userinfo`、
   * `/api/entitlement/quota`、`/api/llm/config` 与推理的 `/api/adk/llm`。
   */
  gatewayBase: string
  /** 推理与目录请求的 `x-package-region` 头（`GLOBAL` / `CN`）。 */
  packageRegion: 'GLOBAL' | 'CN'
  /** OAuth 客户端 id（桌面端常量；两地逐字相同）。 */
  clientId: string
  /**
   * 推理请求头 `appKey`（**必填，非空**）。
   *
   * ⚠️ 缺了它上游**不报错**，而是以 HTTP 200 + 正常帧形态回一段
   * 「Your app version is no longer supported. Please update…」的**普通文本**
   * —— 形态与正常回答完全一样，会被当成模型输出吐给下游（用户看到的是模型
   * 莫名其妙说了一句版本提示）。实测带任意**非空**取值即恢复（上游只校验
   * 「有没有」，不校验取值），故沿用桌面端同源的默认值。
   */
  appKey: string
  /** 客户端版本（`x-app-version` 与 `version` 两个头都用它）。 */
  appVersion: string
  /** ADK 推理请求的租户（桌面端默认值 `accio-agent`）。 */
  tenant: string
  /** ADK 推理请求的来源标记（桌面端默认值 `phoenix-desktop`）。 */
  iaiTag: string
  /**
   * 账号记录 id 的**前缀**（id 生成用）。
   *
   * 两地都带前缀：同一个人在国内 / 国际两套系统里的 `user_id` 完全可能相同，
   * 撞了的话存储层的撞 id 保护会拒绝写入，而「两地账号并存」正是两个 provider
   * 建模的意义之一。
   */
  accountIdPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底目录（两地共用一份）。 */
  fallbackModels: readonly AccioFallbackModel[]
}

/**
 * 兜底模型目录（10 条，**两地共用**）。
 *
 * 抄自客户端内置的 `@ali/accio-adk-ts/model-catalog.json` 里 `visible: true`
 * 的条目（2026-09 快照），顺序照抄原表、不重排 —— 重排会让「与远端对比」
 * 这类排查失去可比性。
 *
 * ⚠️ 这些是**上游代号之前的那一代模型名**：目录接口现在给的是
 * `1Orbit-I9eY7YK8bW1f` 这类不透明代号，但老名字实测**仍然可用**
 * （逐条发得通）。保留它们的意义是「进程启动即有清单可广告、断网 / 未登录时
 * 模型选择器不为空」；远程清单拉到之后这份退居兜底（见 `accio-adapter.ts`）。
 */
const ACCIO_FALLBACK_MODELS: readonly AccioFallbackModel[] = [
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    contextWindow: 1_000_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    // Gemini 系：档位必须在**顶层**，放 properties 直接 400。
    reasoningPlacement: 'top',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    contextWindow: 1_000_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    reasoningPlacement: 'top',
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen 3.6 Plus',
    contextWindow: 991_808,
    supportsImage: false,
    reasoningEfforts: [],
    reasoningPlacement: 'top',
  },
  {
    id: 'qwen3-max-2026-01-23',
    name: 'Qwen 3 Max',
    contextWindow: 262_144,
    supportsImage: false,
    reasoningEfforts: [],
    reasoningPlacement: 'top',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    contextWindow: 1_050_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    // GPT 系：**只有** properties 能出思考内容（顶层静默无效）。
    reasoningPlacement: 'properties',
  },
  {
    id: 'gpt-5.2-1211',
    name: 'GPT 5.2',
    contextWindow: 400_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    reasoningPlacement: 'properties',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    reasoningPlacement: 'top',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    reasoningPlacement: 'top',
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    contextWindow: 200_000,
    supportsImage: false,
    reasoningEfforts: [],
    reasoningPlacement: 'top',
  },
  {
    // ⚠️ 大小写逐字照抄远端（`MiniMax-M2.5`）：模型 id 是**大小写敏感**的
    // 路由键，随手「规范化」成小写会让持久化的配置全部 404。
    id: 'MiniMax-M2.5',
    name: 'MiniMax M2.5',
    contextWindow: 204_800,
    supportsImage: true,
    reasoningEfforts: [],
    // MiniMax 走 OpenAI 协议（`protocol: 'openai'`）→ properties。
    reasoningPlacement: 'properties',
  },
]

/** Accio 国际版。 */
export const ACCIO: AccioProduct = {
  id: 'accio',
  displayName: 'Accio (国际版)',
  loginBase: 'https://www.accio.com',
  gatewayBase: 'https://phoenix-gw.alibaba.com',
  packageRegion: 'GLOBAL',
  clientId: 'accio-work',
  appKey: '35298846',
  appVersion: '0.32.6',
  tenant: 'accio-agent',
  iaiTag: 'phoenix-desktop',
  accountIdPrefix: 'accio-intl-',
  defaultCredentialRef: 'ACCIO_ACCESS_TOKEN',
  fallbackModels: ACCIO_FALLBACK_MODELS,
}

/** Accio 国内版（与上面**只差**登录站点、区域与账号前缀）。 */
export const ACCIO_CN: AccioProduct = {
  id: 'accio-cn',
  displayName: 'Accio (国内版)',
  loginBase: 'https://www.accio-ai.com',
  gatewayBase: 'https://phoenix-gw.alibaba.com',
  packageRegion: 'CN',
  clientId: 'accio-work',
  appKey: '35298846',
  appVersion: '0.32.6',
  tenant: 'accio-agent',
  iaiTag: 'phoenix-desktop',
  accountIdPrefix: 'accio-cn-',
  defaultCredentialRef: 'ACCIO_CN_ACCESS_TOKEN',
  fallbackModels: ACCIO_FALLBACK_MODELS,
}

/**
 * 全部 Accio 产品配置。
 *
 * 国际版在前：与注册表顺序一致，也决定模型目录合并时同名模型先归谁家。
 */
export const ALL_ACCIO_PRODUCTS: readonly AccioProduct[] = [ACCIO, ACCIO_CN]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `qoderProductById` / `zcodeProductById`
 * 分开：各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做
 * 类型收窄。
 */
export function accioProductById(id: string): AccioProduct | undefined {
  return ALL_ACCIO_PRODUCTS.find((product) => product.id === id)
}
