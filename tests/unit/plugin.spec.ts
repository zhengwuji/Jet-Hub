import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply, makeReadImage } from '../../src/index.js'
import * as pluginEntry from '../../src/index.js'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { runBuddyLoginFlow } from '../../src/buddy-oauth.js'
import { CodeArtsAuth } from '../../src/service.js'
import { BuddyAuth } from '../../src/buddy-auth.js'
import { LobsteraiAuth } from '../../src/lobsterai-auth.js'
import { TraeAuth } from '../../src/trae-auth.js'
import { WORKBUDDY } from '../../src/product.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { TRAE } from '../../src/trae-product.js'

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
    // ⚠️ **累加语义**，与真实 ctx.llm 一致：六个 provider 各自在自己的
    // registerXxxLlm 里独立调用本方法，若这里先清空就会把前面几个注册的目录项
    // 抹掉（早期 mock 这样写，导致 lobsterai/qoder/trae 的目录断言假失败）。
    // `replace()` 返回空操作：当前实现已不再动态增删目录项（见 src/index.ts）。
    for (const entry of entries) {
      this.providers.push(entry.provider)
      this.configurableProviders.push(entry)
    }
    return { replace: () => {} }
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
  it('registers the codeartsAuth service (no slash commands)', () => {
    const { ctx, commands } = makeContext()
    apply(ctx)
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    // CodeArts 不再注册任何斜杠命令：登录/状态/续期统一在 Jet Hub 设置页完成。
    const names = commands.definitions.map((d) => d.name)
    for (const removed of ['codearts-login', 'codearts-status', 'codearts-refresh', 'codearts-logout']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('注册 codearts LLM 路由（目录、适配器、设置 namespace）', () => {
    const { ctx, llm } = makeContext()
    apply(ctx)
    // 目录项必须常在（模型的设置页入口），「无账号就不显示模型」由适配器
    // listModels() 内的 providerCatalogVisible() 门控实现，见 src/account-pool.ts。
    expect(llm.providers).toContain('codearts')
    expect(llm.adapters).toContain('codearts')
  })

  it('stops the refresh scheduler when the plugin context is disposed', async () => {
    const { ctx } = makeContext()
    apply(ctx)
    const stopSpy = vi.spyOn(ctx.codeartsAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stopSpy).toHaveBeenCalled()
  })
})

/** schemastery `toJSON()` 的序列化形态：子 schema 以 id 存于 `refs`，`dict` 存 id。 */
interface SerializedSchema {
  uid: string | number
  refs: Record<string, {
    type?: string
    meta?: Record<string, unknown>
    dict?: Record<string, string | number>
  }>
}

/**
 * DSH 0.1.7-rc.1 起 `ctx.settings` 是 `SettingsForms`：**没有 `register`**，
 * 命名空间只能是 profile 条目 id。旧实现会在这条分支上打一条误导性的
 * 「settings 服务不可用」告警，并把 provider 的 settingsNs 留成永不存在于
 * settings 的 `llm-*`。这里锁死新契约下的行为（Gitee issue IKI7WT）。
 */
describe('0.1.7 settings 契约（SettingsForms，无 register）', () => {
  /** 0.1.7 的 settings 形状：describe/configure 在，register 不在。 */
  function make017Context(): { ctx: Context; llm: FakeLlm } {
    const ctx = new Context()
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    const llm = new FakeLlm()
    ctx.provide('llm', llm as never)
    ctx.provide('settings', {
      describe: () => [],
      configure: () => () => {},
    } as never)
    return { ctx, llm }
  }

  it('apply 不抛错，且不再打「settings 服务不可用」告警', () => {
    const { ctx } = make017Context()
    const warns: string[] = []
    const spy = vi.spyOn(ctx.logger, 'warn').mockImplementation(((...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }) as never)
    try {
      expect(() => apply(ctx)).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(warns.filter(w => w.includes('settings 服务不可用'))).toEqual([])
  })

  it('provider 的 settingsNs 解析为本插件条目 id（无条目时退回旧名，但不再假设其存在）', () => {
    const { ctx, llm } = make017Context()
    apply(ctx)
    const codearts = llm.configurableProviders.find(entry => entry.provider === 'codearts')
    // 该替身没有 profile 条目（fiber.entry 缺失）→ 退回旧命名空间名。
    expect(codearts?.settingsNs).toBe('llm-codearts')
  })

  it('Config 暴露 volatile 的 providers 字段（否则 settings.describe 不收录本条目）', () => {
    const schema = (pluginEntry as {
      Config?: { toJSON(): SerializedSchema }
    }).Config
    expect(schema).toBeDefined()
    const json = schema!.toJSON()
    const root = json.refs[String(json.uid)]
    expect(root?.type).toBe('object')
    // `dict` 存的是子 schema 在 refs 里的 id。
    const providersRef = String(root?.dict?.['providers'])
    expect(json.refs[providersRef]?.meta?.['volatile']).toBe(true)
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
    // provider 路由与目录项都注册就绪。
    // 「没有账号就不显示模型」由适配器 listModels() 内的 providerCatalogVisible()
    // 门控实现（返回空数组让 DSH 过滤掉该分组），**不**体现为目录项被摘除 ——
    // 目录项必须常在，否则模型的设置页入口会消失。
    expect(llm.providers).toContain('buddy')
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
    // 四个 CodeBuddy 系产品都必须注册：客户端 PROVIDERS 列表列了它们，
    // 不注册就会出现「面板在、后端无实例」的空壳，账号池里对应 provider
    // 的账号成孤儿（本机 workbuddy-cn 就有真实账号）。
    expect(registered).toContain('buddy')
    expect(registered).toContain('buddy-intl')
    expect(registered).toContain('workbuddy-cn')
    expect(registered).toContain('workbuddy')
  })

  /**
   * ⚠️ **不变量：客户端列出的每个 provider 都必须有服务端实例。**
   *
   * 真实缺陷（本次修复）：客户端 PROVIDERS 列表里有 `buddy-intl` 与
   * `workbuddy-cn` 两个面板，但服务端 `ALL_PRODUCTS` 一度只留了
   * `buddy` + `workbuddy` → 两个面板成了**空壳**（面板在、无适配器），
   * 账号池里 `workbuddy-cn` 的真实账号成**孤儿**：能看见却无法续期/删除。
   *
   * 这条断言直接比对「客户端面板列表」与「服务端已注册路由」两个集合，
   * 任何一侧新增而另一侧漏加都会立刻失败 —— 比逐个 `toContain` 更难绕过。
   */
  it('客户端列出的每个 provider 都有服务端实例（防面板空壳）', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    const panelIds = [...clientSource.matchAll(/\{\s*id:\s*'([a-z][a-z0-9-]*)',\s*label:/g)].map((m) => m[1]!)

    const ctx = createMockContext()
    apply(ctx as never)
    const registered = new Set(ctx.llm.registeredProviders)
    // 适配器是「能真正收发请求」的那一层，比 configurableProviders 更硬。
    const adapters = new Set(ctx.llm.adapters)

    expect(panelIds.length).toBeGreaterThan(0)
    for (const id of panelIds) {
      expect(registered, `面板 ${id} 没有对应的 provider 路由（空壳）`).toContain(id)
      expect(adapters, `面板 ${id} 没有对应的适配器（空壳）`).toContain(id)
    }
  })

  it('WorkBuddy 使用独立的凭据 ref', () => {
    expect(WORKBUDDY.defaultCredentialRef).toBe('WORKBUDDY_ACCESS_TOKEN')
  })

  it('可配置 provider 目录项注册即固定，不随账号池增删而变动', () => {
    const ctx = createMockContext()
    apply(ctx as never)

    // 目录项在各自 registerXxxLlm 里一次性注册，**不**依赖账号是否存在。
    //
    // 早期实现（本地分支的 syncConfigurableProviders）会在「有账号才登记」，
    // 后果是 lobsterai / qoder / trae 永远不在目录里、settingsNs 从未注册，
    // 模型设置页在 `refFor → deriveKeyRef(provider)` 处崩溃。该机制已被
    // Gitee 的 b3a9561 整体替换：目录固定，而「没有账号就不显示模型」改由
    // 各适配器 listModels() 里的 providerCatalogVisible() 门控实现
    // （空分组会被 DSH 的 buildModelCatalog 过滤掉）。
    for (const provider of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'trae']) {
      const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === provider)
      expect(entry, provider).toBeDefined()
      expect(entry?.settingsNs, provider).toBe(`llm-${provider}`)
    }
  })

  // 关键前置：命名空间必须预先注册，防止模型设置页崩溃
  it('全部产品的 settings namespace 始终预注册，避免未注册崩溃', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.settings.registeredNamespaces).toContain('llm-codearts')
    expect(ctx.settings.registeredNamespaces).toContain('llm-buddy')
    expect(ctx.settings.registeredNamespaces).toContain('llm-workbuddy')
    // 六个 provider 的 namespace 都要预注册（含 Gitee 新增的三个）
    expect(ctx.settings.registeredNamespaces).toContain('llm-lobsterai')
    expect(ctx.settings.registeredNamespaces).toContain('llm-qoder')
    expect(ctx.settings.registeredNamespaces).toContain('llm-trae')
    // Antigravity 复用本机 IDE 凭据，同样需要自己的 namespace
    expect(ctx.settings.registeredNamespaces).toContain('llm-antigravity')
  })

  it('不注册任何 provider 的斜杠命令（入口都在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of [
      'buddy-login', 'buddy-status', 'buddy-refresh', 'workbuddy-login', 'workbuddy-status',
      // CodeArts 的三个命令也已移除：登录/状态/续期统一在 Jet Hub 完成，
      // 六个 provider 的做法现在完全一致。
      'codearts-login', 'codearts-status', 'codearts-refresh', 'codearts-logout',
    ]) {
      expect(names, removed).not.toContain(removed)
    }
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
    expect(ctx.workbuddyAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyAuth).not.toBe(ctx.workbuddyAuth)
    expect(ctx.buddyAuth.product.id).toBe('buddy')
    expect(ctx.workbuddyAuth.product.id).toBe('workbuddy')
    expect(ctx.buddyAuth.credentialRefName).toBe('BUDDY_ACCESS_TOKEN')
    expect(ctx.workbuddyAuth.credentialRefName).toBe('WORKBUDDY_ACCESS_TOKEN')
    // CodeBuddy 国际版与 WorkBuddy 国内版同样各有独立实例与凭据 ref ——
    // 它们与各自的同族产品**互不串用**（端点与登录态都不同）。
    expect(ctx.buddyIntlAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.workbuddyCnAuth).toBeInstanceOf(BuddyAuth)
    expect(ctx.buddyIntlAuth.product.id).toBe('buddy-intl')
    expect(ctx.workbuddyCnAuth.product.id).toBe('workbuddy-cn')
    expect(ctx.buddyIntlAuth.credentialRefName).toBe('BUDDY_INTL_ACCESS_TOKEN')
    expect(ctx.workbuddyCnAuth.credentialRefName).toBe('WORKBUDDY_CN_ACCESS_TOKEN')
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

  /**
   * `connection` **不得**出现在插件级静态 `inject` 里。
   *
   * 该服务只由 Web bundle（dsh-client-connection）提供，headless / CLI profile
   * 中并不存在。静态 `inject` 会让本插件在那些 profile 里永久 pending，整个
   * profile 因此以
   * `plugin tree failed to load: 1 entry did not activate` 启动失败
   * —— chicheng-cron 的 skill/agent 任务正是跑在 `dsh --profile headless` 下，
   * 会全部 exit 1。
   *
   * 正确做法是 `registerJetHubRpc` 内部用惰性注入（`ctx.inject(['connection'], …)`）
   * 挂载端点：Web 下正常注册，其余 profile 只是不注册 Jet Hub 端点。
   *
   * 这条断言锁住的是「**能不能加载**」而非某个功能细节，所以即便日后有人为了
   * 让 UI 更"直接"而把 connection 加回静态 inject，也必须先看到这里失败。
   */
  it('静态 inject 不得包含 connection（否则 headless profile 启动失败）', () => {
    const { inject } = pluginEntry as { inject?: readonly string[] }
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).not.toContain('connection')
    // 必需服务仍须声明，避免修 connection 时顺手把别的服务误删。
    for (const required of ['credentials', 'commands', 'llm']) {
      expect(inject, required).toContain(required)
    }
  })
})


