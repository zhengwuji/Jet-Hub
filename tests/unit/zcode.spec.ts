/**
 * ZCode（智谱 / Z.AI）产品配置、协议常量与纯函数的单元测试。
 *
 * 全部**无网络**：只验证常量、纯函数与解析逻辑。协议里最要紧的几处
 * （中转页参数的 set 语义与二次编码、模型表的静态性、不可续期）都有对应用例。
 */

import { describe, expect, it } from 'vitest'
import { ZCODE, ZCODE_INTL, ALL_ZCODE_PRODUCTS, zcodeProductById } from '../../src/zcode-product.js'
import {
  ZCODE_DEFAULT_APP_VERSION,
  applyZcodeInterstitial,
  isZcodeRefreshable,
  newZcodePollToken,
  newZcodeUuid,
  parseZcodeCredential,
  zcodeAccountId,
  zcodeAppVersion,
  zcodeCredentialExpiresAtMs,
  zcodeDisplayName,
  zcodeEnvelopeError,
  zcodeJwtExpiresAtMs,
  zcodeUrlencode,
} from '../../src/zcode.js'

describe('ZCode 产品配置', () => {
  it('两个地区各占一个 provider，id 固定', () => {
    expect(ZCODE.id).toBe('zcode')
    expect(ZCODE_INTL.id).toBe('zcode-intl')
    expect(ALL_ZCODE_PRODUCTS.map((p) => p.id)).toEqual(['zcode', 'zcode-intl'])
  })

  it('zcode 平面两地**相同**（登录/领取都在 zcode.z.ai）', () => {
    expect(ZCODE.zcodeOrigin).toBe('https://zcode.z.ai')
    expect(ZCODE_INTL.zcodeOrigin).toBe('https://zcode.z.ai')
  })

  it('推理平面两地**不同**（这是两家唯一的实质差异）', () => {
    expect(ZCODE.openaiBaseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(ZCODE_INTL.openaiBaseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
  })

  it('OAuth 的 provider 取值两地不同（且不是我们的 provider id）', () => {
    expect(ZCODE.upstreamProvider).toBe('bigmodel')
    expect(ZCODE_INTL.upstreamProvider).toBe('zai')
  })

  it('bizHost 国内版是 bigmodel.cn 而非 open.bigmodel.cn（照抄参考实现的硬编码）', () => {
    expect(ZCODE.bizHost).toBe('https://bigmodel.cn')
    expect(ZCODE_INTL.bizHost).toBe('https://api.z.ai')
  })

  it('账号 id 前缀两地不相交（同一人的 userId 可能相同）', () => {
    expect(ZCODE.accountIdPrefix).toBe('zcode-user-')
    expect(ZCODE_INTL.accountIdPrefix).toBe('zcode-intl-user-')
    expect(ZCODE.accountIdPrefix).not.toBe(ZCODE_INTL.accountIdPrefix)
  })

  it('凭据 ref 两地不同（登录态互不相通）', () => {
    expect(ZCODE.defaultCredentialRef).toBe('ZCODE_ACCESS_TOKEN')
    expect(ZCODE_INTL.defaultCredentialRef).toBe('ZCODE_INTL_ACCESS_TOKEN')
  })

  it('zcodeProductById 认得两家，未知 id 返回 undefined', () => {
    expect(zcodeProductById('zcode')?.id).toBe('zcode')
    expect(zcodeProductById('zcode-intl')?.id).toBe('zcode-intl')
    expect(zcodeProductById('glm')).toBeUndefined()
    expect(zcodeProductById('')).toBeUndefined()
  })
})

describe('ZCode 静态模型表', () => {
  it('恰好 11 个模型，顺序照抄参考实现', () => {
    expect(ZCODE.fallbackModels.map((m) => m.id)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'glm-4.7',
      'glm-4.6',
      'glm-4.5-air',
      'glm-4.6v',
      'glm-5v-turbo',
    ])
  })

  it('两地清单逐字相同（差异在账号能用哪些，不在清单）', () => {
    expect(ZCODE.fallbackModels).toEqual(ZCODE_INTL.fallbackModels)
  })

  it('glm-5.3-flash 必须被广告（体验套餐领到后实际可用的就是它）', () => {
    expect(ZCODE.fallbackModels.some((m) => m.id === 'glm-5.3-flash')).toBe(true)
  })

  it('视觉两档不支持思考（标错会让客户端发 thinking 被上游拒）', () => {
    const byId = new Map(ZCODE.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('glm-4.6v')?.supportsImage).toBe(true)
    expect(byId.get('glm-4.6v')?.supportsReasoning).toBe(false)
    expect(byId.get('glm-5v-turbo')?.supportsImage).toBe(true)
    expect(byId.get('glm-5v-turbo')?.supportsReasoning).toBe(false)
  })

  it('文本档支持思考、不支持图片', () => {
    const byId = new Map(ZCODE.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('glm-5.3')?.supportsReasoning).toBe(true)
    expect(byId.get('glm-5.3')?.supportsImage).toBe(false)
  })

  it('所有 contextWindow / maxTokens 都是安全正整数（0 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', () => {
    for (const model of ZCODE.fallbackModels) {
      expect(Number.isSafeInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(Number.isSafeInteger(model.maxTokens)).toBe(true)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
  })

  it('glm-5.3 的上下文与输出上限逐条对照源码', () => {
    const byId = new Map(ZCODE.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('glm-5.3')?.contextWindow).toBe(1_000_000)
    expect(byId.get('glm-5.3')?.maxTokens).toBe(128_000)
    expect(byId.get('glm-4.5-air')?.contextWindow).toBe(131_072)
    expect(byId.get('glm-4.5-air')?.maxTokens).toBe(98_304)
  })
})

describe('zcodeUrlencode', () => {
  it('只放行 RFC 3986 unreserved，其余百分号编码', () => {
    expect(zcodeUrlencode('abc-_.~123')).toBe('abc-_.~123')
    expect(zcodeUrlencode('a b')).toBe('a%20b')
    expect(zcodeUrlencode('a&b=c')).toBe('a%26b%3Dc')
  })

  it('把整个 URL 当查询值编码（冒号斜杠都要转）', () => {
    expect(zcodeUrlencode('zcode://oauth/callback')).toBe('zcode%3A%2F%2Foauth%2Fcallback')
  })

  it('按字节编码（多字节 UTF-8 不产生非法串）', () => {
    expect(zcodeUrlencode('中')).toBe('%E4%B8%AD')
  })
})

describe('applyZcodeInterstitial（中转页参数）', () => {
  const authorizeUrl = 'https://zcode.z.ai/api/v1/oauth/authorize?redirect=zcode%3A%2F%2Fcli%2Fcallback%2Fbigmodel&state=abc'

  // ── 当前上游形态：回调已经是 http(s) 服务端地址 → **必须原样返回** ──
  //
  // 真实故障（2026-10-04，用户报障「浏览器里登录成功，但 Jet Hub 里没有账号」）：
  // 早期实现无条件把 redirect 换成中转页，而中转页最终跳向 `zcode://` 自定义协议，
  // 服务端收不到回调 → 永远不知道该 flow 已授权 → poll 永远 pending → 超时删号。
  describe('上游回调已是 http(s) 服务端地址时，原样返回（不改写）', () => {
    // 逐字来自 2026-10-04 对 /api/v1/oauth/cli/init 的实测响应
    const realCn = 'https://bigmodel.cn/login?appId=zcode'
      + '&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel'
      + '&state=29c6667a07ab53a8d246059bbdf51e52'
    const realIntl = 'https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg'
      + '&redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai'
      + '&state=87049d2b31019009d8cb1667bdd55ef5&response_type=code'

    it('国内版：一个字都不改（含服务端 CLI 回调）', () => {
      const out = applyZcodeInterstitial(ZCODE, realCn)
      expect(out).toBe(realCn)
      expect(out).toContain('redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel')
      expect(out).not.toContain('app/oauth/login')
      expect(out).not.toContain('%253A')
    })

    it('国际版：一个字都不改（含服务端 CLI 回调）', () => {
      const out = applyZcodeInterstitial(ZCODE_INTL, realIntl)
      expect(out).toBe(realIntl)
      expect(out).toContain('redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai')
      expect(out).not.toContain('app/oauth/login')
    })

    it('http（非 https）也算服务端回调，不改写', () => {
      const plain = 'https://x/login?redirect=http://127.0.0.1:8080/cb&state=s'
      expect(applyZcodeInterstitial(ZCODE, plain)).toBe(plain)
    })

    it('原样返回时开头仍是 https（没被编码破坏）', () => {
      expect(applyZcodeInterstitial(ZCODE, realCn).startsWith('https://')).toBe(true)
    })
  })

  // ── 旧形态兜底：回调是自定义协议时才套中转页 ──
  describe('上游回调是自定义协议（旧形态）时，套中转页兜底', () => {
    it('国内版替换的是 redirect 参数（不是追加）', () => {
      const out = applyZcodeInterstitial(ZCODE, authorizeUrl)
      // 原来的 redirect 值必须消失（set 语义：同名参数只留一个）
      expect(out).not.toContain('cli%2Fcallback%2Fbigmodel')
      // 只应有一个 redirect=
      expect(out.split('redirect=').length - 1).toBe(1)
      // 中转页地址整体被编码，故这里断言编码形态而不是裸路径
      expect(out).toContain('%2Fapp%2Foauth%2Flogin')
    })

    it('国际版替换的是 redirect_uri 参数', () => {
      const intlUrl = 'https://zcode.z.ai/api/v1/oauth/authorize?redirect_uri=zcode%3A%2F%2Fcli%2Fcallback%2Fzai&state=abc'
      const out = applyZcodeInterstitial(ZCODE_INTL, intlUrl)
      expect(out).not.toContain('cli%2Fcallback%2Fzai')
      expect(out.split('redirect_uri=').length - 1).toBe(1)
    })

    it('中转页地址整体**再编码一次**（得到 %253A%252F%252F）', () => {
      const out = applyZcodeInterstitial(ZCODE, authorizeUrl)
      // 少这一次编码会让 &app_version=… 被外层查询吃掉
      expect(out).toContain('%253A%252F%252Foauth%252Fcallback')
    })

    it('state 等其它参数原样保留', () => {
      const out = applyZcodeInterstitial(ZCODE, authorizeUrl)
      expect(out).toContain('state=abc')
    })

    it('参数名不存在时追加（不是丢弃）', () => {
      const bare = 'https://zcode.z.ai/api/v1/oauth/authorize?state=abc'
      const out = applyZcodeInterstitial(ZCODE, bare)
      expect(out).toContain('redirect=')
      expect(out).toContain('state=abc')
    })

    it('片段（#…）被原样拼回，不参与替换', () => {
      const withHash = `${authorizeUrl}#frag`
      const out = applyZcodeInterstitial(ZCODE, withHash)
      expect(out.endsWith('#frag')).toBe(true)
    })
  })
})

describe('zcodeAppVersion / zcodeJwtExpiresAtMs / 过期时刻', () => {
  it('默认客户端版本是 3.14.0（用参考项目自己的版本号会得 1004 ineligible）', () => {
    // 不依赖环境变量的实际取值，只断言常量本身
    expect(ZCODE_DEFAULT_APP_VERSION).toBe('3.14.0')
    // 环境变量未设置时应回落到默认值
    const saved = process.env.ZCODE_APP_VERSION
    delete process.env.ZCODE_APP_VERSION
    expect(zcodeAppVersion()).toBe('3.14.0')
    if (saved !== undefined) process.env.ZCODE_APP_VERSION = saved
  })

  it('从 JWT payload 读 exp 并换算成毫秒', () => {
    // {"exp":1791009732}
    const payload = Buffer.from(JSON.stringify({ exp: 1791009732 }), 'utf8').toString('base64url')
    const token = `header.${payload}.sig`
    expect(zcodeJwtExpiresAtMs(token)).toBe(1791009732 * 1000)
  })

  it('已经是毫秒的 exp 不再乘一次', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1791009732000 }), 'utf8').toString('base64url')
    expect(zcodeJwtExpiresAtMs(`h.${payload}.s`)).toBe(1791009732000)
  })

  it('畸形令牌返回 undefined 而不抛错', () => {
    expect(zcodeJwtExpiresAtMs('')).toBeUndefined()
    expect(zcodeJwtExpiresAtMs('not-a-jwt')).toBeUndefined()
    expect(zcodeJwtExpiresAtMs('a.!!!.c')).toBeUndefined()
  })

  it('凭据过期时刻优先取 expires_at，其次 JWT', () => {
    expect(zcodeCredentialExpiresAtMs({ access_token: 'x', expires_at: 12345 })).toBe(12345)
    const payload = Buffer.from(JSON.stringify({ exp: 1000 }), 'utf8').toString('base64url')
    expect(zcodeCredentialExpiresAtMs({ access_token: `h.${payload}.s` })).toBe(1_000_000)
    expect(zcodeCredentialExpiresAtMs({ access_token: 'opaque' })).toBeUndefined()
  })
})

