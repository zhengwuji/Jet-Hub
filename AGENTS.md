# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）与 `lobsterai`（有道 **LobsterAI** / 龙虾）三个 LLM provider 路由。

`buddy` 与 `workbuddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与上述两者**完全不同源**：登录方式、请求头、续期载荷、签到流程、版本号来源都不一样，因此实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 那里面 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 等字段对 LobsterAI 全部无意义。详见 README 的「LobsterAI provider」章节与 `docs/lobsterai-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI 与 CodeArts 三个面板提供** —— 国际版 WorkBuddy 后端没有签到接口，故不提供。三者是**三套互不相同的协议**（见下「积分领取」）。

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

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `status()` — 查询凭据状态（configured、source、expiresAt、refreshable）
- `refresh()` — 手动静默续期凭据
- `logout()` — 清除凭据并停止续期定时器

另有按凭据 ref 续期**指定账号**的 `refreshAccountCredential(refName)` —— 供 Jet Hub 账号卡片的「刷新」按钮使用。**不要**用 `refresh()` 去刷账号池里的账号：它读写的是该 provider 的**默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），而账号卡片对应的是 `BUDDY_ACCOUNT_XXX`，会刷到另一个凭据上。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号同样会出现在 Jet Hub 里并参与积分领取。

**真实缺陷**（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
点「一键领取积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
根因是两处都按 `enabled` 过滤：

- `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
  → 停用期间 refresh_token 一路放到失效；
- `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
  → **所有账号都停用时续期定时器根本不启动**。

用户重新启用后拿到的是死凭据，只能重新登录。四个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，互不覆盖。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，而正处于限流期的
  账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

## 单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤

腾讯系两个端点（scoped `/console/enterprises/personal/models` 与 `/v3/config`）
**都下发 `data.models[].maxOutputTokens`**。它是权威的单次请求输出额度，适配器
**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`（DSH 只在调用方未显式给值时用声明的默认值兜底）。

**真实缺陷**（用户报障）：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被
截断，`turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。
根因不是「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当作
`isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关
默认值，而网关默认恰好就是 **32000**（远端 `auto` / `glm-4.6` 等声明的即为此值）。
远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。

要点：

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值（编大被上游拒、编小无谓截断）
- ⚠️ **远端是外部输入，非法值必须过滤**：`positiveMaxTokens` 只放行安全正整数。
  DSH 对 `defaultMaxTokens` 有硬校验，`0` / 负数 / `NaN` 会直接抛
  `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）
- 实测（2026-09-19）各端点值不完全一致：`deepseek-v4.1-flash` 在 scoped 端点
  为 128000、`/v3/config` 为 131072。与 `maxInputTokens` 同策略 —— 采信实际
  命中的那个端点，**不做跨端点取大**
- 网关**确实接受且精确生效**：`max_tokens: 64` 会精确截断在 64
  （`finish_reason=length`、`completion_tokens=64`）。验证脚本
  `scripts/verify-max-tokens.mjs`（用国际版限免的 v4.1-flash，`credit: 0`）
- `reasoning_tokens` **计入** `completion_tokens`：思考内容与正文共享同一额度，
  故思考开到 `max` 时正文更早撞上限。「单次请求」≠「单轮」——每 step 独立预算，
  超长文件仍需拆多步写
- 排查脚本（均为**只读 GET**，零模型额度）：`scripts/dump-max-output.mjs`
  导出全模型 `id → maxOutputTokens`；`scripts/probe-max-output.mjs` 打印原始条目

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

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

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**

## LobsterAI 模型列表（三个易踩的坑）

`GET /api/models/available` 有三个**各自独立、叠加生效**的坑，任一个都会让远端已上线的模型在面板里看不到或参数不对：

