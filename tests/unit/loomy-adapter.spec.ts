import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '18611112222',
}

/** 实测的远端模型条目（2026-09-26 GET /api/v1/models 的真实形状）。 */
function remoteEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 （x4.0）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 512_000,
    capabilities: {
      reasoning: true, vision: true, function_calling: true,
      input_modalities: ['text', 'image', 'video'], output_modalities: ['text'],
    },
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof LoomyAdapter>[0]> = {}) {
  return new LoomyAdapter({
    credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
    resolveCredential: async () => CRED,
    refresh: async () => {},
    ...over,
  })
}

describe('parseLoomyRemoteModels', () => {
  it('只保留 type=chat，并把倍率规范化进 name', () => {
    const models = parseLoomyRemoteModels({
      object: 'list',
      data: [
        remoteEntry(),
        remoteEntry({ id: 'Hy-Image-3.5-preview', name: 'Hy image 3.5 preview', type: 'image' }),
      ],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('MiniMax-M3')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
    expect(models[0]!.contextWindow).toBe(1_048_576)
    expect(models[0]!.supportsImage).toBe(true)
    expect(models[0]!.supportsThinking).toBe(true)
  })

  it('接受裸数组与 {data:[]} 两种形态', () => {
    expect(parseLoomyRemoteModels([remoteEntry()])).toHaveLength(1)
    expect(parseLoomyRemoteModels({ data: [remoteEntry()] })).toHaveLength(1)
  })

  it('畸形输入返回空数组（不抛）', () => {
    expect(parseLoomyRemoteModels(null)).toEqual([])
    expect(parseLoomyRemoteModels('x')).toEqual([])
    expect(parseLoomyRemoteModels({ data: 'x' })).toEqual([])
  })

  it('input_modalities 不含 image 时 supportsImage 为 false', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731（x3.0）',
        capabilities: { reasoning: true, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.supportsImage).toBe(false)
  })
})

describe('LoomyAdapter.listModels', () => {
  it('远端可用时用远端（带倍率）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry(), remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(2)
    expect(models[0]!.provider).toBe('loomy')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
  })

  it('远端失败时回退兜底表（8 个，兜底表名已含倍率）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(8)
    expect(models.map((m) => m.id)).toContain('qwen3.8-flash')
  })

  it('无账号池时目录可见（headless/单测保守放行）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('有账号池但未登录时返回空数组（不抛错）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('loomy')).toEqual([])
  })

  it('黑名单里的模型被过滤', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const ids = (await adapter.listModels('loomy')).map((m) => m.id)
    expect(ids).not.toContain('spark-x')
    expect(ids.length).toBe(7)
  })
})

describe('LoomyAdapter.listAllModels', () => {
  it('不套黑名单，且带最终展示名', () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const all = adapter.listAllModels()
    // 被关闭的 spark-x 也必须出现（否则用户无法重新打开）
    expect(all.map((m) => m.id)).toContain('spark-x')
    expect(all.find((m) => m.id === 'spark-x')!.name).toBe('Spark X2.5 · x0.1')
  })
})

describe('LoomyAdapter.resolveModel', () => {
  it('name 不带倍率（价格只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    expect(resolved.name).toBe('Spark X2.5')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'nope')
    expect(resolved.context).toBeUndefined()
  })
})

describe('LoomyAdapter.providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    expect(makeAdapter().providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy (讯飞)' })
  })

  it('provider 非法时回退到产品 id（避免 undefined.toUpperCase 崩）', () => {
    expect(makeAdapter().providerInfo(undefined as never).id).toBe('loomy')
  })
})
