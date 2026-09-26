import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// .mjs 无类型声明，但 tsconfig 只 include `src`、tests 不参与 typecheck，
// 且 vitest 用 esbuild 转译，故这里直接 import 纯函数是安全的。
import { decodePng, encodePng, resizeArea } from '../../scripts/extract-cline-icon.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const JET_HUB_SOURCE = join(REPO_ROOT, 'plugin-src', 'client', 'jet-hub.js')

/**
 * Cline 面板图标的回归测试。
 *
 * ## 为什么需要这个文件
 *
 * **真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。
 *
 * 初版图标是**凭印象手绘**的内联 SVG（「C 形弧线 + 圆角方块」），与 Cline 的
 * 真实标志（**顶部带凸起的圆角方块 + 中间两条竖线 + 左右两侧尖角**）完全不符。
 * 修法是从本机官方安装目录提取真实图标（`scripts/extract-cline-icon.mjs`）。
 *
 * 本测试因此守两件事：
 * 1. 内联的必须是**结构完整的 PNG**（防退回手绘 SVG）；
 * 2. 它与「从官方 PNG 重新提取」的结果**逐字节一致**（防图标被悄悄改坏）。
 *
 * ⚠️ 官方源文件可能不存在（未安装 Cline 的机器 / CI）——那条用例**干净跳过**，
 * 而不是失败。故路径探测用轻量的 `existsSync`，**内容读取留在测试体内**
 * （惰性读取：在收集阶段读不存在的文件会让整份套件变成 Failed Suite 而非 skip）。
 */
describe('Cline 面板图标（必须来自官方提取，不得手绘）', () => {
  /** 从客户端源码里取出 `CLINE_ICON` 的 data URI。 */
  function readIconDataUri(): string {
    const source = readFileSync(JET_HUB_SOURCE, 'utf8')
    const matched = /const CLINE_ICON = '([^']*)'/.exec(source)
    if (matched === null) throw new Error("jet-hub.js 里找不到 const CLINE_ICON = '...' 声明")
    return matched[1]!
  }

  it('是 PNG data URI，不是手绘 SVG', () => {
    const uri = readIconDataUri()
    // 这条断言就是「防退回手绘」的闸门：初版是 data:image/svg+xml;base64,...
    expect(uri.startsWith('data:image/png;base64,'), `当前形态：${uri.slice(0, 40)}…`).toBe(true)
    expect(uri.startsWith('data:image/svg+xml')).toBe(false)
  })

  it('base64 解码后是结构完整的 PNG，且尺寸为 48×48', () => {
    const uri = readIconDataUri()
    const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64')

    // PNG 签名（8 字节）
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // 第一个 chunk 必须是 IHDR，长度 13
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
    expect(bytes.readUInt32BE(8)).toBe(13)
    // IHDR：宽 / 高 / 位深 8 / color type 6(RGBA) / 非隔行
    expect(bytes.readUInt32BE(16)).toBe(48)
    expect(bytes.readUInt32BE(20)).toBe(48)
    expect(bytes[24]).toBe(8)
    expect(bytes[25]).toBe(6)
    expect(bytes[28]).toBe(0)
    // 以 IEND 结尾
    expect(bytes.toString('ascii', bytes.length - 8, bytes.length - 4)).toBe('IEND')
    // 体积下限：真实位图图标远大于手绘 SVG 的几百字节
    expect(bytes.length).toBeGreaterThan(1_000)
  })

  it('能被提取脚本自己的解码器读回（编码/解码自洽）', () => {
    const uri = readIconDataUri()
    const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64')
    const decoded = decodePng(bytes)
    expect(decoded.width).toBe(48)
    expect(decoded.height).toBe(48)
    expect(decoded.rgba.length).toBe(48 * 48 * 4)
    // 四角应是透明的（官方图标带透明圆角）
    const alphaAt = (x: number, y: number): number => decoded.rgba[(y * 48 + x) * 4 + 3]!
    expect(alphaAt(0, 0)).toBe(0)
    expect(alphaAt(47, 0)).toBe(0)
    expect(alphaAt(0, 47)).toBe(0)
    expect(alphaAt(47, 47)).toBe(0)
    // 中心应是不透明的品牌紫/白色标记区域
    expect(alphaAt(24, 24)).toBe(255)
  })

  /**
   * ⚠️ 需要本机装了 Cline（官方图标源存在）。未装则跳过 —— 不断言失败。
   */
  const appDir = process.env.CLINE_APP_DIR !== undefined && process.env.CLINE_APP_DIR.length > 0
    ? process.env.CLINE_APP_DIR
    : join(process.env.LOCALAPPDATA ?? '', 'Cline')
  const officialClassic = join(appDir, 'icons', 'app', 'macos', 'classic.png')
  const hasOfficialSource = existsSync(officialClassic)

  it.skipIf(!hasOfficialSource)(
    '与「从官方 classic.png 重新提取」的结果逐字节一致',
    () => {
      // 惰性读取（见文件头注释：收集阶段读文件会让 skip 变成 Failed Suite）
      const source = decodePng(readFileSync(officialClassic))
      const regenerated = encodePng(
        resizeArea(source.rgba, source.width, source.height, 48, 48), 48, 48, 'paeth',
      )
      const inlined = Buffer.from(readIconDataUri().slice('data:image/png;base64,'.length), 'base64')
      expect(inlined.equals(regenerated), '内联图标与官方源提取结果不一致（图标可能被改坏）').toBe(true)
    },
  )

  it('官方图标源缺失时明确记录（便于解释为何上面的用例被跳过）', () => {
    if (!hasOfficialSource) {
      console.log(`\n[cline-icon] 未找到官方图标源：${officialClassic}\n  → 逐字节比对用例已跳过；如需校验请安装 Cline 或设置 CLINE_APP_DIR。`)
    }
    expect(typeof hasOfficialSource).toBe('boolean')
  })
})
