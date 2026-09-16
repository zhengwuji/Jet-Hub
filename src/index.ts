import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerAntigravityLocalLlm, ANTIGRAVITY_PROVIDER } from './antigravity-local-adapter.js'
import { readAntigravityCredential } from './antigravity.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from './buddy-auth.js'
import { AccountPool } from './account-pool.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { ALL_PRODUCTS, CODEBUDDY, WORKBUDDY } from './product.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'

export const name = 'codearts-auth'
export const inject = ['credentials', 'commands', 'llm', 'connection']

/**
 * Provider 配置 namespace 的 schema。
 *
 * `registerConfigurableProviders` 声明的 `settingsNs` 必须真实存在于
 * settings 服务中，否则模型设置页读到 undefined 的 namespace，
 * 在 `refFor → deriveKeyRef(provider)` 处会以
 * `provider.toUpperCase is not a function` 崩溃。
 * 两者都只需承接一个可选的 `providers` 映射，故共用同一宽松 schema。
 *
 * 注意：`settings.register()` 要求 schemastery schema —— `describe()` 会对每个
 * 注册项无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)`。
 * 传入裸函数（`(value) => ...`）会让 `describe()` 抛
 * `TypeError: registration.schema.toJSON is not a function`，进而使所有
 * 依赖 settings 的界面（模型设置页、主题、sidebar 的 settings.get/shell.get）
 * 全部失败。因此这里必须用 `Schema.object({...})` 构造。
 */
const providerSettingsSchema = Schema.object({
  providers: Schema.dict(Schema.any()).default({}),
})

/** 注册 provider 配置 namespace（已存在时忽略重复注册错误）。 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = ctx.get('settings') as
    | {
      register: (ns: string, schema: unknown) => unknown
      describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string }>
    }
    | undefined
  if (!settings || typeof settings.register !== 'function') {
    ctx.logger.warn('[codearts-auth] settings 服务不可用，provider namespace 未注册')
    return
  }
  for (const ns of namespaces) {
    try {
      settings.register(ns, providerSettingsSchema)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，
 * 只是收到图片时报 UNSUPPORTED_CONTENT。两个 CodeBuddy 系产品（CodeBuddy /
 * WorkBuddy）共用同一后端与协议，图片能力相同，故共用本实现。
 */
function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) return undefined
    try {
      const stored = await attachments.readImage(attachment as never)
      return { data: stored.data, mediaType: stored.ref.mediaType }
    } catch {
      return undefined
    }
  }
}

