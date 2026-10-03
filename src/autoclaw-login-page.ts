/**
 * AutoClaw 本地登录页（宿主侧 Node 起 HTTP 服务器承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * AutoClaw 的两个 provider **都需要浏览器**，但 Jet Hub 客户端只会
 * 「拿 `loginUrl` → `window.open` → 轮询 `login.poll`」——**没有短信表单**
 * （Loomy 那条曾有过，因顺序死锁已删除，不要复活它）。而两地的登录形态
 * 又互不相同：
 *
 * | 地区 | 登录方式 | 缺什么 |
 * |---|---|---|
 * | 国内版 `autoclaw` | 手机验证码（发码 → 登录） | 客户端没有填手机号/验证码的界面 |
 * | 国际版 `autoclaw-intl` | Zai / Google 网页 OAuth | **先要过一次阿里云滑块**才能拿到授权地址 |
 *
 * 阿里云验证码 SDK 必须在**浏览器**里跑：宿主侧 Node 没有 DOM，铸不出令牌
 * （`AutoclawAuth.requestOAuthUrl` 在 `captcha-config` 声明 `enabled` 而
 * 没有令牌时会**显式抛错**，这正是它的设计意图）。
 *
 * 故做法是：宿主侧起一个本地页面，把表单 / 滑块放在页面里，
 * 页面只负责展示与提交，凭据与令牌全部留在宿主侧 —— 这正是
 * `src/raccoon-login-page.ts` 已验证过的模式，本文件逐段照抄它的骨架。
 *
 * ```text
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /autoclaw/login          → 弹窗页（按 product.loginMode 渲染短信 / OAuth 两套 UI）
 *   POST /autoclaw/sms/send       → 国内版：提交手机号，宿主侧调 auth.sendSmsCode
 *   POST /autoclaw/sms/verify     → 国内版：提交验证码，宿主侧调 auth.loginWithSmsCode
 *   GET  /autoclaw/oauth/start    → 国际版：取验证码组件配置（sceneId / prefix）
 *   POST /autoclaw/oauth/start    → 国际版：带 captchaParam 起 OAuth，回授权地址
 * ```
 *
 * ## 为什么 OAuth 要「先 GET 配置、再 POST 起流程」
 *
 * `AutoclawAuth.loginWithOAuth` 是**阻塞**到用户完成授权才返回的，
 * 直接调它会让页面一直转圈（且违反「两步式登录必须立即返回 loginUrl」的
 * 铁律）。故 POST 分支改用两步式入口 `auth.startLogin(...)`：
 * 它起好自己的回调口、立刻返回 `{ loginUrl, result, close }`，
 * 我们把 `loginUrl` 交给页面做**顶层导航**，再把 `result` 桥接到本页面的
 * 结果 promise 上。授权完成后由 `startLogin` 内部的回调服务器落定
 * （见 {@link AUTOCLAW_LOGIN_PAGE_PATHS} 里 `oauthCallback` 的说明）。
 *
 * ## ⚠️ 已知缺口：阿里云验证码的 sceneId / prefix 从哪来
 *
 * raccoon 的产品配置里有 `aliyunCaptcha: { sceneId, prefix }` 字段，
 * 而 **`AutoclawProduct` 没有** —— AutoClaw 的 scene_id / prefix 只由上游
 * `POST {userapi}/userapi/overseasv1/oauth-captcha-config` 动态下发
 * （见 `AutoclawAuth.requestOAuthUrl` 的第 ① 步）。
 *
 * 而 `AutoclawAuth` **没有公开**取该配置的方法（`requestOAuthUrl` 是
 * private），本文件又**不允许改动其它文件**去加一个公开方法。
 * 权衡后采取**降级方案**：
 *
 * - 由调用方通过 `options.aliyunCaptcha` 显式传入 `{ sceneId, prefix }`；
 * - 未传入时，页面**如实提示**「该环境需要验证码，请在客户端完成登录后
 *   导入凭据」并禁用登录按钮 —— 不猜、不硬编码、也不由本文件代发请求
 *   （宿主侧 Node 即便拿到 scene_id 也铸不出令牌，代发请求毫无意义）。
 *
 * **将来该怎么补**（两选一，都需要动 `autoclaw-auth.ts`）：
 * ① 在 `AutoclawAuth` 上加一个公开方法（如 `captchaConfig()`）返回
 *    `{ enabled, sceneId, prefix, region }`，本文件的 GET 分支改为调它，
 *    `options.aliyunCaptcha` 退化为覆盖值；
 * ② 或者把 `sceneId` / `prefix` 加进 `AutoclawProduct`（与 raccoon 对齐）。
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：手机号、`device_id`（发码与登录必须同一个值）、
 *   回调端口、凭据本体；
 * - **页面侧**只做展示与表单提交：**不知道**任何 token、密钥或 `device_id`；
 * - 页面发出的每个请求都打在**本机** `127.0.0.1` 上，不对外暴露监听面。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AUTOCLAW_LOGIN_TIMEOUT_MS,
  type AutoclawAuth,
  type StartedAutoclawLogin,
} from './autoclaw-auth.js'
import type { AutoclawCredential } from './autoclaw.js'
import type { AutoclawProduct } from './autoclaw-product.js'

/**
 * 本地登录页的路径。
 *
 * ⚠️ `oauthCallback` **刻意没有对应的路由处理器**：国际版的授权回调由
 * `AutoclawAuth.startLogin` **自己起的回调服务器**接（端口来自
 * `AUTOCLAW_CALLBACK_PORTS` 白名单，主机名必须是 `localhost`，与本页面的
 * `127.0.0.1:随机端口` 是两回事）。保留这个常量是为了让「一条登录链路上
 * 到底有几个地址」在**一个地方**看得全，避免后来者以为漏实现了回调。
 */
