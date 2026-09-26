import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8')

/**
 * 源码级回归：新增 provider 的接线点一处都不能漏。
 * 历史缺陷正是「加了 provider 但忘了在 modelAdapters 里登记」→
 * 设置页里被关闭的模型显示成裸 id（丢倍率）。
 */
describe('Loomy 在 index.ts 的接线', () => {
  it('导入并实例化 LoomyAuth', () => {
    expect(indexSource).toContain("from './loomy-auth.js'")
    expect(indexSource).toContain('new LoomyAuth(ctx)')
  })

  it('注册 Loomy 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './loomy-adapter.js'")
    expect(indexSource).toContain('registerLoomyLlm(ctx,')
    expect(indexSource).toMatch(/const loomyAdapter = registerLoomyLlm/)
  })

  it('provider 解析用 LOOMY.id（不写死字面量）', () => {
    expect(indexSource).toContain("pool.getAvailableAccount(LOOMY.id, '')")
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    expect(indexSource).toMatch(/loomy\.refreshAccountCredential\(available\.entry\.credentialRef\)/)
  })

  it('settings namespace 已注册', () => {
    expect(indexSource).toMatch(/registerProviderSettings\([\s\S]*?'llm-loomy'/)
  })

  it('加入批量续期调度', () => {
    expect(indexSource).toMatch(/await loomy\.refreshAll\(pool\)/)
  })

  it('cleanup 调用 loomy.stop()', () => {
    expect(indexSource).toMatch(/loomy\.stop\(\)/)
  })

  it('modelAdapters 里登记了 loomy', () => {
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?loomy: loomyAdapter/)
  })

  it('registerJetHubRpc 传入了 loomy', () => {
    // ⚠️ 断言到 `loomy` 与 `modelAdapters` 之间**不限定**具体参数 ——
    // 每新增一个 provider 都会在这中间插一个实参（raccoon 即如此），
    // 写死 `cline, loomy, modelAdapters` 会让每次新增 provider 都误报失败。
    expect(indexSource).toMatch(/registerJetHubRpc\([\s\S]*?loomy,[\s\S]*?modelAdapters\)/)
  })

  /**
   * ⚠️ 远端模型目录必须用 **token 头**（业务端点），不是 Bearer。
   * 带错会得到 `100002 缺少 token`，表现为「模型列表永远是兜底表」。
   */
  it('fetchRemoteModels 用 token 头请求 /models', () => {
    // ⚠️ 不能用 `indexOf('fetchRemoteModels')` —— 那个字符串在文件里出现 6 次
    // （每个 provider 一次），会命中 CodeArts 的那处。用 Loomy 专属锚点。
    const start = indexSource.indexOf('LOOMY.apiBase}/models')
    expect(start).toBeGreaterThan(-1)
    const body = indexSource.slice(Math.max(0, start - 400), start + 200)
    expect(body).toContain('token: credential.access_token')
    expect(body).toContain('token') // 业务端点用 token 头
  })
})
