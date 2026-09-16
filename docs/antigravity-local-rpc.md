# Antigravity 本地私有 RPC 协议（实测记录）

> **本文档是方案 B 的实现依据，全部内容来自本机实测（2026-09-16），非推测。**
> 修改 `src/antigravity-local.ts` 前必读。

## 为什么需要方案 B

Antigravity IDE 的 agent **不走**公共 Cloud Code API，而是走**本地 language_server 的私有 RPC**。
两者是完全独立的授权体系：

| 通道 | 端点 | 本机实测结果 |
|------|------|--------------|
| 公共 API（方案 A） | `cloudcode-pa.googleapis.com` | ❌ 403 `SUBSCRIPTION_REQUIRED` |
| 本地私有（方案 B） | `127.0.0.1:<port>` | ✅ 全部 200，正常返回模型与配额 |

实测证据：同一账号（Pro / TEAMS_TIER_PRO），公共 API 的 `generateContent` 13 个模型
全部 403；而本地 `GetAvailableModels` 正常返回 33 条模型与配额 `remainingFraction`。

### 方案 B 的防封号优势（关键）

方案 A 是插件**自己**把请求发到 Google —— 服务端会看到「同一 token、第二个客户端」
（TLS 指纹、连接模式、时序都与 IDE 不同）。

方案 B 里请求由 **IDE 自己的 language_server 进程**发出，使用 IDE 自己的连接、
会话与节奏。对 Google 而言，这与「用户在 IDE 里正常提问」**完全无法区分**——因为它就是。

> 一句话：**A 是"冒充 IDE"，B 是"借用 IDE"。**

## 进程拓扑

```
Antigravity IDE (Electron, 多进程)
   │ 启动时拉起 ↓
language_server_windows_x64.exe  (子进程)
   ├─ 监听 127.0.0.1:17013 / 22931   ← 插件打这里
   │     鉴权头：x-codeium-csrf-token
   └─ 直连 Google (198.18.x.x:443)   ← 推理由它自己发出
```

- 二进制路径：`<IDE>/resources/app/extensions/antigravity/bin/language_server_windows_x64.exe`
- ⚠️ 注意区分：`Programs/antigravity/resources/bin/language_server.exe` 是**旧版残留**，
  真正的实例来自 `Programs/Antigravity IDE/resources/app/extensions/...`

### 完整命令行（实测）

```
--csrf_token <UUID>                  ← 鉴权用，与该实例的监听端口**配对**
--extension_server_port <PORT>       ← 它作为**客户端**去连的 IDE 端口（不要用它）
--extension_server_csrf_token <UUID> ← 同上，不是插件要用的那个
--app_data_dir antigravity-ide
--subclient_type ide
--cloud_code_endpoint https://cloudcode-pa.googleapis.com
--workspace_id file_g_...            ← 仅带 --enable_lsp 时有
--parent_pipe_path \\.\pipe\...      ← 仅带 --enable_lsp 时有
```

### 端口/token 配对（易错点）

`--extension_server_port` **不是**插件要连的端口。实测对应关系：

| 进程 | `--csrf_token` | 监听端口（插件目标） | `--extension_server_port`（不要用） |
|------|----------------|----------------------|-------------------------------------|
| PID 37116 | `b619e6fb-…` | `17013` | 16995 |
| PID 11940 | `7469e2bc-…` | `22931` | 22929 |

**配对校验是强制的**：用错 token 会返回 `401 unauthenticated: invalid CSRF token`。

## 鉴权

```
POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
Headers:
  Content-Type: application/json
  x-codeium-csrf-token: <该实例的 --csrf_token>     ← 头名不能写错
Body: JSON（proto3 的 JSON 映射）
```

探测到的错误响应（供实现时判断）：

| 响应 | 含义 |
|------|------|
| `401 missing CSRF token` | 头名写错（如用了 `x-csrf-token`）或未带 |
| `401 invalid CSRF token` | 头名对，但 token 与端口不配对 |
| `404 page not found` | 方法名不存在 |
| `405` | 方法存在但 HTTP 方法不对（需 POST） |
| `400 Client sent an HTTP request to an HTTPS server` | 打到了要求 TLS 的端口（如 22930） |

## 已确认可用的方法（全部实测 200）

### 1. `GetUserStatus` — 账号与配额

```jsonc
// 请求：{}
// 响应：
{
  "userStatus": {
    "name": "Baffina Oravecz",
    "email": "baffinaoravecz@gmail.com",
    "planStatus": {
      "planInfo": {
        "teamsTier": "TEAMS_TIER_PRO",
        "planName": "Pro",
        "maxNumChatInputTokens": "16384",
        "monthlyPromptCredits": 50000,
        "monthlyFlowCredits": 150000
      },
      "availablePromptCredits": 500,
      "availableFlowCredits": 100
    }
  }
}
```