export const AUTOCLAW_LOGIN_PAGE_PATHS = {
  login: '/autoclaw/login',
  smsSend: '/autoclaw/sms/send',
  smsVerify: '/autoclaw/sms/verify',
  oauthStart: '/autoclaw/oauth/start',
  oauthCallback: '/autoclaw/oauth/callback',
} as const

/** 一次登录流程的句柄（与 `StartedRaccoonLoginFlow` 同形）。 */
export interface StartedAutoclawLoginFlow {
  /** 弹窗地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<AutoclawCredential>
  /** 主动关闭本地服务器（含 `startLogin` 起的回调口）。 */
  close: () => Promise<void>
}

/** 流程内部状态（**只存在于宿主侧**）。 */
interface FlowState {
  /**
   * 最近一次**发码成功**的手机号（未发过码时为空串）。
   *
   * ⚠️ 只记「成功发过码」的号码，且 verify 时**优先用它**：
   * `device_id` 是发码那一刻生成并记住的，换一个号码配旧 `device_id`
   * 必然失败（上游回 `400001`，与「验证码错误」同码，极难排查）。
   * 用户要改号码就必须重新发一次码 —— 这与 raccoon 的取舍一致。
   */
  phone: string
  /** 当前在跑的国际版 OAuth 流程（`startLogin` 的句柄）。 */
  oauth: StartedAutoclawLogin | undefined
  /**
   * OAuth 尝试的代数（每次重新发起 +1）。
   *
   * ⚠️ 用途是**丢弃迟到的落定**：用户重试时旧回调口虽然关了，但它的
   * 超时定时器仍会在到点时 reject；不校验代数的话，那次迟到的失败会把
   * **新**流程一并判死（表现为「刚重试就报超时」）。
   */
  oauthGeneration: number
}

/** `startAutoclawLoginFlow` 的选项。 */
export interface AutoclawLoginFlowOptions {
  /** 产品配置（决定页面渲染短信还是 OAuth 形态）。 */
  product: AutoclawProduct
  /** 认证服务：实际的发码 / 登录 / 起 OAuth 都由它完成。 */
  auth: AutoclawAuth
  /**
   * 注入的 fetch（测试用）。
   *
   * 本文件**不直接发任何出站 HTTP 请求**（全部经 `auth`），故当前实现不消费它；
   * 保留该字段是为了与 `RaccoonLoginFlowOptions` 形状一致，也是将来若要
   * 在宿主侧直接探测 `oauth-captcha-config`（见文件头缺口说明第 ① 条）时的注入点。
   */
  fetcher?: typeof fetch
  /** 超时（毫秒）；默认 {@link AUTOCLAW_LOGIN_TIMEOUT_MS}。 */
  timeoutMs?: number
  /**
   * 阿里云验证码组件配置（国际版必需）。
   *
   * ⚠️ 上游 `oauth-captcha-config` 会声明 `enabled:true`，而滑块必须在
   * 浏览器里过 —— 故页面需要 `sceneId` / `prefix` 才能初始化 SDK。
   * 未提供时页面走降级提示（见文件头缺口说明）。
   */
  aliyunCaptcha?: { sceneId: string; prefix: string }
}

