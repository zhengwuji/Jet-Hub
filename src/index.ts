import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { registerQoderLlm } from './qoder-adapter.js'
import { registerTraeLlm } from './trae-adapter.js'
import { registerClineLlm } from './cline-adapter.js'
import { registerLoomyLlm, parseLoomyRemoteModels } from './loomy-adapter.js'
import { registerRaccoonLlm } from './raccoon-adapter.js'
import { registerKeyedLlm } from './keyed-adapter.js'
import { registerZcodeLlm } from './zcode-adapter.js'
import { registerAutoclawLlm } from './autoclaw-adapter.js'
import { registerAccioLlm } from './accio-adapter.js'
import { registerCatpawLlm } from './catpaw-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { QoderAuth } from './qoder-auth.js'
import { TraeAuth } from './trae-auth.js'
import { ClineAuth } from './cline-auth.js'
import { LoomyAuth } from './loomy-auth.js'
import { RaccoonAuth } from './raccoon-auth.js'
import { KeyedAuth } from './keyed-auth.js'
import { ZcodeAuth } from './zcode-auth.js'
import { AutoclawAuth } from './autoclaw-auth.js'
import { AccioAuth } from './accio-auth.js'
import { CatpawAuth } from './catpaw-auth.js'
import { LOOMY } from './loomy-product.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import { RACCOON } from './raccoon-product.js'
import { ALL_KEYED_PRODUCTS } from './keyed-product.js'
import { ZCODE, ZCODE_INTL } from './zcode-product.js'
import { AUTOCLAW, AUTOCLAW_INTL } from './autoclaw-product.js'
import { ACCIO, ACCIO_CN } from './accio-product.js'
import { CATPAW } from './catpaw-product.js'
import { AccountPool } from './account-pool.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import { broadcastCatalogChanged, buildRaccoonNickname, registerJetHubRpc } from './jet-hub-rpc.js'
import { ALL_PRODUCTS, CODEBUDDY, CODEBUDDY_INTL, WORKBUDDY, WORKBUDDY_CN } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE, TRAE_INTL } from './trae-product.js'
import { CLINE } from './cline-product.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import type { QoderCredential } from './qoder.js'
import type { TraeCredential } from './trae.js'
import type { ClineCredential } from './cline.js'
import type { LoomyCredential } from './loomy.js'
import type { RaccoonCredential } from './raccoon.js'
import type { KeyedCredential } from './keyed.js'
import { parseKeyedCredential } from './keyed.js'
import type { ZcodeCredential } from './zcode.js'
import { parseZcodeCredential } from './zcode.js'
import type { AutoclawCredential } from './autoclaw.js'
import { parseAutoclawCredential } from './autoclaw.js'
import type { AccioCredential } from './accio.js'
import { parseAccioCredential } from './accio.js'
import type { CatpawCredential } from './catpaw.js'
import { parseCatpawCredential } from './catpaw.js'

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
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `codearts-auth`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - 它是六个 provider 各自 `registerConfigurableProviders({ settingsNs })` 的
 *   落地位置（0.1.7 下 `settingsNs` = 本条目 id），模型设置页据此把 provider
 *   判定为「已配置」（判据见 `dsh-client-ui-settings-models` 的 `configured`）；
 * - 本插件的凭据与账号管理**不**走这里（那是 Jet Hub 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
const providersSchema = Schema.dict(Schema.any()).default({})