describe('LobsterAI provider 注册', () => {
  it('apply 时注册 lobsterai provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('lobsterai')
    expect(ctx.llm.adapters).toContain('lobsterai')
  })

  it('注册 lobsterai 的可配置 provider 目录项（含展示名）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'lobsterai')
    expect(entry).toMatchObject({ provider: 'lobsterai', displayName: LOBSTERAI.displayName })
  })

  // 与 workbuddy 同理：settingsNs 未注册时，模型设置页会在
  // refFor → deriveKeyRef(provider) 处以 `provider.toUpperCase is not a function` 崩溃。
  it('lobsterai 的 settingsNs 为 llm-lobsterai，且对应 settings namespace 已注册', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'lobsterai')
    expect(entry?.settingsNs).toBe('llm-lobsterai')
    expect(ctx.settings.registeredNamespaces).toContain('llm-lobsterai')
  })

  it('不注册任何 lobsterai 斜杠命令（入口在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['lobsterai-login', 'lobsterai-status', 'lobsterai-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('暴露 lobsteraiAuth 服务实例，服务名不与既有 provider 冲突', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.lobsteraiAuth).toBeInstanceOf(LobsteraiAuth)
    expect(ctx.lobsteraiAuth.name).toBe('lobsteraiAuth')
    expect(ctx.lobsteraiAuth.product.id).toBe('lobsterai')
    expect(ctx.lobsteraiAuth.credentialRefName).toBe('LOBSTERAI_ACCESS_TOKEN')
    // 四个 provider 的服务实例必须两两不同（同名二次注册会抛错）。
    expect(ctx.lobsteraiAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.lobsteraiAuth).not.toBe(ctx.workbuddyAuth)
  })

  it('lobsteraiAuth 只读自己的凭据 ref（不串用腾讯系凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：LobsterAI 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(false)

    await ctx.credentials.set('LOBSTERAI_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.lobsteraiAuth.status()).configured).toBe(true)
  })

  it('dispose 时停止 LobsterAI 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.lobsteraiAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

describe('TRAE provider 注册', () => {
  it('apply 时注册 trae provider 路由与适配器', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.llm.registeredProviders).toContain('trae')
    expect(ctx.llm.adapters).toContain('trae')
  })

  it('注册 trae 的可配置 provider 目录项（含展示名）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'trae')
    expect(entry).toMatchObject({ provider: 'trae', displayName: TRAE.displayName })
  })

  // 与 workbuddy / lobsterai 同理：settingsNs 未注册时，模型设置页会在
  // refFor → deriveKeyRef(provider) 处以 `provider.toUpperCase is not a function` 崩溃。
  it('trae 的 settingsNs 为 llm-trae，且对应 settings namespace 已注册', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const entry = ctx.llm.configurableProviders.find((item: { provider: string }) => item.provider === 'trae')
    expect(entry?.settingsNs).toBe('llm-trae')
    expect(ctx.settings.registeredNamespaces).toContain('llm-trae')
  })

  it('不注册任何 trae 斜杠命令（入口在 Jet Hub 设置页）', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const names = ctx.commands.definitions.map((d) => d.name)
    for (const removed of ['trae-login', 'trae-status', 'trae-refresh']) {
      expect(names, removed).not.toContain(removed)
    }
  })

  it('暴露 traeAuth 服务实例，服务名不与既有 provider 冲突', () => {
    const ctx = createMockContext()
    apply(ctx as never)
    expect(ctx.traeAuth).toBeInstanceOf(TraeAuth)
    expect(ctx.traeAuth.name).toBe('traeAuth')
    expect(ctx.traeAuth.product.id).toBe('trae')
    expect(ctx.traeAuth.credentialRefName).toBe('TRAE_ACCESS_TOKEN')
    // 五个 provider 的服务实例必须两两不同（同名二次注册会抛错）。
    expect(ctx.traeAuth).not.toBe(ctx.buddyAuth)
    expect(ctx.traeAuth).not.toBe(ctx.workbuddyAuth)
    expect(ctx.traeAuth).not.toBe(ctx.lobsteraiAuth)
  })

  it('traeAuth 只读自己的凭据 ref（不串用其它 provider 凭据）', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    // 只写入 CodeBuddy 的 ref：TRAE 必须报告未配置。
    await ctx.credentials.set('BUDDY_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeAuth.status()).configured).toBe(false)

    await ctx.credentials.set('TRAE_ACCESS_TOKEN', JSON.stringify({
      access_token: 'AT2', refresh_token: 'RT2', expires_at: String(Date.now() + 7_200_000),
    }))
    expect((await ctx.traeAuth.status()).configured).toBe(true)
  })

  it('dispose 时停止 TRAE 的续期调度', async () => {
    const ctx = createMockContext()
    apply(ctx as never)
    const stop = vi.spyOn(ctx.traeAuth, 'stop')
    await ctx.fiber.dispose()
    expect(stop).toHaveBeenCalled()
  })
})

