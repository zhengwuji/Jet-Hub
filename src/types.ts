import type { DpopPrivateJwk } from './oauth.js'

/** snap-manager ticket 端点响应的传输格式。 */
export interface CodeArtsCredentialResponse {
  credential?: {
    access?: string
    secret?: string
    securitytoken?: string
    securityToken?: string
    expires_at?: string
    expiresAt?: string
  }
  result?: {
    accessKeyId?: string
    secretAccessKey?: string
    securityToken?: string
    expiration?: string
    expiresAt?: string
  }
  domain_id?: string
  user_id?: string
  user_name?: string
  error_code?: string
  error_msg?: string
}

/**
 * ========================================
 * ProviderAccountEntry 与多账号相关类型
 * ========================================
 */

/** 每个模型的重置时间信息 */
export interface RateLimitInfo {
  /** 模型 ID（如 'deepseek-v4-flash'） */
  modelId: string
  /** 重置时间戳（毫秒）；0 或缺失 = 不在重置期 */
  resetAtMs: number
}

/** 账号索引条目（存于 ctx.settings，非 credentials） */
export interface ProviderAccountEntry {
  /** 账号唯一标识：{provider}-{shortid}（如 'codearts-a1b2c3d4'） */
  id: string
  /** provider 名称：'codearts' | 'buddy' */
  provider: string
  /** 用户可读昵称 */
  nickname: string
  /** 是否启用（停用不参与自动切换） */
  enabled: boolean
  /** 对应的 credential ref 名称：{PROVIDER}_ACCOUNT_{UUID_SHORT}（如 'CODEARTS_ACCOUNT_A1B2C3D4'） */
  credentialRef: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 凭据过期时间（毫秒时间戳），用于展示 */
  expiresAt?: number
  /** 是否可静默续期 */
  refreshable: boolean
  /** 每个模型的重置时间，key=模型ID（毫秒时间戳） */
  modelRateLimits?: Record<string, number>
  /**
   * TRAE 签到设备轮换代次（仅 `trae` provider 使用）。
   *
   * 业务码 `9074`（签到人数过多）的限流范围是 **device_id 而非账号**：
   * 命中后把代次 +1，即可由 `device_id` 派生出一个全新的签到设备号绕开它
   * （见 `src/trae.ts` 的 `deriveCheckinDeviceId`）。
   *
   * 这里只存**整数代次**而不是新设备号本身：派生结果由
   * `(credential.device_id, generation)` 唯一决定，故无需改写凭据本体
   * （登录凭据里的 `device_id` 是设备指纹，动它会牵涉风控）。
   *
   * 缺省/0 = 使用凭据原始 `device_id`，既有账号行为完全不变。
   */
  traeCheckinDeviceGeneration?: number
}

/** 账号详细状态（返回给 Client 展示） */
export interface ProviderAccountStatus extends ProviderAccountEntry {
  /** 最近刷新错误 */
  refreshError?: string
  /** 来源（env/file 等） */
  source?: string
}

/** Jet Hub 在 ctx.settings 中的 schema */
export interface JetHubConfig {
  accounts: ProviderAccountEntry[]
  /**
   * 模型黑名单：provider id → 模型 id → true。
   *
   * **黑名单制**：只有键存在且为 true 的模型被隐藏，未记录的模型默认打开。
   */
  disabledModels?: Record<string, Record<string, boolean>>
}

/** RPC 端点请求/响应类型 */
export interface RpcListAccountsRequest {
  provider: string
}
export interface RpcListAccountsResponse {
  accounts: ProviderAccountStatus[]
}

export interface RpcCreateAccountRequest {
  provider: string
}
export interface RpcCreateAccountResponse {
  accountId: string
  loginUrl: string
}

export interface RpcPollLoginRequest {
  accountId: string
  provider: string
}
export interface RpcPollLoginResponse {
  done: boolean
  success?: boolean
  error?: string
}

export interface RpcUpdateAccountRequest {
  accountId: string
  patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled'>>
}

export interface RpcDeleteAccountRequest {
  accountId: string
}

