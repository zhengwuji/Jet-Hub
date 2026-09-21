import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { QoderAdapter } from '../../src/qoder-adapter.js'
import { QODER } from '../../src/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/qoder.js'

/** 源码级断言的路径基准（与 `jet-hub-rpc.spec.ts` 同款）。 */
const here = dirname(fileURLToPath(import.meta.url))

const cred: QoderCredential = buildQoderCredential(
  // ⚠️ `uid` 是**加密推理必需**的（`generate_runtime_auth_fields` 用它派生
  // `encrypt_user_info`）；缺了 WASM 会挂起。真实值来自设备码响应的 `user_id`。
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' })

/** 构造适配器（默认注入可用凭据与 noop refresh）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof QoderAdapter>[0]> = {}): QoderAdapter {
  return new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    ...overrides,
  })
}

/** 一段标准 OpenAI 正文帧。 */
function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })
}

/** 一段标准 OpenAI 结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })

/**
 * 构造**加密端点风格**的信封 SSE 响应。
 *
 * 真实形态（实测）：每帧多一层 `{headers, body, statusCode}` 包装，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 */
function envelopeResponse(frames: string[]): Response {
  const body = frames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(adapter: QoderAdapter, model = 'auto'): Promise<Array<Record<string, unknown>>> {
  return collectWith(adapter, {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/** 用**自定义 options** 收集一次 stream 的全部 chunk。 */
async function collectWith(
  adapter: QoderAdapter,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('QoderAdapter 模型目录', () => {
  it('listModels 返回兜底表（本插件不发远端请求）', async () => {
    const models = await makeAdapter().listModels('qoder')
    expect(models.length).toBe(QODER.fallbackModels.length)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(models.every((m) => m.provider === 'qoder')).toBe(true)
  })

  it('listModels 应用 Jet Hub 黑名单', async () => {
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set(['auto']) } as never,
    })
    const models = await adapter.listModels('qoder')
    expect(models.some((m) => m.id === 'auto')).toBe(false)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
  })

  // 目录门控：没有已登录账号时不显示该 provider 的任何模型。
  // 见 `providerCatalogVisible`（src/account-pool.ts）。
  describe('无已登录账号时隐藏整个 provider 目录', () => {
    it('没有已登录账号 → 返回空数组', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => false,
        } as never,
      })
      expect(await adapter.listModels('qoder')).toEqual([])
    })

    it('有已登录账号 → 正常返回目录', async () => {
      const adapter = makeAdapter({
        accountPool: {
          disabledModelsFor: () => new Set<string>(),
          hasLoggedInAccount: async () => true,
        } as never,
      })
      expect((await adapter.listModels('qoder')).length).toBe(QODER.fallbackModels.length)
    })
  })

  it('providerInfo 返回 qoder', () => {
    expect(makeAdapter().providerInfo('qoder')).toEqual({ id: 'qoder', name: QODER.displayName })
  })

  // 计费倍率展示（目录 `price_factor`）。
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（ModelSelect 的 `children: model.name`），`description` 仅用于
  // `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」。
  describe('listModels 的计费倍率', () => {
    it('price_factor=0 显示为「免费」而非 x0', async () => {
      // 实测 Qwen3.8-Flash（qfmodel）的 price_factor 正是 0。
      const models = await makeAdapter().listModels('qoder')
      const flash = models.find((m) => m.id === 'qfmodel')
      expect(flash?.name).toBe('Qwen3.8-Flash · 免费')
    })

    it('其余模型显示 x 倍率（数值对照真实 catalog）', async () => {
      const models = await makeAdapter().listModels('qoder')
      // ⚠️ 早期用例断言的是 `x0.8` / `x3.2` —— 那是兜底表的**过期估值**，
      // 真实 catalog 为 0.5 / 8（用户报障后逐条校正，见 qoder-product.spec.ts）。
      expect(models.find((m) => m.id === 'dmodel')?.name).toBe('DeepSeek-V4-Pro · x0.5')
      expect(models.find((m) => m.id === 'gfmodel')?.name).toBe('GLM-5.3-Flash · x0.1')
      expect(models.find((m) => m.id === 'smodel')?.name).toBe('Sonus · x8')
    })

    // ⚠️ 角标**不再**由目录快照 `promotion.active` 决定 —— 那是采集时刻的值，
    // 会随错峰窗口切换而失真。真实判据是 `windowStart`/`windowEnd` 的本地推算
    // （边界用例见 qoder-product.spec.ts 的「错峰时段判定」）。
    // 这里只验证**无窗口字段时的回退行为**，与当前钟点无关、恒定可复现。
    it('无窗口字段时回退到 active：false 不显示角标、用原价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: false, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口外 → 原价、无角标（避免用户按折扣价预期却被按原价计费）
      expect(models[0]?.name).toBe('Promo · x0.5')
      expect(models[0]?.name).not.toContain('折')
    })

    it('无窗口字段时回退到 active：true 显示 原价→折后价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口内 → `原价→折后价`（0.5→0.2），与 TRAE / buddy 同形态。
      // ⚠️ 旧形态是 `x0.2 错峰 4 折`（只有折后价 + 角标），用户要求对齐 TRAE。
      expect(models[0]?.name).toBe('Promo · x0.5→x0.2')
    })

    it('无 priceFactor 时 name 保持原样（不编造倍率）', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{ id: 'unknown', name: 'Unknown', contextWindow: 1000 }],
      }
      const adapter = makeAdapter({ product: product as never })
      expect((await adapter.listModels('qoder'))[0]?.name).toBe('Unknown')
    })

    // resolveModel 的 name 用于会话中的模型显示，**不带**价格后缀
    // （价格只属于选择列表这个语境）。
    it('resolveModel 的 name 不带倍率后缀', async () => {
      expect((await makeAdapter().resolveModel('qoder', 'qfmodel')).name).toBe('Qwen3.8-Flash')
    })
  })
})

