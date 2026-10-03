/**
 * TRAE（字节跳动 TRAE IDE）每日签到与积分余额。
 *
 * ## 数据来源
 *
 * 本模块重构自 trae-mate 的 `checkin.rs` + `credits.rs`。
 * trae-mate 是实际能成功签到的参考实现，其核心差异：
 *
 * - **请求头齐全**：约 20 个客户端头，而非简单的 Ug 头
 * - **设备身份稳定**：每个账号的 device_id 基于 user_id 确定性派生
 *   （15 位数字 + UUID v4 market_user_id + 64 hex session_id）
 * - **领取 body 为 `{}`**，而非 `{"req_source":2}`
 * - **积分余额 body 含 `require_usage: true`**
 * - **错误分类与冷却**：PlanLimit/SoftRate/SessionDead 等有冷却时间
 *
 * ## 签到
 *
 * 状态查询：
 *   POST /trae/api/v2/ug/checkin_credits/status → body {}
 *   响应: { checked_in: bool, credits: int64, enable: bool }
 *
 * 领取：
 *   POST /trae/api/v2/ug/checkin_credits/claim → body {}
 *   响应: { code: 0, message: "success" }
 *
 * ## 积分余额
 *
 *   POST /trae/api/v2/pay/ide_user_ent_usage
 *   body {"require_usage": true, "req_source": 2}
 *   响应: { user_entitlement_pack_list: [ ... ] }
 *   remain = ∑(credits_limit - credits_amount)
 *
 * ## 公共约定（与另三套协议一致）
 *
 * - `claimAll` / `status` **处理该 provider 下的全部账号，含已停用**
 * - 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
 * - 返回同一个 `ClaimOutcome` / `CreditBalance` 判别联合
 */

import {
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  traeCheckinHeaders,
  type TraeCredential,
} from './trae.js'
import type { TraeProduct } from './trae-product.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

// ── 错误分类与冷却时间（对齐 trae-mate `cooldown.rs`）──

/**
 * 签到错误分类，每类对应不同冷却策略。
 */
export interface TraeCheckinError {
  type: string     // PlanLimit | SoftRate | SessionDead | NotFound | Server | Client | BusinessError | Unknown
  cooldownSecs: number // -1=永久, 0=不冷却, >0=冷却秒数
}

/**
 * 分类签到错误，返回类型与冷却时间。
 *
 * 对齐 trae-mate `cooldown.rs:classify_error`：
 * - 200 + code=1005 → PlanLimit, 43200s (12h)
 * - HTTP 429 → SoftRate, 60s
 * - HTTP 401 → SessionDead, 永久
 * - HTTP 404 → NotFound, 60s
 * - 5xx → Server, 600s
 * - 4xx → Client, 600s
 * - 业务码非0 → BusinessError, 300s
 * - 成功/无码 → Unknown, 不冷却
 */
export function classifyTraeCheckinError(
  httpStatus: number,
  code: number | undefined,
): TraeCheckinError {
  if (httpStatus === 200 && code === 1005) {
    return { type: 'PlanLimit', cooldownSecs: 43_200 }
  }
  if (httpStatus === 429) {
    return { type: 'SoftRate', cooldownSecs: 60 }
  }
  if (httpStatus === 401) {
    return { type: 'SessionDead', cooldownSecs: -1 }
  }
  if (httpStatus === 404) {
    return { type: 'NotFound', cooldownSecs: 60 }
  }
  if (httpStatus >= 500 && httpStatus < 600) {
    return { type: 'Server', cooldownSecs: 600 }
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return { type: 'Client', cooldownSecs: 600 }
  }
  if (code !== undefined && code !== 0) {
    return { type: 'BusinessError', cooldownSecs: 300 }
  }
  return { type: 'Unknown', cooldownSecs: 0 }
}

/**
 * 签到业务码 **9074**：「签到人数过多」。
 *
 * 保留此常量作为公开引用（供测试与 RPC 使用）。
 */
export const TRAE_CHECKIN_BUSY_CODE = 9074

