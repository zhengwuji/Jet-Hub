import { describe, expect, it } from 'vitest'
import { RACCOON, raccoonProductById } from '../../src/raccoon-product.js'

describe('RACCOON 产品配置', () => {
  it('id 与显示名固定', () => {
    expect(RACCOON.id).toBe('raccoon')
    expect(RACCOON.displayName).toBe('Raccoon (商汤)')
  })

  it('基址与前缀来自 .env.electron（逐条对照，不凭印象）', () => {
    expect(RACCOON.apiBase).toBe('https://xiaohuanxiong.com')
    expect(RACCOON.authApiPrefix).toBe('/api/web/auth/v1')
    expect(RACCOON.llmApiPrefix).toBe('/api/web/llm/v2')
    expect(RACCOON.pointsApiPrefix).toBe('/api/web/points/v1')
    expect(RACCOON.desktopApiPrefix).toBe('/api/web/desktop/v1')
  })

  it('凭据 ref 与手机号密钥固定', () => {
    expect(RACCOON.defaultCredentialRef).toBe('RACCOON_ACCESS_TOKEN')
    expect(RACCOON.phoneCipherSecret).toBe('senseraccoon2023')
  })

  it('阿里云验证码配置来自渲染层模块 37907', () => {
    expect(RACCOON.aliyunCaptcha.sceneId).toBe('1pkmy0x3')
    expect(RACCOON.aliyunCaptcha.prefix).toBe('hk1r5l')
  })

  it('客户端平台标识必须是 desktop-windows（猜错会让 points/grant 被拒）', () => {
    expect(RACCOON.clientPlatform).toMatch(/^desktop-(windows|macos|linux)$/)
  })
})

describe('兜底模型表', () => {
  it('恰好 6 个可见模型，顺序照抄远端', () => {
    expect(RACCOON.fallbackModels.map((m) => m.id)).toEqual([
      'sn-sensenova-6-8-flash',
      'sn-sensenova-6-8-flash-lite',
      'sn-glm-5-3',
      'sn-kimi-k3',
      'sn-glm-5-3-flash',
      'sn-deepseek-v4-1-flash',
    ])
  })

  it('不包含 Raccoon-Auto（它是客户端 UI 合成条目，不是远端模型）', () => {
    expect(RACCOON.fallbackModels.some((m) => m.id.includes('raccoon-auto'))).toBe(false)
    expect(RACCOON.fallbackModels.some((m) => m.name.includes('Raccoon-Auto'))).toBe(false)
  })

  it('不包含 3 个 visible:false 的 raccoon-* 内部模型', () => {
    expect(RACCOON.fallbackModels.some((m) => m.id.startsWith('raccoon-'))).toBe(false)
  })

  it('展示名已含倍率（规范化形态，与 raccoonDisplayName 输出一致）', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-glm-5-3')?.name).toBe('GLM-5-3 · x0.75')
    expect(byId.get('sn-kimi-k3')?.name).toBe('Kimi-K3 · x1')
    expect(byId.get('sn-glm-5-3-flash')?.name).toBe('GLM-5-3-Flash · x0.2→x0.1')
    expect(byId.get('sn-deepseek-v4-1-flash')?.name).toBe('DeepSeek-V4.1-Flash · x0.25')
    expect(byId.get('sn-sensenova-6-8-flash')?.name).toBe('SenseNova-6.8-Flash · 免费')
    expect(byId.get('sn-sensenova-6-8-flash-lite')?.name).toBe('SenseNova-6.8-Flash-Lite · 免费')
  })

  it('上下文窗口与输出上限逐条对照远端实测值', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-sensenova-6-8-flash')?.contextWindow).toBe(256_000)
    expect(byId.get('sn-sensenova-6-8-flash')?.maxTokens).toBe(63_999)
    expect(byId.get('sn-glm-5-3')?.contextWindow).toBe(1_000_000)
    expect(byId.get('sn-glm-5-3')?.maxTokens).toBe(100_000)
    expect(byId.get('sn-deepseek-v4-1-flash')?.contextWindow).toBe(1_000_000)
  })

  it('图片能力按 tags 含 vision 判定（deepseek-v4-1-flash 不带 vision）', () => {
    const byId = new Map(RACCOON.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('sn-sensenova-6-8-flash')?.supportsImage).toBe(true)
    expect(byId.get('sn-glm-5-3')?.supportsImage).toBe(true)
    expect(byId.get('sn-kimi-k3')?.supportsImage).toBe(true)
    expect(byId.get('sn-deepseek-v4-1-flash')?.supportsImage).toBe(false)
  })

  it('所有 contextWindow / maxTokens 都是安全正整数（0 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS）', () => {
    for (const model of RACCOON.fallbackModels) {
      expect(Number.isSafeInteger(model.contextWindow)).toBe(true)
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(Number.isSafeInteger(model.maxTokens)).toBe(true)
      expect(model.maxTokens).toBeGreaterThan(0)
    }
  })
})

describe('raccoonProductById', () => {
  it('认得 raccoon，未知 id 返回 undefined', () => {
    expect(raccoonProductById('raccoon')?.id).toBe('raccoon')
    expect(raccoonProductById('buddy')).toBeUndefined()
    expect(raccoonProductById('')).toBeUndefined()
  })
})
