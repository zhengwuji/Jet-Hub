import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { JetHubState, ModelDisableMap } from './jet-hub-store.js'
import type { ProviderAccountEntry } from './types.js'
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupPayload } from './types.js'

/**
 * 备份操作所需的账号池最小接口。
 *
 * 只声明实际用到的方法（结构化类型），使本模块可脱离 Cordis 上下文单测；
 * 真实的 {@link AccountPool} 结构上即满足此接口。
 */
export interface BackupPool {
  /** 读取完整状态快照（账号列表 + 模型黑名单）。 */
  getStateSnapshot(): JetHubState
  /** 整体替换账号列表与模型黑名单。 */
  replaceAll(accounts: readonly ProviderAccountEntry[], disabledModels: ModelDisableMap): Promise<void>
}

/** 备份操作所需的凭据服务最小接口（`ctx.credentials` 结构上满足）。 */
export interface BackupCredentials {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
}

/** 导出结果。 */
export interface BackupExportResult {
  payload: BackupPayload
  /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
  warnings: string[]
}

/** 导入结果。 */
export interface BackupImportResult {
  /** 写入的凭据条数。 */
  credentialsImported: number
  /** 写入的账号数。 */
  accountsImported: number
  /** 跳过的凭据 ref（非法 ref、值非字符串等）。 */
  skipped: string[]
  /**
   * 导入的账号中「凭据已过期」的条数（账号条目 `expiresAt <= 当前时刻`）。
   * 供前端提示：过期凭据若 refresh_token 仍有效会在请求时静默续期；
   * 若 refresh_token 也已失效则需重新登录。
   */
  expiredAccounts: number
  /**
   * 导入的账号中「凭据缺失」的条数：账号条目的 credentialRef 不在备份的
   * credentials 字典里。这类账号导入后无凭据，对应 provider 目录会被门控
   * 隐藏（像未登录一样），供前端提示重新登录。
   */
  missingCredentials: number
}

/** 备份文件格式校验失败。 */
export class BackupFormatError extends Error {}

/**
 * 导出全部账号 + 凭据 + 模型黑名单。
 *
 * 逐账号读取凭据；单个账号凭据缺失/损坏只记入 {@link BackupExportResult.warnings}，
 * 不中断整体导出 —— 换版本迁移场景下宁可先导出能导出的，也不要让一个坏账号
 * 挡住整份备份。
 */
export async function exportBackup(
  pool: BackupPool,
  credentials: BackupCredentials,
): Promise<BackupExportResult> {
  const state = pool.getStateSnapshot()
  const exported: Record<string, string> = {}
  const warnings: string[] = []
  for (const entry of state.accounts) {
    try {
      const resolved = await credentials.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        warnings.push(`${entry.id}: 凭据未配置`)
      } else {
        exported[entry.credentialRef] = resolved.value
      }
    } catch (error) {
      warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials: exported,
      accounts: state.accounts,
      disabledModels: state.disabledModels,
    },
    warnings,
  }
}

/**
 * 校验备份载荷的格式与版本；不合法时抛 {@link BackupFormatError}。
 *
 * 校验在前、写入在后：凭据与账号池都不可被错误格式的备份文件覆盖。
 */
export function assertBackupPayload(value: unknown): asserts value is BackupPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupFormatError('备份内容不是对象')
  }
  const record = value as Record<string, unknown>
  if (record.format !== BACKUP_FORMAT) {
    throw new BackupFormatError(`不是 ${BACKUP_FORMAT} 备份文件（format=${String(record.format)}）`)
  }
  if (record.version !== BACKUP_VERSION) {
    throw new BackupFormatError(`不支持的备份版本：${String(record.version)}（当前支持 v${BACKUP_VERSION}）`)
  }
  if (typeof record.exportedAt !== 'string') {
    throw new BackupFormatError('备份缺少 exportedAt 字段')
  }
  if (typeof record.credentials !== 'object' || record.credentials === null || Array.isArray(record.credentials)) {
    throw new BackupFormatError('备份 credentials 字段无效')
  }
  if (!Array.isArray(record.accounts)) {
    throw new BackupFormatError('备份 accounts 字段无效')
  }
  if (typeof record.disabledModels !== 'object' || record.disabledModels === null || Array.isArray(record.disabledModels)) {
    throw new BackupFormatError('备份 disabledModels 字段无效')
  }
}

/**
 * 导入备份：先写凭据，再整体替换账号池。
 *
 * - 非法/值类型错误的凭据 ref 会被跳过并记录 —— `credentialRef()` 对非法
 *   POSIX 标识符抛错，`set` 也可能因存储后端拒绝而失败，都不应中断整体导入；
 * - 账号池整体替换由 `replaceAll` 内部归一化（丢弃坏条目），保证坏数据
 *   不会进池；
 * - ⚠️ 不按账号条目反查凭据，而是直接按 `credentials` 字典逐条写入 ——
 *   备份文件里可能含账号池之外的独立凭据 ref（如各 provider 的默认单凭据
 *   ref），导出时一并纳入，导入时同样还原。
 */
export async function importBackup(
  credentials: BackupCredentials,
  pool: BackupPool,
  raw: unknown,
): Promise<BackupImportResult> {
  assertBackupPayload(raw)
  const payload = raw
  const skipped: string[] = []
  let credentialsImported = 0
  for (const [refName, value] of Object.entries(payload.credentials)) {
    if (typeof value !== 'string') {
      skipped.push(refName)
      continue
    }
    try {
      await credentials.set(credentialRef(refName), value)
      credentialsImported++
    } catch (error) {
      skipped.push(refName)
    }
  }
  await pool.replaceAll(payload.accounts, payload.disabledModels)
  // 统计已过期账号：expiresAt 是毫秒时间戳，缺失或 NaN 视为「未知」不算过期
  const now = Date.now()
  const expiredAccounts = payload.accounts.filter((entry) =>
    typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now,
  ).length
  // 统计凭据缺失账号：账号条目存在但其 credentialRef 不在 credentials 字典。
  // 注意导入时被 skipped 的 ref 也算「缺失」——它们确实没写进凭据存储。
  const skippedSet = new Set(skipped)
  const missingCredentials = payload.accounts.filter((entry) =>
    !Object.prototype.hasOwnProperty.call(payload.credentials, entry.credentialRef)
    || skippedSet.has(entry.credentialRef),
  ).length
  return {
    credentialsImported,
    accountsImported: payload.accounts.length,
    skipped,
    expiredAccounts,
    missingCredentials,
  }
}
