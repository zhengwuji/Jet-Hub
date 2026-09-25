import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ClineAdapter, isClineRotatableFailure, recordsClineRateLimit } from '../../src/cline-adapter.js'
import { CLINE } from '../../src/cline-product.js'
import { mergeClineModels, type ClineModel } from '../../src/cline-models.js'
import type { ClineCredential } from '../../src/cline.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 实测凭据形态（access_token 自带 workos: 前缀）。 */
const cred: ClineCredential = {
  access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
  refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
  expire_time: Date.now() + 3_600_000,
  account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
  email: 'ijetlee@163.com',
  nickname: 'ijetlee@163.com',
}

/** 固定目录（离线；含免费与付费条目）。 */
const MODELS: ClineModel[] = mergeClineModels(CLINE, {
  freeIds: ['cline-free/deepseek-v4.1-flash', 'cline-free/gemini-3.8-flash'],
  remoteIds: ['deepseek/deepseek-v4.1-flash', 'openai/gpt-6-luna'],
  entries: [
    { id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-v4.1-Flash' },
    { id: 'cline-free/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  ],
})

/** 构造适配器（默认注入凭据 + 固定目录，完全离线）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof ClineAdapter>[0]> = {}): ClineAdapter {
  return new ClineAdapter({
    credentialRef: { name: 'CLINE_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: CLINE,
    loadModels: async () => ({ models: MODELS, warnings: [] }),
    ...overrides,
  })
}

/** 标准 OpenAI SSE 帧。 */
function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(
  adapter: ClineAdapter,
  options: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'cline-free/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('ClineAdapter 模型目录', () => {
  it('免费模型在 name 里标出（远端 free 集合驱动）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // 展示名优先取**兜底表**（内嵌目录的正式名，与 Cline IDE 显示一致，
    // 即用户截图里的 "DeepSeek V4.1 Flash (free)"），而非远端 slug
    //（"Deepseek-v4.1-Flash"）。标记统一由 clineDisplayName 拼。
    expect(byId.get('cline-free/deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash · 免费')
    expect(byId.get('cline-free/gemini-3.8-flash')?.name).toBe('Gemini 3.8 Flash · 免费')
  })

  it('付费模型不标免费（同名但不同命名空间）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // ⚠️ 核心不变式：`deepseek/deepseek-v4.1-flash` 是**另一个**计费实体
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.name).not.toContain('免费')
    expect(byId.get('openai/gpt-6-luna')?.name).not.toContain('免费')
  })

  it('目录含远端全部模型（用户要求「全部列出」）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const ids = models.map((m) => m.id)
    expect(ids).toContain('cline-free/deepseek-v4.1-flash')
    expect(ids).toContain('deepseek/deepseek-v4.1-flash')
    expect(ids).toContain('openai/gpt-6-luna')
  })

  it('listAllModels 也带免费标记（设置页能看到正确展示名）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    const entry = models.find((m) => m.id === 'cline-free/deepseek-v4.1-flash')
    expect(entry?.name).toBe('DeepSeek V4.1 Flash · 免费')
  })

  it('未加载完成时 listAllModels 回退兜底表（仍含 5 个免费模型）', () => {
    const adapter = makeAdapter({ loadModels: async () => { throw new Error('offline') } })
    const models = adapter.listAllModels()
    expect(models.length).toBe(CLINE.fallbackModels.length)
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(5)
  })

  it('远端目录两个端点都失败时仍返回兜底表', async () => {
    const adapter = makeAdapter({
      loadModels: async () => ({ models: [], warnings: ['recommended-models boom', 'models boom'] }),
    })
    const models = await adapter.listModels('cline')
    expect(models.length).toBe(CLINE.fallbackModels.length)
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(5)
  })

  it('黑名单过滤只作用于 listModels，不影响 listAllModels', async () => {
    const disabled = new Set(['cline-free/deepseek-v4.1-flash'])
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => disabled,
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const listed = await adapter.listModels('cline')
    expect(listed.map((m) => m.id)).not.toContain('cline-free/deepseek-v4.1-flash')
    // 设置页必须仍能看到它（否则无法重新打开）
    expect(adapter.listAllModels().map((m) => m.id)).toContain('cline-free/deepseek-v4.1-flash')
  })

  it('没有任何已登录账号时返回空数组（目录门控）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('cline')).toEqual([])
  })

  it('目录门控不可用（替身未实现 hasLoggedInAccount）时保守放行', async () => {
    const adapter = makeAdapter({ accountPool: { disabledModelsFor: () => new Set<string>() } as never })
    expect((await adapter.listModels('cline')).length).toBeGreaterThan(0)
  })
})

describe('ClineAdapter resolveModel', () => {
  it('name 不带免费标记（标记只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.name).toBe('DeepSeek V4.1 Flash')
    expect(resolved.name).not.toContain('免费')
  })

  it('声明 defaultMaxTokens（否则上限永久退回网关默认值）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.defaultMaxTokens).toBe(131_072)
  })

  it('声明 context（内嵌目录的 contextWindow）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context / defaultMaxTokens', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.name).toBe('unknown/model-x')
  })

  it('inputModalities 按模型判定（图片能力）', async () => {
    const adapter = makeAdapter()
    const withImage = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(withImage.inputModalities).toContain('image')
    const unknown = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(unknown.inputModalities).toEqual(['text'])
  })
})

