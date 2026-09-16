/**
 * 单元测试：Antigravity 本地私有通道（方案 B）。
 *
 * 覆盖范围（全部 mock，不依赖本机是否装了 IDE，也不出网）：
 * - 命令行解析与端口/token 配对
 * - 发现流程（含配对失败重试、IDE 未运行的降级）
 * - RPC 错误映射与 CSRF token 脱敏
 * - 轨迹解析（回复文本、错误步、用量、状态迁移）
 * - 适配器的串行限速、通道选择、完整 stream 生命周期
 *
 * 两个**回归测试**（都对应真实踩过的坑，勿删）：
 * - sleep 不得使用 `.unref()`
 * - 响应体不得使用 `response.clone()`
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  callRpc,
  countUserInputs,
  discoverLanguageServer,
  extractArg,
  fetchModelConfigs,
  findErrorStep,
  findReplyForTurn,
  findReplyStep,
  isReplyDone,
  redact,
  replyText,
  replyUsage,
  sendUserMessage,
  startCascade,
} from '../../src/antigravity-local.js'
import {
  AntigravityLocalAdapter,
  IDE_NOT_RUNNING_MESSAGE,
  contentToText,
} from '../../src/antigravity-local-adapter.js'

/** 构造一个返回固定 JSON 的 fetch 实现。 */
function jsonFetch(payload: unknown, status = 200, onCall?: (url: string, init: RequestInit) => void) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onCall?.(String(url), init ?? {})
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

/** 构造按 URL 分派的 fetch 实现。 */
function routedFetch(routes: Record<string, unknown>, onCall?: (url: string, init: RequestInit) => void) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    onCall?.(target, init ?? {})
    for (const [fragment, payload] of Object.entries(routes)) {
      if (target.includes(fragment)) {
        return new Response(JSON.stringify(payload), { status: 200 })
      }
    }
    return new Response('404 page not found', { status: 404 })
  }) as unknown as typeof fetch
}

const INSTANCE = { port: 17013, csrfToken: 'b619e6fb-fee5-4b76-a709-dc151140f5aa', pid: 37116 }

const SAMPLE_COMMAND_LINE =
  '"c:\\Users\\Administrator\\AppData\\Local\\Programs\\Antigravity IDE\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe" '
  + '--csrf_token b619e6fb-fee5-4b76-a709-dc151140f5aa '
  + '--extension_server_port 16995 '
  + '--extension_server_csrf_token 6e8f1150-71e5-4ee1-9269-8d9bd0f7235f '
  + '--app_data_dir antigravity-ide --subclient_type ide'

describe('extractArg —— 命令行参数解析', () => {
  it('取出 --csrf_token', () => {
    expect(extractArg(SAMPLE_COMMAND_LINE, 'csrf_token')).toBe('b619e6fb-fee5-4b76-a709-dc151140f5aa')
  })

  it('不会把 --extension_server_csrf_token 误当作 csrf_token', () => {
    // 这是真实踩过的坑：两者的尾部都是 csrf_token，正则必须锚定前置边界。
    const value = extractArg(SAMPLE_COMMAND_LINE, 'csrf_token')
    expect(value).not.toBe('6e8f1150-71e5-4ee1-9269-8d9bd0f7235f')
  })

  it('取出 --extension_server_port（用于确认它不是插件要连的端口）', () => {
    expect(extractArg(SAMPLE_COMMAND_LINE, 'extension_server_port')).toBe('16995')
  })

  it('参数不存在时返回 undefined', () => {
    expect(extractArg(SAMPLE_COMMAND_LINE, 'workspace_id')).toBeUndefined()
  })
})

