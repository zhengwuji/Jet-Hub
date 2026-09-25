/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { CodeArtsCredential } from './types.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { QoderAuth } from './qoder-auth.js'
import type { TraeAuth } from './trae-auth.js'
import type { ClineAuth } from './cline-auth.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs } from './lobsterai.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { isQoderRefreshable, qoderCredentialExpiresAtMs } from './qoder.js'
import type { QoderCredential } from './qoder.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js'
import { isTraeRefreshable, traeCredentialExpiresAtMs } from './trae.js'
import type { TraeCredential } from './trae.js'
import { fetchClineCreditBalance } from './cline-credits.js'
import {
  clineCredentialExpiresAtMs,
  isClineRefreshable,
  type ClineCredential,
} from './cline.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js'
import { credentialExpiresAtMs } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
  type CheckinStatus,
  type ClaimOutcome,
  type CreditBalance,
} from './credits.js'
import { CODEBUDDY, productById, type BuddyProduct } from './product.js'
import {
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance,
} from './lobsterai-credits.js'
import {
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfoDetailed,
} from './codearts-credits.js'
import {
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance,
} from './trae-credits.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
import type {
  ProviderAccountEntry,
  RpcListAccountsRequest,
  RpcListAccountsResponse,
  RpcCreateAccountRequest,
  RpcCreateAccountResponse,
  RpcPollLoginRequest,
  RpcPollLoginResponse,
  RpcUpdateAccountRequest,
  RpcDeleteAccountRequest,
  RpcReorderAccountsRequest,
  RpcRefreshAccountRequest,
  RpcRefreshAccountResponse,
  RpcRetestAccountRequest,
  RpcRetestAllRequest,
  RpcResetAccountRequest,
  RpcResetAllRequest,
  RpcCreditsStatusRequest,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllRequest,
  RpcCreditsClaimAllResponse,
  RpcCreditsClaimSummary,
  RpcCreditsBalancesRequest,
  RpcCreditsBalancesResponse,
  RpcModelListRequest,
  RpcModelListResponse,
  RpcModelSetDisabledRequest,
  RpcModelSetDisabledResponse,
  RpcModelSetAllDisabledRequest,
  RpcModelSetAllDisabledResponse,
} from './types.js'

/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 CodeArts 凭据 JSON；解析失败返回 undefined。 */
function parseCodeArtsCredential(raw: string): CodeArtsCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as CodeArtsCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_key_id === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 LobsterAI 凭据 JSON；解析失败返回 undefined。 */
function parseLobsteraiCredential(raw: string): LobsteraiCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as LobsteraiCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Qoder 凭据 JSON；解析失败返回 undefined。 */
function parseQoderCredential(raw: string): QoderCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as QoderCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 TRAE 凭据 JSON；解析失败返回 undefined。 */
function parseTraeCredential(raw: string): TraeCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as TraeCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Cline 凭据 JSON；解析失败返回 undefined。 */
function parseClineCredential(raw: string): ClineCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as ClineCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<
  TCredential = BuddyCredential,
  TProduct = BuddyProduct,
