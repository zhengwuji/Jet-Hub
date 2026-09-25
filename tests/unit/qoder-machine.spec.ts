/**
 * Qoder 设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）回归用例。
 *
 * ## 两次真实缺陷（本文件的用例分别锁死）
 *
 * ### ① 缺 machine 头 ⇒ 服务端不下发可领活动（2026-09-25）
 *
 * 「没领过却显示今日已领取」：配额/活动请求**缺少成对的 machine 头**时，
 * 服务端只回 1 条 `VIEW_DETAILS`（`claimable:false`），没有
 * `CLAIM_BENEFIT/CLAIMABLE`。实证来源：`qoder积分.pcapng` +
 * `SSLKEYLOGFILE` 解密；逐项消融确认 **Token 与 Type 必须成对**（缺一即失效）。
 *
 * ### ② 读**陈旧磁盘缓存** ⇒ 第二个账号看不到可领活动（2026-09-26）
 *
 * 加入第二个 Qoder 账号后，一键领取对它报「当前没有可领取的活动」，
 * 而 IDE 里可领。根因：初版**读 `machine_token.json`**，而那是
 * `runtime-info.exe` 的陈旧缓存（实测停在 179 天前，且**跑 exe 也不更新**）。
 * native 的真实做法是**每次按需 spawn** `runtime-info.exe --account-stdin`。
 * 实测对照（第二个账号）：
 *   - 磁盘缓存（`f677427e14…`）→ `claimable:false`，仅 1 条 `VIEW_DETAILS`
 *   - 实时生成（`15e6683914…`）→ `claimable:true`，含 `CLAIM_BENEFIT/CLAIMABLE/100`
 *
 * ⚠️ 本文件**不得真的 spawn 开发机上的 `runtime-info.exe`**：那会让用例
 * 每次都花约 3.8 秒、且结果随「开发机是否装了 Qoder 桌面端」而变。
 * 故所有用例都把 `QODER_RUNTIME_INFO` 指向不存在或受控的路径。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetQoderMachineIdentityCache,
  resolveQoderMachineIdentity,
  resolveQoderMachineIdentityAsync,
  withQoderMachineHeaders,
  withQoderMachineHeadersAsync,
} from '../../src/qoder-machine.js'

/** 真实的 `machine_token.json` 形状（取自开发机，token 已截断）。 */
const REAL = { token: 'P1gAqPZCWUi74rLzCPRlKoCcii6MYvi3', type: 'f677427e14abd0f6c1', updateAt: 1774862945355 }

let dir: string
let file: string

beforeEach(() => {
  // 每次用独立临时目录，避免污染真实 %APPDATA% 且用例互不影响。
  dir = mkdtempSync(join(tmpdir(), 'qoder-mach-'))
  file = join(dir, 'machine_token.json')
  process.env.QODER_MACHINE_TOKEN_PATH = file
  // ⚠️ 关键：把可执行文件指到不存在的路径，强制走「磁盘缓存」退路，
  // 从而不真的 spawn（既快，又不受开发机是否装了桌面端影响）。
  process.env.QODER_RUNTIME_INFO = join(dir, 'no-such-runtime-info')
  resetQoderMachineIdentityCache()
})

afterEach(() => {
  delete process.env.QODER_MACHINE_TOKEN_PATH
  delete process.env.QODER_RUNTIME_INFO
  resetQoderMachineIdentityCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('Qoder 设备身份解析', () => {
  it('无实时可执行文件时退回磁盘缓存（token + type）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  /**
   * ⚠️ **必须成对**：只有 token 或只有 type 时一律视为「拿不到」。
   *
   * 实测依据（同一账号、同一 token、只改请求头）：只加 Token 或只加 Type
   * 服务端都仍只回 1 条 `VIEW_DETAILS`；两者都加才回
   * `CLAIM_BENEFIT/CLAIMABLE/100`。故发一半毫无意义，宁可整体不发。
   */
  it('只有 token 或只有 type 时视为拿不到（不可发一半）', () => {
    writeFileSync(file, JSON.stringify({ token: REAL.token }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify({ type: REAL.type }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    // 空串同样视为缺失（不能让空头出现在请求里）
    writeFileSync(file, JSON.stringify({ token: '', type: REAL.type }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
  })

  it('文件缺失 / JSON 损坏 / 形状非法 → undefined 且不抛错', () => {
    // 文件不存在
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, 'not json')
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify(['array']))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()

    writeFileSync(file, JSON.stringify({ token: 123, type: 456 }))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
  })

  it('缓存生效：首次读取后删除文件仍可解析（避免每请求 IO）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
    rmSync(file, { force: true })
    // 未清缓存 → 仍返回上次结果
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  it('「拿不到」也被缓存（不反复读盘）', () => {
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    // 缓存后再写入文件也不影响本次进程的结果，直到显式重置
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toBeUndefined()
    resetQoderMachineIdentityCache()
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  it('异步版语义与同步版一致（同一个退路）', async () => {
    writeFileSync(file, JSON.stringify(REAL))
    await expect(resolveQoderMachineIdentityAsync()).resolves.toEqual({ token: REAL.token, type: REAL.type })
  })

  it('异步版拿不到时返回 undefined（不抛错）', async () => {
    await expect(resolveQoderMachineIdentityAsync()).resolves.toBeUndefined()
  })
})

describe('withQoderMachineHeaders', () => {
  it('拿得到身份时并入两个头（成对）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    const headers = withQoderMachineHeaders({ Accept: 'application/json', 'Cosy-ClientType': '10' })
    expect(headers['Cosy-MachineToken']).toBe(REAL.token)
    expect(headers['Cosy-MachineType']).toBe(REAL.type)
    // 原头必须保留
    expect(headers['Cosy-ClientType']).toBe('10')
    expect(headers.Accept).toBe('application/json')
  })

  /**
   * ⚠️ **保守降级**：拿不到身份时**原样返回**，不写空串头。
   *
   * 理由：纯插件登录（未装 Qoder 桌面端）的用户本机没有 exe 也没有该文件，
   * 此时不能让积分功能整体失败；发空头反而可能被服务端按非法设备处理。
   */
  it('拿不到身份时原样返回（不写空头，保持修复前行为）', () => {
    const input = { Accept: 'application/json', 'Cosy-ClientType': '10' }
    const headers = withQoderMachineHeaders(input)
    expect(headers).toEqual(input)
    expect(headers).not.toHaveProperty('Cosy-MachineToken')
    expect(headers).not.toHaveProperty('Cosy-MachineType')
  })

  it('异步版同样并入两个头', async () => {
    writeFileSync(file, JSON.stringify(REAL))
    const headers = await withQoderMachineHeadersAsync({ 'Cosy-ClientType': '10' })
    expect(headers['Cosy-MachineToken']).toBe(REAL.token)
    expect(headers['Cosy-MachineType']).toBe(REAL.type)
  })

  it('异步版拿不到身份时原样返回', async () => {
    const input = { 'Cosy-ClientType': '10' }
    await expect(withQoderMachineHeadersAsync(input)).resolves.toEqual(input)
  })
})