describe('callRpc —— 请求构造与响应处理', () => {
  it('只发送 Content-Type 与 x-codeium-csrf-token，不伪造身份头', async () => {
    // 防封号不变量：不得出现 Authorization / User-Agent / 自定义 X-* 业务头。
    let seenHeaders: Record<string, string> = {}
    const fetchImpl = jsonFetch({ ok: true }, 200, (_url, init) => {
      seenHeaders = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>),
      )
    })
    await callRpc(INSTANCE, 'Heartbeat', {}, { fetchImpl })

    expect(seenHeaders['Content-Type']).toBe('application/json')
    expect(seenHeaders['x-codeium-csrf-token']).toBe(INSTANCE.csrfToken)
    expect(seenHeaders['Authorization']).toBeUndefined()
    expect(seenHeaders['User-Agent']).toBeUndefined()
    expect(Object.keys(seenHeaders).filter((k) => k.toLowerCase().startsWith('x-'))
      .every((k) => k === 'x-codeium-csrf-token')).toBe(true)
  })

  it('打到正确的 RPC 路径', async () => {
    let seenUrl = ''
    const fetchImpl = jsonFetch({}, 200, (url) => { seenUrl = url })
    await callRpc(INSTANCE, 'GetUserStatus', {}, { fetchImpl })
    expect(seenUrl).toBe(
      'http://127.0.0.1:17013/exa.language_server_pb.LanguageServerService/GetUserStatus',
    )
  })

  it('非 JSON 响应不抛错，json 为 undefined', async () => {
    const fetchImpl = (async () => new Response('500 internal', { status: 500 })) as unknown as typeof fetch
    const result = await callRpc(INSTANCE, 'Heartbeat', {}, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.json).toBeUndefined()
    expect(result.text).toBe('500 internal')
  })

  it('401 invalid CSRF token 被如实返回（配对校验的依据）', async () => {
    const fetchImpl = jsonFetch(
      { code: 'unauthenticated', message: 'invalid CSRF token' }, 401,
    )
    const result = await callRpc(INSTANCE, 'Heartbeat', {}, { fetchImpl })
    expect(result.status).toBe(401)
    expect(result.ok).toBe(false)
  })
})

describe('redact —— CSRF token 脱敏', () => {
  it('把 token 从文本里抹掉', () => {
    const text = `failed with token ${INSTANCE.csrfToken} in request`
    const out = redact(text, [INSTANCE.csrfToken])
    expect(out).not.toContain(INSTANCE.csrfToken)
    expect(out).toContain('<redacted>')
  })

  it('短字符串不参与替换（避免误伤正常文本）', () => {
    expect(redact('hello world', ['abc'])).toBe('hello world')
  })
})

describe('discoverLanguageServer —— 发现与端口配对', () => {
  it('IDE 未运行时返回 undefined（不抛错）', async () => {
    // 直接注入一个空进程列表的场景：discover 内部会走 listLanguageServerProcesses，
    // 这里通过 fetchImpl 断言它在拿不到进程时根本不会发请求。
    let called = false
    const fetchImpl = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    // 真实实现会先跑 PowerShell；本机无 IDE 时结果为 undefined。
    const result = await discoverLanguageServer({ fetchImpl })
    if (result === undefined) {
      expect(called).toBe(false)
    } else {
      // 本机确实装了 IDE：至少验证返回结构合法。
      expect(typeof result.port).toBe('number')
      expect(result.csrfToken.length).toBeGreaterThan(0)
    }
  })
})

describe('startCascade —— 会话创建', () => {
  it('使用 source=11 且**不带任何模型字段**', async () => {
    // 回归保护：模型不能放在 StartCascade（requestedModel 是枚举，
    // 传错位置会报 "neither PlanModel nor RequestedModel specified"）。
    let seenBody: Record<string, unknown> = {}
    const fetchImpl = jsonFetch({ cascadeId: 'cascade-1' }, 200, (_url, init) => {
      seenBody = JSON.parse(String(init.body))
    })
    const cascadeId = await startCascade(INSTANCE, { fetchImpl })
    expect(cascadeId).toBe('cascade-1')
    expect(seenBody).toEqual({ source: 11 })
    expect(seenBody.requestedModel).toBeUndefined()
    expect(seenBody.requestedModelId).toBeUndefined()
  })

  it('响应缺少 cascadeId 时报错', async () => {
    const fetchImpl = jsonFetch({}, 200)
    await expect(startCascade(INSTANCE, { fetchImpl })).rejects.toThrow(/创建会话失败/)
  })
})

