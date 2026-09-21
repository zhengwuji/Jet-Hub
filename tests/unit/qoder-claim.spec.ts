import { describe, expect, it, vi } from 'vitest'
import {
  claimQoderCampaign,
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  parseQoderCampaigns,
} from '../../src/qoder-credits.js'
import { QODER } from '../../src/qoder-product.js'
import type { QoderCredential } from '../../src/qoder.js'

/**
 * 2026-09-21 由抓包（keylog 解密）解出的真实响应。
 *
 * 领取成功（`replayed:false` + `benefit`）。
 */
const CLAIMED_OK = {
  grantId: '01a0c475-d6f8-70de-90b2-d4c8058c554d',
  status: 'CLAIMED',
  replayed: false,
  benefit: {
    kind: 'CREDITS',
    amount: 100,
    modelScope: { modelSeries: { key: 'ALL_MODELS' } },
    validity: { mode: 'RELATIVE_DAYS', days: 30 },
  },
  campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
  campaignKey: 'act-20260921-308',
  campaignVersion: 1,
  claimedAt: '2026-09-21T14:54:12.176671Z',
  grantedAt: '2026-09-21T14:54:12.393072Z',
  expiresAt: '2026-10-21T14:54:12.176671Z',
}

/**
 * ⚠️ 同一活动**再次**领取的真实响应（抓包里 01a05bce 那次）。
 *
 * 关键：HTTP **200**、`replayed:true`、**无 `benefit`**，
 * 且 `claimedAt` 是**上一次**领取的旧时间（2026-09-18，而请求在 09-21）。
 */
const CLAIMED_REPLAY = {
  grantId: '01a0b515-5381-765b-9160-8fbf643bc17c',
  status: 'CLAIMED',
  replayed: true,
  campaignId: '01a05bce-e800-7494-a002-806e4438f483',
  campaignKey: 'act-20260901-493',
  campaignVersion: 2,
  claimedAt: '2026-09-18T15:14:28.79769Z',
  grantedAt: '2026-09-18T15:14:28.866351Z',
}

/** 抓包里的活动列表（含一个可领、一个仅详情）。 */
const CAMPAIGNS_BODY = {
  uid: '01a0b514-ad7c-7dca-ae92-70181beb532e',
  showCampaign: true,
  claimable: true,
  campaignUrl: 'https://openapi.qoder.sh/growth-page/activity-iframe',
  campaigns: [
    {
      campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
      campaignKey: 'act-20260921-308',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    },
    {
      campaignId: '01a05bce-e800-7494-a002-806e4438f483',
      campaignKey: 'act-20260901-493',
      actionType: 'VIEW_DETAILS',
      claimStatus: 'CLAIMED',
    },
  ],
}

/** 今天已领后的真实响应（列表被清空）。 */
const CAMPAIGNS_EMPTY = { uid: 'u', showCampaign: false, claimable: false, campaignUrl: '', campaigns: [] }

const cred = {} as QoderCredential
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Qoder 活动列表解析', () => {
  it('提取 campaignId / actionType / claimStatus / amount', () => {
    const parsed = parseQoderCampaigns(CAMPAIGNS_BODY)!
    expect(parsed.claimable).toBe(true)
    expect(parsed.campaigns).toHaveLength(2)
    expect(parsed.campaigns[0]).toMatchObject({
      campaignId: '01a0bf8d-0c44-7352-96c5-3baa11cb2da2',
      actionType: 'CLAIM_BENEFIT',
      claimStatus: 'CLAIMABLE',
      amount: 100,
    })
  })

  it('形状非法返回 undefined（与「无活动」区分）', () => {
    expect(parseQoderCampaigns(null)).toBeUndefined()
    expect(parseQoderCampaigns([])).toBeUndefined()
    expect(parseQoderCampaigns('nope')).toBeUndefined()
    // 缺 campaignId 的条目被跳过，但整体仍有效
    expect(parseQoderCampaigns({ campaigns: [{ campaignKey: 'x' }] })?.campaigns).toEqual([])
  })

  it('列表为空时 campaigns 为 []（不是 undefined）', () => {
    const parsed = parseQoderCampaigns(CAMPAIGNS_EMPTY)!
    expect(parsed.campaigns).toEqual([])
    expect(parsed.claimable).toBe(false)
  })
})

