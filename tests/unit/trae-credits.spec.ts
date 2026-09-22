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
import { TRAE } from '../../src/trae-product.js'
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
