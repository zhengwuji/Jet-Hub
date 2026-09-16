/**
 * Antigravity 凭据复用模块的单元测试。
 *
 * 覆盖重点（不依赖本机是否装有 Antigravity）：
 * - protobuf 解析链路的每一层（顶层 sentinel → payload 解包 → token 字段）
 * - 登录状态判定（signedIn / 其它状态 / 缺失）
 * - 目录探测与容错（库不存在、库为空、结构变化都返回 undefined 而不抛错）
 * - 续期请求的构造与错误处理
 *
 * 真实凭据的端到端验证在 tests/e2e（有闸门）与 .probe 手测中完成，
 * 单测一律使用构造的 fixture，保证 CI 无网络、无外部依赖。
 */

import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  antigravityUserDirs,
  findStateDbPath,
  isAntigravityCredentialExpired,
  refreshAntigravityToken,
  readAntigravityCredential,
  AUTH_STATE_SENTINEL,
  OAUTH_TOKEN_KEY,
  OAUTH_TOKEN_SENTINEL,
  PROFILE_URL_KEY,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  GOOGLE_TOKEN_ENDPOINT,
  CLOUD_CODE_BASE,
} from '../../src/antigravity.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'

/* ─────────────────────── protobuf 构造工具 ─────────────────────── */

/** 编码 varint。 */
function varint(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

/** 编码一个 length-delimited 字段。 */
function field(num: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload])
}

/** 构造一个 sentinel entry：f1 = key，f2 = payload。 */
function entry(key: string, payload: Buffer): Buffer {
  return field(1, Buffer.concat([
    field(1, Buffer.from(key, 'utf8')),
    field(2, payload),
  ]))
}

/** 构造完整的顶层 token blob（base64 前的字节）。 */
function buildTokenBlob(options: {
  state?: string
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  omitTokenEntry?: boolean
}): string {
  const state = options.state ?? 'signedIn'
  const stateJson = JSON.stringify({ state, context: { project: '' } })
  // entry 1: payload 是 protobuf(f1 = JSON 文本)
  const stateEntry = entry(AUTH_STATE_SENTINEL, field(1, Buffer.from(stateJson, 'utf8')))

  const parts = [stateEntry]
  if (options.omitTokenEntry !== true) {
    const access = options.accessToken ?? 'ya29.test-access-token-value'
    const refresh = options.refreshToken ?? '1//test-refresh-token-value'
    const type = options.tokenType ?? 'Bearer'
    // token 内层 protobuf：f1=access, f2=type, f3=refresh
    const tokenProto = Buffer.concat([
      field(1, Buffer.from(access, 'utf8')),
      field(2, Buffer.from(type, 'utf8')),
      field(3, Buffer.from(refresh, 'utf8')),
    ])
    // payload = protobuf(f1 = 内层 base64 文本)
    const tokenEntry = entry(OAUTH_TOKEN_SENTINEL, field(1, Buffer.from(tokenProto.toString('base64'), 'utf8')))
    parts.push(tokenEntry)
  }
  return Buffer.concat(parts).toString('base64')
}

/* ─────────────────────── 临时状态库构造 ─────────────────────── */

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/**
 * 造一个含指定 key/value 的 state.vscdb。
 * @returns `User` 目录路径（用于指向 globalStorage）
 */
function makeStateDb(rows: Array<[string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), 'agy-test-'))
  tempDirs.push(root)
  const globalStorage = join(root, 'User', 'globalStorage')
  mkdirSync(globalStorage, { recursive: true })
  const dbPath = join(globalStorage, 'state.vscdb')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of rows) insert.run(key, value)
  db.close()
  return join(root, 'User')
}

/** 临时把 APPDATA 指向指定目录并运行回调，结束后恢复。 */
function withAppData<T>(userDirParent: string, fn: () => T): T {
  const previous = process.env.APPDATA
  process.env.APPDATA = userDirParent
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
  }
}

/** 造一个 APPDATA 下有 `Antigravity IDE\User` 的布局，返回 APPDATA 路径。 */
function makeAppData(rows: Array<[string, string]>, folder = 'Antigravity IDE'): string {
  const appData = mkdtempSync(join(tmpdir(), 'agy-appdata-'))
  tempDirs.push(appData)
  const globalStorage = join(appData, folder, 'User', 'globalStorage')
  mkdirSync(globalStorage, { recursive: true })
  const db = new DatabaseSync(join(globalStorage, 'state.vscdb'))
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of rows) insert.run(key, value)
  db.close()
  return appData
}

