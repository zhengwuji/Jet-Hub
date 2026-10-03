/**
 * CatPaw 会话注册表（`x-session-id` → conversationId 的进程内映射）。
 *
 * **内存数据结构：不读盘、不发网络请求。**
 *
 * ## 它解决什么问题
 *
 * CatPaw 上游是**有状态会话协议**：一轮对话由 `round`（提交消息）+ `turn`
 * （SSE 执行）+ 工具循环 + `event(completed)` 组成，全程围绕一个
 * `conversationId`。而 harness 看到的是无状态协议，每轮都提交完整历史 ——
 * 于是适配器必须自己记住：
 *
 * | 记住什么 | 回答什么问题 |
 * |---|---|
 * | `sessionId` → conversationId | 这次请求该复用哪个 conversation（还是新建） |
 * | 已同步消息的**指纹链** | 客户端历史里哪一段上游已经见过（增量从哪开始） |
 * | `modelType` | 模型换了没有（换了必须重建 conversation） |
 * | `accountId` / `uid` | 账号或用户换了没有（换了必须重建） |
 * | 待响应的 `toolCallId` | 这次请求是不是「工具续接」 |
 * | 在途占用 | 同 session 是否已有流式请求在跑 |
 *
 * 这些状态**只在进程内**：重启后注册表为空，客户端下一轮自然走「全新会话全量
 * round」，功能不受影响，只是那一轮多传一次历史。因此本模块没有持久化需求。
 *
 * ## 账号身份的两个维度
 *
 * 一个 conversationId 建在**上游账号上下文**里，续接要求上下文完全一致：
 *
 * | 维度 | 值 | 什么时候变 |
 * |---|---|---|
 * | `accountId` | 选路结果（空串 = 无账号身份） | 选到别的账号、账号被删/禁用 |
 * | `uid` | 本次请求**实际使用的凭证**里的用户标识 | 同一账号记录底下换了用户 |
 *
 * ⚠️ **空串是显式身份而不是通配**（空只匹配空）：把空串当通配会让真实账号建的
 * 记录在账号被删/禁用、请求回落到默认登录态（accountId 为空）之后仍被复用，
 * 续接到一个已经不存在的账号上下文里。
 *
 * ## ⚠️ LRU 用**单调序号**而不是毫秒时间戳
 *
 * 毫秒时间戳会在同一毫秒内登记的多条记录上**打平**，淘汰结果于是随 `Map` 的
 * 迭代顺序变（不确定）。单调序号让「淘汰哪一条」完全确定。
 *
 * ## ⚠️ `markInflight` 的「判断 + 登记」必须在同一次加锁里完成
 *
 * 否则两个并发请求会同时看到「没被占用」，双双续接到同一个 conversation 上，
 * 把上游的历史搅成两条并行分支。Node 是单线程且本函数**同步**（内部没有任何
 * `await`），因此天然满足这条约束 —— 但这正是**必须写成同步函数**的原因：
 * 一旦有人在里面加了 `await`，这个保证立刻失效。**不要**把本函数改成 async。
 */

/** 长会话（带 `sessionId` 的普通轮次）的存活时间：2 小时。 */
export const CATPAW_SESSION_TTL_MS = 2 * 60 * 60 * 1000

/**
 * **工具续接**会话的存活时间：10 分钟。
 *
 * 比长会话短得多，因为「工具结果」是**紧接着**执行完就要提交的东西：
 * 本地工具执行完立刻发下一条请求，中间不会有几分钟的空档。客户端超过 10 分钟
 * 没把工具结果交回来，说明这一轮已经放弃（用户打断并改问别的），继续保留那条
 * 待响应记录会让下一次请求误判成「工具续接」。
 */
export const CATPAW_TOOL_SESSION_TTL_MS = 10 * 60 * 1000

/**
 * 注册表容量上限。
 *
 * 每条记录 = conversationId + 指纹链（几十条消息的 64 字节摘要），200 条是
 * MB 量级，对桌面应用完全可接受。之所以要上限而不是无界：客户端每次都发一个
 * 新的 `sessionId` 时（某些工具型客户端），无界表会随请求数单调增长。
 */
