import { describe, expect, it } from 'vitest'
import { QODER, ALL_QODER_PRODUCTS, qoderProductById } from '../../src/qoder-product.js'

describe('Qoder 产品配置', () => {
  it('端点常量与逆向结果一致（国际版）', () => {
    // 依据：设计文档 §2.1 environments.prod
    expect(QODER.authBase).toBe('https://qoder.com')
    expect(QODER.openApiBase).toBe('https://openapi.qoder.sh')
    // ⚠️ 推理基址与 environments.prod.inferBaseUrl（api2.qoder.sh）不同
    expect(QODER.inferBase).toBe('https://api2-v2.qoder.sh')
  })

  it('prod 用 J_a 作 clientId，G_a 仅作非 prod 记录', () => {
    // 依据：源码 `client_id: i ? J_a : G_a`，调用点第 4 参是 isProd()。
    // **不要读反** —— 早期读反导致 GitHub 授权后报「参数无效」（真实缺陷）。
    expect(QODER.clientId).toBe('e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
    expect(QODER.testClientId).toBe('e93fe488-5778-4c35-a6fc-0f54ed7b3139')
  })

  it('client metadata 取 CLI 默认值', () => {
    // 依据：设计文档 §2.2 Fp()
    expect(QODER.clientMetadata).toEqual({
      client_type: '5',
      business_product: 'cli',
      business_type: 'agent',
      scene: 'assistant',
    })
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(QODER.defaultCredentialRef).toBe('QODER_ACCESS_TOKEN')
  })

  it('兜底模型表非空、id 唯一、含 auto', () => {
    const ids = QODER.fallbackModels.map((m) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('auto')
  })

  it('加密端点与公开端点**不是同一个 host**', () => {
    // 这是踩过的坑：加密推理（agent_chat_generation）走 api2.qoder.sh，
    // 公开 OpenAI 兼容端点走 api2-v2.qoder.sh。混用会 404。
    expect(QODER.inferBase).toBe('https://api2-v2.qoder.sh')
    expect(QODER.encryptedInferBase).toBe('https://api2.qoder.sh')
    expect(QODER.encryptedInferBase).not.toBe(QODER.inferBase)
  })

  it('展示名必须含模型名与版本，不能只写厂商（用户报障）', () => {
    // 真实缺陷（用户报障）：「选择模型时看到的是 GLM、DeepSeek、MiniMax，
    // 只有厂商名字没有模型名字和版本，这个显示肯定不对」。
    // 展示名是用户唯一的辨识依据，只写厂商等于没有信息。
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('gmodel')).toBe('GLM-5.3')
    expect(byId.get('dmodel')).toBe('DeepSeek-V4-Pro')
    expect(byId.get('mmodel')).toBe('MiniMax-M3')
    expect(byId.get('kmodel')).toBe('Kimi-K2.8-Preview')
    expect(byId.get('qmodel')).toBe('Qwen3.7-Plus')
  })

  it('表里是**模型目录 key**，与本机 catalog-v6 逐条一致', () => {
    // ⚠️ 早期误以为「目录 key 不能用于推理」，于是把表换成通用名
    // （qwen-flash 等），结果拿到的是 Qwen3.5/2.5 而非目录里的 Qwen3.8 系列
    // （用户报障）。真相：目录 key 用于**加密端点**，通用名用于公开端点。
    const ids = QODER.fallbackModels.map((m) => m.id)
    // 本机 catalog-v6 的 chat 场景 17 个 key（实测 2026-09-20）
    expect(ids).toEqual([
      'auto', 'ultimate', 'performance', 'efficient',
      'smodel', 'cmodel',
      'qmodel_38max', 'qfmodel',
      'qmodel_latest', 'qmodel',
      'kmodel_latest', 'kmodel',
      'gmodel', 'gfmodel',
      'dmodel', 'dfmodel',
      'mmodel',
    ])
    // 通用名**不属于**这张表（它们只在公开端点有意义）
    expect(ids).not.toContain('qwen-flash')
    expect(ids).not.toContain('qwen-plus')
  })

  it('Qwen3.8 系列必须在表内（这是本次修复的核心目标）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('qfmodel')).toBe('Qwen3.8-Flash')
    expect(byId.get('qmodel_38max')).toBe('Qwen3.8-Max')
  })

  it('免费额度模型标记正确（Qwen3.8-Max / Qwen3.8-Flash）', () => {
    const free = QODER.fallbackModels.filter((m) => m.isFree === true).map((m) => m.id)
    expect(free.sort()).toEqual(['qfmodel', 'qmodel_38max'])
  })

  it('支持思考的模型要带 efforts 档位，不支持的留空', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    // 实测：ultimate 有 xhigh/high/low/max/medium；qmodel_38max 只有 xhigh/low/medium
    expect(byId.get('ultimate')?.efforts).toEqual(['xhigh', 'high', 'low', 'max', 'medium'])
    expect(byId.get('qmodel_38max')?.efforts).toEqual(['xhigh', 'low', 'medium'])
    // auto / efficient 是非思考模型
    expect(byId.get('auto')?.supportsThinking).toBe(false)
    expect(byId.get('auto')?.efforts).toBeUndefined()
  })

  it('每个兜底模型都有正的 contextWindow', () => {
    for (const model of QODER.fallbackModels) {
      expect(model.contextWindow, model.id).toBeGreaterThan(0)
    }
  })

  it('qoderProductById 命中与未命中', () => {
    expect(qoderProductById('qoder')).toBe(QODER)
    expect(qoderProductById('nope')).toBeUndefined()
    expect(ALL_QODER_PRODUCTS).toHaveLength(1)
  })
})
