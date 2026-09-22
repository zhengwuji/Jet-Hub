import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  CREDITS_CAPABILITIES,
  supportsCreditBalance,
  supportsDailyCheckin,
} from '../../plugin-src/client/credits-capabilities.js'

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Jet Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [jet-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而当时该端点以 `productById()` 判能力，CodeArts 根本
 * 不是 BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（尤其 WorkBuddy 余额真/签到假、未登记项默认关闭）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 *
 * 注：CodeArts 后来已接入真实实现（`src/codearts-credits.ts`，华为云签名），
 * 故其能力由全假变为全真；**门控机制本身不变**，仍是防止「对不支持的
 * provider 发必然失败的请求」的那道闸。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 余额与签到都支持（华为云 SDK-HMAC-SHA256 签名协议）', () => {
    // 华为云走 `snap-access` 的签名端点，与腾讯系协议完全不同源，
    // 但**能力上两项都具备**（见 src/codearts-credits.ts）。
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('codearts')).toBe(true)
    expect(supportsDailyCheckin('codearts')).toBe(true)
  })

  it('CodeBuddy 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(true)
  })

  it('WorkBuddy 国际版支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('workbuddy')).toBe(true)
    expect(supportsDailyCheckin('workbuddy')).toBe(false)
  })

  it('Qoder 两项能力都有（余额 + 每日领取）', () => {
    // ⚠️ 早期把 qoder 误判为「两项皆无」，随后又误判为「有余额、无签到」，
    // 两次都值得记录：
    //
    // ① 余额：只按 `/api/` 前缀搜端点，而它挂在 `/sash/api/v2/me/usage`，
    //    且**只需 Bearer + Cosy-ClientType**（不需要模型列表那样的 WASM 签名）。
    // ② 签到：曾依据 `/sash/api/v1/me/campaigns` 返回 `claimable:false,
    //    campaigns:[]` 判定「没有签到端点」。真相是**那天已领** ——
    //    活动每日 10:00（UTC+8）刷新。2026-09-21 用 keylog 解密抓包拿到了
    //    领取端点（`POST …/{campaignId}/claim`）与幂等证据（`replayed:true`）。
    //
    // 教训：「某次实测没看到」不能推广成「不存在」。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
    }
  })

  it('能力矩阵覆盖 PROVIDERS 中的每一个 provider', () => {
    // 客户端 PROVIDERS 列表与能力表必须同步：漏登记的 provider 会静默失去
    // 积分能力（默认关闭），而多登记的条目则是死配置。
    const source = readClientSource()
    const providerIds = [...source.matchAll(/\{\s*id:\s*'([a-z]+)',\s*label:/g)].map((m) => m[1]!)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })
})

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 600)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {
    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    expect(normalized).toMatch(/canLoadCredits\s*\n\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用
    const cardStart = normalized.indexOf('function AccountCard(')
    const cardBody = normalized.slice(cardStart, cardStart + 4000)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })

  /**
   * 领取结果必须逐账号显示**原因**，不能只给计数。
   *
   * 真实教训：CodeArts 的领取曾因「数字 campaignId 被当成字符串解析」而
   * 全部失败，但 UI 只显示「1 个失败」，用户与排查者都无从判断是凭据问题、
   * 活动未开、还是解析 bug —— 只能靠翻代码 + 抓包定位。
   * 后端一直返回 `results[].outcome.message`，前端不该把它丢掉。
   */
  it('claimCredits 汇总逐账号原因并在面板渲染', () => {
    const normalized = source.replace(/\r\n/g, '\n')
    const start = normalized.indexOf('const claimCredits = async () => {')
    expect(start).toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 3000)
    // 必须读取 results（而不只是 summary）
    expect(body, 'claimCredits 未消费 results').toContain('results')
    // 必须为失败条目带上 outcome.message
    expect(body).toContain('outcome.message')
    // 必须把 details 交给 notice
    expect(body).toContain('details')
    // 渲染层必须真的消费 claimNotice.details
    const renderStart = normalized.indexOf('claimNotice\n')
    expect(renderStart).toBeGreaterThan(-1)
    const renderBody = normalized.slice(renderStart, renderStart + 900)
    expect(renderBody, 'claimNotice 的 details 未被渲染').toContain('claimNotice.details')
    expect(renderBody).toContain('dim-jh-probeDetails')
  })
})