describe('ClineAdapter 请求构造', () => {
  it('POST 到 OpenAI 兼容端点，鉴权头保留 workos: 前缀', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const adapter = makeAdapter({
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(calls[0]!.url).toBe('https://api.cline.bot/api/v1/chat/completions')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer workos:eyJhbGciOiJSUzI1NiIs')
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('请求体是标准 OpenAI 形状（model / messages / stream）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(body.model).toBe('cline-free/deepseek-v4.1-flash')
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('system 提示并入 messages 顶部', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { system: 'be terse' })
    const body = JSON.parse(bodies[0]!) as { messages: Array<{ role: string }> }
    expect(body.messages[0]!.role).toBe('system')
  })

  it('工具定义真的下发（顶层 tools，OpenAI 风格）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, {
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    })
    const body = JSON.parse(bodies[0]!) as { tools: Array<{ type: string; function: { name: string } }> }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.type).toBe('function')
    expect(body.tools[0]!.function.name).toBe('read_file')
  })

  it('max_tokens 收敛到安全上限（不编造、不超界）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { maxTokens: 9_999_999 })
    const body = JSON.parse(bodies[0]!) as { max_tokens: number }
    expect(body.max_tokens).toBe(943_718)
  })

  it('reasoningEffort 透传为 reasoning_effort', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { reasoningEffort: 'high' })
    expect((JSON.parse(bodies[0]!) as { reasoning_effort: string }).reasoning_effort).toBe('high')
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/no usable credential/)
  })

  it('凭据过期时先续期再取新凭据', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      resolveCredential: async () => (refreshed
        ? { ...cred, access_token: 'workos:new-token' }
        : { ...cred, expire_time: 1 }),
      refresh: async () => { refreshed = true },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer workos:new-token')
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(refreshed).toBe(true)
  })
})

describe('ClineAdapter SSE 消费', () => {
  /**
   * ⚠️ **Cline 的思考字段是 `delta.reasoning`**，不是 `reasoning_content`。
   * 实测形态：`{"delta":{"reasoning":"The","reasoning_details":[…]}}`。
   * 只认后者会让思考内容被静默丢弃（用户看到「模型不思考」）。
   */
  it('消费 delta.reasoning 为 reasoning 块（Cline 特有字段名）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning: 'Let me think', reasoning_details: [{ type: 'reasoning.text', text: 'Let me think' }] } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'PONG' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('Let me think')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(text).toBe('PONG')
  })

  it('仍然消费 reasoning_content（Qoder / buddy 形态不回归）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('thinking')
  })

  it('工具调用按 index 合并', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const end = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string })?.type === 'tool-call')
    expect(end).toBeDefined()
    expect((end!.block as { name: string }).name).toBe('read_file')
  })
})

describe('ClineAdapter 限流与换号判定', () => {
  it('429 / 402 可换号', () => {
    expect(isClineRotatableFailure(429, '')).toBe(true)
    expect(isClineRotatableFailure(402, '')).toBe(true)
  })

  it('额度文案命中可换号（中英双通道）', () => {
    expect(isClineRotatableFailure(400, 'insufficient credit')).toBe(true)
    expect(isClineRotatableFailure(400, '积分不足')).toBe(true)
  })

  it('400 请求格式错 / 5xx 服务端故障不换号（换号无用）', () => {
    expect(isClineRotatableFailure(400, 'invalid request format')).toBe(false)
    expect(isClineRotatableFailure(500, 'internal error')).toBe(false)
  })

  it('只有 429 / 402 记限流徽章（徽章含义必须是「受限」而非「出过错」）', () => {
    expect(recordsClineRateLimit(429, '')).toBe(true)
    expect(recordsClineRateLimit(402, '')).toBe(true)
    expect(recordsClineRateLimit(400, 'insufficient credit')).toBe(false)
  })

  it('限流时换到下一个账号并成功', async () => {
    let call = 0
    const adapter = makeAdapter({
      resolveCredential: async () => cred,
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => true,
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: 'acc-2', credentialRef: 'CLINE_ACCOUNT_2' },
          credential: { ...cred, access_token: 'workos:second' },
        }),
      } as never,
      fetchImpl: (async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(call).toBe(2)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
  })
})

describe('Cline 接线（源码级回归）', () => {
  const root = resolve(here, '../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

  it('index.ts 注册 cline 服务、适配器与续期', () => {
    const source = read('src/index.ts')
    expect(source).toContain('registerClineLlm')
    expect(source).toContain('new ClineAuth(ctx)')
    expect(source).toContain('cline.refreshAll(pool)')
    expect(source).toContain('cline.stop()')
    // Jet Hub「显示列表」需要适配器实例
    expect(source).toContain('cline: clineAdapter')
    expect(source).toContain('registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai, qoder, trae, cline, modelAdapters)')
    // 老契约下的 settings namespace
    expect(source).toContain("'llm-cline'")
  })

  it('jet-hub-rpc.ts 为 cline 接上登录、续期与余额三个分派点', () => {
    const source = read('src/jet-hub-rpc.ts')
    expect(source).toContain('cline.startLogin({ refName })')
    expect(source).toContain('cline.refreshAccountCredential(entry.credentialRef)')
    expect(source).toContain('fetchClineCreditBalance(credential, CLINE)')
    // 签到必须显式拒绝（而不是落到 unsupported provider 的泛化文案）
    expect(source).toContain('Cline 不支持每日签到')
  })

  it('客户端 PROVIDERS 含 cline 且有图标', () => {
    const source = read('plugin-src/client/jet-hub.js')
    expect(source).toMatch(/\{\s*id:\s*'cline',\s*label:\s*'Cline'/)
    expect(source).toContain('const CLINE_ICON')
  })

  it('能力矩阵登记 cline 为「有余额、无签到」', () => {
    const source = read('plugin-src/client/credits-capabilities.js')
    expect(source).toMatch(/cline:\s*Object\.freeze\(\{\s*balance:\s*true,\s*dailyCheckin:\s*false\s*\}\)/)
  })
})
