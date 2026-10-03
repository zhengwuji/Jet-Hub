/**
 * AutoClaw（智谱 AutoGLM 加速版客户端）产品配置。
 *
 * ## 为什么新建 `AutoclawProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `TraeProduct` /
 * `RaccoonProduct` / `ZcodeProduct` 的字段全部围绕各自协议设计（归属头、
 * refresh 载荷、WASM 签名参数、OAuth client id…），对 autoclaw 无一有意义。
 * autoclaw 需要的是：一个**推理平面**基址（含尾部 `/autoclaw`）、一个
 * **业务平面**基址（登录 / 模型目录 / 钱包 / 签到）、一套客户端身份常量、
 * 一个订阅信息路径，以及一张兜底模型表。
 * 故定义**平行**的接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 这一家是什么
 *
 * AutoClaw 是 AutoGLM 的「加速」客户端，订阅登录态可以直接跑推理，
 * 不需要用户去开放平台申请 API Key。两个地区的**域名与登录方式都不同**：
 *
 * ```text
 *              推理平面（含 /autoclaw 尾缀）                     业务平面（userapi）
 *   国内版  autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw
 *          ↑ 业务平面 https://autoglm-acceleration-api.zhipuai.cn
 *   国际版  autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw
 *          ↑ 业务平面 https://autoglm-api.autoglm.ai
 * ```
 *
 * ## ⚠️ 两地差异清单（照抄参考实现时最容易搞错的一处）
 *
 * | 项 | 国内版 | 国际版 |
 * |---|---|---|
 * | id | `autoclaw` | `autoclaw-intl` |
 * | 登录方式 | **手机验证码** | **Zai / Google OAuth 网页登录** |
 * | 订阅信息路径 | `/agentpay/v1/assistant/subscribe-info` | `/agentpay/v1/assistant/oversea-subscribe-info` |
 * | 账号 id 前缀 | `user-` | `intl-user-` |
 *
 * ⚠️ **登录方式决定 `startLogin` 的语义**：国内版没有可打开的登录页，
 * 它的入口是两个 RPC（`login.sendSms` / `login.submitSms`），
 * 详见 `src/autoclaw-auth.ts`。
 *
 * ## 为什么是两个 provider 而不是「一家的一个选项」
 *
 * 与 Qoder / TRAE / ZCode 的区域版同一思路：做成「一个 provider 上的
 * `region` 字段」会让地区变成**账号的属性**，界面上混在一起、
 * 「哪个账号走哪个站点」看不出来，账号记录也无法按地区隔离
 * （同一个人在两套系统里的 user_id 完全可能相同，撞 id 会让存储层的
 * 撞 id 保护拒绝写入）。按两个 provider 建模之后各自有独立的账号、
 * 清单、启停与映射。
 *
 * ## 数据来源
 *
 * 客户端身份常量（`AUTOCLAW_APP_ID` / `AUTOCLAW_APP_KEY` /
 * `AUTOCLAW_CLIENT_VERSION` / `AUTOCLAW_INFER_VERSION`）与回调端口列表
 * 均来自官方客户端产物；静态模型表来自实测的模型目录。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ `id` 与 `routeId` **是两个不同的东西**，不要合并：
 * - `id` 是本插件播报给 DSH 的**目录 id**（剥掉前缀的通用名，如 `glm-5.3`）；
 * - `routeId` 是上游 `X-Request-Model` 头要的**路由 id**（带前缀，如
 *   `zaicoding_glm-5.3`）。
 *
 * DSH 只会持久化/回传 `id`，故适配器必须用 {@link resolveAutoclawRoute}
 * 把它映射回 `routeId` —— 直接把 `id` 发给上游会 404 或落到错误的通道。
 */
export interface AutoclawFallbackModel {
  /** 目录 id（DSH 侧标识，剥前缀）。 */
  id: string
  /** 上游路由 id（`X-Request-Model` 头的取值）。 */
  routeId: string
  /** 展示名。 */
  name: string
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
}

