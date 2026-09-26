import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from '../../src/account-pool.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/**
 * 伪造的 MockContext。
 *
 * `staleReads` 选项模拟 DSH settings 服务的真实行为：`scope.get()` 返回的是
 * 服务内部的 resolved 快照，`replace()` 之后该快照未必立即更新。开启后
 * get() 会返回上一次 replace() 之前的值——用于复现"连续记录限流互相覆盖"。
 */
function createMockContext(
  initialAccounts: ProviderAccountEntry[] = [],
  options: {
    staleReads?: boolean
    initialDisabledModels?: Record<string, Record<string, boolean>>
    /** 初始的 Loomy 永久积分锁定状态（模拟「已落盘的老状态」）。 */
    initialLoomyPermanentLocked?: boolean
  } = {},
) {
  let stored: {
    accounts?: ProviderAccountEntry[]
    disabledModels?: Record<string, Record<string, boolean>>
    loomyPermanentLocked?: boolean
  } = {
    accounts: initialAccounts,
    ...options.initialDisabledModels !== undefined ? { disabledModels: options.initialDisabledModels } : {},
    ...options.initialLoomyPermanentLocked !== undefined
      ? { loomyPermanentLocked: options.initialLoomyPermanentLocked }
      : {},
  }
  // 滞后读：get() 返回的这个值只在"下一次 replace 之后"才追平
  let visible = stored
  const replaceCalls: Array<ProviderAccountEntry[]> = []
  // 每次 replace 的完整载荷：用于断言「写账号时没有把黑名单抹掉」这类
  // 整体替换语义带来的数据丢失。
  const replacePayloads: Array<Record<string, unknown>> = []
  const mockSettings = {
    register: (_ns: string, _schema: unknown) => ({
      get: () => (options.staleReads ? visible : stored),
      replace: async (value: {
        accounts?: ProviderAccountEntry[]
        disabledModels?: Record<string, Record<string, boolean>>
        loomyPermanentLocked?: boolean
      }) => {
        if (options.staleReads) {
          // 模拟滞后：get() 始终慢一拍，本次写入要等下一次 replace 才可见
          visible = stored
        }
        stored = value
        replaceCalls.push(value.accounts ?? [])
        replacePayloads.push(value as Record<string, unknown>)
      },
    }),
    describe: () => [{ ns: 'jet-hub', value: stored }],
  }
  const mockCredentials = new Map<string, string>()
  return {
    replaceCalls,
    replacePayloads,
    logger: { warn: () => {}, info: () => {} },
    get: (key: string) => key === 'settings' ? mockSettings : undefined,
    credentials: {
      describe: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        return { configured: mockCredentials.has(key), source: 'test' as const, writable: true }
      },
      resolve: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        const value = mockCredentials.get(key)
        return value ? { value, source: 'test' as const } : undefined
      },
      set: async (ref: ReturnType<typeof credentialRef>, value: string) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.set(key, value)
      },
      unset: async (ref: ReturnType<typeof credentialRef>) => {
        const key = typeof ref === 'string' ? ref : String(ref)
        mockCredentials.delete(key)
      },
    },
  }
}