> {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry) => Promise<ClaimOutcome>
  /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /**
   * 余额查询的**带原因**版本（优先于 {@link fetchBalance}）。
   *
   * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
   * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
   * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
   * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
   * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
   */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
  ) => Promise<{ balance: CreditBalance | null; error?: string }>
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /**
   * 领取前是否先查一次签到状态（默认 `true`）。
   *
   * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
   * 领取请求（活动未开 / 今天已领时直接短路）。
   *
   * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
   * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
   * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
   * 故它传 `false` 跳过预检，直接交给 `claim`。
   */
  precheckStatus?: boolean
  /**
   * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
   * 使用的 fetch。
   *
   * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
   * `(credential, product, fetcher)`，而本模块的历史写法是
   * `deps.claim ?? (claimDailyCheckin as unknown as …)`，把三参函数硬转成
   * 「只传两个参数」的类型 —— 于是调用点写 `claim(credential, product, entry)`
   * 时，`entry` 落进了 `fetcher` 位置，运行时抛
   * **`TypeError: fetcher is not a function`**（真实缺陷：用户一键领取 4 个
   * CodeBuddy 账号全部失败）。
   *
   * 现改为**显式包装**默认实现（见下面的 `resolveClaim` 等），既保留 `entry`
   * 给需要它的 provider（TRAE 用 `entry.id` 取签到设备代次），又把 fetcher
   * 正确送进第三参。未提供时用全局 `fetch`。
   */
  fetcher?: typeof fetch
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  // 与 collectClaimResults 同款：显式包装默认实现把 fetcher 送进第三参，
  // 不用 `as unknown as` 掩盖签名差异（见 CreditsEndpointDeps.fetcher 的说明）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const results: RpcCreditsStatusResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as TCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
      deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转。**
  //
  // 真实签名是 `(credential, product, fetcher)`，而本接口把 `claim` 声明为
  // `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
  // 历史写法用 `as unknown as` 把这个不匹配「压」过去 —— TypeScript 于是不再
  // 报错，但调用点传的第三个实参是 `entry`，它落进 `fetcher` 位置，运行时抛
  // **`TypeError: fetcher is not a function`**。
  // **真实缺陷**：用户一键领取 4 个 CodeBuddy 账号全部失败，报错就是这句。
  //
  // 修法：显式包装 —— 把 `deps.fetcher`（或全局 `fetch`）送进第三参，
  // `entry` 只交给真正需要它的 provider（它们在自己的分支里注入 `claim`）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const claim = deps.claim
    ?? (async (credential: TCredential, product: TProduct): Promise<ClaimOutcome> =>
      claimDailyCheckin(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product, entry)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product, entry)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  // 同 collectClaimResults：显式包装，避免 `as unknown as` 掩盖签名差异。
  const fetcher = deps.fetcher ?? fetch
  const fetchBalance = deps.fetchBalance
    ?? (async (credential: TCredential, product: TProduct): Promise<CreditBalance | null> =>
      fetchCreditBalance(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const fetchDetailed = deps.fetchBalanceDetailed
  const results: RpcCreditsBalancesResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        error = '凭据未配置'
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (fetchDetailed !== undefined) {
          // 带原因的查询：实现自己决定「非积分账户」等业务状态的文案。
          const detailed = await fetchDetailed(credential, product)
          balance = detailed.balance
          error = detailed.error
          if (balance === null && error === undefined) error = '余额查询失败'
        } else {
          balance = await fetchBalance(credential, product)
          // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
          if (balance === null) error = '余额查询失败'
        }
      }
    } catch (caught) {
      deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
      error = caught instanceof Error ? caught.message : String(caught)
      balance = null
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
    })
  }
  return results
}

/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * 用 `ctx.get` 而不是 `inject`：Jet Hub 的账号管理是主要职责，模型开关只是
 * 附加能力；llm 服务缺失时账号面板仍应可用，只是「显示列表」按钮报错。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故这里把它
 * 声明为可选：缺失时退化为「用 listModels 的结果 + 黑名单补回裸 id」。
 */
function llmServiceOf(ctx: Context): {
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  listAllModels?(provider: string): readonly { id: string; name: string }[]
} | undefined {
  return ctx.get('llm') as
    | {
      listModels(provider: string): Promise<Array<{ id: string; name: string }>>
      listAllModels?(provider: string): readonly { id: string; name: string }[]
    }
    | undefined
}

/**
 * 注册 Jet Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  qoder: QoderAuth,
  trae: TraeAuth,
  cline: ClineAuth,
  /**
   * provider → 适配器实例（可选）。
   *
   * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
   * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
   * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
   */
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerJetHubEndpoints(
      connectionCtx as Context, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, modelAdapters,
    )
  })
}

/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单**的完整目录。
 *
 * 只声明用到的方法（结构化类型），避免让本模块依赖五个具体适配器类。
 */
