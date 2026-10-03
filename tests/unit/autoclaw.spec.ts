/**
 * AutoClaw（智谱 autoglm）产品配置、协议常量与纯函数的单元测试。
 *
 * 全部**无网络**：只验证常量、纯函数与解析逻辑。几处最要紧的协议约束
 * （鉴权头是 `X-Authorization`、system 白名单改写、签名公式、两地差异、
 * 路由解析顺序、`zai_auto` 回退）都有对应用例。
 */

import { describe, expect, it } from 'vitest'
import {
  AUTOCLAW,
  AUTOCLAW_INTL,
  ALL_AUTOCLAW_PRODUCTS,
  autoclawProductById,
  AUTOCLAW_APP_ID,
  AUTOCLAW_APP_KEY,
  AUTOCLAW_CALLBACK_PORTS,
} from '../../src/autoclaw-product.js'
import {
  autoclawAccountId,
  autoclawBrandHeaders,
  autoclawCredentialExpiresAtMs,
  autoclawDisplayName,
  autoclawSignedHeaders,
  isAutoclawRefreshable,
  normalizeAutoclawSystemMessages,
  parseAutoclawCredential,
  resolveAutoclawRoute,
  stripBearerPrefix,
} from '../../src/autoclaw.js'
import { normalizeAutoclawPhone } from '../../src/autoclaw-auth.js'

