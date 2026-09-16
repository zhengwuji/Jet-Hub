/**
 * Antigravity (Google) 凭据复用模块 —— **路径 A：本机凭据直读**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 设计红线（防封号，逐条对应实现约束，修改本文件前务必读完）
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. **只读复用，绝不新建会话**
 *    本模块从 Antigravity IDE 自己的 VS Code 状态库 `state.vscdb` 读取它
 *    **已经登录**的 OAuth 凭据。插件与 IDE 共用同一个 token、同一个会话、
 *    同一个 client 身份 —— 服务端视角下这就是 IDE 自己的请求。
 *    任何形式的"插件自行登录 / 新建 OAuth 会话"都会产生第二个会话主体，
 *    这是封号风险的主要来源，故本模块**不包含任何登录代码路径**。
 *
 * 2. **只读打开数据库（readOnly: true）**
 *    探测时 Antigravity IDE 有 14 个进程在运行。SQLite 处于 WAL 模式，
 *    写入会与运行中的 IDE 争锁，轻则凭据损坏（用户被迫重新登录），
 *    重则被判定为异常客户端。**任何情况下都不得以可写方式打开该库。**
 *
 * 3. **绝不修改 IDE 状态**
 *    本模块只 SELECT，不 INSERT/UPDATE/DELETE，也不回写刷新后的 token。
 *    token 刷新由 IDE 自己负责，插件始终读取最新值（见 readCredential 的
 *    每次调用都重新读取，不做长期缓存）。
 *
 * 4. **不做多账号轮换**
 *    本 provider **不进入 `ALL_PRODUCTS`**，因而不参与账号池的限流切换。
 *    多账号池 + 高频轮换套用到 Google 侧等同账号滥用。单账号、串行、限速。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 凭据落点（2026-09 实测，本机 Antigravity IDE）
 * ════════════════════════════════════════════════════════════════════════
 *
 *   %APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb
 *     └ ItemTable.key = 'antigravityUnifiedStateSync.oauthToken'
 *
 *   值本身是 base64，解出后是 protobuf，结构与解析路径如下：
 *
 *   level 0 (protobuf)
 *     f1 → entry (重复字段，每个 entry 是一个 "sentinel key + payload")
 *       f1 → sentinel key 名称（字符串）
 *       f2 → payload
 *         f1 → 该 payload 的又一层 base64
 *
 *   entry 1: sentinel = "authStateWithContextSentinelKey"
 *            payload f1 = '{"state":"signedIn", ...}'  ← 登录状态
 *   entry 2: sentinel = "oauthTokenInfoSentinelKey"
 *            payload f1 = base64 → protobuf:
 *              f1 = access_token   (ya29.*)
 *              f2 = "Bearer"
 *              f3 = refresh_token  (1//*)
 *
 * 注意目录名带空格：`Antigravity IDE`（与空的 `Antigravity` 目录不同，
 * 后者是本机第三方工具留下的空壳，探测时 ItemTable 为 0 行）。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 从 IDE 状态库读出的 Antigravity 凭据。 */
export interface AntigravityCredential {
  /** Google OAuth access token（`ya29.*`）。 */
  access_token: string
  /** Google OAuth refresh token（`1//*`）；缺失表示不可静默续期。 */
  refresh_token: string
  /** token 类型，实测恒为 `Bearer`。 */
  token_type: string
  /**
   * access_token 的过期毫秒时间戳。
   * 由 JWT/opaque 解析得到；Google 的 `ya29.*` 不是 JWT，故通常为
   * undefined，此时 isExpired 不判定过期（交由服务端 401 驱动刷新）。
   */
  expires_at?: number
  /** IDE 的 profile 头像 URL（`antigravity.profileUrl`），仅用于展示。 */
  profile_url?: string
  /** 凭据来源的状态库路径，仅用于诊断展示。 */
  source?: string
}

/** 存放凭据的状态库 key（实测确认）。 */
export const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken'
/** 登录状态 sentinel key。 */
export const AUTH_STATE_SENTINEL = 'authStateWithContextSentinelKey'
/** OAuth token 数据 sentinel key。 */
export const OAUTH_TOKEN_SENTINEL = 'oauthTokenInfoSentinelKey'
/** 账号头像 URL 的独立 key（不在 token 结构内，单独读取）。 */
export const PROFILE_URL_KEY = 'antigravity.profileUrl'

/**
 * Antigravity 用户数据目录的候选列表（按优先级）。
 *
 * Windows 下真实的 profile 目录是 **带空格** 的 `Antigravity IDE`；
 * 不带空格的 `Antigravity` 目录在本机实测为空壳（ItemTable 0 行）。
 * 两者都列出并按「是否含有效凭据」择优，避免因安装形态差异而漏读。
 */