### 2. `GetCascadeModelConfigData` — 模型 label ↔ id 映射

```jsonc
// 请求：{}
// 响应：
{ "clientModelConfigs": [
    { "label": "Gemini 3.8 Flash (High)",
      "modelOrAlias": { "model": "MODEL_PLACEHOLDER_M318" },
      "supportsImages": true, "isRecommended": true },
    ...
] }
```

实测 14 个模型：Gemini 3.6/3.7/3.8 Flash（High/Medium/Low）、Gemini 3.1 Pro（High/Low）、
Claude Sonnet 4.6 (Thinking)、Claude Opus 4.6 (Thinking)、GPT-OSS 120B (Medium)。

### 3. `GetAvailableModels` — 含配额与上下文窗口

```jsonc
// 请求：{}
// 响应：
{ "response": { "models": {
    "MODEL_PLACEHOLDER_M298": {
      "model": "MODEL_PLACEHOLDER_M298",
      "modelProvider": "MODEL_PROVIDER_GOOGLE",
      "maxTokens": 1048576,
      "quotaInfo": { "remainingFraction": 0.9268373,
                     "resetTime": "2026-09-16T15:16:52Z" }
    }, ... } } }
```

### 4. `StartCascade` — 创建会话 ★核心

```jsonc
// 请求：{ "source": 11 }
//   source 是枚举 CortexTrajectorySource，字段名是 `source`（**不是** trajectorySource）
//   11 = CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE
// 响应：{ "cascadeId": "eebc2071-d750-41d4-8ade-9f57f11e4f70" }
```

`StartCascadeRequest` 的其他可用字段（从 proto 描述符提取）：
`trajectoryType`、`cascadeId`、`metadata`、`requestedModel`、`workspaceUris`、
`parentConversationId`、`baseTrajectoryIdentifier`、`agentPath`、`customAgentSpec`、
`experimentConfig`、`projectEnvConfig`、`tags`、`sourceMetadata`、`citcWorkspaceDetails`

**枚举取值**（按二进制字面量偏移顺序推断）：

```
0  UNSPECIFIED              10 ASYNC_CM
1  CASCADE_CLIENT           11 INTERACTIVE_CASCADE   ← IDE 交互式对话用这个
2  EXPLAIN_PROBLEM          12 REPLAY
3  REFACTOR_FUNCTION        13 SDK
4  EVAL                     14 CLI
5  EVAL_TASK                15 JETBOX
6  ASYNC_PRR                16 AGENT_API
7  ASYNC_CF                 17 SUBAGENT
8  ASYNC_SL                 18 PASSIVE_CODER
9  ASYNC_PRD                19 PYTHON_SDK
```

### 5. `SendUserCascadeMessage` — 发送用户消息 ★核心

```jsonc
// 请求：
{ "cascadeId": "<上一步返回的 id>",
  "items": [ { "text": "Say exactly: PONG" } ] }
// 响应：{} （200）
```

**`items[].text` 是实测确认可用的结构**（其他候选如 `userInput.text`、`content`、
`{type,text}` 均未验证或无此字段）。

`SendUserCascadeMessageRequest` 的其他字段：
`cascadeId`、`items`、`metadata`、`cascadeConfig`、`blocking`、`images`、`media`、
`fileComments`、`fileDiffComments`、`artifactComments`、`editorState`、`clientType`、
`messageOrigin`、`additionalSteps`、`deliveryStrategy`、`plannerResponse`、
`continueAfterInjection`、`propagateError`、`tags`、`userIdentity`、`activeProfile`

### 6. `GetCascadeTrajectory` — 读回对话轨迹

```jsonc
// 请求：{ "cascadeId": "..." }
// 响应：
{ "trajectory": {
    "trajectoryId": "60895be4-...",
    "cascadeId": "76a8d6d5-...",
    "trajectoryType": "CORTEX_TRAJECTORY_TYPE_CASCADE",
    "steps": [
      { "type": "CORTEX_STEP_TYPE_USER_INPUT",
        "status": "CORTEX_STEP_STATUS_DONE",
        "metadata": { "createdAt": "...", "source": "CORTEX_STEP_SOURCE_USER_EXPLICIT",
                      "executionId": "cc5c421a-..." } }, ...
    ] } }
```

### 7. `Heartbeat` — 存活检测

```jsonc
// 响应：{ "lastExtensionHeartbeat": "2026-09-16T12:09:05.294861600Z" }
```

## 未注册的方法（404，勿再尝试）

`ListAvailableModels`、`GetModelConfigs`、`GenerateContent`、`AsyncGenerateContent`、
`StreamGenerateContent`、`SendMessage`、`SendUserMessage`、`CreateCascade`、
`StartConversation`、`CreateConversation`、`InvokeCascade`、`RunCascade`、`StartChat`