describe('parseZcodeCredential', () => {
  it('接受 JSON 字符串', () => {
    const parsed = parseZcodeCredential('{"access_token":"key.secret","jwt":"j"}')
    expect(parsed?.access_token).toBe('key.secret')
    expect(parsed?.jwt).toBe('j')
  })

  it('接受已解析对象（调用点常拿到账号池的 credential，无需类型断言）', () => {
    const parsed = parseZcodeCredential({ access_token: 'k', user_id: 'u1' })
    expect(parsed?.access_token).toBe('k')
    expect(parsed?.user_id).toBe('u1')
  })

  it('缺 access_token / 非对象 / 坏 JSON 一律 undefined', () => {
    expect(parseZcodeCredential('{"jwt":"j"}')).toBeUndefined()
    expect(parseZcodeCredential('not json')).toBeUndefined()
    expect(parseZcodeCredential(null)).toBeUndefined()
    expect(parseZcodeCredential([1, 2])).toBeUndefined()
    expect(parseZcodeCredential('')).toBeUndefined()
  })

  it('可选字段缺失时不产生 undefined 值的键', () => {
    const parsed = parseZcodeCredential({ access_token: 'k' })
    expect(parsed).toEqual({ access_token: 'k' })
  })
})

describe('isZcodeRefreshable', () => {
  it('恒 false —— 上游没有 refresh 端点（与 Loomy 同型，与 raccoon 相反）', () => {
    expect(isZcodeRefreshable({ access_token: 'k' })).toBe(false)
    expect(isZcodeRefreshable({ access_token: 'k', jwt: 'j' })).toBe(false)
  })
})