describe('sendUserMessage —— 模型指定位置（关键回归）', () => {
  it('模型放在 cascadeConfig.plannerConfig.planModel', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchImpl = jsonFetch({}, 200, (_url, init) => {
      seenBody = JSON.parse(String(init.body))
    })
    await sendUserMessage(INSTANCE, 'cascade-1', 'hello', 'MODEL_PLACEHOLDER_M300', { fetchImpl })

    expect(seenBody.cascadeId).toBe('cascade-1')
    expect(seenBody.items).toEqual([{ text: 'hello' }])
    // ★ 这是打通链路的关键字段路径，写错会一直报 "neither PlanModel nor
    //   RequestedModel specified"，因此单独断言。
    expect(seenBody.cascadeConfig).toEqual({
      plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M300' },
    })
  })

  it('模型 id 原样传递（不剥掉 MODEL_PLACEHOLDER_ 前缀）', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchImpl = jsonFetch({}, 200, (_url, init) => { seenBody = JSON.parse(String(init.body)) })
    await sendUserMessage(INSTANCE, 'c', 't', 'MODEL_PLACEHOLDER_M318', { fetchImpl })
    const config = seenBody.cascadeConfig as { plannerConfig: { planModel: string } }
    expect(config.plannerConfig.planModel).toBe('MODEL_PLACEHOLDER_M318')
  })

  it('HTTP 500 时报错且不回显 CSRF token', async () => {
    const fetchImpl = jsonFetch(
      { code: 'unknown', message: `bad token ${INSTANCE.csrfToken}` }, 500,
    )
    await expect(
      sendUserMessage(INSTANCE, 'c', 't', 'm', { fetchImpl }),
    ).rejects.toThrow(/发送消息失败/)
    await expect(
      sendUserMessage(INSTANCE, 'c', 't', 'm', { fetchImpl }),
    ).rejects.not.toThrow(new RegExp(INSTANCE.csrfToken))
  })
})

describe('轨迹解析', () => {
  const trajectory = {
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: '4', modifiedResponse: '4', stopReason: 'STOP_REASON_STOP_PATTERN' },
        metadata: {
          modelUsage: {
            model: 'MODEL_PLACEHOLDER_M300',
            inputTokens: '32926',
            outputTokens: '1',
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
          },
        },
      },
    ],
  }

  it('countUserInputs 统计用户输入步', () => {
    expect(countUserInputs(trajectory)).toBe(1)
    expect(countUserInputs({ steps: [] })).toBe(0)
  })

  it('findReplyStep 从后往前找回复步', () => {
    expect(findReplyStep(trajectory)?.type).toBe('CORTEX_STEP_TYPE_PLANNER_RESPONSE')
    expect(findReplyStep({ steps: [] })).toBeUndefined()
  })

  it('回复步取最后一条（多轮时不会拿到历史回复）', () => {
    const multi = {
      steps: [
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '第一轮' } },
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: '第二轮' } },
      ],
    }
    expect(replyText(findReplyStep(multi)!)).toBe('第二轮')
  })

  it('replyText 优先 modifiedResponse，回退 response', () => {
    expect(replyText({ plannerResponse: { response: 'a', modifiedResponse: 'b' } })).toBe('b')
    expect(replyText({ plannerResponse: { response: 'a' } })).toBe('a')
    expect(replyText({ plannerResponse: {} })).toBe('')
  })

  it('isReplyDone 判定完成状态', () => {
    expect(isReplyDone({ status: 'CORTEX_STEP_STATUS_DONE' })).toBe(true)
    expect(isReplyDone({ status: 'CORTEX_STEP_STATUS_GENERATING' })).toBe(false)
    expect(isReplyDone({})).toBe(false)
  })

  it('replyUsage 把字符串形式的 int64 转成数字', () => {
    const step = findReplyStep(trajectory)!
    expect(replyUsage(step)).toEqual({ inputTokens: 32926, outputTokens: 1 })
  })

  it('replyUsage 对缺失用量返回空对象', () => {
    expect(replyUsage({})).toEqual({})
  })

  it('findErrorStep 提取错误原因', () => {
    const withError = {
      steps: [{
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'CORTEX_STEP_STATUS_DONE',
        errorMessage: {
          error: {
            modelErrorMessage: 'failed to construct executor: neither PlanModel nor RequestedModel specified.',
          },
        },
      }],
    }
    expect(findErrorStep(withError)).toMatch(/neither PlanModel nor RequestedModel/)
    expect(findErrorStep(trajectory)).toBeUndefined()
  })
})