1. **响应是单层 `data` 数组**：真实形态是 `{code:0, message:'success', data:[{modelId,...}]}` —— `data` **直接是数组**（实测 2026-09-17，26 个模型）。**不能**复用 `parseLobsteraiEnvelope`：那个信封要求 `data` 必须是对象（用于把「凭据失效返回 `data:null`」判成失败），复用会让本端点恒判失败 → 空数组 → 适配器静默回退静态兜底表。解析走 `readLobsteraiModelArray`，**同时兼容**单层与双层（`data.data`）两种形状。
2. **必须带 `X-LobsterAI-Client-Capabilities` 头**：服务端按该头声明的能力**过滤模型集合**。不带时只返回 25 个且**没有 `kimi-k3`**；带 `kimi-k3-agentic-v1` 才返回 26 个。所以模型列表用 `lobsteraiModelsHeaders`（含两个 `X-LobsterAI-Client-*` 头，`Accept` 为 JSON），**不是**只有 4 个基础头的 `lobsteraiAuthHeaders`。
3. **能力声明还必须含 `thinking-level-control-v1`**：`reasoning_effort: "off"`（关闭思考）在**不带**该能力时服务端直接 HTTP 500；low/high/max/xhigh 不受影响。故 `LOBSTERAI_CLIENT_CAPABILITIES` 是**逗号分隔的两个值**，缺一不可 —— 这是「用户把档位调到 off 才炸」的隐蔽故障。

静态兜底表（`LOBSTERAI_FALLBACK_MODELS`，19 个）是 2026-08-06 抄的快照，**只在远端整体失败时顶替**；远端可用时完全采信远端（不做 buddy 那样的「以兜底表为准」裁剪）。它天然会逐渐过时（实测已缺 8 个新模型、多了 1 个已下架模型），排查「模型看不到」时**先确认远端到底返回了什么**，别直接看兜底表。

### 远端模型参数必须消费（不能只看 id/name）

远端每个模型还下发 `contextWindow`（实测多为 **1000000**，兜底表却统一写 131072）、`supportsImage`（26 个里 19 个为 true）、`supportsThinking`、`thinkingConfig`、`maxTokens`、`description`。这些是权威值，**兜底表只是估值**：

- `resolveModel` 的 `context` 取**远端优先、兜底表次之**；采信 131072 估值会让 DSH 远未用满 1M 窗口就触发压缩
- `inputModalities` 由远端 `supportsImage` 驱动（未声明时保守报 `text`）
- 可选字段缺失一律留 `undefined`，**绝不填 0/false**：「远端说不支持」与「远端没说」是两回事

### 思考档位的 wire 值是 `openclawLevel`，不是 `level`

`thinkingConfig.options[]` 每项有 `level`（**产品侧档位名**，含 `max`）与 `openclawLevel`（**发给服务端的 `reasoning_effort` 取值**，无 `max`）。远端把 `level: 'max'` 映射到 `openclawLevel: 'xhigh'`。

实测反证：直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），发 `'xhigh'` 才真正触发最高档。因此 `reasoningFor()` 用 `openclawLevel` 作 effort id，`defaultEffort` 也经 `options` 映射后再声明（必须落在 efforts 内，否则 DSH 会拿不存在的档位去请求）。

### SSE 的 `delta.content` / `delta.reasoning_content` 会显式返回 `null`

真实形态（实测 335 帧）：一个模型要么走 content、要么走 reasoning_content，**另一侧恒为 `null`**（227 帧 `content=null`）。解析必须用 `typeof x === 'string'` 而非 `!== undefined` —— 只判 undefined 会让 `.length` 在 null 上崩溃，表现为**每轮对话第一帧就报 `Cannot read properties of null`**。

### 图片输入

远端声明 `supportsImage` 的模型**真的**接受图片：服务端收 OpenAI 兼容的 `{type:'image_url', image_url:{url}}` data URL（实测模型能正确识别图片内容）。**唯一**接受的形态就是它 —— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。

- 能力按**模型**判定（`inputModalitiesFor`），不是按 provider 一刀切
- `stream()` 里 `ensureRemoteModels()` 必须在图片判定**之前**调用，否则 `remoteMeta` 尚空、会把支持图片的模型误判为不支持
- 工具结果内嵌图片（`read_image`）不能留在 `role:'tool'` 消息里（该角色 content 只能是字符串），须提升为**其后的独立 user 消息**；`userContentParts` 与 `collectImages` 必须**对称递归**，否则深层图片会被静默吞掉
- 只声明 `inputModalities` 而不实现比不声明**更糟**：DSH 在 `LlmRuntime` 里按它决定是否把图片投影成文本占位符，声明支持就必须真支持

## 「+ 新建账号」必须两步式返回 loginUrl（四个 provider 一致）

