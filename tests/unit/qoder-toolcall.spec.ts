/**
 * qwen3.8f（`qfmodel`）工具调用修复的**回归测试**。
 *
 * 背景：qoder 加密通路原先既不把 harness 的 `tools` 写进请求体，
 * 也不回放历史工具调用 ⇒ 上游「看不见工具」⇒ 表现为「qwen3.8f 无法调用工具」。
 *
 * 这两条在源码里的确切位置：
 * - `src/qoder-wasm.ts` 的 payload 构造：`tools: []` 硬编码；
 * - `src/qoder-adapter.ts` 的 history 过滤：只留 `typeof content === 'string'`。
 *
 * 本测试**不加载 WASM** —— 直接断言加密前的明文 payload
 * （`prepareInfer` 返回的是密文 body，无法断言内容）。
 */
import { describe, expect, it } from 'vitest'
import { buildInferPayload, type QoderInferAsk, type QoderToolSpec } from '../../src/qoder-wasm.js'

/** 一份最小可用的工具定义（OpenAI wire 形态）。 */
const WEATHER_TOOL: QoderToolSpec = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市的天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
}

/** 不带工具的基础请求，供向后兼容断言复用。 */
function baseAsk(overrides: Partial<QoderInferAsk> = {}): QoderInferAsk {
  return {
    modelKey: 'qfmodel',
    userText: '北京今天天气怎么样？',
    business: { type: 'agent' },
    ...overrides,
  }
}

describe('qwen3.8f 工具调用修复 · 工具定义进请求体', () => {
  it('payload 带上 tools —— 这是「上游看不见工具」的直接修复', () => {
    const payload = buildInferPayload(baseAsk({ tools: [WEATHER_TOOL] }))
    expect(payload.tools).toBeDefined()
    expect(Array.isArray(payload.tools)).toBe(true)
    expect(payload.tools).toHaveLength(1)

    const tool = (payload.tools as QoderToolSpec[])[0]!
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('get_weather')
    expect(tool.function.description).toBe('查询指定城市的天气')
    // ⚠️ 参数 schema 必须原样带上，否则上游不知道参数形状。
    expect(tool.function.parameters).toEqual(WEATHER_TOOL.function.parameters)
  })

  it('多个工具全部保留，顺序不变', () => {
    const second: QoderToolSpec = {
      type: 'function',
      function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
    }
    const payload = buildInferPayload(baseAsk({ tools: [WEATHER_TOOL, second] }))
    const names = (payload.tools as QoderToolSpec[]).map((t) => t.function.name)
    expect(names).toEqual(['get_weather', 'read_file'])
  })

  it('向后兼容：无工具时 tools 仍为 []，与修复前逐字节一致', () => {
    const payload = buildInferPayload(baseAsk())
    expect(payload.tools).toEqual([])
  })

  it('向后兼容：显式传空数组同样产出 []', () => {
    const payload = buildInferPayload(baseAsk({ tools: [] }))
    expect(payload.tools).toEqual([])
  })

  it('不污染 payload 的其他字段（tools 之外逐项不变）', () => {
    const withTools = buildInferPayload(baseAsk({ tools: [WEATHER_TOOL] }))
    const without = buildInferPayload(baseAsk())

    // 随机 id 会变，排除掉；其余字段必须完全一致。
    const strip = (p: Record<string, unknown>): Record<string, unknown> => {
      const { request_id: _a, request_set_id: _b, chat_record_id: _c, session_id: _d, ...rest } = p
      return rest
    }
    expect(strip(withTools)).toEqual({ ...strip(without), tools: [WEATHER_TOOL] })
  })
})

describe('qwen3.8f 工具调用修复 · 历史工具调用回放', () => {
  it('assistant 的 tool_calls 出现在 messages 里', () => {
    const payload = buildInferPayload(baseAsk({
      history: [
        { role: 'user', content: '北京今天天气怎么样？' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"北京"}' },
          }],
        },
      ],
    }))

    const messages = payload.messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const calls = assistant!.tool_calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('call_1')
    expect(calls[0]!.type).toBe('function')
    // ⚠️ arguments 必须是字符串（OpenAI wire 规范），不是对象。
    expect(typeof (calls[0]!.function as Record<string, unknown>).arguments).toBe('string')
    expect((calls[0]!.function as Record<string, unknown>).name).toBe('get_weather')
  })

  it("role:'tool' 的结果消息带 tool_call_id", () => {
    const payload = buildInferPayload(baseAsk({
      history: [
        { role: 'user', content: '北京今天天气怎么样？' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"北京"}' },
          }],
        },
        { role: 'tool', content: '晴，26℃', tool_call_id: 'call_1' },
      ],
    }))

    const messages = payload.messages as Array<Record<string, unknown>>
    const toolMsg = messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe('call_1')
    expect(toolMsg!.content).toBe('晴，26℃')
  })

  it('纯文本历史保持原样（不含工具字段）', () => {
    const payload = buildInferPayload(baseAsk({
      history: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你？' },
      ],
    }))
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: '你好' })
    expect(messages[1]).toEqual({ role: 'assistant', content: '你好，有什么可以帮你？' })
  })

  it('history 为空时回退为单条 user 消息（userText）', () => {
    const payload = buildInferPayload(baseAsk({ userText: '只回答两个字' }))
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages).toEqual([{ role: 'user', content: '只回答两个字' }])
  })
})