describe('zcodeAccountId', () => {
  it('前缀由地区给出，两地不相交', () => {
    expect(zcodeAccountId(ZCODE, 'u1')).toBe('zcode-user-u1')
    expect(zcodeAccountId(ZCODE_INTL, 'u1')).toBe('zcode-intl-user-u1')
  })

  it('userId 为空时用随机后缀（不能落固定串，否则第二个账号覆盖第一个）', () => {
    const a = zcodeAccountId(ZCODE, '')
    const b = zcodeAccountId(ZCODE, '')
    expect(a.startsWith('zcode-user-anon-')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('zcodeDisplayName', () => {
  it('有 userId 时附在后面，便于多账号区分', () => {
    expect(zcodeDisplayName(ZCODE, { access_token: 'k', user_id: 'u1' })).toBe('ZCode 国内版 · u1')
    expect(zcodeDisplayName(ZCODE_INTL, { access_token: 'k', user_id: 'u2' })).toBe('ZCode 国际版 · u2')
  })

  it('无 userId 时退回地区名（不产出孤立的「·」）', () => {
    expect(zcodeDisplayName(ZCODE, { access_token: 'k' })).toBe('ZCode 国内版')
  })
})

describe('zcodeEnvelopeError', () => {
  it('code 缺失或为 0 视为成功', () => {
    expect(zcodeEnvelopeError({ data: {} })).toBeUndefined()
    expect(zcodeEnvelopeError({ code: 0 })).toBeUndefined()
  })

  it('非 0 时带出上游 msg', () => {
    expect(zcodeEnvelopeError({ code: 1003, msg: 'already claimed' })).toContain('already claimed')
    expect(zcodeEnvelopeError({ code: 1003, msg: 'already claimed' })).toContain('1003')
  })

  it('msg 缺失时用兜底文案（不留空白）', () => {
    expect(zcodeEnvelopeError({ code: 500 })).toContain('上游拒绝')
  })

  it('非对象输入不抛错', () => {
    expect(zcodeEnvelopeError(null)).toBeUndefined()
    expect(zcodeEnvelopeError('x')).toBeUndefined()
  })
})

describe('随机件', () => {
  it('poll token 是 64 位十六进制', () => {
    const token = newZcodePollToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toBe(newZcodePollToken())
  })

  it('设备标识是 UUID v4 形态（非 UUID 形态会被上游当缺失，回 3001）', () => {
    const id = newZcodeUuid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).not.toBe(newZcodeUuid())
  })
})
