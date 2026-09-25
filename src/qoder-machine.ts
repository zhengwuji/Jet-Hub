/**
 * Qoder 设备身份：`Cosy-MachineToken` + `Cosy-MachineType`。
 *
 * ## 为什么需要它（真实缺陷，2026-09-25 用抓包 + 消融实验定位）
 *
 * 用户报障：「Qoder 没领过积分却显示『今日已领取』，去 IDE 看还是可领取」。
 *
 * 早期实现认为 `/sash/` 端点**只需 Bearer + `Cosy-ClientType`**（见
 * `qoder-credits.ts` 的旧注释）。该判断**不完整** —— 服务端还要校验
 * 设备身份，**缺少 machine 头族时不下发「可领取」的活动**。
 *
 * ### 证据（2026-09-21 抓包解密 + 逐项消融）
 *
 * 用户提供的 `qoder积分.pcapng` 配 `SSLKEYLOGFILE` 解密后，可见 native 请求
 * `/sash/api/v1/me/campaigns` 时带的头是：
 *
 * ```
 * cosy-clienttype:      10
 * cosy-version:         0.3.4
 * cosy-machineos:       x86_64_win32
 * cosy-machinehostname: DESKTOP-FSEE011
 * cosy-machineid:       8da07a0d-…
 * cosy-machinetoken:    P1gAtkTG…
 * cosy-machinecode:     1a743bcb766a88545c
 * cosy-machinetype:     f4c9a409144dcb6377
 * ```
 *
 * 同一账号当下的对照实验（只改请求头，其它全同）：
 *
 * | 请求头 | `/sash/api/v1/me/campaigns` |
 * |---|---|
 * | 仅 `Cosy-ClientType: 10` | `showCampaign:true, claimable:false`，**1 条** `VIEW_DETAILS` |
 * | ＋ `Cosy-MachineToken` ＋ `Cosy-MachineType` | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
 * | 全套 − `Cosy-MachineToken` | 退回 1 条（失效） |
 * | 全套 − `Cosy-MachineType` | 退回 1 条（失效） |
 * | 单独加任一头（不含配对） | 全部无效 |
 *
 * 结论：**`MachineToken` 与 `MachineType` 必须成对出现**，缺一即失效；
 * `Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` /
 * `MachineCode` 实测**均非必需**（去掉后仍能拿到活动）。
 *
 * 这解释了为什么只把 `Cosy-ClientType` 从 `5` 改成 `10` 仍不够 ——
 * 它是**必要但不充分**条件。
 *
 * ## 值的来源：本机 IDE 的 `machine_token.json`
 *
 * `%APPDATA%\Qoder\SharedClientCache\cache\machine_token.json`：
 *
 * ```json
 * { "token": "P1gA…", "type": "f677427e14abd0f6c1", "updateAt": 1774862945355 }
 * ```
 *
 * 即 `Cosy-MachineToken` = `token`，`Cosy-MachineType` = `type`。
 *
 * ⚠️ **实测该文件即使很旧（`updateAt` 为 179 天前）token 依然有效**，
 * 所以不做时效校验、也不因过期而拒发 —— 发出去最多是服务端忽略，
 * 而漏发会让用户看不到可领取的活动。
 *
 * ⚠️ **读不到时返回 undefined，调用方应照常发请求（只是不带这两个头）**：
 * 这与修复前的行为一致，属**保守降级** —— 用户若未安装 Qoder 桌面端
 * （纯插件登录的账号）就没有该文件，此时不能让整个积分功能报错。
 *
 * 为什么直接读文件而不自己生成 token：官方经 `runtime-info.exe`（UMID 模块）
 * 生成，其内部含设备指纹与签名逻辑，复刻代价高且属重复造轮子；而该文件
 * 就在本机、格式稳定，直接读更可靠（实测有效）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 设备身份的两个必需值。 */
export interface QoderMachineIdentity {
  /** 发送为 `Cosy-MachineToken`。 */
  token: string
  /** 发送为 `Cosy-MachineType`。 */
  type: string
}

/**
 * 缓存解析结果。
 *
 * - `undefined` = 尚未解析；
 * - `null` = 已解析过但**拿不到**（不重复读盘）；
 * - 对象 = 解析成功。
 *
 * 用模块级缓存是因为该值要参与**每次**积分请求的头构造，而文件读取是同步
 * IO；缓存后仅在首次调用时有代价。
 */
let cached: QoderMachineIdentity | null | undefined

/**
 * `machine_token.json` 的候选路径。
 *
 * 顺序即优先级；`QODER_MACHINE_TOKEN_PATH` 可覆盖（**供单测隔离与排查用**：
 * 默认路径落在用户真实 `%APPDATA%` 下，测试必须能指向 fixture，
 * 否则用例结果会随开发机是否装了 Qoder 桌面端而变）。
 */
function candidatePaths(): readonly string[] {
  const override = process.env.QODER_MACHINE_TOKEN_PATH
  if (override !== undefined && override.length > 0) return [override]

  const suffix = ['Qoder', 'SharedClientCache', 'cache', 'machine_token.json']
  const paths: string[] = []
  const appData = process.env.APPDATA
  if (appData !== undefined && appData.length > 0) {
    paths.push(join(appData, ...suffix))
  }
  const home = homedir()
  paths.push(join(home, 'Library', 'Application Support', ...suffix))
  paths.push(join(home, '.config', ...suffix))
  return paths
}

/** 从单个文件解析；形状不符或读取失败返回 undefined。 */
function parseFile(path: string): QoderMachineIdentity | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // 文件不存在 / 无权限：正常降级，不抛错。
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const token = record.token
  const type = record.type
  // 两者必须都是**非空字符串**：缺任一即无法配对，而配对是服务端下发活动的必要条件
  // （见模块头部的消融表），故视为拿不到而不是发一半。
  if (typeof token !== 'string' || token.length === 0) return undefined
  if (typeof type !== 'string' || type.length === 0) return undefined
  return { token, type }
}

/**
 * 解析本机 Qoder 设备身份；拿不到返回 `undefined`。
 *
 * 结果被缓存（含「拿不到」这一结果），故可安全地在每个请求里调用。
 */
export function resolveQoderMachineIdentity(): QoderMachineIdentity | undefined {
  if (cached !== undefined) return cached ?? undefined
  for (const path of candidatePaths()) {
    const identity = parseFile(path)
    if (identity !== undefined) {
      cached = identity
      return identity
    }
  }
  cached = null
  return undefined
}

/** 仅供测试：清空缓存（生产代码不需要）。 */
export function resetQoderMachineIdentityCache(): void {
  cached = undefined
}

/**
 * 把设备身份并入请求头。
 *
 * 拿不到身份时**原样返回**，不写空串 —— 发空头会让服务端可能按非法设备处理，
 * 漏发才是安全的降级（与修复前行为一致）。
 */
export function withQoderMachineHeaders(headers: Record<string, string>): Record<string, string> {
  const identity = resolveQoderMachineIdentity()
  if (identity === undefined) return headers
  return {
    ...headers,
    // 两者必须同时出现（见模块头部消融表：缺一即拿不到可领活动）。
    'Cosy-MachineToken': identity.token,
    'Cosy-MachineType': identity.type,
  }
}
