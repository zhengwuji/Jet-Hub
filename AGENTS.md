# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）与 `workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）两个 LLM provider 路由。

`buddy` 与 `workbuddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到，见 `src/credits.ts`）**仅 CodeBuddy 面板提供** —— 国际版 WorkBuddy 后端没有签到接口。

插件另提供 `antigravity`（Google Antigravity IDE）路由，走**路径 A：本机凭据复用**——只读复用 IDE 自身的 OAuth 登录态，不独立登录、不进账号池。硬性约束见下文「Antigravity 渠道的硬性约束」。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` 编译宿主侧 + `esbuild` 打包客户端）
- **语言**：TypeScript
- **许可**：MIT

## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证
  git 安装时两侧产物齐全。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy`、`test:e2e:workbuddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致

## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |

## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `status()` — 查询凭据状态（configured、source、expiresAt、refreshable）
- `refresh()` — 手动静默续期凭据
- `logout()` — 清除凭据并停止续期定时器

服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，互不覆盖。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络
- E2E 测试按 provider 分为独立脚本（`pnpm test:e2e:*`），**均带闸门且默认跳过**；哪些会消耗模型积分见 `tests/e2e/README.md`
- 测试文件按约定放在 `tests/unit/` 与 `tests/e2e/` 目录

## LLM Provider 约定

- provider 名称：`codearts` / `buddy` / `workbuddy` / `antigravity`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `antigravity`：Bearer access_token（Google OAuth）+ Google Cloud Code 私有协议
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例

## Antigravity 渠道的硬性约束（防封号）

`antigravity` 渠道**不属于** `BuddyProduct` 体系，`ALL_PRODUCTS` 中**没有**
它的条目。以下约束是刻意的架构决策，修改时必须保持：

1. **不得把 antigravity 加入 `ALL_PRODUCTS`**。该数组会被 `index.ts` 用于
   创建多账号服务实例并接入 `refreshAll` / 限流自动切换。Google 侧对
   「同一账号被多客户端高频轮换」的判定远比腾讯侧严格。
2. **不得给 `AntigravityAdapter` 传入 `accountPool`**。它固定单账号、串行、
   限速（`MIN_REQUEST_GAP_MS`，两次请求间隔 ≥ 1s）。
3. **`state.vscdb` 必须以 `readOnly: true` 打开**。IDE 运行时该库处于 WAL
   模式，写入会与 IDE 争锁并可能损坏凭据。
4. **不得伪造客户端身份标识**。`buddy-adapter.ts` 会设置
   `User-Agent: CodeBuddyIDE/...` 来伪装成 IDE 客户端 —— 那是腾讯侧的做法，
   **不要复制到 antigravity 适配器**。Google 侧对指纹不匹配极其敏感。
5. **续期默认交给 IDE**。IDE 自行续期并写回 `state.vscdb`，而
   `readAntigravityCredential()` 每次调用都重新读取，天然拿到最新 token。
   `refreshAntigravityToken()` 仅在显式配置 `refresh` 实现时才被调用
   （用于 IDE 长期未运行、库中 token 已失效的场景）。

凭据解析链路（base64 → protobuf → sentinel entry → payload 解包 → token 字段）
的字段位置与实测依据见 `src/antigravity.ts` 文件头注释；改动前务必先读该注释。

### 两条通道（自适应选路：方案 B 优先，方案 A 降级）

插件对 Antigravity 实现了两条互斥通道，由适配器**按账号实际可用性自动选路**
（`AntigravityLocalAdapter.probeChannels()`）：

| 通道 | 实现文件 | 出网方式 | 本机实测 |
|------|----------|----------|----------|
| **B（首选）** | `src/antigravity-local.ts` + `src/antigravity-local-adapter.ts` | 请求打向 `127.0.0.1`，由 **IDE 自己的 language_server** 转发 | ✅ 可用 |
| A（降级） | `src/antigravity.ts` + `src/antigravity-adapter.ts` | 插件自己直连 `cloudcode-pa.googleapis.com` | ❌ 403 `SUBSCRIPTION_REQUIRED` |

**为什么 B 比 A 更安全**：A 是「冒充 IDE」—— 服务端会看到同一 token 的第二个
客户端，TLS 指纹、连接模式、时序都与 IDE 不同；B 是「借用 IDE」—— 请求由 IDE
自己的进程发出，对 Google 而言与「用户在 IDE 里正常提问」完全无法区分（因为它就是）。

#### 自适应选路规则（`probeChannels()`）

| 本地通道 | 公共通道 | 结果 |
|----------|----------|------|
| 可用 | **不探测** | `local` —— 本地能用就不问 Google，少一次出站即少一分指纹暴露 |
| 不可用 | 探测 → 200 | `public`（自动降级） |
| 不可用 | 探测 → 401/403 | `unavailable` + 列出两条路各自的原因与下一步 |
| 不可用 | `allowPublicFallback: false` | `unavailable`（完全不碰公共 API） |

