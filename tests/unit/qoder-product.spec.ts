import { describe, expect, it } from 'vitest'
import { QODER, ALL_QODER_PRODUCTS, qoderProductById } from '../../src/qoder-product.js'
import { promotionActiveNow, qoderDisplayName } from '../../src/qoder-adapter.js'

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

  /**
   * ⚠️ 真实缺陷（用户报障）：「qwen3.8-max 是 0.5 原价打折到 0.2，
   * 现在界面显示的是 0.5 不是 0.2」。
   *
   * 根因**不是展示逻辑**，而是兜底表的数值大范围过期 —— 早期表里多处是
   * 手工估值，与真实 catalog 有 14 个模型对不上（`smodel` 写 3.2 实际 8、
   * `qmodel_38max` 写 0.5 实际 0.2 …）。而旧用例**只断言了 id 列表**，
   * 所以价格漂移一直没被发现。这里锁死真实数值。
   */
  it('倍率与真实 catalog 一致（用户报障：显示 0.5 而非折后 0.2）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    // 实测 2026-09-21 的 catalog-v6 `price_factor`（采集时刻的生效价）
    const expected: Record<string, number> = {
      auto: 0.5, ultimate: 2, performance: 1.1, efficient: 0.3,
      smodel: 8, cmodel: 4,
      qmodel_38max: 0.2, qfmodel: 0, qmodel_latest: 0.1, qmodel: 0.04,
      kmodel_latest: 1.4, kmodel: 0.8,
      gmodel: 0.8, gfmodel: 0.1,
      dmodel: 0.5, dfmodel: 0.1,
      mmodel: 0.2,
    }
    for (const [id, price] of Object.entries(expected)) {
      expect(byId.get(id)?.priceFactor, `${id} 的 priceFactor`).toBe(price)
    }
  })

  it('错峰促销：原价 × 折扣 = 折后价（三条实测全部吻合）', () => {
    const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
    for (const id of ['qmodel_38max', 'qmodel_latest', 'qmodel']) {
      const m = byId.get(id)
      const p = m?.promotion
      expect(p, `${id} 应有 promotion`).toBeDefined()
      const computed = p!.beforePromotionPriceFactor! * p!.discountFactor!
      // priceFactor 是采集时刻的生效价（当时在窗口内 → 等于折后价）
      expect(Number(computed.toFixed(4)), `${id} 折后价`).toBe(m!.priceFactor)
      // 且折扣确实更便宜
      expect(m!.priceFactor!).toBeLessThan(p!.beforePromotionPriceFactor!)
    }
  })

  it('窗口字段齐备（展示层据此本地推算，不依赖会过期的 active 快照）', () => {
    for (const m of QODER.fallbackModels) {
      if (m.promotion === undefined) continue
      expect(m.promotion.windowStart, m.id).toMatch(/^\d{1,2}:\d{2}$/)
      expect(m.promotion.windowEnd, m.id).toMatch(/^\d{1,2}:\d{2}$/)
    }
  })
})

describe('Qoder 错峰时段判定（本地推算）', () => {
  const promo = {
    active: false, // ⚠️ 故意写错：快照不可信，必须以窗口为准
    discountFactor: 0.4,
    beforePromotionPriceFactor: 0.5,
    windowStart: '22:00',
    windowEnd: '08:00',
  }
  const at = (iso: string): Date => new Date(iso)

  it('跨零点窗口：22:00–08:00 的各边界', () => {
    expect(promotionActiveNow(promo, at('2026-09-21T00:18:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T03:00:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T07:59:00+08:00'))).toBe(true)
    expect(promotionActiveNow(promo, at('2026-09-21T08:00:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T12:00:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T21:59:00+08:00'))).toBe(false)
    expect(promotionActiveNow(promo, at('2026-09-21T22:00:00+08:00'))).toBe(true)
  })

  it('窗口字段缺失时回退到目录的 active', () => {
    const noWindow = { active: true, discountFactor: 0.4 }
    expect(promotionActiveNow(noWindow, at('2026-09-21T12:00:00+08:00'))).toBe(true)
    expect(promotionActiveNow({ ...noWindow, active: false }, at('2026-09-21T00:00:00+08:00'))).toBe(false)
  })

  it('非法窗口值也回退到 active（不抛错）', () => {
    const bad = { active: true, windowStart: 'xx', windowEnd: 'yy' }
    expect(promotionActiveNow(bad, at('2026-09-21T12:00:00+08:00'))).toBe(true)
  })
})

describe('Qoder 展示名', () => {
  const byId = new Map(QODER.fallbackModels.map((m) => [m.id, m]))
  const inWindow = new Date('2026-09-21T00:18:00+08:00')
  const outWindow = new Date('2026-09-21T12:00:00+08:00')

  // ⚠️ **折扣显示形态与 TRAE / buddy 对齐**（用户要求）：
  //   TRAE   `Seed-2.1-Turbo · x0.4→x0.2`
  //   buddy  `GLM-5.2 · x0.79→x0.50`
  //   Qoder  `Qwen3.8-Max · x0.5→x0.2`   ← 本次统一
  //
  // 旧形态是「只有折后价 + 中文角标」（`x0.2 错峰 4 折`），两条信息：
  // ① 看不到原价与折扣幅度；② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。
  it('窗口内显示 原价→折后价（与 TRAE/buddy 形态一致）', () => {
    const name = qoderDisplayName(byId.get('qmodel_38max')!, inWindow)
    expect(name).toBe('Qwen3.8-Max · x0.5→x0.2')
  })

  it('窗口外显示原价，且**不带箭头**（避免误导为有折扣）', () => {
    const name = qoderDisplayName(byId.get('qmodel_38max')!, outWindow)
    expect(name).toBe('Qwen3.8-Max · x0.5')
    expect(name).not.toContain('→')
    expect(name).not.toContain('错峰')
  })

  it('折扣幅度不同的模型也走箭头形态', () => {
    // qmodel_latest：原价 0.5、2 折 → 0.1
    expect(qoderDisplayName(byId.get('qmodel_latest')!, inWindow)).toBe('Qwen3.7-Max · x0.5→x0.1')
    // qmodel：原价 0.1、4 折 → 0.04
    expect(qoderDisplayName(byId.get('qmodel')!, inWindow)).toBe('Qwen3.7-Plus · x0.1→x0.04')
  })

  it('免费模型显示「免费」而不是 x0', () => {
    expect(qoderDisplayName(byId.get('qfmodel')!, inWindow)).toBe('Qwen3.8-Flash · 免费')
  })

  it('无促销的模型直接用 priceFactor（无箭头）', () => {
    expect(qoderDisplayName(byId.get('smodel')!, inWindow)).toBe('Sonus · x8')
    expect(qoderDisplayName(byId.get('dmodel')!, inWindow)).toBe('DeepSeek-V4-Pro · x0.5')
  })
})
