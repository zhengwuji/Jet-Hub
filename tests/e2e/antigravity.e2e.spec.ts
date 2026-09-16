/**
 * Antigravity 端到端链路验证（真实本机凭据）。
 *
 * **两级闸门**（与会话其余 e2e 的分级约定一致）：
 *
 * - `DSH_ANTIGRAVITY_E2E=1`
 *     只跑**只读**用例：读本机凭据、验证解析结果。零网络。
 *
 * - 再加 `DSH_ANTIGRAVITY_E2E_CONFIRM=yes`
 *     才跑**会发出站请求**的用例：token 续期与 Cloud Code 端点调用。
 *     这些请求使用 IDE 自己的官方 client 身份，不产生新会话，但对 Google
 *     是真实调用，故默认不执行。
 *
 * 验证内容：
 * 1. 能从本机 IDE 状态库读到真实凭据（只读）
 * 2. 续期成功后凭据能通过 Cloud Code 官方端点认证（需 CONFIRM）
 * 3. 防伪造身份的常量回归检查
 *
 * ⚠️ 本测试只读复用 IDE 凭据，不发起登录、不改动 IDE 状态。
 */

import { describe, expect, it } from 'vitest'
import {
  readAntigravityCredential,
  refreshAntigravityToken,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  CLOUD_CODE_BASE,
} from '../../src/antigravity.js'

const ENABLED = process.env.DSH_ANTIGRAVITY_E2E === '1'
/** 第二级闸门：允许发出真实的出站请求。 */
const NETWORK_ALLOWED = process.env.DSH_ANTIGRAVITY_E2E_CONFIRM === 'yes'

describe.skipIf(!ENABLED)('antigravity e2e', () => {
  it('读到本机 Antigravity 凭据（只读，无网络）', () => {
    const credential = readAntigravityCredential()
    expect(credential, '未读到凭据：请先打开 Antigravity IDE 完成登录').toBeDefined()
    expect(credential?.access_token.length).toBeGreaterThan(20)
    expect(credential?.access_token.startsWith('ya29.')).toBe(true)
    console.log('[e2e] 凭据来源:', credential?.source)
    console.log('[e2e] access_token 长度:', credential?.access_token.length)
    console.log('[e2e] refresh_token 长度:', credential?.refresh_token.length)
  })

  it.skipIf(!NETWORK_ALLOWED)('续期成功且 scope 含 experimentsandconfigs', async () => {
    const credential = readAntigravityCredential()
    if (credential === undefined) return
    const token = await refreshAntigravityToken(credential.refresh_token)
    expect(token.access_token.length).toBeGreaterThan(20)
    expect(token.token_type).toBe('Bearer')
    expect(token.scope).toContain('experimentsandconfigs')
    console.log('[e2e] 续期 scope:', token.scope)
  })

  it.skipIf(!NETWORK_ALLOWED)('续期后的凭据能通过 Cloud Code 端点认证', async () => {
    const credential = readAntigravityCredential()
    if (credential === undefined) return
    const token = await refreshAntigravityToken(credential.refresh_token)

    const response = await fetch(`${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: { ideType: 'ANTIGRAVITY', platform: 'WINDOWS_AMD64', pluginVersion: '1.0.0' },
      }),
    })
    const text = await response.text()
    console.log('[e2e] loadCodeAssist HTTP', response.status)
    console.log('[e2e] body:', text.slice(0, 500))
    expect(response.status).toBe(200)

    // 认证通过即证明凭据链路可用。
    //
    // 注意：响应中 allowedTiers 可能含 standard-tier，**同时** ineligibleTiers
    // 出现 UNSUPPORTED_CLIENT —— 后者表示个人免费层已停用（官方要求迁移到
    // Antigravity 产品线），属预期状态，不作断言失败。同理，此处**不**断言
    // 模型可调用：实测该端点对无订阅账号一律返回 403 SUBSCRIPTION_REQUIRED，
    // 而 IDE 自身仍可用（走本地 language_server 私有通道）。
    const body = JSON.parse(text) as { allowedTiers?: Array<{ id?: string }> }
    expect(Array.isArray(body.allowedTiers)).toBe(true)
  })

  it('client_id / client_secret 为官方值（防伪造身份回归检查）', () => {
    expect(ANTIGRAVITY_CLIENT_ID).toBe(
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    )
    expect(ANTIGRAVITY_CLIENT_SECRET).toMatch(/^GOCSPX-/)
  })
})
