/**
 * Antigravity 本地私有 RPC 客户端 —— **方案 B：借用 IDE 的 language_server**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么是方案 B（而不是直连 Google 公共 API）
 * ════════════════════════════════════════════════════════════════════════
 *
 * Antigravity IDE 的 agent **不走**公共 Cloud Code API，而是走本地
 * language_server 的私有 RPC。两者是完全独立的授权体系，本机实测：
 *
 *   - 公共 API（方案 A）：同一份凭据，13 个模型全部 403 SUBSCRIPTION_REQUIRED
 *   - 本地私有（方案 B）：全部 200，正常返回模型清单与配额
 *
 * 更关键的是**防封号**：方案 A 是插件自己把请求发到 Google，服务端会看到
 * 「同一 token、第二个客户端」（TLS 指纹、连接模式、时序都与 IDE 不同）；
 * 方案 B 里请求由 **IDE 自己的进程**发出，使用 IDE 自己的连接、会话与节奏，
 * 对 Google 而言与「用户在 IDE 里正常提问」完全无法区分 —— 因为它就是。
 *
 *   一句话：**A 是"冒充 IDE"，B 是"借用 IDE"。**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 协议要点（全部来自本机实测，详见 docs/antigravity-local-rpc.md）
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. 入口：`POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>`
 * 2. 鉴权头名是 `x-codeium-csrf-token`（**不是** `x-csrf-token`），值取该实例的
 *    `--csrf_token`，且**必须与端口配对**（错配 → `401 invalid CSRF token`）
 * 3. 模型**必须**在 `SendUserCascadeMessage.cascadeConfig.plannerConfig.planModel`
 *    指定，取值是 `MODEL_PLACEHOLDER_*` 字符串。传错位置会报
 *    `neither PlanModel nor RequestedModel specified`（这条踩过很多次）
 * 4. **没有服务端流式方法**，回复只能靠轮询 `GetCascadeTrajectory`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 防封号约束（每条都对应代码中的强制措施）
 * ════════════════════════════════════════════════════════════════════════
 *
 * ① **不读凭据文件**
 *    方案 B 全程不碰 `state.vscdb`。账号身份由 IDE 运行时决定，插件只是
 *    向本机 loopback 发 JSON。**本文件中不得出现任何凭据读取逻辑。**
 *
 * ② **不伪造任何身份标识**
 *    请求就是本地 loopback，**连 `Authorization` 都不需要**。只发
 *    `Content-Type` 与本地 CSRF 头，**不设置 User-Agent、不设置任何 X-Product
 *    之类的自定义头**。对比 buddy-adapter 会伪装 UA 成 IDE 客户端 —— 那是
 *    腾讯侧的做法，**这里绝不采用**。
 *
 * ③ **CSRF token 是敏感值**
 *    只用于本地 loopback 鉴权，**不得记录到日志、不得持久化、不得出现在
 *    任何错误信息里**（见 `redact` 与错误构造处的处理）。
 *
 * ④ **不接账号池、不轮换**
 *    本模块不接收 `accountPool`，也不进入 `ALL_PRODUCTS`。永远只用 IDE
 *    当前登录的那一个身份。
 *
 * ⑤ **串行 + 最小间隔**
 *    本地 RPC 虽不直接出网，但每次调用都会消耗账号配额（IDE 会代发到
 *    Google）。沿用方案 A 的串行 + 最小间隔策略，避免形成"比 IDE 更激进"
 *    的调用特征。
 */

import { execFile, execSync } from 'node:child_process'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** RPC 服务路径前缀。 */
const RPC_PREFIX = '/exa.language_server_pb.LanguageServerService/'

/** 语言服务器进程名（Windows）。 */
const LS_PROCESS_NAME = 'language_server_windows_x64.exe'