/** AutoClaw 产品配置。 */
export interface AutoclawProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'autoclaw' | 'autoclaw-intl'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * 推理平面基址（**含尾部 `/autoclaw`**）。
   *
   * 推理请求打在 `${upstreamBaseUrl}/chat/completions`。
   * ⚠️ 尾部这一段 `/autoclaw` 不是可省的装饰：少了它网关会把请求路由到
   * 另一条通道并返回 404。
   */
  upstreamBaseUrl: string
  /**
   * 业务平面基址（登录 / 模型目录 / 钱包 / 签到）。
   *
   * ⚠️ 它**不是** `upstreamBaseUrl` 去掉尾缀 —— 模型目录与钱包走的是
   * **同 host 的 `/proxy/` 一级**（`/autoclaw-proxy/proxy/autoclaw-model-config`），
   * 而推理走的是 `/autoclaw-proxy/proxy/autoclaw` 那一级。两者只差一段路径，
   * 照抄推理基址去拼目录会 404。
   */
  userapiBaseUrl: string
  /** 登录方式：`sms` = 手机验证码（国内版），`oauth` = 网页 OAuth（国际版）。 */
  loginMode: 'sms' | 'oauth'
  /** 订阅信息路径（两地区不同）。 */
  subscribePath: string
  /**
   * 账号记录 id 的**前缀**。
   *
   * 两家都带前缀：同一个人在国内 / 国际两套系统里的 user_id 完全可能相同，
   * 撞了的话存储层的撞 id 保护会拒绝写入，而「两地账号并存」正是两个
   * provider 建模的意义之一。
   */
  accountIdPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底目录（两地共用）。 */
  fallbackModels: readonly AutoclawFallbackModel[]
}

/**
 * 客户端应用 id。
 *
 * ⚠️ 这是**公开协议常量**（官方客户端把它硬编码在前端产物里，用于
 * `X-Auth-Appid` 与签名公式），不是安全边界 —— 与 Loomy 的 AccessKey、
 * raccoon 的手机号加密密钥同性质。改它会让**所有**签名校验失败。
 */
export const AUTOCLAW_APP_ID = '100003'

/**
 * 签名密钥。
 *
 * 签名公式：`X-Auth-Sign = md5hex(`${appId}&${tsSeconds}&${appKey}`)`
 * （小写 hex、无填充）。见 `src/autoclaw.ts` 的 `autoclawSignedHeaders`。
 *
 * ⚠️ 同为**公开协议常量**（AGENTS.md 的「公共逆向协议常量保留」条款）：
 * 它是客户端内嵌的公共 Secret，改动会导致生产功能瘫痪。
 */
export const AUTOCLAW_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'

/**
 * 登录 / 业务接口的客户端版本（`X-Version`）。
 *
 * ⚠️ **这是版本门控，不是装饰**：模型目录端点不带它（或带错版本）会
 * **少返回模型**，而不是报错 —— 表现为「目录里莫名少了几个模型」。
 */
export const AUTOCLAW_CLIENT_VERSION = '1.18.5'

/**
 * **推理**请求的客户端版本（`X-Version`）。
 *
 * ⚠️ 与 {@link AUTOCLAW_CLIENT_VERSION} **刻意是两个值**：官方客户端的
 * 登录链路与推理链路用的是两套版本号（1.18.5 / 1.17.8）。统一成一个值
 * 属于「看起来更整洁」的改动，但会让其中一条链路带错版本。
 */
export const AUTOCLAW_INFER_VERSION = '1.17.8'

