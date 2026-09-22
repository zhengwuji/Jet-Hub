/**
 * TRAE（字节跳动 TRAE IDE）产品配置。
 *
 * ## 数据来源
 *
 * 基于对 `E:\Workplace\APP\Golang\trae2api` 的逆向分析（2026-08），
 * 以及上游项目 `Sliverkiss/traework2api` 的实测结果。
 *
 * - API 端点：`trae2api/internal/upstream/constants.go`（实测可用的 SOLO 免费通道）；
 * - 客户端常量：同一文件，版本号 `0.1.52` / `20260811` 为实测可获取 glm-5.3 的最低版本；
 * - 兜底模型表：`trae2api/internal/server/handler.go:247-280` 的 staticModels；
 * - 登录 URL 格式：`trae2api/internal/server/login.go` 的 `BuildLoginURL`。
 *
 * ## 为什么是独立接口而非复用 BuddyProduct/LobsteraiProduct
 *
 * TRAE 与二者都不同源：
 * - 与 BuddyProduct 差异：认证用 ExchangeToken（轮换 refreshToken）而非 external-link 轮询；
 *   请求头用 `Cloud-IDE-JWT` 而非 `Bearer`；chat 端点需要 payload 格式转换；
 *   SSE 格式自定（非 OpenAI 标准），需独立解析。
 * - 与 LobsteraiProduct 差异：chat 端点使用 POST + JSON body + 自定义 SSE；
 *   认证协议不同（OAuth code + ExchangeToken，non-localhost 可回调）；
 *   凭据中需持久化 machine_id/device_id 等设备指纹。
 *
 * 因此这里定义**平行**的 `TraeProduct`：共用的是架构模式（产品差异收敛到单一真相源），
 * 不是那个类型。
 */

/**
 * 兜底模型目录中的一个条目（对齐 Go 端 staticModels 格式）。
 *
 * 数据来源：`handler.go:247-280`（2026-08 实测快照）。
 * 远端 `batch_get_detail_param` 拉取失败时用此表回退。
 *
 * ⚠️ **数值是估值**（采信实测主流值 `contextWindow=200000`），远端可用时
 * **完全采信远端**的 `context_window_tokens` 与 `max_tokens`。旧的 `131072` /
 * `maxOutputTokens: 128000` 是 2026-08 的估值，已被实测推翻（见 `AGENTS.md`）。
 */
export interface TraeFallbackModel {
  id: string
  name: string
  contextWindow: number
  /** 已知的上游内部/隐藏条目（远端不可用时也不该出现在目录里）。 */
  isHidden?: boolean
}

/**
 * TRAE 产品配置。
 *
 * 与 `LobsteraiProduct` / `BuddyProduct` 平行，字段全部为 TRAE 实际需要的。
 */