## 实现要点

### 发现流程（每次调用前动态发现，不可硬编码）

1. 用 WMI 列出 `language_server_windows_x64.exe` 进程及其命令行
   （`Get-CimInstance Win32_Process -Filter "Name='...'"`）
2. 从命令行提取 `--csrf_token`
3. **确定该实例的监听端口**：解析 csrf → 端口配对。
   实测可用的做法是逐个探测候选端口，用 CSRF 校验结果确认配对
   （配对错的会返回 `invalid CSRF token`）
4. 端口/token 都可能随 IDE 重启变化，**不得缓存**（或需带失效重探）

### 重要约束

1. **IDE 必须正在运行**。language_server 是 IDE 的子进程，IDE 关闭即消失；
   实现需优雅降级（回退到方案 A 或给出明确提示）。
2. **不要伪造任何身份标识**。请求就是本地 loopback，不需要、也不应该添加
   `Authorization`、UA 伪装或自定义头。
3. **不需要也不应该读 `state.vscdb`**（那是方案 A 的做法）。方案 B 全程不碰
   凭据文件，账号身份由 IDE 运行时决定。
4. **限速仍然需要**：虽然推理由 IDE 发起，但高频调用仍会消耗账号配额。
   沿用方案 A 的串行 + 最小间隔策略。
5. **CSRF token 是敏感值**：仅用于本地 loopback 鉴权，不得记录到日志或持久化。

## ★ 模型必须在 `cascadeConfig.plannerConfig.planModel` 指定（实测确认 2026-09-16）

**这是打通链路的关键，之前的文档没写，盲试过下列全部错误路径，全部失败**：

| 尝试的字段 | 结果 |
|------------|------|
| `StartCascade.requestedModel = <字符串 id>` | 400 `invalid value for enum field requestedModel` |
| `StartCascade.requestedModel = <数值>` | 200，但执行时报 `neither PlanModel nor RequestedModel specified` |
| `StartCascade.requestedModelId = <字符串 id>` | 200，但执行时同样报 "neither PlanModel nor RequestedModel" |
| `SendUserCascadeMessage.cascadeConfig.requestedModel` | 同样报错 |
| `SendUserCascadeMessage.metadata.requestedModel` | 同样报错 |

**正确形态**（实测成功，`statusTransitions` 走到 `GENERATING` → `DONE` 并返回真实文本）：

```jsonc
// StartCascade：不需要任何模型字段
{ "source": 11 }
// → { "cascadeId": "..." }

// SendUserCascadeMessage：模型放在 cascadeConfig.plannerConfig.planModel
{
  "cascadeId": "<上一步的 id>",
  "items": [{ "text": "What is 2+2?" }],
  "cascadeConfig": { "plannerConfig": { "planModel": "MODEL_PLACEHOLDER_M300" } }
}
// → 200 {}
```

`planModel` 取 `GetCascadeModelConfigData` 返回的 `clientModelConfigs[].modelOrAlias.model`
原样字符串（**带 `MODEL_PLACEHOLDER_` 前缀，不要剥掉**）。

依据来自二进制中的 template 字面量：
`{{- if or (eq .CascadeConfig.GetPlannerConfig.GetPlanModel.String "MODEL_PLACEHOLDER_M54") ... }}`
—— 证明了字段路径 `CascadeConfig → PlannerConfig → PlanModel` 且取值形态是
`MODEL_PLACEHOLDER_*` 字符串。

### 错误信息对照

| 报错 | 含义 |
|------|------|
| `failed to construct executor: neither PlanModel nor RequestedModel specified.` | 没传 `cascadeConfig.plannerConfig.planModel` |
| `trajectory not found: `（空 id） | `StartCascade` 失败导致 cascadeId 为空，后续调用无从依附 |
| `invalid value for enum field requestedModel` | `requestedModel` 是枚举，不接受字符串 |

## ★ 流式回复的获取方式：轮询（无服务端流式方法）

**结论：没有服务端流式方法，只能轮询 `GetCascadeTrajectory`。**

实测时间线（单次问答，模型 `MODEL_PLACEHOLDER_M300`）：

```
send=200 (22ms)          ← SendUserCascadeMessage 立即返回 {}，本身是异步投递
  [1052ms]  USER_INPUT
  [2078ms]  USER_INPUT, EPHEMERAL_MESSAGE, CONVERSATION_HISTORY
  [3410ms]  USER_INPUT, EPHEMERAL_MESSAGE, CONVERSATION_HISTORY, PLANNER_RESPONSE
```

**实测要点**：