/**
 * 端口候选表。
 *
 * IDE 每次启动端口都会变（实测见过 17013 / 22931），因此**不得硬编码单一端口**。
 * 这里先试实测见过的值，再扫一段常见区间。发现流程最终以「CSRF 校验通过」
 * 为准来确认配对关系，而不是假设端口就是某个固定值。
 */
const KNOWN_PORTS = [17013, 22931]
const SCAN_RANGE_START = 16990
const SCAN_RANGE_END = 17020
const SCAN_RANGE_START_2 = 22920
const SCAN_RANGE_END_2 = 22940

/** 单个候端口的探测超时（毫秒）。要短，避免发现流程整体变慢。 */
const PROBE_TIMEOUT_MS = 1200

/** 常规 RPC 超时（毫秒）。 */
const RPC_TIMEOUT_MS = 60_000

/** 轮询回复时的单次请求超时（毫秒）。 */
const POLL_REQUEST_TIMEOUT_MS = 15_000

/**
 * 两次出站调用之间的最小间隔（毫秒）。
 *
 * 取 1000ms 的理由与方案 A 相同：IDE 与用户的交互本身是秒级节奏，插件以相同
 * 节奏调用不会形成"比 IDE 更激进"的特征。**不要调低** —— 这是防封号的一道
 * 实质性闸门，而不是性能开关。
 */
export const MIN_REQUEST_GAP_MS = 1000

/** 轮询回复的间隔（毫秒）。这是本地 loopback，比出站调用可以更密。 */
export const POLL_INTERVAL_MS = 800

/** 等待回复的默认总超时（毫秒）。 */
export const DEFAULT_REPLY_TIMEOUT_MS = 300_000

/** CortexTrajectorySource 枚举：交互式对话。 */
const SOURCE_INTERACTIVE_CASCADE = 11

/** 步骤类型常量。 */
const STEP_USER_INPUT = 'CORTEX_STEP_TYPE_USER_INPUT'
const STEP_PLANNER_RESPONSE = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE'
const STEP_ERROR_MESSAGE = 'CORTEX_STEP_TYPE_ERROR_MESSAGE'

/** 步骤状态常量。 */
const STATUS_DONE = 'CORTEX_STEP_STATUS_DONE'

/** 发现的 language_server 实例。 */
export interface LanguageServerInstance {
  /** 监听端口（与 csrfToken 配对）。 */
  port: number
  /**
   * CSRF token。
   *
   * ⚠️ 敏感值：仅用于本地 loopback 鉴权。**不得写入日志或持久化**。
   */
  csrfToken: string
  /** 进程 id（仅用于诊断输出，不含敏感信息）。 */
  pid: number
}

/** RPC 调用结果。 */
export interface RpcResult<T = unknown> {
  status: number
  ok: boolean
  /** 解析后的 JSON；非 JSON 响应时 undefined。 */
  json: T | undefined
  /** 原始响应文本，仅用于错误诊断。 */
  text: string
}

/** 模型配置条目。 */
export interface CascadeModelConfig {
  /** 模型 id，形如 `MODEL_PLACEHOLDER_M318`。 */
  id: string
  /** 展示名，形如 `Gemini 3.8 Flash (High)`。 */
  label: string
  supportsImages: boolean
  isRecommended: boolean
}

/** 轨迹步骤。 */
interface TrajectoryStep {
  type?: string
  status?: string
  plannerResponse?: {
    response?: string
    modifiedResponse?: string
    stopReason?: string
    messageId?: string
    toolCalls?: readonly unknown[]
  }
  errorMessage?: {
    error?: {
      userErrorMessage?: string
      modelErrorMessage?: string
      shortError?: string
    }
  }
  metadata?: {
    modelUsage?: {
      model?: string
      inputTokens?: string | number
      outputTokens?: string | number
      cachedContentTokenCount?: string | number
      thinkingTokens?: string | number
    }
  }
}

/** 轨迹结构。 */
interface Trajectory {
  trajectoryId?: string
  cascadeId?: string
  steps?: TrajectoryStep[]
}

