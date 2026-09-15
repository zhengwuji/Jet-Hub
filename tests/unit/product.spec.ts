import { describe, expect, it } from 'vitest'
import { ALL_PRODUCTS, CODEBUDDY, CODEBUDDY_INTL, WORKBUDDY_CN, WORKBUDDY, productById } from '../../src/product.js'

describe('产品配置', () => {
  it('CodeBuddy 国际版使用 ide platform 与 www.codebuddy.ai 端点', () => {
    expect(CODEBUDDY_INTL).toMatchObject({
      id: 'buddy-intl',
      platform: 'ide',
      endpoint: 'https://www.codebuddy.ai',
      apiDomain: 'www.codebuddy.ai',
      productCode: 'codebuddy',
      defaultCredentialRef: 'BUDDY_INTL_ACCESS_TOKEN',
      appendSessionParams: false,
    })
  })

  it('WorkBuddy 国内版使用 workbuddy platform 与 copilot.tencent.com 端点', () => {
    expect(WORKBUDDY_CN).toMatchObject({
      id: 'workbuddy-cn',
      platform: 'workbuddy',
      endpoint: 'https://copilot.tencent.com',
      apiDomain: 'copilot.tencent.com',
      productCode: 'workbuddy',
      defaultCredentialRef: 'WORKBUDDY_CN_ACCESS_TOKEN',
      appendSessionParams: true,
      pluginVersion: '5.5.4',
    })
  })

  it('所有产品的 id 互不相同', () => {
    const ids = ALL_PRODUCTS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ALL_PRODUCTS.length)
  })

  it('CodeBuddy 使用 ide platform、codebuddy 产品码与中国区端点', () => {
    expect(CODEBUDDY).toMatchObject({
      id: 'buddy',
      platform: 'ide',
      endpoint: 'https://copilot.tencent.com',
      apiDomain: 'copilot.tencent.com',
      productCode: 'codebuddy',
      defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
      appendSessionParams: false,
    })
  })

  it('WorkBuddy 使用 workbuddy-ai platform 与 workbuddy 产品码', () => {
    expect(WORKBUDDY).toMatchObject({
      id: 'workbuddy',
      platform: 'workbuddy-ai',
      productCode: 'workbuddy',
      defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
      appendSessionParams: true,
    })
  })

  it('两个产品的 id 互不相同', () => {
    expect(CODEBUDDY.id).not.toBe(WORKBUDDY.id)
  })

  it('两个产品使用不同的 endpoint（模型池随区域不同，不能共用）', () => {
    // 这是国际版改造的核心：路径与解析逻辑相同，但域名不同，
    // 不同区域后端返回不同模型池（中国版 glm/hy/deepseek，国际版 claude/gpt/gemini）。
    expect(WORKBUDDY.endpoint).toBe('https://www.workbuddy.ai')
    expect(WORKBUDDY.endpoint).not.toBe(CODEBUDDY.endpoint)
  })

  it('apiDomain 与 endpoint 的主机名一致', () => {
    for (const product of ALL_PRODUCTS) {
      expect(new URL(product.endpoint).hostname).toBe(product.apiDomain)
    }
  })

  it('WorkBuddy 携带 pluginVersion 且 appendSessionParams 为 true', () => {
    // 逆向自 WorkBuddyAI 5.5.2 的 cli/product.json
    expect(WORKBUDDY.pluginVersion).toBe('5.5.2')
    expect(WORKBUDDY.appendSessionParams).toBe(true)
  })

  it('CodeBuddy 不需要追加会话参数', () => {
    expect(CODEBUDDY.appendSessionParams).toBe(false)
    expect(CODEBUDDY.pluginVersion).toBeUndefined()
  })

  it('两个产品的 endpoint 都是 HTTPS', () => {
    for (const product of ALL_PRODUCTS) {
      expect(product.endpoint.startsWith('https://')).toBe(true)
    }
  })

  it('两个产品都带兜底模型目录，且条目字段完整', () => {
    // 兜底目录的用途：服务端按认证上下文下发的模型集合可能残缺，
    // 用产品自带的权威清单校正（见 BuddyAdapter.reconcileWithFallback）。
    for (const product of ALL_PRODUCTS) {
      expect(product.fallbackModels, product.id).toBeDefined()
      expect(product.fallbackModels!.length).toBeGreaterThan(0)
      for (const model of product.fallbackModels!) {
        expect(typeof model.id).toBe('string')
        expect(model.id.length).toBeGreaterThan(0)
        expect(typeof model.name).toBe('string')
        expect(model.name.length).toBeGreaterThan(0)
        expect(model.contextWindow).toBeGreaterThan(0)
      }
    }
  })

  it('WorkBuddy 兜底目录含 IDE 实际展示的 GPT 系列', () => {
    // 这 6 个模型是 CLI token 从 /v3/config 拿不到的（实测只返回 13 个内部别名），
    // 必须由兜底目录提供。
    const ids = new Set(WORKBUDDY.fallbackModels!.map((m) => m.id))
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('兜底目录不含非对话模型与实测不可用的内部别名', () => {
    const banned = ['o4-mini', 'nes-1.1', 'nes-1.2', 'completion-1.0', 'codewise-jump', 'hunyuan-image-alpha']
    for (const product of ALL_PRODUCTS) {
      for (const id of banned) {
        expect(product.fallbackModels!.some((m) => m.id === id), `${product.id}:${id}`).toBe(false)
      }
    }
  })

  it('思考等级非空的条目带默认等级', () => {
    for (const product of ALL_PRODUCTS) {
      for (const model of product.fallbackModels!) {
        if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0) {
          for (const effort of model.reasoningEfforts) {
            expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(effort)
          }
        }
      }
    }
  })

  it('productById 能按 id 查到配置', () => {
    expect(productById('buddy')).toBe(CODEBUDDY)
    expect(productById('buddy-intl')).toBe(CODEBUDDY_INTL)
    expect(productById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(productById('buddy-intl')).toBe(CODEBUDDY_INTL)
    expect(productById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(productById('buddy-intl')).toBe(CODEBUDDY_INTL)
    expect(productById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(productById('buddy-intl')).toBe(CODEBUDDY_INTL)
    expect(productById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(productById('buddy-intl')).toBe(CODEBUDDY_INTL)
    expect(productById('workbuddy-cn')).toBe(WORKBUDDY_CN)
    expect(productById('workbuddy')).toBe(WORKBUDDY)
  })

  it('productById 对未知 id 返回 undefined', () => {
    expect(productById('codearts')).toBeUndefined()
    expect(productById('')).toBeUndefined()
  })
})