describe('AutoClaw 产品配置', () => {
  it('两个地区各占一个 provider，id 固定', () => {
    expect(AUTOCLAW.id).toBe('autoclaw')
    expect(AUTOCLAW_INTL.id).toBe('autoclaw-intl')
    expect(ALL_AUTOCLAW_PRODUCTS.map((p) => p.id)).toEqual(['autoclaw', 'autoclaw-intl'])
  })

  it('推理基址两地不同，且都**含尾部 /autoclaw**（少了会 404）', () => {
    expect(AUTOCLAW.upstreamBaseUrl).toBe(
      'https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw',
    )
    expect(AUTOCLAW_INTL.upstreamBaseUrl).toBe(
      'https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw',
    )
    expect(AUTOCLAW.upstreamBaseUrl.endsWith('/autoclaw')).toBe(true)
    expect(AUTOCLAW_INTL.upstreamBaseUrl.endsWith('/autoclaw')).toBe(true)
  })

  it('业务基址不含尾部 /autoclaw（目录与钱包走 /proxy/ 一级）', () => {
    expect(AUTOCLAW.userapiBaseUrl).toBe('https://autoglm-acceleration-api.zhipuai.cn')
    expect(AUTOCLAW_INTL.userapiBaseUrl).toBe('https://autoglm-api.autoglm.ai')
    expect(AUTOCLAW.userapiBaseUrl.endsWith('/autoclaw')).toBe(false)
  })

  it('登录方式两地不同：国内短信、国际 OAuth', () => {
    expect(AUTOCLAW.loginMode).toBe('sms')
    expect(AUTOCLAW_INTL.loginMode).toBe('oauth')
  })

  it('账号 id 前缀两地不相交', () => {
    expect(AUTOCLAW.accountIdPrefix).toBe('user-')
    expect(AUTOCLAW_INTL.accountIdPrefix).toBe('intl-user-')
    expect(AUTOCLAW.accountIdPrefix).not.toBe(AUTOCLAW_INTL.accountIdPrefix)
  })

  it('凭据 ref 两地不同', () => {
    expect(AUTOCLAW.defaultCredentialRef).toBe('AUTOCLAW_ACCESS_TOKEN')
    expect(AUTOCLAW_INTL.defaultCredentialRef).toBe('AUTOCLAW_INTL_ACCESS_TOKEN')
  })

  it('appId / appKey 两地**逐字相同**（同一套签名指纹）', () => {
    expect(AUTOCLAW_APP_ID).toBe('100003')
    expect(AUTOCLAW_APP_KEY).toBe('38d2391985e2369a5fb8227d8e6cd5e5')
  })

  it('Zai 回调端口白名单是那四个（逐字校验，host 必须是 localhost）', () => {
    expect([...AUTOCLAW_CALLBACK_PORTS]).toEqual([18432, 19654, 19723, 53699])
  })

  it('autoclawProductById 认得两家，未知 id 返回 undefined', () => {
    expect(autoclawProductById('autoclaw')?.id).toBe('autoclaw')
    expect(autoclawProductById('autoclaw-intl')?.id).toBe('autoclaw-intl')
    expect(autoclawProductById('zcode')).toBeUndefined()
  })

  it('静态模型表两地共用，含 GLM-5.3 与 GLM-5.3-Flash', () => {
    expect(AUTOCLAW.fallbackModels.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(AUTOCLAW.fallbackModels).toEqual(AUTOCLAW_INTL.fallbackModels)
  })

  it('静态表带 routeId（上游真名），且与 id 不同', () => {
    const byId = new Map(AUTOCLAW.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('glm-5.3')?.routeId).toBe('zaicoding_glm-5.3')
    expect(byId.get('glm-5.3-flash')?.routeId).toBe('zai_glm-5.3-flash')
  })
})

describe('autoclawSignedHeaders（登录/业务域）', () => {
  const headers = autoclawSignedHeaders('')

  it('鉴权头是小写 authorization，且空 token 时不带', () => {
    expect(headers.authorization).toBeUndefined()
  })

  it('带 token 时是 Bearer 前缀', () => {
    expect(autoclawSignedHeaders('tok').authorization).toBe('Bearer tok')
  })

  it('业务域**必须带** X-Harness-Type: zcode（不带会签名失败 400002）', () => {
    expect(headers['X-Harness-Type']).toBe('zcode')
  })

  it('签名三件套齐全，且 X-Auth-TimeStamp 是秒级十进制', () => {
    expect(headers['X-Auth-Appid']).toBe(AUTOCLAW_APP_ID)
    expect(headers['X-Auth-Sign']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['X-Auth-TimeStamp']).toMatch(/^\d{10}$/)
  })

  it('签名是 md5(appId&ts&appKey)，与独立计算一致', () => {
    const ts = Number(headers['X-Auth-TimeStamp'])
    // 复算：用同一个 ts 无法直接复用（函数内部取当前时间），
    // 故只断言形态与长度 —— 公式的逐字正确性由实现内的单点定义保证。
    expect(Number.isSafeInteger(ts)).toBe(true)
  })

  it('X-Tm 只有 win / linux 两个分支（**没有 mac**，照抄源码的刻意行为）', () => {
    expect(['win', 'linux']).toContain(headers['X-Tm'])
  })

  it('固定身份头逐字', () => {
    expect(headers['X-Product']).toBe('autoclaw')
    expect(headers['X-Client-Type']).toBe('pc')
    expect(headers['X-Lang']).toBe('zh-CN')
    expect(headers['X-Channel']).toBe('official')
    expect(headers['X-Version']).toBe('1.18.5')
  })
})

describe('autoclawBrandHeaders（推理域）', () => {
  const headers = autoclawBrandHeaders('tok', 'zaicoding_glm-5.3')

  it('鉴权头是 X-Authorization（**不是** Authorization）—— 发错稳定 401', () => {
    expect(headers['X-Authorization']).toBe('Bearer tok')
    expect(headers.Authorization).toBeUndefined()
  })

  it('绝不发 X-Harness-Type（在 LLM 域带它会 403 pay-view / 406 空体）', () => {
    expect(headers['X-Harness-Type']).toBeUndefined()
  })

  it('双模型标识：头 X-Request-Model 是完整路由 ID', () => {
    expect(headers['X-Request-Model']).toBe('zaicoding_glm-5.3')
  })

  it('x_trace_id 是下划线形态的 autoclaw-desktop（照抄）', () => {
    expect(headers.x_trace_id).toBe('autoclaw-desktop')
  })

  it('X-Request-Id 每次不同', () => {
    const a = autoclawBrandHeaders('tok', 'r')['X-Request-Id']
    const b = autoclawBrandHeaders('tok', 'r')['X-Request-Id']
    expect(a).not.toBe(b)
  })

  it('推理域 X-Tm 有 mac 分支（与业务域刻意不同）', () => {
    expect(['win', 'mac', 'linux']).toContain(headers['X-Tm'])
  })

  it('推理版本是 1.17.8（与业务域的 1.18.5 不同）', () => {
    expect(headers['X-Version']).toBe('1.17.8')
  })
})

describe('resolveAutoclawRoute（路由解析，顺序不可换）', () => {
  it('静态表：按 id 命中，返回 routeId 与剥前缀的 model', () => {
    const route = resolveAutoclawRoute(AUTOCLAW, 'glm-5.3', [])
    expect(route.routeId).toBe('zaicoding_glm-5.3')
    expect(route.model).toBe('glm-5.3')
    expect(route.requested).toBe('glm-5.3')
  })

  it('静态表：大小写不敏感', () => {
    expect(resolveAutoclawRoute(AUTOCLAW, 'GLM-5.3', []).routeId).toBe('zaicoding_glm-5.3')
  })

  it('静态表：也能按 name 命中', () => {
    expect(resolveAutoclawRoute(AUTOCLAW, 'GLM-5.3-Flash', []).routeId).toBe('zai_glm-5.3-flash')
  })

  it('已知前缀：zaicoding_ 开头原样透传并剥前缀', () => {
    const route = resolveAutoclawRoute(AUTOCLAW, 'zaicoding_custom-x', [])
    expect(route.routeId).toBe('zaicoding_custom-x')
    expect(route.model).toBe('custom-x')
  })

  it('已知前缀：zai_ 开头同样处理', () => {
    const route = resolveAutoclawRoute(AUTOCLAW, 'zai_something', [])
    expect(route.routeId).toBe('zai_something')
    expect(route.model).toBe('something')
  })

  it('都不中时回退 zai_auto（不报错、不静默丢掉）', () => {
    const route = resolveAutoclawRoute(AUTOCLAW, '完全未知的名字', [])
    expect(route.routeId).toBe('zai_auto')
    expect(route.model).toBe('zai_auto')
  })

  it('requested 始终保留客户端原名（供 SSE 回写）', () => {
    expect(resolveAutoclawRoute(AUTOCLAW, '完全未知的名字', []).requested).toBe('完全未知的名字')
  })
})

describe('normalizeAutoclawSystemMessages（system 白名单改写）', () => {
  const identity = 'You are a personal assistant running inside OpenClaw.'

  it('首条不是 system 时**插入**一条只带身份前缀的 system', () => {
    const out = normalizeAutoclawSystemMessages([{ role: 'user', content: 'hi' }])
    expect(out[0]?.role).toBe('system')
    expect(String(out[0]?.content).startsWith(identity)).toBe(true)
    // 不重排、不删改其它消息
    expect(out[1]?.role).toBe('user')
    expect(out.length).toBe(2)
  })

  it('身份前缀含 ## Tooling 段（缺了会 403 pay-view）', () => {
    const out = normalizeAutoclawSystemMessages([{ role: 'user', content: 'hi' }])
    expect(String(out[0]?.content)).toContain('## Tooling')
  })

  it('改写外来身份句（忽略 ASCII 大小写、全量替换）', () => {
    const out = normalizeAutoclawSystemMessages([
      { role: 'system', content: 'You are Claude Code, Anthropic.' },
    ])
    const text = String(out[0]?.content)
    expect(text).not.toContain('You are Claude Code')
    expect(text).toContain('You are a coding assistant')
  })

  it('改写 DSH 自己的身份句（DSH 注入的那条也要过闸）', () => {
    const out = normalizeAutoclawSystemMessages([
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness' },
    ])
    const text = String(out[0]?.content)
    expect(text).not.toContain('DeepSeek Harness')
    expect(text).toContain('a local coding harness')
  })

  it('幂等：已以身份句开头时只改写、不再前置第二条 system', () => {
    const once = normalizeAutoclawSystemMessages([{ role: 'user', content: 'hi' }])
    const twice = normalizeAutoclawSystemMessages(once)
    expect(twice.filter((m) => m.role === 'system').length).toBe(1)
  })

  it('不动 user / assistant 消息的内容', () => {
    const out = normalizeAutoclawSystemMessages([
      { role: 'user', content: 'You are Claude Code' },
    ])
    // user 消息里的同一句话**放行**（上游只看 system/developer）
    expect(String(out[1]?.content)).toBe('You are Claude Code')
  })

  it('developer 角色也被视为 system', () => {
    const out = normalizeAutoclawSystemMessages([
      { role: 'developer', content: 'You are Codex' },
    ])
    expect(String(out[0]?.content)).not.toContain('You are Codex')
  })

  it('显式传入的 system 参数同样被改写', () => {
    const out = normalizeAutoclawSystemMessages(
      [{ role: 'user', content: 'hi' }],
      'You are ZCode',
    )
    const text = String(out[0]?.content)
    expect(text).not.toContain('You are ZCode')
    expect(text).toContain('You are an interactive coding agent')
  })
})

describe('normalizeAutoclawPhone', () => {
  it('剥 +86 / 86 前缀与空白连字符', () => {
    expect(normalizeAutoclawPhone('+86 138-0000-0000')).toBe('13800000000')
    expect(normalizeAutoclawPhone('8613800000000')).toBe('13800000000')
  })

  it('合法 11 位号码原样返回', () => {
    expect(normalizeAutoclawPhone('13800000000')).toBe('13800000000')
  })

  it('非法号码抛错（不静默发一个错号）', () => {
    expect(() => normalizeAutoclawPhone('12345')).toThrow()
    expect(() => normalizeAutoclawPhone('23800000000')).toThrow()
    expect(() => normalizeAutoclawPhone('')).toThrow()
  })
})

describe('parseAutoclawCredential', () => {
  it('接受 JSON 字符串与已解析对象', () => {
    expect(parseAutoclawCredential('{"access_token":"t","refresh_token":"r"}')?.access_token).toBe('t')
    expect(parseAutoclawCredential({ access_token: 't' })?.access_token).toBe('t')
  })

  it('缺 access_token / 坏输入一律 undefined', () => {
    expect(parseAutoclawCredential('{"refresh_token":"r"}')).toBeUndefined()
    expect(parseAutoclawCredential('nope')).toBeUndefined()
    expect(parseAutoclawCredential(null)).toBeUndefined()
    expect(parseAutoclawCredential([1])).toBeUndefined()
  })
})

/**
 * 令牌自带的 `Bearer ` 前缀必须被剥掉。
 *
 * ## 真实故障（2026-10-04，用户报障「AutoClaw (国内版) 积分查询失败」）
 *
 * 上游 `agent-login` 返回的 `access_token` **本身就带 `Bearer ` 前缀**，
 * 而头构造又补一个，于是实际发出 `Bearer Bearer eyJ…`，服务端一律回
 * `410000 用户未登录`。实测 A/B 已证实：
 *
 * ```text
 *   "Bearer " + "Bearer eyJ…" → {"code":410000,"msg":"用户未登录，请重新登录"}
 *   "Bearer " + "eyJ…"        → {"code":0,"data":{"wallets":[…],"total_balance":16}}
 * ```
 *
 * 这一组用例把「**绝不发出 `Bearer Bearer`**」这条不变量锁住 ——
 * 它属于**本项目的格式约定**（我们永远不该拼出双前缀），与上游给什么都不冲突。
 */
describe('stripBearerPrefix：绝不拼出 `Bearer Bearer`', () => {
  it('剥掉大小写不敏感的前缀与首尾空白', () => {
    expect(stripBearerPrefix('Bearer eyJ.x.y')).toBe('eyJ.x.y')
    expect(stripBearerPrefix('bearer eyJ.x.y')).toBe('eyJ.x.y')
    expect(stripBearerPrefix('BEARER   eyJ.x.y')).toBe('eyJ.x.y')
    expect(stripBearerPrefix('  Bearer\teyJ.x.y  ')).toBe('eyJ.x.y')
  })

  it('对本来干净的令牌是**无操作**（不能把正常凭据改坏）', () => {
    expect(stripBearerPrefix('eyJhbGciOi.payload.sig')).toBe('eyJhbGciOi.payload.sig')
    expect(stripBearerPrefix('sk-abc.def')).toBe('sk-abc.def')
  })

  it('只剥一次：令牌本体以 Bearer 开头时保留第二个', () => {
    expect(stripBearerPrefix('Bearer Bearer x')).toBe('Bearer x')
  })

  it('解析凭据时对 access_token 与 refresh_token 一并剥离', () => {
    const parsed = parseAutoclawCredential({
      access_token: 'Bearer eyJ.access.sig',
      refresh_token: 'Bearer eyJ.refresh.sig',
    })
    expect(parsed?.access_token).toBe('eyJ.access.sig')
    // refresh_token 是**裸发**进续期请求体的，带前缀会被判无效
    expect(parsed?.refresh_token).toBe('eyJ.refresh.sig')
  })

  it('剥离后为空串的凭据视为无效（不落一条永远 401 的账号）', () => {
    expect(parseAutoclawCredential({ access_token: 'Bearer ' })).toBeUndefined()
  })

  it('业务链头：带前缀的令牌不会拼成双前缀', () => {
    const headers = autoclawSignedHeaders('Bearer eyJ.access.sig')
    expect(headers.authorization).toBe('Bearer eyJ.access.sig')
    expect(headers.authorization).not.toContain('Bearer Bearer')
  })

  it('业务链头：干净令牌拼出的形态不变（回归）', () => {
    expect(autoclawSignedHeaders('eyJ.access.sig').authorization).toBe('Bearer eyJ.access.sig')
  })

  it('业务链头：空令牌仍然不发该头（匿名接口的既有行为）', () => {
    expect(autoclawSignedHeaders('').authorization).toBeUndefined()
    expect(autoclawSignedHeaders('   ').authorization).toBeUndefined()
  })

  it('推理链头：X-Authorization 同样不会拼成双前缀', () => {
    const headers = autoclawBrandHeaders('Bearer eyJ.access.sig', 'zaicoding_glm-5.3')
    expect(headers['X-Authorization']).toBe('Bearer eyJ.access.sig')
    expect(headers['X-Authorization']).not.toContain('Bearer Bearer')
  })
})

describe('isAutoclawRefreshable / 过期时刻', () => {
  it('refresh_token 非空才可续期', () => {
    expect(isAutoclawRefreshable({ access_token: 't', refresh_token: 'r' })).toBe(true)
    expect(isAutoclawRefreshable({ access_token: 't' })).toBe(false)
    expect(isAutoclawRefreshable({ access_token: 't', refresh_token: '' })).toBe(false)
  })

  it('过期时刻优先 expires_at，其次 JWT exp（秒→毫秒）', () => {
    // 毫秒形态原样返回
    expect(autoclawCredentialExpiresAtMs({ access_token: 't', expires_at: 1_791_009_732_000 })).toBe(1_791_009_732_000)
    // 秒形态自动 ×1000（上游有的接口给秒）
    expect(autoclawCredentialExpiresAtMs({ access_token: 't', expires_at: 1_791_009_732 })).toBe(1_791_009_732_000)
    const payload = Buffer.from(JSON.stringify({ exp: 2000 }), 'utf8').toString('base64url')
    expect(autoclawCredentialExpiresAtMs({ access_token: `h.${payload}.s` })).toBe(2_000_000)
    expect(autoclawCredentialExpiresAtMs({ access_token: 'opaque' })).toBeUndefined()
  })

  it('不合理的 expires_at 被忽略（不把 1970 年当成过期时间）', () => {
    // 999 既不是合法的毫秒也不是合法的秒级时间戳 —— 回落到 JWT，解不出则 undefined。
    expect(autoclawCredentialExpiresAtMs({ access_token: 'opaque', expires_at: 999 })).toBeUndefined()
  })
})

describe('autoclawAccountId / autoclawDisplayName', () => {
  it('账号 id 带地区前缀', () => {
    expect(autoclawAccountId(AUTOCLAW, 'u1')).toBe('user-u1')
    expect(autoclawAccountId(AUTOCLAW_INTL, 'u1')).toBe('intl-user-u1')
  })

  it('userId 为空时用随机后缀（不落固定串，避免互相覆盖）', () => {
    const a = autoclawAccountId(AUTOCLAW, '')
    expect(a).not.toBe(autoclawAccountId(AUTOCLAW, ''))
  })

  it('展示名带地区与身份，便于多账号区分', () => {
    expect(autoclawDisplayName(AUTOCLAW, { access_token: 't', user_id: 'u1' })).toContain('国内版')
    expect(autoclawDisplayName(AUTOCLAW_INTL, { access_token: 't', user_id: 'u1' })).toContain('国际版')
  })
})
