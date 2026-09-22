import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { registerTraeLlm } from './trae-adapter.js'
// Antigravity（Google）：走独立的本地私有通道 / 公共 API 降级路径。
// ⚠️ 刻意**不放进 ALL_PRODUCTS**，也不接入账号池，原因见下方注册处注释。
import { registerAntigravityLocalLlm, getRegisteredAntigravityAdapter, ANTIGRAVITY_PROVIDER } from './antigravity-local-adapter.js'
import { readAntigravityCredential } from './antigravity.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { TraeAuth } from './trae-auth.js'
import { AccountPool } from './account-pool.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { ALL_PRODUCTS, CODEBUDDY, WORKBUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Jet Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

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

 * 只是收到图片时报 UNSUPPORTED_CONTENT。三个 provider 共用本实现：
 * 两个 CodeBuddy 系产品（CodeBuddy / WorkBuddy）共用同一后端与协议；
 * LobsterAI 的图片形态同为 OpenAI 兼容的 `image_url` data URL
 * （2026-09-17 实测服务端接受并正确识别内容）。

 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'codearts-auth: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/** 注册 codeartsAuth 服务与 codearts LLM 路由（不注册斜杠命令）。 */
export function apply(ctx: Context): void {
  // provider 的 settingsNs 必须已注册，否则模型设置页会因未注册 namespace 崩溃。
  // 七个 namespace 分别对应：codearts 路由、CodeBuddy（buddy）路由、
  // WorkBuddy（workbuddy）路由、LobsterAI（lobsterai）路由、Qoder（qoder）路由、
  // TRAE（trae）路由、Antigravity 路由 —— 前六者由 registerBuddyLlm /
  // registerLobsteraiLlm / registerQoderLlm / registerTraeLlm 以
  // `llm-${product.id}` 派生，漏注册会让模型设置页在
  // `refFor → deriveKeyRef(provider)` 处以
  // `provider.toUpperCase is not a function` 崩溃。
  // antigravity 复用本机 IDE 凭据，同样需要自己的 namespace。
  registerProviderSettings(
    ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai', 'llm-qoder', 'llm-trae',
    `llm-${ANTIGRAVITY_PROVIDER}`,
  )
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
    if (removed.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  // ⚠️ **CodeArts 不注册任何斜杠命令**（`codearts-login` / `codearts-status` /
  // `codearts-refresh` 三个已删除）：登录、状态与续期统一在 Jet Hub 设置页完成，
  // 与 buddy / workbuddy / lobsterai / qoder / trae 的既有做法一致。
  const codearts = registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // CodeArts **只认账号池**，与其余五个 provider 一致。
      //
      // ⚠️ 早期它额外支持「单凭据模式」（`CODEARTS_ACCESS_TOKEN`）：登录后把凭据
      // 写到那个固定 ref，适配器在账号池取不到时回退去读它。该模式**已移除** ——
      // 登录入口只有 Jet Hub 设置页，凭据一律写入 `CODEARTS_ACCOUNT_XXX`，
      // 固定的 `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取。
      //
      // 这里仍保留 `credentialRef` 选项，仅为满足适配器契约与报错文案
      // （其余 provider 同样传各自的默认 ref，但都不再作为回退来源）。
      const available = await pool.getAvailableAccount('codearts', '')
      return available?.credential as CodeArtsCredential | undefined
    },
    // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
    // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
    // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
    refresh: async () => {
      const available = await pool.getAvailableAccount('codearts', '')
      if (available) await service.refreshAccountCredential(available.entry.credentialRef)
    },
    fetchRemoteModels: () => service.refreshModels(pool),
    accountPool: pool,
    // 与其余五个 provider 一致：目录项（llm-codearts）由 registerCodeArtsLlm
    // 自己注册。早期这里是 `skipConfigurableRegistration: true`，因为当时由
    // index.ts 的 syncConfigurableProviders() 集中登记；该机制已移除 ——
    // 它只登记 ALL_PRODUCTS 里的产品，导致 lobsterai/qoder/trae 漏登记，
    // 模型设置页会在 deriveKeyRef 处崩溃。
  })

  // ===== Buddy (腾讯 CodeBuddy) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Jet Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。
  const buddy = new BuddyAuth(ctx)
  const buddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: async () => {
      // 优先使用账号池获取可用账号，回退到单凭据解析
      if (pool) {
        const available = await pool.getAvailableAccount('buddy', '')
        if (available) return available.credential as BuddyCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => buddy.refresh(),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Jet Hub 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  const workbuddyAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
      // 保证不会串用 CodeBuddy 的凭据。
      const available = await pool.getAvailableAccount('workbuddy', '')
      if (available) return available.credential as BuddyCredential
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => workbuddy.refresh(),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Jet Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  const lobsteraiAdapter = registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
      // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) return available.credential as LobsteraiCredential
      const resolved = await ctx.credentials.resolve(credentialRef(LOBSTERAI.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as LobsteraiCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== Qoder (阿里系 AI IDE) 服务 =====
  // 第五个产品线，协议与四者**都不同源**：PKCE 设备码轮询登录
  // （不起本地回调服务器，见 src/qoder-oauth.ts）。
  // 服务名由产品 id 派生，注册为 ctx.qoderAuth。
  // 与其它 provider 一样不注册斜杠命令：入口在 Jet Hub 的 Qoder 面板。
  const qoder = new QoderAuth(ctx)
  const qoderAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 Qoder 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 QODER.id 而非字面量 'qoder'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(QODER.id, '')
      if (available) return available.credential as QoderCredential
      const resolved = await ctx.credentials.resolve(credentialRef(QODER.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as QoderCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `QODER_ACCOUNT_XXX` 的凭据，而 `qoder.refresh()` 读写的是
      // `QODER_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      const available = await pool.getAvailableAccount(QODER.id, '')
      if (available) await qoder.refreshAccountCredential(available.entry.credentialRef)
      else await qoder.refresh()
    },
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: QODER,
  })

  // ===== TRAE（字节 TRAE IDE）服务 =====
  // 第六个产品线，协议与前面几者**完全不同**：认证用 ExchangeToken（轮换 refreshToken），
  // 对话用 Cloud-IDE-JWT 鉴权，载荷需从 OpenAI 格式转换为 SOLO 格式，
  // SSE 为自定义格式（非 OpenAI 标准），需独立解析。
  // 服务名由 TraeAuth 依 product.id 派生，注册为 ctx.traeAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 TRAE 面板。
  const trae = new TraeAuth(ctx)
  const traeAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, '')
      if (available) return available.credential as TraeCredential
      const resolved = await ctx.credentials.resolve(credentialRef(TRAE.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as TraeCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE.id, '')
      if (available) await trae.refreshAccountCredential(available.entry.credentialRef)
      else await trae.refresh()
    },
    fetchRemoteModels: () => trae.fetchModels(pool),
    // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
    // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE,
  })

  // ===== 多账号静默续期调度 =====
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 每 30 分钟检查一次

  async function refreshAllCredentials(): Promise<void> {
    try {
      await service.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await buddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await workbuddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await lobsterai.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await qoder.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await trae.refreshAll(pool)
    } catch { /* 静默 */ }
    // ⚠️ Antigravity **刻意不在此列**：它不接账号池、不做限流轮换，续期由 IDE
    // 自己负责（见下方注册处注释）。把它并进 refreshAll 会引入 Google 侧敏感的
    // 多客户端轮换行为。
  }

  // 启动时如果有任何可续期账号，安排定期续期。
  //
  // ⚠️ 判据只看 `refreshable`，**不看 `enabled`**：停用只影响账号池的自动
  // 选号，不该让凭据停止续期。早期这里写成 `a.refreshable && a.enabled`，
  // 于是「所有账号都被停用」时续期定时器**根本不启动**，凭据一路过期到
  // refresh_token 失效，用户重新启用后只能重新登录（真实缺陷）。
  pool.listAllAccounts().then(accounts => {
    const hasRefreshable = accounts.some(a => a.refreshable)
    if (hasRefreshable) {
      const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
      ctx.effect(() => () => {
        clearInterval(refreshTimer)
        service.stop()
        buddy.stop()
        workbuddy.stop()
        lobsterai.stop()
        qoder.stop()
        trae.stop()
      }, 'jet-hub: multi-account refresh scheduler')
    }
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
    qoder.stop()
    trae.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== 可配置 provider 目录项：注册即固定，不做动态增删 =====
  //
  // ⚠️ **不在此处动态增删可配置 provider 目录项**。
  //
  // 早期实现（本地分支）用过一套 `syncConfigurableProviders()`：按「是否有账号/凭据」
  // 把 provider 从目录里增删，并监听账号池变更重算。该方案有两个缺陷，已在
  // Gitee 侧的 `b3a9561` 中被**整体替换**：
  //
  // 1. 它只登记 `ALL_PRODUCTS` 里的产品，于是 lobsterai / qoder / trae 三个
  //    provider 永远不在目录里（settingsNs 也就从未注册）——模型设置页会在
  //    `refFor → deriveKeyRef(provider)` 处崩溃；
  // 2. 「没有账号就不显示模型」这个需求已被**更准确的实现**取代：门控下沉到各
  //    适配器的 `listModels()`（`providerCatalogVisible()`），DSH 的
  //    `buildModelCatalog` 会对空分组做 `.filter(g => g.models.length > 0)`。
  //    这样做的额外好处是**不影响路由** —— 目录只是建议性的，已持久化的模型
  //    仍可 resolveModel / 正常收发（与模型黑名单同一契约）。
  //
  // 因此这里保持「注册即固定」：六个 provider 的 configurableProviders 与
  // settingsNs 在各自的 registerXxxLlm 里一次性注册，不再随账号池变化增删。

  // ===== Jet Hub RPC 注册 =====
  // ===== Antigravity (Google) 注册 =====
  //
  // ⚠️ 刻意**不放进 ALL_PRODUCTS**，也不传入 accountPool。
  //
  // 原因（防封号的关键架构决策）：ALL_PRODUCTS 会被上面的循环用于创建
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
  const disposeAntigravity = registerAntigravityLocalLlm(ctx, {
    skipConfigurableRegistration: true,
  })
  // ⚠️ `registerAntigravityLocalLlm` 返回的是**注销函数**（`() => void`），
  // 不是适配器实例 —— 实例由模块内的 `setRegisteredAntigravityAdapter` 持有，
  // 只能经 `getRegisteredAntigravityAdapter()` 取回。别把返回值当适配器用。
  ctx.effect(() => disposeAntigravity)

  // provider → 适配器实例：Jet Hub「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts,
    buddy: buddyAdapter,
    workbuddy: workbuddyAdapter,
    lobsterai: lobsteraiAdapter,
    qoder: qoderAdapter,
    trae: traeAdapter,
  }
  // Antigravity 的适配器实例只在它已注册时登记。`getRegisteredAntigravityAdapter()`
  // 类型上是可选的（注册函数返回的是注销函数而非实例），故此处按需取值，
  // 避免把 `undefined` 塞进 `modelAdapters` 而破坏其类型契约。
  const antigravityAdapter = getRegisteredAntigravityAdapter()
  if (antigravityAdapter !== undefined) {
    modelAdapters[ANTIGRAVITY_PROVIDER] = antigravityAdapter
  }

  registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai, qoder, trae, modelAdapters)
  ctx.provide('accountPool', pool)
}