/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startAutoclawLoginFlow(
  options: AutoclawLoginFlowOptions,
): Promise<StartedAutoclawLoginFlow> {
  const { product, auth } = options
  const state: FlowState = {
    phone: '',
    oauth: undefined,
    oauthGeneration: 0,
  }

  let resolveResult!: (value: AutoclawCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AutoclawCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快失败/立刻关闭），
  // 那一段窗口里 Node 会报 unhandled rejection（与 raccoon-login-page 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: AutoclawCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      state,
      product,
      auth,
      aliyunCaptcha: options.aliyunCaptcha,
      settleOk,
      settleErr,
    }).catch((error: unknown) => {
      try {
        response
          .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // 响应可能已发出，忽略
      }
    })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${AUTOCLAW_LOGIN_PAGE_PATHS.login}`

  /**
   * 关服务器 + **还回 OAuth 回调口**。
   *
   * ⚠️ 必须连 `state.oauth` 一起关：白名单端口只有
   * `AUTOCLAW_CALLBACK_PORTS` 那 4 个，泄漏一个就会让后续尝试在
   * 「端口全部被占用」上失败（`startLogin` 拒绝退到随机端口）。
   *
   * 用「共享一个 promise」而不是 `closed` 布尔量：这样 `close()` 与
   * 结果落定后的自动关闭**并发**时，`await close()` 仍能等到真正关完，
   * 而不是拿到一个「已经有人在关但我先返回了」的假信号。
   */
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async (): Promise<void> => {
      const oauth = state.oauth
      state.oauth = undefined
      if (oauth !== undefined) await oauth.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    })()
    return shutdownPromise
  }

  const close = async (): Promise<void> => {
    // 尚未落定则先 reject，避免调用方拿到一个永远悬挂的 promise。
    settleErr(new Error('autoclaw: 登录流程已关闭'))
    await shutdown()
  }

  const timeoutMs = options.timeoutMs ?? AUTOCLAW_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`autoclaw: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  void result
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      void shutdown()
    })

  return { loginUrl, result, close }
}

/** 一次请求的依赖集合。 */
interface HandleDeps {
  state: FlowState
  product: AutoclawProduct
  auth: AutoclawAuth
  /** 阿里云验证码配置；未提供时页面只能给出降级提示。 */
  aliyunCaptcha: AutoclawLoginFlowOptions['aliyunCaptcha']
  settleOk: (value: AutoclawCredential) => void
  settleErr: (error: unknown) => void
}

