/**
 * `src/trae-credits.ts` 的单元测试。
 *
 * 全部用桩 fetcher，**不发任何真实网络请求**。
 *
 * ⚠️ 新实现（对齐 trae-mate）的关键行为变更：
 * - 9074 **不再重试**（设备身份基于 user_id 确定性派生，天然独立，不需要轮换）
 * - claim body 改为 `{}`，而非 `{"req_source":2}`
 * - 请求头使用完整客户端头（约 20 个），而非简化的 Ug 头
 * - 错误分类 + 冷却信息通过 `errorType` / `cooldownSecs` 返回
 */

import { describe, expect, it } from 'vitest'
import {
  TRAE_CHECKIN_BUSY_CODE,
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance,
  classifyTraeCheckinError,
} from '../../src/trae-credits.js'
import { TRAE, TRAE_INTL } from '../../src/trae-product.js'
import type { TraeCredential } from '../../src/trae.js'

function makeCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    nickname: '测试账号',
    machine_id: 'a'.repeat(32),
    device_id: 'c'.repeat(32),
    ...overrides,
  }
}

/** 桩 fetcher：按调用次序返回给定的响应体，并记录调用次数。 */
function stubFetcher(payloads: unknown[]): { fetcher: typeof fetch; calls: number } {
  let calls = 0
  const fetcher = (async () => {
    calls++
    const next = payloads.shift()
    if (next === undefined) throw new Error('unexpected fetch call')
    return new Response(JSON.stringify(next), { status: 200 })
  }) as unknown as typeof fetch
  return { fetcher, calls: calls }
}

/** 返回 { success, errorType, cooldownSecs } 辅助断言。 */
function failedWith(outcome: unknown): { errorType?: string; cooldownSecs?: number } {
  const o = outcome as Record<string, unknown>
  return { errorType: o.errorType as string, cooldownSecs: o.cooldownSecs as number }
}

