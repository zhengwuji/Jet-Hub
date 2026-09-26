import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CREDITS_CAPABILITIES } from '../../plugin-src/client/credits-capabilities.js'

const here = dirname(fileURLToPath(import.meta.url))
const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

/**
 * 客户端源码级回归。
 *
 * UI 组件无法在单测里渲染（react 不在本仓库依赖内），
 * 故与既有 `credits-capabilities.spec.ts` 同法：用源码断言锁死关键守卫。
 */
describe('Loomy 客户端接线', () => {
  it('PROVIDERS 里登记了 loomy', () => {
    expect(hubSource).toMatch(/\{ id: 'loomy', label: 'Loomy \(讯飞\)'/)
  })

  it('Loomy 走统一的「弹窗 + 轮询」路径（与其他 provider 一致）', () => {
    // 不再有 loginMode/sms 分支：account.create 直接返回本地弹窗 loginUrl
    expect(hubSource).not.toContain("loginMode === 'sms'")
    expect(hubSource).not.toContain('SmsLoginForm')
    // 走既有的 window.open + login.poll
    expect(hubSource).toContain("'login.poll'")
    expect(hubSource).toContain('window.open(loginUrl')
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
   * 早期前端有个「短信表单」分支，表单要等 `account.create` 返回才渲染、
   * 而 `account.create` 又要求先有手机号 —— **顺序死锁**。
   * 改用微信扫码后该分支已删除。
   */
  it('account.create 调用不再传 phone（顺序死锁回归）', () => {
    const start = hubSource.indexOf("rpcCall('account.create'")
    expect(start).toBeGreaterThan(-1)
    const body = hubSource.slice(start, start + 200)
    expect(body).not.toContain('phone')
  })

  it('新手任务按钮按能力渲染（onboardingTasks）', () => {
    expect(hubSource).toContain('supportsOnboardingTasks')
    expect(hubSource).toContain("'onboarding.claim'")
  })

  /**
   * ⚠️ **真实缺陷**（用户报障「新手任务按钮溢出了，文字有点长」）：
   * `.dim-jh-accountActions` 是 `flex-wrap: nowrap`，行内已有 5 个文字按钮，
   * 再加「领取新手任务」会被挤出容器。
   *
   * 修法：压成**纯礼物图标按钮**，文案移到 `title` tooltip。
   * 本用例锁死「不再有文字标签」+「图标与 tooltip 都在」。
   */
  it('新手任务按钮是纯图标 + tooltip（不再用长文字，避免溢出）', () => {
    // 用「礼物图标」这一唯一特征定位按钮体，再取到该按钮表达式结束
    // （下一个按钮 = 重测按钮的 RETEST_HELP）。不依赖缩进/换行形态。
    const iconAt = hubSource.indexOf('dim-jh-iconBtn')
    expect(iconAt).toBeGreaterThan(-1)
    const start = hubSource.lastIndexOf('onClaimOnboarding', iconAt)
    expect(start).toBeGreaterThan(-1)
    const end = hubSource.indexOf('RETEST_HELP', start)
    expect(end).toBeGreaterThan(start)
    const body = hubSource.slice(start, end)

    // ① 图标按钮类名（正方形，不撑宽）
    expect(body).toContain('dim-jh-iconBtn')
    // ② 礼物图标：svg + 盒身矩形
    expect(body).toContain("createElement('svg'")
    expect(body).toContain("createElement('rect'")
    // ③ tooltip 说明用途与「一次性」
    expect(body).toContain('title:')
    expect(body).toMatch(/新手任务[\s\S]{0,40}10000/)
    expect(body).toMatch(/仅能领取一次|只能领取一次/)
    // ④ 无障碍标签（图标按钮必需，否则屏幕阅读器读不出用途）
    expect(body).toContain("'aria-label'")
    // ⑤ **不再**把长文案作为按钮子节点
    expect(body).not.toMatch(/\}, '领取新手任务'\)/)
  })

  it('图标按钮有正方形样式（不依赖内容宽度）', () => {
    const styles = readFileSync(
      resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8',
    )
    expect(styles).toContain('.dim-jh-iconBtn')
    // 左右 padding 与上下一致 → 正方形
    expect(styles).toMatch(/\.dim-jh-iconBtn \{[^}]*padding:\s*4px 8px/)
  })

  /**
   * ⚠️ 客户端**不调用** `onboarding.status`：领取动作（`onboarding.claim`）
   * 的响应已带回 `earned`/`total`/逐任务明细，足以渲染进度，
   * 再发一次只读查询纯属多余请求。该端点保留给将来的面板级进度展示。
   */
  it('客户端不调用 onboarding.status（claim 的响应已含进度）', () => {
    expect(hubSource).not.toContain("'onboarding.status'")
  })

  it('新手任务不被混进「一键签到」（否则每天发 8 个必然 alreadyCompleted 的请求）', () => {
    // claimCredits 只调 credits.claimAll，不得调用 onboarding.claim
    const start = hubSource.indexOf('const claimCredits = async')
    expect(start).toBeGreaterThan(-1)
    const end = hubSource.indexOf('\n  };', start)
    const body = hubSource.slice(start, end > start ? end : start + 3000)
    expect(body).toContain("'credits.claimAll'")
    expect(body).not.toContain('onboarding.claim')
  })

  it('能力矩阵含 loomy 且三项齐全', () => {
    expect(CREDITS_CAPABILITIES.loomy)
      .toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
  })

  /**
   * ⚠️ 两池必须**分开显示**（用户明确要求）：永久积分与每日赠送是两个
   * 分开计算的池，只显示合计会丢失这一信息。
   */
  it('账号卡片分开显示永久/每日两个池', () => {
    expect(hubSource).toContain('永久积分')
    expect(hubSource).toContain('每日赠送')
  })

  /**
   * 短信登录（备用路径）现在**完全在宿主侧**（`login.sendSms` / `login.submitSms`），
   * 客户端不再有对应表单 —— 主路径是微信扫码弹窗。
   */
  it('客户端不再包含短信表单（已改为宿主侧备用路径）', () => {
    expect(hubSource).not.toContain("'login.sendSms'")
    expect(hubSource).not.toContain("'login.submitSms'")
  })
})
