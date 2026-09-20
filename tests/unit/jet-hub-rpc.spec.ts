import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  registerJetHubRpc,
} from '../../src/jet-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import type { ClaimOutcome, CheckinStatus, CreditBalance } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

describe('积分领取结果汇总', () => {
  it('统计成功数量与累计积分', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 50, streakDays: 2, isStreakDay: true },
      { kind: 'already-claimed', message: '今天已签到' },
      { kind: 'failed', code: 500, message: 'boom' },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 2, totalCredit: 150, alreadyClaimed: 1, inactive: 0, failed: 1,
    })
  })

  it('全部已领取时 claimed 为 0', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ claimed: 0, totalCredit: 0, alreadyClaimed: 2 })
  })

  it('混合 inactive 与 failed 分别计数', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'inactive', message: '活动未开启' },
      { kind: 'failed', code: 1, message: 'x' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ inactive: 1, failed: 1, claimed: 0 })
  })

  it('空数组返回全 0', () => {
    expect(computeClaimSummary([])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })

  it('未知 kind 兜底计入 failed，而不是被静默漏计', () => {
    // 模拟 ClaimOutcome 未来新增 kind、但汇总分支未同步更新的情况。
    const unknown = { kind: 'brand-new-kind', message: 'x' } as unknown as ClaimOutcome
    expect(computeClaimSummary([unknown, { kind: 'inactive', message: 'i' }]))
      .toMatchObject({ failed: 1, inactive: 1, claimed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────
// 逐账号异常隔离（Task 8 补充修复）
//
// 直接调用 RPC 端点需要构造 ctx.connection.fetch.register 替身，
// 因此端点已把「逐账号处理」抽成 collectCreditsStatus / collectClaimResults
// 两个可导出函数（方案 A）。这里对它们单测：既能精确断言单账号隔离，
// 又能验证顺序性，且完全不发起网络请求（fetchStatus / claim 均注入桩）。
// ─────────────────────────────────────────────────────────────

/** 构造账号条目；默认是启用的合法账号。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 最小合法凭据 JSON。 */
const VALID_CREDENTIAL_JSON = JSON.stringify({
  access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
})

/** 构造签到状态。 */
function makeStatus(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100,
    todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
    activityName: 'a', themeName: 't', endTime: '', ...overrides,
  }
}

/**
 * 构造依赖替身。
 * 默认：所有 ref 都能解析出合法凭据，状态接口返回「可领取」，领取返回成功。
 */
function makeDeps(overrides: Partial<CreditsEndpointDeps> = {}): CreditsEndpointDeps {
  return {
    resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
    fetchStatus: async () => makeStatus(),
    claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    ...overrides,
  }
}

describe('credits.status 单账号异常隔离', () => {
  it('非法 credentialRef 只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const asked: string[] = []
    const deps = makeDeps({
      resolve: async (ref) => {
        asked.push(String(ref))
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    // 三个账号都要出现在结果里（不是整批抛异常）
    expect(results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(results[0]?.status).toBeNull()
    // 关键：坏账号之后的两个账号确实被继续处理
    expect(results[1]?.status).not.toBeNull()
    expect(results[2]?.status).not.toBeNull()
    // 坏账号根本没走到 resolve（名称校验先抛）
    expect(asked).toEqual(['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_AAAA1111'])
  })

  it('resolve 抛错只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => {
        resolveCalls++
        // 第一个账号的 resolve 抛错（如凭据已被外部删除）；后续账号正常。
        if (resolveCalls === 1) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['boom', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toEqual(makeStatus())
    expect(resolveCalls).toBe(2)
  })

  it('JSON 损坏与网络失败都只影响该账号', async () => {
    const accounts = [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'network-down' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => ({ value: resolveCalls++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      // 第二个账号（network-down）的状态请求抛网络错误
      fetchStatus: async () => {
        if (resolveCalls === 2) throw new Error('socket hang up')
        return makeStatus()
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['corrupt', 'network-down', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toBeNull()
    expect(results[2]?.status).toEqual(makeStatus())
  })

  it('停用账号同样处理（停用与签到无关），异常出口收到告警', async () => {
    const warnings: string[] = []
    const accounts = [
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'bad-ref', credentialRef: '非法名称' }),
    ]
    const results = await collectCreditsStatus(accounts, WORKBUDDY, makeDeps({
      warn: (msg) => warnings.push(msg),
    }))

    // 停用只影响账号池的自动选择与限流切换，不改变「该账号今天领了没」，
    // 故两个账号都要出现在结果里。
    expect(results.map(r => r.accountId)).toEqual(['off', 'bad-ref'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad-ref')
  })

  it('凭据解析为 undefined 时状态为 null，且不调用状态接口', async () => {
    let statusCalls = 0
    const results = await collectCreditsStatus([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { statusCalls++; return makeStatus() },
    }))

    expect(results[0]?.status).toBeNull()
    expect(statusCalls).toBe(0)
  })
})

describe('credits.claimAll 单账号异常隔离与顺序性', () => {
  it('停用账号也被领取（一键领取覆盖全部账号）', async () => {
    const accounts = [
      makeEntry({ id: 'enabled-1', enabled: true }),
      makeEntry({ id: 'disabled-1', enabled: false }),
      makeEntry({ id: 'disabled-2', enabled: false }),
    ]
    const deps = makeDeps({
      claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 停用只影响账号池的自动选择与限流切换；积分照领。
    expect(response.results.map(r => r.accountId)).toEqual(['enabled-1', 'disabled-1', 'disabled-2'])
    expect(response.results.every(r => r.outcome.kind === 'claimed')).toBe(true)
    expect(response.summary).toEqual({
      claimed: 3, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })

  it('非法 credentialRef 的账号记为 failed，其余账号仍被领取', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const claimed: string[] = []
    const deps = makeDeps({
      claim: async () => {
        claimed.push(`claim-${claimed.length}`)
        return { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 整批成功返回，三个账号都有结果
    expect(response.results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', code: -1 })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.results[2]?.outcome).toMatchObject({ kind: 'claimed' })
    // 坏账号没有阻止后两个账号真正发起领取
    expect(claimed).toHaveLength(2)
    expect(response.summary).toEqual({
      claimed: 2, totalCredit: 200, alreadyClaimed: 0, inactive: 0, failed: 1,
    })
  })

  it('resolve 抛错被收敛为该账号的 failed，不冒泡中断整批', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let first = true
    const deps = makeDeps({
      resolve: async () => {
        if (first) { first = false; throw new Error('凭据已被外部删除') }
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', message: '凭据已被外部删除' })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.summary.failed).toBe(1)
    expect(response.summary.claimed).toBe(1)
  })

  it('凭据未配置记为 failed 且不发起任何请求', async () => {
    let touched = 0
    const response = await collectClaimResults([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { touched++; return makeStatus() },
      claim: async () => { touched++; return { kind: 'failed', code: -1, message: 'x' } },
    }))

    expect(response.results[0]?.outcome).toEqual({ kind: 'failed', code: -1, message: '凭据未配置' })
    expect(touched).toBe(0)
  })

  it('保持「先查状态再领取」：活动未开启/今日已签到时跳过领取请求', async () => {
    const accounts = [makeEntry({ id: 'inactive' }), makeEntry({ id: 'done' }), makeEntry({ id: 'ready' })]
    let call = 0
    const claimCalls: string[] = []
    const deps = makeDeps({
      fetchStatus: async () => {
        call++
        if (call === 1) return makeStatus({ active: false })
        if (call === 2) return makeStatus({ todayCheckedIn: true })
        return makeStatus()
      },
      claim: async () => {
        claimCalls.push('claim')
        return { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results.map(r => r.outcome.kind))
      .toEqual(['inactive', 'already-claimed', 'claimed'])
    // 只有第三个账号真正调用了领取接口
    expect(claimCalls).toHaveLength(1)
  })

  it('顺序执行：任一时刻只有一个账号在处理（不并发）', async () => {
    const accounts = [
      makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' }),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      resolve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return makeStatus()
      },
      claim: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false }
      },
    })

    await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(maxInFlight).toBe(1)
  })

  it('按账号顺序串行，且结果顺序与账号顺序一致', async () => {
    const accounts = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]
    const order: string[] = []
    let seq = 0
    const deps = makeDeps({
      // 让先启动的账号耗时更长，若并发则 c 会先完成
      resolve: async () => {
        const mine = seq++
        await new Promise(r => setTimeout(r, mine === 0 ? 10 : 1))
        order.push(`entry-${mine}`)
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(order).toEqual(['entry-0', 'entry-1', 'entry-2'])
    expect(response.results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：4 个 CodeBuddy 账号一键领取全部失败，
   * 错误是 **`fetcher is not a function`**。
   *
   * 根因：`claimDailyCheckin` / `fetchCheckinStatus` 的真实签名是
   * `(credential, product, fetcher)`，而 `collectClaimResults` 在**未注入
   * deps 时**调用的是 `claim(credential, product, entry)` —— 把 `entry`
   * 塞进了 `fetcher` 的位置，于是 `fetcher(...)` 抛
   * `TypeError: fetcher is not a function`。
   *
   * 为什么长期没被发现：`makeDeps` **总是注入 `claim` / `fetchStatus`**，
   * 于是真实的默认实现路径**从未被任何用例覆盖**；而
   * `deps.claim ?? (claimDailyCheckin as unknown as …)` 这个
   * `as unknown as` 强转**掩盖了签名不匹配**，TypeScript 也帮不上忙。
   *
   * 本用例刻意**不注入 claim / fetchStatus**，走真实默认实现，用注入的
   * fetcher 断言「被当成函数调用的那个参数确实是 fetcher」。
   */
  it('未注入 deps 时走真实默认实现，第三参必须是 fetcher（真实缺陷回归）', async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      // 状态端点返回「活动开启且今天没领」，让流程走到 claim。
      // ⚠️ 字段名必须是真实的 `active` / `today_checked_in`（见 fetchCheckinStatus），
      // 用错名字会被 readBool 读成 false → 落到 inactive 短路。
      if (String(url).includes('checkin-activity-status')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { active: true, today_checked_in: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { credit: 100, streak_days: 1, is_streak_day: false },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const accounts = [makeEntry({ id: 'cb-1', credentialRef: 'BUDDY_ACCOUNT_A70DB211' })]
    // ⚠️ 关键：**不传** claim / fetchStatus，走真实的 claimDailyCheckin，
    // 只注入 fetcher。
    const response = await collectClaimResults(accounts, WORKBUDDY, {
      resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
      fetcher: fakeFetch,
    })

    // 不得是 `fetcher is not a function`
    const outcome = response.results[0]?.outcome
    if (outcome?.kind === 'failed') {
      expect(outcome.message).not.toContain('fetcher is not a function')
    }
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    // 确认确实发出了两次真实请求（状态 + 领取）
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('checkin-activity-status')
    expect(calls[1]).toContain('daily-checkin')
  })
})

/**
 * collectCreditBalances：逐账号收集积分余额。
 *
 * 与状态/领取的关键差异是**保留失败原因**——账号卡片要显示"为什么没查到"，
 * 把它降级成 null 会让 UI 显示成空白，用户无从判断是余额为 0 还是查询失败。
 */
describe('credits.balances 逐账号余额收集', () => {
  const BALANCE: CreditBalance = {
    total: 347.87,
    packages: [
      { name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, cycleStartTime: '', cycleEndTime: '2026-09-28 10:05:56' },
      { name: 'Free Plan Subscription', unit: 'credits', remaining: 100, total: 100, used: 0, cycleStartTime: '', cycleEndTime: '2026-09-30 23:59:59' },
    ],
  }

  it('成功时回传余额与包明细', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances([makeEntry({ id: 'a' })], WORKBUDDY, deps)

    expect(results).toEqual([{ accountId: 'a', nickname: '测试号', balance: BALANCE }])
  })

  it('余额为 0 与查询失败严格区分', async () => {
    const empty: CreditBalance = { total: 0, packages: [] }
    let call = 0
    const deps = makeDeps({ fetchBalance: async () => (call++ === 0 ? empty : null) })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'zero' }), makeEntry({ id: 'failed' })], WORKBUDDY, deps,
    )

    // 第一个真余额 0：可展示为 0，不算错误
    expect(results[0]!.balance).toEqual(empty)
    expect(results[0]!.error).toBeUndefined()
    // 第二个查不到：balance 为 null 且带原因，UI 不能显示成 0
    expect(results[1]!.balance).toBeNull()
    expect(results[1]!.error).toBe('余额查询失败')
  })

  it('凭据未配置时给出原因，且不发起余额请求', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances([makeEntry({ id: 'noconf' })], WORKBUDDY, deps)

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBe('凭据未配置')
    expect(touched).toBe(0)
  })

  it('单个账号异常不中断整批，且记录该账号的原因', async () => {
    let call = 0
    const warnings: string[] = []
    const deps = makeDeps({
      resolve: async () => {
        if (call++ === 0) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchBalance: async () => BALANCE,
      warn: (msg) => warnings.push(msg),
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe('凭据已被外部删除')
    expect(results[0]!.balance).toBeNull()
    expect(results[1]!.balance).toEqual(BALANCE)
    expect(warnings).toHaveLength(1)
  })

  it('凭据 JSON 损坏只影响该账号', async () => {
    let call = 0
    const deps = makeDeps({
      resolve: async () => ({ value: call++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      fetchBalance: async () => BALANCE,
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBeDefined()
    expect(results[1]!.balance).toEqual(BALANCE)
  })

  it('停用账号同样查询（停用与余额无关）', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'off', enabled: false })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toEqual(BALANCE)
  })

  it('顺序执行，不并发（避免风控）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      fetchBalance: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return BALANCE
      },
    })
    await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(maxInFlight).toBe(1)
  })

  it('结果顺序与账号顺序一致', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * model.list / model.setDisabled 端点。
 *
 * 这两个端点是 Jet Hub「显示列表」按钮的唯一数据通道，同时串起三件必须
 * 一起正确的事：
 * 1. 列表来自 `ctx.llm.listModels()`（对话框模型选择器读的同一份目录）；
 * 2. 黑名单经 AccountPool 持久化；
 * 3. 关闭后的模型从对话框选择器里消失，**但在设置页仍可被重新打开**。
 *
 * 因此这里用「注册端点 → 通过 HTTP 请求调用 → 断言响应」的方式做端到端
 * 验证，而不是分别测两个函数——两者的衔接正是最容易出错的地方。
 *
 * ⚠️ 第 3 条的两个方向必须都覆盖，且**桩必须模拟真实适配器的过滤行为**：
 * 真实 `listModels` 会实时剔除黑名单命中的模型，所以 `model.list` 绝不能在
 * 一个已被过滤的目录上「回填 disabled」——那样被关闭的模型会连同开关一起
 * 消失，用户再也无法重新打开（历史 bug）。早期版本的桩是
 * `options.models.map(...)`（从不过滤），恰好绕过这个矛盾，导致该 bug 在
 * 「注释声称已验证第 3 条」的情况下依然漏到了线上。
 */
describe('account.create 必须立即返回 loginUrl（两步式登录回归）', () => {
  /**
   * 真实缺陷（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
   * 跳转过去了」。
   *
   * 根因是**时序**，不是弹窗 API 用法：
   * - 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
   *   `window.open`；
   * - 早期 `account.create` 对 codearts / lobsterai 走**阻塞式** `login()`
   *   （`await` 到用户在浏览器里完成授权，数十秒），返回时手势早已过期；
   * - 前端 `window.open` 被弹窗拦截器拒绝并返回 `null`，于是命中兜底
   *   `window.location.href = loginUrl`，把整个设置页导航到外部登录页。
   *
   * 修法：这两个 provider 也改为「先返回 loginUrl、后台再等回调」的两步式
   * （与 CodeBuddy 系一致）。因此本用例守的是**契约**：`account.create`
   * 必须在用户完成授权**之前**就 resolve —— 若哪天有人改回阻塞式，
   * 这里会以超时失败，而不是等到用户再次报障。
   *
   * 用假计时器不适用（涉及真实 Promise 链），故用「授权永不完成」来模拟
   * 用户尚未操作：旧实现会一直挂着，新实现立即返回。
   */
  type Handler = (request: Request) => Promise<Response>

  /** 构造端点，注入一个「授权永不完成」的登录服务替身。 */
  function registerCreateEndpoints(overrides: {
    /** startLogin 是否可用；false 模拟旧实现的阻塞式 login。 */
    twoPhase: boolean
  }) {
    let handler: Handler | undefined
    /** 记录 startLogin / login 的调用，用于断言走了哪条路径。 */
    const calls: string[] = []
    let resolveLogin!: () => void
    const neverFinishes = new Promise<void>((resolve) => { resolveLogin = resolve })

    // 登录服务替身：startLogin 立即返回 URL，result 永不落定（模拟用户未操作）。
    const makeAuth = (id: string) => ({
      async startLogin() {
        calls.push(`${id}:startLogin`)
        return {
          loginUrl: `https://example.test/${id}/login`,
          result: neverFinishes.then(() => ({
            access: '{}', expires: 0, ref: id, loginUrl: '', refreshable: false,
          })),
          close: async () => {},
        }
      },
      async login() {
        calls.push(`${id}:login`)
        // 阻塞式：永不 resolve，复刻旧实现的等待语义。
        return await neverFinishes
      },
    })

    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }

    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }

    registerJetHubRpc(
      ctx as never, pool as never,
      makeAuth('codearts') as never,
      {} as never, {} as never,
      makeAuth('lobsterai') as never,
      makeAuth('qoder') as never,
      makeAuth('trae') as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown } }
      return body.result
    }
    return { call, calls, resolveLogin }
  }

  /**
   * 给 `account.create` 一个**远早于**用户授权完成的超时预算。
   *
   * 旧实现下它必然超时（因为 await 的是永不落定的登录）；新实现下它应当
   * 在毫秒级返回。这个差异正是本用例的判定依据。
   */
  const FAST_BUDGET_MS = 2000

  it.each(['codearts', 'lobsterai', 'qoder', 'trae'])(
    '%s 在用户完成授权之前就返回 loginUrl（不阻塞）',
    async (provider) => {
      const { call, calls } = registerCreateEndpoints({ twoPhase: true })

      const result = await Promise.race([
        call('account.create', { provider }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), FAST_BUDGET_MS)),
      ])

      expect(
        result,
        `${provider} 的 account.create 阻塞了：说明它退回了「等用户授权完成才返回」`
        + '的旧实现，前端 window.open 会因手势过期被拦截，进而跳转主页面。',
      ).not.toBe('timeout')
      expect((result as { ok: boolean }).ok).toBe(true)
      const value = (result as { value: { loginUrl: string; accountId: string } }).value
      expect(value.loginUrl).toContain(provider)
      expect(value.accountId).toContain(provider)
      // 必须走两步式的 startLogin，而不是阻塞式 login。
      expect(calls).toContain(`${provider}:startLogin`)
      expect(calls).not.toContain(`${provider}:login`)
    },
  )

  it('未登录成功的账号先以占位条目登记，使前端 login.poll 能立即看到', async () => {
    // 两步式下 account.create 返回时凭据还不存在；若不登记占位条目，
    // 前端的 login.poll 会查不到该账号而永远返回 done:false。
    let added: Record<string, unknown> | undefined
    const pool = {
      addAccount: async (entry: Record<string, unknown>) => { added = entry },
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const auth = {
      async startLogin() {
        return {
          loginUrl: 'https://example.test/codearts/login',
          result: new Promise(() => {}),
          close: async () => {},
        }
      },
    }
    registerJetHubRpc(ctx as never, pool as never, auth as never, {} as never, {} as never, {} as never, {} as never)
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'codearts' } },
      }),
    }))
    await response.json()
    expect(added, 'account.create 未登记占位账号条目').toBeDefined()
    expect(added?.provider).toBe('codearts')
    expect(added?.enabled).toBe(true)
    expect(added?.refreshable).toBe(false)
  })

  /**
   * `startLogin` 启动失败（最典型：回调端口被占用）必须变成**规范的 RPC 错误响应**。
   *
   * 真实缺陷：`startTraeLoginFlow` 早期直接 `server.listen(port)` 且未注册
   * `'error'` 处理器 —— listen 失败是**事件**异步抛出的，不属于 Promise 链，
   * 于是逃过 RPC 的 try/catch 成为**进程级 unhandled error**，把整个 DSH 宿主
   * 崩掉。用户看到的不是可读文案，而是一整堆 `EADDRINUSE` 堆栈 + 进程退出。
   *
   * 现在 `startTraeLoginFlow` 会把 listen 失败转成可捕获的 reject；本用例守
   * 「RPC 层照常返回 `ok:false` + 可读 message」这一契约。
   */
  it('startLogin 因端口占用失败时返回可读的 RPC 错误（而非崩进程）', async () => {
    let handler: Handler | undefined
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    }
    const pool = {
      addAccount: async () => {},
      updateAccount: async () => {},
      removeAccount: async () => {},
      listAccounts: async () => [],
    }
    // 复刻「listen 失败」的服务替身：startLogin 直接抛可读错误。
    const failingAuth = {
      async startLogin() {
        throw new Error('TRAE 回调端口 18080 无法监听（EADDRINUSE）；端口可能已被其它程序占用，请释放后重试。')
      },
    }
    registerJetHubRpc(
      ctx as never, pool as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      failingAuth as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const response = await handler(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
        payload: { method: 'account.create', payload: { provider: 'trae' } },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; error?: { code: string; message: string } }
    }

    // 必须是规范的错误响应（而不是裸 500 / 进程崩溃）。
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.message).toContain('18080')
    expect(body.result.error?.message).toMatch(/端口|占用/)
  })

  /**
   * 前端源码级守卫：`createAccount` 不得再劫持当前页面。
   *
   * 组件无法在单测里渲染（react 不在本仓库依赖内），故与
   * `credits-capabilities.spec.ts` 同款——用源码断言锁死那条破坏性兜底
   * 不再出现。`window.location.href = loginUrl` 会把用户正在使用的设置页
   * 整个导航到外部登录页，且登录完成后回不来；正确做法是保留可点击链接。
   */
  it('createAccount 不再用 window.location.href 跳转主页面', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const start = source.indexOf('const createAccount = async () => {')
    expect(start).toBeGreaterThan(-1)
    // 取到下一个顶层函数定义为止，避免把文件其余部分一起扫进来。
    const rest = source.slice(start)
    const end = rest.indexOf('\n  const toggleAccount')
    const body = end > -1 ? rest.slice(0, end) : rest.slice(0, 3000)

    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF。
    // 再剔除注释行：本文件里保留了叙述该缺陷的注释（含 `window.location.href = …`
    // 字样），直接扫全文会把注释本身当成违规。与 credits-capabilities.spec.ts 同款。
    const normalized = body.replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(
      normalized,
      'createAccount 里又出现了 window.location.href 跳转：弹窗被拦截时'
      + '必须展示可点击链接，而不是把整个设置页导航走。',
    ).not.toMatch(/window\.location\.(href|assign|replace)\s*=/)
    // 必须仍然尝试弹出新窗口（两步式的前提）。
    expect(normalized).toContain('window.open(loginUrl')
    // 弹窗失败时要有手动链接兜底。
    expect(normalized).toContain('setLoginUrlForManual(loginUrl)')
  })
})

describe('model.list / model.setDisabled 端点', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 构造带 RPC 端点所需的 ctx 替身，返回注册进去的 fetch 处理器。 */
  function registerEndpoints(options: {
    models: Array<{ id: string; name: string }>
    disabledModels?: Record<string, Record<string, boolean>>
    /** listModels 抛错时用于验证错误路径。 */
    listModelsError?: string
    /** 省略 llm 服务（验证降级行为）。 */
    withoutLlm?: boolean
    /**
     * 是否让桩复刻真实适配器的黑名单过滤（默认 true）。
     *
     * 真实 `CodeArtsAdapter.listModels` / `BuddyAdapter.listModels` 都会实时
     * 剔除 `disabledModelsFor(provider)` 命中的模型，因此桩默认也必须过滤，
     * 否则「端点在一个已过滤目录上回填 disabled」这类缺陷会被静默绕过。
     * 仅当需要验证「适配器未过滤」这一非真实场景时才置为 false。
     */
    adapterFiltersDisabledModels?: boolean
    /**
     * 复刻适配器实例映射（`listAllModels` 返回**不套黑名单**的全量目录）。
     *
     * 真实链路里 `index.ts` 会把五个适配器实例传给 `registerJetHubRpc`；
     * `model.list` 据此拿到被关闭模型的**真实展示名**（含倍率），而不是裸 id。
     * 省略时退化为「listModels + 裸 id 补回」的历史行为。
     */
    modelAdapters?: Record<string, { listAllModels(): readonly { id: string; name: string }[] }>
  }) {
    // settings 替身：内存里保存 namespace 的值，语义与真实服务一致的
    // 「整体 replace」。
    let stored: Record<string, unknown> = {
      accounts: [],
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    let handler: Handler | undefined

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { fetch: Handler }) => { handler = config.fetch },
            },
          }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              // 复刻真实适配器：黑名单命中的模型不会出现在 listModels 结果里。
              // 读的是 settings 替身的当前值（而非构造时的快照），这样
              // model.setDisabled 之后的下一次 listModels 会立刻反映过滤结果，
              // 与真实「每次调用都实时读账号池」的语义一致。
              const disabled = options.adapterFiltersDisabledModels !== false
                ? ((stored.disabledModels as Record<string, Record<string, boolean>> | undefined)?.[provider] ?? {})
                : {}
              return options.models
                .filter(m => disabled[m.id] !== true)
                .map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      // `connection` 由生产代码用**惰性注入**（`ctx.inject`）挂载，而非插件级
      // 静态 `inject`：它只存在于 Web bundle，静态声明会让 headless/CLI profile
      // 永久 pending 而启动失败。替身必须复刻这一机制，否则 registerJetHubRpc
      // 会以 `ctx.inject is not a function` 直接抛错。
      //
      // 语义对齐真实 cordis：回调以**同一 ctx** 立即调用（本替身里 connection
      // 始终可用），使端点注册行为与 Web profile 下完全一致。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
    }

    registerJetHubRpc(
      ctx as never, pool, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      options.modelAdapters as never,
    )
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    /** 调用一个端点方法，返回解包后的 result。 */
    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored }
  }

  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  it('model.list 回传 llm 的模型目录，并把黑名单回填为 disabled', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(true)
    // 未提供 modelAdapters 时退化为历史行为：hy3 已被适配器过滤掉（桩复刻了
    // 真实过滤），由端点补回列表；补回的条目拿不到原始 name，回退为 id。
    expect(result.value).toEqual({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', disabled: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', disabled: false },
        { id: 'hy3', name: 'hy3', disabled: true },
      ],
    })
  })

  /**
   * 回归：**被关闭的模型也要显示倍率**（用户报障）。
   *
   * 真实缺陷：适配器的 `listModels` 会按黑名单过滤，于是被关闭的模型不在其中，
   * 端点只能凭黑名单的 key（裸 id）补回 —— 展示名与倍率随之丢失。用户看到
   * 「打开的显示倍率、关闭的没有倍率」。
   *
   * 修法：`index.ts` 把适配器实例传给 `registerJetHubRpc`，端点用其
   * `listAllModels()`（不套黑名单、带最终展示名）作为目录来源。
   */
  it('关闭的模型仍显示带倍率的展示名（不再退化成裸 id）', async () => {
    const catalog = [
      { id: 'glm-5.2', name: 'GLM-5.2 · x0.78' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · x0.13' },
      { id: 'kimi-k3', name: 'Kimi-K3 · x1.83' },
    ]
    const { call } = registerEndpoints({
      models: catalog,
      disabledModels: { trae: { 'deepseek-v4.1-flash': true } },
      modelAdapters: { trae: { listAllModels: () => catalog } },
    })

    const result = await call('model.list', { provider: 'trae' })
    expect(result.ok).toBe(true)
    const models = (result.value as { models: Array<{ id: string; name: string; disabled: boolean }> }).models
    const closed = models.find((m) => m.id === 'deepseek-v4.1-flash')
    expect(closed?.disabled, '该项应为已关闭').toBe(true)
    // 关键断言：关闭项必须仍是**带倍率的展示名**，而不是裸 id。
    expect(closed?.name).toBe('DeepSeek-V4.1-Flash · x0.13')
    // 打开项不受影响。
    expect(models.find((m) => m.id === 'glm-5.2')?.name).toBe('GLM-5.2 · x0.78')
    // 全部模型都应在列表里（含被关闭的）。
    expect(models.map((m) => m.id)).toEqual(['glm-5.2', 'deepseek-v4.1-flash', 'kimi-k3'])
  })

  /**
   * 回归测试：关闭 → 列表 → 重新打开的完整往返。
   *
   * 历史 bug：`model.list` 直接在 `llm.listModels()`（已被适配器过滤）的结果上
   * 回填 disabled，被关闭的模型不在数组里，它的开关因此从设置页彻底消失，
   * 用户无法重新打开。此用例锁死「关掉的模型必须仍在 model.list 里且可被 reopen」。
   */
  it('关闭模型后它仍出现在 model.list 中（可被重新打开），但不在对话框目录里', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    // 初始：全部可见、全部打开
    const before = await call('model.list', { provider: 'buddy' })
    expect((before.value as { models: Array<{ id: string }> }).models.map(m => m.id))
      .toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])

    // 关闭 hy3
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })

    // 关键断言：hy3 仍出现在设置页列表里，且标记为已关闭 —— 否则无法重新打开
    const after = await call('model.list', { provider: 'buddy' })
    const models = (after.value as { models: Array<{ id: string; disabled: boolean }> }).models
    const hy3 = models.find(m => m.id === 'hy3')
    expect(hy3).toBeDefined()
    expect(hy3!.disabled).toBe(true)
    // 其余模型不受影响
    expect(models.filter(m => m.disabled).map(m => m.id)).toEqual(['hy3'])

    // 重新打开：hy3 恢复正常显示
    await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })
    const reopened = await call('model.list', { provider: 'buddy' })
    const reopenedModels = (reopened.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(reopenedModels.map(m => m.id)).toEqual(['glm-5.2', 'deepseek-v4-flash', 'hy3'])
    expect(reopenedModels.every(m => !m.disabled)).toBe(true)
  })

  /**
   * 关闭多个模型（含连续操作）后，全部都能在设置页找到。
   *
   * 覆盖用户实际场景：连续关掉多个模型后想找回其中一个。
   */
  it('连续关闭多个模型后，每个都仍可在 model.list 中找到并重新打开', async () => {
    const { call } = registerEndpoints({ models: MODELS })

    for (const id of ['glm-5.2', 'hy3']) {
      await call('model.setDisabled', { provider: 'buddy', modelId: id, disabled: true })
    }

    const listed = await call('model.list', { provider: 'buddy' })
    const models = (listed.value as { models: Array<{ id: string; disabled: boolean }> }).models
    expect(models.map(m => m.id).sort()).toEqual(['deepseek-v4-flash', 'glm-5.2', 'hy3'])
    expect(models.filter(m => m.disabled).map(m => m.id).sort()).toEqual(['glm-5.2', 'hy3'])
  })

  it('未配置黑名单时全部模型默认打开（黑名单制）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.list', { provider: 'workbuddy' })
    const models = (result.value as { models: Array<{ disabled: boolean }> }).models

    expect(models.every(m => m.disabled === false)).toBe(true)
  })

  it('黑名单按 provider 隔离', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const buddy = await call('model.list', { provider: 'buddy' })
    const workbuddy = await call('model.list', { provider: 'workbuddy' })

    const flagOf = (result: unknown, id: string) =>
      (result as { models: Array<{ id: string; disabled: boolean }> }).models.find(m => m.id === id)!.disabled

    expect(flagOf(buddy.value, 'hy3')).toBe(true)
    // 另一个 provider 的同名模型不受影响
    expect(flagOf(workbuddy.value, 'hy3')).toBe(false)
  })

  it('model.setDisabled 持久化到 settings，并在后续 model.list 中生效', async () => {
    const { call, storedValue } = registerEndpoints({ models: MODELS })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    // 落盘内容可核对：
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })

    const list = await call('model.list', { provider: 'buddy' })
    const hy3 = (list.value as { models: Array<{ id: string; disabled: boolean }> })
      .models.find(m => m.id === 'hy3')!
    expect(hy3.disabled).toBe(true)
  })

  it('重新打开时从黑名单移除（写 false 不残留）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })

    expect(set.value).toEqual({ provider: 'buddy', disabledModels: {} })
    expect(storedValue().disabledModels).toEqual({})
  })

  it('model.setDisabled 缺少 modelId 时返回 bad-request 而不是静默成功', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('modelId')
  })

  it('llm 服务不可用时 model.list 返回可读错误（账号面板不受影响）', async () => {
    const { call } = registerEndpoints({ models: MODELS, withoutLlm: true })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })

  it('适配器 listModels 抛错时返回可读错误而不是裸 500', async () => {
    const { call } = registerEndpoints({ models: MODELS, listModelsError: '令牌已过期' })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('令牌已过期')
  })
})