export interface TraeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'trae' | 'trae-intl'
  /**
   * 区域站点：`cn`（国内版，trae.cn）/ `global`（国际版，trae.ai）。
   *
   * 官方把两个区域做成**两个独立客户端**（本机实测：`Trae` 与 `Trae CN`
   * 两套用户数据目录，安装包也不同）。差异全在域名上，协议一致。
   */
  site: 'cn' | 'global'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 上游 API 基址（Agent 服务：对话 + 模型列表）。 */
  agentHost: string
  /** 签到/积分/Ug 基址。 */
  ugHost: string
  /** OAuth/认证基址（ExchangeToken / GetUserInfo）。 */
  oauthHost: string
  /** 登录门户基址。 */
  consoleHost: string
  /** 客户端 ID（OAuth2 的 client_id）。 */
  clientId: string
  /** App ID（请求头 X-App-Id）。 */
  appId: string
  /**
   * IDE 版本号（控制模型可用性：0.1.52 才能用 glm-5.3）。
   *
   * 版本号是「模型可用的准入条件」—— 上游按 `X-Ide-Version` / `X-App-Version-Code`
   * 决定哪些模型可以返回，版本过低时 glm-5.3 等新模型会报 `4001 param is invalid`。
   */
  ideVersion: string
  /** IDE 版本号代码（日期式，如 `20260811`）。 */
  ideVersionCode: string
  /** 设备品牌（请求头 X-Device-Brand）。 */
  deviceBrand: string
  /** 操作系统版本（请求头 X-OS-Version）。 */
  osVersion: string
  /**
   * **默认**对话通道（`function`），模型未标明所属通道时使用。
   *
   * ⚠️ 它不是「唯一的通道」——各通道模型集不同，真正的通道归属由远端目录
   * 的每条 `function` 决定（见 {@link channels}）。
   */
  function: string
  /**
   * 要拉取的**全部**对话通道，**顺序即优先级**。
   *
   * 真实 CN IDE 用 `batch_get_detail_param` 一次查 22 个 function，每个
   * function 各自一套模型目录；同一条目在不同通道的可用性（`is_custom_model`
   * / `is_invisible_to_user` / `config_switch`）**可以不同**，而且
   * **模型只在列出它的通道里可调用**（发错通道 → 流内 `4001`）。
   *
   * 这里只列**实测可调用**的通道，并让 `solo_work_lite` 排在首位以保持既有
   * 模型的通道不变（最小行为变更）；`solo_agent_remote` 补上 agent 专有模型
   * （`glm-5.1` / `qwen-3.5` / `Doubao-Seed-Code`）与 1M 上下文声明。
   *
   * 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖以试验其它通道。
   */
  channels: readonly string[]
  /**
   * 远端不可用时的兜底输出上限（`max_tokens`）。
   *
   * 实测主流模型在远端声明的即为此值；远端可用时**以远端为准**。
   * 不放进 `fallbackModels` 逐条声明是因为各模型真实值并不一致
   * （4000 ~ 384000），逐条填只会编造出更细的假数据。
   */
  fallbackMaxOutputTokens?: number
  /**
   * 是否启用 **Max 模式**（1M 上下文）。**默认开启**，显式设 `DSH_TRAE_MAX_MODE=0` 关闭。
   *
   * 默认开的原因（用户要求）：上下文应当用**最大的那一档**。开启后只有远端
   * `display_config.max_mode === true` 的模型才会走 1M —— 未标记的模型即便
   * 开关为开也仍走常规 `dev`(200K)，见 `TraeAdapter.maxModeFor`，所以开启
   * 不会让任何模型失败。
   *
   * ⚠️ Max 会话向 1M 窗口里塞入远超常规的上下文，**计费倍率与常规会话不同**
   * （远端按 `strategy=max` 单独计价）。需要省额度时设 `DSH_TRAE_MAX_MODE=0`。
   *
   * 与 `Trae2api-cn` 的 `TRAE_REMOTE_MAX_MODE` 同名（但那边默认 `0`，本插件
   * 按用户要求改为默认开）。
   */
  maxMode?: boolean
  /**
   * Max 模式白名单（逗号分隔，`DSH_TRAE_MAX_MODELS`）。留空 = 所有
   * `max_mode=true` 的模型都生效；含 `*` 亦表示全部。
   *
   * 对齐 `Trae2api-cn` 的 `TRAE_REMOTE_MAX_MODELS`。
   */
  maxModeModels?: readonly string[]
  /**
   * @deprecated **不再生效**。`is_invisible_to_user` 过滤已移至
   * `parseTraeBatchModelList` 作为硬性过滤执行，不再由本开关控制。保留字段
   * 仅为避免破坏现有 profile 配置中显式设置了该值的用户。
   */
  hideInternalModels?: boolean
  /**
   * 登录 URL 的 `plugin_version` 参数（**不是** IDE 版本号）。
   *
   * 实测值 `2.3.62834`（`login.sh:54`）—— 与 `ideVersion` 是两个独立字段：
   * 前者是登录门户认的插件版本，后者是 chat 端点的模型准入版本。
   */
  pluginVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** User-Agent。 */
  userAgent: string
  /** 远端模型列表不可用时的兜底模型目录。 */
  fallbackModels: readonly TraeFallbackModel[]
}

/** 上游 API 基址（Agent 服务，国内版）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'
/** 签到/积分/Ug 基址（国内版）。 */
export const TRAE_UG_HOST = 'https://api.trae.cn'
/** OAuth/认证基址（国内版）。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'
/** 登录门户基址（国内版）。 */
export const TRAE_CONSOLE_HOST = 'https://www.trae.cn'

