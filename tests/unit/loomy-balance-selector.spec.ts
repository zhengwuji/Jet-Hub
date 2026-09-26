import { describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import {
  LOOMY_BALANCE_CACHE_TTL_MS,
  LoomyBalanceSelector,
} from '../../src/loomy-balance-selector.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '18611112222',
}

/** 造一个余额响应。 */
function balanceResponse(balance: number, dailyBalance: number): Response {
  return new Response(JSON.stringify({
    code: '000000',
    desc: '成功',
    trace_id: 't',
    data: { balance, dailyBalance, availableBalance: balance + dailyBalance },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 造一个失败响应（凭据失效）。 */
function authError(): Response {
  return new Response(JSON.stringify({
    code: '100002', desc: '登录已失效', trace_id: 't', data: {},
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 按账号 token 分派余额响应的 fetch 替身。 */
function makeFetcher(byToken: Record<string, { balance: number; daily: number } | 'error'>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = String((init?.headers as Record<string, string> | undefined)?.token ?? '')
    const spec = byToken[token]
    if (spec === undefined) throw new Error(`未预期的 token: ${token}`)
    if (spec === 'error') return authError()
    return balanceResponse(spec.balance, spec.daily)
  })
}

/** 造一个按 ref 返回不同凭据的解析器。 */
function makeResolver(byRef: Record<string, LoomyCredential | undefined>) {
  return async (ref: string): Promise<LoomyCredential | undefined> => byRef[ref]
}

describe('LoomyBalanceSelector.balanceOf', () => {
  it('查到余额时返回 ok + 两个池', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 4445, daily: 0 } })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const balance = await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    expect(balance.ok).toBe(true)
    expect(balance.permanentBalance).toBe(4445)
    expect(balance.dailyBalance).toBe(0)
  })

  it('凭据失效时返回 ok:false 且带原因（不抛错）', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: 'error' })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const balance = await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    expect(balance.ok).toBe(false)
    expect(balance.error).toMatch(/余额查询失败/)
    // 两个余额字段都不该编造数字
    expect(balance.dailyBalance).toBeUndefined()
    expect(balance.permanentBalance).toBeUndefined()
  })

  it('凭据未配置时返回 ok:false', async () => {
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({}),
      fetcher: vi.fn() as unknown as typeof fetch,
    })
    const balance = await selector.balanceOf({ id: 'a1', credentialRef: 'missing' })
    expect(balance.ok).toBe(false)
    expect(balance.error).toMatch(/凭据未配置/)
  })

  it('凭据解析抛错时也返回 ok:false（不冒泡）', async () => {
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: async () => { throw new Error('boom') },
      fetcher: vi.fn() as unknown as typeof fetch,
    })
    const balance = await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    expect(balance.ok).toBe(false)
    expect(balance.error).toMatch(/boom/)
  })
})

/**
 * 缓存（用户选择 60 秒 TTL）。
 *
 * 每次选号都实时查所有账号会显著变慢（N 个账号 = N 次网络往返）。
 */