describe('AccountPool', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  /** 每次通过工厂返回新对象，避免测试间 Object.assign 污染共享引用 */
  function makeMockAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'buddy-001',
      provider: 'buddy',
      nickname: 'test-user',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as any)
  })

  it('should add and list accounts', async () => {
    await pool.addAccount(makeMockAccount())
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('buddy-001')
  })

  it('should filter by provider', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const buddyAccounts = await pool.listAccounts('buddy')
    const codeartsAccounts = await pool.listAccounts('codearts')
    expect(buddyAccounts).toHaveLength(1)
    expect(codeartsAccounts).toHaveLength(1)
  })

  it('should update account', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.updateAccount('buddy-001', { enabled: false })
    const list = await pool.listAccounts('buddy')
    expect(list[0].enabled).toBe(false)
  })

  it('should throw on update for non-existent account', async () => {
    await expect(pool.updateAccount('nonexistent', { enabled: false })).rejects.toThrow('Account nonexistent not found')
  })

  it('should remove account and credential', async () => {
    await pool.addAccount(makeMockAccount())
    // 先设一个凭据，确认删除时清理
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.removeAccount('buddy-001')
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(0)
    const resolved = await ctx.credentials.resolve(credentialRef('BUDDY_ACCOUNT_T1'))
    expect(resolved).toBeUndefined()
  })

  it('should return available account for model', async () => {
    // 为两个账号都设置凭据
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test1' }))
    await pool.addAccount(makeMockAccount())
    // 为第二个账号设置模型限流
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T2'), JSON.stringify({ access_token: 'test2' }))
    await pool.addAccount(makeMockAccount({
      id: 'buddy-002',
      credentialRef: 'BUDDY_ACCOUNT_T2',
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).not.toBeNull()
    expect(result!.entry.id).toBe('buddy-001')
  })

  it('should return null when all accounts rate-limited', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), JSON.stringify({ access_token: 'test' }))
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3600000 },
    }))
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when no accounts at all', async () => {
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential resolve fails', async () => {
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should return null when credential JSON parse fails', async () => {
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T1'), 'not-json')
    await pool.addAccount(makeMockAccount())
    const result = await pool.getAvailableAccount('buddy', 'deepseek-v4-flash')
    expect(result).toBeNull()
  })

  it('should update model rate limit', async () => {
    await pool.addAccount(makeMockAccount())
    const resetAt = Date.now() + 7200000
    await pool.updateModelRateLimit('buddy-001', 'deepseek-v4-flash', resetAt)
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBe(resetAt)
  })

  it('should sweep expired rate limits', async () => {
    await pool.addAccount(makeMockAccount({
      modelRateLimits: { 'deepseek-v4-flash': Date.now() - 1000, 'deepseek-v4-pro': Date.now() + 3600000 },
    }))
    await pool.sweepExpiredRateLimits()
    const list = await pool.listAccounts('buddy')
    expect(list[0].modelRateLimits?.['deepseek-v4-flash']).toBeUndefined()
    expect(list[0].modelRateLimits?.['deepseek-v4-pro']).toBeDefined()
  })

  // ── 手动排序（Jet Hub 拖拽）──
  // 顺序即 getAvailableAccount 的候选优先级，故这些用例同时守「持久化」与
  // 「真的影响选号」两件事 —— 只测前者会让拖拽退化成 UI 装饰。
  describe('reorderAccounts', () => {
    /** 建三个同 provider 账号，凭据齐备，便于验证选号结果。 */
    async function seedThree(ids: string[]): Promise<void> {
      for (const id of ids) {
        const ref = `BUDDY_ACCOUNT_${id.toUpperCase()}`
        await ctx.credentials.set(credentialRef(ref), JSON.stringify({ access_token: id }))
        await pool.addAccount(makeMockAccount({ id, credentialRef: ref }))
      }
    }

    it('重排后 listAccounts 顺序随之改变', async () => {
      await seedThree(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      const list = await pool.listAccounts('buddy')
      expect(list.map(a => a.id)).toEqual(['c', 'a', 'b'])
    })

    it('重排真正影响 getAvailableAccount 的选号结果', async () => {
      await seedThree(['a', 'b', 'c'])
      // 默认顺序取第一个
      expect((await pool.getAvailableAccount('buddy', ''))?.entry.id).toBe('a')
      // 把 c 拖到首位后，自动选号应改用 c
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      expect((await pool.getAvailableAccount('buddy', ''))?.entry.id).toBe('c')
    })

    it('手动顺序优先于「限流重置时间更早」的账号', async () => {
      // 这是本次改动的**核心语义**。早期实现按「重置时间最早到期」重排候选，
      // 会让手动顺序形同虚设。
      //
      // ⚠️ 构造要点（前两版都写错了，说明保留于此）：
      // 1. 查询的 modelId 必须**正是**账号带限流标记的那个模型 ——
      //    否则 `ra - rb` 恒为 0，旧排序根本不换位，测试恒通过；
      // 2. 两个账号都必须**已过限流期**（`Date.now() >= resetAt`），
      //    否则会被候选过滤掉，根本进不了排序。
      const past = Date.now() - 10_000
      const pastLater = Date.now() - 5_000
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a', credentialRef: 'BUDDY_ACCOUNT_A',
        // a 的限流重置时间**更晚**（但都已过期）
        modelRateLimits: { 'deepseek-v4-flash': pastLater },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({
        id: 'b', credentialRef: 'BUDDY_ACCOUNT_B',
        // b 更早 → 旧排序会把 b 排到 a 前面
        modelRateLimits: { 'deepseek-v4-flash': past },
      }))

      // 两者限流均已过期 → 都进候选。手动顺序 a→b，故应取 a；
      // 旧排序按重置时间升序会把 b 提到前面。
      expect((await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id).toBe('a')
      await pool.reorderAccounts('buddy', ['b', 'a'])
      expect(
        (await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id,
        '手动顺序未生效：选号仍按限流重置时间重排',
      ).toBe('b')
    })

    it('限流期内的账号被跳过，即使它排在最前（限流豁免）', async () => {
      const limited = Date.now() + 3600000
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_A'), JSON.stringify({ access_token: 'a' }))
      await pool.addAccount(makeMockAccount({
        id: 'a', credentialRef: 'BUDDY_ACCOUNT_A',
        modelRateLimits: { 'deepseek-v4-flash': limited },
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B'), JSON.stringify({ access_token: 'b' }))
      await pool.addAccount(makeMockAccount({ id: 'b', credentialRef: 'BUDDY_ACCOUNT_B' }))

      // a 排首位但对目标模型限流中 → 应跳到 b
      await pool.reorderAccounts('buddy', ['a', 'b'])
      expect((await pool.getAvailableAccount('buddy', 'deepseek-v4-flash'))?.entry.id).toBe('b')
    })

    it('不影响其他 provider 账号的相对位置与下标', async () => {
      // 账号存在一个全局数组里，而设置页按 provider 分组渲染。
      // 拖 CodeArts 不应顺带改动 Buddy 账号的位置。
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B1'), JSON.stringify({ access_token: 'b1' }))
      await pool.addAccount(makeMockAccount({ id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' }))
      await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_C1'), JSON.stringify({ access_key_id: 'c1' }))
      await pool.addAccount(makeMockAccount({
        id: 'c1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1',
      }))
      await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_B2'), JSON.stringify({ access_token: 'b2' }))
      await pool.addAccount(makeMockAccount({ id: 'b2', credentialRef: 'BUDDY_ACCOUNT_B2' }))

      await pool.reorderAccounts('codearts', ['c1'])
      const all = await pool.listAllAccounts()
      // Buddy 两个账号仍在各自原本的下标（0 与 2），未被挪动
      expect(all.map(a => a.id)).toEqual(['b1', 'c1', 'b2'])
    })

    it('id 集合不一致时抛错且不改动数据（前端列表过期）', async () => {
      await seedThree(['a', 'b', 'c'])
      // 少一个
      await expect(pool.reorderAccounts('buddy', ['a', 'b'])).rejects.toThrow()
      // 多一个未知 id
      await expect(pool.reorderAccounts('buddy', ['a', 'b', 'c', 'zzz'])).rejects.toThrow()
      // 重复 id
      await expect(pool.reorderAccounts('buddy', ['a', 'a', 'b'])).rejects.toThrow()
      // 数据未被破坏
      const list = await pool.listAccounts('buddy')
      expect(list.map(a => a.id)).toEqual(['a', 'b', 'c'])
    })

    it('重排只写账号字段，不抹掉模型黑名单', async () => {
      // writeAccounts 是整体 replace，漏带 disabledModels 会把它清空。
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await seedThree(['a', 'b', 'c'])
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    })
  })


  it('should list all accounts', async () => {
    await pool.addAccount(makeMockAccount())
    await pool.addAccount(makeMockAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))
    const all = await pool.listAllAccounts()
    expect(all).toHaveLength(2)
  })

  // ── 停用账号绝不参与自动选择 ──
  // `getAvailableAccount` 是 provider 的凭据入口。停用只意味着"不自动参与
  // 轮换"，因此任何情况下都不能返回停用账号——包括 modelId 为空串时
  //（此时无法做限流过滤，最容易误把停用账号当成候选）。
  describe('停用账号不参与自动选择', () => {
    it('modelId 为空串时也不返回停用账号', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on', provider: 'codearts', enabled: true, credentialRef: 'CA_ON',
      }))

      const result = await pool.getAvailableAccount('codearts', '')
      expect(result).not.toBeNull()
      expect(result!.entry.id).toBe('codearts-on')
    })

    it('仅剩停用账号时返回 null（空 modelId 同样如此）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })

    it('空 modelId 会跳过限流过滤，但启用账号仍被返回', async () => {
      // 空 modelId 的语义：调用方还不知道目标模型，只能退化为"任取一个
      // 启用账号"。此处记录该既有行为，避免日后被误改成"一并过滤"。
      await ctx.credentials.set(credentialRef('CA_ON'), JSON.stringify({ access_key_id: 'on' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-on',
        provider: 'codearts',
        enabled: true,
        credentialRef: 'CA_ON',
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 3_600_000 },
      }))

      expect((await pool.getAvailableAccount('codearts', ''))?.entry.id).toBe('codearts-on')
      expect(await pool.getAvailableAccount('codearts', 'deepseek-v4-flash')).toBeNull()
    })
  })

  // ── 限流标记清除（重测/重置的底层能力）──
  describe('clearModelRateLimits', () => {
    it('清空后删除 modelRateLimits 字段本身，不留空对象', async () => {
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'deepseek-v4-flash': Date.now() + 1000 },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001')
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toBeUndefined()
    })

    it('只清除指定的模型，其余保留', async () => {
      const keep = Date.now() + 3_600_000
      await pool.addAccount(makeMockAccount({
        modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': keep },
      }))
      const removed = await pool.clearModelRateLimits('buddy-001', ['model-a'])
      expect(removed).toBe(1)
      expect((await pool.listAccounts('buddy'))[0].modelRateLimits).toEqual({ 'model-b': keep })
    })

    it('对无标记的账号返回 0 且不写盘', async () => {
      await pool.addAccount(makeMockAccount())
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(0)
    })

    it('对不存在的账号返回 0', async () => {
      expect(await pool.clearModelRateLimits('nonexistent')).toBe(0)
    })
  })

  describe('resolveCredentialForAccount（含停用账号）', () => {
    it('停用账号凭据仍可按 id 解析（重测需要）', async () => {
      await ctx.credentials.set(credentialRef('CA_OFF'), JSON.stringify({ access_key_id: 'off' }))
      await pool.addAccount(makeMockAccount({
        id: 'codearts-off', provider: 'codearts', enabled: false, credentialRef: 'CA_OFF',
      }))

      const credential = await pool.resolveCredentialForAccount('codearts-off')
      expect(credential).toMatchObject({ access_key_id: 'off' })
      // 但自动选择必须仍然排除它
      expect(await pool.getAvailableAccount('codearts', '')).toBeNull()
    })

    it('账号不存在或凭据不可用时返回 undefined', async () => {
      expect(await pool.resolveCredentialForAccount('missing')).toBeUndefined()
      await pool.addAccount(makeMockAccount())  // 未设置凭据
      expect(await pool.resolveCredentialForAccount('buddy-001')).toBeUndefined()
    })
  })

  it('listAccountsByProvider 含停用账号', async () => {
    await pool.addAccount(makeMockAccount({ id: 'on', enabled: true }))
    await pool.addAccount(makeMockAccount({ id: 'off', enabled: false, credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await pool.addAccount(makeMockAccount({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_C1' }))

    expect(pool.listAccountsByProvider('buddy').map(a => a.id).sort()).toEqual(['off', 'on'])
    expect(pool.findAccount('off')?.enabled).toBe(false)
  })

  it('should handle removeAccount of non-existent account gracefully', async () => {
    await pool.removeAccount('nonexistent')
    const list = await pool.listAllAccounts()
    expect(list).toHaveLength(0)
  })

  it('should handle updateModelRateLimit for non-existent account gracefully', async () => {
    await pool.updateModelRateLimit('nonexistent', 'deepseek-v4-flash', Date.now() + 3600000)
    // 不会抛出
  })

  /**
   * 回归：settings scope 的 get() 滞后于 replace() 时，连续记录多个账号的
   * 限流不能互相覆盖。
   *
   * 曾经的实现每次都以 scope.get() 为读源，若快照滞后，第二次写入会基于
   * 不含第一次记录的旧快照整体 replace，把前一条限流抹掉——表现为
   * "多个账号都触发过限流，settings.yaml 里却一条 modelRateLimits 都没有"。
   */
  it('keeps earlier rate limits when recording several accounts under a stale scope', async () => {
    const staleCtx = createMockContext([], { staleReads: true })
    const stalePool = new AccountPool(staleCtx as never)

    await stalePool.addAccount(makeMockAccount({ id: 'acct-1', credentialRef: 'BUDDY_ACCOUNT_T1' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-2', credentialRef: 'BUDDY_ACCOUNT_T2' }))
    await stalePool.addAccount(makeMockAccount({ id: 'acct-3', credentialRef: 'BUDDY_ACCOUNT_T3' }))

    const t1 = Date.now() + 3_600_000
    const t2 = Date.now() + 7_200_000
    const t3 = Date.now() + 10_800_000
    await stalePool.updateModelRateLimit('acct-1', 'deepseek-v4.1-flash', t1)
    await stalePool.updateModelRateLimit('acct-2', 'deepseek-v4.1-flash', t2)
    await stalePool.updateModelRateLimit('acct-3', 'deepseek-v4.1-flash', t3)

    const list = await stalePool.listAllAccounts()
    const limits = list.map(a => a.modelRateLimits?.['deepseek-v4.1-flash'])
    // 三条记录都必须留存（fix 前这里会是 [undefined, undefined, t3] 或类似）
    expect(limits).toEqual([t1, t2, t3])
  })

  describe('getStateSnapshot / replaceAll（备份导入用）', () => {
    it('getStateSnapshot 返回账号与黑名单副本（与进程内解耦）', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      const snapshot = pool.getStateSnapshot()
      expect(snapshot.accounts.map(a => a.id)).toEqual(['buddy-001'])
      expect(snapshot.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
      // 修改快照不应污染进程内权威副本
      snapshot.accounts.push(makeMockAccount({ id: 'buddy-002' }))
      snapshot.disabledModels.buddy!['glm-5.3'] = true
      expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['buddy-001'])
      expect(pool.disabledModelsFor('buddy').has('glm-5.3')).toBe(false)
    })

    it('replaceAll 整体替换账号与黑名单', async () => {
      await pool.addAccount(makeMockAccount())
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      const incoming = [
        makeMockAccount({ id: 'codearts-9', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_9' }),
      ]
      await pool.replaceAll(incoming, { trae: { 'qwen3.8-flash': true } })
      // 旧账号与旧黑名单被整体清掉
      expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['codearts-9'])
      expect(pool.disabledModelsFor('buddy').size).toBe(0)
      expect(pool.disabledModelsFor('trae').has('qwen3.8-flash')).toBe(true)
    })

    it('replaceAll 归一化坏条目（丢弃缺 id/provider/credentialRef 的账号）', async () => {
      await pool.addAccount(makeMockAccount())
      // 手工编辑的备份可能带残缺条目：缺 credentialRef 的应被丢弃
      const incoming = [
        makeMockAccount(),
        { id: 'broken', provider: 'buddy' } as ProviderAccountEntry,
      ]
      await pool.replaceAll(incoming, {})
      const list = await pool.listAllAccounts()
      expect(list.map(a => a.id)).toEqual(['buddy-001'])
    })
  })
})

describe('findAccountIdByCredential 的 provider 字段选择', () => {
  it('workbuddy 按 access_token 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T1'), JSON.stringify({
      access_token: 'WB-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-1', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T1', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-1')
  })

  it('workbuddy 不会误用 access_key_id 匹配', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_T2'), JSON.stringify({
      access_token: 'WB-TOKEN', access_key_id: 'SOMETHING-ELSE', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'workbuddy-2', provider: 'workbuddy', nickname: 'WB', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_T2', createdAt: Date.now(), refreshable: true,
    })
    // 传入 access_token 值应命中
    expect(await pool.findAccountIdByCredential('workbuddy', 'WB-TOKEN')).toBe('workbuddy-2')
    // 传入 access_key_id 值不应命中（说明用的确实是 access_token 字段）
    expect(await pool.findAccountIdByCredential('workbuddy', 'SOMETHING-ELSE')).toBe('')
  })

  it('codearts 仍按 access_key_id 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_T3'), JSON.stringify({
      access_key_id: 'AK-1', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-12-31T00:00:00Z',
    }))
    await pool.addAccount({
      id: 'codearts-1', provider: 'codearts', nickname: 'CA', enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_T3', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('codearts', 'AK-1')).toBe('codearts-1')
  })

  it('buddy 仍按 access_token 匹配（既有行为不回归）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_T4'), JSON.stringify({
      access_token: 'BD-TOKEN', refresh_token: 'RT', expires_at: String(Date.now() + 3_600_000),
    }))
    await pool.addAccount({
      id: 'buddy-4', provider: 'buddy', nickname: 'BD', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_T4', createdAt: Date.now(), refreshable: true,
    })
    expect(await pool.findAccountIdByCredential('buddy', 'BD-TOKEN')).toBe('buddy-4')
  })
})

describe('pruneAccountsWithForeignDomain', () => {
  /** WorkBuddy 国际版的判定目标：域名是 www.workbuddy.ai */
  const product = { id: 'workbuddy', apiDomain: 'www.workbuddy.ai' } as never

  it('删除 domain 指向旧端点（中国版）的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_OLD'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'workbuddy-old', provider: 'workbuddy', nickname: '旧', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_OLD', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual(['workbuddy-old'])
    expect(await pool.listAllAccounts()).toHaveLength(0)
  })

  it('保留 domain 与新端点一致的 WorkBuddy 账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NEW'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'www.workbuddy.ai',
    }))
    await pool.addAccount({
      id: 'workbuddy-new', provider: 'workbuddy', nickname: '新', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NEW', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('不触碰其他 provider 的账号', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    // CodeBuddy 账号的 domain 也是 copilot.tencent.com，但不该被 WorkBuddy 的清理波及
    await ctx.credentials.set(credentialRef('BUDDY_ACCOUNT_KEEP'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: 'copilot.tencent.com',
    }))
    await pool.addAccount({
      id: 'buddy-keep', provider: 'buddy', nickname: 'CB', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_KEEP', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('domain 为空的历史凭据保守保留（无法判定）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_NODOMAIN'), JSON.stringify({
      access_token: 'AT', refresh_token: 'RT',
      expires_at: String(Date.now() + 3_600_000),
      domain: '',
    }))
    await pool.addAccount({
      id: 'workbuddy-nodomain', provider: 'workbuddy', nickname: '?', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_NODOMAIN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据缺失时不删除（交给正常的「凭据未配置」报错路径）', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'workbuddy-nocred', provider: 'workbuddy', nickname: '无', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_MISSING', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('凭据 JSON 损坏时不删除且不抛异常', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await ctx.credentials.set(credentialRef('WORKBUDDY_ACCOUNT_BROKEN'), '{not json')
    await pool.addAccount({
      id: 'workbuddy-broken', provider: 'workbuddy', nickname: '坏', enabled: true,
      credentialRef: 'WORKBUDDY_ACCOUNT_BROKEN', createdAt: Date.now(), refreshable: true,
    })

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed).toEqual([])
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  it('混合场景：只删失配的，保留其余', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    for (const [ref, domain] of [
      ['WORKBUDDY_ACCOUNT_A', 'copilot.tencent.com'],
      ['WORKBUDDY_ACCOUNT_B', 'www.workbuddy.ai'],
      ['WORKBUDDY_ACCOUNT_C', 'copilot.tencent.com'],
    ] as const) {
      await ctx.credentials.set(credentialRef(ref), JSON.stringify({
        access_token: 'AT', refresh_token: 'RT',
        expires_at: String(Date.now() + 3_600_000), domain,
      }))
      await pool.addAccount({
        id: ref.toLowerCase(), provider: 'workbuddy', nickname: ref, enabled: true,
        credentialRef: ref, createdAt: Date.now(), refreshable: true,
      })
    }

    const removed = await pool.pruneAccountsWithForeignDomain(product)

    expect(removed.sort()).toEqual(['workbuddy_account_a', 'workbuddy_account_c'])
    const left = await pool.listAllAccounts()
    expect(left).toHaveLength(1)
    expect(left[0]!.id).toBe('workbuddy_account_b')
  })
})

