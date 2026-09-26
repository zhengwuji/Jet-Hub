import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { RACCOON } from '../../src/raccoon-product.js'
import { RaccoonAdapter, registerRaccoonLlm } from '../../src/raccoon-adapter.js'
import type { RaccoonCredential } from '../../src/raccoon.js'
import { raccoonDisplayName } from '../../src/raccoon.js'
import type { AccountPool } from '../../src/account-pool.js'

/** 所有已创建的 service；afterEach 统一释放。 */
const services: Array<{ [Symbol.dispose]?: () => void }> = []

function makeContext(): Context {
  return new Context()
}

afterEach(() => {
  for (const s of services.splice(0)) s[Symbol.dispose]?.()
})

const CRED: RaccoonCredential = { access_token: 'tok', refresh_token: 'r' }

/** 造一个远端模型条目。 */
function remoteModel(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sn-glm-5-3',
    description: 'GLM-5-3',
    visible: true,
    tags: ['general'],
    ability_level: 2,
    params: { context_window: 1_000_000, max_tokens: 100_000 },
    billing_multiplier: 0.75,
    billing_effective_multiplier: 0.75,
    billing_status: 'normal',
    ...patch,
  }
}

/** 造一个 adapter（默认：有凭据、有远端目录、无账号池）。 */
function makeAdapter(patch: {
  models?: Record<string, unknown>[]
  credential?: RaccoonCredential | undefined
  pool?: AccountPool
  fetcher?: typeof fetch
} = {}): RaccoonAdapter {
  const models = patch.models ?? [remoteModel()]
  const adapter = new RaccoonAdapter({
    credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
    resolveCredential: async () => ('credential' in patch ? patch.credential : CRED),
    refresh: async () => {},
    // ⚠️ 生产路径是 `RaccoonAuth.fetchModels` → `raccoonDisplayName`（含倍率）。
    // 替身必须复现这一点，否则测试会断言到「裸 description」这个**生产不会出现**
    // 的形状，从而既测不出倍率丢失、又让人误以为实现有问题。
    fetchRemoteModels: async () => models.map((m) => {
      const params = (m.params ?? {}) as Record<string, unknown>
      return {
        id: String(m.name),
        name: raccoonDisplayName({
          id: String(m.name),
          description: String(m.description),
          effectiveMultiplier: typeof m.billing_effective_multiplier === 'number'
            ? m.billing_effective_multiplier : Number.NaN,
          baseMultiplier: typeof m.billing_multiplier === 'number'
            ? m.billing_multiplier : Number.NaN,
          status: 'normal',
          statusNote: '',
        }),
        contextWindow: Number(params.context_window ?? 0),
        maxTokens: Number(params.max_tokens ?? 0),
        supportsImage: Array.isArray(m.tags) && (m.tags as string[]).includes('vision'),
      }
    }),
    ...patch.pool === undefined ? {} : { accountPool: patch.pool },
    ...patch.fetcher === undefined ? {} : { fetchImpl: patch.fetcher },
  })
  services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
  return adapter
}

/** SSE 响应体。 */
function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 收集 stream 的全部 chunk。 */
async function collect(adapter: RaccoonAdapter, options: Partial<GenerateOptions>): Promise<StreamChunk[]> {
  const full = {
    provider: 'raccoon',
    model: 'sn-glm-5-3',
    messages: [{ role: 'user', content: 'hi' }],
    ...options,
  } as unknown as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(full)) chunks.push(c)
  return chunks
}

describe('providerInfo', () => {
  it('返回 id 与显示名', () => {
    const info = makeAdapter().providerInfo('raccoon')
    expect(info.id).toBe('raccoon')
    expect(info.name).toBe('Raccoon (商汤)')
  })

  it('provider 非字符串时回退到产品 id（不炸 toUpperCase）', () => {
    const info = makeAdapter().providerInfo(undefined as unknown as string)
    expect(info.id).toBe('raccoon')
  })
})

describe('listModels', () => {
  it('无账号池时返回全部模型（门控保守放行）', async () => {
    const models = await makeAdapter().listModels('raccoon')
    expect(models.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    expect(models[0]?.name).toBe('GLM-5-3 · x0.75')
  })

  it('**无已登录账号时返回空数组且不抛错**（DSH 据此隐藏整个分组）', async () => {
    const pool = {
      hasLoggedInAccount: async () => false,
      disabledModelsFor: () => new Set<string>(),
    } as unknown as AccountPool
    const models = await makeAdapter({ pool }).listModels('raccoon')
    expect(models).toEqual([])
  })

  it('应用黑名单', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const models = await makeAdapter({ pool }).listModels('raccoon')
    expect(models).toEqual([])
  })

  it('黑名单只影响目录，不影响 resolveModel（路由契约）', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.id).toBe('sn-glm-5-3')
  })
})