describe('QoderAdapter resolveModel', () => {
  it('已知模型带 contextWindow 与展示名', async () => {
    // dmodel = DeepSeek-V4-Pro，实测 max_input_tokens=1000000
    const resolved = await makeAdapter().resolveModel('qoder', 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('未知模型不编造 context（id 即 name）', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'some-future-model')
    expect(resolved.name).toBe('some-future-model')
    expect(resolved.context).toBeUndefined()
  })

  it('inputModalities 按模型的 supportsImage 判定', async () => {
    const adapter = makeAdapter()
    // 实测 17 个目录模型 is_vl 全为 true
    expect((await adapter.resolveModel('qoder', 'dmodel')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('qoder', 'qmodel_38max')).inputModalities).toEqual(['text', 'image'])
    // 未知模型保守报 text（宁可少报能力）
    expect((await adapter.resolveModel('qoder', 'unknown-x')).inputModalities).toEqual(['text'])
  })
})

describe('QoderAdapter 请求构造（加密端点）', () => {
  it('URL 指向 api2.qoder.sh 的 agent_chat_generation（**不是** api2-v2）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const url = String(call[0])
    // ⚠️ 加密端点与公开端点是**不同 host**：混用会 404
    expect(url.startsWith('https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation')).toBe(true)
    expect(url).toContain('Encode=1')
    expect(url).not.toContain('api2-v2')
  })

  it('请求体是**加密**的（不是 JSON），且带 X-Model-Key 头', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const body = String((call[1] as { body: string }).body)
    // 加密体不是 JSON（朴素 JSON.parse 会失败）
    expect(() => JSON.parse(body)).toThrow()
    expect(body.length).toBeGreaterThan(0)
    // 模型 key 走独立头（服务端据此路由）
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    expect(get('X-Model-Key')).toBe('auto')
    expect(get('X-Model-Source')).toBe('system')
  })

  it('Authorization 是 WASM 生成的 COSY 签名，**不是**普通 Bearer token', async () => {
    // ⚠️ 用普通 `Bearer <token>` 覆盖会得到 403 Signature invalid。
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    const auth = get('authorization')
    expect(auth).toContain('Bearer COSY.')
    expect(auth).not.toBe('Bearer tok')
    expect(get('accept')).toBe('text/event-stream')
  })

  it('请求体必须含 `business`（缺了服务端路由到坏节点）', async () => {
    // ⚠️ 真实缺陷（2026-09-20 定位）：
    //   `qfmodel`（Qwen3.8-Flash）在**不带 `business`** 时恒落到故障节点
    //   `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`；
    //   补上 `business` 后立即正常（其余模型如 `qmodel_38max` 恰好不受影响，
    //   故极易误判为「该模型服务端故障」——IDE 里同一模型完全可用）。
    //
    // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
    // —— 服务端按 `business.type` 选路由池。
    //
    // 请求体是加密的，单测无法直接读字段，故用**源码级断言**锁死
    // （与 `jet-hub-rpc.spec.ts` 的守卫同款做法）。
    const source = readFileSync(resolve(here, '../../src/qoder-adapter.ts'), 'utf8')
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).toContain('business: { type:')
  })

  it('system 提示与用户文本都进加密体（本地不可解，只校验非空）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      model: 'auto',
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withSystem = String((call[1] as { body: string }).body)

    const fetchImpl2 = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    for await (const _ of makeAdapter({ fetchImpl: fetchImpl2 }).stream({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call2 = (fetchImpl2 as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withoutSystem = String((call2[1] as { body: string }).body)

    // 有 system 时密文更长（内容确实进了请求）
    expect(withSystem.length).toBeGreaterThan(withoutSystem.length)
  })
})

describe('QoderAdapter 鉴权与重试', () => {
  it('401 时刷新一次凭据后重试', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return envelopeResponse([textFrame('你好'), finishFrame])
    }) as unknown as typeof fetch
    const refresh = vi.fn(async () => {})
    const chunks = await collect(makeAdapter({ fetchImpl, refresh }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/log in|凭据|credential/i)
  })
})