`account.create` 对**全部四个 provider** 都必须在**用户完成授权之前**返回
`loginUrl`，由前端立即 `window.open`，后台再异步等回调。

这不是风格偏好，而是浏览器硬约束：`window.open` 只在用户点击后的
**transient activation** 窗口（约 5 秒）内被允许。若 `account.create` 阻塞到
用户授权完成（数十秒），返回时手势已过期 → 弹窗被拦截返回 `null` → 前端若
兜底 `window.location.href = loginUrl` 就会把**整个设置页**导航走。
**真实缺陷**（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
跳转过去了」正是此因。

- `buddy` / `workbuddy`：`runBuddyLoginFlow` 不 await，立即返回 URL
- `codearts`：`CodeArtsAuth.startLogin()`（`src/service.ts`），底层 `startOAuthFlow`（`src/login.ts`）
- `lobsterai`：`LobsteraiAuth.startLogin()`（`src/lobsterai-auth.ts`），底层 `startLobsteraiLoginFlow`（`src/lobsterai-oauth.ts`）

要点：

- 阻塞式 `runOAuthFlow` / `runLobsteraiLoginFlow` **保留**（CLI、e2e 仍用），
  但它们现在由 `start*` 实现，两条路径的落库逻辑共用 `persistLogin()` ——
  否则两步式会静默缺少续期武装或账号登记
- 两步式路径**没有外层 `try/finally`**，故超时与「结果落定即关闭回调服务器」
  都收在 `start*` 内部，避免泄漏监听端口
- 两步式下 `account.create` 返回时凭据还不存在，**必须**先登记占位账号条目，
  否则前端 `login.poll` 查不到该账号、永远 `done:false`
- 前端**不得**再出现 `window.location.href = loginUrl`：弹窗被拦截时改为展示
  可点击链接（`loginUrlForManual`）。`tests/unit/jet-hub-rpc.spec.ts` 有源码级
  断言锁死这条（剔除注释行后匹配，因注释里保留了该缺陷的叙述）

## 积分领取（每日签到）

**三套协议完全不同**的实现，各自独立：

**CodeBuddy** —— `src/credits.ts`（国际版 WorkBuddy 后端无签到接口）：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`（「今天已签到」），判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖

**LobsterAI** —— `src/lobsterai-credits.ts`（三步，见 `lobsterai2api/sigin.py`）：

- 槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`
- 幂等是**客户端**保证的：请求带 `idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`
- `clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`
- `platform=win32` 等参数是**客户端形态伪装**，非 Windows 上也照发

**CodeArts** —— `src/codearts-credits.ts`（四步，华为云「每日签到得积分」）：

