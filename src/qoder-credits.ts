/**
 * Qoder 积分余额查询。
 *
 * ## 与前四个 provider 的差异
 *
 * Qoder 的用量接口**不需要 WASM 签名** —— 只需 `Bearer` + `Cosy-ClientType`
 * 头（源码 `Bx()`）。这一点与模型列表端点（`/api/v2/model/list`，需签名）
 * **不同**，早期因为只按 `/api/` 前缀搜索而误判「Qoder 无积分端点」。
 *
 * ## 端点与实测响应（2026-09-19，真实凭据）
 *
 * ```
 * GET {openApiBase}/sash/api/v2/me/usage
 * Authorization: Bearer <token>
 * Cosy-ClientType: 5
 * ```
 *
 * ```json
 * { "displayMode": "qoder",
 *   "qoderUsage": {
 *     "userType": "personal_standard",
 *     "userQuota":  { "total": 0,   "used": 0, "remaining": 0,   "unit": "credits" },
 *     "addOnQuota": { "total": 100, "used": 0, "remaining": 100, "unit": "credits" },
 *     "expiresAt": 253402214400000 } }
 * ```
 *
 * ⚠️ **余额不只在 `userQuota` 里**：实测该账号 `userQuota.remaining = 0`
 * 而 `addOnQuota.remaining = 100`（用户所说的「资源包 100 积分」正是后者）。
 * 只读 `userQuota` 会显示 0 —— 与其它 provider 的「漏读某一层」是同一类缺陷。
 *
 * ## 为什么不做「签到」
 *
 * `/sash/api/v1/me/campaigns` 实测返回 `{"showCampaign":false,"claimable":false,
 * "campaigns":[]}` —— 本账号无活动可领，且逆向中**未发现**签到动作端点
 * （只有活动查询）。故 `dailyCheckin` 仍为 false；余额能力则为 true。
 */

import { roundCredits, type CreditBalance, type CreditPackage } from './credits.js'
import { qoderBearerToken, type QoderCredential } from './qoder.js'
import type { QoderProduct } from './qoder-product.js'

/** 用量接口路径（挂 `openApiBase`）。 */
export const QODER_USAGE_PATH = '/sash/api/v2/me/usage'

/** 单次请求超时（毫秒）。 */
const QODER_CREDITS_TIMEOUT_MS = 15_000

/** 安全读数字字段（容忍字符串与缺失）；无法解析时返回 undefined。 */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 安全读字符串字段。 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 把一个 quota 对象转成 `CreditPackage`。
 *
 * `remaining` 优先取服务端字段；缺失时按 `total - used` 计算
 * （对齐源码 `tVe` 的 `Math.max(0, total - used)`）。
 * 负值一律 clamp 到 0：服务端在超额扣费/计量回滚下可能下发负值，
 * 原样透出会让卡片显示「-12.5 积分」。
 */
function toPackage(
  name: string,
  quota: unknown,
  options: { active?: boolean; expiredTime?: string } = {},
): CreditPackage | undefined {
  const total = readNumber(quota, 'total')
  const used = readNumber(quota, 'used')
  const remainingRaw = readNumber(quota, 'remaining')
  if (total === undefined && used === undefined && remainingRaw === undefined) return undefined
  const totalValue = Math.max(0, total ?? 0)
  const usedValue = Math.max(0, used ?? 0)
  const remaining = remainingRaw !== undefined
    ? Math.max(0, remainingRaw)
    : Math.max(0, totalValue - usedValue)
  return {
    name,
    unit: readString(quota, 'unit') ?? 'credits',
    remaining,
    total: totalValue,
    used: usedValue,
    active: options.active ?? true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: options.expiredTime ?? '',
  }
}

/**
 * 查询 Qoder 账号积分余额。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 401 / 响应形状非法），
 * 与「余额为 0」严格区分 —— 失败时 UI 应显示原因而不是 0。
 *
 * 企业版账号（`displayMode === 'enterprise'`）返回 `null`：
 * 那种模式不提供额度数字，只给一个外部链接（`enterpriseUsage.detailUrl`），
 * 报 0 会误导用户以为没额度。
 */
export async function fetchQoderCreditBalance(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  let response: Response
  try {
    response = await fetcher(`${product.openApiBase}${QODER_USAGE_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${qoderBearerToken(credential)}`,
        // 源码 `Bx()` 的固定头；服务端按它区分客户端形态。
        'Cosy-ClientType': product.clientMetadata.client_type,
        'User-Agent': 'Qoder',
      },
      signal: AbortSignal.timeout(QODER_CREDITS_TIMEOUT_MS),
    })
  } catch {
    // 网络失败：返回 null（与其它 provider 同语义），不抛错。
    return null
  }

  // 401/403 是凭据问题，其它非 2xx 是服务端问题 —— 两者都返回 null，
  // 由调用方统一显示「查询失败」原因。
  if (!response.ok) return null

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const root = body as Record<string, unknown>

  // 企业版：无额度数字，只有外部链接。返回 null 而非 0（见函数注释）。
  if (root.displayMode === 'enterprise') return null

  const usage = root.qoderUsage
  if (typeof usage !== 'object' || usage === null) return null

  const packages: CreditPackage[] = []
  // 顺序即展示顺序：套餐额度 → 赠送/资源包 → 专用资源包。
  const userQuota = toPackage('套餐额度', (usage as Record<string, unknown>).userQuota)
  if (userQuota !== undefined) packages.push(userQuota)
  const addOnQuota = toPackage('资源包', (usage as Record<string, unknown>).addOnQuota)
  if (addOnQuota !== undefined) packages.push(addOnQuota)

  const dedicated = (usage as Record<string, unknown>).dedicatedResourcePackages
  if (Array.isArray(dedicated)) {
    for (const item of dedicated) {
      const pkg = toPackage(
        readString(item, 'name') ?? readString(item, 'id') ?? '专用资源包',
        item,
        { expiredTime: readString(item, 'expiresAt') ?? readString(item, 'expires_at') ?? '' },
      )
      if (pkg !== undefined) packages.push(pkg)
    }
  }

  // 一个包都没解析出来 → 视为「查不到」（响应形状与预期不符），
  // 而不是「余额为 0」——后者会让用户以为额度被清空了。
  if (packages.length === 0) return null

  const total = roundCredits(packages.reduce((sum, pkg) => sum + pkg.remaining, 0))
  return { total, packages, expiredTotal: 0 }
}

/** 把 `CreditBalance` 压成一行可读摘要（供探针与日志使用）。 */
export function describeQoderBalance(balance: CreditBalance | null): string {
  if (balance === null) return '查询失败'
  if (balance.total === 0) return '余额 0'
  return `${balance.total} credits（${balance.packages.length} 个包）`
}
