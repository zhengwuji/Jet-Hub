/**
 * Qoder 设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）回归用例。
 *
 * 这些用例锁定 2026-09-25 定位的**真实缺陷**：
 * 「没领过却显示今日已领取」的根因之一，是配额/活动请求**缺少成对的
 * machine 头**，服务端因此不下发 `CLAIM_BENEFIT/CLAIMABLE` 的活动。
 *
 * 实证来源：用户提供的 `qoder积分.pcapng`（配 `SSLKEYLOGFILE` 解密）
 * 显示 native 请求带完整 machine 头族；逐项消融实验确认
 * **`MachineToken` 与 `MachineType` 必须成对**（缺一即失效）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetQoderMachineIdentityCache,
  resolveQoderMachineIdentity,
  withQoderMachineHeaders,
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
  resetQoderMachineIdentityCache()
})

afterEach(() => {
  delete process.env.QODER_MACHINE_TOKEN_PATH
  resetQoderMachineIdentityCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('Qoder 设备身份解析', () => {
  it('读取 token + type（真实文件形状）', () => {
    writeFileSync(file, JSON.stringify(REAL))
    expect(resolveQoderMachineIdentity()).toEqual({ token: REAL.token, type: REAL.type })
  })

  /**
   * ⚠️ **必须成对**：只有 token 或只有 type 时一律视为「拿不到」。
   *
   * 实测依据（同一账号、同一 token、只改请求头）：
   * - 只加 `Cosy-MachineToken` → 服务端仍只回 1 条 `VIEW_DETAILS`（无可领项）
   * - 只加 `Cosy-MachineType`  → 同上
   * - 两者都加                → 2 条，含 `CLAIM_BENEFIT/CLAIMABLE/100`
   *
   * 故发一半毫无意义，还可能让服务端按非法设备处理；宁可整体不发。
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
   * 理由：纯插件登录（未装 Qoder 桌面端）的用户本机没有该文件，
   * 此时不能让积分功能整体失败；发空头反而可能被服务端按非法设备处理。
   * 修复前的行为就是不带这两个头，故此处只是回到原状。
   */
  it('拿不到身份时原样返回（不写空头，保持修复前行为）', () => {
    const input = { Accept: 'application/json', 'Cosy-ClientType': '10' }
    const headers = withQoderMachineHeaders(input)
    expect(headers).toEqual(input)
    expect(headers).not.toHaveProperty('Cosy-MachineToken')
    expect(headers).not.toHaveProperty('Cosy-MachineType')
  })
})