export interface ModelCatalogSource {
  listAllModels(): readonly { id: string; name: string }[]
}

/**
 * 广播「模型目录可能已变化」。
 *
 * ⚠️ **改黑名单后必须调用**，否则「关闭后选择器里仍能看到该模型，重启后才消失」
 * （真实缺陷，用户报障）。根因在客户端而非适配器：
 * `dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把 `modelCatalog`
 * 响应存进一个 `status === 'ready'` 即**短路返回缓存**的 store，只在三个转发的
 * 宿主事件上 `refresh()`：`llm/adapters-updated` / `settings/document-updated`
 * / `credentials/reference-updated`。
 *
 * 0.1.7 起黑名单落在插件自有文档 `$DSH_HOME/jet-hub/state.json`（不再经 settings
 * 文档，见 jet-hub-store.ts），因此写开关**不会**触发上述任何一个事件 → 客户端
 * 一直复用旧目录，直到重启（`connection/reset` → `resetGeneration()`）才重拉。
 *
 * 三者中 `llm/adapters-updated` 最贴合：按契约它是**无载荷**的「目录可能变了，
 * 请重新读 listModels」通知（dsh-llm README：*consumers re-read the registries*），
 * 正是这里要表达的语义。它也在 `API_REMOTE_FORWARDED_EVENTS` 白名单里，故会真的
 * 送达浏览器。不改变拓扑，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
 * `retryPolicy`）必然通过，不会误报 INVARIANT。
 *
 * ⚠️ **通知失败不能反噬已经落盘的开关**：否则用户看到「切换失败」而实际已生效，
 * 再点一次又因幂等而看似「无效」，比不提示更难排查。故这里自行吞掉异常只记日志。
 */
