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
describe('Raccoon 在 index.ts 的接线', () => {
  it('导入并实例化 RaccoonAuth', () => {
    expect(indexSource).toContain("from './raccoon-auth.js'")
    expect(indexSource).toContain('new RaccoonAuth(ctx)')
  })

  it('注册 Raccoon 适配器并接收返回值', () => {
    expect(indexSource).toContain("from './raccoon-adapter.js'")
    expect(indexSource).toContain('registerRaccoonLlm(ctx,')
    expect(indexSource).toMatch(/const raccoonAdapter = registerRaccoonLlm/)
  })

  it('provider 解析用 RACCOON.id（不写死字面量）', () => {
    expect(indexSource).toContain("pool.getAvailableAccount(RACCOON.id, '')")
  })

  it('refresh 走 refreshAccountCredential（刷新解析凭据所用的那个账号）', () => {
    expect(indexSource).toMatch(/raccoon\.refreshAccountCredential\(available\.entry\.credentialRef\)/)
  })

  it('settings namespace 已注册', () => {
    expect(indexSource).toMatch(/registerProviderSettings\([\s\S]*?'llm-raccoon'/)
  })

  it('加入批量续期调度', () => {
    expect(indexSource).toMatch(/await raccoon\.refreshAll\(pool\)/)
  })

  it('modelAdapters 里登记了 raccoon', () => {
    expect(indexSource).toMatch(/const modelAdapters[\s\S]*?raccoon: raccoonAdapter/)
  })

  it('registerJetHubRpc 传入了 raccoon', () => {
    // ⚠️ 不限定 raccoon 与 modelAdapters 之间的具体实参：将来新增 provider
    // 会在此处插入新参数，写死顺序会让每次扩展都误报失败。
    expect(indexSource).toMatch(/registerJetHubRpc\([\s\S]*?raccoon,[\s\S]*?modelAdapters\)/)
  })

  it('fetchRemoteModels 委托给 RaccoonAuth.fetchModels', () => {
    const start = indexSource.indexOf('fetchRemoteModels: () => raccoon.fetchModels')
    expect(start).toBeGreaterThan(-1)
  })

  it('凭据类型标注为 RaccoonCredential（不是 any）', () => {
    expect(indexSource).toContain("from './raccoon.js'")
    expect(indexSource).toMatch(/RaccoonCredential/)
  })
})