/**
 * 模型黑名单（Jet Hub 的「显示列表」开关）。
 *
 * 语义核心是**黑名单制**：只有被显式关闭的模型会隐藏，未记录的模型
 * 一律默认打开。这保证服务端新增模型时不需要任何配置就能出现在选择器里
 * —— 白名单制会把新模型静默挡在门外，是这套开关最容易踩的坑。
 */
describe('AccountPool 模型黑名单', () => {
  it('未配置时没有任何模型被关闭（默认全开）', () => {
    const pool = new AccountPool(createMockContext() as never)
    expect(pool.disabledModelsFor('buddy').size).toBe(0)
    expect(pool.listDisabledModels('buddy')).toEqual({})
  })

  it('关闭模型后该模型进入黑名单，其余模型不受影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)

    const disabled = pool.disabledModelsFor('buddy')
    expect(disabled.has('glm-5.2')).toBe(true)
    // 没被关掉的模型默认打开 —— 黑名单制的关键断言
    expect(disabled.has('deepseek-v4-flash')).toBe(false)
    expect(disabled.has('hy3')).toBe(false)
  })

  it('重新打开时删除条目，而不是写入 false', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('buddy', 'glm-5.2', false)

    expect(pool.disabledModelsFor('buddy').size).toBe(0)
    // 打开后 provider 表变空，应当整体从配置里消失（不留 { buddy: {} } 噪音）
    const last = ctx.replacePayloads.at(-1)!
    expect(last.disabledModels).toEqual({})
  })

  it('不同 provider 的黑名单互不影响', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('workbuddy', 'gpt-5.4', true)

    expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    expect([...pool.disabledModelsFor('workbuddy')]).toEqual(['gpt-5.4'])
    expect(pool.disabledModelsFor('codearts').size).toBe(0)
  })

  it('关闭多个模型后全部保留', async () => {
    const pool = new AccountPool(createMockContext() as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.setModelDisabled('buddy', 'hy3', true)
    await pool.setModelDisabled('buddy', 'kimi-k2.6', true)

    expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6'])
  })

  /**
   * 批量开关（Jet Hub 模型列表的「打开全部 / 关闭全部」）。
   *
   * 两个方向的语义**刻意不对称**，这是需求明确规定的：
   * - 关闭全部（`setModelsDisabled`）：按**当前列表**逐项写入黑名单；
   * - 打开全部（`clearDisabledModels`）：直接**删除该 provider 的全部关闭项**，
   *   不需要模型目录。
   *
   * 拆成两个方法而不是「一个带 disabled 布尔的方法」的理由：两者需要的入参本就
   * 不同（关闭要 id 列表、打开不要），合并只会让调用方传一个打开时被忽略的参数。
   * 不对称还有实质好处：打开全部若也按列表走，那些「曾被关闭、后来从服务端目录
   * 里下线」的历史遗留键永远清不掉 —— 黑名单会积累死键，且残留键将来若被同名
   * 模型复用会莫名隐藏它。
   */
  describe('批量开关（打开全部 / 关闭全部）', () => {
    it('关闭全部：把给定 id 全部写入黑名单', async () => {
      const pool = new AccountPool(createMockContext() as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3', 'kimi-k2.6'])

      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6'])
    })

    it('关闭全部只写一次（不逐条落盘）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3', 'kimi-k2.6'])

      // 逐条写会产生 3 次 replace；批量必须只写一次，否则 30 个模型就是
      // 30 次整体重写 + 30 次目录广播。
      expect(ctx.replacePayloads).toHaveLength(1)
      expect(ctx.replacePayloads[0]!.disabledModels).toEqual({
        buddy: { 'glm-5.2': true, hy3: true, 'kimi-k2.6': true },
      })
    })

    it('关闭全部保留该 provider 原有的其它关闭项', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'old-model': true } },
      }) as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2'])

      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['glm-5.2', 'old-model'])
    })

    it('打开全部：清空该 provider 的全部关闭项', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true, hy3: true } },
      }) as never)
      await pool.clearDisabledModels('buddy')

      expect(pool.disabledModelsFor('buddy').size).toBe(0)
    })

    /**
     * 打开全部**不看模型目录**：目录里已下线的历史遗留键同样要清掉。
     *
     * 若按当前目录删除，`gone-model` 这类「曾被关闭、如今已不在目录里」的键会
     * 永远留在黑名单中，用户点「打开全部」却仍有残留。
     */
    it('打开全部：清掉不在当前目录里的历史遗留键', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true, 'gone-model': true } },
      }) as never)
      await pool.clearDisabledModels('buddy')

      expect(pool.listDisabledModels('buddy')).toEqual({})
    })

    it('打开全部后 provider 表整体消失（不留 { buddy: {} } 噪音）', async () => {
      const ctx = createMockContext([], {
        initialDisabledModels: { buddy: { 'glm-5.2': true } },
      })
      const pool = new AccountPool(ctx as never)
      await pool.clearDisabledModels('buddy')

      expect(ctx.replacePayloads.at(-1)!.disabledModels).toEqual({})
    })

    it('批量操作不影响其它 provider 的黑名单', async () => {
      const pool = new AccountPool(createMockContext([], {
        initialDisabledModels: { workbuddy: { 'gpt-5.4': true } },
      }) as never)
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3'])
      await pool.clearDisabledModels('buddy')

      expect(pool.disabledModelsFor('buddy').size).toBe(0)
      expect([...pool.disabledModelsFor('workbuddy')]).toEqual(['gpt-5.4'])
    })

    it('批量写黑名单不会抹掉账号列表（整体写入语义）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.addAccount({
        id: 'buddy-bulk', provider: 'buddy', nickname: 'B', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_BULK', createdAt: Date.now(), refreshable: true,
      })
      await pool.setModelsDisabled('buddy', ['glm-5.2', 'hy3'])

      expect(ctx.replacePayloads.at(-1)!.accounts).toHaveLength(1)
      expect(await pool.listAllAccounts()).toHaveLength(1)
    })

    it('关闭全部传空列表时不写盘（没有变更就不该惊动落盘）', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setModelsDisabled('buddy', [])

      expect(ctx.replacePayloads).toHaveLength(0)
    })

    it('打开全部在本就为空时不写盘', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.clearDisabledModels('buddy')

      expect(ctx.replacePayloads).toHaveLength(0)
    })
  })

  it('从已有配置载入黑名单', () => {
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: { buddy: { 'glm-5.2': true } },
    }) as never)
    const disabled = pool.disabledModelsFor('buddy')
    expect(disabled.has('glm-5.2')).toBe(true)
    expect(disabled.size).toBe(1)
  })

  /**
   * 回归：settings 的 replace() 是**整体替换**。写账号列表时若不带上
   * disabledModels，用户刚设置的模型开关会被下一次账号操作（新增/删除/
   * 限流标记）静默清空。
   */
  it('写账号列表时不会抹掉已有的黑名单', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    await pool.addAccount({
      id: 'buddy-x', provider: 'buddy', nickname: 'X', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_X', createdAt: Date.now(), refreshable: true,
    })

    expect(ctx.replacePayloads.at(-1)!.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    expect(pool.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

  /** 反向回归：写黑名单时若丢掉账号列表，账号池会被清空。 */
  it('写黑名单时不会抹掉账号列表', async () => {
    const ctx = createMockContext()
    const pool = new AccountPool(ctx as never)
    await pool.addAccount({
      id: 'buddy-y', provider: 'buddy', nickname: 'Y', enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_Y', createdAt: Date.now(), refreshable: true,
    })
    await pool.setModelDisabled('buddy', 'glm-5.2', true)

    expect(ctx.replacePayloads.at(-1)!.accounts).toHaveLength(1)
    expect(await pool.listAllAccounts()).toHaveLength(1)
  })

  /**
   * ⚠️ **Loomy 永久积分锁定**（用户要求「需要支持持久化」）。
   *
   * 这是**第三个**整体写入的字段，与 `disabledModels` 当年踩过的坑同型：
   * 任何一处写入漏带它，就会被静默抹掉（用户看到「锁自己解开了」）。
   */
  describe('Loomy 永久积分锁定', () => {
    it('默认解锁（未设置时为 false）', () => {
      const pool = new AccountPool(createMockContext() as never)
      expect(pool.loomyPermanentLocked()).toBe(false)
    })

    it('设置后可读回，并落盘到 replace 载荷', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setLoomyPermanentLocked(true)

      expect(pool.loomyPermanentLocked()).toBe(true)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
    })

    it('可再解锁', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setLoomyPermanentLocked(true)
      await pool.setLoomyPermanentLocked(false)
      expect(pool.loomyPermanentLocked()).toBe(false)
      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(false)
    })

    /** ⚠️ 新增账号不得抹掉锁定（与黑名单那次同型缺陷）。 */
    it('新增账号不会抹掉锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setLoomyPermanentLocked(true)
      await pool.addAccount({
        id: 'loomy-x', provider: 'loomy', nickname: 'X', enabled: true,
        credentialRef: 'LOOMY_ACCOUNT_X', createdAt: Date.now(), refreshable: false,
      })

      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
      expect(pool.loomyPermanentLocked()).toBe(true)
    })

    /** ⚠️ 改模型黑名单不得抹掉锁定。 */
    it('写黑名单不会抹掉锁定', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.setLoomyPermanentLocked(true)
      await pool.setModelDisabled('loomy', 'spark-x', true)

      expect(ctx.replacePayloads.at(-1)!.loomyPermanentLocked).toBe(true)
      expect(pool.loomyPermanentLocked()).toBe(true)
    })

    /** ⚠️ 反向：写锁定不得抹掉账号与黑名单。 */
    it('写锁定不会抹掉账号列表与黑名单', async () => {
      const ctx = createMockContext()
      const pool = new AccountPool(ctx as never)
      await pool.addAccount({
        id: 'buddy-z', provider: 'buddy', nickname: 'Z', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_Z', createdAt: Date.now(), refreshable: true,
      })
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await pool.setLoomyPermanentLocked(true)

      const last = ctx.replacePayloads.at(-1)!
      expect(last.accounts).toHaveLength(1)
      expect(last.disabledModels).toEqual({ buddy: { 'glm-5.2': true } })
    })

    it('跨实例读回（模拟重启）', async () => {
      const ctx1 = createMockContext()
      await new AccountPool(ctx1 as never).setLoomyPermanentLocked(true)
      // 用第一实例落盘的载荷作为「新进程」的初始状态
      const persisted = ctx1.replacePayloads.at(-1) as { loomyPermanentLocked?: boolean }

      const ctx2 = createMockContext([], {
        initialLoomyPermanentLocked: persisted.loomyPermanentLocked,
      })
      expect(new AccountPool(ctx2 as never).loomyPermanentLocked()).toBe(true)
    })

    it('初始状态为已锁定时可读回（模拟重启后首次载入）', () => {
      const pool = new AccountPool(createMockContext([], {
        initialLoomyPermanentLocked: true,
      }) as never)
      expect(pool.loomyPermanentLocked()).toBe(true)
    })
  })

  it('配置文件里的脏数据被忽略而不是抛错', () => {
    // 模拟手工编辑过的/老版本的配置文件：数组、字符串、false 都应被丢弃
    const pool = new AccountPool(createMockContext([], {
      initialDisabledModels: {
        buddy: { 'glm-5.2': true, 'hy3': false, 'bad': 'yes' } as never,
        broken: ['glm-5.2'] as never,
      },
    }) as never)

    // 只有显式 true 的条目生效
    expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    // 结构非法的 provider 整层丢弃
    expect(pool.disabledModelsFor('broken').size).toBe(0)
  })

  it('无 settings scope 时降级为内存态，不抛错', async () => {
    const pool = new AccountPool({ get: () => undefined, logger: { warn: () => {}, info: () => {} } } as never)
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    expect(pool.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

})

/**
 * Gitee issue IKI7WT 的回归：DSH 0.1.7-rc.1 把 `ctx.settings` 换成
 * `SettingsForms`（**没有 `register`**，命名空间只能是 profile 条目 id）。
 * 旧实现因此把账号列表与模型黑名单退化成纯内存 —— 重启即丢。
 * 这里锁死「settings 无 register 时仍要落盘并跨实例存活」。
 */
describe('AccountPool · 0.1.7 契约（settings 无 register）', () => {
  let stateDir: string
  let previousDir: string | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'account-pool-017-'))
    previousDir = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = stateDir
  })

  afterEach(() => {
    if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = previousDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  /** 0.1.7 的 SettingsForms 形状：有 describe/configure，但没有 register。 */
  function make017Context() {
    return {
      get: (key: string) => key === 'settings'
        ? { describe: () => [], configure: () => () => {} }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: true, writable: true, source: 'test' as const }),
      },
    }
  }

  it('账号列表与黑名单跨实例存活（本 issue 的核心断言）', async () => {
    const first = new AccountPool(make017Context() as never)
    await first.addAccount({
      id: 'buddy-01700001',
      provider: 'buddy',
      nickname: '0.1.7 用例',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_01700001',
      createdAt: Date.now(),
      refreshable: true,
    })
    await first.setModelDisabled('buddy', 'glm-5.2', true)

    // 新实例 = 模拟重启：必须从磁盘读回，而不是空列表。
    const second = new AccountPool(make017Context() as never)
    expect((await second.listAccounts('buddy')).map(a => a.id)).toEqual(['buddy-01700001'])
    expect(second.disabledModelsFor('buddy').has('glm-5.2')).toBe(true)
  })

  it('写黑名单时不会抹掉账号列表（整体写入语义）', async () => {
    const pool = new AccountPool(make017Context() as never)
    await pool.addAccount({
      id: 'buddy-01700002',
      provider: 'buddy',
      nickname: 'x',
      enabled: true,
      credentialRef: 'BUDDY_ACCOUNT_01700002',
      createdAt: Date.now(),
      refreshable: true,
    })
    await pool.setModelDisabled('buddy', 'hy3', true)

    const reloaded = new AccountPool(make017Context() as never)
    expect((await reloaded.listAccounts('buddy')).map(a => a.id)).toEqual(['buddy-01700002'])
    expect(reloaded.disabledModelsFor('buddy').has('hy3')).toBe(true)
  })
})

