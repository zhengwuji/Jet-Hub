/**
 * Jet Hub RPC —— 账号端点（`account.*`）。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。其中 `account.create` 一个分支就占了原 switch 的
 * 约六分之一（13+2 个 provider 的登录起步分支），单独拆文件后门面才可读。
 *
 * 依赖全部经 `deps` 注入：门面仍要 import 本模块，从本模块反向 import 门面的
 * 助手会形成运行时环（`account.create` 要用 `shortId` / 各 `parseXxxCredential`）。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { QoderAuth } from '../qoder-auth.js'
import type { TraeAuth } from '../trae-auth.js'
import { LOOMY } from '../loomy-product.js'
import type { LoomyAuth } from '../loomy-auth.js'
import type { LoomyCredential } from '../loomy.js'
import { RACCOON } from '../raccoon-product.js'
import type { RaccoonCredential } from '../raccoon.js'
import type { StartedRaccoonLoginFlow } from '../raccoon-login-page.js'
import { ZCODE, ZCODE_INTL } from '../zcode-product.js'
import { parseZcodeCredential } from '../zcode.js'
import type { StartedZcodeLoginFlow } from '../zcode-auth.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../autoclaw-product.js'
import { parseAutoclawCredential } from '../autoclaw.js'
import { autoclawDisplayName } from '../autoclaw.js'
import { ACCIO, ACCIO_CN } from '../accio-product.js'
import { parseAccioCredential } from '../accio.js'
import { startAutoclawLoginFlow } from '../autoclaw-login-page.js'
import { CATPAW } from '../catpaw-product.js'
import { parseCatpawCredential, catpawDisplayName } from '../catpaw.js'
import { LOBSTERAI } from '../lobsterai-product.js'
import { QODER, QODER_CN } from '../qoder-product.js'
import { TRAE, TRAE_INTL } from '../trae-product.js'
import { CLINE } from '../cline-product.js'
import { keyedProductById } from '../keyed-product.js'
import { isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs } from '../lobsterai.js'
import { fetchQoderUserNickname, isQoderRefreshable, qoderCredentialExpiresAtMs, withQoderNickname } from '../qoder.js'
import { isTraeRefreshable, traeCredentialExpiresAtMs } from '../trae.js'
import { clineCredentialExpiresAtMs, isClineRefreshable } from '../cline.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from '../buddy-oauth.js'
import { credentialExpiresAtMs } from '../buddy.js'
import { CODEBUDDY_INTL, WORKBUDDY_CN, productById } from '../product.js'
import { resetAccount, resetAllAccounts, retestAccount, retestAllAccounts } from '../account-probe.js'
import type { RpcListAccountsRequest, RpcCreateAccountRequest, RpcUpdateAccountRequest, RpcDeleteAccountRequest, RpcReorderAccountsRequest, RpcRefreshAccountRequest, RpcRetestAccountRequest, RpcRetestAllRequest, RpcResetAccountRequest, RpcResetAllRequest } from '../types.js'
import type { RpcResult, JetHubRpcContext, JetHubRpcServices, JetHubRegionRouting, JetHubCredentialHelpers } from './contracts.js'

/** `account.*` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type AccountEndpointDeps = JetHubRpcContext
  & Pick<JetHubRpcServices, 'codearts' | 'buddy' | 'buddyIntl' | 'workbuddy' | 'workbuddyCn' | 'lobsterai' | 'qoder' | 'qoderCn' | 'trae' | 'traeIntl' | 'cline' | 'loomy' | 'raccoon' | 'zcode' | 'zcodeIntl' | 'autoclaw' | 'autoclawIntl' | 'accio' | 'accioCn' | 'catpaw' | 'keyed'>
  & Pick<JetHubRegionRouting, 'buddyAuthForProduct' | 'qoderAuthForProduct' | 'traeAuthForProduct' | 'isQoderProvider' | 'isTraeProvider'>
  & Pick<JetHubCredentialHelpers, 'shortId' | 'parseBuddyCredential' | 'parseCodeArtsCredential' | 'parseLobsteraiCredential' | 'parseQoderCredential' | 'parseTraeCredential' | 'parseClineCredential' | 'buildRaccoonNickname'>

/** 处理 `account.*` 端点方法。 */
export async function handleAccountMethod(
  method: string,
  payload: unknown,
  deps: AccountEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, codearts, buddy, buddyIntl, workbuddy, workbuddyCn, lobsterai, qoder,
    qoderCn, trae, traeIntl, cline, loomy, raccoon, zcode, zcodeIntl, autoclaw, autoclawIntl,
    accio, accioCn,
    catpaw,
    keyed, buddyAuthForProduct,
    qoderAuthForProduct, traeAuthForProduct, isQoderProvider, isTraeProvider, shortId,
    parseBuddyCredential, parseCodeArtsCredential, parseLobsteraiCredential,
    parseQoderCredential, parseTraeCredential, parseClineCredential, buildRaccoonNickname, } = deps

  switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
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
            buddyAuthForProduct(product.id)?.scheduleRefresh()
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
          // CodeArts 也是**回调式**登录（本地回调服务器收授权码），但同样必须
          // 走两步式：先返回 loginUrl 让前端立刻 window.open，后台再等回调。
          //
          // 为什么不能像早期那样 await 整个流程（真实缺陷）：浏览器只在用户
          // 点击后的短暂窗口（transient activation，约 5 秒）内允许 window.open。
          // 阻塞数十秒后才返回 URL，弹窗必被拦截并返回 null，前端兜底逻辑
          // 便执行 `window.location.href = loginUrl`，把整个设置页跳走
          // ——用户报的「主页面直接跳转过去了」正是此因。
          const started = await codearts.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: 'codearts',
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseCodeArtsCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.user_name !== undefined && credential.user_name.length > 0
                ? credential.user_name
                : id,
              expiresAt: credential?.expires_at !== undefined
                ? (Number.isNaN(Date.parse(credential.expires_at)) ? undefined : Date.parse(credential.expires_at))
                : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background codearts login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === LOBSTERAI.id) {
          // LobsterAI 与 codearts 同款：回调式登录 + 两步式返回，
          // 理由见上面的 codearts 分支（弹窗拦截导致主页面被跳转）。
          const started = await lobsterai.startLogin({ refName })
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseLobsteraiCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`)
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (isQoderProvider(provider)) {
          // Qoder 与 codearts / lobsterai 同款两步式，但登录机制不同：
          // 它是**设备码轮询**（不开本地回调服务器，见 src/qoder-oauth.ts），
          // 同样必须在用户授权前返回 loginUrl，理由见上面的 codearts 分支。
          // 按 `provider` 取对应区域的服务实例（国际版 / 国内版端点不同）。
          const qoderAuth = qoderAuthForProduct(provider) as QoderAuth
          const started = await qoderAuth.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseQoderCredential(loginResult.access)
            // ⚠️ 设备码轮询响应**不带 `user_name`**，故 `credential.nickname` 恒为空
            // —— 必须补一次 userinfo 才能拿到真实名字，否则账号卡片只能显示
            // `qoder-xxxx`（多账号无法区分）。见 `fetchQoderUserNickname` 的说明。
            //
            // ⚠️ **失败不阻塞登录**：昵称只是展示信息，拿不到就退回账号 id
            //（与 `toLoginFlowResult` 对过期时间的处理同原则）。
            let nickname = credential?.nickname
            if ((nickname === undefined || nickname.length === 0) && credential !== undefined) {
              nickname = await fetchQoderUserNickname(credential, QODER)
              // 写回**凭据**（不只账号条目）：账号条目会随 Jet Hub 的账号操作
              // 整体重写，而凭据里存一份才能在续期后与其它面板都稳定拿到。
              if (nickname !== undefined && loginResult.access.length > 0) {
                const updated = withQoderNickname(credential, nickname)
                await ctx.credentials.set(credentialRef(refName), JSON.stringify(updated))
              }
            }
            await pool.updateAccount(id, {
              nickname: nickname !== undefined && nickname.length > 0 ? nickname : id,
              expiresAt: credential !== undefined ? qoderCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isQoderRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${provider} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (isTraeProvider(provider)) {
          // TRAE 回调式登录 + 两步式返回（与 LobsterAI / codearts 同因）。
          const traeAuth = traeAuthForProduct(provider) as TraeAuth
          const started = await traeAuth.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseTraeCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? traeCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isTraeRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${provider} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === CLINE.id) {
          // Cline 是 **WorkOS 设备码轮询**登录（见 src/cline-oauth.ts）：
          // 与 Qoder 同为「不开本地回调服务器」的轮询式，但判据形态不同 ——
          // Qoder 看 HTTP 404，Cline 看响应体的 `error: authorization_pending`。
          //
          // ⚠️ 与 Qoder 的另一处差异：`startLogin` 内部要先发一次
          // `POST {workOsBase}/user_management/authorize/device` 拿到设备码，
          // 才能返回 loginUrl（Qoder 的 URL 是纯本地构造的）。那只是一次
          // 快速 POST，仍远快于浏览器手势窗口，故两步式的理由与 Qoder 一致。
          const started = await cline.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: CLINE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseClineCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? clineCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isClineRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${CLINE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === LOOMY.id) {
          // Loomy 走**微信扫码**登录（与其余 provider 同为「两步式」）：
          // 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
          // 立即返回 `loginUrl` 让前端 `window.open`。
          //
          // ⚠️ **真实缺陷**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
          // 早期实现要求 `account.create` **必须带 phone**，但表单要等它返回
          // `loginMode:'sms'` 才渲染 —— 用户根本没机会输入手机号，直接报错，
          // 表单永远出不来。**顺序死锁**。改用微信扫码后此矛盾消失：
          // 手机号只在「首次扫码」时由弹窗页自己收集。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          // 登录成功后再回填昵称/有效期。
          await pool.addAccount({
            id,
            provider: LOOMY.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let started
          try {
            started = await loomy.startWechatLogin()
          } catch (error) {
            // 取二维码 uuid 失败（网络/页面结构变化）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Loomy 微信登录（获取二维码失败）：${reason}`)
          }

          started.result.then(async (login) => {
            const result = await loomy.persistWechatLogin(login, { refName })
            const credential = JSON.parse(result.access) as LoomyCredential
            await pool.updateAccount(id, {
              // 用手机号尾号让多账号可区分（Loomy 无独立昵称接口；
              // 微信昵称可能有，优先用它）。
              nickname: login.nickname !== undefined && login.nickname.length > 0
                ? login.nickname
                : credential.phone.length >= 4
                  ? `Loomy ${credential.phone.slice(-4)}`
                  : id,
              expiresAt: result.expires > 0 ? result.expires : undefined,
              // ⚠️ 恒 false：Loomy 无续期端点。
              refreshable: false,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${LOOMY.id} wechat login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === RACCOON.id) {
          // raccoon 走**本地页承载**的微信扫码 / 短信双路径登录（与 Loomy 同型）：
          // `startLogin` 立即返回指向 127.0.0.1 的 `loginUrl`，后台 await 结果。
          //
          // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
          //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          //    登录成功后再回填昵称与 refreshable。失败则删除占位条目。
          await pool.addAccount({
            id,
            provider: RACCOON.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let raccoonStarted: StartedRaccoonLoginFlow
          try {
            raccoonStarted = await raccoon.startLogin()
          } catch (error) {
            // 起本地服务器失败：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Raccoon 登录（本地登录页启动失败）：${reason}`)
          }

          raccoonStarted.result.then(async (credential) => {
            const result = await raccoon.persistLogin(credential, { refName })
            const saved = JSON.parse(result.access) as RaccoonCredential
            await pool.updateAccount(id, {
              // ⚠️ 服务端的 `name` 是**自动生成的默认名**（本机账号是
              // `RaccoonAva`，即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
              //（`wechat_bindings` 只有绑定 id 与时间，无昵称/头像）。
              // 它是账号的**正式名字**（JWT payload 里也有 `name`，官方客户端
              // 就显示它），故**保留**；但若注册第二个账号，服务端很可能又给一个
              // 相近的默认名 → 多账号重名、无法区分。
              //
              // 故追加**手机号尾号**消歧：`RaccoonAva (6665)`。
              // 与 Loomy 的 `Loomy 2222` 同策略（那边没有真实名字可用，
              // 这边有，所以保留原名再挂尾号）。
              nickname: buildRaccoonNickname(saved, id),
              expiresAt: result.expires > 0 ? result.expires : undefined,
              // ⚠️ raccoon **有** refresh 端点，与 Loomy（恒 false）不同。
              refreshable: result.refreshable,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${RACCOON.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: raccoonStarted.loginUrl } }
        } else if (ZCODE.id === provider || ZCODE_INTL.id === provider) {
          // ZCode 走**服务端中介的 CLI 轮询**登录（与 Qoder 的设备码轮询同型）：
          // `startLogin` 立即返回指向 `zcode.z.ai` 的授权地址，后台按上游给的
          // 间隔轮询；**不起本地回调端口**（造带 localhost redirect_uri 的
          // 授权地址会被上游拒，见 `src/zcode.ts` 模块头）。
          //
          // ⚠️ 与 raccoon / loomy 一样先登记**占位条目**，使前端 `login.poll`
          //    能立即看到该账号；登录成功后再回填昵称与有效期。失败则删除占位。
          //
          // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
          //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
          const zcodeProduct = provider === ZCODE.id ? ZCODE : ZCODE_INTL
          const zcodeService = provider === ZCODE.id ? zcode : zcodeIntl

          await pool.addAccount({
            id,
            provider: zcodeProduct.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // ⚠️ 恒不可续期：ZCode 没有 refresh 端点（见 `isZcodeRefreshable`）。
            refreshable: false,
            createdAt: Date.now(),
          })

          let zcodeStarted: StartedZcodeLoginFlow
          try {
            zcodeStarted = await zcodeService.startLogin()
          } catch (error) {
            // 起登录流程失败（网络/上游拒绝）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 ZCode 登录：${reason}`)
          }

          zcodeStarted.result.then(async (credential) => {
            const result = await zcodeService.persistLogin(credential, { refName })
            const saved = parseZcodeCredential(result.access)
            if (saved === undefined) return
            await pool.updateAccount(id, {
              nickname: zcodeService.displayNameFor(saved),
              ...result.expires > 0 ? { expiresAt: result.expires } : {},
              // ⚠️ 恒 false：本家无续期端点。
              refreshable: false,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${zcodeProduct.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: zcodeStarted.loginUrl } }
        } else if (provider === ACCIO.id || provider === ACCIO_CN.id) {
          // Accio 走 **OAuth 2.0 授权码 + PKCE（S256）** 网页登录：与 AutoClaw
          // 国际版同型（浏览器 302 回本机 loopback 端口），差异是**授权地址由
          // 网关自己拼**（不需先过一次风控验证码）。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          //    登录成功后再回填昵称与有效期。失败则删除占位条目。
          //
          // ⚠️ 绝不能等用户授权完成才返回 loginUrl —— `window.open` 只在用户
          //    手势窗口内有效，那时手势早已过期、弹窗必被拦截。
          const accioProduct = provider === ACCIO.id ? ACCIO : ACCIO_CN
          const accioService = provider === ACCIO.id ? accio : accioCn

          await pool.addAccount({
            id,
            provider: accioProduct.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let accioStarted
          try {
            accioStarted = await accioService.startLogin()
          } catch (error) {
            // 起本地回调服务器失败（端口被占/网络）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Accio 登录（本地回调服务器启动失败）：${reason}`)
          }

          accioStarted.result.then(async (credential) => {
            const result = await accioService.persistLogin(credential, { refName })
            const saved = parseAccioCredential(result.access)
            if (saved === undefined) return
            await pool.updateAccount(id, {
              nickname: accioService.displayNameFor(saved),
              ...result.expires > 0 ? { expiresAt: result.expires } : {},
              // Accio **有** refresh 端点（refresh_token 轮换）。
              refreshable: result.refreshable,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${accioProduct.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: accioStarted.loginUrl } }
        } else if (provider === AUTOCLAW.id || provider === AUTOCLAW_INTL.id) {
          // AutoClaw 两个地区**都需要浏览器**，而客户端只有「弹窗 + 轮询」：
          //   · 国内版 = 手机验证码（需要表单填手机号与验证码）
          //   · 国际版 = 网页 OAuth（**先要过一次阿里云滑块**才能拿到授权地址）
          // 两者都不是「返回一个上游 URL 就能搞定」的形态，故走**本地登录页**
          //（与 raccoon 同一模式：宿主侧起 127.0.0.1 上的页面，页面只做展示与
          // 提交，凭据与令牌全留宿主侧）。
          //
          // ⚠️ 绝不能用 `AutoclawAuth.loginWithOAuth`（阻塞到授权完成）——
          // 那会违反「两步式登录必须立即返回 loginUrl」的铁律，
          // 导致 `window.open` 被浏览器弹窗拦截。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号。
          const autoclawProduct = provider === AUTOCLAW.id ? AUTOCLAW : AUTOCLAW_INTL
          const autoclawService = provider === AUTOCLAW.id ? autoclaw : autoclawIntl

          await pool.addAccount({
            id,
            provider: autoclawProduct.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let autoclawStarted
          try {
            autoclawStarted = await startAutoclawLoginFlow({
              product: autoclawProduct,
              auth: autoclawService,
            })
          } catch (error) {
            // 起本地服务器失败（端口被占）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 AutoClaw 登录（本地登录页启动失败）：${reason}`)
          }

          autoclawStarted.result.then(async (credential) => {
            const result = await autoclawService.persistLogin(credential, { refName })
            const saved = parseAutoclawCredential(result.access)
            if (saved === undefined) return
            await pool.updateAccount(id, {
              // 展示名由产品 + 凭据算出（`AutoClaw 国内版 · <user_id/email>`）。
              nickname: autoclawDisplayName(autoclawProduct, saved),
              ...result.expires > 0 ? { expiresAt: result.expires } : {},
              // AutoClaw **有** refresh 端点（refresh_token 轮换）。
              refreshable: result.refreshable,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${autoclawProduct.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: autoclawStarted.loginUrl } }
        } else if (provider === CATPAW.id) {
          // CatPaw 走 **passport 会话 + loopback 回调** 网页登录：`startLogin`
          // 立即返回拼好的登录入口地址（带 state / redirect / sid 三个 query），
          // 后台等两条通道（浏览器 POST 回本机 / poll-token 兜底）里先到的那条。
          //
          // ⚠️ 上游 `login-callback` 页面会把 `{token,state}` **POST 到本机**，
          //    那是一次「公网页面 → 127.0.0.1」的跨源请求，浏览器会做私有网络
          //    检查（PNA）—— 回调响应里的 `Access-Control-Allow-Private-Network`
          //    由 `CatpawAuth` 那边的本地服务器补上（见 `catpaw-auth.ts`）。
          //
          // ⚠️ 先登记**占位条目**，使前端 `login.poll` 能立即看到该账号。
          await pool.addAccount({
            id,
            provider: CATPAW.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // ⚠️ 恒不可续期：CatPaw 没有 refreshToken、没有续期端点。
            refreshable: false,
            createdAt: Date.now(),
          })

          let catpawStarted
          try {
            catpawStarted = await catpaw.startLogin()
          } catch (error) {
            // 取登录入口失败（网络）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 CatPaw 登录（获取登录入口失败）：${reason}`)
          }

          catpawStarted.result.then(async (credential) => {
            const result = await catpaw.persistLogin(credential, { refName })
            const saved = parseCatpawCredential(result.access)
            if (saved === undefined) return
            await pool.updateAccount(id, {
              nickname: catpawDisplayName(saved),
              ...result.expires > 0 ? { expiresAt: result.expires } : {},
              // ⚠️ 恒 false：本家无续期端点。
              refreshable: false,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${CATPAW.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: catpawStarted.loginUrl } }
        } else if (keyedProductById(provider) !== undefined) {
          // 「粘贴 API Key」族（`commandcode` / `opencode`）：**没有登录页也
          // 没有验证码**的渠道。凭据就是用户从平台控制台复制的 API Key，故这里
          // 只登记**占位条目**并立刻返回 `loginMode:'key'`，前端据此渲染
          // 「粘贴 Key」表单，随后调 `login.submitKey` 完成写入。
          //
          // ⚠️ **绝不能复用 `startLogin` 形状**：本族没有 `loginUrl` 可弹
          //   （返回空串），前端若按 `'url'` 处理会走到
          //   「后端未返回登录地址」的错误分支。
          //
          // ⚠️ 这里**不校验 Key**（没有 Key 可校验），也不做任何网络请求；
          //   校验发生在 `login.submitKey`，且必须先校验再写凭据 ——
          //   否则会留下「账号在、模型全空、报错与真实原因无关」的黑洞。
          //
          // ⚠️ 与 raccoon 一样先登记占位条目，使前端 `login.poll` 能立即
          //   看到该账号；`submitKey` 成功后回填昵称与模型集。若用户中途
          //   关闭弹窗，占位条目会留在池里（无凭据）—— 这是**刻意**的：
          //   它给了用户「重新粘贴」的落脚点（`login.poll` 判据是
          //   「凭据能否解析」，无凭据即仍未登录），与 Loomy 短信登录
          //   「失败不删占位」的既有取舍一致。
          const keyedProduct = keyedProductById(provider)
          if (keyedProduct === undefined) {
            return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
          }
          await pool.addAccount({
            id,
            provider,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // ⚠️ 本族**恒不可续期**：Key 是用户手工粘贴的，插件无从续期，
            //   过期只能重新粘贴。这也是 `refreshAll()` 不会碰它们的原因。
            refreshable: false,
            createdAt: Date.now(),
          })

          return {
            ok: true,
            value: {
              accountId: id,
              loginUrl: '',
              loginMode: 'key' as const,
              // 平台清单由**服务端下发**，而不是让客户端自己抄一份
              // （理由见 `RpcCreateAccountResponse.platforms` 的注释）。
              // ⚠️ 本族一个 provider 对应**一个**平台，故清单恒只有一项；
              //   保留数组形状是为了让客户端的表单（平台下拉 + 控制台链接）
              //   不必分两套渲染。**不含任何凭据**：清单是公开平台元数据。
              platforms: [{
                id: keyedProduct.id,
                label: keyedProduct.displayName,
                baseUrl: keyedProduct.baseUrl,
                consoleUrl: keyedProduct.consoleUrl,
                ...keyedProduct.note === undefined ? {} : { note: keyedProduct.note },
              }],
            },
          }
        } else {
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }
      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }
      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }
      // 拖拽排序：重写该 provider 账号在池中的顺序。
      // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
      case 'account.reorder': {
        const req = payload as RpcReorderAccountsRequest
        if (typeof req.provider !== 'string' || req.provider.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
          return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } }
        }
        try {
          await pool.reorderAccounts(req.provider, req.orderedIds)
        } catch (error) {
          // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
          // 刷新重试，而不是抛成 jet-hub/handler-failed 那种「未知故障」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return { ok: true, value: undefined }
      }
      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          switch (entry.provider) {
            case 'codearts':
              await codearts.refreshAccountCredential(entry.credentialRef)
              break
            case 'buddy':
              await buddy.refreshAccountCredential(entry.credentialRef)
              break
            case CODEBUDDY_INTL.id:
              // ⚠️ 早期漏了这一条：`buddy-intl` 账号的「刷新」会落到 default
              // 抛 `Unknown provider`。
              await buddyIntl.refreshAccountCredential(entry.credentialRef)
              break
            case 'workbuddy':
              await workbuddy.refreshAccountCredential(entry.credentialRef)
              break
            case WORKBUDDY_CN.id:
              // ⚠️ 早期漏了这一条：`workbuddy-cn` 账号卡片的「刷新」按钮会落到
              // default 分支抛 `Unknown provider`（与 WorkBuddy 那个历史缺陷同类）。
              await workbuddyCn.refreshAccountCredential(entry.credentialRef)
              break
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef)
              break
            case QODER.id:
              await qoder.refreshAccountCredential(entry.credentialRef)
              break
            case QODER_CN.id:
              await qoderCn.refreshAccountCredential(entry.credentialRef)
              break
            case TRAE.id:
              await trae.refreshAccountCredential(entry.credentialRef)
              break
            case TRAE_INTL.id:
              await traeIntl.refreshAccountCredential(entry.credentialRef)
              break
            case CLINE.id:
              await cline.refreshAccountCredential(entry.credentialRef)
              break
            case LOOMY.id:
              // ⚠️ Loomy **没有 refresh 端点**：这里只能做**有效性探测**，
              // 失效时抛「请重新登录」。见 LoomyAuth.refreshAccountCredential。
              await loomy.refreshAccountCredential(entry.credentialRef)
              break
            case RACCOON.id:
              // raccoon **有** refresh 端点（refresh_token 轮换），这里是真续期。
              // ⚠️ 只读写传入的 ref，不碰默认单凭据 ref。
              // ⚠️ **必须传 pool + entry.id**：续期后要把新的 `expiresAt` 写回
              // 账号池，否则 UI 一直显示「已过期」（真实缺陷：JWT 已续到 15:09、
              // 账号池仍是 12:02，相差 3.1 小时，但功能完全正常）。
              await raccoon.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case ZCODE.id:
              // ⚠️ ZCode **没有** refresh 端点：这里只能做**有效性探测**，
              // 失效时抛「请重新登录」。见 ZcodeAuth.refreshAccountCredential。
              await zcode.refreshAccountCredential(entry.credentialRef)
              break
            case ZCODE_INTL.id:
              // ⚠️ 早期漏这类分支会让账号卡片的「刷新」落到 default 抛
              // `Unknown provider`（`buddy-intl` / `workbuddy-cn` 都因此坏过）。
              await zcodeIntl.refreshAccountCredential(entry.credentialRef)
              break
            case AUTOCLAW.id:
              // AutoClaw 国内版：`refresh_token` 轮换（`code 400002` 时降级到
              // `agent-refresh` 再试一次，见 AutoclawAuth.refresh）。
              await autoclaw.refreshAccountCredential(entry.credentialRef)
              break
            case AUTOCLAW_INTL.id:
              await autoclawIntl.refreshAccountCredential(entry.credentialRef)
              break
            case ACCIO.id:
              // ⚠️ Accio 的凭据可能「时间上还新但已被服务端失效」，
              // 故这里传 force=true 不看临期窗口；同时传 pool + accountId
              // 以便续期成功后把新的 expiresAt 写回账号池。
              await accio.refreshAccountCredential(entry.credentialRef, pool, entry.id, true)
              break
            case ACCIO_CN.id:
              await accioCn.refreshAccountCredential(entry.credentialRef, pool, entry.id, true)
              break
            case CATPAW.id:
              // ⚠️ CatPaw **没有** refreshToken：这里只能做**有效性探测**，
              // 失效时抛「请在客户端重新登录后重新导入登录态」。
              await catpaw.refreshAccountCredential(entry.credentialRef)
              break
            default: {
              // 「粘贴 API Key」族（`commandcode` / `opencode`）：**没有** refresh
              // 端点，也没有 refresh_token 可轮换 —— Key 是用户手工粘贴的「长期
              // 凭据」，插件无从续期。这里只能做**有效性探测**（打一次 chat 端点），
              // 失效时抛「请重新粘贴」。与 Loomy 同型，与 raccoon 的「真续期」相反。
              //
              // ⚠️ 探测成功也不改写凭据（无 expires_in 可写，平白一次写盘会
              // 制造「凭据被刷新过」的假象）。见 KeyedAuth.refreshAccountCredential。
              //
              // ⚠️ 放在 `default` 里而不是逐 id 写 `case`：本族会继续增加平台，
              // 逐个 case 正是历史上「新增 provider 漏改一处就出空壳面板」的
              // 成因（`buddy-intl` / `workbuddy-cn` 都因此让「刷新」按钮坏过）。
              const keyedAuth = keyed.get(entry.provider)
              if (keyedAuth === undefined) throw new Error(`Unknown provider: ${entry.provider}`)
              await keyedAuth.refreshAccountCredential(entry.credentialRef)
              break
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
      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
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
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }
      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        const value = await resetAllAccounts(pool, req.provider)
        return { ok: true, value }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