export const CATPAW_MAX_SESSIONS = 200

/** 一条会话记录。 */
export interface CatpawSessionRecord {
  /** 上游 conversationId（本轮之后要复用的那个）。 */
  conversationId: string
  /**
   * 已同步消息的指纹链。
   *
   * 语义：**最后一条已提交给上游的消息**的指纹（增量定位只看最后一条，
   * 见 `locateIncrement`）。每轮结束后追加「本轮提交的消息 + 上游返回的消息」
   * 的指纹。
   */
  fingerprintChain: string[]
  /** 上游数字模型 ID。与当前请求不一致 → 记录失效重建。 */
  modelType: number
  /** 这条会话是**哪个账号**建的（空串 = 无账号身份，只匹配空）。 */
  accountId: string
  /** 建立这条会话时的**用户标识**（uid / loginName；空串只匹配空）。 */
  uid: string
  /** 待响应的工具调用 id（非空 ⇔ 这条会话在等工具结果）。 */
  pendingCallIds: string[]
  /**
   * 最后活动时的单调序号（LRU 淘汰用；值越小越久没被写）。
   *
   * 由注册表在登记时写入，调用方**不需要**自己维护它。
   */
  lastSequence: number
}

/** 内部表项（记录 + 过期判定所需的会话 id）。 */
interface Entry {
  record: CatpawSessionRecord
  /** 对应的客户端会话 id（空串 = 匿名工具会话，按 conversationId 索引）。 */
  sessionId: string
  /** 最后活动时刻（毫秒；TTL 用）。 */
  lastActiveAt: number
}

/** 进程级单例。 */
let sessions = new Map<string, Entry>()
/** 匿名工具会话（无 `sessionId`，按 conversationId 索引）。 */
let anonymousSessions = new Map<string, Entry>()
/** `toolCallId` → conversationId（工具续接的查找索引）。 */
let callIndex = new Map<string, string>()
/** 在途占用的客户端会话 id（权威来源）。 */
let inflight = new Set<string>()
/**
 * 占用时捕获的账号身份（`markInflight` 写、`releaseInflight` 清）。
 *
 * ⚠️ 为什么要**按占用捕获**而不是登记时现取：一条流式请求可能在「客户端换号」
 * 之后才收尾登记，那时现取会拿到**新**身份，把一条用旧凭证建立的会话标成新用户
 * 的 —— 那正是要防的串会话。
 */
let inflightIdentities = new Map<string, { accountId: string; uid: string }>()
/** 淘汰用的单调序号。 */
let sequence = 0

/** 清空全部状态（**仅供单测**：进程级单例需要用例间隔离）。 */
export function clearAll(): void {
  sessions = new Map()
  anonymousSessions = new Map()
  callIndex = new Map()
  inflight = new Set()
  inflightIdentities = new Map()
  sequence = 0
}

/** 记录一条会话（覆盖写）。 */
export function registerSession(sessionId: string, record: CatpawSessionRecord): void {
  const now = Date.now()
  sequence += 1
  // 身份落定：占用时捕获的优先（见 `inflightIdentities` 的说明）。
  const captured = sessionId.length > 0 ? inflightIdentities.get(sessionId) : undefined
  const settled: CatpawSessionRecord = {
    ...record,
    accountId: captured?.accountId ?? record.accountId,
    uid: captured?.uid ?? record.uid,
    lastSequence: sequence,
  }
  const entry: Entry = { record: settled, sessionId, lastActiveAt: now }
  if (sessionId.length === 0) {
    const previous = anonymousSessions.get(settled.conversationId)
    if (previous !== undefined) clearCallIndex(previous.record)
    anonymousSessions.set(settled.conversationId, entry)
    indexCalls(entry.record)
    return
  }
  const previous = sessions.get(sessionId)
  // 同 session 换写：旧记录的 call 索引先撤掉（`pendingCallIds` 可能变小了，
  // 留着旧 id 会让后续请求命中一个已经不存在的待响应集合）。
  if (previous !== undefined) clearCallIndex(previous.record)
  if (sessions.size >= CATPAW_MAX_SESSIONS && !sessions.has(sessionId)) {
    evictLeastRecentlyUsed()
  }
  sessions.set(sessionId, entry)
  indexCalls(entry.record)
}

