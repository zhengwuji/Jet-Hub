import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../../src/index.js'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { WORKBUDDY } from '../../src/product.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
  runOAuthFlow: vi.fn(),
}))

// Buddy 登录会真实发起轮询网络请求：插件层测试只关心命令/路由注册，故 mock 整个流程。
// RefreshTokenExpiredError 必须保留真实实现：buddy-auth 的 RefreshScheduler
// onError 回调以 `error instanceof RefreshTokenExpiredError` 判定续期是否
// 彻底失效；mock 缺少该导出会让判定路径抛出 unhandled rejection。
vi.mock('../../src/buddy-oauth.js', async (importOriginal) => ({
  ...await importOriginal(),
  runBuddyLoginFlow: vi.fn(),
}))

const mockedRunLoginFlow = vi.mocked(runLoginFlow)
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)
const mockedRunBuddyLoginFlow = vi.mocked(runBuddyLoginFlow)

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

class FakeCommands {
  readonly definitions: CommandDefinition[] = []
  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

class FakeLlm {
  readonly providers: string[] = []
  readonly adapters: string[] = []
  /** `registerConfigurableProviders` 的入参明细，供目录项（displayName/settingsNs）断言使用。 */
  readonly configurableProviders: Array<{ provider: string; displayName?: string; settingsNs?: string }> = []
  /** `registerAdapter` 注册的路由名，供 provider 路由断言使用。 */
  readonly registeredProviders: string[] = []
  registerConfigurableProviders(
    entries: Array<{ provider: string; displayName?: string; settingsNs?: string }>,
  ): { replace: (next: Array<{ provider: string; displayName?: string; settingsNs?: string }>) => void } {
    this.providers.length = 0
    this.configurableProviders.length = 0
    for (const entry of entries) {
      this.providers.push(entry.provider)
      this.configurableProviders.push(entry)
    }
    return {
      replace: (next) => {
        this.providers.length = 0
        this.configurableProviders.length = 0
        for (const entry of next) {
          this.providers.push(entry.provider)
          this.configurableProviders.push(entry)
        }
      },
    }
  }
  registerAdapter(providers: string[], _adapter: unknown): { replace: () => void } {
    this.adapters.push(...providers)
    this.registeredProviders.push(...providers)
    return { replace: () => {} }
  }
}

/**
 * settings 服务的替身。
 *
 * `registerProviderSettings` 会注册 provider 配置 namespace 并回读 `describe()`
 * 自检，因此替身必须同时实现 `register` 与 `describe`，否则自检日志会走
 * “describe 失败”分支，无法反映真实的 namespace 注册结果。
 */
class FakeSettings {
  readonly registeredNamespaces: string[] = []
  register(ns: string, _schema: unknown): void {
    if (!this.registeredNamespaces.includes(ns)) this.registeredNamespaces.push(ns)
  }
  describe(): Array<{ ns: string }> {
    return this.registeredNamespaces.map((ns) => ({ ns }))
  }
}

function makeContext(): { ctx: Context; commands: FakeCommands; llm: FakeLlm; settings: FakeSettings } {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  const commands = new FakeCommands()
  ctx.provide('commands', commands as never)
  const llm = new FakeLlm()
  ctx.provide('llm', llm as never)
  const settings = new FakeSettings()
  ctx.provide('settings', settings as never)
  return { ctx, commands, llm, settings }
}

/**
 * WorkBuddy 测试所用的 mock 上下文。
 *
 * 返回真实的 `Context`（`apply()` 需要它），替身通过 `ctx.provide` 注入，
 * 测试里可直接以 `ctx.llm` / `ctx.settings` 取回并断言。
 */
function createMockContext(): Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings } {
  const m = makeContext()
  const proxy = new Proxy(m.ctx, {
    get(target, prop, receiver) {
      if (prop === 'llm') return m.llm
      if (prop === 'commands') return m.commands
      if (prop === 'settings') return m.settings
      return Reflect.get(target, prop, receiver)
    },
  })
  return proxy as Context & { llm: FakeLlm; commands: FakeCommands; settings: FakeSettings }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('plugin entry', () => {
  it('registers the codeartsAuth service and the codearts-login command', () => {
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(commands.definitions.map((d) => d.name)).toContain('codearts-login')
  })

  it('command handler reports success with ref and expiry', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text?: string }).text).toContain('CODEARTS_ACCESS_TOKEN')
  })

  it('command handler reports a failure as an error result', async () => {
    mockedRunOAuthFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx, commands } = makeContext()
    apply(ctx)
    const login = commands.definitions.find((d) => d.name === 'codearts-login')!
    const result = await login.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'CodeArts login timed out' })
  })

  it('registers the codearts LLM route and the status/refresh commands', () => {
    const { ctx, commands, llm } = makeContext()
    apply(ctx)
    // 无账号时模型设置列表不显示，但 adapter 路由已就绪
    expect(llm.providers).not.toContain('codearts')
    expect(llm.adapters).toContain('codearts')
    const names = commands.definitions.map((d) => d.name)
    expect(names).toContain('codearts-status')
    expect(names).toContain('codearts-refresh')
  })

  it('codearts-status reports refreshability', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'cred', expires: 1234, loginUrl: 'https://login' })
    const { ctx, commands } = makeContext()
    apply(ctx)
    const status = commands.definitions.find((d) => d.name === 'codearts-status')!
    const result = await status.handler({
      commandId: 'cid' as never,
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
  })

  it('stops the refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.codeartsAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

describe('buddy plugin entry', () => {
  it('registers the buddyAuth service without slash commands', () => {
    // 登录/状态/续期都在 Jet Hub 设置页完成，命令式入口已移除。
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    const names = commands.definitions.map((d) => d.name)
    expect(names).not.toContain('buddy-login')
    expect(names).not.toContain('buddy-status')
    expect(names).not.toContain('buddy-refresh')
  })

  it('registers the buddy LLM route', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    // 无账号时模型设置列表不显示，但 adapter 路由已就绪
    expect(llm.providers).not.toContain('buddy')
    expect(llm.adapters).toContain('buddy')
  })

  it('stops the buddy refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.buddyAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

describe('WorkBuddy provider 注册', () => {
  it('apply 时注册 buddy 与 workbuddy 两个 provider 路由', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const registered = ctx.llm.registeredProviders
    expect(registered).toContain('buddy')
    expect(registered).toContain('buddy-intl')
    expect(registered).toContain('workbuddy-cn')
    expect(registered).toContain('workbuddy')
  })

  it('WorkBuddy 使用独立的凭据 ref', () => {
    expect(WORKBUDDY.defaultCredentialRef).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  it('动态同步模型设置目录项：有账号时注册显示，删除账号后自动移除', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 初始没有账号：模型侧不显示（已删除/无账号的提供方不留在模型列表中）
    expect(ctx.llm.configurableProviders.find((p) => p.provider === 'workbuddy')).toBeUndefined()
    expect(ctx.llm.configurableProviders.find((p) => p.provider === 'codearts')).toBeUndefined()

    // 模拟在账号池新增一个 workbuddy 账号
    await ctx.accountPool.addAccount({
      id: 'workbuddy-test-1',
      provider: 'workbuddy',
      nickname: 'WB Test',
      enabled: true,
      credentialRef: 'WORKBUDDY_TEST_REF',
      refreshable: false,
      createdAt: Date.now(),
    })

    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'workbuddy')
    expect(entry).toMatchObject({ provider: 'workbuddy', displayName: WORKBUDDY.displayName })
    expect(entry?.settingsNs).toBe('llm-workbuddy')

    // 模拟删除该账号：模型侧自动注销移除
    await ctx.accountPool.removeAccount('workbuddy-test-1')
    expect(ctx.llm.configurableProviders.find((p) => p.provider === 'workbuddy')).toBeUndefined()
  })

  // 关键前置：命名空间必须预先注册，防止模型设置页崩溃
  it('全部产品的 settings namespace 始终预注册，避免未注册崩溃', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.settings.registeredNamespaces).toContain('llm-codearts')
    expect(ctx.settings.registeredNamespaces).toContain('llm-buddy')
    expect(ctx.settings.registeredNamespaces).toContain('llm-buddy-intl')
    expect(ctx.settings.registeredNamespaces).toContain('llm-workbuddy-cn')
    expect(ctx.settings.registeredNamespaces).toContain('llm-workbuddy')
  })

  it('不注册任何 buddy/workbuddy 斜杠命令（入口在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['buddy-login', 'buddy-status', 'buddy-refresh', 'workbuddy-login', 'workbuddy-status']) {
      expect(names, removed).not.toContain(removed)
    }
    // codearts 的三个命令保留（CodeArts 没有 Jet Hub 登录入口的替代品）。
    expect(names).toContain('codearts-login')
    expect(names).toContain('codearts-status')
    expect(names).toContain('codearts-refresh')
    // 命令名必须唯一，重复注册会让后注册的覆盖先注册的。
    expect(new Set(names).size).toBe(names.length)
  })

  // cordis 的 Service 构造时按名称注册，同名第二次注册会抛
  // `service "buddyAuth" has been registered`。两个产品必须各占一个服务名，
  // 否则 apply() 直接抛错、插件完全无法加载。
  it('同时暴露 buddyAuth 与 workbuddyAuth 两个独立实例，各读自己的凭据 ref', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.buddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyIntlAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.workbuddyCnAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.workbuddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyAuth).not.toBe(ctx.workbuddyAuth)
    expect(ctx.buddyAuth.product.id).toBe('buddy')
    expect(ctx.workbuddyAuth.product.id).toBe('workbuddy')
    expect(ctx.buddyAuth.credentialRefName).toBe('BUDDY_ACCESS_TOKEN')
    expect(ctx.workbuddyAuth.credentialRefName).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  it('workbuddyAuth 只读 WorkBuddy 自己的凭据 ref', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：WorkBuddy 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.workbuddyAuth.status()).configured).toBe(false)

    // 写入 WorkBuddy 自己的 ref 后变为已配置。
    await ctx.credentials.set('WORKBUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.workbuddyAuth.status()).configured).toBe(true)
  })

  it('buddyAuth 与 workbuddyAuth 的凭据互相隔离', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写 CodeBuddy 的 ref：CodeBuddy 已配置、WorkBuddy 未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.buddyAuth.status()).configured).toBe(true)
    expect((await ctx.workbuddyAuth.status()).configured).toBe(false)
  })

  it('dispose 时同时停止 Buddy 与 WorkBuddy 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const buddyStop = vi.spyOn(ctx.buddyAuth, 'stop')
    const workbuddyStop = vi.spyOn(ctx.workbuddyAuth, 'stop')
    await ctx.fiber.dispose()
    expect(buddyStop).toHaveBeenCalled()
    expect(workbuddyStop).toHaveBeenCalled()
  })
})