describe('Qoder 签到状态', () => {
  it('有可领活动 → todayCheckedIn=false，dailyCredit 取 benefit.amount', async () => {
    const status = await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json(CAMPAIGNS_BODY)) as never)
    expect(status).toMatchObject({ active: true, todayCheckedIn: false, dailyCredit: 100 })
  })

  /**
   * ⚠️ 真实缺陷回归：服务端在「今天已领」时把 `campaigns` 清空并回
   * `showCampaign:false`。若按「列表非空」判 `active`，调用方会先命中
   * 「活动未开启」分支 —— 用户看到的是「签到活动未开启」而不是「今天已领」。
   */
  it('列表被清空（今天已领）→ active 仍为 true、todayCheckedIn=true', async () => {
    const status = await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json(CAMPAIGNS_EMPTY)) as never)
    expect(status).toMatchObject({ active: true, todayCheckedIn: true })
  })

  it('网络失败 / 非 2xx → null（与「无活动」严格区分）', async () => {
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => { throw new Error('x') }) as never)).toBeNull()
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => json({}, 500)) as never)).toBeNull()
    expect(await fetchQoderCheckinStatus(cred, QODER, vi.fn(async () => new Response('<html>', { status: 200 })) as never)).toBeNull()
  })
})

describe('Qoder 领取单个活动', () => {
  it('成功：从 benefit.amount 读积分', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(CLAIMED_OK)) as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
  })

  /**
   * ⚠️ 核心幂等判据：重复领取**同样是 200**，必须靠 `replayed:true` 识别。
   * 只看 HTTP 状态会把「今天已领」误报成「领取成功 +100」——
   * 用户报障过同类问题（TRAE 显示成功但 +0 积分）。
   */
  it('replayed:true → already-claimed（**不是** claimed）', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(CLAIMED_REPLAY)) as never)
    expect(outcome.kind).toBe('already-claimed')
    expect(outcome).toMatchObject({ message: '今天已领取' })
  })

  it('status 非 CLAIMED 且未 replayed → failed', async () => {
    const body = { status: 'NOT_ELIGIBLE', campaignId: 'c1' }
    const outcome = await claimQoderCampaign(cred, QODER, 'c1', vi.fn(async () => json(body)) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
  })

  it('401 给出「重新登录」的可读原因（而不是空洞的 HTTP 401）', async () => {
    const outcome = await claimQoderCampaign(cred, QODER, 'c1',
      vi.fn(async () => new Response('<html>', { status: 401 })) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
    if (outcome.kind === 'failed') expect(outcome.message).toContain('重新登录')
  })

  it('请求体是空串（抓包实测 content-length: 0）', async () => {
    const fetcher = vi.fn(async () => json(CLAIMED_OK))
    await claimQoderCampaign(cred, QODER, 'c1', fetcher as never)
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(init.body).toBe('')
    expect(init.method).toBe('POST')
  })

  it('campaignId 被 URL 编码（防注入路径分隔符）', async () => {
    const fetcher = vi.fn(async () => json(CLAIMED_OK))
    await claimQoderCampaign(cred, QODER, 'a/b', fetcher as never)
    const url = String(fetcher.mock.calls[0]![0])
    expect(url).toContain('/campaigns/a%2Fb/claim')
  })
})

describe('Qoder 领取全部可领活动', () => {
  it('无可领活动 → already-claimed（今天已领）', async () => {
    const outcome = await claimQoderDailyCheckin(cred, QODER, vi.fn(async () => json(CAMPAIGNS_EMPTY)) as never)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('只领 CLAIM_BENEFIT 且 CLAIMABLE 的，跳过 VIEW_DETAILS', async () => {
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json(CLAIMED_OK) : json(CAMPAIGNS_BODY))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100 })
    const claimCalls = fetcher.mock.calls.filter((c) => String(c[0]).includes('/claim'))
    // 只对 01a0bf8d 发起领取，VIEW_DETAILS 的 01a05bce 不碰
    expect(claimCalls).toHaveLength(1)
    expect(String(claimCalls[0]![0])).toContain('01a0bf8d')
  })

  it('多个可领活动逐个领取并累加积分', async () => {
    const two = {
      ...CAMPAIGNS_BODY,
      campaigns: [
        { campaignId: 'a', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } },
        { campaignId: 'b', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 50 } },
      ],
    }
    const fetcher = vi.fn(async (url: string) =>
      String(url).includes('/claim') ? json({ status: 'CLAIMED', replayed: false, benefit: { amount: String(url).includes('/a/') ? 100 : 50 } }) : json(two))
    const outcome = await claimQoderDailyCheckin(cred, QODER, fetcher as never)
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 150 })
    expect(fetcher.mock.calls.filter((c) => String(c[0]).includes('/claim'))).toHaveLength(2)
  })

  it('查询列表失败 → failed（不误报已领）', async () => {
    const outcome = await claimQoderDailyCheckin(cred, QODER, vi.fn(async () => { throw new Error('x') }) as never)
    expect(outcome).toMatchObject({ kind: 'failed' })
  })
})
