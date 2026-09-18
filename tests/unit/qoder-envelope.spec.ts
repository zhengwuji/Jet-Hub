import { describe, expect, it } from 'vitest'
import { unwrapQoderEnvelopeStream } from '../../src/qoder-envelope.js'
import { consumeOpenAiSse } from '../../src/openai-compat.js'

/**
 * 构造 Qoder 加密端点风格的**信封 SSE**。
 *
 * 真实形态（实测 2026-09-20）：
 * ```
 * data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[...]}","statusCodeValue":200,"statusCode":"OK"}
 * ```
 * 内层 `body` 是**标准 OpenAI chunk 的 JSON 字符串**（未加密）。
 */
function envelopeSse(innerFrames: readonly string[], trailing = '\n\n'): string {
  return innerFrames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('') + trailing
}

/** 一段标准 OpenAI 正文帧。 */
const textFrame = (text: string): string =>
  JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })

/** 标准结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })

/** 把字符串包成 Response（模拟网络流）。 */
function asResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集适配器产出的 chunk。 */
async function collect(response: Response): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of consumeOpenAiSse(response, {}, {
    label: 'qoder', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000,
  })) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('Qoder 信封 SSE 解包', () => {
  it('剥掉信封后正文可被适配器消费', async () => {
    const sse = envelopeSse([textFrame('你'), textFrame('好'), finishFrame])
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    const text = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text as string)
      .join('')
    expect(text).toBe('你好')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reasoning_content 也要能透出（思考模型）', async () => {
    const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中' }, index: 0 }] })
    const sse = envelopeSse([reasoning, textFrame('答'), finishFrame])
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('思考中')
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('答')
  })

  it('分块到达（跨 chunk 截断）也要正确拼接', async () => {
    const sse = envelopeSse([textFrame('跨'), textFrame('块')], '')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(sse)
        // 故意在 JSON 中间切开
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.subarray(i, i + 7))
        }
        controller.close()
      },
    })
    const chunks = await collect(
      unwrapQoderEnvelopeStream(new Response(stream, { status: 200 }), 'qoder'),
    )
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('跨块')
  })

  it('业务错误帧必须抛错，不得静默 finish', async () => {
    // 真实错误形态：内层 body 是 [FAIL]node:... 的业务 JSON
    const fail = JSON.stringify({
      code: '400',
      message: '[FAIL]node:oa_qwen-plus-2025-04-28 msg:Execution failed: null',
    })
    const sse = envelopeSse([fail])
    await expect(collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))).rejects.toThrow(
      /Execution failed/,
    )
  })

  it('错误信息里保留 code 便于定位', async () => {
    const fail = JSON.stringify({ code: '400', message: '[FAIL]node:x msg:boom' })
    const error = await collect(unwrapQoderEnvelopeStream(asResponse(envelopeSse([fail])), 'qoder'))
      .catch((e: unknown) => e)
    expect((error as Error).message).toContain('400')
    expect((error as Error).message).toContain('boom')
  })

  it('非信封的标准帧原样透传（容错）', async () => {
    const sse = `data: ${textFrame('原生')}\n\ndata: ${finishFrame}\n\n`
    const chunks = await collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('原生')
  })

  it('event: 行保留（event: error 对诊断有价值）', async () => {
    const sse = `event: error\ndata: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`
    await expect(collect(unwrapQoderEnvelopeStream(asResponse(sse), 'qoder'))).rejects.toThrow(/boom/)
  })

  it('没有 body 的响应要明确报错', () => {
    const response = { body: null, status: 200, statusText: 'OK' } as unknown as Response
    expect(() => unwrapQoderEnvelopeStream(response, 'qoder')).toThrow(/body/)
  })
})
