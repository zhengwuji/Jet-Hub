/**
 * Antigravity 本地私有通道（方案 B）端到端验证。
 *
 * **两级闸门**（与会话其余 e2e 的分级约定一致）：
 *
 * - `DSH_ANTIGRAVITY_E2E=1`
 *     只跑**只读**用例：发现 language_server、读模型清单、读账号配额。
 *     这些请求全部打向 `127.0.0.1`，**不产生任何 Google 侧流量**，因此
 *     属于安全等级最低的一档。
 *
 * - 再加 `DSH_ANTIGRAVITY_E2E_CONFIRM=yes`
 *     才跑**会消耗账号配额**的用例：真实发一条消息给模型并取回回复。
 *     虽然是 IDE 自己发出去的（服务端视角与正常使用无区别），但确实
 *     计费，故默认不执行。
 *
 * ⚠️ 与方案 A 的 e2e 不同，本文件**不读取任何凭据文件**：方案 B 的账号
 * 身份完全由 IDE 运行时决定。
 *
 * 前置条件：Antigravity IDE 必须正在运行。
 */

import { describe, expect, it } from 'vitest'
import {
  discoverLanguageServer,
  fetchModelConfigs,
  getTrajectory,
  sendUserMessage,
  startCascade,
  type LanguageServerInstance,
} from '../../src/antigravity-local.js'
import {
  AntigravityLocalAdapter,
  IDE_NOT_RUNNING_MESSAGE,
} from '../../src/antigravity-local-adapter.js'

const ENABLED = process.env.DSH_ANTIGRAVITY_E2E === '1'
/** 第二级闸门：允许消耗账号配额的真实推理。 */
const INFERENCE_ALLOWED = process.env.DSH_ANTIGRAVITY_E2E_CONFIRM === 'yes'

/** 测试期间复用一个已发现的实例，避免每个用例都跑一次进程发现。 */
let cached: LanguageServerInstance | undefined
async function instance(): Promise<LanguageServerInstance | undefined> {
  if (cached === undefined) cached = await discoverLanguageServer()
  return cached
}

describe.skipIf(!ENABLED)('antigravity local rpc e2e', () => {
  it('能发现本机 language_server 实例（纯本地，无出站流量）', async () => {
    const found = await instance()
    expect(found, '未发现 language_server：请先打开 Antigravity IDE').toBeDefined()
    // 只断言结构，**不打印 csrfToken** —— 它是敏感值。
    expect(typeof found?.port).toBe('number')
    expect(found?.port).toBeGreaterThan(1024)
    expect(found?.csrfToken.length).toBeGreaterThan(8)
    console.log('[e2e-local] 实例 pid:', found?.pid, 'port:', found?.port)
  })

  it('能拉到真实模型清单（纯本地，无出站流量）', async () => {
    const found = await instance()
    if (found === undefined) return
    const configs = await fetchModelConfigs(found)
    expect(configs.length).toBeGreaterThan(0)
    // 实测本机返回 14 个模型，且 id 形如 MODEL_PLACEHOLDER_*。
    expect(configs.some((c) => c.id.startsWith('MODEL_'))).toBe(true)
    console.log('[e2e-local] 模型数:', configs.length)
    for (const config of configs.slice(0, 5)) {
      console.log(`[e2e-local]   ${config.id} = ${config.label}`)
    }
  })

  it('StartCascade 能创建会话', async () => {
    const found = await instance()
    if (found === undefined) return
    const cascadeId = await startCascade(found)
    expect(typeof cascadeId).toBe('string')
    expect(cascadeId.length).toBeGreaterThan(8)
    console.log('[e2e-local] cascadeId:', cascadeId)

    // 新建的会话应能立刻读回（轨迹存在，即使还没有任何步骤）。
    const trajectory = await getTrajectory(found, cascadeId)
    expect(trajectory.cascadeId).toBe(cascadeId)
  })

  it('适配器报告的通道为 local', async () => {
    const adapter = new AntigravityLocalAdapter()
    const channel = await adapter.currentChannel()
    // IDE 在跑就是 local；没跑则 unavailable（allowPublicFallback 默认关闭）。
    expect(['local', 'unavailable']).toContain(channel)
    console.log('[e2e-local] 当前通道:', channel)
  })

  it.skipIf(!INFERENCE_ALLOWED)('能发消息并取回真实模型回复（消耗配额）', async () => {
    const found = await instance()
    if (found === undefined) {
      throw new Error('未发现 language_server，无法进行推理 e2e')
    }

    const configs = await fetchModelConfigs(found)
    const model = configs.find((c) => c.isRecommended)?.id ?? configs[0]?.id
    expect(model, '模型清单为空').toBeDefined()
    console.log('[e2e-local] 使用模型:', model)

    const cascadeId = await startCascade(found)
    // ⚠️ 模型必须放在 cascadeConfig.plannerConfig.planModel —— 这是打通链路
    // 的关键字段路径，写错会报 "neither PlanModel nor RequestedModel specified"。
    await sendUserMessage(found, cascadeId, 'What is 2+2? Reply with just the number.', model!)

    // 轮询等待回复（本地 loopback，不产生出站流量）。
    const deadline = Date.now() + 120_000
    let text = ''
    while (Date.now() < deadline) {
      const trajectory = await getTrajectory(found, cascadeId)
      const steps = trajectory.steps ?? []
      const reply = [...steps].reverse().find((s) => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE')
      if (reply !== undefined) {
        text = reply.plannerResponse?.modifiedResponse ?? reply.plannerResponse?.response ?? ''
        console.log('[e2e-local] 回复:', JSON.stringify(text.slice(0, 100)))
        if (reply.status === 'CORTEX_STEP_STATUS_DONE') break
      }
      await new Promise((resolve) => { setTimeout(resolve, 800) })
    }
    expect(text.length).toBeGreaterThan(0)
  })

  it('IDE 未运行时的提示文案可读', () => {
    // 这条是纯静态断言：确保降级路径给出的中文提示确实指向可执行的下一步。
    expect(IDE_NOT_RUNNING_MESSAGE).toContain('Antigravity IDE')
    expect(IDE_NOT_RUNNING_MESSAGE).toContain('必须先打开')
  })
})