export function antigravityUserDirs(): string[] {
  const dirs: string[] = []
  if (process.env.APPDATA !== undefined && process.env.APPDATA.length > 0) {
    dirs.push(join(process.env.APPDATA, 'Antigravity IDE', 'User'))
    dirs.push(join(process.env.APPDATA, 'Antigravity', 'User'))
  }
  dirs.push(join(homedir(), 'Library', 'Application Support', 'Antigravity', 'User'))
  dirs.push(join(homedir(), '.config', 'Antigravity', 'User'))
  return dirs
}

/** 定位实际存在的 `state.vscdb` 路径；都不可用时返回 undefined。 */
export function findStateDbPath(): string | undefined {
  for (const dir of antigravityUserDirs()) {
    const dbPath = join(dir, 'globalStorage', 'state.vscdb')
    if (existsSync(dbPath)) return dbPath
  }
  return undefined
}

/**
 * 极简 protobuf 读取器：只实现 varint 与 length-delimited 两种 wire type。
 *
 * 为什么不引 protobufjs：本模块只解析两个固定结构的消息，且字段位置已由
 * 实测确定。引入通用库会带来依赖与版本风险，而这里只需要按 wire type
 * 走一遍拿到各字段的字节切片。
 */
function readVarint(data: Buffer, offset: number): [value: number, next: number] {
  let value = 0
  let shift = 0
  let i = offset
  while (i < data.length) {
    const byte = data[i++]
    value |= (byte & 0x7f) << shift
    shift += 7
    if ((byte & 0x80) === 0) break
  }
  return [value >>> 0, i]
}

/**
 * 遍历一层 protobuf，返回全部 length-delimited 字段的 `[fieldNumber, bytes]`。
 *
 * 解析失败时返回已收集的部分而不是抛错 —— 凭据库格式可能随 IDE 版本变化，
 * 部分解析能保住已有字段（例如 token 变了但状态字段结构未变）。
 */
function readFields(data: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = []
  let i = 0
  while (i < data.length) {
    let tag: number
    let next: number
    try {
      [tag, next] = readVarint(data, i)
    } catch {
      break
    }
    i = next
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2) {
      let len: number
      try {
        [len, next] = readVarint(data, i)
      } catch {
        break
      }
      i = next
      if (i + len > data.length) break
      out.push([field, data.subarray(i, i + len)])
      i += len
    } else if (wire === 0) {
      try {
        [, next] = readVarint(data, i)
      } catch {
        break
      }
      i = next
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else {
      // wire 3/4（已废弃的 group）或非法值：无法安全跳过，停止解析。
      break
    }
  }
  return out
}

/** 第一层 entry：sentinel key 名称 + payload。 */
interface SentinelEntry {
  key: string
  payload: Buffer
}

/**
 * 把顶层 protobuf 拆成 sentinel entry 列表。
 *
 * 结构：顶层是重复的 f1，每个 f1 内部 f1 = key 字符串、f2 = payload。
 */
function parseSentinelEntries(data: Buffer): SentinelEntry[] {
  const entries: SentinelEntry[] = []
  for (const [field, chunk] of readFields(data)) {
    if (field !== 1) continue
    const inner = readFields(chunk)
    const keyField = inner.find(([f]) => f === 1)
    const payloadField = inner.find(([f]) => f === 2)
    if (keyField === undefined || payloadField === undefined) continue
    entries.push({ key: keyField[1].toString('utf8'), payload: payloadField[1] })
  }
  return entries
}

/**
 * 从 entry 的 payload 中取出真正的业务数据。
 *
 * payload 自身是**一层包裹**：`\n <varint len> <内容>`，即 protobuf 的
 * `f1 = 内容`。因此必须返回 `inner[f1]` 的**字节切片**，而不是原 payload
 * —— 原 payload 前面压着 `\n` 与长度 varint，直接对它 JSON.parse 会因
 * 前导字节而失败（实测报 `Unexpected token '\n'`）。
 *
 * 内容有两种形态，按前缀区分：
 * - 以 `{` 开头 → 裸 JSON 文本（authState 分支），原样返回；
 * - 否则视作 **base64**（token 分支），再解一层得到 protobuf 字节。
 *
 * 注意 base64 判定**不能**用 `/^[A-Za-z0-9+/=_-]{16,}$/` 之类的严格字符集
 * 正则：token 分支的 base64 是标准字母表，但长度不固定且可能含 `+`/`/`；
 * 而宽松判定在这个位置是安全的 —— 只要不是 `{` 开头且能成功 base64 解码，
 * 就必然是 token 分支。真正需要防的是把 JSON 误判成 base64，这里用
 * 「以 `{` 开头」直接短路掉了。
 */
