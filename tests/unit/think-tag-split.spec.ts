/**
 * `splitThinkTaggedContent` 的回归测试。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * `workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，只在思考段
 * 末尾留一个 `</think:6124c78e>` **闭标签**（开标签缺失）。实测该会话 93 步中
 * 只有 9 步的 reasoning 通道非空，思考总量 9563 字符 vs 正文 64043 字符。
 *
 * 两个后果：
 *  1. 思考内容落在正文块里 → 现有思考守卫（只喂 reasoning）完全看不见 →
 *     该模型的正文出现真循环（去重率 0.0412），实测三段（seq 34752/34768/34823）；
 *  2. 用户在界面上看到的是「模型把内心独白当正文输出」。
 *
 * 故需按闭标签把正文块切回「思考 + 真正文」两段。
 *
 * ## 实测形态（155 会话普查）
 *
 * | 项 | 值 |
 * |---|---|
 * | 含标签的步数 | 28（仅 2 个模型：hy4-preview-f 25、workbuddy/ds-v4.1-flash 3）|
 * | 开标签 | **0** |
 * | 闭标签 | 28（每步恰好 1 个）|
 * | hex | 恒为 `6124c78e`（会话级 id，8 位小写）|
 * | 标签前 | 内心独白（`让me check.` 重复），13~34364 字符 |
 * | 标签后 | **真正文**，13~56 字符 |
 */
import { describe, expect, it } from 'vitest'
import { splitThinkTaggedContent } from '../../src/sse.js'

describe('splitThinkTaggedContent', () => {
  it('无标签时返回 undefined（不得改变既有行为）', () => {
    expect(splitThinkTaggedContent('普通正文，没有标签。')).toBeUndefined()
    expect(splitThinkTaggedContent('')).toBeUndefined()
  })

  it('闭标签前的文本归为思考、之后的归为正文', () => {
    const raw = '让me check callers.让me grep.</think:6124c78e>让me确认校验函数名。'
    const split = splitThinkTaggedContent(raw)
    expect(split).toBeDefined()
    expect(split!.reasoning).toBe('让me check callers.让me grep.')
    expect(split!.text).toBe('让me确认校验函数名。')
  })

  it('textStart 指向标签结束位置（正文在原文中的起点）', () => {
    const raw = '思考部分</think:6124c78e>正文部分'
    const split = splitThinkTaggedContent(raw)!
    // 标签长度 = '</think:6124c78e>'.length = 17
    expect(split.textStart).toBe('思考部分'.length + '</think:6124c78e>'.length)
    expect(raw.slice(split.textStart)).toBe('正文部分')
  })

  it('标签在末尾时正文为空串（实测 seq=34768 形态）', () => {
    const raw = '重复的内心独白。\n\n停止重复。读实现。</think:6124c78e>'
    const split = splitThinkTaggedContent(raw)!
    expect(split.text).toBe('')
    expect(split.reasoning).toBe('重复的内心独白。\n\n停止重复。读实现。')
  })

  it('标签在开头时思考为空串', () => {
    const raw = '</think:6124c78e>直接就是正文'
    const split = splitThinkTaggedContent(raw)!
    expect(split.reasoning).toBe('')
    expect(split.text).toBe('直接就是正文')
    expect(split.textStart).toBe('</think:6124c78e>'.length)
  })

  it('多个闭标签时以最后一个为界，且思考段不残留标签', () => {
    const raw = 'A</think:aaa>B</think:bbb>真正文'
    const split = splitThinkTaggedContent(raw)!
    // 以最后一个闭标签（bbb）为界；思考段里的 aaa 标签也要清掉。
    expect(split.reasoning).toBe('AB')
    expect(split.text).toBe('真正文')
  })

  it('hex 长度不固定也认（实测 8 位，防御更长/更短的变体）', () => {
    for (const hex of ['a', 'ab', 'abcdef', '6124c78e', '0123456789abcdef0123']) {
      const raw = `思考</think:${hex}>正文`
      const split = splitThinkTaggedContent(raw)
      expect({ hex, reasoning: split?.reasoning, text: split?.text }).toEqual({
        hex, reasoning: '思考', text: '正文',
      })
    }
  })

  it('hex 含非十六进制字符时不认（避免误伤正常文本）', () => {
    expect(splitThinkTaggedContent('思考</think:zzzz>正文')).toBeUndefined()
    expect(splitThinkTaggedContent('思考</think:>正文')).toBeUndefined()
  })

  it('只有开标签时不切分（实测开标签恒缺失，不猜语义）', () => {
    // ⚠️ 实测 28 步全部只有闭标签、开标签为 0。仅见开标签时无法确定
    // 「思考到哪结束」，故不切分 —— 保持原样比猜错安全。
    expect(splitThinkTaggedContent('<think:6124c78e>还没结束的思考')).toBeUndefined()
  })

  it('大小写不匹配不认（实测恒小写）', () => {
    expect(splitThinkTaggedContent('思考</THINK:6124c78e>正文')).toBeUndefined()
    expect(splitThinkTaggedContent('思考</Think:6124c78e>正文')).toBeUndefined()
  })

  it('不匹配无关的尖括号文本', () => {
    expect(splitThinkTaggedContent('a < b </div> c')).toBeUndefined()
    expect(splitThinkTaggedContent('</think>无 hex</think>')).toBeUndefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // 关键回归（普查发现）：必须区分「真泄漏」与「模型在**讨论/引用**标签」。
  //
  // 实测 28 处 text 块标签中，有 **3 处是反引号包裹的行内引用** —— 包括
  // 本次排查会话里我自己复述该标签字面量的正文（`seq=250/270/277`）。
  // 若只看「有没有标签」，会把这类**正常正文**的前半段误当思考移走。
  //
  // 实测判据 A（标签是否被反引号包裹）分离度：**3/3 与 25/25 全部正确**。
  // ─────────────────────────────────────────────────────────────────────
  it('反引号包裹的标签是"引用"而非泄漏，不切分', () => {
    // 实测 seq=270 形态：正文里行内引用该标签说明语义。
    expect(splitThinkTaggedContent('标签语义已明确：`</think:6124c78e>` 是思考与正文的分界符。')).toBeUndefined()
    // 实测 seq=250 形态：在反引号里复述标签。
    expect(splitThinkTaggedContent('正文里残留了 `</think:6124c78e>` 闭标签，但开标签 0 个。')).toBeUndefined()
  })

  it('裸标签（真泄漏）仍正常切分', () => {
    const raw = '让me check callers.让me grep.</think:6124c78e>让me确认校验函数名。'
    const split = splitThinkTaggedContent(raw)!
    expect(split.reasoning).toBe('让me check callers.让me grep.')
    expect(split.text).toBe('让me确认校验函数名。')
  })

  it('代码块里的标签也视为引用（``` 包裹），不切分', () => {
    const raw = '标签形态如下：\n\n```\n<思考>...</think:6124c78e><正文>\n```\n\n即闭标签是分界符。'
    expect(splitThinkTaggedContent(raw)).toBeUndefined()
  })
})