/**
 * 从 language_server 进程的命令行里提取指定参数的值。
 *
 * 命令行形如：
 * ```
 * "...\language_server_windows_x64.exe" --csrf_token <UUID> \
 *   --extension_server_port 16995 --extension_server_csrf_token <UUID> ...
 * ```
 *
 * ⚠️ 注意区分 `--csrf_token` 与 `--extension_server_csrf_token`：
 * 前者是插件要用的（配对监听端口），后者是 language_server 反过来连 IDE 用的。
 * 用正则锚定 `--csrf_token ` 并在匹配后排除 `--extension_server_` 前缀。
 */
export function extractArg(commandLine: string, name: string): string | undefined {
  // 前置边界 (^|\s) 避免 `--extension_server_csrf_token` 里的 `csrf_token` 被误命中。
  const match = new RegExp(`(?:^|\\s)--${name}[ =](\\S+)`).exec(commandLine)
  return match?.[1]
}

/** 判断单行输出是否看起来像 CLI 横幅噪声（防止把别的输出当进程行）。 */
function looksLikeProcessLine(line: string): boolean {
  return line.includes('language_server')
}

/**
 * 通过 netstat -ano 实时获取指定进程监听的本地 TCP 端口（毫秒级，无额外解释器开销）。
 */
export function getListeningPortsForPids(pids: number[]): Map<number, Set<number>> {
  const portsByPid = new Map<number, Set<number>>()
  if (pids.length === 0) return portsByPid
  for (const pid of pids) portsByPid.set(pid, new Set())
  try {
    const output = execSync('netstat -ano', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const pidSet = new Set(pids)
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 5 && parts[0] === 'TCP' && parts[3] === 'LISTENING') {
        const pid = Number.parseInt(parts[4], 10)
        if (pidSet.has(pid)) {
          const addr = parts[1]
          const colonIdx = addr.lastIndexOf(':')
          if (colonIdx !== -1) {
            const port = Number.parseInt(addr.slice(colonIdx + 1), 10)
            if (Number.isFinite(port) && port > 0) {
              portsByPid.get(pid)?.add(port)
            }
          }
        }
      }
    }
  } catch {
    // netstat 异常时 fallback 到基于命令行参数和常见区间探测
  }
  return portsByPid
}

/**
 * 列出本机正在运行的 language_server 进程及其命令行。
 *
 * 为什么走 WMI：进程命令行是发现 csrf token 与配对端口的**唯一**来源。
 * 用 `Get-CimInstance Win32_Process`（不是已废弃的 `wmic`）。
 */
export async function listLanguageServerProcesses(): Promise<
  Array<{ pid: number; commandLine: string }>
> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*${LS_PROCESS_NAME}*" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, out) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(out))
      },
    )
  })

  const trimmed = stdout.trim()
  if (trimmed.length === 0) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const result: Array<{ pid: number; commandLine: string }> = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { ProcessId?: unknown; CommandLine?: unknown }
    const pid = typeof record.ProcessId === 'number' ? record.ProcessId : Number(record.ProcessId)
    const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine : ''
    if (!Number.isFinite(pid) || commandLine.length === 0) continue
    if (!looksLikeProcessLine(commandLine)) continue
    result.push({ pid, commandLine })
  }
  return result
}

/**
 * 发一次本地 RPC。
 *
 * 只发送 `Content-Type` 与 `x-codeium-csrf-token` 两个头 —— 见文件头约束 ②。
 * 请求体是 proto3 的 JSON 映射。
 */