/**
 * 三个积分端点的 provider 分派与能力边界（后端侧契约）。
 *
 * 四个 provider 分属**三套互不相同的协议**：
 * - CodeBuddy 系（buddy / workbuddy）经 `productById()` 取 BuddyProduct；
 * - `lobsterai`（三步 client-activities）；
 * - `codearts`（华为云 SDK-HMAC-SHA256 签名，见 `src/codearts-credits.ts`）。
 *
 * 历史背景（本用例的由来）：CodeArts 曾**不是** BuddyProduct，
 * `productById('codearts')` 返回 undefined，于是三个端点必然回
 * `bad-request: unsupported provider: codearts`。当时客户端在面板挂载时对
 * **所有** provider 无条件调用 `credits.balances`，把这条必然的拒绝当成运行时
 * 故障打进了控制台，并把账号卡片的「积分」渲染成「查询失败」（修法见
 * `plugin-src/client/credits-capabilities.js` 与
 * `tests/unit/credits-capabilities.spec.ts`）。
 *
 * 现在 CodeArts 已接入真实实现，因此本用例锁三件事：
 * 1. **未登记**的 provider 仍回可读的 bad-request（兜底契约不能退化）；
 * 2. CodeArts 被**接受**并返回结构化结果（新能力的回归保护）；
 * 3. 拒绝/接受都**按 provider 精确生效**，没有连 CodeBuddy 系一起误拒。
 *
 * 防止的「好心改坏」：把拒绝改成「返回空结果」→ 前端会以为该 provider 真没有
 * 积分可查，永远查不出问题；让它抛异常 → 退化成 `jet-hub/handler-failed`，
 * 丢失「provider 不支持」这一原因。
 */