describe('QoderAdapter SSE 解析', () => {
  it('解析正文与 reasoning_content', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      textFrame('你好'),
      finishFrame,
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
  })

  it('delta.content 显式为 null 时不崩溃（真实形态）', async () => {
    // 实测：一个模型要么走 content、要么走 reasoning_content，另一侧恒为 null
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: 'r' } }] }),
      finishFrame,
    ])) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).resolves.toBeDefined()
  })

  it('工具调用分片合并', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1',
        function: { name: 'read', arguments: '{"p"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
        function: { arguments: ':"x"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    const end = chunks.find((c) => c.type === 'block-end'
      && (c.block as { type?: string } | undefined)?.type === 'tool-call')
    expect(end).toBeDefined()
    const block = end!.block as { name: string; arguments: string }
    expect(block.name).toBe('read')
    expect(block.arguments).toBe('{"p":"x"}')
  })
})

describe('QoderAdapter SSE 错误帧（真实缺陷：报错被静默吞掉）', () => {
  /**
   * 真实缺陷（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止了」。
   *
   * 服务端对无效模型的真实响应（实测 2026-09-19）：
   * ```
   * event: error
   * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
   *        "request_id":"...","type":"invalid_model_error"}
   * ```
   *
   * ⚠️ 两处与 OpenAI 标准不同，早期实现因此**整帧丢弃**：
   * 1. 有独立的 `event: error` 行（我们的解析器只处理 `data:` 行）；
   * 2. 错误信息在**顶层 `code`/`message`**，而非 `{error: {message}}`。
   *
   * 后果：错误被当成「正常结束、无内容」→ 只产出
   * `[{type:'finish', reason:{kind:'stop'}}]`，UI 表现为
   * 「没回复就干净地停止」，用户看不到任何原因。
   */
  const errorFrame = 'event: error\ndata: {"code":"invalid_model_error","message":"Unsupported model \\"qfmodel\\"","request_id":"abc","type":"invalid_model_error"}\n\n'

  it('顶层 code/message 的错误帧必须抛错，而不是静默 finish', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/Unsupported model/)
  })

  it('错误必须带上服务端 message，便于用户定位', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const error = await collect(makeAdapter({ fetchImpl })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('invalid_model_error')
    expect((error as Error).message).toContain('qfmodel')
  })

  it('标准 OpenAI 形态 {error:{message}} 仍要抛错（不回归）', async () => {
    const frame = 'data: {"error":{"message":"boom"}}\n\n'
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/boom/)
  })

  it('正常帧不受影响（event: 行被忽略，data 帧照常解析）', async () => {
    const frame = `event: message\ndata: ${textFrame('你好')}\ndata: ${finishFrame}\ndata: [DONE]\n\n`
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('QoderAdapter 图片输入', () => {
  it('不支持图片的模型收到图片时报 UNSUPPORTED_CONTENT', async () => {
    // 实测真实模型 is_vl 全为 true，故用**未知模型**测「保守报 text」这条路径
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl, readImage: async () => undefined })
    const iterate = async (): Promise<void> => {
      for await (const _ of adapter.stream({
        model: 'text-only-unknown',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ],
        }],
      } as never)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/不支持图片/)
  })

  it('支持图片的模型接受图片并真的读取了附件', async () => {
    // ⚠️ 请求体已加密，无法再断言明文 image_url 形态
    // （那是公开端点的形态）。且加密体长度因分块填充而**不单调**，
    // 也不能用长度断言。这里验证真正可观察的行为：
    //   1. 不抛 UNSUPPORTED_CONTENT（图片被接受）
    //   2. readImage 被调用（附件确实被读取，而非静默丢弃）
    const readImage = vi.fn(async (): Promise<{ data: Uint8Array; mediaType: string }> =>
      ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))

    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const chunks = await collectWith(makeAdapter({ fetchImpl, readImage }), {
      model: 'dmodel',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
    })

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})