/**
 * 取一条会话记录（**不做过期清理**）。
 *
 * 返回**副本**：调用方拿到后可以随便用，不会影响表内状态。过期判定交给调用方
 * （`Date.now() - lastActiveAt >= ttl`），因为「过期后该怎么办」是适配器的语义
 * （走全新会话），不是注册表能决定的。
 */
export function getSession(sessionId: string): CatpawSessionRecord | undefined {
  if (sessionId.length === 0) return undefined
  const entry = sessions.get(sessionId)
  if (entry === undefined) return undefined
  if (isExpired(entry)) {
    removeSession(sessionId)
    return undefined
  }
  return { ...entry.record, fingerprintChain: [...entry.record.fingerprintChain] }
}

/** 按 conversationId 取记录（排障与工具会话收尾用）。 */
export function getSessionByConversation(conversationId: string): CatpawSessionRecord | undefined {
  if (conversationId.length === 0) return undefined
  for (const entry of sessions.values()) {
    if (entry.record.conversationId === conversationId) {
      return { ...entry.record, fingerprintChain: [...entry.record.fingerprintChain] }
    }
  }
  const anonymous = anonymousSessions.get(conversationId)
  if (anonymous === undefined) return undefined
  return { ...anonymous.record, fingerprintChain: [...anonymous.record.fingerprintChain] }
}

/** 清掉一条会话（含 call 索引）。返回是否真的删掉了。 */
export function clearSession(sessionId: string): boolean {
  if (sessionId.length === 0) return false
  return removeSession(sessionId)
}

/**
 * 作废某账号名下的全部会话（账号切换 / 删除 / 禁用时调用）。
 *
 * `accountId` 为空 → 作废**无账号身份**的记录：空是显式身份，所以这条路径是
 * 「默认登录态换了用户」的清理口。
 *
 * @returns 作废的记录条数（供日志）。
 */
export function clearAccount(accountId: string): number {
  let count = 0
  for (const [sessionId, entry] of [...sessions.entries()]) {
    if (entry.record.accountId !== accountId) continue
    clearCallIndex(entry.record)
    sessions.delete(sessionId)
    count += 1
  }
  for (const [conversationId, entry] of [...anonymousSessions.entries()]) {
    if (entry.record.accountId !== accountId) continue
    clearCallIndex(entry.record)
    anonymousSessions.delete(conversationId)
    count += 1
  }
  return count
}

/**
 * 占用一个客户端会话（**判断与登记在同一次同步调用里完成**）。
 *
 * ⚠️ **这条约束是必须的，不是风格问题**：判断与登记若分成两步（先查后写），
 * 两个并发请求会同时看到「没被占用」，双双续接到同一个 conversation 上，把
 * 上游的历史搅成两条并行分支。Node 单线程 + 本函数**同步**（内部零 `await`）
 * 天然满足「同一次加锁」的语义 —— 但也正因为如此，**绝不要**把它改成 async。
 *
 * `sessionId` 为空串（客户端没给）时**不占用**、返回 true：无状态请求本来就不该
 * 受并发保护约束。
 *
 * @returns 是否成功占位（false = 同一 session 已有流式请求在跑，调用方必须改走
 *   独立 conversation：不读也不写会话映射）。
 */
export function markInflight(sessionId: string, identity: { accountId: string; uid: string }): boolean {
  if (sessionId.length === 0) return true
  if (inflight.has(sessionId)) return false
  inflight.add(sessionId)
  // 占用时捕获身份（见 `inflightIdentities` 的说明）。已占用时**不覆盖**捕获值：
  // 先到的那个请求才是这条会话的建立者。
  inflightIdentities.set(sessionId, identity)
  return true
}