// ── JSON 安全读取 ──

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读取业务码，兼容数字与字符串形态。
 *
 * ⚠️ 不能只 `typeof === 'number'`：后端在部分网关上以字符串 `"9074"` 返回，
 * 只认数字会误判为成功（code=0）。
 */
function readClaimCode(body: Record<string, unknown>): number {
  const raw = body.code
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return raw === undefined ? 0 : -1
}

// ── HTTP 请求 ──

/**
 * 发起一次 POST 请求（签到专用，使用完整客户端头）。
 *
 * 用 `credential.uid` 作为 user_id 来派生稳定的设备身份。
 * 每次请求生成独立的 `X-Request-Id`。
 *
 * ⚠️ **基址必须取 `product.ugHost`，不能写死**（真实缺陷）：早期实现把
 * `https://api.trae.cn` 硬编码在这里，于是 `TraeProduct.ugHost`（国内
 * `api.trae.cn` / 国际 `api.trae.ai`）成了**死配置** —— 国际版账号的请求
 * 被发到国内站点，服务端只回业务码 `4014`（"not able to authenticate you"），
 * 界面显示成语义错误的「积分查询失败（凭据失效或响应异常）」。区域端点必须由
 * 产品配置驱动，这也是本仓库「产品配置是单一真相源」的既定约定。
 *
 * ⚠️ 同处还有第二个缺陷：`traeCheckinHeaders(credential, {} as never, uid)`
 * 把一个**空对象**当产品传入，`App-Version` 因此被写成 `undefined`。
 * 现改为透传真实产品。
 *
 * ⚠️ **只改 host 还不够**（2026-10-03 实测补充）：国际版连**路径版本号**都不同
 * （国际 v1 / 国内 v2），故积分查询另取 `product.entUsagePath`。国际版真实 Ug
 * 站点是 `ug-normal.trae.ai`（见 `TRAE_INTL_UG_HOST`），**不是** `api.trae.ai`
 * —— 后者只承载 `/cloudide/api/v3/trae/*` 认证类接口，`/trae/api/*` 一律网关 404。
 *
 * ⚠️ **签到在国际版仍未打通**：`checkin_credits/*` 在 `ug-normal.trae.ai` 上
 * v1/v2 皆 404，且 TRAE 官网 bundle 中根本不含该字面量（网页端不做签到）。
 * 故国际版「一键领取」仍会失败，属**已知未实现**，不在本次修复范围。
 */
async function postJson(
  path: string,
  credential: TraeCredential,
  body: string,
  fetcher: typeof fetch,
  userId: string | undefined,
  product: TraeProduct,
): Promise<{ ok: true; body: Record<string, unknown>; httpStatus: number } | { ok: false; message: string; httpStatus: number }> {
  const uid = userId ?? credential.uid
  if (uid.length === 0) {
    return { ok: false, message: '缺少 user_id，无法构造设备身份', httpStatus: 0 }
  }
  try {
    const response = await fetcher(`${product.ugHost}${path}`, {
      method: 'POST',
      headers: traeCheckinHeaders(credential, product, uid) as Record<string, string>,
      body,
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
    })
    const httpStatus = response.status
    const text = await response.text()
    if (!response.ok) {
      const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
      return { ok: false, message: `HTTP ${response.status}: ${snippet}`, httpStatus }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: `非 JSON 响应: ${text.trim().slice(0, 80)}`, httpStatus }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: '响应不是对象', httpStatus }
    }
    return { ok: true, body: parsed as Record<string, unknown>, httpStatus }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), httpStatus: 0 }
  }
}

// ── 签到状态查询 ──

/**
 * 查询签到状态。
 */
