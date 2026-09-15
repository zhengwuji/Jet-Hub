import { describe, expect, it } from 'vitest'
import {
  collectClaimResults,
  collectCreditsStatus,
  computeClaimSummary,
} from '../../src/jet-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/jet-hub-rpc.js'
import type { ClaimOutcome, CheckinStatus } from '../../src/credits.js'
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
})

describe('account.create credentialRef 命名规范', () => {
  it('所有产品的 provider 都能派生出符合 POSIX 标识符正则的 credentialRef', async () => {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    const { ALL_PRODUCTS } = await import('../../src/product.js')
    const providers = ['codearts', ...ALL_PRODUCTS.map((p) => p.id)]
    for (const provider of providers) {
      const refPrefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
      const refName = `${refPrefix}_ACCOUNT_A1B2C3D4`
      expect(() => credentialRef(refName)).not.toThrow()
    }
  })
})