/** 释放占用。返回 false = 本来就没占用（重复释放，不报错）。 */
export function releaseInflight(sessionId: string): boolean {
  if (sessionId.length === 0) return false
  // 占用捕获的身份随占用一起消失（登记时已经用掉；留着只会在同 session id 复用时
  // 把旧身份当成新请求的身份）。
  inflightIdentities.delete(sessionId)
  return inflight.delete(sessionId)
}

/** 该会话当前是否被占用（只读，排障用）。 */
export function isInflight(sessionId: string): boolean {
  if (sessionId.length === 0) return false
  return inflight.has(sessionId)
}

/**
 * 登记一个待响应的工具调用 id（工具续接的查找索引）。
 *
 * ⚠️ 它**只在记录已存在时**生效：索引必须挂在某条 conversation 上，凭空建一条
 * 记录会让「按 toolCallId 找会话」命中一个没有指纹链的空壳。
 */
export function rememberCallId(toolCallId: string, conversationId: string): void {
  if (toolCallId.length === 0 || conversationId.length === 0) return
  callIndex.set(toolCallId, conversationId)
}

/**
 * 按 `toolCallId` 找待响应的会话（工具续接判定用）。
 *
 * 不做过期清理：过期后应该走「全新会话」，返回 undefined 与之等价。
 */
export function lookupCallId(toolCallId: string): CatpawSessionRecord | undefined {
  if (toolCallId.length === 0) return undefined
  const conversationId = callIndex.get(toolCallId)
  if (conversationId === undefined) return undefined
  for (const entry of sessions.values()) {
    if (entry.record.conversationId !== conversationId) continue
    if (isExpired(entry)) return undefined
    return { ...entry.record, fingerprintChain: [...entry.record.fingerprintChain] }
  }
  const anonymous = anonymousSessions.get(conversationId)
  if (anonymous === undefined) return undefined
  if (isExpired(anonymous)) return undefined
  return { ...anonymous.record, fingerprintChain: [...anonymous.record.fingerprintChain] }
}

/** 注册表快照（排障用）。 */
export function catpawRegistryStats(): {
  sessions: number
  anonymous: number
  inflight: number
  callIds: number
} {
  return {
    sessions: sessions.size,
    anonymous: anonymousSessions.size,
    inflight: inflight.size,
    callIds: callIndex.size,
  }
}

// ─── 内部 ──────────────────────────────────────────────────────────

/** 一条记录的 TTL：**带 sessionId 的一律 2 小时**；匿名工具会话 10 分钟。 */
function ttlOf(entry: Entry): number {
  return entry.sessionId.length === 0 ? CATPAW_TOOL_SESSION_TTL_MS : CATPAW_SESSION_TTL_MS
}

/** 是否已过期。 */
function isExpired(entry: Entry): boolean {
  return Date.now() - entry.lastActiveAt >= ttlOf(entry)
}

/** 移除一条会话（含 call 索引）。 */
function removeSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId)
  if (entry === undefined) return false
  clearCallIndex(entry.record)
  sessions.delete(sessionId)
  return true
}

/** 把记录的待响应 id 写进索引。 */
function indexCalls(record: CatpawSessionRecord): void {
  for (const callId of record.pendingCallIds) {
    if (callId.length > 0) callIndex.set(callId, record.conversationId)
  }
}

/** 撤掉记录的 call 索引（只删仍指向它的那些）。 */
function clearCallIndex(record: CatpawSessionRecord): void {
  for (const callId of record.pendingCallIds) {
    if (callIndex.get(callId) === record.conversationId) callIndex.delete(callId)
  }
}

/**
 * 淘汰最久未活动的一条（LRU）。
 *
 * ⚠️ 判据是**单调序号**而不是 `lastActiveAt`：毫秒时间戳会在同一毫秒内登记的
 * 多条记录上打平，淘汰结果随 `Map` 迭代顺序变（不确定）。
 */
function evictLeastRecentlyUsed(): void {
  let victim: string | undefined
  let smallest = Number.POSITIVE_INFINITY
  for (const [sessionId, entry] of sessions) {
    if (entry.record.lastSequence < smallest) {
      smallest = entry.record.lastSequence
      victim = sessionId
    }
  }
  if (victim !== undefined) removeSession(victim)
}
