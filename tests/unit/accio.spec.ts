/**
 * Accio（阿里 Accio Work）产品配置、协议常量与纯函数的单元测试。
 *
 * 全部**无网络**：只验证常量、纯函数与解析逻辑。几处最值钱的坑
 * （`sg_k` 是 md5 而非签名、鉴权 token 在 body、四个 JSON 字符串字段、
 * 思考档位落点、模型代号）都有对应用例。
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ACCIO, ACCIO_CN, ALL_ACCIO_PRODUCTS, accioProductById } from '../../src/accio-product.js'
import { parseAccioModelCatalog } from '../../src/accio-auth.js'
import {
  ACCIO_CALLBACK_PATH,
  accioAccountId,
  accioCredentialExpiresAtMs,
  accioDisplayName,
  accioUrlencode,
  buildAccioAuthorizeUrl,
  buildAccioChatBody,
  buildAccioGenerateContentUrl,
  isAccioRefreshable,
  newAccioDeviceId,
  newAccioState,
  openAiToAccioContents,
  openAiToAccioTools,
  parseAccioCredential,
} from '../../src/accio.js'

describe('Accio 产品配置', () => {
  it('两个地区各占一个 provider，id 固定', () => {
    expect(ACCIO.id).toBe('accio')
    expect(ACCIO_CN.id).toBe('accio-cn')
    expect(ALL_ACCIO_PRODUCTS.map((p) => p.id)).toEqual(['accio', 'accio-cn'])
  })

  it('登录站点两地不同', () => {
    expect(ACCIO.loginBase).toBe('https://www.accio.com')
    expect(ACCIO_CN.loginBase).toBe('https://www.accio-ai.com')
  })

  it('业务网关与推理网关两地**相同**（同一个 host）', () => {
    expect(ACCIO.gatewayBase).toBe('https://phoenix-gw.alibaba.com')
    expect(ACCIO_CN.gatewayBase).toBe('https://phoenix-gw.alibaba.com')
  })

  it('package-region 两地不同（GLOBAL / CN）', () => {
    expect(ACCIO.packageRegion).toBe('GLOBAL')
    expect(ACCIO_CN.packageRegion).toBe('CN')
  })

  it('client_id 两地逐字相同', () => {
    expect(ACCIO.clientId).toBe('accio-work')
    expect(ACCIO_CN.clientId).toBe('accio-work')
  })

  it('账号 id 前缀两地不相交', () => {
    expect(ACCIO.accountIdPrefix).toBe('accio-intl-')
    expect(ACCIO_CN.accountIdPrefix).toBe('accio-cn-')
  })

  it('凭据 ref 两地不同', () => {
    expect(ACCIO.defaultCredentialRef).toBe('ACCIO_ACCESS_TOKEN')
    expect(ACCIO_CN.defaultCredentialRef).toBe('ACCIO_CN_ACCESS_TOKEN')
  })

  it('accioProductById 认得两家，未知 id 返回 undefined', () => {
    expect(accioProductById('accio')?.id).toBe('accio')
    expect(accioProductById('accio-cn')?.id).toBe('accio-cn')
    expect(accioProductById('autoclaw')).toBeUndefined()
  })

  it('回调路径是 /auth/callback-accio', () => {
    expect(ACCIO_CALLBACK_PATH).toBe('/auth/callback-accio')
  })

  it('兜底模型表带 reasoningPlacement（Gemini 系 400 与 GPT 无思考的分水岭）', () => {
    const byId = new Map(ACCIO.fallbackModels.map((m) => [m.id, m]))
    // Gemini 系必须落 top（放 properties 是硬 400）
    expect(byId.get('gemini-3-flash-preview')?.reasoningPlacement).toBe('top')
    // GPT 系必须落 properties（放顶层永远不出思考）
    expect(byId.get('gpt-5.4')?.reasoningPlacement).toBe('properties')
    expect(byId.get('gpt-5.2-1211')?.reasoningPlacement).toBe('properties')
  })

  it('兜底表覆盖 10 个模型，含 gemini / claude / gpt / qwen / glm', () => {
    expect(ACCIO.fallbackModels.length).toBe(10)
    const ids = ACCIO.fallbackModels.map((m) => m.id)
    expect(ids).toContain('gemini-3-flash-preview')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('gpt-5.4')
    expect(ids).toContain('qwen3.6-plus')
    expect(ids).toContain('glm-5')
  })

  it('所有 contextWindow 都是安全正整数', () => {
    for (const model of ACCIO.fallbackModels) {
      expect(Number.isSafeInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })
})

describe('accioUrlencode', () => {
  it('只放行 unreserved，其余百分号编码', () => {
    expect(accioUrlencode('abc-_.~123')).toBe('abc-_.~123')
    expect(accioUrlencode('a b')).toBe('a%20b')
    expect(accioUrlencode('a&b=c')).toBe('a%26b%3Dc')
  })

  it('按 UTF-8 字节编码（不是 UTF-16 的 %uXXXX）', () => {
    expect(accioUrlencode('中')).toBe('%E4%B8%AD')
  })
})

describe('buildAccioAuthorizeUrl', () => {
  const pkce = { codeVerifier: 'v', codeChallenge: 'CHAL+with/special=chars' }
  const url = buildAccioAuthorizeUrl(ACCIO, pkce, 'STATE123', 'http://127.0.0.1:9999/auth/callback-accio')

  it('五个参数齐全且逐字', () => {
    expect(url.startsWith('https://www.accio.com/login?')).toBe(true)
    expect(url).toContain('return_url=http%3A%2F%2F127.0.0.1%3A9999%2Fauth%2Fcallback-accio')
    expect(url).toContain('state=STATE123')
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('client_id=accio-work')
  })

  it('code_challenge 里的 +/= 被编码（少编一个会让换码 invalid_grant）', () => {
    expect(url).toContain('code_challenge=CHAL%2Bwith%2Fspecial%3Dchars')
  })

  it('国内版用国内登录站点', () => {
    expect(buildAccioAuthorizeUrl(ACCIO_CN, pkce, 's', 'http://x/y')).toContain('https://www.accio-ai.com/login')
  })
})

describe('newAccioState / newAccioDeviceId', () => {
  it('state 是 32 位 hex（UUID 去掉连字符）', () => {
    const state = newAccioState()
    expect(state).toMatch(/^[0-9a-f]{32}$/)
    expect(state).not.toBe(newAccioState())
  })

  it('deviceId 带 desktop- 前缀且唯一', () => {
    const id = newAccioDeviceId()
    expect(id.startsWith('desktop-')).toBe(true)
    expect(id).not.toBe(newAccioDeviceId())
  })
})

describe('buildAccioGenerateContentUrl', () => {
  it('sg_k 是小写 hex MD5(requestId)，不是签名', () => {
    const url = buildAccioGenerateContentUrl(ACCIO, 'req-1')
    const expected = createHash('md5').update('req-1', 'utf8').digest('hex')
    expect(url).toBe(`https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?sg_k=${expected}`)
  })

  it('requestId 变化 → sg_k 变化', () => {
    const a = buildAccioGenerateContentUrl(ACCIO, 'a')
    const b = buildAccioGenerateContentUrl(ACCIO, 'b')
    expect(a).not.toBe(b)
  })
})

describe('openAiToAccioContents（OpenAI → ADK Gemini 信封）', () => {
  it('system 抽成 system_instruction 字符串（**不是** {parts}）', () => {
    const out = openAiToAccioContents([
      { role: 'system', content: '规则一' },
      { role: 'system', content: '规则二' },
      { role: 'user', content: 'hi' },
    ])
    expect(typeof out.systemInstruction).toBe('string')
    expect(out.systemInstruction).toBe('规则一\n\n规则二')
    // system 不产生 contents 项
    expect(out.contents.length).toBe(1)
  })

  it('user → role:user，assistant → role:model', () => {
    const out = openAiToAccioContents([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    expect(out.contents[0]?.role).toBe('user')
    expect(out.contents[1]?.role).toBe('model')
  })

  it('相邻同 role 合并 parts', () => {
    const out = openAiToAccioContents([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ])
    expect(out.contents.length).toBe(1)
    expect((out.contents[0]?.parts as unknown[]).length).toBe(2)
  })

  it('assistant 的 tool_calls → function_call，args_json 是**字符串**', () => {
    const out = openAiToAccioContents([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
      },
    ])
    const parts = out.contents[0]?.parts as Array<Record<string, unknown>>
    const call = parts.find((p) => 'function_call' in p)
    expect(call).toBeDefined()
    const fn = call?.function_call as Record<string, unknown>
    expect(fn.id).toBe('c1')
    expect(fn.name).toBe('f')
    // ⚠️ 必须是 JSON 字符串，不是对象
    expect(typeof fn.args_json).toBe('string')
  })

  it('tool 结果 → function_response，response_json 是**字符串**', () => {
    const out = openAiToAccioContents([
      { role: 'tool', tool_call_id: 'c1', content: '结果文本' },
    ])
    const parts = out.contents[0]?.parts as Array<Record<string, unknown>>
    const resp = parts.find((p) => 'function_response' in p)
    expect(resp).toBeDefined()
    const fr = resp?.function_response as Record<string, unknown>
    expect(fr.id).toBe('c1')
    expect(typeof fr.response_json).toBe('string')
  })

  it('data URL 图片 → inline_data（mime_type + data）', () => {
    const out = openAiToAccioContents([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ])
    const parts = out.contents[0]?.parts as Array<Record<string, unknown>>
    const inline = parts.find((p) => 'inline_data' in p)
    expect(inline).toBeDefined()
    const data = inline?.inline_data as Record<string, unknown>
    expect(data.mime_type).toBe('image/png')
    expect(data.data).toBe('AAAA')
  })

  it('http(s) 图片 → file_data（file_uri）', () => {
    const out = openAiToAccioContents([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
    ])
    const parts = out.contents[0]?.parts as Array<Record<string, unknown>>
    const file = parts.find((p) => 'file_data' in p)
    expect(file).toBeDefined()
    expect((file?.file_data as Record<string, unknown>).file_uri).toBe('https://x/y.png')
  })
})

describe('openAiToAccioTools', () => {
  it('parameters_json 是 JSON 字符串', () => {
    const tools = openAiToAccioTools([
      { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } },
    ])
    expect(tools.length).toBe(1)
    expect(typeof tools[0]?.parameters_json).toBe('string')
    expect(tools[0]?.name).toBe('f')
  })

  it('无 parameters 时给合法缺省（不是 undefined）', () => {
    const tools = openAiToAccioTools([{ name: 'f', description: '' }])
    expect(JSON.parse(String(tools[0]?.parameters_json))).toEqual({ type: 'object', properties: {} })
  })
})

describe('buildAccioChatBody', () => {
  const contents = [{ role: 'user', parts: [{ text: 'hi' }] }]
  const systemInstruction = 'sys'

  it('鉴权 token 在 body 里（不是 Authorization 头）', () => {
    const out = buildAccioChatBody(
      ACCIO,
      { access_token: 'tok-123', device_id: 'dev-1' },
      { model: 'glm-5' },
      contents,
      systemInstruction,
      [],
    )
    expect(out.body.token).toBe('tok-123')
  })

  it('message_id 必填且形如 msg-<requestId>（缺了上游回 200 帧 invalid params）', () => {
    const out = buildAccioChatBody(ACCIO, { access_token: 't' }, { model: 'glm-5' }, contents, systemInstruction, [])
    expect(typeof out.body.message_id).toBe('string')
    expect(String(out.body.message_id)).toBe(`msg-${out.requestId}`)
  })

  it('固定身份字段逐字', () => {
    const out = buildAccioChatBody(ACCIO, { access_token: 't' }, { model: 'glm-5' }, contents, systemInstruction, [])
    expect(out.body.tenant).toBe('accio-agent')
    expect(out.body.iai_tag).toBe('phoenix-desktop')
    expect(out.body.empid).toBe('')
  })

  it('properties 恒含 normalized_response', () => {
    const out = buildAccioChatBody(ACCIO, { access_token: 't' }, { model: 'glm-5' }, contents, systemInstruction, [])
    expect((out.body.properties as Record<string, unknown>).normalized_response).toBe('true')
  })

  it('system_instruction 是字符串', () => {
    const out = buildAccioChatBody(ACCIO, { access_token: 't' }, { model: 'glm-5' }, contents, systemInstruction, [])
    expect(typeof out.body.system_instruction).toBe('string')
    expect(out.body.system_instruction).toBe('sys')
  })

  it('有 tools 时 tool_config 是 JSON 字符串', () => {
    const out = buildAccioChatBody(
      ACCIO,
      { access_token: 't' },
      { model: 'glm-5' },
      contents,
      systemInstruction,
      [{ name: 'f', description: '', parameters_json: '{}' }],
    )
    expect(typeof out.body.tool_config).toBe('string')
    expect(JSON.parse(String(out.body.tool_config))).toHaveProperty('functionCallingConfig')
  })

  it('思考档位落 top 时放顶层，落 properties 时放 properties', () => {
    const top = buildAccioChatBody(
      ACCIO,
      { access_token: 't' },
      { model: 'gemini-3-flash-preview', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'], reasoningPlacement: 'top' },
      contents,
      systemInstruction,
      [],
    )
    expect(top.body.reasoning_effort).toBe('high')
    expect((top.body.properties as Record<string, unknown>).reasoning_effort).toBeUndefined()

    const props = buildAccioChatBody(
      ACCIO,
      { access_token: 't' },
      { model: 'gpt-5.4', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'], reasoningPlacement: 'properties' },
      contents,
      systemInstruction,
      [],
    )
    expect(props.body.reasoning_effort).toBeUndefined()
    expect((props.body.properties as Record<string, unknown>).reasoning_effort).toBe('high')
  })

  it('模型不声明档位时一个思考字段都不发', () => {
    const out = buildAccioChatBody(
      ACCIO,
      { access_token: 't' },
      { model: 'qwen3.6-plus', reasoningEffort: 'high', reasoningEfforts: [] },
      contents,
      systemInstruction,
      [],
    )
    expect(out.body.reasoning_effort).toBeUndefined()
    expect((out.body.properties as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })

  it('max_tokens → max_output_tokens', () => {
    const out = buildAccioChatBody(
      ACCIO, { access_token: 't' }, { model: 'glm-5', maxTokens: 4096 }, contents, systemInstruction, [],
    )
    expect(out.body.max_output_tokens).toBe(4096)
  })
})

describe('parseAccioModelCatalog（对外 id 必须可读、且同名不撞）', () => {
  /**
   * 真实目录样本（2026-10-04 实测国内版 `POST /api/llm/config` 的节选）。
   *
   * 刻意包含四种边界：
   *   · 上游 `modelCode` 是**混淆代号**（`1Helix-…` / `1Orbit-…`）；
   *   · 展示名与兜底表同名（`Claude Sonnet 4.6`）→ 应沿用兜底表那个可读 id；
   *   · 展示名是**纯中文**（`极致`）→ slug 为空，只能退回代号；
   *   · **展示名重复**（`Qwen 3.8 Max` ×2）→ 必须消歧成两个不同的 id。
   */
  const catalog = {
    code: 0,
    data: [
      {
        provider: 'OpenAI',
        modelList: [
          { modelCode: 'auto', modelDisplayName: 'Auto', visible: true },
          // visible:false 应被丢掉
          { modelCode: 'auto:design_expert', modelDisplayName: 'Auto', visible: false },
          { modelCode: '1Helix-G6aS8tR2qN7m', modelDisplayName: 'GPT 6 Astra', visible: true },
          // 非对话操作（视频生成）应被丢掉，且它的 visible 是 null 而不是 false
          {
            modelCode: 'rlab-1.0-storyboard',
            modelDisplayName: 'Multi-shot Video',
            visible: null,
            supportedOperationList: ['VIDEO_GENERATION'],
          },
        ],
      },
      {
        provider: 'Claude',
        modelList: [
          { modelCode: '1Orbit-I9eY7YK8bW1f', modelDisplayName: 'Claude Sonnet 4.6', visible: true },
          { modelCode: '1Orbit-Q7hN3xR6cP2m', modelDisplayName: '极致', visible: true },
        ],
      },
      {
        provider: 'Qwen',
        modelList: [
          { modelCode: '1Drift-T3TB6WS9a23w', modelDisplayName: 'Qwen 3.8 Max', visible: true },
          { modelCode: '1Drift-T3T9WWS9a23w', modelDisplayName: 'Qwen 3.8 Max', visible: true },
          { modelCode: '1Drift-F8hS3mK7pL2n', modelDisplayName: 'Qwen 3.8 Flash', visible: true },
          { modelCode: '1Drift-F8hS9mK7pL2n', modelDisplayName: 'Qwen 3.8 Flash', visible: true },
        ],
      },
    ],
  }

  const models = parseAccioModelCatalog(catalog)

  it('过滤 visible:false 与非对话操作（含 visible:null 的视频条目）', () => {
    expect(models.some((m) => m.upstreamKey === 'auto:design_expert')).toBe(false)
    expect(models.some((m) => m.upstreamKey === 'rlab-1.0-storyboard')).toBe(false)
  })

  it('**对外 id 不再是上游混淆代号**（用户报障「模型列表是乱码」的根因）', () => {
    const gpt = models.find((m) => m.upstreamKey === '1Helix-G6aS8tR2qN7m')
    expect(gpt?.id).toBe('gpt-6-astra')
    expect(gpt?.id).not.toBe('1Helix-G6aS8tR2qN7m')
    // 名仍是上游展示名（含倍率后缀不在这里——目录没给 usageMultiple）
    expect(gpt?.name).toBe('GPT 6 Astra')
  })

  it('与兜底表同名的沿用兜底表 id（既有名字保持稳定）', () => {
    const claude = models.find((m) => m.upstreamKey === '1Orbit-I9eY7YK8bW1f')
    expect(claude?.id).toBe('claude-sonnet-4-6')
  })

  it('纯中文展示名 slug 为空 → 退回代号（不造中文 id）', () => {
    const cn = models.find((m) => m.name === '极致')
    expect(cn?.id).toBe('1Orbit-Q7hN3xR6cP2m')
  })

  it('展示名重复时**两条都**留在列表里，且 id 互不相同', () => {
    const max = models.filter((m) => m.name === 'Qwen 3.8 Max')
    // ⚠️ 关键：不能「先到先得、静默丢掉后来的」——那是少一个模型
    expect(max.length).toBe(2)
    expect(new Set(max.map((m) => m.id)).size).toBe(2)
    for (const m of max) expect(m.id.startsWith('qwen-3-8-max')).toBe(true)

    const flash = models.filter((m) => m.name === 'Qwen 3.8 Flash')
    expect(flash.length).toBe(2)
    expect(new Set(flash.map((m) => m.id)).size).toBe(2)
  })

  it('全部 id 唯一（撞 id 会让两条模型共用一份开关状态）', () => {
    const ids = models.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('upstreamKey 始终原样保留（发上游用的是它，不能被改名影响）', () => {
    for (const m of models) expect(typeof m.upstreamKey).toBe('string')
    expect(models.some((m) => m.upstreamKey === '1Drift-T3TB6WS9a23w')).toBe(true)
  })
})

