/**
 * 单元测试：Antigravity 自适应通道选择。
 *
 * 覆盖「有权限就能用、没权限就明确说不能用」这条需求的全部判定分支：
 *
 * | 本地通道 | 公共通道 | 期望结果 |
 * |----------|----------|----------|
 * | 可用 | —（不探） | `local`（不问公共，省一次出站） |
 * | 不可用 | 可用 | `public`（自动降级） |
 * | 不可用 | 不可用 | `unavailable` + 可执行的中文诊断 |
 *
 * 全部 mock，不依赖本机是否装了 IDE，也不出网。
 */

import { describe, expect, it } from 'vitest'

import {
  AntigravityLocalAdapter,
  type ChannelProbe,
} from '../../src/antigravity-local-adapter.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'

const INSTANCE = { port: 17013, csrfToken: 'tok-abcdefgh', pid: 37116 }

const MODEL_CONFIGS = {
  clientModelConfigs: [
    { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' }, supportsImages: true, isRecommended: true },
  ],
}

/**
 * 构造一个可控的 fetch：
 * - `localAlive` 决定 Heartbeat 是否成功
 * - `publicStatus` 决定 loadCodeAssist 的响应码
 */
function makeFetch(options: {
  localAlive: boolean
  publicStatus?: number
  publicBody?: unknown
  onPublicCall?: () => void
}) {
  return (async (url: string | URL | Request) => {
    const target = String(url)

    // —— 本地通道（127.0.0.1）——
    if (target.includes('127.0.0.1')) {
      if (target.includes('Heartbeat')) {
        return options.localAlive
          ? new Response(JSON.stringify({ lastExtensionHeartbeat: 'x' }), { status: 200 })
          : new Response(JSON.stringify({ code: 'unauthenticated', message: 'invalid CSRF token' }), { status: 401 })
      }
      if (target.includes('GetCascadeModelConfigData')) {
        return options.localAlive
          ? new Response(JSON.stringify(MODEL_CONFIGS), { status: 200 })
          : new Response('401', { status: 401 })
      }
      if (target.includes('StartCascade')) {
        return new Response(JSON.stringify({ cascadeId: 'c1' }), { status: 200 })
      }
      if (target.includes('SendUserCascadeMessage')) return new Response('{}', { status: 200 })
      if (target.includes('GetCascadeTrajectory')) {
        return new Response(JSON.stringify({
          trajectory: {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'CORTEX_STEP_STATUS_DONE',
                plannerResponse: { response: '来自本地通道' },
              },
            ],
          },
        }), { status: 200 })
      }
      return new Response('404 page not found', { status: 404 })
    }

    // —— 公共通道（cloudcode-pa.googleapis.com）——
    options.onPublicCall?.()
    const status = options.publicStatus ?? 403
    const body = options.publicBody ?? {
      error: { code: status, status: 'SUBSCRIPTION_REQUIRED', message: 'no subscription' },
    }
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

describe('自适应通道选择', () => {
  it('本地通道可用时用 local，且**不探测公共通道**（省一次出站）', async () => {
    let publicCalls = 0
    const adapter = new AntigravityLocalAdapter({
      discover: async () => INSTANCE,
      fetchImpl: makeFetch({ localAlive: true, onPublicCall: () => { publicCalls++ } }),
    })

    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('local')
    expect(probe.local.available).toBe(true)
    expect(probe.local.modelCount).toBe(1)
    // 关键：本地能用时不该去问 Google —— 少一次出站就少一分指纹暴露。
    expect(publicCalls).toBe(0)
  })

  it('本地不可用 + 公共 200 → 自动降级到 public', async () => {
    const fetchImpl = makeFetch({ localAlive: false, publicStatus: 200, publicBody: {} })
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl,
      publicAdapter: new AntigravityAdapter({
        fetchImpl,
        readCredential: () => ({ access_token: 'ya29.mock', refresh_token: '1//mock', token_type: 'Bearer' }),
      }),
    })

    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('public')
    expect(probe.public.available).toBe(true)
    expect(probe.local.available).toBe(false)
  })

  it('本地不可用 + 公共 403 → unavailable，并说明是订阅问题', async () => {
    const fetchImpl = makeFetch({ localAlive: false, publicStatus: 403 })
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl,
      publicAdapter: new AntigravityAdapter({
        fetchImpl,
        readCredential: () => ({ access_token: 'ya29.mock', refresh_token: '1//mock', token_type: 'Bearer' }),
      }),
    })

    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('unavailable')
    expect(probe.message).toBeDefined()
    // 必须同时说明两条路各为什么不通行。
    expect(probe.message).toContain('本地私有通道')
    expect(probe.message).toContain('公共 API 通道')
    // 且必须给出可执行的下一步。
    expect(probe.message).toContain('打开 Antigravity IDE')
  })

  it('本地不可用 + 公共 401（凭据过期）→ unavailable 且提示重新登录', async () => {
    const fetchImpl = makeFetch({
      localAlive: false,
      publicStatus: 401,
      publicBody: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'invalid credentials' } },
    })
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl,
      publicAdapter: new AntigravityAdapter({
        fetchImpl,
        readCredential: () => ({ access_token: 'ya29.mock', refresh_token: '1//mock', token_type: 'Bearer' }),
      }),
    })

    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('unavailable')
    expect(probe.public.reason).toContain('401')
    expect(probe.public.reason).toContain('重新登录')
  })

  it('本地 Heartbeat 通过但拉不到模型清单 → 仍算本地可用（判据是存活，不是清单）', async () => {
    // 设计取舍：模型清单只是 advisory 的展示数据。若把它当判据，
    // 一次瞬时抖动就会让可用渠道被误报为不可用，用户因此被错误降级。
    // 判据锚定在 Heartbeat（证明实例存活 + CSRF 配对正确）上。
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('Heartbeat')) return new Response('{}', { status: 200 })
      if (target.includes('GetCascadeModelConfigData')) {
        return new Response(JSON.stringify({ clientModelConfigs: [] }), { status: 200 })
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({
      discover: async () => INSTANCE,
      fetchImpl,
      allowPublicFallback: false,
    })
    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('local')
    expect(probe.local.available).toBe(true)
    // 拉不到清单时 modelCount 缺省，但通道依然可用。
    expect(probe.local.modelCount).toBeUndefined()
  })

  it('显式关闭降级（allowPublicFallback: false）时不探公共通道', async () => {
    let publicCalls = 0
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl: makeFetch({ localAlive: false, onPublicCall: () => { publicCalls++ } }),
      allowPublicFallback: false,
    })

    const probe = await adapter.probeChannels()
    expect(probe.channel).toBe('unavailable')
    expect(publicCalls).toBe(0)
    expect(probe.public.reason).toContain('显式禁用')
  })

  it('探测结果带 TTL 缓存，重复调用不重复探测', async () => {
    let calls = 0
    const adapter = new AntigravityLocalAdapter({
      discover: async () => { calls++; return INSTANCE },
      fetchImpl: makeFetch({ localAlive: true }),
    })

    await adapter.probeChannels()
    const afterFirst = calls
    await adapter.probeChannels()
    expect(calls).toBe(afterFirst)
  })

  it('force 可以绕过缓存', async () => {
    let calls = 0
    const adapter = new AntigravityLocalAdapter({
      discover: async () => { calls++; return INSTANCE },
      fetchImpl: makeFetch({ localAlive: true }),
    })

    await adapter.probeChannels()
    const afterFirst = calls
    await adapter.probeChannels({ force: true })
    expect(calls).toBeGreaterThan(afterFirst)
  })

  it('invalidateProbe 清空缓存', async () => {
    let calls = 0
    const adapter = new AntigravityLocalAdapter({
      discover: async () => { calls++; return INSTANCE },
      fetchImpl: makeFetch({ localAlive: true }),
    })

    await adapter.probeChannels()
    const afterFirst = calls
    adapter.invalidateProbe()
    await adapter.probeChannels()
    expect(calls).toBeGreaterThan(afterFirst)
  })
})