/** 处理一次本地请求。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state, product, auth } = deps

  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.login) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderAutoclawLoginPage(product))
    return
  }

  // ── 国际版：取验证码组件配置（GET）────────────────────────────────
  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.oauthStart && request.method === 'GET') {
    const captcha = deps.aliyunCaptcha
    if (captcha === undefined) {
      // 缺口：`AutoclawAuth` 没公开 captcha-config，本文件也不代它发请求。
      // 页面据此给出**可执行**的替代路径，而不是让用户点一个必然失败的按钮。
      writeJson(response, {
        enabled: false,
        message: '该环境需要阿里云验证码，但本地未配置验证码组件。'
          + '请在客户端完成登录后导入凭据，或由调用方通过 aliyunCaptcha 选项提供 sceneId / prefix。',
      })
      return
    }
    writeJson(response, { enabled: true, sceneId: captcha.sceneId, prefix: captcha.prefix })
    return
  }

  // ── 国内版：发码 ───────────────────────────────────────────────────
  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.smsSend && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    if (phone.length === 0) {
      // ⚠️ 只做非空检查：格式归一化与校验在服务端（`sendSmsCode` 内部），
      //    在这里再写一遍正则等于把规则复制成两份，迟早分叉。
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入手机号' }))
      return
    }
    try {
      await auth.sendSmsCode(phone)
      // 只在发送成功后才记住手机号：否则后续 verify 会用一个没收到验证码的号码。
      state.phone = phone
      writeJson(response, { ok: true })
    } catch (error) {
      // 单步失败**不终止**流程（用户可能只是号码写错/被限频），
      // 把原因回给页面让它就地提示并允许重试。
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  // ── 国内版：验证码登录 ─────────────────────────────────────────────
  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.smsVerify && request.method === 'POST') {
    const body = await readJsonBody(request)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const phoneFromPage = typeof body.phone === 'string' ? body.phone.trim() : ''
    // 优先用发码时记住的号码（`device_id` 与它配对，见 FlowState.phone）。
    const phone = state.phone.length > 0 ? state.phone : phoneFromPage
    if (phone.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请先获取手机验证码' }))
      return
    }
    if (code.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入验证码' }))
      return
    }
    try {
      // ⚠️ 第三个参数传**空串**：服务会自动沿用发码时记住的 `device_id`
      //    （传别的值会让验证码对不上，见 `loginWithSmsCode` 的说明）。
      const credential = await auth.loginWithSmsCode(phone, code, '')
      deps.settleOk(credential)
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  // ── 国际版：带 captchaParam 起 OAuth（POST）────────────────────────
  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.oauthStart && request.method === 'POST') {
    const body = await readJsonBody(request)
    const captchaParam = typeof body.captchaParam === 'string' ? body.captchaParam.trim() : ''
    // 只有显式 `'google'` 才切提供方，其余（含缺字段）一律默认 `zai`。
    const identityProvider = body.identityProvider === 'google' ? 'google' : 'zai'

    // 重新发起前先还回上一个回调口（白名单端口只有 4 个）。
    const previous = state.oauth
    state.oauth = undefined
    if (previous !== undefined) await previous.close()

    let started: StartedAutoclawLogin
    try {
      // ⚠️ 用**两步式**的 `startLogin` 而不是阻塞的 `loginWithOAuth`：
      //    后者要等用户授权完才返回，页面会一直转圈，也违反两步式铁律。
      started = await auth.startLogin({
        identityProvider,
        // 令牌为空时不带该字段：让上游自己判「不需要验证码」的场合仍能走通。
        ...captchaParam.length === 0 ? {} : { aliCaptchaVerifyParam: captchaParam },
      })
    } catch (error) {
      // 单步失败**不终止**流程：最常见的原因是滑块令牌过期，页面提示后
      // 用户重新过一次滑块即可（`startLogin` 抛错时已自己关掉回调口）。
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    state.oauth = started
    const generation = state.oauthGeneration + 1
    state.oauthGeneration = generation
    // 桥接 `startLogin` 的结果（见 FlowState.oauthGeneration 的代数说明）。
    void started.result.then(
      (credential) => {
        if (state.oauthGeneration === generation) deps.settleOk(credential)
      },
      (error: unknown) => {
        // 走到这里说明授权/换码阶段失败，同一次尝试的回调口已经关了、
        // 无法原地重试，故如实落定为失败，让调用方重新走一次登录。
        if (state.oauthGeneration === generation) deps.settleErr(error)
      },
    )
    writeJson(response, { ok: true, loginUrl: started.loginUrl })
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

/** 写一个 JSON 响应。 */
function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 读取并解析请求体（上限 64KB，避免被塞爆）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：弹窗页只可能来自本机浏览器，不对外暴露。
 * 端口用 `0` 让系统分配：本页面与 `AUTOCLAW_CALLBACK_PORTS` 那套白名单
 * **互不相干**（白名单只约束 OAuth 回调地址，那是 `startLogin` 自己起的口）。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('autoclaw: 本地登录页服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/** HTML 转义（产品展示名会进模板；即使是常量也不留注入面）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 页面内联样式（短信 / OAuth 两套共用）。 */
const AUTOCLAW_LOGIN_PAGE_STYLE = `  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 340px; }
  h1 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
  .sub { font-size: 12px; color: #8a9099; margin: 0 0 16px; }
  .status { margin-top: 12px; font-size: 13px; color: #4e5969; min-height: 20px; line-height: 1.6; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; text-align: left; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button.primary { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
                   background: #8E6BF2; color: #fff; cursor: pointer; }
  button.primary:disabled { background: #c9cdd4; cursor: not-allowed; }
  button.primary + button.primary { margin-top: 8px; }
  /* 身份提供方切换（Zai / Google）：与 raccoon 的 Tab 同一套视觉 */
  .idp { display: flex; gap: 4px; background: #f2f3f5; border-radius: 8px; padding: 4px; margin-bottom: 14px; }
  .idp button { flex: 1; padding: 7px; font-size: 13px; border: 0; border-radius: 6px;
                background: transparent; color: #4e5969; cursor: pointer; }
  .idp button[data-active="1"] { background: #fff; color: #1f2329; font-weight: 600;
                                 box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  #captcha-element { margin-bottom: 10px; }`

/** 国内版（手机验证码）页面主体。 */
const AUTOCLAW_SMS_BODY = `    <p class="sub">手机验证码登录</p>
    <label for="phone">手机号</label>
    <input id="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="tel"
           placeholder="请输入 11 位手机号">
    <button class="primary" id="sendCode" type="button">发送验证码</button>
    <label for="smsCode">验证码</label>
    <input id="smsCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
           placeholder="请输入短信验证码">
    <button class="primary" id="doLogin" type="button">登录</button>
    <div class="status" id="status"></div>`

/**
 * 国内版页面脚本。
 *
 * 两步式交互：先「发送验证码」（宿主侧调 `auth.sendSmsCode`），
 * 再「登录」（宿主侧调 `auth.loginWithSmsCode`）。
 * ⚠️ 手机号只做**非空**检查 —— 归一化与格式校验在服务端。
 */
const AUTOCLAW_SMS_SCRIPT = `  var phoneInput = document.getElementById('phone');
  var codeInput = document.getElementById('smsCode');
  var sendBtn = document.getElementById('sendCode');
  var loginBtn = document.getElementById('doLogin');

  sendBtn.addEventListener('click', function () {
    var phone = (phoneInput.value || '').trim();
    if (!phone) { setStatus('请输入手机号', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('发送中…');
    postJson(paths.smsSend, { phone: phone }).then(function (data) {
      if (data && data.ok) { setStatus('验证码已发送，请查收短信', 'ok'); }
      else { setStatus((data && data.message) || '发送失败，请重试', 'err'); }
    }).catch(function () {
      setStatus('发送失败，请检查网络后重试', 'err');
    }).finally(function () {
      sendBtn.disabled = false;
    });
  });

  loginBtn.addEventListener('click', function () {
    var phone = (phoneInput.value || '').trim();
    var code = (codeInput.value || '').trim();
    if (!phone) { setStatus('请输入手机号', 'err'); return; }
    if (!code) { setStatus('请输入验证码', 'err'); return; }
    loginBtn.disabled = true;
    setStatus('登录中…');
    postJson(paths.smsVerify, { phone: phone, code: code }).then(function (data) {
      if (data && data.ok) { setStatus('登录成功，可以关闭此页面。', 'ok'); }
      else { setStatus((data && data.message) || '验证码不正确，请重试', 'err'); }
    }).catch(function () {
      setStatus('登录失败，请检查网络后重试', 'err');
    }).finally(function () {
      loginBtn.disabled = false;
    });
  });`

/** 国际版（网页 OAuth）页面主体。 */
const AUTOCLAW_OAUTH_BODY = `    <p class="sub">选择登录方式并完成人机验证</p>
    <div class="idp">
      <button id="idpZai" data-active="1" type="button">Zai</button>
      <button id="idpGoogle" data-active="0" type="button">Google</button>
    </div>
    <div id="captcha-element"></div>
    <button class="primary" id="startOauth" type="button">开始登录</button>
    <div class="status" id="status">正在初始化…</div>`

/**
 * 国际版页面脚本。
 *
 * 流程：页面加载 → GET `oauthStart` 取 `{ enabled, sceneId, prefix }` →
 * 用**官方脚本**初始化阿里云滑块（`window.initAliyunCaptcha`）→
 * 过滑块拿到 `captchaParam` → POST `oauthStart` → 顶层导航到授权地址。
 *
 * ⚠️ `sceneId` / `prefix` **不在页面里硬编码**（AutoClaw 的产品配置没有
 * 这两个字段），只能由宿主侧下发，见文件头的缺口说明。
 */
const AUTOCLAW_OAUTH_SCRIPT = `  var startBtn = document.getElementById('startOauth');
  var idpZai = document.getElementById('idpZai');
  var idpGoogle = document.getElementById('idpGoogle');
  var selectedIdp = 'zai';
  var configLoaded = false;
  var captchaReady = false;
  var captchaInstance = null;

  function selectIdp(value) {
    selectedIdp = value;
    idpZai.setAttribute('data-active', value === 'zai' ? '1' : '0');
    idpGoogle.setAttribute('data-active', value === 'google' ? '1' : '0');
  }
  idpZai.addEventListener('click', function () { selectIdp('zai'); });
  idpGoogle.addEventListener('click', function () { selectIdp('google'); });

  // 拿到授权地址后**顶层导航**过去：授权页随后会重定向回
  // AutoclawAuth.startLogin 自己起的回调口，本页面不参与回调。
  function beginOauth(captchaParam) {
    startBtn.disabled = true;
    setStatus('正在获取授权地址…');
    postJson(paths.oauthStart, {
      captchaParam: captchaParam || '',
      identityProvider: selectedIdp
    }).then(function (data) {
      if (data && data.ok && data.loginUrl) {
        setStatus('正在跳转到授权页面…', 'ok');
        window.location.href = data.loginUrl;
        return;
      }
      setStatus((data && data.message) || '获取授权地址失败，请重试', 'err');
      startBtn.disabled = false;
    }).catch(function () {
      setStatus('网络异常，请重试', 'err');
      startBtn.disabled = false;
    });
  }

  // SDK 一旦接管该按钮，点击会由它弹滑块并回调 captchaVerifyCallback；
  // 这里只在「组件没起来」时兜底直接提交，让服务端报明确原因。
  startBtn.addEventListener('click', function () {
    if (!configLoaded) { setStatus('正在初始化验证码组件…'); return; }
    if (captchaReady) { return; }
    setStatus('验证码组件未加载，正在尝试直接登录…');
    beginOauth('');
  });

  fetch(paths.oauthStart).then(function (r) { return r.json(); }).then(function (config) {
    configLoaded = true;
    if (!config || !config.enabled) {
      // 降级路径：宿主没给 sceneId / prefix，这里如实提示并禁用按钮。
      setStatus((config && config.message) || '未配置验证码组件，无法在此页面登录', 'err');
      startBtn.disabled = true;
      return;
    }
    if (typeof window.initAliyunCaptcha !== 'function') {
      setStatus('验证码组件未加载，可直接点击「开始登录」尝试');
      return;
    }
    window.initAliyunCaptcha({
      SceneId: config.sceneId,
      prefix: config.prefix,
      mode: 'popup',
      element: '#captcha-element',
      button: '#startOauth',
      captchaVerifyCallback: function (captchaParam) {
        beginOauth(captchaParam);
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function () { return null; },
      getInstance: function (instance) { captchaInstance = instance; return null; },
      slideStyle: { width: 320, height: 40 },
      language: 'cn'
    });
    captchaReady = true;
    setStatus('请选择登录方式，然后点击「开始登录」');
  }).catch(function () {
    configLoaded = true;
    setStatus('无法读取验证码配置，请重试', 'err');
  });`

/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 按 `product.loginMode` 渲染**两套完全不同的 UI**：短信表单 / OAuth 滑块
 * - 短信页**不引任何 CDN**：国内版发码链路本来就没有验证码参数
 *   （`AutoclawAuth.sendSmsCode(phone)` 的签名里没有 captcha），
 *   引一个用不上的外部脚本只会多一个失败面
 * - OAuth 页引官方滑块脚本，`SceneId` / `prefix` 由 `GET oauthStart` **动态**取
 * - 页面只做展示与提交：**不含**任何 token、密钥、`device_id`
 */
export function renderAutoclawLoginPage(product: AutoclawProduct): string {
  const isSms = product.loginMode === 'sms'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 ${escapeHtml(product.displayName)}</title>
<style>
${AUTOCLAW_LOGIN_PAGE_STYLE}
</style>
</head>
<body>
  <div class="card">
    <h1>登录 ${escapeHtml(product.displayName)}</h1>
${isSms ? AUTOCLAW_SMS_BODY : AUTOCLAW_OAUTH_BODY}
  </div>

${isSms ? '' : '<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>\n'}<script>
(function () {
  'use strict';
  var paths = ${JSON.stringify(AUTOCLAW_LOGIN_PAGE_PATHS)};

  // ── 公共工具（两套页面共用；页面侧只做展示与提交，不持有任何秘密）──
  var statusEl = document.getElementById('status');
  function setStatus(text, tone) {
    statusEl.textContent = text || '';
    if (tone) { statusEl.setAttribute('data-tone', tone); }
    else { statusEl.removeAttribute('data-tone'); }
  }
  function postJson(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

${isSms ? AUTOCLAW_SMS_SCRIPT : AUTOCLAW_OAUTH_SCRIPT}
})();
</script>
</body>
</html>`
}