function broadcastCatalogChanged(ctx: Context): void {
  try {
    ctx.emit('llm/adapters-updated')
  } catch (error) {
    ctx.logger.warn(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`)
  }
}

/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  qoder: QoderAuth,
  trae: TraeAuth,
  cline: ClineAuth,
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  connection.fetch.register({
    path: JET_HUB_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = await request.json() as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== JET_HUB_ENDPOINT
        || !call || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Jet Hub management request.' } })
      }

      try {
        const result = await handleMethod(call.method as string, call.payload, request.signal)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
        // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'jet-hub/handler-failed', message },
        })
      }
    },
  })

  /** 分发端点方法到对应的处理器 */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        const accounts = await pool.listAccounts(req.provider)
        return { ok: true, value: { accounts } }
      }

      case 'account.create': {
        const req = payload as RpcCreateAccountRequest
        const { provider } = req
        const id = `${provider}-${shortId()}`
        const suffix = shortId().toUpperCase()
        const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`

        // CodeBuddy 系（buddy / workbuddy）共用两步登录流程：
        // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
        // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
        // 参数、X-Product-Code、User-Agent），全部由 product 承载。
        const product = productById(provider)
        if (product !== undefined) {
          let state: string
          let authUrl: string
          try {
            const authState = await fetchAuthState(undefined, undefined, product)
            state = authState.state
            // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId
            authUrl = decorateLoginUrl(authState.authUrl, product)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`)
          }
          const ref = credentialRef(refName)
          // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          // 后台异步执行完整登录流程，使用同一个 state
          runBuddyLoginFlow({ openBrowser: () => {}, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access)
            // 续期定时器归属该产品自己的服务实例
            ;(product.id === CODEBUDDY.id ? buddy : workbuddy).scheduleRefresh()
            const credential = parseBuddyCredential(flow.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((err) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: authUrl } }
        } else if (provider === 'codearts') {
          // CodeArts 也是**回调式**登录（本地回调服务器收授权码），但同样必须
          // 走两步式：先返回 loginUrl 让前端立刻 window.open，后台再等回调。
          //
          // 为什么不能像早期那样 await 整个流程（真实缺陷）：浏览器只在用户
          // 点击后的短暂窗口（transient activation，约 5 秒）内允许 window.open。
          // 阻塞数十秒后才返回 URL，弹窗必被拦截并返回 null，前端兜底逻辑
          // 便执行 `window.location.href = loginUrl`，把整个设置页跳走
          // ——用户报的「主页面直接跳转过去了」正是此因。
          const started = await codearts.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: 'codearts',
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseCodeArtsCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.user_name !== undefined && credential.user_name.length > 0
                ? credential.user_name
                : id,
              expiresAt: credential?.expires_at !== undefined
                ? (Number.isNaN(Date.parse(credential.expires_at)) ? undefined : Date.parse(credential.expires_at))
                : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background codearts login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === LOBSTERAI.id) {
          // LobsterAI 与 codearts 同款：回调式登录 + 两步式返回，
          // 理由见上面的 codearts 分支（弹窗拦截导致主页面被跳转）。
          const started = await lobsterai.startLogin({ refName })
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseLobsteraiCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`)
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === QODER.id) {
          // Qoder 与 codearts / lobsterai 同款两步式，但登录机制不同：
          // 它是**设备码轮询**（不开本地回调服务器，见 src/qoder-oauth.ts），
          // 同样必须在用户授权前返回 loginUrl，理由见上面的 codearts 分支。
          const started = await qoder.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: QODER.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseQoderCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? qoderCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isQoderRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${QODER.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === TRAE.id) {
          // TRAE 回调式登录 + 两步式返回（与 LobsterAI / codearts 同因）。
          const started = await trae.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: TRAE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseTraeCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? traeCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isTraeRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${TRAE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === CLINE.id) {
          // Cline 是 **WorkOS 设备码轮询**登录（见 src/cline-oauth.ts）：
          // 与 Qoder 同为「不开本地回调服务器」的轮询式，但判据形态不同 ——
          // Qoder 看 HTTP 404，Cline 看响应体的 `error: authorization_pending`。
          //
          // ⚠️ 与 Qoder 的另一处差异：`startLogin` 内部要先发一次
          // `POST {workOsBase}/user_management/authorize/device` 拿到设备码，
          // 才能返回 loginUrl（Qoder 的 URL 是纯本地构造的）。那只是一次
          // 快速 POST，仍远快于浏览器手势窗口，故两步式的理由与 Qoder 一致。
          const started = await cline.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: CLINE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseClineCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? clineCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isClineRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${CLINE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else {
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }

      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }

      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }

      // 拖拽排序：重写该 provider 账号在池中的顺序。
      // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
      case 'account.reorder': {
        const req = payload as RpcReorderAccountsRequest
        if (typeof req.provider !== 'string' || req.provider.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
          return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } }
        }
        try {
          await pool.reorderAccounts(req.provider, req.orderedIds)
        } catch (error) {
          // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
          // 刷新重试，而不是抛成 jet-hub/handler-failed 那种「未知故障」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return { ok: true, value: undefined }
      }

      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          switch (entry.provider) {
            case 'codearts':
              await codearts.refreshAccountCredential(entry.credentialRef)
              break
            case 'buddy':
              await buddy.refreshAccountCredential(entry.credentialRef)
              break
            case 'workbuddy':
              await workbuddy.refreshAccountCredential(entry.credentialRef)
              break
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef)
              break
            case QODER.id:
              await qoder.refreshAccountCredential(entry.credentialRef)
              break
            case TRAE.id:
              await trae.refreshAccountCredential(entry.credentialRef)
              break
            case CLINE.id:
              await cline.refreshAccountCredential(entry.credentialRef)
              break
            default:
              throw new Error(`Unknown provider: ${entry.provider}`)
          }
          return { ok: true, value: { success: true } }
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }

      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }

      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
        const account = await retestAccount(pool, req.accountId)
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length },
        }
      }

      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case 'account.retestAll': {
        const req = payload as RpcRetestAllRequest
        const value = await retestAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 限流标记：重置（不发请求，直接清除）──
      case 'account.reset': {
        const req = payload as RpcResetAccountRequest
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }

      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        const value = await resetAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // 四个 provider 分属**三套互不相同的协议**，各自在自己的分支里处理：
      //   - CodeBuddy 系（buddy / workbuddy）：`productById()` 取 BuddyProduct，
      //     走 `collectCreditsStatus` 的默认实现；
      //   - `lobsterai`：slot → context 三步，无独立状态端点；
      //   - `codearts`：华为云 SDK-HMAC-SHA256 签名，无独立状态端点。
      //
      // ⚠️ 只有 CodeBuddy 系能经 `productById()` 解析出产品配置；后两者
      // **必须各自提前分支**，否则会落到下面的 bad-request。历史上 CodeArts
      // 就是因此恒回 `unsupported provider: codearts`（客户端在面板挂载时
      // 无条件调用 credits.balances，于是每打开一次设置页都在控制台报错并把
      // 账号卡片标成查询失败）。现在 CodeArts 已有真实实现，该 bad-request
      // 只对**未知** provider 生效。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        if (req.provider === 'codearts') {
          // CodeArts 没有独立的「签到状态」端点：可领状态要经
          // `statistics/plugin`（账户类型）+ `/v1/ops/delivery`（活动列表）
          // 两步才能得到，且语义与 CodeBuddy 的 CheckinStatus 不同构
          //（无 streak_days / daily_credit 等概念）。
          // 故与 LobsterAI 同样如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 没有独立的「签到状态」端点：活动状态要经
          // slot → context 两步才能得到，且语义与 CodeBuddy 的
          // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
          // 故这里如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === TRAE.id) {
          // TRAE 有签到状态端点，但需要发起 Ug 请求获取（见 claim 内部的多步流程）。
          // 与 LobsterAI/CodeArts 一样如实返回 null，由 claimAll 自行处理预检。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（对整个 sidecar 二进制做字符串扫描，
          // checkin / check-in / daily / campaign 均无任何 Cline 业务端点命中；
          // 见 src/cline-credits.ts 的模块注释）。故与 WorkBuddy 国际版一致，
          // 如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
      }

      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === QODER.id) {
          // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
          // 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
          // （与 LobsterAI 传 false 的理由同类）。
          //
          // ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
          // HTTP 200），已在 claimQoderCampaign 内部处理。
          const value = await collectClaimResults<QoderCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimQoderDailyCheckin(credential, QODER),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === 'codearts') {
          // CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
          // 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
          // 故 precheckStatus: false 跳过外部那次 CodeBuddy 式的状态查询 ——
          // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
          const value = await collectClaimResults<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimCodeArtsDailyCheckin(credential),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
          //（带缓存，通常无额外网络开销）。
          const clientVersion = await lobsterai.resolveClientVersion()
          const value = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimLobsteraiDailyCheckin(credential, product, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === TRAE.id) {
          const value = await collectClaimResults<TraeCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
            //
            // TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
            // `{code:0, message:"success"}`，与真正领取成功**无法区分**。
            // 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
            // 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
            // 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
            // 判据只能是 status 端点的 `checked_in`。
            fetchStatus: (credential) =>
              fetchTraeCheckinStatus(credential as TraeCredential, TRAE, fetch),
            claim: (credential, _product, entry) =>
              claimTraeDailyCheckin(
                credential as TraeCredential,
                TRAE,
                fetch,
                pool.traeCheckinDeviceGenerationFor(entry.id),
                (next) => pool.updateTraeCheckinDeviceGeneration(entry.id, next),
              ),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（见 src/cline-credits.ts 的模块注释：
          // 对整个 sidecar 做字符串扫描，无任何 checkin/campaign 业务端点）。
          // 客户端按能力矩阵（`credits-capabilities.js` 的
          // `cline: { balance: true, dailyCheckin: false }`）根本不会渲染
          // 「一键领取积分」按钮、也不会发起本调用；这里显式返回可读错误，
          // 而不是落到下面 `productById` 的 `unsupported provider` 泛化文案
          // —— 后者会让排查者以为是「provider 没注册」，而真相是「该产品无此能力」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Cline 不支持每日签到（其后端没有签到接口）',
            },
          }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }

      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === 'codearts') {
          // 余额来自 `statistics/plugin`（与账户类型检测同一个响应），
          // 故用带原因的钩子：非积分账户要显示「Token 计费账户」而不是
          // 误导性的「余额查询失败」。
          const values = await collectCreditBalances<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalanceDetailed: async (credential) => {
              // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
              // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
              // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
              // 无信息量的「账户信息查询失败」）。
              const result = await fetchCodeArtsAccountInfoDetailed(credential)
              if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
              const info = result.info
              if (!info.isCreditPackage) {
                return {
                  balance: null,
                  error: info.isTokenPackage
                    ? 'Token 计费账户，无积分余额'
                    : '非积分计费账户，无积分余额',
                }
              }
              // 积分账户但没有 credit metric：如实报「无积分数据」，
              // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
              if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
              return { balance: info.credit }
            },
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === QODER.id) {
          // 余额来自 `GET /sash/api/v2/me/usage`（实测只需 Bearer +
          // Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
          // `fetchQoderCreditBalance` 只吃 QoderCredential，故这里不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: QoderCredential
            try {
              credential = JSON.parse(resolved.value) as QoderCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await fetchQoderCreditBalance(credential, QODER)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带上原因，卡片显示原因而非 0（与其它 provider 同约定）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === TRAE.id) {
          const values = await collectCreditBalances(accounts, TRAE, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchTraeCreditBalance(credential as TraeCredential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === CLINE.id) {
          // 余额来自 `GET /api/v1/users/{accountId}/balance`（实测
          // `{data:{userId, balance}, success:true}`）。与 Qoder 分支同因：
          // `fetchClineCreditBalance` 只吃 ClineCredential，故不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          //
          // ⚠️ 账号 id 必须用凭据里的 `account_id`（`usr-…`），**不是** JWT 的
          // `sub`（`user_…`）—— 传后者实测返回 `400 Invalid request format`。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: ClineCredential
            try {
              credential = JSON.parse(resolved.value) as ClineCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const result = await fetchClineCreditBalance(credential, CLINE)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance: result.balance,
              // 查不到时带上**具体原因**（含 HTTP 状态码与错误体摘要），
              // 而不是笼统一句「查询失败」—— 卡片显示原因而非 0
              //（0 是「已用光」的语义，会误导用户）。
              ...result.balance === null
                ? { error: result.error ?? '积分查询失败（凭据失效或响应异常）' }
                : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
      }

      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case 'model.list': {
        const req = payload as RpcModelListRequest
        const llm = llmServiceOf(ctx)
        if (llm === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
        }
        let models: Array<{ id: string; name: string }>
        try {
          models = await llm.listModels(req.provider)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
        }
        // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
        // 下一次 listModels 就会应用新的过滤结果。
        const disabledMap = pool.listDisabledModels(req.provider)
        // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：所有适配器
        // 的 listModels 内部都会实时 `filter(m => !disabledModelsFor(provider).has(m.id))`。
        // 若直接对这个结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
        // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
        // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
        // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
        //
        // 因此设置页的目录必须以**未过滤**的全量为准：
        // - 优先用适配器提供的 `listAllModels()`（不套黑名单，且带**最终展示名**，
        //   含倍率与同名消歧）；
        // - 它不存在时（外部/旧适配器）退化为「listModels 结果 + 黑名单补回裸 id」，
        //   此时关闭项只能显示 id（历史行为）。
        //
        // ⚠️ 展示名必须来自**不套黑名单**的全量目录而非裸 id：用户报障
        // 「关闭的就没有显示倍率，关闭的应该也显示倍率」—— 根因正是补回时只有
        // id 可用。适配器实例由 `registerJetHubRpc` 的 `modelAdapters` 传入
        // （DSH 的 `ctx.llm` 只保证 `listModels`，不透传自定义方法）。
        // 对话框模型选择器读的仍是过滤后的 `listModels`，可见性行为完全不变。
        const catalogSource = modelAdapters?.[req.provider]
        const all = catalogSource?.listAllModels()
        let catalog: Array<{ id: string; name: string }>
        if (all !== undefined) {
          catalog = [...all]
          // 全量目录里若仍有黑名单命中却缺失者，一并补上（保底，正常不会发生）。
          const known = new Set(catalog.map((model) => model.id))
          for (const id of Object.keys(disabledMap)) {
            if (disabledMap[id] === true && !known.has(id)) catalog.push({ id, name: id })
          }
        } else {
          const listedIds = new Set(models.map((model) => model.id))
          const filteredOut = Object.keys(disabledMap)
            .filter((id) => disabledMap[id] === true && !listedIds.has(id))
          catalog = [
            ...models.map((model) => ({ id: model.id, name: model.name })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            ...filteredOut.map((id) => ({ id, name: id })),
          ]
        }
        const value: RpcModelListResponse = {
          models: catalog.map((model) => ({
            id: model.id,
            name: model.name,
            disabled: disabledMap[model.id] === true,
          })),
        }
        return { ok: true, value }
      }

      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
      //
      // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
      // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
      // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
      // 磁盘、界面一直显示旧目录。
      case 'model.setDisabled': {
        const req = payload as RpcModelSetDisabledRequest
        if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } }
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true)
        ctx.logger.info(
          `[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      /**
       * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
       * 「打开全部 / 关闭全部」）。
       *
       * 两个方向的语义**刻意不对称**（需求明确规定）：
       *
       * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
       *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
       *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
       * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
       *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
       *   才能被清掉（按目录删的话它们永远留在配置里）。
       *
       * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
       * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
       * 的黑名单。批量端点只落盘一次、只广播一次。
       */
      case 'model.setAllDisabled': {
        const req = payload as RpcModelSetAllDisabledRequest
        // ⚠️ `disabled` **不做默认值猜测**：缺失或非布尔一律拒绝。默认成 true 会
        // 让一次字段名写错的前端改动静默关闭用户全部模型；默认成 false 则反向
        // 静默打开 —— 两个方向都是灾难性且难察觉的。
        if (typeof req.provider !== 'string' || typeof req.disabled !== 'boolean') {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'provider 与 disabled（布尔）必填' },
          }
        }
        if (req.disabled) {
          // 关闭全部：先取全量目录，再一次性写入黑名单。
          let ids: string[]
          const all = modelAdapters?.[req.provider]?.listAllModels()
          if (all !== undefined) {
            ids = all.map((model) => model.id)
          } else {
            const llm = llmServiceOf(ctx)
            if (llm === undefined) {
              // 目录读不出来就**不落盘**：否则会写入一个不完整的黑名单，
              // 用户看到「关了一半」且无从判断原因。
              return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
            }
            try {
              ids = (await llm.listModels(req.provider)).map((model) => model.id)
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
            }
          }
          await pool.setModelsDisabled(req.provider, ids)
          ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的全部 ${ids.length} 个模型`)
        } else {
          // 打开全部：纯本地操作，不读目录 —— 目录故障时用户仍应能把开关全打开。
          await pool.clearDisabledModels(req.provider)
          ctx.logger.info(`[jet-hub] 打开 ${req.provider} 的全部模型`)
        }
        // 只广播一次：批量不等于逐条广播。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetAllDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      default:
        return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
}

/** 构造带 rpcId 的响应 JSON */
function reply(rpcId: string, result: unknown): Response {
  const value = typeof result === 'object' && result !== null && (result as Record<string, unknown>).ok === false
    ? { ...result as Record<string, unknown>, error: { ...(result as Record<string, unknown>).error as Record<string, unknown>, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