describe('自适应选路在 stream 中的实际行为', () => {
  it('本地可用 → 回复来自本地通道', async () => {
    const adapter = new AntigravityLocalAdapter({
      discover: async () => INSTANCE,
      fetchImpl: makeFetch({ localAlive: true }),
      pollIntervalMs: 5,
    })

    const chunks = []
    for await (const chunk of adapter.stream({ model: 'MODEL_PLACEHOLDER_M318', messages: [] })) {
      chunks.push(chunk)
    }
    const delta = chunks.find((c) => c.type === 'text-delta') as { text: string } | undefined
    expect(delta?.text).toBe('来自本地通道')
  })

  it('本地不可用 + 公共可用 → 自动走公共通道，不抛错', async () => {
    // 方案 A 会真实发起 generateContent；这里只验证它**被调用到**，
    // 用 401 让它快速失败以便断言"确实换路了"。
    let sawPublicGenerate = false
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('127.0.0.1')) {
        return new Response('401', { status: 401 })
      }
      if (target.includes('loadCodeAssist')) {
        return new Response('{}', { status: 200 })
      }
      if (target.includes('generateContent')) {
        sawPublicGenerate = true
        return new Response(JSON.stringify({ error: { status: 'SUBSCRIPTION_REQUIRED' } }), { status: 403 })
      }
      return new Response('404', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl,
      pollIntervalMs: 5,
      publicAdapter: new AntigravityAdapter({
        fetchImpl,
        readCredential: () => ({ access_token: 'ya29.mock', refresh_token: '1//mock', token_type: 'Bearer' }),
      }),
    })

    const iterate = async () => {
      for await (const _chunk of adapter.stream({ model: 'gemini-3.1-pro', messages: [] })) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow()
    // 关键断言：请求确实被路由到了公共通道。
    expect(sawPublicGenerate).toBe(true)
  })

  it('两条通道都不可用时，抛出的错误说明两条路的原因', async () => {
    const adapter = new AntigravityLocalAdapter({
      discover: async () => undefined,
      fetchImpl: makeFetch({ localAlive: false, publicStatus: 403 }),
    })

    const iterate = async () => {
      for await (const _chunk of adapter.stream({ model: 'm', messages: [] })) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/没有可用的通道/)
    await expect(iterate()).rejects.toThrow(/打开 Antigravity IDE/)
  })
})

describe('currentChannel 与 probeChannels 的一致性', () => {
  it('currentChannel 返回 probeChannels 的 channel', async () => {
    const adapter = new AntigravityLocalAdapter({
      discover: async () => INSTANCE,
      fetchImpl: makeFetch({ localAlive: true }),
    })
    const probe: ChannelProbe = await adapter.probeChannels()
    expect(await adapter.currentChannel()).toBe(probe.channel)
  })
})