/* ─────────────────────── 测试 ─────────────────────── */

describe('antigravity 凭据读取', () => {
  it('解析完整凭据：access / refresh / token_type / profile_url', () => {
    const appData = makeAppData([
      [OAUTH_TOKEN_KEY, buildTokenBlob({})],
      [PROFILE_URL_KEY, 'https://lh3.googleusercontent.com/a/test-avatar'],
    ])
    const credential = withAppData(appData, readAntigravityCredential)
    expect(credential).toBeDefined()
    expect(credential?.access_token).toBe('ya29.test-access-token-value')
    expect(credential?.refresh_token).toBe('1//test-refresh-token-value')
    expect(credential?.token_type).toBe('Bearer')
    expect(credential?.profile_url).toBe('https://lh3.googleusercontent.com/a/test-avatar')
    expect(credential?.source).toContain('state.vscdb')
  })

  it('profile_url 缺失时不影响凭据读取', () => {
    const appData = makeAppData([[OAUTH_TOKEN_KEY, buildTokenBlob({})]])
    const credential = withAppData(appData, readAntigravityCredential)
    expect(credential?.access_token).toBe('ya29.test-access-token-value')
    expect(credential?.profile_url).toBeUndefined()
  })

  it('登录状态非 signedIn 时返回 undefined', () => {
    const appData = makeAppData([[OAUTH_TOKEN_KEY, buildTokenBlob({ state: 'signedOut' })]])
    expect(withAppData(appData, readAntigravityCredential)).toBeUndefined()
  })

  it('缺少 token entry 时返回 undefined', () => {
    const appData = makeAppData([[OAUTH_TOKEN_KEY, buildTokenBlob({ omitTokenEntry: true })]])
    expect(withAppData(appData, readAntigravityCredential)).toBeUndefined()
  })

  it('状态库中无该 key 时返回 undefined', () => {
    const appData = makeAppData([['unrelated.key', 'x']])
    expect(withAppData(appData, readAntigravityCredential)).toBeUndefined()
  })

  it('状态库文件不存在时返回 undefined（不抛错）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agy-empty-'))
    tempDirs.push(empty)
    expect(withAppData(empty, readAntigravityCredential)).toBeUndefined()
  })

  it('值被破坏（非 base64 protobuf）时返回 undefined（不抛错）', () => {
    const appData = makeAppData([[OAUTH_TOKEN_KEY, '!!!not-a-protobuf!!!']])
    expect(withAppData(appData, readAntigravityCredential)).toBeUndefined()
  })

  it('回退识别不带空格的 Antigravity 目录', () => {
    const appData = makeAppData([[OAUTH_TOKEN_KEY, buildTokenBlob({})]], 'Antigravity')
    const credential = withAppData(appData, readAntigravityCredential)
    expect(credential?.access_token).toBe('ya29.test-access-token-value')
  })

  it('优先使用带空格的 Antigravity IDE 目录', () => {
    const appData = makeAppData([], 'Antigravity')
    // 在 IDE 目录放真实凭据，在无空格目录留空
    const ideDir = join(appData, 'Antigravity IDE', 'User', 'globalStorage')
    mkdirSync(ideDir, { recursive: true })
    const db = new DatabaseSync(join(ideDir, 'state.vscdb'))
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(OAUTH_TOKEN_KEY, buildTokenBlob({ accessToken: 'ya29.from-ide-dir' }))
    db.close()
    expect(withAppData(appData, readAntigravityCredential)?.access_token).toBe('ya29.from-ide-dir')
  })

  it('token 字段顺序变化时仍按内容形态识别', () => {
    // 手工构造 f3 / f2 / f1 逆序的 token protobuf
    const tokenProto = Buffer.concat([
      field(3, Buffer.from('1//reordered-refresh', 'utf8')),
      field(2, Buffer.from('Bearer', 'utf8')),
      field(1, Buffer.from('ya29.reordered-access', 'utf8')),
    ])
    const blob = Buffer.concat([
      entry(AUTH_STATE_SENTINEL, field(1, Buffer.from(JSON.stringify({ state: 'signedIn' }), 'utf8'))),
      entry(OAUTH_TOKEN_SENTINEL, field(1, Buffer.from(tokenProto.toString('base64'), 'utf8'))),
    ]).toString('base64')
    const appData = makeAppData([[OAUTH_TOKEN_KEY, blob]])
    const credential = withAppData(appData, readAntigravityCredential)
    expect(credential?.access_token).toBe('ya29.reordered-access')
    expect(credential?.refresh_token).toBe('1//reordered-refresh')
  })
})