/**
 * 国际版（Trae / trae.ai）端点。
 *
 * ## 证据来源（本机已装官方客户端，2026-09-22 实测）
 *
 * 本机同时存在 `Trae` 与 `Trae CN` 两套客户端用户数据
 * （`%APPDATA%\Trae` / `%APPDATA%\Trae CN`），从其中的日志与
 * `ahanet/server.json` 提取到两套互不相同的域名：
 *
 * | 维度 | 国内版（Trae CN） | 国际版（Trae） |
 * |---|---|---|
 * | 门户 | `www.trae.cn` | `www.trae.ai` |
 * | 认证 | `api.trae.com.cn` | `api.trae.ai` / `api-us-east.trae.ai` |
 * | 站点 | `api.trae.cn` | —— |
 * | Agent | `trae-api-cn.mchost.guru` | `api5-normal-alisg.mchost.guru` |
 *
 * ⚠️ **Agent host 不能简单把 `-cn` 换成 `sg`**：国际版真实出站域名是
 * `api5-normal-alisg.mchost.guru`（日志 `x-tt-net-final-domain` 实测），
 * 而 `trae-api-sg.mchost.guru` / `trae-api-us.mchost.guru` 出现在
 * `ahanet/server.json` 的 IP 映射表里 —— 那是**接入点**，与业务 host 不同层。
 * 取实测出站的那个。
 *
 * ⚠️ 国际版**没有** `api.trae.cn` 那层「站点域」，其 Ug（签到/积分）走
 * `api.trae.ai`（日志里 userRegion=us 时 host 为 `api-us-east.trae.ai`；
 * 通用入口用 `api.trae.ai`，与 `coresg-normal.trae.ai` 同域族）。
 */
export const TRAE_INTL_AGENT_HOST = 'https://api5-normal-alisg.mchost.guru'
/** 签到/积分/Ug 基址（国际版）。 */
export const TRAE_INTL_UG_HOST = 'https://api.trae.ai'
/** OAuth/认证基址（国际版）。 */
export const TRAE_INTL_OAUTH_HOST = 'https://api.trae.ai'
/** 登录门户基址（国际版）。 */
export const TRAE_INTL_CONSOLE_HOST = 'https://www.trae.ai'

/**
 * 兜底模型目录（32 个，对齐 Go 端 staticModels）。
 *
 * 来源：`handler.go:247-280`，2026-08 实测快照。
 * 顺序照抄 Go 端，不重排。远端可用时完全采信远端，本表只在远端整体失败时顶替。
 */