1. `SendUserCascadeMessage` **无论传不传 `blocking` 都立即返回**（22ms）。传
   `blocking: true` 时若前面有错误，会把错误以 HTTP 500 + 错误体形式同步返回
   （见下方错误对照），成功时行为与不传一致。**因此 `blocking` 不能用来等回复。**
2. 回复必须靠轮询 `GetCascadeTrajectory`，观察 `steps[]` 增长。
3. **轮询节奏**：实测首个 step 约 1s 出现、完整回复约 3.4s 完成。建议 800ms ~ 1.2s
   一次。注意这属于**本地 loopback 轮询**，不产生 Google 侧流量，因此不受
   `MIN_REQUEST_GAP_MS` 的语义约束（但稳妥起见仍应设上限，见实现）。
4. **步骤状态迁移**（`metadata.internalMetadata.statusTransitions`）：
   `PENDING` → `RUNNING` → `DONE`；模型步（`PLANNER_RESPONSE`）另有一档
   `GENERATING` → `DONE`。**判完成用 step 的 `status == CORTEX_STEP_STATUS_DONE`，
   不要只看 type 出现。**
5. **`PLANNER_RESPONSE` 的 `viewableAt` 与 `finishedGeneratingAt` 之间有明显间隔**
   （实测 1.5s），说明服务端是逐段产出、本地按步落库，轮询天然拿到「已生成完的
   整段」。**无法做到 token 级流式**，适配器按「拿到整段文本后一次性 yield」实现。

### 回复文本的取值路径（实测）

```jsonc
// steps[] 中 type == "CORTEX_STEP_TYPE_PLANNER_RESPONSE" 的那一步
{
  "type": "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
  "status": "CORTEX_STEP_STATUS_DONE",
  "metadata": {
    "modelUsage": {
      "model": "MODEL_PLACEHOLDER_M300",
      "inputTokens": "32926",          // ← 注意是字符串，不是数字
      "outputTokens": "1",
      "responseOutputTokens": "1",
      "apiProvider": "API_PROVIDER_GOOGLE_GEMINI",
      "responseHeader": { "sessionID": "-3750763034362895579" },
      "responseId": "G4qqarnJAdulqtsPhNC18QQ"
    },
    "generatorModel": "MODEL_PLACEHOLDER_M300"
  },
  "plannerResponse": {
    "response": "4",                   // ← 最终回复文本
    "modifiedResponse": "4",           // ← 有 UI 微调时取这个，否则同 response
    "thinkingSignature": "...",        // base64，思维链签名（非明文）
    "messageId": "bot-a33182b5-...",
    "stopReason": "STOP_REASON_STOP_PATTERN"
  }
}
```

**取文本的规则**：优先 `plannerResponse.modifiedResponse`，为空则回退
`plannerResponse.response`。**`thinkingSignature` 是签名不是明文思维链**，
不要尝试当 reasoning 文本用。

### 工具调用相关步骤类型（实测观察到）

| step type | 含义 |
|-----------|------|
| `CORTEX_STEP_TYPE_USER_INPUT` | 用户输入（回显） |
| `CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE` | 系统注入的临时提示（如 memorix 提示），**不应回传给用户** |
| `CORTEX_STEP_TYPE_CONVERSATION_HISTORY` | 携带历史会话摘要的步骤，**内容很长，不应回传** |
| `CORTEX_STEP_TYPE_PLANNER_RESPONSE` | 模型回复正文 ★ |
| `CORTEX_STEP_TYPE_ERROR_MESSAGE` | 执行错误，`errorMessage.error.modelErrorMessage` 是原因 |
| `CORTEX_STEP_TYPE_VIEW_FILE` / `CODE_ACTION` / `RUN_COMMAND` 等 | 工具执行步（IDE agent 的工具） |

## 待验证（实现时需要确认）

- [x] `SendUserCascadeMessage` 是否有流式/非流式两种模式 —— **已确认：无流式，
      靠轮询；`blocking` 不用于等回复**
- [x] 如何获取模型的**流式**回复 —— **已确认：只能轮询 `GetCascadeTrajectory`**
- [x] `requestedModel` 的取值形态 —— **已确认：不是这个字段；模型走
      `cascadeConfig.plannerConfig.planModel`（字符串 `MODEL_PLACEHOLDER_*`）**
- [ ] 多轮对话是否复用同一 `cascadeId`（**建议复用**：复用即保留 IDE 侧会话上下文，
      且与 IDE 自身行为一致；每轮新建 cascade 会污染 IDE 的会话列表）
- [ ] 工具调用（`CORTEX_STEP_TYPE_*`）如何映射到 harness 的 tool-call 块
      —— **本适配器不映射工具调用**：让 IDE 的 agent 自己用工具，插件只取
      `plannerResponse.response` 作为文本回复。理由见 `AGENTS.md` 防封号约束。