describe('antigravity 目录探测', () => {
  it('antigravityUserDirs 返回 Windows 下带空格目录优先', () => {
    const previous = process.env.APPDATA
    process.env.APPDATA = 'C:\\fake\\AppData\\Roaming'
    try {
      const dirs = antigravityUserDirs()
      expect(dirs[0]).toBe(join('C:\\fake\\AppData\\Roaming', 'Antigravity IDE', 'User'))
      expect(dirs[1]).toBe(join('C:\\fake\\AppData\\Roaming', 'Antigravity', 'User'))
    } finally {
      if (previous === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previous
    }
  })

  it('findStateDbPath 在无安装时返回 undefined', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agy-none-'))
    tempDirs.push(empty)
    expect(withAppData(empty, findStateDbPath)).toBeUndefined()
  })

  it('findStateDbPath 找到实际存在的库', () => {
    const appData = makeAppData([['k', 'v']])
    const found = withAppData(appData, findStateDbPath)
    expect(found).toContain('state.vscdb')
  })
})

describe('antigravity 凭据过期判定', () => {
  it('永不本地判定过期（由服务端 401 驱动）', () => {
    expect(isAntigravityCredentialExpired({
      access_token: 'ya29.x', refresh_token: '1//y', token_type: 'Bearer',
    })).toBe(false)
  })
})

describe('antigravity token 续期', () => {
  it('构造正确的官方客户端续期请求', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        access_token: 'ya29.refreshed', expires_in: 3599,
        scope: 'scope-a scope-b', token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await refreshAntigravityToken('1//my-refresh', fetcher)
    expect(result.access_token).toBe('ya29.refreshed')
    expect(result.expires_in).toBe(3599)
    expect(capturedUrl).toBe(GOOGLE_TOKEN_ENDPOINT)

    const params = new URLSearchParams(capturedBody)
    expect(params.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID)
    expect(params.get('client_secret')).toBe(ANTIGRAVITY_CLIENT_SECRET)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('1//my-refresh')
  })

  it('无 refresh_token 时直接报错，不发请求', async () => {
    let called = false
    const fetcher = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    await expect(refreshAntigravityToken('', fetcher)).rejects.toThrow(/无 refresh_token/)
    expect(called).toBe(false)
  })

  it('续期失败时抛出带服务端原因的 AUTH 错误', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Token has been expired or revoked.',
    }), { status: 400 })) as unknown as typeof fetch
    await expect(refreshAntigravityToken('1//dead', fetcher))
      .rejects.toThrow(/invalid_grant.*expired or revoked/s)
  })

  it('响应缺少 access_token 时报错', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ expires_in: 100 }), { status: 200 })) as unknown as typeof fetch
    await expect(refreshAntigravityToken('1//x', fetcher)).rejects.toThrow(/缺少 access_token/)
  })
})

describe('antigravity 常量', () => {
  it('端点为 Cloud Code 官方地址', () => {
    expect(CLOUD_CODE_BASE).toBe('https://cloudcode-pa.googleapis.com')
  })

  it('客户端凭据为官方提取值', () => {
    expect(ANTIGRAVITY_CLIENT_ID).toContain('.apps.googleusercontent.com')
    expect(ANTIGRAVITY_CLIENT_SECRET).toMatch(/^GOCSPX-/)
  })
})

/* ─────────── 适配器：拒绝诊断与限速闸门回归测试 ─────────── */