describe('claimTraeDailyCheckin · 对齐 trae-mate', () => {
  /**
   * ⚠️ **claim 响应不含积分数**（真实缺陷回归）。
   *
   * 实测（2026-09-20）claim 的完整响应就是 `{"code":0,"message":"success"}` ——
   * 没有任何 credits 字段。早期实现读 `body.credits`，于是**恒为 0**，界面显示
   * 「1 个账号领取成功（+0 积分）」而 IDE 里明明写着 150（用户报障）。
   *
   * 真实数值只在 **status 端点**的 `credits` 字段里（实测 `credits:150`，与积分
   * 余额中「签到奖励」包的 `credits_limit:150` 完全吻合）。故领取成功后补查一次
   * 状态。桩按调用次序返回：第 1 次 claim、第 2 次 status。
   */
  it('成功时从 status 补查真实所得（claim 响应本身没有数量）', async () => {
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success' },                        // claim
      { code: 0, checked_in: true, credits: 150, streak_days: 3, enable: true }, // status
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150, streakDays: 3 })
  })

  it('补查失败时 credit 为 0，但仍是 claimed（不因补查而判失败）', async () => {
    // status 返回非 0 业务码 → fetchTraeCheckinStatus 返回 null → credit 兜底 0。
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success' },
      { code: 500, message: 'oops' },
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
  })

  it('⚠️ 不再从 claim 响应读 credits（那是恒 0 的旧缺陷）', async () => {
    // 即便 claim 响应**伪造**一个 credits，也不该采信 —— 真实协议里没有该字段。
    const { fetcher } = stubFetcher([
      { code: 0, message: 'success', credits: 999 },
      { code: 0, checked_in: true, credits: 150, enable: true },
    ])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
  })

  it('9074 不再重试（基于 user_id 确定性派生设备身份，天然独立）', async () => {
    const { fetcher } = stubFetcher([{ code: TRAE_CHECKIN_BUSY_CODE, message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: TRAE_CHECKIN_BUSY_CODE })
    // 只有一次请求（不再做设备轮换重试）
  })

  it('9074 返回 BusinessError + 300s 冷却', async () => {
    const { fetcher } = stubFetcher([{ code: TRAE_CHECKIN_BUSY_CODE, message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(failedWith(outcome)).toMatchObject({ errorType: 'BusinessError', cooldownSecs: 300 })
  })

  it('其它业务码如实回报（不重试）', async () => {
    const { fetcher } = stubFetcher([{ code: 9004, message: 'device required' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: 9004, message: 'device required' })
  })

  it('⚠️ 字符串形态的 "9074" 也要被正确识别', async () => {
    const { fetcher } = stubFetcher([{ code: '9074', message: 'too many users' }])
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome).toMatchObject({ kind: 'failed', code: 9074 })
  })

  it('HTTP 失败时报 failed', async () => {
    const fetcher = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const outcome = await claimTraeDailyCheckin(makeCredential(), TRAE, fetcher)
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(-1)
  })
})

describe('classifyTraeCheckinError（对齐 trae-mate cooldown.rs）', () => {
  it('200 + code=1005 → PlanLimit, 43200s', () => {
    expect(classifyTraeCheckinError(200, 1005)).toMatchObject({ type: 'PlanLimit', cooldownSecs: 43200 })
  })
  it('429 → SoftRate, 60s', () => {
    expect(classifyTraeCheckinError(429, undefined)).toMatchObject({ type: 'SoftRate', cooldownSecs: 60 })
  })
  it('401 → SessionDead, 永久', () => {
    expect(classifyTraeCheckinError(401, undefined)).toMatchObject({ type: 'SessionDead', cooldownSecs: -1 })
  })
  it('404 → NotFound, 60s', () => {
    expect(classifyTraeCheckinError(404, undefined)).toMatchObject({ type: 'NotFound', cooldownSecs: 60 })
  })
  it('5xx → Server, 600s', () => {
    expect(classifyTraeCheckinError(502, undefined)).toMatchObject({ type: 'Server', cooldownSecs: 600 })
  })
  it('4xx → Client, 600s', () => {
    expect(classifyTraeCheckinError(400, 1000)).toMatchObject({ type: 'Client', cooldownSecs: 600 })
  })
  it('业务码非0 → BusinessError, 300s', () => {
    expect(classifyTraeCheckinError(200, 1000)).toMatchObject({ type: 'BusinessError', cooldownSecs: 300 })
  })
  it('code=0 或 undefined → Unknown, 0s', () => {
    expect(classifyTraeCheckinError(200, 0)).toMatchObject({ type: 'Unknown', cooldownSecs: 0 })
    expect(classifyTraeCheckinError(200, undefined)).toMatchObject({ type: 'Unknown', cooldownSecs: 0 })
  })
})

describe('fetchTraeCheckinStatus / fetchTraeCreditBalance', () => {
  it('状态查询读 checked_in / credits / enable', async () => {
    const { fetcher } = stubFetcher([{ checked_in: true, credits: 100, enable: true }])
    const status = await fetchTraeCheckinStatus(makeCredential(), TRAE, fetcher)
    expect(status).toMatchObject({ todayCheckedIn: true, dailyCredit: 100, active: true })
  })

  it('余额按 pack 累加 credits_limit - credits_amount', async () => {
    const { fetcher } = stubFetcher([{
      user_entitlement_pack_list: [
        { entitlement_base_info: { quota: { credits_limit: 500 } }, usage: { credits_amount: 120 } },
        { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 0 } },
        { entitlement_base_info: { quota: { credits_limit: 0 } }, usage: { credits_amount: 0 } },
      ],
    }])
    const balance = await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(balance?.total).toBe(480)
  })

  it('无资源包时返回 null（区分「查不到」与「余额为 0」）', async () => {
    const { fetcher } = stubFetcher([{ user_entitlement_pack_list: [] }])
    expect(await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)).toBeNull()
  })
})