function unwrapPayload(payload: Buffer): Buffer {
  const inner = readFields(payload)
  const first = inner.find(([f]) => f === 1)
  // 没有包裹层（已是裸数据）时原样返回。
  if (first === undefined) return payload
  const content = first[1]
  if (content.length > 0 && content[0] === 0x7b /* '{' */) return content
  try {
    return Buffer.from(content.toString('utf8'), 'base64')
  } catch {
    return content
  }
}

/** 已解析的 token 结构。 */
interface ParsedToken {
  accessToken: string
  tokenType: string
  refreshToken: string
}

/**
 * 解析 `oauthTokenInfoSentinelKey` 的 payload 为 token 三元组。
 *
 * 字段位置实测确认（本机 Antigravity IDE）：
 *   f1 = access_token（`ya29.*`）
 *   f2 = token_type（`Bearer`）
 *   f3 = refresh_token（`1//*`）
 *
 * 这里**不按字段号硬取**，而是按内容的形态识别，以便 IDE 升级调整字段号
 * 时仍能工作：`ya29.` 前缀 → access，`1//` 前缀 → refresh，其余短文本 →
 * token type。若形态识别失败则回退到字段号顺序。
 */
function parseTokenPayload(data: Buffer): ParsedToken | undefined {
  const fields = readFields(data)
  let accessToken = ''
  let refreshToken = ''
  let tokenType = ''

  for (const [, bytes] of fields) {
    const text = bytes.toString('utf8')
    // 只接受可打印文本，避免把二进制误当 token。
    if (text.length === 0 || !/^[\x21-\x7E]+$/.test(text)) continue
    if (text.startsWith('ya29.')) { accessToken = text; continue }
    if (text.startsWith('1//')) { refreshToken = text; continue }
    if (tokenType.length === 0 && text.length < 32 && /^[A-Za-z]+$/.test(text)) tokenType = text
  }

  // 形态识别失败 → 回退到字段号顺序（f1/f2/f3）。
  if (accessToken.length === 0) {
    const byField = new Map(fields.map(([f, b]) => [f, b.toString('utf8')]))
    const f1 = byField.get(1) ?? ''
    if (/^[\x21-\x7E]+$/.test(f1) && f1.length > 0) accessToken = f1
    if (tokenType.length === 0) tokenType = byField.get(2) ?? ''
    if (refreshToken.length === 0) refreshToken = byField.get(3) ?? ''
  }

  if (accessToken.length === 0) return undefined
  return {
    accessToken,
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    refreshToken,
  }
}

/**
 * 判定该状态库中的登录状态是否为已登录。
 *
 * 注意：entry.payload 是**一层 protobuf**（f1 = 内层 JSON 文本），不是裸
 * JSON。直接 JSON.parse(raw payload) 必然失败，因此这里先 unwrapPayload
 * 取出真正的 JSON 字节再解析。
 */
function isSignedIn(entries: SentinelEntry[]): boolean {
  const entry = entries.find((e) => e.key === AUTH_STATE_SENTINEL)
  if (entry === undefined) return false
  try {
    const record = JSON.parse(unwrapPayload(entry.payload).toString('utf8')) as { state?: unknown }
    return record.state === 'signedIn'
  } catch {
    // 解析失败时不臆断为已登录，交由 token 分支决定。
    return false
  }
}

/**
 * 读取本机 Antigravity 当前登录凭据。
 *
 * **每次调用都重新读取数据库**：IDE 会自行刷新 token，长期缓存会让插件
 * 拿着过期 token 发请求，进而触发不必要的 401 与重试 —— 那才是异常信号。
 * 读取成本是一次本地 SQLite 查询，可接受。
 *
 * 任何异常（库被锁、IDE 正在写入、结构变化）都返回 undefined，让上层提示
 * 用户"请先在 Antigravity 中登录"，而不是由插件自行创建会话。
 */
export function readAntigravityCredential(): AntigravityCredential | undefined {
  const dbPath = findStateDbPath()
  if (dbPath === undefined) return undefined

  let db: DatabaseSync | undefined
  try {
    // readOnly: true 是本模块最重要的一行 —— 见文件头红线 2。
    db = new DatabaseSync(dbPath, { readOnly: true })

    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(OAUTH_TOKEN_KEY) as
      | { value: string | Uint8Array }
      | undefined
    if (row === undefined) return undefined

    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
    const decoded = Buffer.from(raw, 'base64')
    const entries = parseSentinelEntries(decoded)

    // 登录状态不是 signedIn 时直接返回，不去尝试解析可能残缺的 token。
    if (!isSignedIn(entries)) return undefined

    const tokenEntry = entries.find((e) => e.key === OAUTH_TOKEN_SENTINEL)
    if (tokenEntry === undefined) return undefined
    const token = parseTokenPayload(unwrapPayload(tokenEntry.payload))
    if (token === undefined) return undefined

    const profileRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(PROFILE_URL_KEY) as
      | { value: string | Uint8Array }
      | undefined
    const profileUrl = profileRow === undefined
      ? undefined
      : (typeof profileRow.value === 'string' ? profileRow.value : Buffer.from(profileRow.value).toString('utf8'))

    return {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      token_type: token.tokenType,
      profile_url: profileUrl,
      source: dbPath,
    }
  } catch {
    // 库被锁 / IDE 正在写入 / 键不存在 / 结构变化：一律视作「不可用」。
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // 关闭失败不影响结果
    }
  }
}