describe('AccountPool · TRAE 签到设备轮换代次', () => {
  let ctx: ReturnType<typeof createMockContext>
  let pool: AccountPool

  function makeTraeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'trae-1',
      provider: 'trae',
      nickname: 'trae-user',
      enabled: true,
      credentialRef: 'TRAE_ACCOUNT_T1',
      createdAt: Date.now(),
      refreshable: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    ctx = createMockContext()
    pool = new AccountPool(ctx as never)
  })

  it('默认代次为 0（既有账号行为不变）', async () => {
    await pool.addAccount(makeTraeAccount())
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(0)
  })

  it('写入后读回新代次', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 3)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(3)
  })

  it('只接受更大的代次（防止乱序回调把代次写回小值）', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 5)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 2)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(5)
  })

  it('非法代次（0 / 负数 / NaN）被忽略', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 0)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', -1)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', Number.NaN)
    expect(pool.traeCheckinDeviceGenerationFor('trae-1')).toBe(0)
  })

  it('账号不存在时不抛错', async () => {
    await expect(pool.updateTraeCheckinDeviceGeneration('nope', 1)).resolves.toBeUndefined()
    expect(pool.traeCheckinDeviceGenerationFor('nope')).toBe(0)
  })

  it('不破坏同一账号条目的其它字段（modelRateLimits 等）', async () => {
    await pool.addAccount(makeTraeAccount())
    await pool.updateModelRateLimit('trae-1', 'glm-5.2', Date.now() + 60_000)
    await pool.updateTraeCheckinDeviceGeneration('trae-1', 2)

    const entry = (await pool.listAccounts('trae')).find(a => a.id === 'trae-1')!
    expect(entry.traeCheckinDeviceGeneration).toBe(2)
    expect(entry.modelRateLimits?.['glm-5.2']).toBeGreaterThan(0)
  })

  /**
   * `hasLoggedInAccount` —— 「没有已登录账号就不显示该 provider 的模型」的判据。
   *
   * 必须由这个测试锁死三条语义（都容易被改错）：
   * 1. 判据是**凭据能否解析**，不是「有没有条目」（`logout()` 只清凭据、留条目）；
   * 2. **不看 `enabled`**（停用只影响自动选号，与是否已登录无关）；
   * 3. CodeArts 的**单凭据 ref** 必须能作为额外判据传入。
   */
  describe('hasLoggedInAccount（模型目录门控判据）', () => {
    it('没有账号条目时返回 false', async () => {
      expect(await pool.hasLoggedInAccount('trae')).toBe(false)
    })

    it('有账号且凭据可解析时返回 true', async () => {
      await pool.addAccount(makeTraeAccount())
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('⚠️ 有条目但凭据读不到（已登出）时返回 false', async () => {
      // `Auth.logout()` 只 unset 凭据、**保留账号条目**，故不能只看「有条目」，
      // 否则用户登出后模型仍然显示，门控形同虚设。
      await pool.addAccount(makeTraeAccount())
      // 故意不写凭据（等价于 logout 之后的状态）
      expect(await pool.hasLoggedInAccount('trae')).toBe(false)
    })

    it('⚠️ 账号被停用（enabled=false）但凭据仍在时**仍返回 true**', async () => {
      // 停用只影响「自动选号」，不代表「未登录」。若这里返回 false，
      // 把所有账号停用的用户会发现整个 provider 的模型凭空消失 ——
      // 与「续期只看 refreshable、不看 enabled」是同一条既有约定。
      await pool.addAccount(makeTraeAccount({ enabled: false }))
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('只统计本 provider 的账号（不串号）', async () => {
      await pool.addAccount(makeTraeAccount())
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_T1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
      expect(await pool.hasLoggedInAccount('lobsterai')).toBe(false)
    })

    it('多账号时任一凭据可用即为 true', async () => {
      await pool.addAccount(makeTraeAccount())
      await pool.addAccount(makeTraeAccount({ id: 'trae-2', credentialRef: 'TRAE_ACCOUNT_2' }))
      // 只有第二个账号的凭据可用
      await ctx.credentials.set(credentialRef('TRAE_ACCOUNT_2'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('trae')).toBe(true)
    })

    it('⚠️ 只认账号池条目，不再有「单凭据 ref」例外', async () => {
      // CodeArts 早期的单凭据模式（固定 ref `CODEARTS_ACCESS_TOKEN`）已移除：
      // 即便该 ref 下有凭据，账号池为空时也应返回 false —— 六个 provider 判据一致。
      await ctx.credentials.set(credentialRef('CODEARTS_ACCESS_TOKEN'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('codearts')).toBe(false)
      // 在账号池里登记后才是「已登录」。
      await pool.addAccount({
        id: 'codearts-1',
        provider: 'codearts',
        nickname: 'ca',
        enabled: true,
        credentialRef: 'CODEARTS_ACCOUNT_1',
        createdAt: Date.now(),
        refreshable: true,
      })
      await ctx.credentials.set(credentialRef('CODEARTS_ACCOUNT_1'), '{"access_token":"AT"}')
      expect(await pool.hasLoggedInAccount('codearts')).toBe(true)
    })
  })
})