describe('fetchTraeCreditBalance · 区域端点', () => {
  /** 记录请求 URL 的桩 fetcher。 */
  function recordingFetcher(payload: unknown): { fetcher: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetcher = (async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch
    return { fetcher, urls }
  }

  /**
   * ⚠️ **真实缺陷回归**：`postJson` 曾把 `https://api.trae.cn` 与 v2 路径写死，
   * 于是 `TraeProduct.ugHost` / `entUsagePath` 成了死配置，国际版账号被发到
   * 国内站点 + 错版本号，面板恒显示「余额查询失败」。
   *
   * 国际版真实站点是 `ug-normal.trae.ai`、路径是 **v1**（判据来自 TRAE 官网
   * `account-setting` 的 bundle：`genBaseURL("/trae/api/v1/pay/ide_user_ent_usage")`，
   * 且该模块导出 `ug-normal.trae.ai`）。
   */
  it('国际版走 product.ugHost + entUsagePath（ug-normal.trae.ai / v1）', async () => {
    const { fetcher, urls } = recordingFetcher({ user_entitlement_pack_list: [] })
    await fetchTraeCreditBalance(makeCredential(), TRAE_INTL, fetcher)
    expect(urls[0]).toBe('https://ug-normal.trae.ai/trae/api/v1/pay/ide_user_ent_usage')
  })

  it('国内版仍走 api.trae.cn / v2（无回归）', async () => {
    const { fetcher, urls } = recordingFetcher({ user_entitlement_pack_list: [] })
    await fetchTraeCreditBalance(makeCredential(), TRAE, fetcher)
    expect(urls[0]).toBe('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage')
  })
})

describe('fetchTraeCreditBalance · 用量计费（dollar usage billing）', () => {
  /** 造一个 entitlement pack（默认 status=1、无到期时间 ⇒ 有效）。 */
  function pack(opts: {
    status?: unknown
    expireTime?: number
    endTime?: number
    quota?: Record<string, number>
    usage?: Record<string, number>
  } = {}): Record<string, unknown> {
    return {
      display_desc: 'Free plan',
      status: opts.status,
      expire_time: opts.expireTime ?? 0,
      entitlement_base_info: { quota: opts.quota ?? {}, end_time: opts.endTime ?? 0 },
      usage: opts.usage ?? {},
    }
  }

  function balanceOf(packList: unknown[]): Promise<unknown> {
    const fetcher = (async () => new Response(
      JSON.stringify({ user_entitlement_pack_list: packList }), { status: 200 },
    )) as unknown as typeof fetch
    return fetchTraeCreditBalance(makeCredential(), TRAE_INTL, fetcher)
  }

  type Balance = {
    total: number
    expiredTotal: number
    packages: { name: string; unit: string; remaining: number; total: number; active: boolean }[]
  }

  /**
   * ⚠️ **真实缺陷回归**：国际版是 `is_dollar_usage_billing: true`，
   * `credits_limit` 恒为 0（实测国际版 Free plan = 0），旧实现只认
   * `credits_limit > 0`，一个包都产不出 ⇒ 返回 null ⇒ 面板恒「余额查询失败」。
   * 现按官网同款字段展开请求额度，单位「次」。
   */
  it('credits_limit=0 时展开请求额度（与官网 usage 页同口径）', async () => {
    const balance = await balanceOf([pack({
      quota: {
        credits_limit: 0,
        advanced_model_request_limit: 1000,
        premium_model_fast_request_limit: 10,
        premium_model_slow_request_limit: 50,
        auto_completion_limit: 5000,
      },
      usage: { credits_amount: 0 },
    })]) as Balance

    expect(balance.total).toBe(6060)
    expect(balance.packages.map((p) => p.name)).toEqual([
      '高级模型请求 · Free plan', '快速请求 · Free plan', '慢速请求 · Free plan', '自动补全 · Free plan',
    ])
    expect(balance.packages.every((p) => p.unit === '次')).toBe(true)
  })

  it('用量值从对应字段扣除', async () => {
    const balance = await balanceOf([pack({
      quota: { credits_limit: 0, advanced_model_request_limit: 1000 },
      usage: { advanced_model_request_usage: 250 },
    })]) as Balance
    expect(balance.packages[0]).toMatchObject({ remaining: 750, total: 1000, active: true })
    expect(balance.total).toBe(750)
  })

  it('limit <= 0 的项不产生条目', async () => {
    const balance = await balanceOf([pack({
      quota: { credits_limit: 0, advanced_model_request_limit: 0, auto_completion_limit: 5000 },
    })]) as Balance
    expect(balance.packages).toHaveLength(1)
    expect(balance.packages[0]!.name).toBe('自动补全 · Free plan')
  })
})

describe('fetchTraeCreditBalance · 资源包有效性判定', () => {
  const NOW_S = Math.floor(Date.now() / 1000)
  const FUTURE = NOW_S + 30 * 86_400
  const PAST = NOW_S - 86_400

  function pack(opts: {
    status?: unknown
    expireTime?: number
    endTime?: number
    quota?: Record<string, number>
    usage?: Record<string, number>
  } = {}): Record<string, unknown> {
    return {
      display_desc: 'Free plan',
      status: opts.status,
      expire_time: opts.expireTime ?? 0,
      entitlement_base_info: { quota: opts.quota ?? {}, end_time: opts.endTime ?? 0 },
      usage: opts.usage ?? {},
    }
  }

  function balanceOf(packList: unknown[]): Promise<unknown> {
    const fetcher = (async () => new Response(
      JSON.stringify({ user_entitlement_pack_list: packList }), { status: 200 },
    )) as unknown as typeof fetch
    return fetchTraeCreditBalance(makeCredential(), TRAE_INTL, fetcher)
  }

  type Balance = {
    total: number
    expiredTotal: number
    packages: { name: string; remaining: number; active: boolean; cycleEndTime: string; expiredTime: string }[]
  }

  const usageQuota = { credits_limit: 0, advanced_model_request_limit: 1000 }

  /**
   * ⚠️ **真实缺陷回归**：`active` 原为硬编码 `true` —— 套餐到期后面板仍显示
   * 「N/N 个资源包有效」并把失效额度算进总额，`expiredTotal` 更是从不累加。
   * 官网 bundle 的判据是 `pack.status === d.it.Active`（**不是** `ent_status`），
   * 到期时间取 `expire_time || entitlement_base_info.end_time`。
   */
  it('status=1 且未到期 → 有效并计入 total', async () => {
    const balance = await balanceOf([pack({ status: 1, endTime: FUTURE, quota: usageQuota })]) as Balance
    expect(balance.packages[0]!.active).toBe(true)
    expect(balance.total).toBe(1000)
    expect(balance.expiredTotal).toBe(0)
  })

  it('已过 end_time → 失效、不计入 total 而计入 expiredTotal', async () => {
    const balance = await balanceOf([pack({ status: 1, endTime: PAST, quota: usageQuota })]) as Balance
    expect(balance.packages[0]!.active).toBe(false)
    expect(balance.total).toBe(0)
    expect(balance.expiredTotal).toBe(1000)
  })

  it('status !== 1（非 Active）→ 失效', async () => {
    const balance = await balanceOf([pack({ status: 2, endTime: FUTURE, quota: usageQuota })]) as Balance
    expect(balance.packages[0]!.active).toBe(false)
    expect(balance.expiredTotal).toBe(1000)
  })

  it('expire_time 优先于 end_time', async () => {
    const balance = await balanceOf([
      pack({ status: 1, expireTime: PAST, endTime: FUTURE, quota: usageQuota }),
    ]) as Balance
    expect(balance.packages[0]!.active).toBe(false)
  })

  it('status 缺失且无到期时间 → 保守视为有效（不把未知当失效）', async () => {
    const balance = await balanceOf([pack({ quota: usageQuota })]) as Balance
    expect(balance.packages[0]!.active).toBe(true)
    expect(balance.total).toBe(1000)
  })

  it('失效包的到期时间写入 expiredTime（tooltip 据此显示「失效于」）', async () => {
    const balance = await balanceOf([pack({ status: 1, endTime: PAST, quota: usageQuota })]) as Balance
    expect(balance.packages[0]!.expiredTime).not.toBe('')
    expect(balance.packages[0]!.cycleEndTime).toBe('')
  })

  it('credits 口径同样受影响：过期包不计入 total', async () => {
    const balance = await balanceOf([
      pack({ status: 1, endTime: PAST, quota: { credits_limit: 500 }, usage: { credits_amount: 100 } }),
    ]) as Balance
    expect(balance.total).toBe(0)
    expect(balance.expiredTotal).toBe(400)
  })
})