export async function fetchTraeCheckinStatus(
  credential: TraeCredential,
  product: TraeProduct,
  fetcher: typeof fetch = fetch,
): Promise<CheckinStatus | null> {
  const result = await postJson(TRAE_CHECKIN_STATUS_PATH, credential, '{}', fetcher, credential.uid, product)
  if (!result.ok) return null
  const body = result.body
  const code = readClaimCode(body)
  if (code !== 0) return null
  return {
    active: body.enable === true,
    todayCheckedIn: body.checked_in === true,
    streakDays: readNumber(body, 'streak_days') || 0,
    dailyCredit: readNumber(body, 'credits') || 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: readNumber(body, 'total_credits') || 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

// ── 签到领取 ──

/**
 * 执行签到领取。
 *
 * 对齐 trae-mate `checkin_engine` 流程，关键差异：
 *
 * 1. **请求头**：使用完整客户端头（含 `X-Market-User-ID` / `X-Lscbd-Aid` 等）
 * 2. **设备身份**：基于 `credential.uid` 确定性派生，每个账号独立稳定
 * 3. **Body**：`{}` 而非 `{"req_source":2}`
 * 4. **网络重试**：网络异常（非业务码、HTTP 不可达）重试，业务码不重试
 * 5. **错误分类**：返回分类信息供调用方做冷却
 *
 * @param userId 可选的手动 user_id（默认用 credential.uid）
 */
export async function claimTraeDailyCheckin(
  credential: TraeCredential,
  product: TraeProduct,
  fetcher: typeof fetch = fetch,
  generation = 0,
  onRotate?: (nextGeneration: number) => void | Promise<void>,
  userId?: string,
  retryCount = 3,
): Promise<ClaimOutcome & { errorType?: string; cooldownSecs?: number }> {
  const uid = userId ?? credential.uid
  // 多次重试
  const doClaim = async (): Promise<{ ok: boolean; body?: Record<string, unknown>; httpStatus: number; message: string; code: number }> => {
    let lastError = { ok: false, httpStatus: 0, message: '', code: 0 }
    for (let attempt = 0; attempt <= Math.max(0, retryCount); attempt++) {
      const result = await postJson(TRAE_CHECKIN_CLAIM_PATH, credential, '{}', fetcher, uid, product)
      if (result.ok) {
        const c = readClaimCode(result.body)
        return { ok: true, body: result.body, httpStatus: result.httpStatus, message: '', code: c }
      }
      lastError = { ok: false, httpStatus: result.httpStatus, message: result.message, code: 0 }
      // 只重试网络异常（非 Web 页面/非 JSON 等）——业务错误不再重试
      if (result.httpStatus > 0) {
        return lastError
      }
      if (attempt < retryCount) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    return lastError
  }

  const response = await doClaim()
  if (!response.ok) {
    return { kind: 'failed', code: -1, message: response.message, errorType: 'Unknown', cooldownSecs: 0 }
  }

  const body = response.body!
  const code = readClaimCode(body)

  // ── 9074：设备轮换已废弃，不再重试 ──
  // trae-mate 基于 user_id 确定性派生设备身份，不同账号天然不同设备，
  // 不再需要 9074 时换设备号重试。
  if (code === 9074) {
    return {
      kind: 'failed',
      code: 9074,
      message: readString(body, 'message') || readString(body, 'msg') || '签到人数过多，请稍后再试',
      errorType: 'BusinessError',
      cooldownSecs: 300,
    }
  }

  const msg = readString(body, 'message') || readString(body, 'msg') || ''

  if (code === 0) {
    // ⚠️ **claim 响应不含积分数**：实测（2026-09-20）它的完整响应就是
    // `{"code":0,"message":"success"}`，没有 credits 字段。早期实现读
    // `body.credits` 因此恒为 0，界面显示「领取成功 +0 积分」（用户报障），
    // 而 IDE 里明明写着 150。
    //
    // 真实数值只在 **status 端点**的 `credits` 字段里（实测 `credits:150`，
    // 与积分余额中「签到奖励」包的 `credits_limit:150` 完全吻合）。
    // 故领取成功后补查一次状态 —— 多一次往返，换取如实报告所得。
    const status = await fetchTraeCheckinStatus(credential, product, fetcher)
    return {
      kind: 'claimed',
      credit: status?.dailyCredit ?? 0,
      streakDays: status?.streakDays ?? 0,
      isStreakDay: false,
    }
  }

  const { type, cooldownSecs } = classifyTraeCheckinError(response.httpStatus, code)
  return {
    kind: 'failed',
    code,
    message: msg.length > 0 ? msg : `签到失败（code=${code}）`,
    errorType: type,
    cooldownSecs,
  }
}

// ── 积分余额查询 ──

/**
 * entitlement pack 的「有效」状态值（官方 `d.it.Active`）。
 *
 * 判据来源：TRAE 官网 `account-setting` 页面的 bundle 判定一个包是否有效用的是
 * `(pack.status) === d.it.Active` —— **不是** `ent_status`（后者在 bundle 里
 * 根本不是权益字段，只作为 `progress_status` / `present_status` 的子串出现）。
 *
 * ⚠️ 枚举定义本身被压缩掉了、取不到字面量，故按实测取值：两个区域实时拉到的
 * **全部 4 个包**（国际版 Free plan + 国内版 免费/每月登录赠送/签到奖励）
 * 的 `status` 都是 `1`。未知取值一律**保守视为有效** —— 旧实现恒为 `true`，
 * 保守方向不会造成可见回退。
 */
const TRAE_ENT_STATUS_ACTIVE = 1

/**
 * 解析包的到期时间（毫秒）。
 *
 * 回退顺序对齐官方前端：`expire_time` 优先，为 0/缺失时用
 * `entitlement_base_info.end_time`（两者实测都是**秒级**时间戳；这里也兼容毫秒）。
 */
function traePackEndTimeMs(entry: Record<string, unknown>, base: Record<string, unknown>): number | undefined {
  const raw = readNumber(entry, 'expire_time') || readNumber(base, 'end_time')
  if (raw <= 0) return undefined
  return raw > 1_000_000_000_000 ? raw : raw * 1000
}

/**
 * 一个包是否有效：**状态为 Active 且未到到期时间**。
 *
 * ⚠️ 旧实现把 `active` 恒置 `true`，于是套餐到期后面板仍显示「N/N 个资源包有效」
 * 并把已失效额度照算进总额（TRAE 分册记录过的同类误报）。现按服务端下发的
 * `status` 与到期时间如实判定。
 */
function isTraePackActive(entry: Record<string, unknown>, endTimeMs: number | undefined): boolean {
  const status = entry.status
  if (typeof status === 'number' && status !== TRAE_ENT_STATUS_ACTIVE) return false
  if (endTimeMs !== undefined && Date.now() >= endTimeMs) return false
  return true
}

/**
 * 「用量计费」账户的额度字段映射（`credit package 的 quota` → 展示项）。
 *
 * 背景：国际版（SG）账号是 **dollar usage billing**（实测
 * `is_dollar_usage_billing: true`），服务端**不下发 `credits_limit`**
 * （恒为 0），只有「请求次数」类额度。旧实现只认 `credits_limit > 0`，
 * 于是这类账号一个包都产出不了 → 返回 `null` → 面板恒显示「余额查询失败」。
 *
 * 字段口径对齐 TRAE 官网 `account-setting#usage` 页面自己的渲染逻辑
 * （其状态对象为 `slowRequestLimit/Usage`、`advancedModelLimit/Usage`、
 * `autocompleteLimit/Usage`），故展示项与官网一致。
 */
const TRAE_USAGE_QUOTAS: readonly (readonly [string, string, string])[] = [
  ['高级模型请求', 'advanced_model_request_limit', 'advanced_model_request_usage'],
  ['快速请求', 'premium_model_fast_request_limit', 'premium_model_fast_request_usage'],
  ['慢速请求', 'premium_model_slow_request_limit', 'premium_model_slow_request_usage'],
  ['自动补全', 'auto_completion_limit', 'auto_completion_amount'],
]

/**
 * 查询积分/用量余额。
 *
 * 两种计费口径都要支持：
 *
 * 1. **积分计费**（国内版，`is_credits_billing: true`）：按各包
 *    `credits_limit - usage.credits_amount` 汇总（对齐 trae-mate
 *    `calc_remaining_credits`）。
 * 2. **用量计费**（国际版，`is_dollar_usage_billing: true`）：无 credits 口径，
 *    改列 {@link TRAE_USAGE_QUOTAS} 里的请求次数额度，单位「次」。
 *
 * 路径取 `product.entUsagePath`（两国版版本号不同），基址取 `product.ugHost`。
 * body 使用 `{"require_usage": true, "req_source": 2}`。
 */
export async function fetchTraeCreditBalance(
  credential: TraeCredential,
  product: TraeProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const result = await postJson(
    product.entUsagePath,
    credential,
    JSON.stringify({ require_usage: true, req_source: 2 }),
    fetcher,
    credential.uid,
    product,
  )
  if (!result.ok) return null
  const body = result.body
  const packList = body.user_entitlement_pack_list
  if (!Array.isArray(packList) || packList.length === 0) return null

  const packages: CreditPackage[] = []
  let total = 0
  // 失效包的余额单独累计：面板据此提示「另有 N 已失效」，且不计入上面的总额。
  let expiredTotal = 0

  for (const item of packList) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const base = entry.entitlement_base_info as Record<string, unknown> | undefined
    if (typeof base !== 'object' || base === null) continue
    const quota = base.quota as Record<string, unknown> | undefined
    if (typeof quota !== 'object' || quota === null) continue

    const usage = entry.usage as Record<string, unknown> | undefined
    const usageRecord = typeof usage === 'object' && usage !== null
      ? usage as Record<string, unknown>
      : undefined
    // 套餐名两级回退：`entitlement_base_info.name` → 顶层 `display_desc`
    // （实测国际版只有后者，值为 "Free plan"；国内版有中文 display_desc）。
    const planName = readString(base, 'name') || readString(entry, 'display_desc')
    // 真实有效性（状态 + 到期时间），并把它写进 tooltip 用的周期/失效时间字段。
    const endTimeMs = traePackEndTimeMs(entry, base)
    const active = isTraePackActive(entry, endTimeMs)
    const endTimeText = endTimeMs === undefined ? '' : new Date(endTimeMs).toISOString()

    const creditsLimit = readNumber(quota, 'credits_limit')
    if (creditsLimit > 0) {
      const used = usageRecord === undefined ? 0 : readNumber(usageRecord, 'credits_amount')
      // 负数 clamp（与用量分支同口径）：回滚/超额下服务端可能下发负剩余。
      const remaining = Math.max(0, creditsLimit - used)
      packages.push({
        name: planName.length > 0 ? planName : '资源包',
        unit: 'credits',
        remaining,
        total: creditsLimit,
        used,
        active,
        cycleStartTime: '',
        cycleEndTime: active ? endTimeText : '',
        expiredTime: active ? '' : endTimeText,
      })
      if (active) total += remaining
      else expiredTotal += remaining
      continue
    }

    // 用量计费包：列出请求次数额度。`limit <= 0` 的项跳过（与 Go 端同口径）。
    for (const [label, limitKey, usageKey] of TRAE_USAGE_QUOTAS) {
      const limit = readNumber(quota, limitKey)
      if (limit <= 0) continue
      const used = usageRecord === undefined ? 0 : readNumber(usageRecord, usageKey)
      // 负数 clamp：超额用量下服务端可能给出负剩余，原样透出会显示成负数。
      const remaining = Math.max(0, limit - used)
      packages.push({
        name: planName.length > 0 ? `${label} · ${planName}` : label,
        unit: '次',
        remaining,
        total: limit,
        used,
        active,
        cycleStartTime: '',
        cycleEndTime: active ? endTimeText : '',
        expiredTime: active ? '' : endTimeText,
      })
      if (active) total += remaining
      else expiredTotal += remaining
    }
  }

  if (packages.length === 0) return null
  return { total, packages, expiredTotal }
}

// ── 处理器工厂（与 `jet-hub-rpc.ts` 协作）──

export function makeTraeCheckinStatusHandler(product: TraeProduct) {
  return async (credential: TraeCredential) => fetchTraeCheckinStatus(credential, product)
}

export function makeTraeClaimHandler(product: TraeProduct) {
  return async (credential: TraeCredential) => claimTraeDailyCheckin(credential, product)
}

export function makeTraeBalanceHandler(product: TraeProduct) {
  return async (credential: TraeCredential) => fetchTraeCreditBalance(credential, product)
}