export const Config = Schema.object({
  providers: typeof (providersSchema as any)?.volatile === 'function'
    ? (providersSchema as any).volatile()
    : providersSchema,
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * - **≤0.1.6**：`ctx.settings` 允许插件注册任意 namespace，六个 provider 各占
 *   一个（`llm-buddy` / `llm-workbuddy` / ...）。注册缺失会让模型设置页在
 *   `refFor → deriveKeyRef(provider)` 处以
 *   `provider.toUpperCase is not a function` 崩溃，故注册后回读 `describe()` 自检。
 * - **0.1.7-rc.1**：settings 换成 `SettingsForms`，**没有 `register`**，命名
 *   空间只能是 profile 条目 id —— 此时不再（也无法）注册；各 provider 的
 *   `settingsNs` 由 `settingsNamespaceFor()` 指向本插件条目 id，模型设置页照常
 *   工作。这里刻意**静默跳过**：旧实现在这条分支上会打一条误导性的
 *   「settings 服务不可用」告警（启动日志实证）。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
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
  // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下需要**：
  registerProviderSettings(
    ctx,
    'llm-buddy', 'llm-buddy-intl', 'llm-workbuddy-cn', 'llm-workbuddy',
    'llm-codearts', 'llm-lobsterai',
    'llm-qoder', 'llm-qoder-cn', 'llm-trae', 'llm-trae-intl',
    'llm-cline', 'llm-loomy', 'llm-raccoon', 'llm-commandcode', 'llm-opencode-zen',
    'llm-zcode', 'llm-zcode-intl',
    'llm-autoclaw', 'llm-autoclaw-intl',
    'llm-accio', 'llm-accio-cn',
    'llm-catpaw',
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
    // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
    // 后者在 Jet Hub 登录路径下根本不存在，会把 401 报成「未配置凭据」
    // 并自锁。详见 createPoolRefresh 的注释。
    refresh: createPoolRefresh(pool, 'buddy', buddy),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== CodeBuddy 国际版（www.codebuddy.ai）服务 =====
  // ⚠️ **必须保留**：客户端 PROVIDERS 里有「CodeBuddy (国际版)」面板，
  // 且合并前的本地版本就注册过它。合并时一度删掉 → 面板成空壳、已有
  // `buddy-intl` 账号成孤儿。与国际版同源（同 BuddyAdapter），仅 endpoint 不同。
  const buddyIntl = new BuddyAuth(ctx, { product: CODEBUDDY_INTL })
  const buddyIntlAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(CODEBUDDY_INTL.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(CODEBUDDY_INTL.id, '')
      if (available) return available.credential as BuddyCredential
      const resolved = await ctx.credentials.resolve(credentialRef(CODEBUDDY_INTL.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => buddyIntl.refresh(),
    fetchRemoteModels: () => buddyIntl.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CODEBUDDY_INTL,
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
    // 同上：必须刷池内账号（`WORKBUDDY_ACCESS_TOKEN` 从未被写入过）。
    // 这条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refresh: createPoolRefresh(pool, 'workbuddy', workbuddy),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== WorkBuddy 国内版（copilot.tencent.com）服务 =====
  // ⚠️ **必须保留**：用户账号池里存在 `workbuddy-cn` 账号（历史遗留），
  // 合并时一度删掉这份注册，导致该面板成空壳、账号成孤儿。
  // 与国际版同源（同 BuddyAdapter），仅 endpoint 不同。
  const workbuddyCn = new BuddyAuth(ctx, { product: WORKBUDDY_CN })
  const workbuddyCnAdapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY_CN.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(WORKBUDDY_CN.id, '')
      if (available) return available.credential as BuddyCredential
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY_CN.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => workbuddyCn.refresh(),
    fetchRemoteModels: () => workbuddyCn.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: WORKBUDDY_CN,
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
  //
  // **两个区域分别注册**（国际版 `qoder` / 国内版 `qoder-cn`）：官方是同一代码库
  // 的两个构建（`build.site` 分 global / cn，见 src/qoder-product.ts 的端注释），
  // 端点全不同且账号体系独立，故与 buddy / workbuddy 一样各自成实例、互不覆盖。
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

  // ===== Qoder 国内版（Qoder CN）服务 =====
  // 与上面的国际版共用 QoderAdapter，端点差异全部由 product 配置承载。
  // 服务名由 product.id 派生 → 注册为 ctx['qoder-cnAuth']，与国际版互不覆盖。
  const qoderCn = new QoderAuth(ctx, { product: QODER_CN })
  const qoderCnAdapter = registerQoderLlm(ctx, {
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 `qoder-cn` 的账号池取号，回退到国内版自己的单凭据 ref ——
      // 绝不回退到国际版 ref（两者登录态不通，串用必然 401）。
      const available = await pool.getAvailableAccount(QODER_CN.id, '')
      if (available) return available.credential as QoderCredential
      const resolved = await ctx.credentials.resolve(credentialRef(QODER_CN.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as QoderCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(QODER_CN.id, '')
      if (available) await qoderCn.refreshAccountCredential(available.entry.credentialRef)
      else await qoderCn.refresh()
    },
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: QODER_CN,
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

  // ===== TRAE 国际版（Trae / trae.ai）服务 =====
  // 与国内版是**两个独立客户端**（本机实测 `Trae` 与 `Trae CN` 各一套用户数据），
  // 协议一致、仅域名不同 —— 共用同一个 TraeAdapter，差异全部由 TRAE_INTL 承载。
  // 登录态互不相通，故独立 provider 与独立凭据 ref。
  // 服务名由 product.id 派生 → 注册为 ctx['trae-intlAuth']。
  const traeIntl = new TraeAuth(ctx, { product: TRAE_INTL })
  const traeIntlAdapter = registerTraeLlm(ctx, {
    credentialRef: credentialRef(TRAE_INTL.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 `trae-intl` 的账号池取号，回退到国际版自己的 ref。
      const available = await pool.getAvailableAccount(TRAE_INTL.id, '')
      if (available) return available.credential as TraeCredential
      const resolved = await ctx.credentials.resolve(credentialRef(TRAE_INTL.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as TraeCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(TRAE_INTL.id, '')
      if (available) await traeIntl.refreshAccountCredential(available.entry.credentialRef)
      else await traeIntl.refresh()
    },
    fetchRemoteModels: () => traeIntl.fetchModels(pool),
    // 图片能力与国内版一致：按模型判定（远端 display_config.multimodal），
    // 这里只负责读字节。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: TRAE_INTL,
  })

  // ===== Cline（Cline 桌面端 / Cline API）服务 =====
  // 第七个产品线，协议与前面六者**都不同源**：登录是 **WorkOS 设备码轮询**
  // （api.workos.com，不起本地回调端口），鉴权头是 `Bearer workos:<jwt>`
  // （前缀**不可剥**），推理是**标准 OpenAI 兼容**端点。
  // 服务名由 ClineAuth 依 product.id 派生，注册为 ctx.clineAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Cline 面板。
  const cline = new ClineAuth(ctx)
  const clineAdapter = registerClineLlm(ctx, {
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 Cline 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 CLINE.id 而非字面量 'cline'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(CLINE.id, '')
      if (available) return available.credential as ClineCredential
      const resolved = await ctx.credentials.resolve(credentialRef(CLINE.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as ClineCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      const available = await pool.getAvailableAccount(CLINE.id, '')
      if (available) await cline.refreshAccountCredential(available.entry.credentialRef)
      else await cline.refresh()
    },
    // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
    // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CLINE,
  })

  // ===== Loomy（讯飞办公助手）服务 =====
  // 第八个产品线，与前面七者**都不同源**：登录是**短信验证码**
  // （讯飞 CAccount，HMAC-SHA1 签名，没有 loginUrl 可打开），
  // 推理是标准 OpenAI 兼容（复用 openai-compat.ts）。
  // 服务名由 LoomyAuth 依 product.id 派生，注册为 ctx.loomyAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Loomy 面板。
  const loomy = new LoomyAuth(ctx)

  /**
   * 按凭据 ref 解析 Loomy 凭据（供选号器与兜底路径共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处。
   */
  const resolveLoomyCredentialByRef = async (refName: string): Promise<LoomyCredential | undefined> => {
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as LoomyCredential
    } catch {
      return undefined
    }
  }

  /**
   * Loomy 的**按余额优先选号器**（负载均衡）。
   *
   * ⚠️ **为什么需要它**（真实缺陷）：实测 Loomy 的今日赠送额度（每天 5000）
   * 耗尽后，服务端**继续扣永久积分且不报错** —— 「耗尽」是**静默降级**而非错误。
   * 而本插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
   * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
   *
   * 策略：优先有今日额度的号 → 其次有永久积分的号 → 都无/查不到排最后。
   * 档内保持手动拖拽顺序（详见 `loomy-balance-rank.ts`）。
   */
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef,
  })

  const loomyAdapter = registerLoomyLlm(ctx, {
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    /**
     * 解析本轮该用哪个账号的凭据。
     *
     * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
     * 的签名说明）—— **必须透传给 `getAvailableAccount`**，否则模型级限流
     * 过滤失效（早期实现传空串 `''`，等于「不按模型过滤」）。
     */
    resolveCredential: async (modelId?: string) => {
      // 只从 Loomy 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 LOOMY.id 而非字面量 'loomy'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      //
      // ⚠️ 先按「模型未受限 + 未停用」筛出候选，**再**按余额分档选号。
      // 余额排序只在这批候选内部进行 —— 即你的要求：
      // 「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
      const candidates = pool
        .listAccountsByProvider(LOOMY.id)
        .filter(a => a.enabled)
        .filter((a) => {
          // 与 `getAvailableAccount` 的限流判据保持一致（空 modelId = 不过滤）。
          const key = modelId ?? ''
          if (key.length === 0) return true
          if (!a.modelRateLimits) return true
          const resetAt = a.modelRateLimits[key]
          return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
        })
        .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

      // 「锁定永久积分」：只允许消耗今日赠送额度（用户要求，且持久化）。
      const allowPermanent = !pool.loomyPermanentLocked()

      if (candidates.length > 0) {
        const picked = await loomyBalanceSelector.select(candidates, { allowPermanent })
        if (picked !== undefined) {
          const credential = await resolveLoomyCredentialByRef(picked.account.credentialRef)
          if (credential !== undefined) return credential
        } else if (!allowPermanent) {
          // ⚠️ **锁定时绝不可落到下面的单凭据兜底** —— 那会绕过锁定、
          // 照样消耗永久积分，锁定形同虚设。这里直接抛明确错误（用户要求）。
          throw new Error(
            'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽'
            + '（或余额查询失败）。请在 Jet Hub 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
          )
        }
      }

      // 兜底：账号池为空/全部不可解析时，退回单凭据 ref。
      const resolved = await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // ⚠️ Loomy **没有 refresh 端点**，这里的 `refresh` 语义是
      // 「探测凭据是否仍有效」，失效时抛错提示重新登录。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则探测的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      if (available) await loomy.refreshAccountCredential(available.entry.credentialRef)
      else await loomy.refresh()
    },
    // 远端模型目录：GET /api/v1/models。
    // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
    // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount(LOOMY.id, '')
      const resolved = available !== null && available !== undefined
        ? { value: JSON.stringify(available.credential) }
        : await ctx.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
      if (resolved === undefined) return []
      let credential: LoomyCredential
      try {
        credential = JSON.parse(resolved.value) as LoomyCredential
      } catch {
        return []
      }
      const response = await fetch(`${LOOMY.apiBase}/models`, {
        headers: { Accept: 'application/json', token: credential.access_token },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return []
      return parseLoomyRemoteModels(await response.json())
    },
    // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: LOOMY,
  })

  // ===== Raccoon Work（商汤小浣熊）服务 =====
  // 第九个产品线。登录与 Loomy 同型（**本地页承载**的微信扫码 + 短信双路径），
  // 但**有** refresh 端点（凭据可静默续期），且客户端可能未安装。
  //
  // ⚠️ **不依赖客户端**：官方桌面端靠 `office-raccoon://auth/callback` 自定义协议
  // 回调，本插件（宿主侧 Node 进程）收不到；故改为「宿主本地生成 code + 自行轮询」，
  // 完全绕开该回调。凭据存插件自有的 ctx.credentials，不读客户端任何文件。
  // 见 tests/unit/raccoon-client-independence.spec.ts 的回归防线。
  //
  // 服务名由 RaccoonAuth 依 product.id 派生，注册为 ctx.raccoonAuth。
  // 不注册斜杠命令：入口在 Jet Hub 的 Raccoon 面板。
  const raccoon = new RaccoonAuth(ctx)
  const raccoonAdapter = registerRaccoonLlm(ctx, {
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 raccoon 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 RACCOON.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(RACCOON.id, '')
      // `getAvailableAccount` 的凭据类型是 `CodeArtsCredential | BuddyCredential`
      // 联合（历史遗留），与 `RaccoonCredential` 无充分重叠，故经 `unknown` 转换。
      // 运行时安全性由 provider 过滤保证：查询用 `RACCOON.id`，取到的必是 raccoon 凭据。
      if (available) return available.credential as unknown as RaccoonCredential
      const resolved = await ctx.credentials.resolve(credentialRef(RACCOON.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as RaccoonCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // ⚠️ raccoon **有** refresh 端点（与 Loomy 恒 false 不同），这里是真续期。
      //
      // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
      const available = await pool.getAvailableAccount(RACCOON.id, '')
      if (available) {
        // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
        // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
        //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
        // 这条路径正是「发消息时按需续期」，故它是最常触发回写的地方。
        await raccoon.refreshAccountCredential(
          available.entry.credentialRef, pool, available.entry.id,
        )
      } else {
        await raccoon.refresh()
      }
    },
    // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
    // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
    // 失败时返回空数组，由适配器回退兜底表。
    fetchRemoteModels: () => raccoon.fetchModels(pool),
    // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: RACCOON,
  })

  // 一次性修复**老账号**的昵称与凭据字段（与上面 WorkBuddy 的启动清理同类）。
  //
  // 早期实现把服务端的 `name` 直接当昵称用，而实测它是**自动生成的默认名**
  //（本机账号是 `RaccoonAva`），注册第二个账号时会重名、无法区分；
  // 且凭据里没存 `phone`（后来才发现 `user_info.phone` 可用于消歧）。
  // 光改代码只影响新登录的账号，故这里主动补一次：
  // 拉 `user_info` 补 `phone`，并用 `buildRaccoonNickname` 重算昵称。
  //
  // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
  void raccoon.repairAccountNicknames(pool, buildRaccoonNickname).then((repaired) => {
    if (repaired.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已修正 ${repaired.length} 个 Raccoon 账号的显示名（追加手机号尾号以便区分）：${repaired.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 修正 Raccoon 账号显示名失败：${String(error)}`)
  })

  // ===== ZCode（智谱 / Z.AI 编码代理客户端）服务 =====
  // 第十个产品线，与前面九者**都不同源**：登录是**服务端中介的 CLI 轮询**
  // （`/oauth/cli/init` + `/oauth/cli/poll/{flow_id}`，不起本地回调端口 ——
  // 造一个带 localhost redirect_uri 的授权地址会被上游拒），
  // 且登录后**必须再换一次**推理凭证（OAuth 的 access_token 不是推理凭证，
  // 直接拿去打 /chat/completions 必 401）。
  //
  // 两个区域分别注册（国内 `zcode` / 国际 `zcode-intl`）：zcode 平面两地相同
  // （都是 zcode.z.ai），只有**推理平面**不同（open.bigmodel.cn / api.z.ai），
  // 登录态互不相通，故与 qoder / trae 一样各自成实例、互不覆盖。
  //
  // 服务名由 ZcodeAuth 依 product.id 派生 → ctx.zcodeAuth / ctx['zcode-intlAuth']。
  // 不注册斜杠命令：入口在 Jet Hub 的 ZCode 面板。
  const zcode = new ZcodeAuth(ctx, { product: ZCODE })
  const zcodeAdapter = registerZcodeLlm(ctx, {
    credentialRef: credentialRef(ZCODE.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 zcode 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 ZCODE.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(ZCODE.id, '')
      if (available) return parseZcodeCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(ZCODE.defaultCredentialRef))
      if (!resolved) return undefined
      return parseZcodeCredential(resolved.value)
    },
    refresh: async () => {
      // ⚠️ 本家**不可续期**（上游没有 refresh 端点）：这里的语义是「如实报错
      // 让用户重新登录」，而不是「换个新令牌」。仍须针对**解析凭据时所用的
      // 那一个**账号，而不是默认单凭据 ref。
      const available = await pool.getAvailableAccount(ZCODE.id, '')
      if (available) await zcode.refreshAccountCredential(available.entry.credentialRef)
      else await zcode.refresh()
    },
    // 图片字节桥接：ZCode 的视觉档（glm-4.6v / glm-5v-turbo）支持图片，
    // 模态按模型判定（静态表的 supportsImage）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: ZCODE,
  })

  // ===== ZCode 国际版（Z.AI）服务 =====
  // 与国内版共用 ZcodeAdapter，端点与 OAuth 的 provider 取值差异全部由
  // product 配置承载。登录态互不相通，故独立 provider 与独立凭据 ref。
  const zcodeIntl = new ZcodeAuth(ctx, { product: ZCODE_INTL })
  const zcodeIntlAdapter = registerZcodeLlm(ctx, {
    credentialRef: credentialRef(ZCODE_INTL.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 `zcode-intl` 的账号池取号，回退到国际版自己的 ref ——
      // 绝不回退到国内版 ref（两者登录态不通，串用必然 401）。
      const available = await pool.getAvailableAccount(ZCODE_INTL.id, '')
      if (available) return parseZcodeCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(ZCODE_INTL.defaultCredentialRef))
      if (!resolved) return undefined
      return parseZcodeCredential(resolved.value)
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(ZCODE_INTL.id, '')
      if (available) await zcodeIntl.refreshAccountCredential(available.entry.credentialRef)
      else await zcodeIntl.refresh()
    },
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: ZCODE_INTL,
  })

  // ===== AutoClaw（智谱 autoglm）服务 =====
  // 第十一个产品线。**国内版与国际版是两家 provider**（与 AutoClaw 的两个地区
  // 同一思路：地区做成账号的属性会让「哪个账号走哪个站点」看不出来）。
  //
  // 两家**共用一套实现**（`AutoclawAdapter` 持有一个 product），差异只有：
  //   · 上游域名（zhipuai.cn / autoglm.ai）
  //   · 登录方式：国内版**手机验证码**、国际版 **Zai/Google 网页 OAuth**
  //   · 订阅接口路径
  //
  // ⚠️ 认证头是 **`X-Authorization`**（不是 `Authorization`）—— 发错稳定 401。
  // ⚠️ 出站 system 提示词必须过白名单改写（`normalizeAutoclawSystemMessages`）：
  //    上游 2026-09-22 起对 system 做**字面**校验，带外来身份句会 403/406。
  // 服务名由 AutoclawAuth 依 product.id 派生 → ctx.autoclawAuth / ctx['autoclaw-intlAuth']。
  const autoclaw = new AutoclawAuth(ctx, { product: AUTOCLAW })
  const autoclawAdapter = registerAutoclawLlm(ctx, {
    credentialRef: credentialRef(AUTOCLAW.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 autoclaw 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 AUTOCLAW.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(AUTOCLAW.id, '')
      if (available) return parseAutoclawCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(AUTOCLAW.defaultCredentialRef))
      if (!resolved) return undefined
      return parseAutoclawCredential(resolved.value)
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
      // 两者错配会让「刚登录好却一直认证失败」（本插件在 LobsterAI 上踩过）。
      const available = await pool.getAvailableAccount(AUTOCLAW.id, '')
      if (available) await autoclaw.refreshAccountCredential(available.entry.credentialRef)
      else await autoclaw.refresh()
    },
    fetchRemoteModels: () => autoclaw.fetchModels(pool),
    // 图片字节桥接：glm-5.3-flash 支持图片（远端 input 含 image）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: AUTOCLAW,
  })

  // ===== AutoClaw 国际版（autoglm.ai）服务 =====
  // 与国内版共用 AutoclawAdapter，差异全部由 product 配置承载。
  // ⚠️ 国际版走 **OAuth 网页登录**（国内版是手机验证码），且回调端口有白名单
  // （`AUTOCLAW_CALLBACK_PORTS`，Zai 逐字校验且 host 必须是 `localhost`）。
  const autoclawIntl = new AutoclawAuth(ctx, { product: AUTOCLAW_INTL })
  const autoclawIntlAdapter = registerAutoclawLlm(ctx, {
    credentialRef: credentialRef(AUTOCLAW_INTL.defaultCredentialRef),
    resolveCredential: async () => {
      const available = await pool.getAvailableAccount(AUTOCLAW_INTL.id, '')
      if (available) return parseAutoclawCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(AUTOCLAW_INTL.defaultCredentialRef))
      if (!resolved) return undefined
      return parseAutoclawCredential(resolved.value)
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(AUTOCLAW_INTL.id, '')
      if (available) await autoclawIntl.refreshAccountCredential(available.entry.credentialRef)
      else await autoclawIntl.refresh()
    },
    fetchRemoteModels: () => autoclawIntl.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: AUTOCLAW_INTL,
  })

  // ===== Accio（阿里 Accio Work）服务 =====
  // 第十二个产品线，上游不是 OpenAI 协议而是**阿里 ADK 的 Gemini 风格信封**
  // （`POST /api/adk/llm/generateContent`，SSE，token 放在 **body** 里而不是头），
  // 因此适配器自己完成「构造 → 发送 → 翻译」，与 Qoder / CatPaw 同一处境。
  //
  // 两家**共用一套实现**（`AccioAdapter` 持有一个 product），差异只有三处：
  //   · 登录站点（www.accio.com / www.accio-ai.com）
  //   · `x-package-region`（GLOBAL / CN）
  //   · provider id 与账号 id 前缀
  // 业务网关与推理网关是**同一个 host**，client_id 两地逐字相同。
  //
  // 服务名由 AccioAuth 依 product.id 派生 → ctx.accioAuth / ctx['accio-cnAuth']。
  const accio = new AccioAuth(ctx, { product: ACCIO })
  const accioAdapter = registerAccioLlm(ctx, {
    credentialRef: credentialRef(ACCIO.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 accio 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 ACCIO.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(ACCIO.id, '')
      if (available) return parseAccioCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(ACCIO.defaultCredentialRef))
      if (!resolved) return undefined
      return parseAccioCredential(resolved.value)
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      // ⚠️ 传 pool + accountId：续期成功后要把新的 expiresAt 写回账号池，
      // 否则 UI 会一直显示「已过期」而实际能正常发消息（raccoon 踩过的坑）。
      const available = await pool.getAvailableAccount(ACCIO.id, '')
      if (available) await accio.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await accio.refresh()
    },
    fetchRemoteModels: () => accio.fetchModels(pool),
    // 图片字节桥接：目录 `multimodal` 为真才播报图片能力（按模型判定）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: ACCIO,
  })

  // ===== Accio 国内版（www.accio-ai.com）服务 =====
  // 与上面的国际版共用 AccioAdapter，差异全部由 product 配置承载。
  // 服务名由 product.id 派生 → 注册为 ctx['accio-cnAuth']，与国际版互不覆盖。
  const accioCn = new AccioAuth(ctx, { product: ACCIO_CN })
  const accioCnAdapter = registerAccioLlm(ctx, {
    credentialRef: credentialRef(ACCIO_CN.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 `accio-cn` 的账号池取号，回退到国内版自己的单凭据 ref ——
      // 绝不回退到国际版 ref（两者登录态不通，串用必然 401）。
      const available = await pool.getAvailableAccount(ACCIO_CN.id, '')
      if (available) return parseAccioCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(ACCIO_CN.defaultCredentialRef))
      if (!resolved) return undefined
      return parseAccioCredential(resolved.value)
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount(ACCIO_CN.id, '')
      if (available) await accioCn.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await accioCn.refresh()
    },
    fetchRemoteModels: () => accioCn.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: ACCIO_CN,
  })

  // ===== CatPaw（美团 AI 客户端）服务 =====
  // 第十三个产品线，也是**最难**的一家：上游不是 OpenAI 协议，而是一套自有的
  // **conversation 会话协议**（round → event(running) → turn(SSE) → 工具循环
  // → event(completed)），一次客户端请求对应多个上游请求，中间还要维护
  // 「x-session-id → conversationId」映射与已同步消息的指纹链。
  //
  // 因此适配器是**有状态**的（`is_stateful` 语义）：会话注册表只在进程内，
  // 重启后自然回落到「全新会话 + 全量历史」，功能不受影响。
  //
  // ⚠️ 凭据是桌面端会话 Cookie 里的 `X-Passport-Token` + 独立的 `uid` 头
  //    （token 不是 JWT，不含 uid），且**没有 refreshToken** —— 过期只能重新登录。
  // 服务名由 CatpawAuth 派生 → ctx.catpawAuth。不注册斜杠命令。
  const catpaw = new CatpawAuth(ctx, { product: CATPAW })
  const catpawAdapter = registerCatpawLlm(ctx, {
    credentialRef: credentialRef(CATPAW.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 catpaw 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用其它 provider 的凭据。
      // provider 实参用 CATPAW.id 而非字面量：写死字面量在改名/多产品场景下
      // 会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(CATPAW.id, '')
      if (available) return parseCatpawCredential(available.credential)
      const resolved = await ctx.credentials.resolve(credentialRef(CATPAW.defaultCredentialRef))
      if (!resolved) return undefined
      return parseCatpawCredential(resolved.value)
    },
    refresh: async () => {
      // ⚠️ 本家**没有 refreshToken、没有续期端点**：这里的语义是「如实报错
      // 让用户重新登录」（与 Loomy / ZCode 同型）。仍须针对**解析凭据时所用的
      // 那一个**账号，而不是默认单凭据 ref。
      const available = await pool.getAvailableAccount(CATPAW.id, '')
      if (available) await catpaw.refreshAccountCredential(available.entry.credentialRef)
      else await catpaw.refresh()
    },
    fetchRemoteModels: () => catpaw.fetchModels(pool),
    // 图片字节桥接：上游**不拉取 http(s) 图片**，只能内联 data URL；过大时
    // 适配器会如实省略而不是发一个必然 504 的请求（见适配器模块头）。
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CATPAW,
  })

  // ===== 「粘贴 API Key」族（commandcode / opencode）=====
  // 这两个 provider 与其余 12 个**形态完全不同**：凭据由用户在前端弹窗里
  // 粘贴（`login.submitKey`），插件负责校验后持久化。
  //
  // ⚠️ 三点本质差异（改动前务必理解，否则会写出看似合理但永远不生效的代码）：
  //
  // 1. **没有 `startLogin()`**。`account.create` 对它只建占位条目并立即返回
  //    `loginMode: 'key'`，一个网络请求都不发（见 `src/rpc/account.ts`）。
  // 2. **没有续期**。Key 是手工粘贴的，两个平台都不提供「用 Key 换新 Key」
  //    的端点 ⇒ `refreshable` 恒 false，`refreshAll()` 是空操作（但保留，
  //    否则 `refreshAllCredentials()` 得为它加特例分支）。
  // 3. **没有签到、没有余额查询**。能力表登记
  //    `{ balance: false, dailyCheckin: false }` —— 用户自带 Key 的额度由
  //    **对方平台**决定，本插件无从查询，也不该编造。
  //
  // ⚠️ **Key 校验必须打 chat 端点，不能用 `GET /models`**：实测两个平台的
  // 目录端点都不鉴权（无 Key 同样返回 200 + 完整模型列表），拿它当校验会让
  // 任意字符串都被判「有效」。详见 `src/keyed-auth.ts` 的文件头注释。
  //
  // 服务名由 `KeyedAuth` 派生，注册为 `ctx.commandcodeAuth` / `ctx.opencodeAuth`。
  const keyedServices = new Map<string, KeyedAuth>()
  const keyedAdapters = new Map<string, ReturnType<typeof registerKeyedLlm>>()
  for (const product of ALL_KEYED_PRODUCTS) {
    const productId = product.id
    const auth = new KeyedAuth(ctx, { product })
    keyedServices.set(productId, auth)
    const adapter = registerKeyedLlm(ctx, {
      product,
      credentialRef: credentialRef(product.defaultCredentialRef),
      resolveCredential: async () => {
        // 与其余 provider 同款：只从自己的账号池取号，回退到自己的单凭据 ref。
        // provider 实参用 `product.id` 而非字面量 —— 写死字面量在改名场景下会
        // 静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
        const available = await pool.getAvailableAccount(productId, '')
        // `getAvailableAccount` 的凭据类型是 `CodeArtsCredential | BuddyCredential`
        // 联合（历史遗留），与 `KeyedCredential` 无充分重叠，故经 `unknown` 转换。
        // 运行时安全性由 provider 过滤保证：查询用 `productId`，取到的必是本族凭据。
        if (available) return available.credential as unknown as KeyedCredential
        const resolved = await ctx.credentials.resolve(credentialRef(product.defaultCredentialRef))
        if (!resolved) return undefined
        return parseKeyedCredential(resolved.value)
      },
      // 按账号解析：同一产品下用户可以贴多个 Key（各自的权益不同），
      // 故模型目录必须逐账号聚合，选号也要按「该账号支持该模型」亲和。
      resolveCredentialForAccount: async (accountId) => {
        const parsed = await pool.resolveCredentialForAccount(accountId)
        if (parsed === undefined) return undefined
        // `resolveCredentialForAccount` 的返回类型是历史遗留的联合类型，
        // 与 `KeyedCredential` 无充分重叠，故经 `unknown` 转换。
        // 运行时安全性由 provider 过滤保证：这里的 accountId 必属本产品。
        return parsed as unknown as KeyedCredential
      },
      listAccountEntries: async () =>
        pool.listAccountsByProvider(productId).map(entry => ({ id: entry.id, credentialRef: entry.credentialRef })),
      refresh: async () => {
        // ⚠️ 本族无续期端点：这里的 `refresh` 语义是「探测 Key 是否仍有效」
        // （与 Loomy 同型）。探测的是**解析凭据时所用的那一个**账号，而不是
        // 默认单凭据 ref —— 否则探的是别的 Key，用户会看到「刚贴好却一直认证失败」。
        const available = await pool.getAvailableAccount(productId, '')
        if (available) await auth.refreshAccountCredential(available.entry.credentialRef)
      },
      // ⚠️ 不传 `readImage`：两个平台的 `/models` 都不含多模态声明，无法可靠
      // 判定 ⇒ 按不支持的负能力处理（播报 text-only，遇到图片明确报错），而不是猜。
      accountPool: pool,
      // 目录/凭据告警出口。适配器拿不到 `ctx`，且 `src/` 的 `console.*` 是
      // 只可下调的棘轮基线，故由这里把宿主的 logger 绑进去。
      warn: (message: string) => ctx.logger.warn(message),
      // ⚠️ 目录内容变化（平台上新模型、用户新增/删除账号）时必须广播
      // `llm/adapters-updated`：客户端的 `ModelCatalogDirectory` 在
      // `status === 'ready'` 时**短路返回缓存**，只在宿主事件上 refresh。
      // 少这一句的话，服务端内存里的目录已经是最新的，用户界面却仍要重启
      // DSH 才看得到 —— 与「关闭模型不生效」是同一处坑。
      // 适配器只在模型 id 集合**真的变了**时才回调，故不会造成事件风暴。
      onCatalogChanged: () => broadcastCatalogChanged(ctx),
    })
    keyedAdapters.set(productId, adapter)
  }

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
      await buddyIntl.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await workbuddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await workbuddyCn.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await lobsterai.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await qoder.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await qoderCn.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await trae.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await traeIntl.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await cline.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      // ⚠️ Loomy 不可续期：这里只探测**已过期**的账号（见 LoomyAuth.refreshAll）。
      await loomy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
    // raccoon **可续期**：只按 refreshable 过滤，且只续期已过期的账号。
    await raccoon.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      // ⚠️ ZCode 不可续期（无 refresh 端点）：这里是**标记纠正**（把误标的
      // refreshable 改回 false），不是续期。见 ZcodeAuth.refreshAll。
      await zcode.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await zcodeIntl.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await autoclaw.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await autoclawIntl.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await accio.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await accioCn.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      // ⚠️ CatPaw 不可续期（无 refreshToken）：这里是**标记纠正**，
      // 把误标的 refreshable 改回 false，避免调度器每轮白试。
      await catpaw.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      // ⚠️ 本族恒不可续期（Key 由用户手工粘贴），这里是**空操作**。
      // 保留调用只为与其余 provider 形态一致 —— 否则这里得为它们加特例分支。
      for (const auth of keyedServices.values()) await auth.refreshAll(pool)
    } catch { /* 静默 */ }
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
        buddyIntl.stop()
        workbuddy.stop()
        workbuddyCn.stop()
        lobsterai.stop()
        qoder.stop()
        qoderCn.stop()
        trae.stop()
        traeIntl.stop()
        cline.stop()
        loomy.stop()
        raccoon.stop()
        zcode.stop()
        zcodeIntl.stop()
        autoclaw.stop()
        autoclawIntl.stop()
        accio.stop()
        accioCn.stop()
        catpaw.stop()
      }, 'jet-hub: multi-account refresh scheduler')
    }
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    buddyIntl.stop()
    workbuddy.stop()
    workbuddyCn.stop()
    lobsterai.stop()
    qoder.stop()
    qoderCn.stop()
    trae.stop()
    traeIntl.stop()
    cline.stop()
    loomy.stop()
    raccoon.stop()
    zcode.stop()
    zcodeIntl.stop()
    autoclaw.stop()
    autoclawIntl.stop()
    accio.stop()
    accioCn.stop()
    catpaw.stop()
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

  // provider → 适配器实例：Jet Hub「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {
    // `codearts` 是 registerCodeArtsLlm 返回的**适配器实例**（与 CodeArtsAuth
    // 服务实例 `service` 不同名，故这里可以简写）。
    codearts,
    buddy: buddyAdapter,
    'buddy-intl': buddyIntlAdapter,
    workbuddy: workbuddyAdapter,
    'workbuddy-cn': workbuddyCnAdapter,
    lobsterai: lobsteraiAdapter,
    qoder: qoderAdapter,
    'qoder-cn': qoderCnAdapter,
    trae: traeAdapter,
    'trae-intl': traeIntlAdapter,
    cline: clineAdapter,
    loomy: loomyAdapter,
    raccoon: raccoonAdapter,
    zcode: zcodeAdapter,
    'zcode-intl': zcodeIntlAdapter,
    autoclaw: autoclawAdapter,
    'autoclaw-intl': autoclawIntlAdapter,
    accio: accioAdapter,
    'accio-cn': accioCnAdapter,
    catpaw: catpawAdapter,
    // 「粘贴 Key」族的适配器实例：设置页「模型列表」要用它们的 `listAllModels()`
    // （不受黑名单影响的全量目录）。每个产品的目录是**其全部账号模型的并集**。
    ...Object.fromEntries(keyedAdapters),
  }

  // ⚠️ 具名对象传参：少接 / 接错字段是**编译错误**。
  // 此前是 18 个位置参数，新增 provider 时测试侧漏改两处位置实参，
  // 让 2 个用例静默错位（接错服务与接对服务在类型上完全等价）。
  registerJetHubRpc(ctx, {
    pool,
    codearts: service,
    buddy,
    buddyIntl,
    workbuddy,
    workbuddyCn,
    lobsterai,
    qoder,
    qoderCn,
    trae,
    traeIntl,
    cline,
    loomy,
    raccoon,
    zcode,
    zcodeIntl,
    autoclaw,
    autoclawIntl,
    accio,
    accioCn,
    catpaw,
    keyed: keyedServices,
    modelAdapters,
  })
  ctx.provide('accountPool', pool)
}
