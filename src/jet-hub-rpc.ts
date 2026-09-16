/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / antigravity.channelProbe
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { getAntigravityAdapter } from './antigravity-local-adapter.js'
import { readAntigravityCredential } from './antigravity.js'
import { AccountPool } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { BuddyAuth } from './buddy-auth.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js'
import { credentialExpiresAtMs } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import { claimDailyCheckin, fetchCheckinStatus, type CheckinStatus, type ClaimOutcome } from './credits.js'
import { CODEBUDDY, productById, type BuddyProduct } from './product.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
import type {
  ProviderAccountEntry,
  RpcListAccountsRequest,
  RpcListAccountsResponse,
  RpcCreateAccountRequest,
  RpcCreateAccountResponse,
  RpcPollLoginRequest,
  RpcPollLoginResponse,
  RpcUpdateAccountRequest,
  RpcDeleteAccountRequest,
  RpcRefreshAccountRequest,
  RpcRefreshAccountResponse,
  RpcRetestAccountRequest,
  RpcRetestAllRequest,
  RpcResetAccountRequest,
  RpcResetAllRequest,
  RpcCreditsStatusRequest,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllRequest,
  RpcCreditsClaimAllResponse,
  RpcCreditsClaimSummary,
} from './types.js'

/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 */
export interface CreditsEndpointDeps {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: BuddyCredential, product: BuddyProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: BuddyCredential, product: BuddyProduct) => Promise<ClaimOutcome>
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus(
  accounts: readonly ProviderAccountEntry[],
  product: BuddyProduct,
  deps: CreditsEndpointDeps,
): Promise<RpcCreditsStatusResponse['accounts']> {
  const fetchStatus = deps.fetchStatus ?? fetchCheckinStatus
  const results: RpcCreditsStatusResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as BuddyCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
      deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults(
  accounts: readonly ProviderAccountEntry[],
  product: BuddyProduct,
  deps: CreditsEndpointDeps,
): Promise<RpcCreditsClaimAllResponse> {
  const fetchStatus = deps.fetchStatus ?? fetchCheckinStatus
  const claim = deps.claim ?? claimDailyCheckin
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as BuddyCredential
        // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
        const status = await fetchStatus(credential, product)
        if (status !== null && !status.active) {
          outcome = { kind: 'inactive', message: '签到活动未开启' }
        } else if (status !== null && status.todayCheckedIn) {
          outcome = { kind: 'already-claimed', message: '今天已签到' }
        } else {
          // 状态查询失败（status 为 null）时仍然尝试领取：
          // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
          outcome = await claim(credential, product)
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 注册 Jet Hub 管理 API 端点。
 * 使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。
 */
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddyServices: Map<string, BuddyAuth> | BuddyAuth,
  ...rest: BuddyAuth[]
): void {
  const authMap = new Map<string, BuddyAuth>()
  if (buddyServices instanceof Map) {
    for (const [k, v] of buddyServices) authMap.set(k, v)
  } else if (buddyServices) {
    for (const b of [buddyServices, ...rest]) {
      if (b && typeof b === 'object' && 'product' in b && b.product?.id) {
        authMap.set(b.product.id, b)
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  connection.fetch.register({
    path: JET_HUB_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = await request.json() as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== JET_HUB_ENDPOINT
        || !call || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Jet Hub management request.' } })
      }

      try {
        const result = await handleMethod(call.method as string, call.payload, request.signal)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
        // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'jet-hub/handler-failed', message },
        })
      }
    },
  })

  /** 分发端点方法到对应的处理器 */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        if (req.provider === 'antigravity') {
          const adapter = getAntigravityAdapter()
          const cred = readAntigravityCredential()
          const probe = adapter ? await adapter.probeChannels({ force: true }) : undefined
          if (probe?.channel === 'local') {
            const modelCountDesc = probe.local?.modelCount ? ` · ${probe.local.modelCount} 个可用模型` : ''
            const accounts = [
              {
                id: 'antigravity-local',
                provider: 'antigravity',
                nickname: 'Antigravity 本地私有通道',
                enabled: true,
                credentialRef: `本地私有 RPC (PID ${probe.local?.pid ?? '-'}, 端口 ${probe.local?.port ?? '-'}${modelCountDesc})`,
                refreshable: false,
                createdAt: Date.now(),
                isLocalReuse: true,
              },
            ]
            return { ok: true, value: { accounts } }
          }
          if (cred !== undefined) {
            const accounts = [
              {
                id: 'antigravity-local',
                provider: 'antigravity',
                nickname: 'Antigravity IDE 本地凭据',
                enabled: true,
                credentialRef: cred.source ?? '本地 state.vscdb',
                refreshable: false,
                createdAt: Date.now(),
                isLocalReuse: true,
              },
            ]
            return { ok: true, value: { accounts } }
          }
          const accounts = [
            {
              id: 'antigravity-local',
              provider: 'antigravity',
              nickname: 'Antigravity 本地私有通道',
              enabled: true,
              credentialRef: '未检测到运行中的 Antigravity IDE（启动 IDE 后自动连接）',
              refreshable: false,
              createdAt: Date.now(),
              isLocalReuse: true,
            },
          ]
          return { ok: true, value: { accounts } }
        }
        const accounts = await pool.listAccounts(req.provider)
        return { ok: true, value: { accounts } }
      }

      case 'account.create': {
        const req = payload as RpcCreateAccountRequest
        const { provider } = req
        const id = `${provider}-${shortId()}`
        const suffix = shortId().toUpperCase()
        const refPrefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
        const refName = `${refPrefix}_ACCOUNT_${suffix}`

        // CodeBuddy 系（buddy / workbuddy）共用两步登录流程：
        // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
        // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
        // 参数、X-Product-Code、User-Agent），全部由 product 承载。
        const product = productById(provider)
        if (product !== undefined) {
          let state: string
          let authUrl: string
          try {
            const authState = await fetchAuthState(undefined, undefined, product)
            state = authState.state
            // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId
            authUrl = decorateLoginUrl(authState.authUrl, product)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`)
          }
          const ref = credentialRef(refName)
          // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          // 后台异步执行完整登录流程，使用同一个 state
          runBuddyLoginFlow({ openBrowser: () => {}, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access)
            // 续期定时器归属该产品自己的服务实例
            authMap.get(product.id)?.scheduleRefresh()
            const credential = parseBuddyCredential(flow.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((err) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: authUrl } }
        } else if (provider === 'codearts') {
          // codearts login 是 OAuth 回调方式，不支持纯获取 URL
          // 直接同步执行（需等待回调完成）
          const loginResult = await codearts.login({ refName, accountId: id, pool })
          return { ok: true, value: { accountId: id, loginUrl: loginResult.loginUrl } }
        } else {
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }

      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        if (req.accountId === 'antigravity-local') return { ok: true, value: undefined }
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }

      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        if (req.accountId === 'antigravity-local') return { ok: true, value: undefined }
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }

      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          if (entry.provider === 'codearts') {
            await codearts.refresh()
          } else {
            const auth = authMap.get(entry.provider)
            if (auth) {
              await auth.refresh()
            } else {
              throw new Error(`Unknown provider: ${entry.provider}`)
            }
          }
          return { ok: true, value: { success: true } }
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }

      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }

      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
        if (req.accountId === 'antigravity-local') {
          const adapter = getAntigravityAdapter()
          if (adapter) await adapter.probeChannels({ force: true })
          return { ok: true, value: { accounts: [], clearedCount: 0 } }
        }
        const account = await retestAccount(pool, req.accountId)
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length },
        }
      }

      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case 'account.retestAll': {
        const req = payload as RpcRetestAllRequest
        const value = await retestAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 限流标记：重置（不发请求，直接清除）──
      case 'account.reset': {
        const req = payload as RpcResetAccountRequest
        if (req.accountId === 'antigravity-local') {
          return { ok: true, value: { accounts: [], clearedCount: 0 } }
        }
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }

      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        const value = await resetAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      // Antigravity 通道探测：面板据此显示「当前走哪条通道、为什么」。
      //
      // 本渠道不属于账号池体系（见 AGENTS.md 防封号约束），因此这里既不需要
      // provider 参数，也不返回账号列表 —— 界面展示的是**通道**状态，不是账号。
      case 'antigravity.channelProbe': {
        const req = payload as { force?: boolean } | undefined
        const adapter = getAntigravityAdapter()
        if (adapter === undefined) {
          return {
            ok: true,
            value: {
              channel: 'unavailable',
              local: { available: false, reason: 'Antigravity 适配器尚未注册' },
              public: { available: false, reason: 'Antigravity 适配器尚未注册' },
              message: 'Antigravity 适配器尚未注册，请重启 DSH 后重试。',
            },
          }
        }
        // force 由面板的「重测」按钮传入：绕过 60 秒缓存，强制重新探测。
        const probe = await adapter.probeChannels({ force: req?.force === true })
        return { ok: true, value: probe }
      }

      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
      }

      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }

      default:
        return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
}

/** 构造带 rpcId 的响应 JSON */
function reply(rpcId: string, result: unknown): Response {
  const value = typeof result === 'object' && result !== null && (result as Record<string, unknown>).ok === false
    ? { ...result as Record<string, unknown>, error: { ...(result as Record<string, unknown>).error as Record<string, unknown>, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