describe('积分端点的 provider 能力边界', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 注册端点，返回一个「调用端点方法并解包 result」的函数。 */
  function registerCreditsEndpoints() {
    let handler: Handler | undefined
    const ctx: Record<string, unknown> = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      // 生产代码用惰性注入挂载 connection 端点（见 registerJetHubRpc 的说明）：
      // 替身必须提供 inject，否则会以 `ctx.inject is not a function` 抛错。
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      // 积分端点会 resolve 凭据；返回 undefined 让逐账号流程走「凭据未配置」
      // 分支，从而无需真实网络即可跑完（accounts 替身返回空数组，实际不触发）。
      credentials: { resolve: async () => undefined },
    }
    // pool 替身：一旦 provider 校验被绕过，listAccounts 会返回空数组，
    // 端点便以 `ok: true` + 空列表「假成功」——下面的断言会立刻揭穿它，
    // 而不会因为抛 TypeError 变成误导性的 handler-failed。
    const pool = { listAccounts: async () => [] }

    registerJetHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    return async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
  }

  const CREDITS_METHODS = ['credits.status', 'credits.claimAll', 'credits.balances']

  /**
   * 未知 provider 仍必须被拒。
   *
   * ⚠️ 历史上这条用例断言的是 **codearts** 被拒 —— 当时 CodeArts 确实没有
   * 积分能力（华为云账号体系无腾讯计费接口）。现在它已接入自己的签名协议
   * （`src/codearts-credits.ts`），故改用真正未登记的 provider 名来守住
   * 同一件事：**拒绝是兜底契约，不是常规路径**。
   *
   * 保留本用例的价值：防止「好心改坏」——把拒绝改成「返回空结果」会让前端
   * 以为该 provider 真没有积分可查；让它抛异常则退化成
   * `jet-hub/handler-failed`，丢失「provider 不支持」这一原因。
   */
  it.each(CREDITS_METHODS)('%s 对未知 provider 返回 unsupported provider（可读的 bad-request）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'unknownprovider' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe('unsupported provider: unknownprovider')
  })

  it.each(CREDITS_METHODS)('%s 不会把 CodeBuddy 系一并误拒', async (method) => {
    const call = registerCreditsEndpoints()
    // 两个 Buddy 系产品都能通过 provider 校验，走到 listAccounts（替身返回空）。
    for (const provider of ['buddy', 'workbuddy']) {
      const result = await call(method, { provider })
      expect(result.ok, `${method}/${provider}`).toBe(true)
    }
  })

  /**
   * CodeArts 现在**必须**被接受（不再回 bad-request）。
   *
   * 这是本次接入的核心契约：三个积分端点都要为 `codearts` 分支。
   * 用空账号池调用，只验证「provider 被接受且返回结构化结果」，
   * 不触发任何网络请求。
   */
  it.each(CREDITS_METHODS)('%s 接受 codearts（已接入华为云签名协议）', async (method) => {
    const call = registerCreditsEndpoints()
    const result = await call(method, { provider: 'codearts' })
    expect(result.ok).toBe(true)
  })

  it('credits.balances 对 codearts 返回 accounts 数组', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.balances', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.status 对 codearts 返回 accounts 数组（状态如实为 null）', async () => {
    // 华为侧没有独立的「签到状态」端点，故与 LobsterAI 同样返回 null，
    // 而不是臆造一份 CheckinStatus 形状的对象。
    const call = registerCreditsEndpoints()
    const result = await call('credits.status', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { accounts: unknown[] }).accounts).toEqual([])
  })

  it('credits.claimAll 对 codearts 返回 summary 结构', async () => {
    const call = registerCreditsEndpoints()
    const result = await call('credits.claimAll', { provider: 'codearts' })
    expect(result.ok).toBe(true)
    expect((result.value as { summary: unknown }).summary).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })

  /**
   * TRAE 的 claim 分支**必须开启状态预检**。
   *
   * 真实缺陷（用户报障：「领取积分显示成功但是加 0 积分」的成因之二）：
   * TRAE 的 claim 对「今天已签到」是**幂等**的 —— 实测重复领取同样返回
   * `{code:0, message:"success"}`，与真正领取成功**无法区分**。早期照抄
   * LobsterAI 传了 `precheckStatus: false`（那是「LobsterAI 的领取流程内部
   * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号被
   * 报成「领取成功」。判据只能是 status 端点的 `checked_in`。
   *
   * 用源码级断言而非行为断言：本用例要锁的是「这一行配置别被改回去」，
   * 与仓库里 `qoder-wiring.spec.ts` 守卫接线的方式一致。
   */
  it('TRAE 的 claim 分支开启状态预检并注入 fetchStatus（源码级守卫）', () => {
    // 注意 `here` 是同级另一个 describe 内的局部常量，此处不可见，故就地算路径。
    const srcPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/jet-hub-rpc.ts')
    const source = readFileSync(srcPath, 'utf8')
    // 从 claimAll 的 TRAE 分支起算（前面 credits.status 分支里也有同名判断，
    // 用 `collectClaimResults<TraeCredential` 定位更准）。
    const start = source.indexOf('collectClaimResults<TraeCredential')
    expect(start).toBeGreaterThan(-1)
    // 截到该分支的收尾 `return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }`
    // 之后，避免扫到后续其它 provider 分支。
    const rest = source.slice(start)
    const end = rest.indexOf('RpcCreditsClaimAllResponse }')
    const branch = end > -1 ? rest.slice(0, end) : rest.slice(0, 2000)
    // 剔除注释行：本文件在注释里叙述了这条缺陷的成因（含 precheckStatus 字样）。
    const code = branch
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code, 'TRAE 分支不得关闭状态预检').not.toContain('precheckStatus: false')
    expect(code, 'TRAE 分支必须注入 fetchStatus').toContain('fetchStatus:')
  })
})

