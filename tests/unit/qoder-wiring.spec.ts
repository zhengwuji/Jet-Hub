import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(resolve(here, p), 'utf8')

/** 剔除注释行，避免注释里叙述缺陷的文字造成假阳性/假阴性。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

describe('Qoder 宿主侧接线（src/index.ts）', () => {
  const index = read('../../src/index.ts')

  it('注册了 llm-qoder settings namespace（漏了会让模型设置页崩溃）', () => {
    // 模型设置页会用 provider id 计算 deriveKeyRef(provider)，
    // namespace 未注册时在 refFor → provider.toUpperCase 处崩溃。
    expect(index).toContain("'llm-qoder'")
  })

  it('构造并注册了 Qoder 服务与 LLM 路由', () => {
    expect(index).toContain('new QoderAuth(')
    expect(index).toContain('registerQoderLlm(')
  })

  it('续期调度包含 qoder', () => {
    expect(index).toContain('qoder.refreshAll(pool)')
  })

  it('清理钩子包含 qoder.stop()', () => {
    expect(index).toContain('qoder.stop()')
  })

  it('Jet Hub RPC 传入 qoder 实例', () => {
    expect(index).toContain('registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai, qoder, trae)')
  })

  it('续期调度只看 refreshable，不看 enabled（AGENTS.md 强制约定）', () => {
    // 真实缺陷：写成 `a.refreshable && a.enabled` 后，所有账号被停用时
    // 续期定时器根本不启动，凭据一路过期到 refresh_token 失效。
    const code = codeOnly(index)
    expect(code).toContain('accounts.some(a => a.refreshable)')
    expect(code).not.toContain('a.refreshable && a.enabled')
  })

  it('账号池 provider 实参用 QODER.id 而非字面量', () => {
    // 写死 'qoder' 在改名/多产品场景下会静默查不到账号
    expect(index).toContain('getAvailableAccount(QODER.id')
  })
})

describe('Qoder Jet Hub RPC 分支（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')

  it('registerJetHubRpc 接受 qoder 形参', () => {
    expect(rpc).toContain('qoder: QoderAuth')
  })

  it('account.create 有 qoder 的两步式分支', () => {
    const code = codeOnly(rpc)
    expect(code).toContain('QODER.id')
    expect(code).toContain('qoder.startLogin(')
  })

  it('account.refresh 分派包含 qoder', () => {
    expect(codeOnly(rpc)).toContain('qoder.refreshAccountCredential(entry.credentialRef)')
  })

  it('credits.balances 有 qoder 分支（余额接口只需 Bearer，可用）', () => {
    // 实测修正：Qoder 的余额端点 `/sash/api/v2/me/usage` 只需
    // Bearer + Cosy-ClientType（**不需要** WASM 签名），故余额能力为 true。
    // 早期误判「无积分端点」是因为只按 `/api/` 前缀搜索。
    const code = codeOnly(rpc)
    const creditsStart = code.indexOf("case 'credits.balances'")
    const creditsEnd = code.indexOf("case 'model.list'")
    expect(creditsStart).toBeGreaterThan(-1)
    const creditsBlock = code.slice(creditsStart, creditsEnd)
    expect(creditsBlock).toContain('QODER.id')
    expect(creditsBlock).toContain('fetchQoderCreditBalance')
  })

  it('credits.claimAll 不含 qoder（无签到能力）', () => {
    // 签到能力仍为 false：`/sash/api/v1/me/campaigns` 实测 claimable:false，
    // 且逆向未发现签到动作端点。claimAll 分支不应出现 qoder。
    const code = codeOnly(rpc)
    const start = code.indexOf("case 'credits.claimAll'")
    const end = code.indexOf("case 'credits.balances'")
    expect(start).toBeGreaterThan(-1)
    expect(code.slice(start, end)).not.toContain('QODER.id')
  })
})