describe('AntigravityAdapter 错误诊断', () => {
  /** 造一个直接返回指定状态的假凭据读取器。 */
  const credential = {
    access_token: 'ya29.fake-token',
    refresh_token: '1//fake-refresh',
    token_type: 'Bearer',
  }

  /** 收完整个流并返回抛出的错误（无错误时返回 undefined）。 */
  async function drainForError(adapter: AntigravityAdapter): Promise<unknown> {
    try {
      for await (const _chunk of adapter.stream({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        void _chunk
      }
      return undefined
    } catch (error) {
      return error
    }
  }

  function makeAdapter(response: Response, refresh?: (t: string) => Promise<string>) {
    const fetcher = (async () => response) as unknown as typeof fetch
    return new AntigravityAdapter({
      readCredential: () => credential,
      fetchImpl: fetcher,
      ...refresh !== undefined ? { refresh } : {},
    })
  }

  it('403 + SUBSCRIPTION_REQUIRED → 给出账号订阅诊断，且不尝试续期', async () => {
    let refreshCalls = 0
    const adapter = makeAdapter(new Response(JSON.stringify({
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'no valid license' },
      details: [{ reason: 'SUBSCRIPTION_REQUIRED' }],
    }), { status: 403 }), async () => { refreshCalls += 1; return 'ya29.new' })

    const error = await drainForError(adapter)
    expect((error as { code?: string })?.code).toBe('AUTH')
    expect((error as Error)?.message).toContain('订阅')
    expect((error as Error)?.message).toContain('SUBSCRIPTION_REQUIRED')
    // 关键：403 已能判定原因时**不应**再打一次 token 请求
    expect(refreshCalls).toBe(0)
  })

  it('400 + RESOURCE_PROJECT_INVALID → 提示缺少 GCP project', async () => {
    const adapter = makeAdapter(new Response(JSON.stringify({
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid resource field value' },
      details: [{ reason: 'RESOURCE_PROJECT_INVALID' }],
    }), { status: 400 }))

    const error = await drainForError(adapter)
    expect((error as Error)?.message).toContain('project')
  })

  it('403 + ACCESS_TOKEN_SCOPE_INSUFFICIENT → 提示 scope 不足', async () => {
    const adapter = makeAdapter(new Response(JSON.stringify({
      error: { code: 403, status: 'PERMISSION_DENIED' },
      details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
    }), { status: 403 }))

    const error = await drainForError(adapter)
    expect((error as Error)?.message).toContain('scope')
  })

  it('401 → 触发一次续期后重试', async () => {
    let calls = 0
    let refreshCalls = 0
    const fetcher = (async () => {
      calls += 1
      // 第一次 401，续期后第二次仍 403（模拟真实链路）
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } }), { status: 401 })
        : new Response(JSON.stringify({
            error: { code: 403, status: 'PERMISSION_DENIED' },
            details: [{ reason: 'SUBSCRIPTION_REQUIRED' }],
          }), { status: 403 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityAdapter({
      readCredential: () => credential,
      fetchImpl: fetcher,
      refresh: async () => { refreshCalls += 1; return 'ya29.refreshed' },
    })

    const error = await drainForError(adapter)
    expect(refreshCalls).toBe(1)
    expect(calls).toBe(2)
    expect((error as Error)?.message).toContain('订阅')
  })

  it('401 且未配置 refresh → 提示去 IDE 确认登录，不静默失败', async () => {
    const adapter = makeAdapter(new Response(JSON.stringify({
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'invalid authentication credentials' },
    }), { status: 401 }))

    const error = await drainForError(adapter)
    expect((error as { code?: string })?.code).toBe('AUTH')
    expect((error as Error)?.message).toContain('Antigravity')
  })

  it('限速闸门在无其他 pending 工作时仍能完成（unref 回归）', async () => {
    // 回归：sleep 若使用 .unref()，这里会永久挂起而不是正常返回。
    // 用两次连续调用触发限速等待（MIN_REQUEST_GAP_MS = 1000ms）。
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        error: { code: 400, status: 'INVALID_ARGUMENT' },
      }), { status: 400 })
    }) as unknown as typeof fetch

    const adapter = new AntigravityAdapter({
      readCredential: () => credential,
      fetchImpl: fetcher,
    })

    const started = Date.now()
    await drainForError(adapter)
    await drainForError(adapter)
    const elapsed = Date.now() - started

    expect(calls).toBe(2)
    // 第二次调用必须真的等了限速窗口，而不是被 unref 掉直接跳过/挂起
    expect(elapsed).toBeGreaterThanOrEqual(900)
  }, 15_000)
})