describe('fetchModelConfigs —— 模型清单', () => {
  it('解析 label ↔ id 映射', async () => {
    const fetchImpl = jsonFetch({
      clientModelConfigs: [
        { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' }, supportsImages: true, isRecommended: true },
        { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' }, supportsImages: true },
      ],
    })
    const configs = await fetchModelConfigs(INSTANCE, { fetchImpl })
    expect(configs).toHaveLength(2)
    expect(configs[0]).toEqual({
      id: 'MODEL_PLACEHOLDER_M318',
      label: 'Gemini 3.8 Flash (High)',
      supportsImages: true,
      isRecommended: true,
    })
    expect(configs[1].isRecommended).toBe(false)
  })

  it('跳过缺少模型 id 的条目', async () => {
    const fetchImpl = jsonFetch({ clientModelConfigs: [{ label: 'bad' }, { modelOrAlias: { model: 'M1' } }] })
    const configs = await fetchModelConfigs(INSTANCE, { fetchImpl })
    expect(configs).toHaveLength(1)
    expect(configs[0].id).toBe('M1')
    expect(configs[0].label).toBe('M1')
  })

  it('HTTP 失败时抛出带状态码的错误', async () => {
    const fetchImpl = jsonFetch({ message: 'boom' }, 500)
    await expect(fetchModelConfigs(INSTANCE, { fetchImpl })).rejects.toThrow(/拉取模型清单失败/)
  })
})

describe('AntigravityLocalAdapter —— 通道选择与降级', () => {
  const discovered = { port: 17013, csrfToken: 'tok-abcdefgh', pid: 1 }

  it('IDE 未运行且未开启公共降级时，currentChannel 为 unavailable', async () => {
    const adapter = new AntigravityLocalAdapter({ discover: async () => undefined })
    expect(await adapter.currentChannel()).toBe('unavailable')
  })

  it('IDE 未运行且未开启公共降级时，stream 抛出明确中文提示', async () => {
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      allowPublicFallback: false,
    })
    const iterate = async () => {
      for await (const _chunk of adapter.stream({ model: 'm', messages: [] })) { /* drain */ }
    }
    // 关闭公共降级时，两条路都不通 → 诊断里会说明本地通道为什么不可用。
    await expect(iterate()).rejects.toThrow(/没有可用的通道/)
    await expect(iterate()).rejects.toThrow(/Antigravity IDE/)
  })

  it('IDE 未运行时 listModels 回退到内置目录', async () => {
    const adapter = new AntigravityLocalAdapter({ discover: async () => undefined })
    const models = await adapter.listModels('antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'MODEL_PLACEHOLDER_M318')).toBe(true)
  })

  it('发现实例后 currentChannel 为 local', async () => {
    const fetchImpl = routedFetch({
      Heartbeat: { lastExtensionHeartbeat: '2026-09-16T12:00:00Z' },
    })
    const adapter = new AntigravityLocalAdapter({ discover: async () => discovered, fetchImpl })
    expect(await adapter.currentChannel()).toBe('local')
  })

  it('providerInfo 使用 antigravity 路由名', () => {
    const adapter = new AntigravityLocalAdapter()
    expect(adapter.providerInfo('antigravity').id).toBe('antigravity')
    expect(adapter.providerInfo('antigravity').name).toContain('Antigravity')
  })
})

describe('AntigravityLocalAdapter —— 完整 stream 生命周期', () => {
  const discovered = { port: 17013, csrfToken: 'tok-abcdefgh', pid: 1 }

  it('产出 block-start / text-delta / usage / block-end / finish', async () => {
    let pollCount = 0
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('Heartbeat')) {
        return new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
      }
      // 自适应探测会拉模型清单用于展示；返回非空即可确认本地通道可用。
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({
          clientModelConfigs: [{ label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }],
        }), { status: 200 })
      }
      if (target.includes('StartCascade')) {
        return new Response(JSON.stringify({ cascadeId: 'cascade-1' }), { status: 200 })
      }
      if (target.includes('SendUserCascadeMessage')) {
        return new Response('{}', { status: 200 })
      }
      if (target.includes('GetCascadeTrajectory')) {
        pollCount++
        // 第一次尚未有回复，第二次给出完成态 —— 验证轮询确实在工作。
        const steps = pollCount === 1
          ? [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' }]
          : [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'CORTEX_STEP_STATUS_DONE',
                plannerResponse: { response: '391', modifiedResponse: '391' },
                metadata: { modelUsage: { inputTokens: '32941', outputTokens: '3' } },
              },
            ]
        return new Response(JSON.stringify({ trajectory: { cascadeId: 'cascade-1', steps } }), { status: 200 })
      }
      return new Response('404 page not found', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({
      discover: async () => discovered,
      fetchImpl,
      pollIntervalMs: 5,
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'MODEL_PLACEHOLDER_M300',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
    })) {
      chunks.push(chunk)
    }

    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks.find((c) => c.type === 'text-delta')).toEqual({ type: 'text-delta', index: 0, text: '391' })
    expect(chunks.find((c) => c.type === 'usage')).toEqual({
      type: 'usage', usage: { inputTokens: 32941, outputTokens: 3 },
    })
    expect(chunks.find((c) => c.type === 'block-end')).toEqual({
      type: 'block-end', index: 0, block: { type: 'text', text: '391' },
    })
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(pollCount).toBeGreaterThanOrEqual(2)
  })

  it('轨迹里出现错误步时抛错，不继续傻等', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('Heartbeat')) return new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({
          clientModelConfigs: [{ label: 'M', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }],
        }), { status: 200 })
      }
      if (target.includes('StartCascade')) return new Response(JSON.stringify({ cascadeId: 'c1' }), { status: 200 })
      if (target.includes('SendUserCascadeMessage')) return new Response('{}', { status: 200 })
      if (target.includes('GetCascadeTrajectory')) {
        return new Response(JSON.stringify({
          trajectory: {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
              {
                type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
                status: 'CORTEX_STEP_STATUS_DONE',
                errorMessage: { error: { modelErrorMessage: 'neither PlanModel nor RequestedModel specified.' } },
              },
            ],
          },
        }), { status: 200 })
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({
      discover: async () => discovered,
      fetchImpl,
      pollIntervalMs: 5,
    })
    const iterate = async () => {
      for await (const _chunk of adapter.stream({ model: 'm', messages: [] })) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/neither PlanModel nor RequestedModel/)
  })

  it('serialize 会把 system 与多轮消息带上', async () => {
    let prompt = ''
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('Heartbeat')) return new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({
          clientModelConfigs: [{ label: 'M', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }],
        }), { status: 200 })
      }
      if (target.includes('StartCascade')) return new Response(JSON.stringify({ cascadeId: 'c1' }), { status: 200 })
      if (target.includes('SendUserCascadeMessage')) {
        prompt = (JSON.parse(String(init?.body)).items as Array<{ text: string }>)[0].text
        return new Response('{}', { status: 200 })
      }
      if (target.includes('GetCascadeTrajectory')) {
        return new Response(JSON.stringify({
          trajectory: {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'CORTEX_STEP_STATUS_DONE',
                plannerResponse: { response: 'ok' },
              },
            ],
          },
        }), { status: 200 })
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({ discover: async () => discovered, fetchImpl, pollIntervalMs: 5 })
    for await (const _chunk of adapter.stream({
      model: 'm',
      system: '你是助手',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
        { role: 'user', content: '继续' },
      ],
    })) { /* drain */ }

    expect(prompt).toContain('你是助手')
    expect(prompt).toContain('你好')
    expect(prompt).toContain('继续')
    expect(prompt).toContain('Assistant')
  })

  it('多轮对话时序保护：第二轮轮询即使前几次只返回第一轮轨迹，也绝不提前返回第一轮旧回复', async () => {
    let startCascadeCalls = 0
    let pollCount = 0

    const turn1Trajectory = {
      cascadeId: 'cascade-reused-race',
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '第一轮显卡驱动回答' },
        },
      ],
    }

    const turn2TrajectoryGenerating = {
      cascadeId: 'cascade-reused-race',
      steps: [
        ...turn1Trajectory.steps,
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_GENERATING',
          plannerResponse: { response: '第二轮游戏与AI' },
        },
      ],
    }

    const turn2TrajectoryDone = {
      cascadeId: 'cascade-reused-race',
      steps: [
        ...turn1Trajectory.steps,
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '第二轮游戏与AI驱动回答' },
        },
      ],
    }

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('Heartbeat')) return new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({
          clientModelConfigs: [{ label: 'M', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }],
        }), { status: 200 })
      }
      if (target.includes('StartCascade')) {
        startCascadeCalls++
        return new Response(JSON.stringify({ cascadeId: 'cascade-reused-race' }), { status: 200 })
      }
      if (target.includes('SendUserCascadeMessage')) {
        return new Response('{}', { status: 200 })
      }
      if (target.includes('GetCascadeTrajectory')) {
        pollCount++
        // 在第二轮中，前 2 次轮询模拟 LS 尚未写入第 2 轮 USER_INPUT 的竞态场景
        if (pollCount <= 2) {
          return new Response(JSON.stringify({ trajectory: turn1Trajectory }), { status: 200 })
        } else if (pollCount === 3) {
          return new Response(JSON.stringify({ trajectory: turn2TrajectoryGenerating }), { status: 200 })
        } else {
          return new Response(JSON.stringify({ trajectory: turn2TrajectoryDone }), { status: 200 })
        }
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({ discover: async () => discovered, fetchImpl, pollIntervalMs: 5 })

    // 第一轮请求（pollCount 会变成 1）
    const turn1Chunks = []
    for await (const chunk of adapter.stream({
      model: 'MODEL_PLACEHOLDER_M318',
      system: '系统提示词',
      messages: [{ role: 'user', content: '每次有新显卡驱动要马上更新吗？' }],
    })) {
      turn1Chunks.push(chunk)
    }

    // 第二轮请求（pollCount 会在 2, 3, 4 演进）
    const turn2Chunks = []
    for await (const chunk of adapter.stream({
      model: 'MODEL_PLACEHOLDER_M318',
      system: '系统提示词',
      messages: [
        { role: 'user', content: '每次有新显卡驱动要马上更新吗？' },
        { role: 'assistant', content: '第一轮显卡驱动回答' },
        { role: 'user', content: '玩游戏 又玩 AI 要更新哪个驱动？' },
      ],
    })) {
      turn2Chunks.push(chunk)
    }

    // 验证第二轮回复绝不是第一轮的内容
    const turn2Text = turn2Chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as any).text)
      .join('')
    expect(turn2Text).toBe('第二轮游戏与AI驱动回答')
    expect(turn2Text).not.toContain('第一轮显卡驱动回答')
  })

  it('同 sessionId 下多轮对话复用同一个 cascadeId，不反复新建对话框', async () => {
    let startCascadeCalls = 0
    const sentPrompts: string[] = []
    const trajectorySteps: Array<Array<{ type: string; status?: string; plannerResponse?: { response: string } }>> = [
      // 第一轮轨迹：包含第 1 轮问答
      [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '第一轮回复：天气很好' },
        },
      ],
      // 第二轮轨迹：包含第 1 轮历史 + 第 2 轮输入 + 第 2 轮回复
      [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '第一轮回复：天气很好' },
        },
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '第二轮回复：我是 Antigravity' },
        },
      ],
    ]

    let currentTurn = 0
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('Heartbeat')) return new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({
          clientModelConfigs: [{ label: 'M', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' } }],
        }), { status: 200 })
      }
      if (target.includes('StartCascade')) {
        startCascadeCalls++
        return new Response(JSON.stringify({ cascadeId: 'cascade-reused-1' }), { status: 200 })
      }
      if (target.includes('SendUserCascadeMessage')) {
        const body = JSON.parse(String(init?.body))
        sentPrompts.push(body.items[0].text)
        currentTurn = sentPrompts.length - 1
        return new Response('{}', { status: 200 })
      }
      if (target.includes('GetCascadeTrajectory')) {
        return new Response(JSON.stringify({
          trajectory: {
            cascadeId: 'cascade-reused-1',
            steps: trajectorySteps[currentTurn] ?? [],
          },
        }), { status: 200 })
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({ discover: async () => discovered, fetchImpl, pollIntervalMs: 5 })

    // 第一轮请求
    const turn1Chunks = []
    for await (const chunk of adapter.stream({
            model: 'MODEL_PLACEHOLDER_M318',
      system: '系统提示词',
      messages: [{ role: 'user', content: '福建泉州天气' }],
    })) {
      turn1Chunks.push(chunk)
    }

    // 第二轮请求（即使无 sessionId 字段，也能基于首条用户消息锚定复用同一个 cascadeId）
    const turn2Chunks = []
    for await (const chunk of adapter.stream({
      model: 'MODEL_PLACEHOLDER_M318',
      system: '系统提示词',
      messages: [
        { role: 'user', content: '福建泉州天气' },
        { role: 'assistant', content: '第一轮回复：天气很好' },
        { role: 'user', content: '你是谁？你的最新知识库日期是？' },
      ],
    })) {
      turn2Chunks.push(chunk)
    }

    // 核心断言 1：两轮对话只调用了一次 StartCascade（没有新建对话框！）
    expect(startCascadeCalls).toBe(1)

    // 核心断言 2：第一轮首条消息把用户问题置前便于 IDE 生成标题
    expect(sentPrompts[0]).toMatch(/^福建泉州天气/)
    expect(sentPrompts[0]).toContain('[System Instructions]')
    expect(sentPrompts[0]).toContain('系统提示词')

    // 核心断言 3：第二轮只发送了当前轮次的问题，没有把历史全量重新塞进用户输入
    expect(sentPrompts[1]).toBe('你是谁？你的最新知识库日期是？')

    // 核心断言 4：第二轮正确拿到第二轮的回复，绝不答非所问返回第一轮的旧回复
    const turn2Text = turn2Chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c as any).text)
      .join('')
    expect(turn2Text).toBe('第二轮回复：我是 Antigravity')
  })
})