/**
 * `makeReadImage` 是「图片为什么送不出去」这条诊断链上唯一的桥接点。
 *
 * 旧实现在附件服务缺失或单图读取失败时一律 `return undefined`，
 * 适配器收到 undefined 后 `continue` 丢图：线上请求静默退化成纯文本，
 * 用户只看到模型「看不到图片」，拿不到任何错误原因——排查成本极高。
 * 下面两条锁住「读不到必须抛错」这一契约。
 */
describe('makeReadImage 图片桥接', () => {
  it('附件服务缺失时抛错，并提示需要哪个插件', async () => {
    const ctx = new Context()
    const readImage = makeReadImage(ctx)
    const error = await readImage({ attachmentId: 'att-1' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('attachments')
    expect((error as Error).message).toContain('dsh-attachment-local')
  })

  it('读取成功时返回字节与 mediaType', async () => {
    const ctx = new Context()
    ctx.provide('attachments', {
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' } }),
    } as never)
    const readImage = makeReadImage(ctx)
    await expect(readImage({ attachmentId: 'att-1' })).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
    })
  })

  it('单图读取失败时让原始异常冒泡（绝不静默返回 undefined）', async () => {
    // 分工：桥接层不包装，保持原始错误完整；适配器层负责包成带
    // attachmentId 的 LlmError。此处锁住「不会变成 undefined」这一点。
    const cause = new Error('attachment object is gone')
    const ctx = new Context()
    ctx.provide('attachments', {
      readImage: async () => { throw cause },
    } as never)
    const readImage = makeReadImage(ctx)
    const error = await readImage({ attachmentId: 'att-1' }).catch((e: unknown) => e)
    expect(error).toBe(cause)
    expect(error).not.toBeUndefined()

  })
})
