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
 *           model.list / model.setDisabled /
 *           backup.export / backup.import / backup.status
 *
 * ⚠️ 各方法的**处理器实现**已按领域拆到 `src/rpc/*.ts`（P1-⑤ 结构重构）：
 * 本文件只保留公共助手、共享类型与「领域分派 + 端点注册」门面。
 */

import { handleAccountMethod } from './rpc/account.js'
import { handleLoginMethod } from './rpc/login.js'
import { handleOnboardingMethod } from './rpc/onboarding.js'
import { handleCreditsMethod } from './rpc/credits.js'
import { handleModelMethod } from './rpc/models.js'
import { handleBackupMethod } from './rpc/backup.js'
import type { JetHubRpcDeps } from './rpc/contracts.js'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { CodeArtsCredential, ProviderAccountEntry, RpcCreditsStatusResponse, RpcCreditsClaimAllResponse, RpcCreditsClaimSummary, RpcCreditsBalancesResponse } from './types.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { QoderAuth } from './qoder-auth.js'
import type { TraeAuth } from './trae-auth.js'
import type { ClineAuth } from './cline-auth.js'
import type { LoomyAuth } from './loomy-auth.js'
import type { RaccoonAuth } from './raccoon-auth.js'
import type { ZcodeAuth } from './zcode-auth.js'
import type { AutoclawAuth } from './autoclaw-auth.js'
import type { AccioAuth } from './accio-auth.js'
import type { CatpawAuth } from './catpaw-auth.js'
import type { KeyedAuth } from './keyed-auth.js'
import type { RaccoonCredential } from './raccoon.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE, TRAE_INTL } from './trae-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { BuddyCredential } from './buddy.js'
import { claimDailyCheckin, fetchCheckinStatus, fetchCreditBalance } from './credits.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js'
import { CODEBUDDY, CODEBUDDY_INTL, WORKBUDDY, WORKBUDDY_CN } from './product.js'
import type { BuddyProduct } from './product.js'