describe('listAllModels', () => {
  it('**不套黑名单**（设置页要显示被关闭的模型）', async () => {
    const pool = {
      hasLoggedInAccount: async () => true,
      disabledModelsFor: () => new Set(['sn-glm-5-3']),
    } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    // 远端目录是**惰性加载**的（首次 listModels/resolveModel 时拉取），
    // 故先触发一次加载，再断言 listAllModels。
    await adapter.listModels('raccoon')
    const all = adapter.listAllModels()
    expect(all.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    // 且带**最终展示名（含倍率）**，不是裸 id —— 这正是 listAllModels 的价值：
    // 被黑名单关掉的模型也能在设置页显示倍率与完整名称。
    expect(all[0]?.name).toBe('GLM-5-3 · x0.75')
  })

  it('远端拉取失败时回退兜底表（6 个模型，不带倍率）', async () => {
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
      fetchRemoteModels: async () => { throw new Error('down') },
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    // 先触发一次加载
    await adapter.listModels('raccoon')
    const all = adapter.listAllModels()
    expect(all.length).toBe(6)
    expect(all.map((m) => m.id)).toContain('sn-glm-5-3')
  })
})

describe('resolveModel', () => {
  it('**name 不带倍率**（价格只属于选择列表语境）', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.name).toBe('GLM-5-3')
  })

  it('声明 contextWindow 与 defaultMaxTokens', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(100_000)
  })

  it('未知模型不编造 context', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'nope')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('**远端非法 max_tokens 被过滤**（0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', async () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const adapter = makeAdapter({
        models: [remoteModel({ params: { context_window: 1000, max_tokens: bad } })],
      })
      const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
      expect(resolved.defaultMaxTokens, `max_tokens=${String(bad)} 应被过滤`).toBeUndefined()
    }
  })

  it('图片模态按 tags 含 vision 判定', async () => {
    const withVision = makeAdapter({ models: [remoteModel({ tags: ['vision'] })] })
    expect((await withVision.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities)
      .toEqual(['text', 'image'])
    const without = makeAdapter({ models: [remoteModel({ tags: ['general'] })] })
    expect((await without.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities)
      .toEqual(['text'])
  })
})

describe('stream', () => {
  it('**把 options.tools 真的下发到请求体顶层 tools**（Qoder/TRAE 的缺陷形态）', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {
      tools: [{
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    } as unknown as Partial<GenerateOptions>)

    expect(Array.isArray(seenBody.tools)).toBe(true)
    const tools = seenBody.tools as Array<Record<string, unknown>>
    expect(tools.length).toBe(1)
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'get_weather', description: '查天气' },
    })
  })

  it('无 tools 时不下发空数组', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }),
      ])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenBody.tools).toBeUndefined()
  })

  it('请求体含 model / messages / stream:true，且请求到正确端点', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`)
    expect(seenBody.model).toBe('sn-glm-5-3')
    expect(seenBody.stream).toBe(true)
    expect(Array.isArray(seenBody.messages)).toBe(true)
  })

  it('请求头带 Bearer 与 X-Org-Code', async () => {
    let seenHeaders: Record<string, string> = {}
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })])
    })
    await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    expect(seenHeaders.Authorization).toBe('Bearer tok')
    expect(seenHeaders['X-Org-Code']).toBe('')
  })

  it('解析标准 OpenAI SSE（content 成块）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '你' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(text).toBe('你好')
  })

  it('解析 reasoning_content（思考内容）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '答' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const reasoning = chunks
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(reasoning).toBe('想')
  })

  it('解析工具调用（finish_reason: tool_calls）', async () => {
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0, id: 'call_1', type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            }],
          },
        }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(makeAdapter({ fetcher: fetcher as unknown as typeof fetch }), {})
    const names = chunks
      .filter((c) => c.type === 'tool-call-start' || c.type === 'tool-call-delta')
      .map((c) => c as unknown as Record<string, unknown>)
    expect(names.length).toBeGreaterThan(0)
    expect(JSON.stringify(chunks)).toContain('get_weather')
  })

  it('无凭据时抛 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ credential: undefined })
    await expect(async () => {
      for await (const _ of adapter.stream({
        provider: 'raccoon', model: 'sn-glm-5-3',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as GenerateOptions)) { void _ }
    }).rejects.toThrow(/credential|登录/i)
  })

  it('给不支持图片的模型传图片时抛 UNSUPPORTED_CONTENT', async () => {
    // ⚠️ 必须注入 fetcher：否则判断通过后会真的发网络请求，
    // 用例就变成「因为 401 而失败」而不是「因为图片不支持而失败」。
    const fetcher = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] }),
    ]))
    const adapter = makeAdapter({
      models: [remoteModel({ tags: ['general'] })],
      fetcher: fetcher as unknown as typeof fetch,
    })
    await expect(async () => {
      for await (const _ of adapter.stream({
        provider: 'raccoon', model: 'sn-glm-5-3',
        messages: [{
          role: 'user',
          // ⚠️ 图片块的真实形状是 `{ type:'image', attachment:{ attachmentId } }`
          // —— 判据在 `collectImages` 里读的是 `attachment.attachmentId`。
          content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }],
        }],
      } as unknown as GenerateOptions)) { void _ }
    }).rejects.toThrow(/图片|UNSUPPORTED/i)
  })

  it('HTTP 401 时刷新一次再重试', async () => {
    let calls = 0
    let refreshed = false
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('{}', { status: 401 })
      return sseResponse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })])
    })
    const adapter = new RaccoonAdapter({
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => { refreshed = true },
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher as unknown as typeof fetch,
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    await collect(adapter, {})
    expect(refreshed).toBe(true)
    expect(calls).toBeGreaterThan(1)
  })
})

describe('registerRaccoonLlm', () => {
  it('注册到 ctx.llm 并返回适配器实例', () => {
    const ctx = makeContext()
    const registered: string[] = []
    ctx.provide('llm', {
      registerConfigurableProviders: (list: Array<{ provider: string }>) => {
        for (const item of list) registered.push(item.provider)
      },
      registerAdapter: (ids: string[]) => { for (const id of ids) registered.push(id) },
    } as never)
    const adapter = registerRaccoonLlm(ctx, {
      credentialRef: 'RACCOON_ACCESS_TOKEN' as never,
      resolveCredential: async () => CRED,
      refresh: async () => {},
    })
    services.push(adapter as unknown as { [Symbol.dispose]?: () => void })
    expect(registered).toContain('raccoon')
    expect(adapter).toBeInstanceOf(RaccoonAdapter)
  })
})