describe('parseAccioCredential / 可续期 / 过期', () => {
  it('接受 JSON 字符串与已解析对象', () => {
    expect(parseAccioCredential('{"access_token":"t"}')?.access_token).toBe('t')
    expect(parseAccioCredential({ access_token: 't' })?.access_token).toBe('t')
  })

  it('缺 access_token / 坏输入一律 undefined', () => {
    expect(parseAccioCredential('{}')).toBeUndefined()
    expect(parseAccioCredential('nope')).toBeUndefined()
    expect(parseAccioCredential(null)).toBeUndefined()
  })

  it('refresh_token 非空才可续期', () => {
    expect(isAccioRefreshable({ access_token: 't', refresh_token: 'r' })).toBe(true)
    expect(isAccioRefreshable({ access_token: 't' })).toBe(false)
  })

  it('过期时刻支持毫秒与秒级（秒级自动 ×1000）', () => {
    expect(accioCredentialExpiresAtMs({ access_token: 't', expires_at: 1_791_009_732_000 })).toBe(1_791_009_732_000)
    expect(accioCredentialExpiresAtMs({ access_token: 't', expires_at: 1_791_009_732 })).toBe(1_791_009_732_000)
  })
})

describe('accioAccountId / accioDisplayName', () => {
  it('账号 id 带地区前缀，且同凭据稳定', () => {
    const credential = { access_token: 'tok', user_id: 'u1' }
    const a = accioAccountId(ACCIO, credential)
    expect(a.startsWith('accio-intl-')).toBe(true)
    expect(accioAccountId(ACCIO, credential)).toBe(a)
    expect(accioAccountId(ACCIO_CN, credential).startsWith('accio-cn-')).toBe(true)
  })

  it('不同凭据得到不同 id', () => {
    expect(accioAccountId(ACCIO, { access_token: 'a' }))
      .not.toBe(accioAccountId(ACCIO, { access_token: 'b' }))
  })

  it('展示名带地区', () => {
    expect(accioDisplayName(ACCIO, { access_token: 't' })).toContain('国际版')
    expect(accioDisplayName(ACCIO_CN, { access_token: 't' })).toContain('国内版')
  })
})