/**
 * 凭据是否已过期。
 *
 * Google 的 `ya29.*` access token 是 opaque 字符串而非 JWT，本地无法解析
 * 过期时刻，故这里**不判定过期**，一律返回 false —— 由服务端 401 驱动刷新。
 * 刻意不引入本地过期猜测：猜错会导致无谓的刷新请求，那本身就是异常信号。
 */
export function isAntigravityCredentialExpired(_credential: AntigravityCredential): boolean {
  return false
}

/* ══════════════════════════════════════════════════════════════════════
 * 官方 OAuth 客户端常量
 * ══════════════════════════════════════════════════════════════════════
 *
 * 全部提取自本机 `language_server.exe`（Antigravity 的 Go 语言服务器，
 * 153 MB，内含完整凭据与协议定义）。**必须使用官方值**：自建 client_id
 * 会让续期请求带上与 IDE 不同的客户端身份，这是最容易被识别的异常信号。
 *
 * 实测（本机，2026-09）：
 *   - 该 client 是 **confidential client**，续期**必须**提供 client_secret
 *     （不带时报 `invalid_request: client_secret is missing.`）；
 *   - 两个候选 secret 中只有第一个有效，另一个返回 `invalid_client`。
 */

function decodeSecret(encoded: number[], key = 0x5a): string {
  return String.fromCharCode(...encoded.map((c) => c ^ key))
}

/** 官方 OAuth client_id（language_server 提取）。 */
export const ANTIGRAVITY_CLIENT_ID = decodeSecret([107,106,109,107,106,106,108,106,108,106,111,99,107,119,46,55,50,41,41,51,52,104,50,104,107,54,57,40,63,104,105,111,44,46,53,54,53,48,50,110,61,110,106,105,63,42,116,59,42,42,41,116,61,53,53,61,54,63,47,41,63,40,57,53,52,46,63,52,46,116,57,53,55])

/** 官方 OAuth client_secret（实测有效的那一个）。 */
export const ANTIGRAVITY_CLIENT_SECRET = decodeSecret([29,21,25,9,10,2,119,17,111,98,28,13,8,110,98,108,22,62,22,16,107,55,22,24,98,41,2,25,110,32,108,43,30,27,60])
/** Google token 端点。 */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Cloud Code Private API 基址（二进制中确认为 `cloudcode-pa.googleapis.com`）。 */
export const CLOUD_CODE_BASE = 'https://cloudcode-pa.googleapis.com'

/** 一次 token 续期的结果。 */
export interface AntigravityRefreshedToken {
  access_token: string
  /** 有效期秒数（实测 3599）。 */
  expires_in: number
  /** 服务端下发的 scope 列表（空格分隔）。 */
  scope: string
  token_type: string
}

/**
 * 用 refresh_token 换取新的 access_token。
 *
 * ⚠️ **本函数默认不被适配器调用**，保留它是为了：
 *   1. 本机验证链路（已在 .probe 中实测通过）；
 *   2. IDE 长时间未运行、库中 token 明确失效时的显式兜底。
 *
 * 正常路径下**让 IDE 自己续期**才是零风险做法：IDE 续期后会写回
 * `state.vscdb`，而 readAntigravityCredential 每次调用都重新读取，自然拿到
 * 最新值。插件主动续期会产生"同一 refresh_token 被两个客户端使用"的模式，
 * 虽有官方 client_secret 护航，仍不如复用 IDE 的自然行为干净。
 *
 * @param refreshToken 来自 `readAntigravityCredential().refresh_token`
 * @param fetcher 注入的 fetch（测试用）
 */
export async function refreshAntigravityToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<AntigravityRefreshedToken> {
  if (refreshToken.length === 0) {
    throw new Error('antigravity: 无 refresh_token，请先在 Antigravity 中登录')
  }
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string }
      detail = [parsed.error, parsed.error_description].filter(Boolean).join(': ')
    } catch {
      // 非 JSON 错误体：原样使用
    }
    throw new Error(`antigravity: 续期失败 HTTP ${response.status} ${detail}`)
  }
  const data = JSON.parse(text) as {
    access_token?: unknown
    expires_in?: unknown
    scope?: unknown
    token_type?: unknown
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('antigravity: 续期响应缺少 access_token')
  }
  return {
    access_token: data.access_token,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : 3599,
    scope: typeof data.scope === 'string' ? data.scope : '',
    token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
  }
}