export async function callRpc<T = unknown>(
  instance: LanguageServerInstance,
  method: string,
  body: Record<string, unknown> = {},
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RpcResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetchImpl(`http://127.0.0.1:${instance.port}${RPC_PREFIX}${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': instance.csrfToken,
        // 注意：此处**没有** Authorization、**没有** User-Agent 伪装、
        // **没有**任何自定义 X-* 业务头。见文件头防封号约束 ②。
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    // ⚠️ 一次性读取响应体：**不要用 response.clone()**。
    // clone() 会让原 response 的 body 进入「被派生」状态，之后任何读取都可能
    // 永久挂起（实测：会静默卡在 for await 上，既不抛错也不结束）。
    const text = await response.text()
    let json: T | undefined
    try {
      json = JSON.parse(text) as T
    } catch {
      json = undefined
    }
    return { status: response.status, ok: response.ok, json, text }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 把 CSRF token 之类的敏感值从文本里抹掉。
 *
 * 见文件头约束 ③：token 不得出现在日志或错误信息里。这里的做法是整体替换为
 * `<redacted>`，而不是部分保留 —— 部分保留仍可能被拼接还原。
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.split(secret).join('<redacted>')
  }
  return out
}

/** 端口/token 配对的存活与功能检测：`Heartbeat` + `GetCascadeModelConfigData` 均成功即确认健康配对。 */
async function probePairing(
  port: number,
  csrfToken: string,
  pid: number,
  fetchImpl: typeof fetch,
): Promise<LanguageServerInstance | undefined> {
  try {
    const result = await callRpc<{ lastExtensionHeartbeat?: string }>(
      { port, csrfToken, pid },
      'Heartbeat',
      {},
      { fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
    )
    // 只有 200 才算配对成功。错配的 token 会返回 401 invalid CSRF token
    if (!result.ok) return undefined

    // 验证是否具有真实模型能力（排除处于 state syncing error 的孤儿进程）
    const modelResult = await callRpc<{ clientModelConfigs?: unknown[] }>(
      { port, csrfToken, pid },
      'GetCascadeModelConfigData',
      {},
      { fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
    )
    if (modelResult.ok) {
      return { port, csrfToken, pid }
    }
  } catch {
    // 端口没开 / 拒绝连接 / 超时：继续下一个候选
  }
  return undefined
}

/** 获取指定进程的所有候选端口（结合 netstat 实时监听端口、命令行参数声明端口及近邻偏移） */
export function candidatePortsForProcess(
  process: { pid: number; commandLine: string },
  portsMap: Map<number, Set<number>>,
): number[] {
  const ports = new Set<number>()

  // 1. netstat 实际发现的监听端口（优先级最高）
  const listening = portsMap.get(process.pid)
  if (listening) {
    for (const p of listening) ports.add(p)
  }

  // 2. 命令行参数中声明的端口及其偏移（language_server 会在紧邻端口开启 HTTP/HTTPS 服务）
  for (const arg of ['extension_server_port', 'https_server_port', 'lsp_port']) {
    const raw = extractArg(process.commandLine, arg)
    if (raw !== undefined) {
      const p = Number.parseInt(raw, 10)
      if (Number.isFinite(p) && p > 0) {
        ports.add(p)
        ports.add(p + 1)
        ports.add(p + 2)
        ports.add(p + 3)
        ports.add(p - 1)
        ports.add(p - 2)
      }
    }
  }

  // 3. 常见静态/历史端口保底
  for (const p of KNOWN_PORTS) ports.add(p)
  for (let p = SCAN_RANGE_START; p <= SCAN_RANGE_END; p++) ports.add(p)
  for (let p = SCAN_RANGE_START_2; p <= SCAN_RANGE_END_2; p++) ports.add(p)

  return [...ports]
}

/** 候选端口列表（去重兼容导出）。 */
export function candidatePorts(): number[] {
  const ports = new Set<number>(KNOWN_PORTS)
  for (let p = SCAN_RANGE_START; p <= SCAN_RANGE_END; p++) ports.add(p)
  for (let p = SCAN_RANGE_START_2; p <= SCAN_RANGE_END_2; p++) ports.add(p)
  return [...ports]
}

/**
 * 发现可用的 language_server 实例。
 *
 * 流程（动态端口发现 + CSRF 配对）：
 * 1. 列出 language_server 进程，从命令行取 `--csrf_token`
 * 2. 通过 netstat 快速提取各 PID 的真实监听端口与候选端口
 * 3. 逐个候选端口发 `Heartbeat` 与 `GetCascadeModelConfigData` 校验确认
 */
export async function discoverLanguageServer(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<LanguageServerInstance | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch

  let processes: Array<{ pid: number; commandLine: string }>
  try {
    processes = await listLanguageServerProcesses()
  } catch {
    // PowerShell 不可用或 WMI 失败：视为 IDE 未运行
    return undefined
  }
  if (processes.length === 0) return undefined

  const pids = processes.map((p) => p.pid)
  const portsMap = getListeningPortsForPids(pids)

  for (const process of processes) {
    const csrfToken = extractArg(process.commandLine, 'csrf_token')
    if (csrfToken === undefined || csrfToken.length === 0) continue

    const ports = candidatePortsForProcess(process, portsMap)
    for (const port of ports) {
      const instance = await probePairing(port, csrfToken, process.pid, fetchImpl)
      if (instance !== undefined) return instance
    }
  }
  return undefined
}

/** 拉取模型配置（label ↔ id 映射）。 */
export async function fetchModelConfigs(
  instance: LanguageServerInstance,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<readonly CascadeModelConfig[]> {
  const result = await callRpc<{
    clientModelConfigs?: Array<{
      label?: string
      modelOrAlias?: { model?: string }
      supportsImages?: boolean
      isRecommended?: boolean
    }>
  }>(instance, 'GetCascadeModelConfigData', {}, options)

  if (!result.ok) {
    throw new LlmError(
      `antigravity-local: 拉取模型清单失败（HTTP ${result.status}）。`
        + `${redact(result.text.slice(0, 200), [instance.csrfToken])}`,
      'SERVER',
      { status: result.status },
    )
  }

  const configs: CascadeModelConfig[] = []
  for (const entry of result.json?.clientModelConfigs ?? []) {
    const id = entry.modelOrAlias?.model
    if (typeof id !== 'string' || id.length === 0) continue
    configs.push({
      id,
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : id,
      supportsImages: entry.supportsImages === true,
      isRecommended: entry.isRecommended === true,
    })
  }
  return configs
}

/** 创建一个新会话，返回 cascadeId。 */
export async function startCascade(
  instance: LanguageServerInstance,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const result = await callRpc<{ cascadeId?: string }>(
    instance,
    'StartCascade',
    // source = CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE。
    // ⚠️ 字段名是 `source`，**不是** `trajectorySource`（写错会一直报 unspecified）。
    // ⚠️ **不要**在这里带任何模型字段：requestedModel 是枚举，不接受
    // MODEL_PLACEHOLDER_* 字符串；模型正确的位置是 SendUserCascadeMessage 的
    // cascadeConfig.plannerConfig.planModel。
    { source: SOURCE_INTERACTIVE_CASCADE },
    options,
  )

  const cascadeId = result.json?.cascadeId
  if (!result.ok || typeof cascadeId !== 'string' || cascadeId.length === 0) {
    throw new LlmError(
      `antigravity-local: 创建会话失败（HTTP ${result.status}）。`
        + redact(result.text.slice(0, 200), [instance.csrfToken]),
      'SERVER',
      { status: result.status },
    )
  }
  return cascadeId
}

/**
 * 发送用户消息。
 *
 * ⚠️ **模型在这里指定**：`cascadeConfig.plannerConfig.planModel` 必须是
 * `MODEL_PLACEHOLDER_*` 原样字符串。不传它会报
 * `failed to construct executor: neither PlanModel nor RequestedModel specified`。
 *
 * 实测该方法无论传不传 `blocking` 都**立即返回**（约 20ms），回复要靠轮询
 * `GetCascadeTrajectory` 获取。因此这里不暴露 blocking 开关。
 */
export async function sendUserMessage(
  instance: LanguageServerInstance,
  cascadeId: string,
  text: string,
  modelId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const result = await callRpc(
    instance,
    'SendUserCascadeMessage',
    {
      cascadeId,
      // ⚠️ `items[].text` 是实测确认可用的结构（其他候选如 userInput.text、
      // content、{type,text} 均未验证或无此字段）。
      items: [{ text }],
      cascadeConfig: { plannerConfig: { planModel: modelId } },
    },
    options,
  )

  if (!result.ok) {
    throw new LlmError(
      `antigravity-local: 发送消息失败（HTTP ${result.status}）。`
        + redact(result.text.slice(0, 300), [instance.csrfToken]),
      'SERVER',
      { status: result.status },
    )
  }
}

/** 读取轨迹。 */
export async function getTrajectory(
  instance: LanguageServerInstance,
  cascadeId: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Trajectory> {
  const result = await callRpc<{ trajectory?: Trajectory }>(
    instance,
    'GetCascadeTrajectory',
    { cascadeId },
    { ...options, timeoutMs: POLL_REQUEST_TIMEOUT_MS },
  )
  if (!result.ok) {
    throw new LlmError(
      `antigravity-local: 读取轨迹失败（HTTP ${result.status}）。`
        + redact(result.text.slice(0, 200), [instance.csrfToken]),
      'SERVER',
      { status: result.status },
    )
  }
  return result.json?.trajectory ?? {}
}

/** 获取最后一个 USER_INPUT 步骤的索引。 */
export function lastUserInputIndex(trajectory: Trajectory): number {
  const steps = trajectory.steps ?? []
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.type === STEP_USER_INPUT) {
      return i
    }
  }
  return -1
}

/** 从轨迹里找出错误步（若存在）。只检查 baselineTotalSteps 之后的错误步。 */
export function findErrorStep(trajectory: Trajectory, baselineTotalSteps = 0): string | undefined {
  const steps = trajectory.steps ?? []
  const userIdx = lastUserInputIndex(trajectory)
  const minIdx = Math.max(userIdx >= 0 ? userIdx : 0, baselineTotalSteps)
  for (let i = steps.length - 1; i >= minIdx; i--) {
    const step = steps[i]
    if (step === undefined || step.type !== STEP_ERROR_MESSAGE) continue
    const error = step.errorMessage?.error
    const message = error?.modelErrorMessage ?? error?.shortError ?? error?.userErrorMessage
    if (typeof message === 'string' && message.length > 0) return message
  }
  return undefined
}

/**
 * 从轨迹里找出针对本轮最新用户输入的模型回复步骤。
 *
 * ⚠️ 关键防串线与时序保护机制：
 * 1. 若 baselineUserInputCount > 0，必须确保当前轨迹中的 USER_INPUT 数量严格大于 baselineUserInputCount，
 *    否则说明语言服务器尚未将本轮用户输入写入轨迹库，绝不能读取上一轮已完成的历史回复！
 * 2. 必须只在最新一次 USER_INPUT（且其索引 >= baselineTotalSteps）之后的步骤里寻找 PLANNER_RESPONSE。
 */
export function findReplyForTurn(
  trajectory: Trajectory,
  baselineUserInputCount = 0,
  baselineTotalSteps = 0,
): TrajectoryStep | undefined {
  const steps = trajectory.steps ?? []
  const currentInputs = countUserInputs(trajectory)

  // 1. 如果已有历史轮次，但当前轨迹尚未录入本轮的 USER_INPUT，直接返回 undefined 等待下一轮轮询
  if (baselineUserInputCount > 0 && currentInputs <= baselineUserInputCount) {
    return undefined
  }

  // 2. 获取最新一次 USER_INPUT 的索引
  const userIdx = lastUserInputIndex(trajectory)

  // 如果 baselineTotalSteps > 0 且 userIdx < baselineTotalSteps，说明最新的 USER_INPUT 仍是旧轮次的
  if (baselineTotalSteps > 0 && userIdx < baselineTotalSteps && userIdx !== -1) {
    return undefined
  }

  // 3. 搜索范围必须严格在 userIdx 之后
  const minIdx = userIdx >= 0 ? userIdx : (baselineTotalSteps > 0 ? baselineTotalSteps - 1 : -1)

  for (let i = steps.length - 1; i > minIdx; i--) {
    const step = steps[i]
    if (step !== undefined && step.type === STEP_PLANNER_RESPONSE && replyText(step).length > 0) {
      return step
    }
  }
  for (let i = steps.length - 1; i > minIdx; i--) {
    const step = steps[i]
    if (step !== undefined && step.type === STEP_PLANNER_RESPONSE) return step
  }
  return undefined
}

/** 从轨迹里找出针对最新一次用户输入的模型回复步骤。 */
export function findCurrentTurnReplyStep(
  trajectory: Trajectory,
  baselineUserInputCount = 0,
  baselineTotalSteps = 0,
): TrajectoryStep | undefined {
  return findReplyForTurn(trajectory, baselineUserInputCount, baselineTotalSteps)
}

/** 从轨迹里找出模型回复步骤（默认获取当前轮次回复）。 */
export function findReplyStep(
  trajectory: Trajectory,
  baselineUserInputCount = 0,
  baselineTotalSteps = 0,
): TrajectoryStep | undefined {
  return findReplyForTurn(trajectory, baselineUserInputCount, baselineTotalSteps)
}

/**
 * 统计轨迹里用户输入步的数量。
 *
 * 用途：多轮对话复用同一 cascadeId 时，用「用户输入步数」来区分「本轮的回复」
 * 与「历史轮的回复」—— 只有在累计到足够多的用户输入之后出现的回复步才属于本轮。
 */
export function countUserInputs(trajectory: Trajectory): number {
  let count = 0
  for (const step of trajectory.steps ?? []) {
    if (step.type === STEP_USER_INPUT) count++
  }
  return count
}

/**
 * 从回复步骤里取文本。
 *
 * 取 `modifiedResponse` 优先、`response` 兜底（实测二者通常相同，
 * `modifiedResponse` 是 UI 微调后的版本，语义上更贴近用户实际看到的输出）。
 *
 * ⚠️ 不把 `thinkingSignature` 当思维链：它是签名字节，不是明文。
 */
export function replyText(step: TrajectoryStep): string {
  const modified = step.plannerResponse?.modifiedResponse
  if (typeof modified === 'string' && modified.length > 0) return modified
  const response = step.plannerResponse?.response
  if (typeof response === 'string') return response
  return ''
}

/** 回复步骤是否已完成。 */
export function isReplyDone(step: TrajectoryStep): boolean {
  if (step.status !== STATUS_DONE) return false
  // 若当前步骤仅包含 toolCalls 且无文本回复，说明 IDE 还处于工具中间步骤，不能视为最终回复完成
  if (replyText(step).length === 0 && (step.plannerResponse?.toolCalls?.length ?? 0) > 0) {
    return false
  }
  return true
}

/** 从回复步骤里取 token 用量。 */
export function replyUsage(step: TrajectoryStep): {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
} {
  const usage = step.metadata?.modelUsage
  if (usage === undefined) return {}
  // ⚠️ 实测 proto3 JSON 里这些字段是**字符串**（int64 映射），不是数字。
  const toNumber = (value: string | number | undefined): number | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string' || value.length === 0) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const result: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } = {}
  const input = toNumber(usage.inputTokens)
  const output = toNumber(usage.outputTokens)
  const thinking = toNumber(usage.thinkingTokens)
  if (input !== undefined) result.inputTokens = input
  if (output !== undefined) result.outputTokens = output
  if (thinking !== undefined && thinking > 0) result.reasoningTokens = thinking
  return result
}

export { SOURCE_INTERACTIVE_CASCADE, STEP_PLANNER_RESPONSE, STEP_ERROR_MESSAGE, STATUS_DONE }
