/**
 * Raccoon Work（商汤小浣熊）产品配置。
 *
 * ## 为什么新建 `RaccoonProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `LoomyProduct` 的字段
 * 全部围绕各自协议设计（归属头、refresh 载荷、WASM 签名参数、讯飞 AccessKey…），
 * 对 raccoon 无一有意义。raccoon 需要的是：一套 API 前缀、桌面端身份标识、
 * 手机号加密密钥、阿里云验证码配置，以及一张兜底模型表。
 * 故定义**平行**的接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * - API 基址与各前缀：`app.asar` 的 `.env.electron`
 * - 手机号加密密钥：渲染层模块 68284 的 `yv(e, t = "senseraccoon2023")`
 * - 阿里云验证码：渲染层模块 37907 的 `q3`（SceneId）/ `$j`（prefix）
 * - 兜底模型表：2026-09-26 用本机登录态实测
 *   `GET /api/web/llm/v2/model_catalog` 取 `visible:true` 的 6 条
 */

import { RACCOON_API_BASE, RACCOON_PHONE_CIPHER_SECRET } from './raccoon.js'

/** 兜底模型目录中的一个条目。 */
export interface RaccoonFallbackModel {
  /** 模型 ID（传给 `chat/completions` 的 `model`）。 */
  id: string
  /** **已规范化**的展示名（含倍率，` · ` 分隔；免费显示「免费」）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限（远端 `params.max_tokens`）。 */
  maxTokens: number
  /** 是否支持图片输入（远端 `tags` 含 `vision`）。 */
  supportsImage: boolean
}

/** Raccoon Work 产品配置。 */
export interface RaccoonProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'raccoon'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** API 基址。 */
  apiBase: string
  /** 认证端点前缀。 */
  authApiPrefix: string
  /** 推理与模型目录前缀。 */
  llmApiPrefix: string
  /** 积分端点前缀。 */
  pointsApiPrefix: string
  /** 桌面端端点前缀。 */
  desktopApiPrefix: string
  /** User-Agent（仅记录用；实测该端点不校验 UA）。 */
  userAgent: string
  /**
   * 客户端平台标识。
   *
   * ⚠️ 取值必须是 `desktop-windows` / `desktop-macos` / `desktop-linux`
   * —— 依据主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`
   * （`win32` → `desktop-windows`）。`desktop/v1/login/points/grant`
   * **要求**该头，猜错会被拒。
   */
  clientPlatform: string
  /** 客户端版本（带 `v` 前缀，如 `v1.0.35`）。 */
  clientVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 手机号传输层加密密钥（见 `raccoon.ts` 的说明：公开常量，非安全边界）。 */
  phoneCipherSecret: string
  /** 阿里云滑块验证码配置（短信登录必需）。 */
  aliyunCaptcha: { sceneId: string; prefix: string }
  /** 远端模型列表不可用时的兜底目录（6 个可见模型）。 */
  fallbackModels: readonly RaccoonFallbackModel[]
}

/**
 * 兜底模型目录（6 个 `visible:true` 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ 展示名由 `raccoonDisplayName` 的输出形态固化（` · x倍率` / ` · 免费` /
 * ` · x原价→x折后价`），与远端 `billing_effective_multiplier` 逐条对应：
 *
 * | id | 原价 | 生效价 | 展示 |
 * |---|---|---|---|
 * | `sn-sensenova-6-8-flash` | 0.5 | 0 | 免费 |
 * | `sn-sensenova-6-8-flash-lite` | 0.5 | 0 | 免费 |
 * | `sn-glm-5-3` | 0.75 | 0.75 | x0.75 |
 * | `sn-kimi-k3` | 1 | 1 | x1 |
 * | `sn-glm-5-3-flash` | 0.2 | 0.1 | x0.2→x0.1 |
 * | `sn-deepseek-v4-1-flash` | 0.25 | 0.25 | x0.25 |
 *
 * ⚠️ **不含** `Raccoon-Auto`：它是客户端 i18n 条目（`modelPicker.auto`）渲染的
 * 「自动选模」入口，不是远端模型 —— 直接发给 `chat/completions` 会 404。
 * ⚠️ 也不含 3 个 `visible:false` 的 `raccoon-*` 内部模型。
 */
const RACCOON_FALLBACK_MODELS: readonly RaccoonFallbackModel[] = [
  {
    id: 'sn-sensenova-6-8-flash',
    name: 'SenseNova-6.8-Flash · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-sensenova-6-8-flash-lite',
    name: 'SenseNova-6.8-Flash-Lite · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3',
    name: 'GLM-5-3 · x0.75',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: true,
  },
  {
    id: 'sn-kimi-k3',
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍，
    // 1 倍也要显示倍率」）—— 见 `raccoonDisplayName` 的注释。
    name: 'Kimi-K3 · x1',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3-flash',
    name: 'GLM-5-3-Flash · x0.2→x0.1',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: false,
  },
  {
    id: 'sn-deepseek-v4-1-flash',
    name: 'DeepSeek-V4.1-Flash · x0.25',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: false,
  },
]

/** Raccoon Work provider 配置。 */
export const RACCOON: RaccoonProduct = {
  id: 'raccoon',
  // ⚠️ 用『Raccoon (商汤)』而非『Raccoon Work (商汤)』—— 后者在 Jet Hub 的
  // provider Tab 里**触发换行**（用户报障）。客户端内的品牌名是 `Raccoon Work`，
  // 但那个词组太长；缩短成 `Raccoon` 后与其余 provider 的标签长度一致
  //（`CodeBuddy (腾讯)` / `LobsterAI (有道)` / `WorkBuddy (国际版)`）。
  displayName: 'Raccoon (商汤)',
  apiBase: RACCOON_API_BASE,
  authApiPrefix: '/api/web/auth/v1',
  llmApiPrefix: '/api/web/llm/v2',
  pointsApiPrefix: '/api/web/points/v1',
  desktopApiPrefix: '/api/web/desktop/v1',
  userAgent: 'Raccoon Work/1.0.35 (Windows)',
  clientPlatform: 'desktop-windows',
  clientVersion: 'v1.0.35',
  defaultCredentialRef: 'RACCOON_ACCESS_TOKEN',
  phoneCipherSecret: RACCOON_PHONE_CIPHER_SECRET,
  aliyunCaptcha: { sceneId: '1pkmy0x3', prefix: 'hk1r5l' },
  fallbackModels: RACCOON_FALLBACK_MODELS,
}

/** 全部 Raccoon 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_RACCOON_PRODUCTS: readonly RaccoonProduct[] = [RACCOON]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` / `loomyProductById`
 * 分开：各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function raccoonProductById(id: string): RaccoonProduct | undefined {
  return ALL_RACCOON_PRODUCTS.find((product) => product.id === id)
}