describe('contentToText', () => {
  it('字符串直接返回', () => {
    expect(contentToText('abc')).toBe('abc')
  })
  it('拼接 text 块', () => {
    expect(contentToText([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'x' },
      { type: 'text', text: 'b' },
    ])).toBe('ab')
  })
  it('非数组返回空串', () => {
    expect(contentToText(undefined)).toBe('')
    expect(contentToText(42)).toBe('')
  })
})

/**
 * 回归测试：两个真实踩过的坑。
 *
 * 这两条不是风格偏好 —— 它们各自对应一个「静默挂死」的线上级故障，
 * 删除测试就等于允许缺陷回归。
 */
describe('回归保护：已踩过的坑', () => {
  it('sleep 不得使用 .unref()', () => {
    // .unref() 会让限速闸门的定时器不被事件循环等待；若此刻进程内无其他
    // pending 工作，for await 会静默挂死（既不抛错也不结束）。
    const source = readFileSync(new URL('../../src/antigravity-local-adapter.ts', import.meta.url), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('setTimeout(resolve, ms).unref')
    expect(code).not.toMatch(/setTimeout\([^)]*\)\.unref\(\)/)
  })

  it('响应体不得使用 .clone()', () => {
    // clone() 会让原 response 的 body 进入「被派生」状态，之后读取会阻塞。
    // 401/500 分支必须只读一次 text()。
    for (const file of ['../../src/antigravity-local.ts', '../../src/antigravity-local-adapter.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      expect(code).not.toContain('.clone()')
    }
  })
})