- 账户类型 `GET /snap-manager/v1/statistics/plugin` → 活动列表 `GET /v1/ops/delivery?channel=IDE` → 领取 `POST /v1/ops/claim` `{campaignId, channel:'IDE'}` →（响应 `id !== null` 时）确认 `POST /v1/ops/confirm` `{campaignId}`
- **认证是 `SDK-HMAC-SHA256` 签名**（复用 `src/sign.ts`），base = `https://snap-access.cn-north-4.myhuaweicloud.com`（与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` **同域**）
- ⚠️ **`Agent-Type` / `X-Language` 必须在签名之后追加，绝不能参与签名**。实测把它们作为 `signRequestHuawei` 的 `extraHeaders` 传入（进入 canonical request 与 SignedHeaders）会得到 `401 APIG.0301 verify ak sk signature fail`；签名后追加则 200 并返回真实数据。正确做法与 `src/models.ts` 的 `fetchSignedGet` 一致（其参数注释写明「签名后追加的头（不参与签名计算）」）。**真实缺陷**：本模块早期误当作签名头，界面显示「积分：账户信息查询失败」。⚠️ 注意 `src/llm-adapter.ts` 的 `maas_type: benefit` 是**反例**——那个头确实需要参与签名，不要据此推断
- ⚠️ **非 2xx 必须带出服务端 `error_code` / `error_msg`**（`describeHttpFailure`）：只报 `HTTP 401` 会让「签名头位置错」「AK 限流（`AK access failed to reach the limit`）」「凭据过期」这些处置方式完全不同的问题看起来一模一样
- ⚠️ **官方文档给的 portal 路径不可用**：`codearts.huaweicloud.com/portal/...` 是 BFF 接口、依赖浏览器 Cookie，实测带 AK/SK 签名也只会返回 IAM 登录跳转 HTML。协议逆向自本机码道 IDE（`out/main.js` 的 `PackageInfoService`、workbench 的 `ActivityWelfarePane`）
- **账户类型检测**：`package.is_credit_package === true` 即积分账户（文档要求「已升级到积分计费模式」）。领取第一步就判它，非积分账户回 `inactive` 而非 `failed`
- **幂等**：本协议无幂等键、无「今天已签到」业务码，唯一保护是活动列表的 `claimable` / `status` 预检（`status` ∈ {CLAIMED, CONFIRMED, CONSUMED} → `already-claimed`）
- ⚠️ **`refresh_token` 一次性轮换**：用一次即作废（`STS5.1806 the refresh token has been used`）。任何刷新都必须**立刻回写**新凭据；E2E 凭据读取（`tests/e2e/codearts-credential.ts`）**只读不刷新**
- `statistics/plugin` 是**裸对象**响应（无 `{code,data}` 包装），而 `ops/*` 有 —— 解析必须兼容两种信封
- ⚠️ **`/v1/ops/delivery` 的字段类型/名字与直觉不符**（实测 2026-09-18，两个坑叠加导致「1 个失败」）：
  - **`campaignId` 是数字**（`1`），不是字符串 → 必须用 `readIdentifier`（兼容数字/字符串），用只收字符串的 `readString` 会得到空串并判 `failed`「活动缺少 campaignId」
  - **可领积分字段是 `benefitAmount`**（`1000`），不是 `amount` → 读错会恒为 0
  - 不可领取的活动 `status` 是 **`null`**（不是字符串），`readString` 要能容忍
  - 完整真实 item 字段：`campaignId` / `title` / `type` / `benefitAmount` / `benefitUnit` / `displayConfig` / `pageUrl` / `claimable` / `hooks` / `extra` / `description` / `status` / `pendingCount` / `pendingTotalAmount`
- ⚠️ **单测必须用真实响应形状**：早期用例喂的是**编造的** `campaignId: 'c-1'` 与 `amount: 1000`，因此完全没抓到上面那个 bug。新用例直接用实测字段集合

三套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 两套协议共用

**积分余额（Credits Balance）** 也是**三套端点**，但语义一致（「查不到」与「余额为 0」严格区分）：

**CodeBuddy 系（buddy / workbuddy）** —— `POST /v2/billing/meter/get-user-resource`：

- body `{}`；响应**双层嵌套**：`data.Response.Data.Accounts[]`（签到是单层 `data`，此处最易解析错）
- 总额用各包 `CapacityRemainPrecise` 相加（实测 247.87+100=347.87），**不用**截断过的 `TotalDosage`（347）
- 包名回退链：`PackageName` → `SubProductName` → `PackageCode`
- 该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），静态搜索找不到，靠真实凭据实测发现

**LobsterAI** —— `GET /api/user/profile-summary`：

- 取 `data.totalCreditsRemaining`
- **不要**用 `/api/user/quota`：它只有 `freeCreditsTotal=300`，不含活动积分

**CodeArts** —— `GET /snap-manager/v1/statistics/plugin`（与账户类型检测**同一响应**）：

- 取 `metrics[]` 中 `usageTotalPackageCredit` 的 `package_credit_remain`；**不累加**基础/按需/赠送分类明细（它们是总额的构成项，相加会重复计算）
- 非积分账户的文案是「Token 计费账户，无积分余额」而非「查询失败」——账户类型差异不是故障。实现走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因

三者共同的约定：

- 累加后 `roundCredits` 规整两位小数（多包浮点噪声会放大成 655.67000031）
- 失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0
- RPC：`credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断：

| provider | `balance` | `dailyCheckin` |
|---|---|---|
| `codearts` | ✓ | ✓（华为云签名四步流程） |
| `buddy` | ✓ | ✓ |
| `workbuddy` | ✓ | ✗（国际版后端无签到接口） |
| `lobsterai` | ✓ | ✓（`client-activities` 三步流程） |

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，当时 CodeArts 无积分能力，面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障。**门控机制保留至今**，用于挡住真正未登记的 provider
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期 workbuddy 指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。