/**
 * `account.reorder` 端点（Jet Hub 拖拽排序）。
 *
 * 用**真实 AccountPool** + 内存 settings 替身，而不是给 pool 打桩：
 * 这个端点的价值全在「参数校验 + 转交 pool.reorderAccounts」，
 * 用桩替换 pool 就只剩「调用了某方法」这种无信息量的断言，
 * 无法发现「集合校验被绕过」「顺序没持久化」这类真实问题。
 */
describe('account.reorder 端点', () => {
  type Handler = (request: Request) => Promise<Response>

  /** 建一个真实 pool（内存 settings）+ 端点调用器。 */
  function setup(initial: Array<{ id: string; provider: string }>) {
    let stored: { accounts: unknown[]; disabledModels: Record<string, unknown> } = {
      accounts: initial.map(a => ({
        ...a,
        nickname: a.id,
        enabled: true,
        credentialRef: `${a.provider.toUpperCase()}_ACCOUNT_${a.id.toUpperCase()}`,
        createdAt: 1,
        refreshable: true,
      })),
      disabledModels: {},
    }
    let handler: Handler | undefined
    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: typeof stored) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)
    const ctx = {
      get: (key: string) => key === 'connection'
        ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
        : undefined,
      inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
      logger: { warn: () => {}, info: () => {} },
      credentials: { resolve: async () => undefined },
    }
    registerJetHubRpc(ctx as never, pool as never, {} as never, {} as never, {} as never, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }
    return { call, orderInStore: () => (stored.accounts as Array<{ id: string }>).map(a => a.id) }
  }

  it('重排成功并把新顺序写入存储', async () => {
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
      { id: 'c', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['c', 'a', 'b'] })
    expect(result.ok).toBe(true)
    expect(orderInStore()).toEqual(['c', 'a', 'b'])
  })

  it('集合不一致（列表过期）回可读错误，而不是 handler-failed', async () => {
    // 这类并发是可预期的：用户拖拽期间在别处新增/删除了账号。
    // 回 bad-request + 可读文案，前端能提示"刷新后重试"；
    // 若抛异常会退化成 jet-hub/handler-failed，用户只看到"未知故障"。
    const { call, orderInStore } = setup([
      { id: 'a', provider: 'buddy' },
      { id: 'b', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['a'] })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('账号列表已变化')
    // 数据未被破坏
    expect(orderInStore()).toEqual(['a', 'b'])
  })

  it('缺 provider 或 orderedIds 非字符串数组 → bad-request', async () => {
    const { call } = setup([{ id: 'a', provider: 'buddy' }])
    expect((await call('account.reorder', { orderedIds: ['a'] })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy' })).ok).toBe(false)
    expect((await call('account.reorder', { provider: 'buddy', orderedIds: [1, 2] })).ok).toBe(false)
  })

  it('重排不影响其他 provider 账号的位置', async () => {
    const { call, orderInStore } = setup([
      { id: 'b1', provider: 'buddy' },
      { id: 'c1', provider: 'codearts' },
      { id: 'b2', provider: 'buddy' },
    ])
    const result = await call('account.reorder', { provider: 'buddy', orderedIds: ['b2', 'b1'] })
    expect(result.ok).toBe(true)
    // buddy 的两个账号在各自原下标上互换，codearts 仍在中间
    expect(orderInStore()).toEqual(['b2', 'c1', 'b1'])
  })
})
