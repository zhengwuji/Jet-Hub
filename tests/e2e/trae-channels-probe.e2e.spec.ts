// 端到端验证：真实 batch 目录 + 真实适配器按模型路由通道。
import { describe, expect, it } from 'vitest'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { TRAE } from '../../src/trae-product.js'
import {
  TRAE_BATCH_MODELS_PATH,
  isTraeModelUsable,
  parseTraeBatchModelList,
  traeSOLOHeaders,
} from '../../src/trae.js'
import { readTraeCredentialsFromDshStore } from './trae-credential.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const enabled = process.env.DSH_TRAE_E2E === '1'
const d = enabled ? describe : describe.skip

/** 与 TraeAuth.fetchModels 同款的真实批量拉取。 */
async function fetchLive(credential: Record<string, unknown>) {
  const res = await fetch(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
    method: 'POST',
    headers: traeSOLOHeaders(credential as never, TRAE, false) as Record<string, string>,
    body: JSON.stringify({
      functions: [...TRAE.channels],
      agent_type: '',
      current_config_info: { config_name: '', is_custom_model: false },
      mode_type: 0, access_type: 0, ab_force_vids: '', ab_autotest_advanced_mode: 0,
      show_custom_model: true,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseTraeBatchModelList(await res.json() as unknown)
}

d('E2E-TRAE-CHANNELS', () => {
  it('真实目录 + 路由', async () => {
    const { credential } = readTraeCredentialsFromDshStore()[0]!
    const raw = credential as unknown as Record<string, unknown>

    const all = await fetchLive(raw)
    const usable = all.filter(isTraeModelUsable)
    console.log(`目录：合并 ${all.length} 条 → 可用 ${usable.length}`)
    console.log('channels = ' + JSON.stringify(TRAE.channels))
    console.log('可用模型 = ' + JSON.stringify(usable.map((m) => m.id)))

    // 1. agent 专有模型必须在，且通道正确
    const glm51 = usable.find((m) => m.id === 'glm-5.1')
    expect(glm51, 'glm-5.1 应出现在可用目录里').toBeDefined()
    expect(glm51!.function).toBe('solo_agent_remote')
    expect(glm51!.contextWindow).toBe(200_000)

    // 2. work 专有模型的通道
    const turbo = usable.find((m) => m.id === 'glm-5-turbo')
    expect(turbo?.function).toBe('solo_work_lite')

    // 3. 真不可调用的自定义模型必须被剔除（就是它们导致 4001）
    for (const bad of ['deepseek-v4-flash', 'silk-gpt-5.6-luna', 'glm-5.3-flash', 'agnes-2.5-flash']) {
      expect(usable.map((m) => m.id), bad).not.toContain(bad)
    }
    // 4. 主流模型的远端 max_tokens 已被消费
    const glm52 = usable.find((m) => m.id === 'glm-5.2')
    expect(glm52?.maxOutputTokens).toBe(32_000)
    expect(glm52?.contextWindow).toBe(200_000)

    // 5. hideInternal 模式下目录应与「官方可见集」一致（glm-5.1 被官方隐藏）
    const ideLike = all.filter((m) => isTraeModelUsable(m, { hideInternal: true }))
    expect(ideLike.map((m) => m.id)).not.toContain('glm-5.1')
    expect(ideLike.length).toBeLessThan(usable.length)

    // ── 真实适配器：按通道路由 ──
    const adapter = new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      resolveCredential: async () => credential,
      refresh: async () => {},
      fetchRemoteModels: async () => all,
      product: TRAE,
    })

    async function chat(model: string): Promise<string> {
      const chunks: string[] = []
      let err = ''
      try {
        for await (const c of adapter.stream({
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：好的' }] }],
          maxTokens: 32,
        } as unknown as GenerateOptions)) {
          const t = c as { type: string; text?: string }
          if (t.type === 'text-delta' && typeof t.text === 'string') chunks.push(t.text)
        }
      } catch (e) { err = e instanceof Error ? e.message : String(e) }
      return err !== '' ? `ERR: ${err.slice(0, 80)}` : chunks.join('').slice(0, 40)
    }

    // glm-5.1 必须走 solo_agent_remote —— 这是旧实现（固定 work_lite）必然 4001 的场景
    const r1 = await chat('glm-5.1')
    console.log(`glm-5.1（应走 solo_agent_remote）→ ${JSON.stringify(r1)}`)
    expect(r1.startsWith('ERR'), `glm-5.1 不该报错：${r1}`).toBe(false)

    // glm-5-turbo 只在 work_lite 有 —— 反向验证路由不是"一律发 agent"
    const turboModel = usable.find((m) => m.id === 'glm-5-turbo')
    if (turboModel !== undefined) {
      await new Promise((r) => setTimeout(r, 4000))
      const r2 = await chat('glm-5-turbo')
      console.log(`glm-5-turbo（应走 solo_work_lite）→ ${JSON.stringify(r2)}`)
      expect(r2.startsWith('ERR'), `glm-5-turbo 不该报错：${r2}`).toBe(false)
    }

    // 真实拉取的目录里前端应能看到这些模型
    const listed = (await adapter.listModels('trae')).map((m) => m.id)
    console.log(`listModels → ${listed.length} 个`)
    expect(listed).toContain('glm-5.1')
    expect(listed).toContain('glm-5.2')
  }, 600_000)
})