/**
 * 网页登录回调的候选端口（**按顺序尝试第一个空闲的**）。
 *
 * ⚠️ 这些端口来自官方客户端**注册在 Zai 侧的白名单**：换一个随机端口
 * 会在授权页被拒（`redirect_uri` 未注册）。故只能在这几个里挑，
 * 而不是像其它 provider 那样退到系统分配的随机端口。
 *
 * ⚠️ 与之配套的**主机名必须是 `localhost`**（写 `127.0.0.1` 会被 Zai 拒），
 * 而 `server.listen` 仍绑 `127.0.0.1` —— 二者不矛盾，`localhost` 在本机
 * 解析到 `127.0.0.1`。
 */
export const AUTOCLAW_CALLBACK_PORTS = [18432, 19654, 19723, 53699] as const

/**
 * 兜底模型表（两地共用，2 条）。
 *
 * ## 为什么两地共用一份
 *
 * 两个地区的模型**路由前缀不同但模型本体相同**：国内走 `zaicoding_*`
 * （智谱编码通道），国际走 `zai_*`。差异已经体现在 `routeId` 上，
 * 故 `id` / `name` / 能力位没有必要各写一份。
 *
 * ## 为什么 `glm-5.3-flash` 支持图片而 `glm-5.3` 不支持
 *
 * 这是**实测的远端目录声明**，不是猜测：`glm-5.3` 的 `input` 只有
 * `["text"]`，`glm-5.3-flash` 带 `"image"`。能力位必须逐模型如实播报 ——
 * DSH 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
 * 声明支持就必须真支持（照抄别的 provider 一刀切会两边都错）。
 */
const AUTOCLAW_FALLBACK_MODELS: readonly AutoclawFallbackModel[] = [
  {
    id: 'glm-5.3',
    routeId: 'zaicoding_glm-5.3',
    name: 'GLM-5.3',
    supportsImage: false,
    contextWindow: 1_048_576,
    maxTokens: 307_200,
  },
  {
    id: 'glm-5.3-flash',
    routeId: 'zai_glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    supportsImage: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
  },
]

/**
 * AutoClaw **国内版**（智谱加速域）。
 *
 * 登录方式：手机验证码（`login.sendSms` / `login.submitSms`）。
 */
export const AUTOCLAW: AutoclawProduct = {
  id: 'autoclaw',
  displayName: 'AutoClaw (国内版)',
  upstreamBaseUrl: 'https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw',
  userapiBaseUrl: 'https://autoglm-acceleration-api.zhipuai.cn',
  loginMode: 'sms',
  subscribePath: '/agentpay/v1/assistant/subscribe-info',
  accountIdPrefix: 'user-',
  defaultCredentialRef: 'AUTOCLAW_ACCESS_TOKEN',
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
}

/**
 * AutoClaw **国际版**（AutoGLM 国际域）。
 *
 * 登录方式：Zai / Google OAuth 网页登录（本地回调端口，见
 * {@link AUTOCLAW_CALLBACK_PORTS}）。
 */
export const AUTOCLAW_INTL: AutoclawProduct = {
  id: 'autoclaw-intl',
  displayName: 'AutoClaw (国际版)',
  upstreamBaseUrl: 'https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw',
  userapiBaseUrl: 'https://autoglm-api.autoglm.ai',
  loginMode: 'oauth',
  subscribePath: '/agentpay/v1/assistant/oversea-subscribe-info',
  accountIdPrefix: 'intl-user-',
  defaultCredentialRef: 'AUTOCLAW_INTL_ACCESS_TOKEN',
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
}

/**
 * 全部 AutoClaw 产品配置。
 *
 * 国内版在前：与注册表顺序一致，也决定模型目录合并时同名模型先归谁家。
 */
export const ALL_AUTOCLAW_PRODUCTS: readonly AutoclawProduct[] = [AUTOCLAW, AUTOCLAW_INTL]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `qoderProductById` / `zcodeProductById`
 * 分开：各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做
 * 类型收窄。
 */
export function autoclawProductById(id: string): AutoclawProduct | undefined {
  return ALL_AUTOCLAW_PRODUCTS.find((product) => product.id === id)
}