/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
export function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
export function parseBuddyCredential(raw: string): BuddyCredential | undefined {
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
export function parseCodeArtsCredential(raw: string): CodeArtsCredential | undefined {
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
export function parseLobsteraiCredential(raw: string): LobsteraiCredential | undefined {
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
export function parseQoderCredential(raw: string): QoderCredential | undefined {
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
export function parseTraeCredential(raw: string): TraeCredential | undefined {
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
export function parseClineCredential(raw: string): ClineCredential | undefined {
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
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (6665)`。
 *
 * ## 为什么要追加手机号尾号
 *
 * 服务端的 `name` 是**自动生成的默认名**（实测本机账号为 `RaccoonAva`，
 * 即「Raccoon」+ 随机串）。实证：
 *
 * - `GET /user_info` 的 `data.name = "RaccoonAva"`；
 * - JWT payload 里同样带 `name: "RaccoonAva"`（官方客户端就是读这个：
 *   `M = () => { ... userName: t.name, id: t.sid }`）；
 * - `wechat_bindings` 只有 `[{id, bound_at}]` —— **没有微信昵称/头像**。
 *   微信扫码走 `snsapi_login`（只给 openid），要昵称需额外申请
 *   `snsapi_userinfo`，这里显然没申请。
 *
 * 所以「显示 `RaccoonAva`」本身与官方一致、**不是取错字段**；但它是默认名，
 * 注册第二个账号时服务端很可能又给一个相近的名字 → 多账号重名、无法区分。
 *
 * 修法参考 Loomy（`Loomy 2222`）：这边有真实名字可用，故**保留原名再挂尾号**，
 * 兼顾「看得出服务端原名字」与「多账号可区分」。
 *
 * 退化顺序：昵称 + 手机号尾号 → 昵称 + 用户 id → 昵称 → 账号 id。
 * ⚠️ 手机号取**后 4 位**（够区分且不完整暴露号码）。
 */
export function buildRaccoonNickname(
  credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>,
  fallbackId: string,
): string {
  const nickname = typeof credential.nickname === 'string' ? credential.nickname.trim() : ''
  const phone = typeof credential.phone === 'string' ? credential.phone.trim() : ''
  const userId = typeof credential.user_id === 'string' ? credential.user_id.trim() : ''

  // 消歧后缀：优先手机号尾号（更利于用户辨认是哪个号），否则用户 id
  const suffix = phone.length >= 4
    ? phone.slice(-4)
    : userId.length > 0 ? userId : ''

  if (nickname.length > 0) {
    // 已有该后缀时不重复追加（例如服务端名字里本就带手机号尾号）
    return suffix.length > 0 && !nickname.includes(suffix) ? `${nickname} (${suffix})` : nickname
  }
  if (suffix.length > 0) return `Raccoon ${suffix}`
  return fallbackId
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
export function llmServiceOf(ctx: Context): {
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
 * 注册 Jet Hub 管理 RPC 端点（本文件的**门面**）。
 *
 * ⚠️ P1-⑤ 之前这里收 **18 个位置参数**。新增 provider 时测试侧漏改
 * 两处位置实参，导致 2 个用例**静默错位** —— 位置参数让「接错服务」与「接对服务」
 * 在类型上完全等价。现改为单个具名对象：少接 / 接错字段是编译错误。
 *
 * `ctx` 仍单独传：它只用于 `connection` 的**惰性注入**（`ctx.inject`），
 * 与「服务集合」是两类东西（静态 `inject` 会让 headless profile 启动失败）。
 *
 * 各端点方法的**实现**已按领域拆到 `src/rpc/*.ts`，本文件只保留公共助手、
 * 共享类型、以及「前缀分派 + 端点注册」。
 */
export interface JetHubRpcServices {
  /** 账号池（账号索引与选号的唯一入口） */
  pool: AccountPool
  codearts: CodeArtsAuth
  buddy: BuddyAuth
  buddyIntl: BuddyAuth
  workbuddy: BuddyAuth
  workbuddyCn: BuddyAuth
  lobsterai: LobsteraiAuth
  qoder: QoderAuth
  qoderCn: QoderAuth
  trae: TraeAuth
  traeIntl: TraeAuth
  cline: ClineAuth
  loomy: LoomyAuth
  raccoon: RaccoonAuth
  /** ZCode 国内版（智谱 / Z.AI 编码代理客户端；CLI 轮询登录）。 */
  zcode: ZcodeAuth
  /** ZCode 国际版（Z.AI；与国内版同一份实现、不同推理平面）。 */
  zcodeIntl: ZcodeAuth
  /** AutoClaw 国内版（智谱 autoglm；手机验证码登录）。 */
  autoclaw: AutoclawAuth
  /** AutoClaw 国际版（autoglm.ai；Zai/Google 网页 OAuth 登录）。 */
  autoclawIntl: AutoclawAuth
  /** Accio 国际版（阿里 Accio Work；PKCE 网页登录）。 */
  accio: AccioAuth
  /** Accio 国内版（与上面同一份实现、不同登录站点与 package-region）。 */
  accioCn: AccioAuth
  /**
   * CatPaw（美团 AI 客户端）。
   *
   * ⚠️ 这是**唯一的有状态 provider**：上游是自有的 conversation 会话协议
   * （round / event / turn 多步时序 + 工具循环），适配器自己维护会话注册表与
   * 指纹链。登录是 passport 会话 + loopback 回调（`startLogin` 自带回调服务器）。
   */
  catpaw: CatpawAuth
  /**
   * 「粘贴 API Key」族认证服务（`provider id → KeyedAuth`）。
   *
   * ⚠️ 它们**不是**「登录式」provider：没有 `startLogin()`，凭据由用户在
   * 前端弹窗里粘贴，经 `login.submitKey` 校验后写入。`account.create` 对它们
   * 只建占位条目（`loginMode: 'key'`），不发任何网络请求。
   *
   * 用 Map 而非具名字段：本族会继续增加平台（每加一个只需在
   * `src/keyed-product.ts` 的表里添一行），具名字段会让每加一个平台都要改
   * `JetHubRpcServices` 接口 —— 那正是历史上「漏改一处就出空壳面板」的成因。
   */
  keyed: ReadonlyMap<string, KeyedAuth>
  /**
   * 适配器实例映射（`provider → listAllModels()` 来源）。
   *
   * ⚠️ `ctx.llm` **不透传自定义方法**，故必须由 `index.ts` 收集实例后传进来，
   * `model.list` 才能拿到被关闭模型的**真实展示名**（含倍率），而不是裸 id。
   */
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>
}

export function registerJetHubRpc(ctx: Context, services: JetHubRpcServices): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerJetHubEndpoints(connectionCtx as Context, services)
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
export function broadcastCatalogChanged(ctx: Context): void {
  try {
    ctx.emit('llm/adapters-updated')
  } catch (error) {
    ctx.logger.warn(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`)
  }
}

/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(
  ctx: Context,
  services: JetHubRpcServices,
): void {
  /**
   * 按产品 id 取对应的 CodeBuddy 系服务实例。
   *
   * CodeBuddy 与 WorkBuddy 同源但各自持有独立的续期定时器，故必须按
   * `product.id` 分派而不是共用一个实例 —— 否则给 WorkBuddy 账号调度续期
   * 会挂到 CodeBuddy 的定时器上，反之亦然。
   * 用 Map 集中：新增同源产品时只改这一处。
   */
  const buddyServices: ReadonlyMap<string, BuddyAuth> = new Map([
    [CODEBUDDY.id, services.buddy],
    [CODEBUDDY_INTL.id, services.buddyIntl],
    [WORKBUDDY_CN.id, services.workbuddyCn],
    [WORKBUDDY.id, services.workbuddy],
  ])
  const buddyAuthForProduct = (productId: string): BuddyAuth | undefined => buddyServices.get(productId)

  /**
   * Qoder 区域族：国际版 `qoder` / 国内版 `qoder-cn`。
   *
   * 两者共用 `QoderAdapter` 与 `QoderAuth`，但**各持独立的续期定时器与凭据 ref**，
   * 且登录态互不相通（官方是两个独立客户端）。故与 CodeBuddy 系同理，必须按
   * `product.id` 分派，不能共用一个实例。
   */
  const qoderServices: ReadonlyMap<string, QoderAuth> = new Map([
    [QODER.id, services.qoder],
    [QODER_CN.id, services.qoderCn],
  ])
  const qoderAuthForProduct = (productId: string): QoderAuth | undefined => qoderServices.get(productId)

  /** TRAE 区域族：国内版 `trae` / 国际版 `trae-intl`。分派理由同 Qoder。 */
  const traeServices: ReadonlyMap<string, TraeAuth> = new Map([
    [TRAE.id, services.trae],
    [TRAE_INTL.id, services.traeIntl],
  ])
  const traeAuthForProduct = (productId: string): TraeAuth | undefined => traeServices.get(productId)

  /** 该 provider 是否属于 Qoder 区域族。 */
  const isQoderProvider = (provider: string): boolean => qoderServices.has(provider)
  /** 该 provider 是否属于 TRAE 区域族。 */
  const isTraeProvider = (provider: string): boolean => traeServices.has(provider)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  /**
   * Loomy 短信登录的中间状态（账号 id → { phone, msgid }）。
   *
   * 为什么放内存而不是凭据存储：msgid 是**一次性的中间态**（5 分钟有效），
   * 登录完成后即无意义；写进 `ctx.credentials` 会污染凭据命名空间，
   * 且它不含任何秘密（不能用于认证）。
   */
  const pendingSmsMsgid = new Map<string, { phone: string; msgid: string }>()

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

  /**
   * 领域处理器共用的依赖装配：**一份**对象喂给全部领域模块。
   *
   * 各领域模块用 `Pick<...>` 声明自己用得到的那几项，故此处多喂无妨；集中装配
   * 还让「门面里的公共助手签名变了」立刻变成编译错误（见 `src/rpc/contracts.ts`）。
   */
  const registry: JetHubRpcDeps = {
    ctx,
    pool: services.pool,
    codearts: services.codearts,
    buddy: services.buddy,
    buddyIntl: services.buddyIntl,
    workbuddy: services.workbuddy,
    workbuddyCn: services.workbuddyCn,
    lobsterai: services.lobsterai,
    qoder: services.qoder,
    qoderCn: services.qoderCn,
    trae: services.trae,
    traeIntl: services.traeIntl,
    cline: services.cline,
    loomy: services.loomy,
    raccoon: services.raccoon,
    zcode: services.zcode,
    zcodeIntl: services.zcodeIntl,
    autoclaw: services.autoclaw,
    autoclawIntl: services.autoclawIntl,
    accio: services.accio,
    accioCn: services.accioCn,
    catpaw: services.catpaw,
    keyed: services.keyed,
    modelAdapters: services.modelAdapters,
    buddyAuthForProduct,
    qoderAuthForProduct,
    traeAuthForProduct,
    isQoderProvider,
    isTraeProvider,
    pendingSmsMsgid,
    shortId,
    parseBuddyCredential,
    parseCodeArtsCredential,
    parseLobsteraiCredential,
    parseQoderCredential,
    parseTraeCredential,
    parseClineCredential,
    buildRaccoonNickname,
    computeClaimSummary,
    collectCreditsStatus,
    collectClaimResults,
    collectCreditBalances,
    llmServiceOf,
    broadcastCatalogChanged,
  }

  /**
   * 分发端点方法到对应的领域处理器。
   *
   * 按 method 的第一段（第一个 `.` 之前）路由，领域模块内仍用**完整 method**
   * 精确匹配 —— 与拆分前那个大 `switch` 语义一致，包括未知方法的 `bad-request`
   * 文案（`unknown method: …` 在两层各出现一次，措辞完全相同）。
   */
  async function handleMethod(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const domain = method.includes('.') ? method.slice(0, method.indexOf('.')) : method
    switch (domain) {
      case 'account':
        return handleAccountMethod(method, payload, registry, signal)
      case 'login':
        return handleLoginMethod(method, payload, registry, signal)
      case 'onboarding':
      case 'loomy':
        return handleOnboardingMethod(method, payload, registry, signal)
      case 'credits':
        return handleCreditsMethod(method, payload, registry, signal)
      case 'model':
        return handleModelMethod(method, payload, registry, signal)
      case 'backup':
        return handleBackupMethod(method, payload, registry, signal)
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
