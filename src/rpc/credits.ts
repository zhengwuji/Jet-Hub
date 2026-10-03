/**
 * Jet Hub RPC —— 积分端点（`credits.*`：状态 / 一键领取 / 余额）。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。9 个 provider 的能力差异全在这三个方法里。
 *
 * ⚠️ 两处刻意的不对称（勿「顺手统一」）：`credits.balances` 对 Loomy / Raccoon
 * 回 `balance: null` 加可读 error 文案；CodeArts 走真实 `fetchBalance` 而非状态预检。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CodeArtsCredential, RpcCreditsStatusRequest, RpcCreditsStatusResponse, RpcCreditsClaimAllRequest, RpcCreditsClaimAllResponse, RpcCreditsBalancesRequest, RpcCreditsBalancesResponse, RpcCreditsClaimAccountResult } from '../types.js'
import { LOOMY } from '../loomy-product.js'
import type { LoomyCredential } from '../loomy.js'
import { RACCOON } from '../raccoon-product.js'
import type { RaccoonCredential } from '../raccoon.js'
import { LOBSTERAI } from '../lobsterai-product.js'
import { QODER, qoderProductById } from '../qoder-product.js'
import { TRAE, traeProductById } from '../trae-product.js'
import { CLINE } from '../cline-product.js'
import { ZCODE, ZCODE_INTL } from '../zcode-product.js'
import { parseZcodeCredential } from '../zcode.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../autoclaw-product.js'
import { parseAutoclawCredential } from '../autoclaw.js'
import { ACCIO, ACCIO_CN } from '../accio-product.js'
import { parseAccioCredential } from '../accio.js'
import { CATPAW } from '../catpaw-product.js'
import { parseCatpawCredential } from '../catpaw.js'
import type { QoderCredential } from '../qoder.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from '../qoder-credits.js'
import type { TraeCredential } from '../trae.js'
import { fetchClineCreditBalance } from '../cline-credits.js'
import type { ClineCredential } from '../cline.js'
import { fetchCheckinStatus, fetchCreditBalance } from '../credits.js'
import type { CheckinStatus } from '../credits.js'
import { productById } from '../product.js'
import type { BuddyProduct } from '../product.js'
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } from '../lobsterai-credits.js'
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed } from '../codearts-credits.js'
import { claimTraeDailyCheckin, fetchTraeCheckinStatus, fetchTraeCreditBalance } from '../trae-credits.js'
import type { RpcResult, JetHubRpcContext, JetHubRpcServices, JetHubRegionRouting, JetHubCreditsHelpers } from './contracts.js'

/** `credits.*` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type CreditsEndpointDeps = JetHubRpcContext
  & Pick<JetHubRpcServices, 'codearts' | 'buddy' | 'workbuddy' | 'lobsterai' | 'qoder' | 'trae' | 'cline' | 'loomy' | 'raccoon' | 'zcode' | 'zcodeIntl' | 'autoclaw' | 'autoclawIntl' | 'accio' | 'accioCn' | 'catpaw'>
  & Pick<JetHubRegionRouting, 'isQoderProvider' | 'isTraeProvider'>
  & Pick<JetHubCreditsHelpers, 'computeClaimSummary' | 'collectCreditsStatus' | 'collectClaimResults' | 'collectCreditBalances'>

/** 处理 `credits.*` 端点方法。 */
export async function handleCreditsMethod(
  method: string,
  payload: unknown,
  deps: CreditsEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, trae, cline, loomy, raccoon,
    zcode, zcodeIntl,
    autoclaw, autoclawIntl,
    accio, accioCn,
    catpaw,
    isQoderProvider, isTraeProvider, computeClaimSummary, collectCreditsStatus,
    collectClaimResults, collectCreditBalances, } = deps

  switch (method) {
      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // 四个 provider 分属**三套互不相同的协议**，各自在自己的分支里处理：
      //   - CodeBuddy 系（buddy / workbuddy）：`productById()` 取 BuddyProduct，
      //     走 `collectCreditsStatus` 的默认实现；
      //   - `lobsterai`：slot → context 三步，无独立状态端点；
      //   - `codearts`：华为云 SDK-HMAC-SHA256 签名，无独立状态端点。
      //
      // ⚠️ 只有 CodeBuddy 系能经 `productById()` 解析出产品配置；后两者
      // **必须各自提前分支**，否则会落到下面的 bad-request。历史上 CodeArts
      // 就是因此恒回 `unsupported provider: codearts`（客户端在面板挂载时
      // 无条件调用 credits.balances，于是每打开一次设置页都在控制台报错并把
      // 账号卡片标成查询失败）。现在 CodeArts 已有真实实现，该 bad-request
      // 只对**未知** provider 生效。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        if (req.provider === 'codearts') {
          // CodeArts 没有独立的「签到状态」端点：可领状态要经
          // `statistics/plugin`（账户类型）+ `/v1/ops/delivery`（活动列表）
          // 两步才能得到，且语义与 CodeBuddy 的 CheckinStatus 不同构
          //（无 streak_days / daily_credit 等概念）。
          // 故与 LobsterAI 同样如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 没有独立的「签到状态」端点：活动状态要经
          // slot → context 两步才能得到，且语义与 CodeBuddy 的
          // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
          // 故这里如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (isTraeProvider(req.provider)) {
          // TRAE 有签到状态端点，但需要发起 Ug 请求获取（见 claim 内部的多步流程）。
          // 与 LobsterAI/CodeArts 一样如实返回 null，由 claimAll 自行处理预检。
          // 国内版与国际版共用同一套签到协议，故按区域族统一分派。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（对整个 sidecar 二进制做字符串扫描，
          // checkin / check-in / daily / campaign 均无任何 Cline 业务端点命中；
          // 见 src/cline-credits.ts 的模块注释）。如实返回 null，
          // 而不是臆造一份状态对象。
          // ⚠️ 不要拿「WorkBuddy 国际版也没有」做类比 —— 那条 2026-10-01 已被
          // 实测证伪（端点存在、只是活动位不下发；国内版更是有活动）。
          // Cline 的判据是独立的二进制扫描结论。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === LOOMY.id) {
          // Loomy 没有独立的「签到状态」端点：每日额度由 `POST /points/first-login`
          // 触发，其响应自带 `alreadyProcessed`。故与 LobsterAI/CodeArts 同样
          // 如实返回 null，由 claimAll 内部处理幂等。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
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
        const accounts = await pool.listAccounts(req.provider)
        if (isQoderProvider(req.provider)) {
          // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
          // 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
          // （与 LobsterAI 传 false 的理由同类）。
          //
          // ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
          // HTTP 200），已在 claimQoderCampaign 内部处理。
          //
          // ⚠️ 必须按 `req.provider` 取对应区域的产品：两国版端点不同
          // （国际 openapi.qoder.sh / 国内 openapi.qoder.com.cn），
          // 用错会打到对方的账号体系上。
          const qoderProduct = qoderProductById(req.provider) ?? QODER
          const value = await collectClaimResults<QoderCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimQoderDailyCheckin(credential, qoderProduct),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === 'codearts') {
          // CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
          // 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
          // 故 precheckStatus: false 跳过外部那次 CodeBuddy 式的状态查询 ——
          // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
          const value = await collectClaimResults<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimCodeArtsDailyCheckin(credential),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
          //（带缓存，通常无额外网络开销）。
          const clientVersion = await lobsterai.resolveClientVersion()
          const value = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimLobsteraiDailyCheckin(credential, product, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (isTraeProvider(req.provider)) {
          // 国内版与国际版共用同一套签到协议，仅端点不同，故按区域取产品配置。
          const traeProduct = traeProductById(req.provider) ?? TRAE
          const value = await collectClaimResults<TraeCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
            //
            // TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
            // `{code:0, message:"success"}`，与真正领取成功**无法区分**。
            // 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
            // 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
            // 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
            // 判据只能是 status 端点的 `checked_in`。
            fetchStatus: (credential) =>
              fetchTraeCheckinStatus(credential as TraeCredential, traeProduct, fetch),
            claim: (credential, _product, entry) =>
              claimTraeDailyCheckin(
                credential as TraeCredential,
                traeProduct,
                fetch,
                pool.traeCheckinDeviceGenerationFor(entry.id),
                (next) => pool.updateTraeCheckinDeviceGeneration(entry.id, next),
              ),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === LOOMY.id) {
          // Loomy 的「签到」= `POST /points/first-login`（触发每日赠送额度）。
          // ⚠️ 语义**不是**「+5000 积分」：`dailyBalance = dailyQuota - dailyConsumed`，
          // 消耗后不回补。文案由 claimLoomyDailyQuota 的 already-claimed 表达。
          // 领取流程自带幂等判据（`alreadyProcessed`），故不做额外预检。
          const values: RpcCreditsClaimAccountResult[] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                outcome: { kind: 'failed', code: -1, message: '凭据未配置' },
              })
              continue
            }
            let credential: LoomyCredential
            try {
              credential = JSON.parse(resolved.value) as LoomyCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                outcome: { kind: 'failed', code: -1, message: '凭据解析失败' },
              })
              continue
            }
            const outcome = await loomy.claimDailyQuota(credential)
            values.push({ accountId: account.id, nickname: account.nickname, outcome })
          }
          return {
            ok: true,
            value: {
              summary: computeClaimSummary(values.map((v) => v.outcome)),
              results: values,
            } satisfies RpcCreditsClaimAllResponse,
          }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（见 src/cline-credits.ts 的模块注释：
          // 对整个 sidecar 做字符串扫描，无任何 checkin/campaign 业务端点）。
          // 客户端按能力矩阵（`credits-capabilities.js` 的
          // `cline: { balance: true, dailyCheckin: false }`）根本不会渲染
          // 「一键领取积分」按钮、也不会发起本调用；这里显式返回可读错误，
          // 而不是落到下面 `productById` 的 `unsupported provider` 泛化文案
          // —— 后者会让排查者以为是「provider 没注册」，而真相是「该产品无此能力」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Cline 不支持每日签到（其后端没有签到接口）',
            },
          }
        }
        if (req.provider === RACCOON.id) {
          // raccoon **没有签到端点**：每日 300 积分由服务端按日自动发放
          //（账单里的 `daily_grant`，实测注册后 1 分钟即到账），
          // 客户端按能力矩阵（`raccoon: { balance: true, onboardingTasks: true }`，
          // **无** `dailyCheckin`）根本不会渲染「一键领取积分」按钮、也不会发起本调用。
          // 这里显式返回可读错误，而不是落到下面 `productById` 的
          // `unsupported provider` 泛化文案 —— 后者会让排查者以为是
          //「provider 没注册」，而真相是「该产品无此能力」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
            },
          }
        }
        if (req.provider === AUTOCLAW.id || req.provider === AUTOCLAW_INTL.id) {
          // AutoClaw 有**真实的**每日签到端点（与 raccoon 相反）。
          // ⚠️ 幂等判据是**响应体字段**（`already_completed === true` 一律算
          // 「今天已签到」），重复领取同样返回 HTTP 200 + `success:false` ——
          // 只看状态码会把「今天已领」误判成「领取成功」。
          const autoclawService = req.provider === AUTOCLAW.id ? autoclaw : autoclawIntl
          const results: RpcCreditsClaimAllResponse['results'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            const credential = resolved === undefined ? undefined : parseAutoclawCredential(resolved.value)
            if (credential === undefined) {
              results.push({
                accountId: account.id,
                nickname: account.nickname,
                outcome: { kind: 'failed', code: 0, message: '凭据未配置或解析失败' },
              })
              continue
            }
            try {
              const outcome = await autoclawService.claimDailyCheckin(credential)
              results.push({ accountId: account.id, nickname: account.nickname, outcome })
            } catch (error) {
              results.push({
                accountId: account.id,
                nickname: account.nickname,
                outcome: {
                  kind: 'failed',
                  code: 0,
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            }
          }
          return {
            ok: true,
            value: {
              summary: computeClaimSummary(results.map((item) => item.outcome)),
              results,
            } satisfies RpcCreditsClaimAllResponse,
          }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }
      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === 'codearts') {
          // 余额来自 `statistics/plugin`（与账户类型检测同一个响应），
          // 故用带原因的钩子：非积分账户要显示「Token 计费账户」而不是
          // 误导性的「余额查询失败」。
          const values = await collectCreditBalances<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalanceDetailed: async (credential) => {
              // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
              // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
              // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
              // 无信息量的「账户信息查询失败」）。
              const result = await fetchCodeArtsAccountInfoDetailed(credential)
              if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
              const info = result.info
              if (!info.isCreditPackage) {
                return {
                  balance: null,
                  error: info.isTokenPackage
                    ? 'Token 计费账户，无积分余额'
                    : '非积分计费账户，无积分余额',
                }
              }
              // 积分账户但没有 credit metric：如实报「无积分数据」，
              // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
              if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
              return { balance: info.credit }
            },
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (isQoderProvider(req.provider)) {
          // 余额来自 `GET /sash/api/v2/me/usage`（实测只需 Bearer +
          // Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
          // `fetchQoderCreditBalance` 只吃 QoderCredential，故这里不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          // 按区域取产品：两国版余额端点不同（openapi.qoder.sh / .com.cn）。
          const qoderProduct = qoderProductById(req.provider) ?? QODER
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: QoderCredential
            try {
              credential = JSON.parse(resolved.value) as QoderCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await fetchQoderCreditBalance(credential, qoderProduct)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带上原因，卡片显示原因而非 0（与其它 provider 同约定）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (isTraeProvider(req.provider)) {
          // 按区域取产品：两国版积分端点不同（api.trae.cn / api.trae.ai）。
          const traeProduct = traeProductById(req.provider) ?? TRAE
          const values = await collectCreditBalances(accounts, traeProduct, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchTraeCreditBalance(credential as TraeCredential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === CLINE.id) {
          // 余额来自 `GET /api/v1/users/{accountId}/balance`（实测
          // `{data:{userId, balance}, success:true}`）。与 Qoder 分支同因：
          // `fetchClineCreditBalance` 只吃 ClineCredential，故不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          //
          // ⚠️ 账号 id 必须用凭据里的 `account_id`（`usr-…`），**不是** JWT 的
          // `sub`（`user_…`）—— 传后者实测返回 `400 Invalid request format`。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: ClineCredential
            try {
              credential = JSON.parse(resolved.value) as ClineCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const result = await fetchClineCreditBalance(credential, CLINE)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance: result.balance,
              // 查不到时带上**具体原因**（含 HTTP 状态码与错误体摘要），
              // 而不是笼统一句「查询失败」—— 卡片显示原因而非 0
              //（0 是「已用光」的语义，会误导用户）。
              ...result.balance === null
                ? { error: result.error ?? '积分查询失败（凭据失效或响应异常）' }
                : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === LOOMY.id) {
          // 余额来自 `GET /points/records`（**只读**，无副作用）。
          // ⚠️ 刻意不用 `first-login`：那是**写**端点，在「打开面板」这种
          // 高频路径上调用会意外触发签到。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: LoomyCredential
            try {
              credential = JSON.parse(resolved.value) as LoomyCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await loomy.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === RACCOON.id) {
          // 余额来自 `GET /points/v1/balance`（**只读**，无副作用）。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: RaccoonCredential
            try {
              credential = JSON.parse(resolved.value) as RaccoonCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await raccoon.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
              // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === ZCODE.id || req.provider === ZCODE_INTL.id) {
          // ZCode 的余额走**套餐 JWT**（不是推理用的 access_token），
          // 逐账号顺序查（**不可并发**：实测批量并发会被上游 429 风控限流）。
          const zcodeService = req.provider === ZCODE.id ? zcode : zcodeIntl
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            const credential = resolved === undefined ? undefined : parseZcodeCredential(resolved.value)
            if (credential === undefined) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置或解析失败',
              })
              continue
            }
            const balance = await zcodeService.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义）。
              // 缺套餐 JWT 是最常见的一种：那说明该账号只换到了推理凭证。
              ...balance === null ? { error: '余额查询失败（缺套餐 JWT 或凭据已失效）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === AUTOCLAW.id || req.provider === AUTOCLAW_INTL.id) {
          // AutoClaw 的余额走 `agent-assetmgr` 钱包接口（**只读**，无副作用）。
          const autoclawService = req.provider === AUTOCLAW.id ? autoclaw : autoclawIntl
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            const credential = resolved === undefined ? undefined : parseAutoclawCredential(resolved.value)
            if (credential === undefined) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置或解析失败',
              })
              continue
            }
            const balance = await autoclawService.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === ACCIO.id || req.provider === ACCIO_CN.id) {
          // Accio 的余额走 `/api/entitlement/quota`（用量百分比，**只读**）。
          const accioService = req.provider === ACCIO.id ? accio : accioCn
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            const credential = resolved === undefined ? undefined : parseAccioCredential(resolved.value)
            if (credential === undefined) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置或解析失败',
              })
              continue
            }
            let balance = null
            try {
              balance = await accioService.fetchCreditBalance(credential)
            } catch (error) {
              // 401/403 会原样抛出（供上层触发续期重试）—— 这里如实带出原因，
              // 而不是把「凭据失效」显示成「余额为 0」。
              values.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: error instanceof Error ? error.message : String(error),
              })
              continue
            }
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义）。
              ...balance === null ? { error: '额度查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === CATPAW.id) {
          // CatPaw 的积分余额走 `GET {gateway}/api/gateway/credit/balance`，
          // ⚠️ 该端点**只认 `X-Auth-Token`**（`X-Passport-Token` / `Cookie` /
          // `Authorization` 全部 401）—— 与推理用的鉴权头刻意不同。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            const credential = resolved === undefined ? undefined : parseCatpawCredential(resolved.value)
            if (credential === undefined) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置或解析失败',
              })
              continue
            }
            let balance = null
            try {
              balance = await catpaw.fetchCreditBalance(credential)
            } catch (error) {
              // 401 / code 4010 / 4011 会抛出「请重新登录」—— 如实带出原因，
              // 而不是把「登录态失效」显示成「余额为 0」。
              values.push({
                accountId: account.id,
                nickname: account.nickname,
                balance: null,
                error: error instanceof Error ? error.message : String(error),
              })
              continue
            }
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              ...balance === null ? { error: '积分查询失败（登录态失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
