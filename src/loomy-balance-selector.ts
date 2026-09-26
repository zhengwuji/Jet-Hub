/**
 * Loomy 账号余额缓存 + 按余额优先的选号。
 *
 * ## 它解决什么（真实缺陷）
 *
 * **实测 2026-09-26**：Loomy 今日赠送额度（每天 5000）耗尽后，服务端
 * **继续扣永久积分且不报错** —— 「耗尽」是**静默降级**，不是错误。
 * 而插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
 * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
 *
 * 本模块在**选号之前**查各账号余额并分档，从而把消耗平摊到
 * 「还有今日额度」的号上（见 `loomy-balance-rank.ts` 的策略说明）。
 *
 * ## 缓存（用户选择 60 秒 TTL）
 *
 * 每次选号都实时查所有账号会显著变慢（N 个账号 = N 次网络往返）。
 * 故加 60 秒 TTL：同一轮对话内的多次请求几乎不重复查。
 *
 * ⚠️ 缓存是**按账号 id** 存的，账号被删/新增时不会串味；
 * 但**停用/启用的变化不经缓存**（那由 `AccountPool` 的 `enabled` 过滤实时决定）。
 */

import type { LoomyCredential } from './loomy.js'
import type { LoomyProduct } from './loomy-product.js'
import { fetchLoomyCreditDetail } from './loomy-credits.js'
import {
  loomyBalanceTier,
  loomyTierUsable,
  rankLoomyAccountsByBalance,
  type LoomyAccountBalance,
  type LoomyTierOptions,
} from './loomy-balance-rank.js'

/** 余额缓存 TTL（毫秒）。用户指定 60 秒。 */
export const LOOMY_BALANCE_CACHE_TTL_MS = 60_000

/** 单个账号的余额（含查询失败标记）。 */
export interface LoomyAccountBalanceEntry extends LoomyAccountBalance {
  /** 查询是否成功；false 时两个余额字段均为 undefined。 */
  ok: boolean
  /** 查询失败原因（诊断用）。 */
  error?: string
}

/** 一条待选账号（调用方从账号池取出）。 */
export interface LoomyCandidateAccount {
  id: string
  credentialRef: string
}

/** 选号依赖（便于单测注入）。 */
export interface LoomySelectionDeps {
  product: LoomyProduct
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<LoomyCredential | undefined>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
}

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: LoomyAccountBalanceEntry
}

/**
 * 余额缓存 + 选号器。
 *
 * 生命周期与适配器实例一致（每个 LoomyAdapter 一个），
 * 故不需要全局状态、也不会跨 provider 串味。
 */
export class LoomyBalanceSelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: LoomySelectionDeps) {}

  /** 清空缓存（凭据变化、手动刷新余额后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 查一个账号的余额（带 TTL 缓存）。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档。
   * 让「一个号查不到」不至于让整个选号失败。
   */
  async balanceOf(account: LoomyCandidateAccount): Promise<LoomyAccountBalanceEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const ttl = this.deps.ttlMs ?? LOOMY_BALANCE_CACHE_TTL_MS
    const cached = this.cache.get(account.id)
    if (cached !== undefined && now - cached.at < ttl) return cached.value

    const value = await this.fetchBalance(account)
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /** 真正发请求查一次余额。 */
  private async fetchBalance(account: LoomyCandidateAccount): Promise<LoomyAccountBalanceEntry> {
    let credential: LoomyCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return {
        id: account.id,
        ok: false,
        error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (credential === undefined) {
      return { id: account.id, ok: false, error: '凭据未配置或已失效' }
    }

    const detail = await fetchLoomyCreditDetail(
      credential,
      this.deps.product,
      this.deps.fetcher ?? fetch,
    )
    if (detail === null) {
      return { id: account.id, ok: false, error: '余额查询失败（凭据失效或响应异常）' }
    }
    return {
      id: account.id,
      ok: true,
      dailyBalance: detail.daily,
      permanentBalance: detail.permanent,
    }
  }

  /**
   * 从候选账号中按余额优先选一个。
   *
   * 排序规则见 `rankLoomyAccountsByBalance`：
   * 有今日额度 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**。
   *
   * ⚠️ 返回的是**第一个**候选（而不是随机），因为档内顺序 = 用户手动顺序。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号
   * 落入 `none` 档（不可用）。若**全部候选都不可用**，本方法返回 `undefined`
   * —— 调用方据此报「无可用账号」的明确错误（用户要求），而不是硬着头皮
   * 用永久积分。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   * @returns 选中的账号 + 其余额；**无可用账号**时返回 undefined。
   */
  async select(
    candidates: readonly LoomyCandidateAccount[],
    options: LoomyTierOptions = {},
  ): Promise<{ account: LoomyCandidateAccount; balance: LoomyAccountBalanceEntry } | undefined> {
    if (candidates.length === 0) return undefined

    // 并发查余额：账号数通常个位数，并发比串行快得多。
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)))
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i]! }]))

    const ranked = rankLoomyAccountsByBalance(
      balances.map((b) => ({ ...b, id: b.id })),
      options,
    )
    const first = ranked[0]
    if (first === undefined) return undefined

    // ⚠️ 排序只保证「可用的在前」，**不保证第一个可用**。
    //
    // 仅在**锁定永久积分**时才把「全部不可用」判成无可用账号：解锁时
    // 「所有号的余额都是 0」仍返回第一个候选 —— 那是**既有行为**（让上游
    // 去报余额不足，错误信息更准确），不能因为本次改动而变化。
    if (options.allowPermanent === false && !loomyTierUsable(loomyBalanceTier(first, options))) {
      return undefined
    }

    const picked = byId.get(first.id)
    return picked
  }
}