/**
 * RPC: 重排某 provider 的账号顺序（Jet Hub 拖拽排序）。
 *
 * 传该 provider **全部**账号 id 的目标顺序；服务端据此重写数组顺序，
 * 该顺序即自动选号/限流换号的候选优先级（见 `AccountPool.reorderAccounts`）。
 */
export interface RpcReorderAccountsRequest {
  provider: string
  /** 该 provider 全部账号 id，按目标顺序排列。 */
  orderedIds: string[]
}

export interface RpcRefreshAccountRequest {
  accountId: string
}
export interface RpcRefreshAccountResponse {
  success: boolean
  error?: string
}

/**
 * ========================================
 * 限流标记重测 / 重置
 * ========================================
 */

/** 单个模型的探测结果。 */
export interface ProbeModelResult {
  modelId: string
  ok: boolean
  /** 失败时的可读原因（限流文案 / HTTP 状态等）。 */
  message?: string
}

/** 单个账号的重测结果。 */
export interface ProbeAccountResult {
  accountId: string
  nickname?: string
  /** 探测的模型数；0 表示该账号没有限流标记，无需重测。 */
  tested: number
  /** 确认恢复正常、标记已清除的模型。 */
  cleared: string[]
  /** 仍受限的模型。 */
  stillLimited: ProbeModelResult[]
  /** 探测过程中的异常（凭据不可用、网络失败等）。 */
  error?: string
}

/** 重测单个账号（使用该账号自己的凭据发送探测消息）。 */
export interface RpcRetestAccountRequest {
  accountId: string
}
/** 重测该 provider 下的全部账号（**包含已停用账号**）。 */
export interface RpcRetestAllRequest {
  provider: string
}
/** 重测结果（单账号与全部共用同一响应结构）。 */
export interface RpcRetestResponse {
  accounts: ProbeAccountResult[]
  /** 汇总：清除的限流标记总数。 */
  clearedCount: number
}

/** 重置单个账号的限流标记（不测试，直接清除）。 */
export interface RpcResetAccountRequest {
  accountId: string
}
/** 重置该 provider 下全部账号的限流标记（**包含已停用账号**）。 */
export interface RpcResetAllRequest {
  provider: string
}
/** 重置结果。 */
export interface RpcResetResponse {
  /** 清除的限流标记总数。 */
  clearedCount: number
  /** 实际被清除了标记的账号数。 */
  accountCount: number
}

/**
 * ========================================
 * 每日签到（积分领取）
 * ========================================
 */

/** RPC: 查询签到状态请求 */
export interface RpcCreditsStatusRequest {
  provider: string
}
/** 单个账号的签到状态 */
export interface RpcCreditsAccountStatus {
  accountId: string
  nickname: string
  /** 状态查询失败（网络错误/凭据损坏）时为 null */
  status: import('./credits.js').CheckinStatus | null
}
/** RPC: 查询签到状态响应 */
export interface RpcCreditsStatusResponse {
  accounts: RpcCreditsAccountStatus[]
}

/** RPC: 一键领取积分请求 */
export interface RpcCreditsClaimAllRequest {
  provider: string
}
/** 单个账号的领取结果 */
export interface RpcCreditsClaimAccountResult {
  accountId: string
  nickname: string
  outcome: import('./credits.js').ClaimOutcome
}
/** 领取汇总 */
export interface RpcCreditsClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
}
/** RPC: 一键领取积分响应 */
export interface RpcCreditsClaimAllResponse {
  results: RpcCreditsClaimAccountResult[]
  summary: RpcCreditsClaimSummary
}

/**
 * ========================================
 * 积分余额（Credits Balance）
 * ========================================
 */

/** RPC: 查询某 provider 下全部账号的积分余额请求 */
export interface RpcCreditsBalancesRequest {
  provider: string
}

/**
 * 单个账号的积分余额。
 *
 * 与签到状态的设计取舍不同：余额**带回每个包的明细**而不只是总数 ——
 * 用户看到「347.87」时通常还想知道它由哪些包构成、各自何时到期（实测一个
 * 账号常同时有「Bonus Pack」与「Free Plan Subscription」两个周期不同的包）。
 * 明细只有几项，一次带回比让前端再发一次请求更划算。
 */