要点（改动时勿破坏）：

1. **本地通道的判据是 `Heartbeat` 通过**，不是「能拉到模型清单」。清单只是
   advisory 的展示数据；把它当判据会让一次瞬时抖动把可用渠道误报为不可用。
2. **公共通道只探认证**（`loadCodeAssist`），**不发推理请求** —— 探测不消耗配额。
3. 探测结果带 **60 秒 TTL**；面板「重测」按钮传 `force: true` 绕过缓存
   （`force` 同时使实例缓存与模型清单缓存失效）。
4. `allowPublicFallback` **默认 `true`**（用 `!== false` 判定）。用户的诉求是
   「有权限就能用」，而不是「必须手动改配置」。设 `false` 则完全不碰公共 API。
5. 公共通道探测到 **401 表示 IDE 里的 OAuth 凭据已过期**（实测本机会出现），
   此时本地通道往往**仍然可用** —— 因为 B 根本不用那份 token。

面板通过 RPC `antigravity.channelProbe` 取探测结论，显示
「✅ 本地私有通道 / ⚠️ 公共 API 降级 / ❌ 当前不可用」及逐条原因。

#### 方案 B 额外的硬性约束

除上方 1~5 条外，`src/antigravity-local*.ts` 还须保持：

6. **不读 `state.vscdb`**。方案 B 全程不碰凭据文件，账号身份由 IDE 运行时决定。
   （这是与方案 A 最大的实现差异，不要为「省一次进程发现」而把凭据读取混进来。）
7. **不发 `Authorization`**，也不发任何自定义业务头。本地 loopback 只需要
   `Content-Type` 与 `x-codeium-csrf-token` 两个头。
8. **CSRF token 不得落日志、不得持久化**。所有错误信息构造处都要经过 `redact()`。
9. **发现流程不得硬编码端口**。端口与 token 都随 IDE 重启变化，必须每次用
   `Heartbeat` 的 CSRF 校验结果动态确认配对。

#### 方案 B 的两个致命字段位置（写错就完全不通）

1. 鉴权头名是 **`x-codeium-csrf-token`**，不是 `x-csrf-token`。写错报
   `missing CSRF token`；头名对但 token 与端口不配对报 `invalid CSRF token`。
2. 模型**必须**放在 `SendUserCascadeMessage.cascadeConfig.plannerConfig.planModel`，
   取值是 `MODEL_PLACEHOLDER_*` **原样字符串**。放到 `StartCascade.requestedModel`
   （那是枚举，传字符串直接 400）或 `requestedModelId` 都会在执行时报
   `failed to construct executor: neither PlanModel nor RequestedModel specified.`

3. 回复**没有服务端流式**，只能轮询 `GetCascadeTrajectory`；模型文本在
   `steps[].plannerResponse.modifiedResponse`（回退 `.response`）。

协议细节、枚举值、错误码、示例响应全部记录在 **`docs/antigravity-local-rpc.md`**，
改动前必读。

### 实测状态：公共 API 需要账号侧授权（2026-09）

**IDE 可用 ≠ 公共 API 可用**，两者是不同授权体系：

- Antigravity IDE 的 agent 走**本地 language_server 私有通道**（命令行为
  `--cloud_code_endpoint ... --subclient_type ide`），该通道正常工作；
- 同一份 OAuth 凭据调用**公共** Cloud Code API 时，实测被拒：
  - `/v1internal:generateContent` → 403 `SUBSCRIPTION_REQUIRED`
  - `aiplatform.googleapis.com` → 400 `RESOURCE_PROJECT_INVALID`
  - `generativelanguage.googleapis.com` → 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
  - 而 `/v1internal:loadCodeAssist` → **200**（凭据认证本身通过）

因此：**不要**把 `generateContent` 的 403 当成"插件写错了"去改鉴权代码；
它是账号未开通对应公共 API。适配器的 `diagnoseRejection()` 已按原因分类
给出中文诊断，待账号获得授权后无需改代码即可使用。

两个已修复的真实缺陷（改动时勿回退）：

- `sleep()` **不能**使用 `.unref()`：限速闸门的定时器被 unref 后，若进程内
  无其他 pending 工作会让 `for await` 静默挂死（既不抛错也不结束）。
- 401/403 分支**不能**用 `response.clone()` 读错误体：clone 后原 body 进入
  被派生状态，后续读取会阻塞。改为一次性 `response.text()`。

## 积分领取（每日签到）

`src/credits.ts` 封装每日签到积分接口，**目前只用于 CodeBuddy**（国际版 WorkBuddy 后端无签到接口）：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`（「今天已签到」），判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖
- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