describe('LoomyBalanceSelector 缓存', () => {
  it('TTL 内重复查同一账号只发一次请求', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 100, daily: 50 } })
    let now = 1_000_000
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => now,
    })

    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    now += LOOMY_BALANCE_CACHE_TTL_MS - 1
    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 后重新查', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 100, daily: 50 } })
    let now = 1_000_000
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => now,
    })

    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    now += LOOMY_BALANCE_CACHE_TTL_MS + 1
    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate 立即失效（不指定 id 则全清）', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 100, daily: 50 } })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    selector.invalidate('a1')
    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(2)

    selector.invalidate()
    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('不同账号各查一次（缓存按 id 隔离）', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: { balance: 100, daily: 0 },
      [cred2.access_token]: { balance: 0, daily: 5000 },
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    await selector.balanceOf({ id: 'a1', credentialRef: 'r1' })
    await selector.balanceOf({ id: 'a2', credentialRef: 'r2' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('LoomyBalanceSelector.select', () => {
  it('优先选有今日额度的账号（即使它在手动顺序里靠后）', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: { balance: 5000, daily: 0 },      // 只有永久
      [cred2.access_token]: { balance: 0, daily: 3000 },                     // 有今日
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
    ])
    expect(picked?.account.id).toBe('a2')
    expect(picked?.balance.dailyBalance).toBe(3000)
  })

  it('都无今日额度时选有永久积分的', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: { balance: 0, daily: 0 },        // 都无
      [cred2.access_token]: { balance: 800, daily: 0 },                      // 有永久
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
    ])
    expect(picked?.account.id).toBe('a2')
  })

  /**
   * ⚠️ **档内保持手动顺序**（用户明确选择，与既有语义一致）。
   */
  it('都有今日额度时按传入顺序（不按余额大小）', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: { balance: 0, daily: 100 },      // 今日较少，但排第一
      [cred2.access_token]: { balance: 0, daily: 9000 },                    // 今日更多，但排第二
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
    ])
    expect(picked?.account.id).toBe('a1')
  })

  /**
   * ⚠️ 用户明确要求：**查询失败归入最后一档**。
   */
  it('查询失败的账号排在有余额的之后', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: 'error',                          // 查不到（排第一）
      [cred2.access_token]: { balance: 10, daily: 0 },                       // 有永久（排第二）
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
    ])
    expect(picked?.account.id).toBe('a2')
  })

  it('全部查不到时仍返回第一个（不返回 undefined，避免直接判无账号）', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: 'error' })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }])
    expect(picked?.account.id).toBe('a1')
    expect(picked?.balance.ok).toBe(false)
  })

  it('候选为空时返回 undefined', async () => {
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({}),
      fetcher: vi.fn() as unknown as typeof fetch,
    })
    expect(await selector.select([])).toBeUndefined()
  })

  /**
   * ⚠️ **锁定永久积分**（用户需求）：只剩永久积分的账号不可用。
   */
  it('锁定时只剩永久积分的账号不被选中（返回 undefined）', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 9999, daily: 0 } })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }], { allowPermanent: false })
    expect(picked).toBeUndefined()
  })

  it('锁定时有今日额度的账号仍可被选中', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 0, daily: 500 } })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }], { allowPermanent: false })
    expect(picked?.account.id).toBe('a1')
    expect(picked?.balance.dailyBalance).toBe(500)
  })

  it('锁定时优先有今日额度的（跳过只剩永久积分的）', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const fetcher = makeFetcher({
      [CRED.access_token]: { balance: 9999, daily: 0 },   // 只有永久（手动顺序第一）
      [cred2.access_token]: { balance: 0, daily: 100 },   // 有今日（第二）
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
    ], { allowPermanent: false })
    expect(picked?.account.id).toBe('a2')
  })

  /**
   * ⚠️ **解锁时必须保持既有行为**：所有账号余额都是 0 时仍返回第一个候选
   * （让上游报余额不足，错误信息更准确），不能因为加了锁定功能而改变。
   */
  it('解锁时全部无余额仍返回第一个（不改变既有行为）', async () => {
    const fetcher = makeFetcher({ [CRED.access_token]: { balance: 0, daily: 0 } })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }])
    expect(picked?.account.id).toBe('a1')
  })

  it('并发查余额（不是串行 N 次等待）', async () => {
    const cred2: LoomyCredential = { ...CRED, access_token: 'T'.repeat(32) }
    const cred3: LoomyCredential = { ...CRED, access_token: 'U'.repeat(32) }
    const order: string[] = []
    const fetcher = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const token = String((init?.headers as Record<string, string>)?.token ?? '')
      order.push(`start:${token[0]}`)
      await new Promise((r) => setTimeout(r, 5))
      order.push(`end:${token[0]}`)
      return balanceResponse(100, 100)
    })
    const selector = new LoomyBalanceSelector({
      product: LOOMY,
      resolveCredential: makeResolver({ r1: CRED, r2: cred2, r3: cred3 }),
      fetcher: fetcher as unknown as typeof fetch,
    })

    await selector.select([
      { id: 'a1', credentialRef: 'r1' },
      { id: 'a2', credentialRef: 'r2' },
      { id: 'a3', credentialRef: 'r3' },
    ])
    // 三个 start 应都在任何 end 之前（并发）
    const firstEnd = order.findIndex((x) => x.startsWith('end:'))
    const startsBeforeEnd = order.slice(0, firstEnd).filter((x) => x.startsWith('start:')).length
    expect(startsBeforeEnd).toBe(3)
  })
})