const TRAE_FALLBACK_MODELS: readonly TraeFallbackModel[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
  { id: 'browser_use_subagent', name: 'Browser Use Subagent', contextWindow: 200_000, isHidden: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
  { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200_000 },
  { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200_000 },
  { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200_000 },
  { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200_000 },
  { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200_000 },
  { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200_000 },
  { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200_000 },
  { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200_000 },
  { id: 'explore_sub_agent_v13', name: 'Explore Sub Agent V13', contextWindow: 200_000, isHidden: true },
  { id: 'explore_sub_agent_v2', name: 'Explore Sub Agent V2', contextWindow: 200_000, isHidden: true },
  { id: 'summary', name: 'Summary', contextWindow: 200_000, isHidden: true },
]

/**
 * 要拉取的对话通道（顺序即优先级）。
 *
 * 默认含三个实测可调用通道：
 * - `solo_agent`：**首位**，对应截图 Auto Mode 的模型列表（`function_configs`
 *   中 `function: "solo_agent"` 的 `config_info_list`）。包含最多的模型（约 66
 *   条），以及 `display_contact_config` 折扣信息、`reasoning_effort_config` 等
 *   完整配置。
 * - `solo_work_lite`：本项目既有通道，`glm-5-turbo` / `sagitta` 等在此通道可用。
 * - `solo_agent_remote`：补上 agent 专有模型（`glm-5.1` / `qwen-3.5` 等）。
 *
 * 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖。
 */
export const TRAE_CHANNELS: readonly string[] = resolveChannelList(
  process.env.DSH_TRAE_CHANNELS,
)

/** 解析 `DSH_TRAE_CHANNELS`；空/非法时回退默认通道列表。 */
function resolveChannelList(raw: string | undefined): readonly string[] {
  const fallback: readonly string[] = ['solo_agent', 'solo_work_lite', 'solo_agent_remote']
  if (raw === undefined) return fallback
  const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : fallback
}

/** 解析布尔型开关环境变量；只有显式真值才算开启。 */
function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * 解析 `DSH_TRAE_MAX_MODE`；**默认开启**（用户要求「上下文用最大的那一档」）。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭 —— 与
 * `isTruthyFlag` 的「默认关」语义相反，故单列一个函数，不要混用。
 */
function resolveMaxModeFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/**
 * 解析 `DSH_TRAE_MAX_MODELS` 白名单。
 *
 * 留空返回 `undefined`（而非空数组）：空数组在下游是「白名单存在但什么都不匹配」
 * 的语义，会把 Max 模式**全部**关掉，与「留空 = 全部生效」相反。
 */
function resolveMaxModeModels(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined
  const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : undefined
}

/**
 * TRAE provider 配置（国内版）。
 */
export const TRAE: TraeProduct = {
  id: 'trae',
  site: 'cn',
  displayName: 'TRAE (字节)',
  agentHost: TRAE_AGENT_HOST,
  ugHost: TRAE_UG_HOST,
  oauthHost: TRAE_OAUTH_HOST,
  consoleHost: TRAE_CONSOLE_HOST,
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  channels: TRAE_CHANNELS,
  fallbackMaxOutputTokens: 32_000,
  maxMode: resolveMaxModeFlag(process.env.DSH_TRAE_MAX_MODE),
  maxModeModels: resolveMaxModeModels(process.env.DSH_TRAE_MAX_MODELS),
  hideInternalModels: isTruthyFlag(process.env.DSH_TRAE_HIDE_INTERNAL),
  pluginVersion: '2.3.62834',
  defaultCredentialRef: 'TRAE_ACCESS_TOKEN',
  userAgent: 'Trae/0.1.52',
  fallbackModels: TRAE_FALLBACK_MODELS,
}

/**
 * TRAE 国际版（Trae / trae.ai）。
 *
 * 与国内版是**两个独立客户端**（本机实测 `Trae` 与 `Trae CN` 各一套用户数据），
 * 协议一致、仅域名不同 —— 因此共用同一个 `TraeAdapter`，差异全部由本配置承载，
 * 与 buddy / workbuddy 那对同源产品同一套做法。
 *
 * ⚠️ **登录与账号体系互相独立**：两边的登录态不通（不同 client_id 与门户域），
 * 故国际版给独立的 `defaultCredentialRef`，账号也各归各的 provider
 * （`trae` / `trae-intl`），避免串用凭据 —— 这与本插件在 workbuddy 上踩过的
 * 「provider 实参写死导致查不到账号」是同一类防护。
 *
 * ⚠️ 其余身份字段（`clientId` / `appId` / `ideVersion` / `pluginVersion`）
 * **沿用与国内版相同的值**：本机国际版客户端的日志里能读到
 * `client_id=ono9krqynydwx5`，但那是**桌面 IDE 的 OAuth client**，与
 * 「SOLO 通道」所用的 `en1oxy7wnw8j9n` 不是同一套体系（本插件走 SOLO 通道）。
 * 在没有国际版 SOLO 通道实测凭据前**不臆造新值** —— 沿用已知可用值，
 * 若上游拒绝会以明确的 `4001` 报错暴露，便于再校正。
 */
export const TRAE_INTL: TraeProduct = {
  id: 'trae-intl',
  site: 'global',
  displayName: 'TRAE (国际版)',
  agentHost: TRAE_INTL_AGENT_HOST,
  ugHost: TRAE_INTL_UG_HOST,
  oauthHost: TRAE_INTL_OAUTH_HOST,
  consoleHost: TRAE_INTL_CONSOLE_HOST,
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  channels: TRAE_CHANNELS,
  fallbackMaxOutputTokens: 32_000,
  maxMode: resolveMaxModeFlag(process.env.DSH_TRAE_MAX_MODE),
  maxModeModels: resolveMaxModeModels(process.env.DSH_TRAE_MAX_MODELS),
  hideInternalModels: isTruthyFlag(process.env.DSH_TRAE_HIDE_INTERNAL),
  pluginVersion: '2.3.62834',
  defaultCredentialRef: 'TRAE_INTL_ACCESS_TOKEN',
  userAgent: 'Trae/0.1.52',
  fallbackModels: TRAE_FALLBACK_MODELS,
}

/**
 * 全部 TRAE 产品配置。
 *
 * 国内版与国际版**分别注册**（provider id 为 `trae` / `trae-intl`）。
 */
export const ALL_TRAE_PRODUCTS: readonly TraeProduct[] = [TRAE, TRAE_INTL]

/** 按 provider id 取 TRAE 产品配置；未知 id 返回 undefined。 */
export function traeProductById(id: string): TraeProduct | undefined {
  return ALL_TRAE_PRODUCTS.find((product) => product.id === id)
}