export interface RpcCreditsBalanceAccount {
  accountId: string
  nickname: string
  /** 余额查询失败（网络/凭据/响应异常）时为 null —— 与「余额为 0」严格区分。 */
  balance: import('./credits.js').CreditBalance | null
  /** 查询失败的原因，供 UI 提示（成功时为 undefined）。 */
  error?: string
}

/** RPC: 查询积分余额响应 */
export interface RpcCreditsBalancesResponse {
  accounts: RpcCreditsBalanceAccount[]
}

/**
 * ========================================
 * 模型列表可见性（黑名单开关）
 * ========================================
 */

/** RPC: 列出某 provider 的模型请求 */
export interface RpcModelListRequest {
  provider: string
}

/**
 * 单个模型在设置页的展示条目。
 *
 * `disabled` 由服务端按黑名单回填，`name` 是适配器播报的展示名 ——
 * 两者都取自**权威来源**（适配器的 listModels），而不是前端自己再拼一份
 * 模型清单，否则远端模型池变化时设置页与对话框会显示两套不同的列表。
 */
export interface RpcModelListEntry {
  id: string
  name: string
  /** true = 已关闭（不出现在对话框的模型选择里）。 */
  disabled: boolean
}

/** RPC: 列出某 provider 的模型响应 */
export interface RpcModelListResponse {
  models: RpcModelListEntry[]
}

/** RPC: 打开/关闭某个模型请求 */
export interface RpcModelSetDisabledRequest {
  provider: string
  modelId: string
  disabled: boolean
}

/** RPC: 打开/关闭某个模型响应（回传写入后的完整黑名单，便于前端校验） */
export interface RpcModelSetDisabledResponse {
  provider: string
  disabledModels: Record<string, boolean>
}

/**
 * RPC: 批量打开/关闭某 provider 的全部模型请求。
 *
 * 两个方向**刻意不对称**（见 `AccountPool.setModelsDisabled` /
 * `clearDisabledModels`）：
 * - `disabled: true` 关闭全部：按当前目录逐项加入黑名单，服务端需要读目录；
 * - `disabled: false` 打开全部：直接清空该 provider 的黑名单，不读目录 ——
 *   这样「曾被关闭、后来从服务端目录里下线」的历史遗留键才能被清掉。
 *
 * `disabled` **没有默认值**：缺失或非布尔一律拒绝。若默认成 `true`，一次字段名
 * 写错的前端改动会静默关闭用户全部模型；默认成 `false` 则反向静默打开 ——
 * 两个方向都是灾难性且难察觉的。
 */
export interface RpcModelSetAllDisabledRequest {
  provider: string
  disabled: boolean
}

/** RPC: 批量打开/关闭响应（回传写入后的完整黑名单，与单条端点同结构） */
export type RpcModelSetAllDisabledResponse = RpcModelSetDisabledResponse

/** 存储在 CODEARTS_ACCESS_TOKEN 下的归一化临时凭据。 */
export interface CodeArtsCredential {
  access_key_id: string
  secret_access_key: string
  security_token: string
  expires_at: string
  domain_id?: string
  user_id?: string
  user_name?: string
  /** 刷新令牌（新式 IAM OAuth 流程签发；缺失表示旧 ticket 凭据，不可静默刷新）。 */
  refresh_token?: string
  /** PKCE 验证器，刷新换取时与 refresh_token 一起提交。 */
  code_verifier?: string
  /** DPoP ES256 私钥 JWK（随凭据持久化，刷新换取时签发 DPoP JWS）。 */
  dpop_private_key_jwk?: DpopPrivateJwk
  /** 模型速率限制/重置时间（框架层附加的运行时元数据，刷新凭据时需保留）。 */
  model_rate_limits?: Record<string, unknown>
}

