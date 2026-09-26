import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

/**
 * 文档回归：Loomy 的**特有差异**必须写进 README/AGENTS.md，
 * 否则后来者会按其余 7 个 provider 的直觉改坏它。
 */
describe('Loomy 文档覆盖', () => {
  const readme = read('../../README.md')
  const agents = read('../../AGENTS.md')

  it('README 提到 Loomy provider', () => {
    expect(readme).toMatch(/[Ll]oomy/)
  })

  it('README 写明「不能续期」这一独有差异', () => {
    expect(readme).toMatch(/Loomy[\s\S]{0,4000}?(不能|无法|没有).{0,12}续期/)
  })

  it('README 写明两套认证头（chat 用 Bearer、业务用 token）', () => {
    expect(readme).toMatch(/Bearer[\s\S]{0,600}?token/)
  })

  it('README 写明新手任务 10000 积分与「纯 API 直领」', () => {
    expect(readme).toMatch(/10000/)
    expect(readme).toMatch(/纯 API 直领/)
  })

  it('README 写明积分两池（永久 + 每日）', () => {
    expect(readme).toMatch(/永久积分/)
    expect(readme).toMatch(/每日赠送/)
  })

  it('README 写明生产域名（不再解释测试域名的来历）', () => {
    expect(readme).toContain('loomyad.xunfei.cn')
    expect(readme).toContain('account.xfinfr.com')
  })

  it('README 记录 e2e 探针命令', () => {
    expect(readme).toContain('pnpm test:e2e:loomy')
    expect(readme).toContain('pnpm test:e2e:loomy-chat')
  })

  /**
   * ⚠️ **用户要求**：以下四类内容**不得**出现在 README / AGENTS.md 的
   * **Loomy 章节**，只能放在**不入库**的 `docs/loomy-protocol-notes.md`：
   *
   * ① 排查脚本清单（`scripts/loomy-*`）
   * ② AccessKey 说明（具体值 / `accessKeyId` / `accessKeySecret`）
   * ③ 加密细节（`.env.prod`、解密口令、`env-file-crypto`、AES）
   * ④ `app.asar` 提取方式
   *
   * ⚠️ **必须限定在 Loomy 章节内**：AGENTS.md 的 **Qoder 章节**也提到
   * `app.asar`（既有内容，不在本次要求范围）。全文匹配会误伤它。
   */
  it('Loomy 章节不含脚本清单 / AccessKey / 加密细节（用户要求）', () => {
    // 截取 Loomy 章节（从标题到文件末尾）。
    // ⚠️ 两个文件的标题写法不同：README 是「## Loomy provider（讯飞办公助手）」，
    // AGENTS.md 是「## ⚠️ Loomy（讯飞）provider：…」。故用共同的锚点
    // `Loomy` + 各自标题行的特征，这里取**最后一个**含 `Loomy` 的二级标题。
    const loomySectionOf = (text: string): string => {
      const matches = [...text.matchAll(/^## .*Loomy.*$/gm)]
      const last = matches.at(-1)
      return last?.index === undefined ? '' : text.slice(last.index)
    }
    const readmeLoomy = loomySectionOf(readme)
    const agentsLoomy = loomySectionOf(agents)
    expect(readmeLoomy.length, 'README 未找到 Loomy 章节').toBeGreaterThan(0)
    expect(agentsLoomy.length, 'AGENTS.md 未找到 Loomy 章节').toBeGreaterThan(0)

    const forbidden: [string, RegExp][] = [
      ['脚本清单', /scripts\/loomy/],
      ['AccessKey 字段名', /accessKey(Id|Secret)/],
      ['加密细节 .env.prod', /\.env\.prod/],
      ['解密实现文件', /env-file-crypto/],
      ['AES 混淆细节', /AES[- ]?256|AES 混淆/],
      ['app.asar 提取', /app\.asar/],
      ['测试域名来历', /ossptest/],
    ]
    for (const [label, pattern] of forbidden) {
      expect(readmeLoomy, `README 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
      expect(agentsLoomy, `AGENTS.md 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
    }
  })

  it('不入库的协议文档确实存在且含这些细节', () => {
    // 细节被移到这里（该文件在 .gitignore 里，故用 readFileSync 直读磁盘）
    const notes = read('../../docs/loomy-protocol-notes.md')
    expect(notes).toContain('AccessKey')
    expect(notes).toContain('env-file-crypto')
    expect(notes).toContain('scripts/loomy')
  })

  it('AGENTS.md 记录 Loomy 的协议要点', () => {
    expect(agents).toMatch(/[Ll]oomy/)
    // 新手任务是纯 API 直领（与 workbuddy 的模拟真实行为相反）
    expect(agents).toMatch(/新手任务/)
  })

  it('AGENTS.md 写明两套头与不可续期', () => {
    expect(agents).toMatch(/两套认证头|两套头/)
    // 措辞可能微调，只要求「isLoomyRefreshable」与「false」同段出现
    expect(agents).toMatch(/isLoomyRefreshable[\s\S]{0,80}?false/)
    expect(agents).toMatch(/没有 refresh 端点/)
  })

  it('AGENTS.md 记录位置参数陷阱（避免下次再加 provider 时重犯）', () => {
    expect(agents).toMatch(/位置参数/)
    expect(agents).toContain('registerJetHubRpc')
  })

  it('AGENTS.md 概述行把 provider 数量更新为七个', () => {
    expect(agents).toMatch(/七个 LLM provider 路由/)
  })
})
