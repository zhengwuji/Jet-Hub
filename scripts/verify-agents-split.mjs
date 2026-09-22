// 校验 AGENTS.md 拆分完整性：主文件 + 分册必须覆盖原文所有章节，零丢失。
//
// 用途：**改动文档结构后跑一次**，确保没有章节在搬运中丢失。
//   用法: node scripts/verify-agents-split.mjs
//
// 判据（三条全过才算合格）：
//   1. 原文每个标题都能在「主文件」或某个「分册」里找到；
//   2. 主文件在指令预算（65536 字节）内 —— 超出会在加载时被静默截断；
//   3. 分册索引表里列出的文件都真实存在。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = 'AGENTS.md'
const VOL_DIR = 'docs/agents'
const BUDGET = 65536

let failed = 0
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++ }
const ok = (msg) => console.log(`  ✅ ${msg}`)

// ---------- 读取 ----------
const mainText = readFileSync(MAIN, 'utf8').replace(/\r\n/g, '\n')
const volFiles = existsSync(VOL_DIR)
  ? readdirSync(VOL_DIR).filter((f) => f.endsWith('.md')).sort()
  : []
const vols = new Map(volFiles.map((f) => [f, readFileSync(join(VOL_DIR, f), 'utf8').replace(/\r\n/g, '\n')]))

const norm = (s) => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
const heads = (t) => [...t.matchAll(/^(#{2,5}) (.+)$/gm)].map((m) => norm(m[2]))

// ---------- 1) 预算 ----------
console.log('【1】主文件体积必须在指令预算内')
const mainBytes = statSync(MAIN).size
if (mainBytes < BUDGET) {
  ok(`${MAIN} = ${mainBytes} 字节，占预算 ${(mainBytes / BUDGET * 100).toFixed(1)}%（余量 ${BUDGET - mainBytes}）`)
} else {
  fail(`${MAIN} = ${mainBytes} 字节，**超出预算 ${mainBytes - BUDGET}** —— 加载时会被静默截断`)
}

// ---------- 2) 分册索引表 ----------
console.log('\n【2】索引表列出的分册必须真实存在')
const linked = [...mainText.matchAll(/\(docs\/agents\/([a-z0-9-]+\.md)\)/g)].map((m) => m[1])
const uniqLinked = [...new Set(linked)]
if (uniqLinked.length === 0) {
  fail('主文件里没有任何分册链接')
} else {
  for (const f of uniqLinked) {
    if (existsSync(join(VOL_DIR, f))) ok(`索引 → ${f}`)
    else fail(`索引指向不存在的分册: ${f}`)
  }
  // 反向：存在但没被索引的分册（会导致改代码时找不到它）
  const orphan = volFiles.filter((f) => !uniqLinked.includes(f))
  if (orphan.length) fail(`存在但未登记在索引里的分册: ${orphan.join(', ')}`)
  else if (volFiles.length) ok(`无未登记分册（共 ${volFiles.length} 个）`)
}

// ---------- 3) 章节完整性（有基线时才校验）----------
console.log('\n【3】章节完整性（对照拆分前基线）')
// 基线 = 拆分前那一版的 AGENTS.md。它已随历史提交入库，故不额外保留副本。
// 需要校验时取出来：
//   git show 483a528:AGENTS.md > AGENTS.md.presplit.bak
//   node scripts/verify-agents-split.mjs
//   rm AGENTS.md.presplit.bak
const BASELINE = 'AGENTS.md.presplit.bak'
if (!existsSync(BASELINE)) {
  console.log('  ⏭️  无基线文件，跳过。')
  console.log('     如需校验：git show 483a528:AGENTS.md > AGENTS.md.presplit.bak')
} else {
  const origHeads = heads(readFileSync(BASELINE, 'utf8').replace(/\r\n/g, '\n'))
  const mainSet = new Set(heads(mainText))
  const volSet = new Set([...vols.values()].flatMap(heads))

  const lost = origHeads.filter((h) => !mainSet.has(h) && !volSet.has(h))
  const kept = origHeads.filter((h) => mainSet.has(h)).length
  const moved = origHeads.length - kept - lost.length

  console.log(`  原文标题 ${origHeads.length} 个：主文件保留 ${kept}，分册承接 ${moved}，丢失 ${lost.length}`)
  if (lost.length === 0) ok('零丢失')
  else {
    fail(`丢失 ${lost.length} 个章节:`)
    for (const h of lost) console.error(`       ${h.slice(0, 78)}`)
  }
}

// ---------- 结论 ----------
console.log('\n' + '='.repeat(64))
if (failed === 0) {
  console.log('✅ 拆分校验通过：完整、在预算内、索引一致')
} else {
  console.log(`❌ 校验未通过：${failed} 项问题（见上）`)
  process.exitCode = 1
}