/** 一次登录流程的结果：已存储的凭据值及其过期时间。 */
export interface LoginFlowResult {
  /** 原始令牌（token/fingerprint 分支）或 JSON.stringify(CodeArtsCredential)（轮询分支）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
}

/** runLoginFlow 和 startCallbackServer 接受的选项。 */
export interface LoginFlowOptions {
  /** pollForCredential 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: (url: string) => void | Promise<void>
  /** 轮询尝试次数上限；默认为 120。 */
  maxAttempts?: number
  /** 登录流程选择：'oauth'（默认）或 'ticket'（旧流程回退）。 */
  flow?: 'oauth' | 'ticket'
}

/**
 * buddy (腾讯 CodeBuddy) 凭据，存储在 BUDDY_ACCESS_TOKEN 下。
 * 定义与解析工具放在 buddy.ts（与 CodeBuddy 协议常量同处一处）。
 */
export type { BuddyCredential } from './buddy.js'

/**
 * ========================================
 * 账号备份（导出 / 导入）
 * ========================================
 */

/** 备份文件格式标识（自包含，与 DSH 版本无关）。 */
export const BACKUP_FORMAT = 'dsh-codearts-auth/backup'

/** 备份格式版本：格式演进时递增并保留迁移逻辑。 */
export const BACKUP_VERSION = 1

/**
 * 备份载荷（导出结果 / 导入输入）。
 *
 * 设计要点：
 * - `credentials` 的值保存凭据 JSON **原文字符串**（与 `ctx.credentials`
 *   存储形态一致），导入时 `set(ref, value)` 直接回写，不重新序列化，
 *   避免字段丢失或变形；
 * - `accounts` 是账号池索引（ProviderAccountEntry 原文），`disabledModels`
 *   是模型黑名单 —— 两者与 `JetHubState` 同构，导入后整体替换；
 * - 整个文件自包含且带 `format` / `version` 标记，因此与 DSH 版本无关：
 *   换版本后导入时按**当前版本**的存储契约重建。
 */
export interface BackupPayload {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** 导出时间（ISO 8601），用于展示与可选的新旧校验。 */
  exportedAt: string
  /** credentialRef → 凭据 JSON 原文（字符串）。 */
  credentials: Record<string, string>
  /** 账号池索引（ProviderAccountEntry 原文）。 */
  accounts: ProviderAccountEntry[]
  /** 模型黑名单：provider id → 被关闭的模型 id → true。 */
  disabledModels: Record<string, Record<string, boolean>>
}

/** RPC: 导出备份响应。 */
export interface RpcBackupExportResponse {
  payload: BackupPayload
  /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
  warnings: string[]
}

/** RPC: 导入备份请求。 */
export interface RpcBackupImportRequest {
  /** 备份载荷（明文 JSON 解析后的对象；加密文件在浏览器侧解密后传入）。 */
  payload: unknown
}

/** RPC: 导入备份响应。 */
export interface RpcBackupImportResponse {
  /** 写入的凭据条数。 */
  credentialsImported: number
  /** 写入的账号数。 */
  accountsImported: number
  /** 跳过的凭据 ref（非法 ref 等）。 */
  skipped: string[]
  /**
   * 导入的账号中「凭据已过期」的条数（账号条目的 `expiresAt <= 当前时刻`）。
   * 这类账号即使 refresh_token 尚有效也会在下一次请求时先静默续期；若
   * refresh_token 也已失效（导出后搁置过久 / CodeArts 一次性轮换），则需
   * 重新登录。前端据此提示用户。
   */
  expiredAccounts: number
  /**
   * 导入的账号中「凭据缺失」的条数：账号条目存在，但其 credentialRef 不在
   * 备份的 credentials 字典里。这类账号导入后无凭据可用，对应 provider 的
   * 模型目录会被门控隐藏（像未登录一样）。前端据此提示用户重新登录该账号。
   */
  missingCredentials: number
}

/**
 * RPC: 查询当前账号池统计（导入前的覆盖提示用）。
 *
 * `withoutExpiry` 统计缺 `expiresAt` 的账号条目——这正是 DSH 版本切换后
 * 自动恢复（`bootstrapFromCredentialRefs`）产生的条目特征：反推只按凭据
 * ref 名重建，不读凭据值，故拿不到有效期。正常登录的账号基本都带
 * `expiresAt`。该数字用于导入前提示「有 N 个自动恢复的账号将被覆盖」。
 */
export interface RpcBackupStatusResponse {
  /** 当前账号池的账号总数。 */
  accounts: number
  /** 缺 `expiresAt` 的账号条目数（疑似自动恢复产物）。 */
  withoutExpiry: number
}