/** 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。 */
export function apply(ctx: Context): void {
  // provider 的 settingsNs 必须已注册，否则模型设置页会因未注册 namespace 崩溃。
  // 三个 namespace 分别对应：codearts 路由、CodeBuddy（buddy）路由、
  // WorkBuddy（workbuddy）路由 —— 后者由 registerBuddyLlm 以
  // `llm-${product.id}` 派生，漏注册会让模型设置页在
  // `refFor → deriveKeyRef(provider)` 处以 `provider.toUpperCase is not a function` 崩溃。
  // antigravity 复用本机 IDE 凭据，同样需要自己的 namespace。
  registerProviderSettings(
    ctx,
    'llm-codearts',
    ...ALL_PRODUCTS.map((p) => `llm-${p.id}`),
    `llm-${ANTIGRAVITY_PROVIDER}`,
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  ctx.commands.register({
    name: 'codearts-login',
    description: '通过浏览器 OAuth 登录华为云 CodeArts',
    handler: async (): Promise<CommandResult> => {
      try {
        const result = await service.login()
        return {
          kind: 'success',
          text: `CodeArts 登录完成。凭据已存储于 ${String(result.ref)}；过期时间 ${new Date(result.expires).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-status',
    description: '显示 CodeArts 登录状态及刷新能力',
    handler: async (): Promise<CommandResult> => {
      const status = await service.status()
      return {
        kind: 'success',
        text: [
          `已配置: ${status.configured}`,
          ...status.source === undefined ? [] : [`来源: ${status.source}`],
          ...status.expiresAt === undefined ? [] : [`过期时间: ${new Date(status.expiresAt).toISOString()}`],
          `可刷新: ${status.refreshable}`,
          ...status.refreshError === undefined ? [] : [`刷新错误: ${status.refreshError}`],
        ].join('\n'),
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-refresh',
    description: '静默刷新 CodeArts 凭据',
    handler: async (): Promise<CommandResult> => {
      try {
        await service.refresh()
        const status = await service.status()
        return {
          kind: 'success',
          text: `CodeArts 凭据已刷新；过期时间 ${status.expiresAt === undefined ? '未知' : new Date(status.expiresAt).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // 优先使用账号池获取可用账号，回退到单凭据解析
      if (pool) {
        const available = await pool.getAvailableAccount('codearts', '')
        if (available) return available.credential as CodeArtsCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as CodeArtsCredential
      } catch {
        return undefined
      }
    },
    refresh: () => service.refresh(),
    fetchRemoteModels: () => service.refreshModels(),
    accountPool: pool,
    skipConfigurableRegistration: true,
  })

  // ===== CodeBuddy / WorkBuddy 系服务注册 =====
  const buddyServices = new Map<string, BuddyAuth>()
  for (const product of ALL_PRODUCTS) {
    const auth = new BuddyAuth(ctx, { product })
    buddyServices.set(product.id, auth)

    registerBuddyLlm(ctx, {
      credentialRef: credentialRef(product.defaultCredentialRef),
      resolveCredential: async () => {
        if (pool) {
          const available = await pool.getAvailableAccount(product.id, '')
          if (available) return available.credential as BuddyCredential
        }
        const resolved = await ctx.credentials.resolve(credentialRef(product.defaultCredentialRef))
        if (!resolved) return undefined
        try {
          return JSON.parse(resolved.value) as BuddyCredential
        } catch {
          return undefined
        }
      },
      refresh: () => auth.refresh(),
      fetchRemoteModels: () => auth.fetchModels(pool),
      readImage: makeReadImage(ctx),
      accountPool: pool,
      product,
      skipConfigurableRegistration: true,
    })
  }

  // ===== Antigravity (Google) 注册 =====
  //
  // ⚠️ 刻意**不放进 ALL_PRODUCTS**，也不传入 accountPool。
  //
  // 原因（防封号的关键架构决策）：ALL_PRODUCTS 会被上面那个循环用于创建
  // 多账号服务实例，并接入 refreshAll / 限流自动切换。Google 侧对"同一账号
  // 被多客户端高频轮换调用"的判定远比腾讯侧严格，账号池那套做法套过来等同
  // 于账号滥用。Antigravity 因此走单账号、无池、纯复用的独立注册路径。
  //
  // **通道选择（方案 B 为主）**：
  //   - 首选本地私有通道：借用 IDE 自己的 language_server 进程发请求，
  //     对 Google 而言与"用户在 IDE 里正常提问"无法区分（见 antigravity-local.ts）。
  //     这条路**不读凭据文件**，账号身份由 IDE 运行时决定。
  //   - 降级公共 API：仅在显式开启 `allowPublicFallback` 且 IDE 未运行时使用
  //     （见 antigravity-adapter.ts）。本机实测该账号的公共 API 全部 403
  //     SUBSCRIPTION_REQUIRED，故默认关闭，改为给出"请先打开 IDE"的中文提示。
  registerAntigravityLocalLlm(ctx, { skipConfigurableRegistration: true })

  // ===== 多账号静默续期调度 =====
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 每 30 分钟检查一次

  async function refreshAllCredentials(): Promise<void> {
    try {
      await service.refreshAll(pool)
    } catch { /* 静默 */ }
    for (const auth of buddyServices.values()) {
      try {
        await auth.refreshAll(pool)
      } catch { /* 静默 */ }
    }
  }

  // 启动时如果有任何可续期账号，安排定期续期
  pool.listAllAccounts().then((accounts) => {
    const hasRefreshable = accounts.some((a) => a.refreshable && a.enabled)
    if (hasRefreshable) {
      const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
      ctx.effect(() => () => {
        clearInterval(refreshTimer)
        service.stop()
        for (const auth of buddyServices.values()) auth.stop()
      }, 'jet-hub: multi-account refresh scheduler')
    }
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    for (const auth of buddyServices.values()) auth.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== 动态同步“设置 -> 模型”可配置提供方列表 =====
  // 规则：删除对应账号后，没有可用/生效账号的提供方从模型列表中移除；
  // 仍有有效/启用账号的提供方予以保留，不予删除。
  interface ConfigurableProviderEntry {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: string[]
  }

  const CODEARTS_DIRECTORY_ENTRY: ConfigurableProviderEntry = {
    provider: 'codearts',
    displayName: 'CodeArts Agent',
    settingsNs: 'llm-codearts',
    settingsPath: [],
  }

  let dirHandle: { replace(entries: ConfigurableProviderEntry[]): void } | undefined
  let currentRegistered = new Set<string>()

  async function syncConfigurableProviders(): Promise<void> {
    const accounts = await pool.listAllAccounts()
    const activeEntries: ConfigurableProviderEntry[] = []

    // 1. 检查 CodeArts 是否有可用账号或有效凭据
    const hasCodeArtsAccount = accounts.some((a) => a.provider === 'codearts' && a.enabled !== false)
    let hasCodeArtsCred = false
    if (!hasCodeArtsAccount) {
      try {
        const resolved = await ctx.credentials?.resolve?.(credentialRef(CODEARTS_CREDENTIAL_REF))
        if (resolved && resolved.value) hasCodeArtsCred = true
      } catch { /* 静默 */ }
    }
    if (hasCodeArtsAccount || hasCodeArtsCred) {
      activeEntries.push(CODEARTS_DIRECTORY_ENTRY)
    }

    // 2. 检查 CodeBuddy / WorkBuddy 各产品是否有可用账号或有效凭据
    for (const product of ALL_PRODUCTS) {
      const hasAccount = accounts.some((a) => a.provider === product.id && a.enabled !== false)
      let hasCred = false
      if (!hasAccount) {
        try {
          const resolved = await ctx.credentials?.resolve?.(credentialRef(product.defaultCredentialRef))
          if (resolved && resolved.value) hasCred = true
        } catch { /* 静默 */ }
      }
      if (hasAccount || hasCred) {
        activeEntries.push({
          provider: product.id,
          displayName: product.displayName,
          settingsNs: `llm-${product.id}`,
          settingsPath: [],
        })
      }
    }

    // 3. Antigravity (Google)：作为本地私有 IDE 直连通道，始终注册该提供方。
    //    用户启动 Antigravity IDE 即可自动无缝直连调用模型。
    activeEntries.push({
      provider: ANTIGRAVITY_PROVIDER,
      displayName: 'Antigravity (Google)',
      settingsNs: `llm-${ANTIGRAVITY_PROVIDER}`,
      settingsPath: [],
    })

    const nextSet = new Set(activeEntries.map((e) => e.provider))
    if (
      dirHandle !== undefined &&
      nextSet.size === currentRegistered.size &&
      [...nextSet].every((p) => currentRegistered.has(p))
    ) {
      return
    }

    if (dirHandle !== undefined) {
      dirHandle.replace(activeEntries)
      currentRegistered = nextSet
    } else if (activeEntries.length > 0) {
      dirHandle = ctx.llm.registerConfigurableProviders(activeEntries)
      currentRegistered = nextSet
    }
  }

  // 顺序 Promise 队列，杜绝启动与事件监听间的并发竞态
  let syncQueue = Promise.resolve()

  function queueSync(): Promise<void> {
    syncQueue = syncQueue.then(async () => {
      await syncConfigurableProviders()
    }).catch((err) => {
      ctx.logger?.warn?.(`[jet-hub] syncConfigurableProviders failed: ${String(err)}`)
    })
    return syncQueue
  }

  // 初始触发一次同步
  void queueSync()

  // 账号池变更（添加账号、删除账号、切换启用状态）时联动刷新
  const unbindAccountsListener = pool.onAccountsChanged(() => queueSync())

  ctx.effect(() => () => {
    unbindAccountsListener()
    if (dirHandle) {
      try {
        (dirHandle as unknown as () => void)()
      } catch { /* 静默 */ }
      dirHandle = undefined
      currentRegistered.clear()
    }
  }, 'jet-hub: dynamic configurable providers sync')

  // ===== Jet Hub RPC 注册 =====
  registerJetHubRpc(ctx, pool, service, buddyServices)
  ctx.provide('accountPool', pool)
}
