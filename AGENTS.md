# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）、`lobsterai`（有道 **LobsterAI** / 龙虾）、`qoder`（阿里系 **Qoder**）与 `trae`（字节跳动 **TRAE**）五个 LLM provider 路由。

`buddy` 与 `workbuddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与上述两者**完全不同源**：登录方式、请求头、续期载荷、签到流程、版本号来源都不一样，因此实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 那里面 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 等字段对 LobsterAI 全部无意义。详见 README 的「LobsterAI provider」章节与 `docs/lobsterai-integration-plan.md`。

`qoder` 是**第五个、也是与其余四者都不同源**的协议族：**PKCE 设备码轮询**登录（不起本地监听端口）、续期请求体需带 **`machine_id`**、推理走**加密端点**（请求体由客户端内嵌 WASM 加密，响应套一层信封）。实现为独立一套 `src/qoder*.ts`（含 `qoder-wasm.ts` / `qoder-envelope.ts`），同样只共用架构模式。五个必须记住的点：

1. **两条推理路径认两套模型名，且 host 不同（最容易踩的坑）**：
   - **加密（本插件使用）**：`POST api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`，请求体与签名头由 WASM 生成，**认模型目录 key**（`qfmodel` / `dmodel`）。
   - **公开**：`POST api2-v2.qoder.sh/model/v1/chat/completions`，**认通用名**（`qwen-flash` / `qwen-plus`），目录 key 一律 `Unsupported model`。
   ⚠️ `api2.qoder.sh` 与 `api2-v2.qoder.sh` **不是同一个 host**，混用 404。配置项见 `QoderProduct.inferBase` / `encryptedInferBase`。
   **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」—— 把目录 key 发给了公开端点；随后又误判为「目录 key 不可用」而把表换成通用名，结果拿到 Qwen3.5/2.5 而非 3.8 系列。
2. **加密推理用 `src/qoder-wasm.ts`**（复用客户端内嵌 WASM 生成加密体与签名头）。**不是「破解密码学」** —— WASM 自己导出了成对编解码函数，我们只是调用它。响应**无需解密**，只在每帧外套一层信封，由 `src/qoder-envelope.ts` 剥离。
   ⚠️ **签名头必须原样透传**，用普通 `Bearer <token>` 覆盖会被判签名无效。
   ⚠️ 改这个文件前先读 **不入库**的 `docs/qoder-encryption-notes.md`：里面有 glue 约定、请求体字段结构与三个已踩过的坑（写错会得到 Rust panic 或 `null pointer passed to rust`），重新实现代价很高。
3. **模型列表恒用静态表**（`src/qoder-product.ts` 的 `fallbackModels`）：远端 `GET /algo/api/v2/model/list` 需 **WASM 签名**，故 `listModels` **不发网络请求**。
   表里是**17 个目录 key**（全部可用），取自客户端下发的模型目录。
   ⚠️ **请求体必须带 `business` 字段**（`business: { type: 'agent' }`）—— 缺了服务端会把请求路由到**故障节点** `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`。
   **真实缺陷**（2026-09-20 定位，极隐蔽）：`qfmodel`（Qwen3.8-Flash）因此「看起来不可用」，而**同一模型在 Qoder IDE 里完全正常**。
   ⚠️ **判据是「IDE 能否用同一模型」**：IDE 能用 → 是我们的请求缺东西，不是服务端故障。当时我错误地排除了 8 类假设（host / query / 明文体 / 模型配置字段 / 客户端版本 / 设备标识 / 会话类型 / 凭据字段），逐条记录见 `docs/qoder-encryption-notes.md` —— 别重复这条路。
   ⚠️ **其余模型恰好不受影响**，所以现象像「只有这一个模型坏」，极易误判为服务端故障。
   ⚠️ **展示名必须含模型名与版本，不能只写厂商**（用户报障：「看到的是 GLM、DeepSeek、MiniMax，只有厂商名字没有模型名字和版本」）。
   ⚠️ **改表必须逐个实发验证可推理**，不能只照抄目录 key。免费额度模型：`qmodel_38max` / `qfmodel`（e2e 探针默认用前者）。
   ⚠️ **错误帧必须能抛错**：Qoder 用独立 `event: error` 行 + 顶层 `{code,message,type}`，**不是** OpenAI 的 `{error:{message}}`。早期解析器只认后者 → 错误被静默当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」。见 `src/openai-compat.ts` 的 `consumeOpenAiSse`。
4. **轮询的 `404` 表示「用户尚未完成授权」，必须继续轮询，不是错误**。实测依据：该端点返回 404 而任意不存在的路径返回 401，说明它被网关豁免认证、由业务层报「会话未就绪」。轮询 host 是 **`openapi.qoder.sh`**（`qoder.com` 的同名路径返回 401）。
5. **prod 的 `client_id` 是 `J_a`（`e883ade2-…`），不是 `G_a`**。源码 `client_id: i ? J_a : G_a`，而调用点 `loginWithDeviceFlow` 传的第 4 参是 **`isProd()`**（`$Oa(){return "prod"===db()}`）—— prod 为 `true` 故用 `J_a`；`G_a`（`e93fe488-…`）只在 daily/test 用。
   ⚠️ **真实缺陷**（用户报障）：初版把第 4 参误读成「useIdeClientId」，于是 prod 用了 `G_a`，GitHub 授权点击后页面报「**参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder**」。根因是服务端在**授权回调阶段**才校验 client_id。
   ⚠️ **只靠入口 302 检查发现不了该错误**：`GET /device/selectAccounts` 对**任一** client_id（含全零 UUID）都返回 302。必须在源码层面核对第 4 参语义。见 `src/qoder-product.ts` 的 `clientId` / `testClientId` 字段注释。

⚠️ **`src/qoder-auth-wasm.wasm`（298 KB）随插件分发**，构建时由 `scripts/copy-assets.mjs` 复制到 `lib/`（`tsc` 不搬 `.wasm`）。`build:all` 已含该步骤。

⚠️ **WASM 提取自 Qoder `0.3.4`**（runtime `1.1.57`）。升级方式：

```
pnpm qoder:wasm            # 自动取 .qoder-versions 下版本号最高的
pnpm qoder:wasm 0.3.5      # 指定版本
pnpm build:assets          # 同步到 lib/
```

取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE **实际运行**不同的版本
（实测 IDE 跑 0.3.4）。刷新后**必须实测一次对话**（`qfmodel` / `qmodel_38max`）确认签名仍被接受。

它**有积分余额、无签到**（能力矩阵登记为 `{balance:true, dailyCheckin:false}`），并复用 `src/openai-compat.ts` 的 OpenAI 协议层共享实现（消息序列化 / SSE 消费 / 错误归类）。详见 README 的「Qoder provider」章节与 `docs/superpowers/specs/2026-09-19-qoder-provider-design.md`。

### ⚠️ Qoder 积分余额：路径在 `/sash/` 下，且只需 Bearer

`GET {openApiBase}/sash/api/v2/me/usage`（实现见 `src/qoder-credits.ts`），
请求头 `Authorization: Bearer` + **`Cosy-ClientType`**，**不需要** WASM 签名。

两个**真实踩过的坑**：

1. **只按 `/api/` 前缀搜端点会漏掉它** —— 它挂在 `/sash/` 下。早期据此误判
   「Qoder 无积分端点」并把能力登记成 `balance:false`（用户报障：
   「登录成功了，没有获取积分吗？现在应该是一个资源包 100 积分」）。
2. **余额不只在 `userQuota` 里** —— 实测 `userQuota.remaining=0` 而
   `addOnQuota.remaining=100`（资源包）。只读 `userQuota` 会显示 0。
   另有 `dedicatedResourcePackages` 需一并累加。

企业版（`displayMode:"enterprise"`）不下发额度数字、只给外部链接 →
返回 `null`（UI 显示「查询失败」）而非 `0`。

签到仍为 **false**：`/sash/api/v1/me/campaigns` 实测 `claimable:false`，
逆向未发现签到动作端点。**余额与签到是彼此独立的能力**，不可互相推断。

### ⚠️ `openai-compat.ts` 只服务 qoder，不要顺手重构既有适配器

`src/openai-compat.ts` 把「消息序列化 + SSE 消费」抽成共享实现给 **qoder 适配器**用。`buddy-adapter.ts` / `lobsterai-adapter.ts` **刻意不改用它** —— 那两份实现已被大量单测与线上流量验证，重构它们属于与本任务无关的高风险改动。若将来要统一，应作为独立任务并配以逐条对拍测试。

它承载的教训（改它时必须保留）：`delta.content` / `delta.reasoning_content` 会显式返回 **`null`**（必须 `typeof === 'string'` 判定）；孤儿工具调用须剔除（否则后端 400 且坏历史被反复重放）；`function.name` 只允许非空覆盖；残缺参数**不补 `{}`**（补了会让 harness 报 schema 错误而非重试）。

`trae` 同样**完全独立**（第五个脉系，独立一套 `src/trae*.ts`），且差异点与其他四者都不一样：认证用 **ExchangeToken 轮换 refreshToken**（不是轮询、也不是 authCode 交换）；鉴权头是 `Cloud-IDE-JWT <token>` 加十余个 `X-*` 身份头；**请求体需要从 OpenAI 格式转换为 SOLO 格式**（`function` / `config_name` / `tools.parameters` 序列化等）；**响应是 SOLO 自定义 SSE 事件**（`output` / `token_usage` / `done` / `error`），必须自行解析并转成 OpenAI chunk；凭据还必须持久化 `machine_id` 与 `device_id`（均为 **32 位 hex**，分别用作设备指纹与签到设备号，后者账号间必须互异）。**登录回调默认直接回传 token**（`auth_callback_url` 参数，老流程没有 `code`；但也并存 PKCE 新流程，两套都要认），详见下「TRAE 协议要点」。实现见 `docs/trae-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI、CodeArts 与 TRAE 四个面板提供** —— 国际版 WorkBuddy 后端没有签到接口、Qoder 无签到端点，故均不提供。四者是**四套互不相同的协议**（见下「积分领取」）。

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

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`traeAuth`）均遵循统一接口：

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

用户重新启用后拿到的是死凭据，只能重新登录。六个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，`QoderAuth` 注册为 `qoderAuth`，`TraeAuth` 注册为 `traeAuth`，互不覆盖。

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

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

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

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**，不能自行构造；请求体加密。积分余额端点另走纯 `Bearer`。
  - `trae`：`Cloud-IDE-JWT <token>` + `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-Machine-Id` / `X-Device-Id` / `X-Ide-Version` 等十余个身份头（**无签名**，**不带** JSON-RPC 包装）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**
- `qoder` 用独立的 `QoderAdapter`（协议不同源，见项目概述）；产品配置是 `src/qoder-product.ts` 的 `QoderProduct`，同样**平行而非继承**。它的 OpenAI 协议层逻辑复用 `src/openai-compat.ts`
- `trae` 用独立的 `TraeAdapter`（协议不同源）；它的产品配置是 `src/trae-product.ts` 的 `TraeProduct`，同样**平行而非继承**。与其它三个 provider 最根本的差异是**载荷与响应都要转换**：请求体经 `transformToSOLOBody` 转成 SOLO 格式，响应经 `parseTraeSSELine` 从 SOLO 自定义 SSE 转成 OpenAI chunk

## TRAE（字节跳动）协议要点（五个易踩的坑）

`trae` 的 chat 链路与其它 provider **全程不同构**，以下是实测/逆向确认的关键约束：

0. **⭐ 必须先做「消息序列化」，再做载荷转换**（`serializeTraeMessages`）：
   DSH 交给适配器的 `options.messages` 是**原生块结构**
   （`content:[{type:'tool-call'}]` / `[{type:'tool-result'}]` / `[{type:'reasoning'}]`），
   **不是** OpenAI wire 格式。必须先转成 `tool_calls` + 独立 `role:'tool'` 消息，
   **再**交给 `transformToSOLOBody`（后者只认识 `type:'text'`）。

   **真实缺陷**：早期实现把原生块**原样**透传，后果是**每一轮多步对话都坏掉**：
   `tool-call` 不是 SOLO 认识的字段 → **模型看不到自己调用过什么**；
   `tool-result` 同样不被识别 → **模型永远看不到工具返回值**，于是反复请求
   同一个工具或凭空编造结果。全程**没有任何报错**，极难排查。
   三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts`）
   都有这一步，只有 TRAE 漏了 —— 本文件甚至早已 `import` 了
   `resolveToolPairing` 却从未使用，说明当初打算写但没接上。
   已由 `tests/unit/trae-adapter.spec.ts` 的「消息序列化（真实缺陷回归）」锁死。
1. **请求体必须转换，不能透传**（`transformToSOLOBody`）：
   - `stream` 强制 `true`；注入 `function: "solo_work_lite"`（实测 `work` / `solo` / `work_lite` 均无效）
   - `model` 同时写入 `config_name` 与 `model` 两个字段；内部名后缀 `__dev` 需去除
   - `messages[].content` 字符串 → `[{type:"text",text:...}]`
   - assistant 的 `tool_calls[].function` → **`function_call`**（SOLO 字段名），无 `name` 的条目须剔除（上游 `FunctionCall.Name` 必填）
   - ⚠️ **`tools[].function.parameters` 必须序列化为 JSON 字符串**（SOLO 上游要求 string，OpenAI 标准是 object）。因此 **tools 必须放进源的 OpenAI 对象里再交给转换函数** —— 若在转换**之后**再补 `bodyObj.tools`，`normalizeTools` 已执行完毕，parameters 会保持对象形态发给上游被拒（真实缺陷，已由 `tests/unit/trae-adapter.spec.ts` 锁死）
2. **响应是 SOLO 自定义 SSE，不是 OpenAI 格式**（`parseTraeSSELine` / `aggregateTraeSSE`）：事件为 `metadata` / `timing_cost` / `output` / `extra_info` / `token_usage` / `done` / `error`；正文在 `output.response`、思考在 `output.reasoning_content`；`tool_calls` 内层同样用 `function_call` 字段且带 SOLO 专属的 `namespace` / `partial_arguments`（须清理掉，只留标准 `function.{name,arguments}`）。解析须兼容 `data: {...}` 与 `data:{...}`（实测无空格）
3. **凭据必须持久化两个机器指纹**（`buildTraeCredential` / `applyTraeRefresh`）：
   - `machine_id`：**32 位 hex** 设备指纹。**续期时绝不可重新生成** —— 服务端按它标识设备，换了可能要求重新登录
   - `device_id`：**32 位 hex** 签到设备号（`login.sh:34` 的 `openssl rand -hex 16`，与 machine_id 同格式）。**账号间必须互异**，同一天两账号共用会被「该设备已签到」拦截；为空则签到报 9004
4. **`4001 param is invalid` 有三个独立成因**（见下「TRAE 的『通道（`function`）』」）：
   最普遍的是**发错了通道**（模型只在列出它的通道里可调用）；其次是模型本身是
   `is_custom_model` 条目；再次是**请求头被叠成重复值**（`content-type` 大小写各写一次）。
   早期把 `4001` 归因于 `X-Ide-Version` 过低（`0.1.43` 请求 `glm-5.3` 报错、
   `0.1.52` 正常）—— **本次复测未能重现该结论**：`glm-5.3` 在 `0.1.52` 与 `0.1.43`
   下**都**正常返回，故该归因**不足以作为 `4001` 的解释**，已降级为「未复现的旧观察」。

其它要点：`exchange` 的 `refresh_token` 会**轮换**（续期后必须回写）；错误分类见 `src/trae-errors.ts`，其中 `4008`（配额耗尽）与 `1005`（plan 权益不足）是 TRAE 最主要的失败模式。

### ⚠️ TRAE 的「通道（`function`）」：模型只在列出它的通道里可调用

**真实缺陷**（用户报障「使用模型时报 `trae: We're sorry, the param is invalid.
Please try with a valid param. (code=4001)`」）。

#### 症状定位

该文案**只**在 `src/trae-adapter.ts` 的 `consumeSse` 流内 `event:error` 分支拼出 ——
说明 **HTTP 是 200**（请求已被接受），上游在**参数校验阶段**才拒绝。

#### 三个独立成因（都实测过，别混为一谈）

| 成因 | 判据 | 实测 |
|---|---|---|
| ① 模型是「需自行配置的自定义模型」 | `display_config.is_custom_model === true` | **5/5 命中、0 误报** |
| ② **发错了通道** | 该模型不在所发 `function` 的目录里 | 见下路由矩阵 |
| ③ 请求头 `content-type` 被叠成重复值 | 实际发出 `"application/json, application/json"` | HTTP 400 + `code=4001 binding: … missing required parameter` |

**①** 的 5 个条目（2026-09-19 快照）：`deepseek-v4-flash` / `glm-5.3-flash` /
`qwen3.8-flash` / `agnes-2.5-flash` / `silk-gpt-5.6-luna`。

> ⚠️ **该名单已过期，不要再据此删模型**（复测 2026-09-20）：`deepseek-v4-flash` /
> `agnes-2.5-flash` / `silk-gpt-5.6-luna` 已**下架**；`glm-5.3-flash` /
> `qwen3.8-flash` 已转为 `is_custom_model: false`，**是正常可调用的合法模型**；
> 全目录 custom 条目数为 **0**。判据是**标志的值**，不是模型名 —— 曾把
> `qwen3.8-flash` 误记为「应被剔除」，差点误删一个可用模型。

**② 是本节重点**。实测路由矩阵（2026-09-19，逐模型 × 逐通道）：

| model | `solo_agent_remote` | `solo_work_lite` |
|---|---|---|
| `glm-5.2` / `kimi-k3` | OK | OK |
| `glm-5.1` / `qwen-3.5` / `Doubao-Seed-Code` | **OK** | 流内 `4001` |
| `glm-5-turbo` / `sagitta` / `seed-code-pro-0430` | 流内 `4001` | **OK** |

即**「模型属于哪个通道，就只能在那个通道里调用」**。旧实现把 `function` 写死
`solo_work_lite`，于是 agent 专有模型一用就报 `4001`。

**③ 是排查时最容易自伤的**：`{ ...headers, 'content-type': 'application/json' }`
与已有的 `Content-Type` 大小写不同，`Headers` 按 `append` 语义**合并**成非法值。
**写探针/代码时务必用 `new Headers(base).set(...)`，不要用对象展开叠同名头。**

#### 通道目录怎么拿：`batch_get_detail_param`（**不是** `get_detail_param`）

真实 CN IDE 用的是**批量**端点，一次传多个 `functions`，响应 `function_configs[]`
为**每个通道各自一套** `config_info_list`：

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
{ "functions": ["solo_work_lite","solo_agent_remote"], "show_custom_model": true,
  "agent_type": "", "current_config_info": {"config_name":"","is_custom_model":false},
  "mode_type": 0, "access_type": 0, "ab_force_vids": "", "ab_autotest_advanced_mode": 0 }
```

单 function 的 `get_detail_param` 只能拿一个通道的目录，**不要**再用它。

#### 「可调用」与「官方可见」是两个独立维度

| 标志 | 含义 | 本插件处理 |
|---|---|---|
| `display_config.is_custom_model` | 需在 IDE 内自行绑定供应商 | **必须剔除**（必然 4001） |
| `config_switch === false` | 上游已停用 | **必须剔除** |
| `is_invisible_to_user` | **官方 picker 不展示** | **必须剔除**（硬性，使目录与官方 Auto Mode 一致） |
| `usage !== 'chat_completion'` | 非对话用途（summary / fast_apply / multimodal…） | **必须剔除** |

> **历史修正**：早期实现把 `is_invisible_to_user` 当作「两个独立维度」而默认保留
> （理由是实测 `glm-5.1` 被官方隐藏却**可调用**）。后来用户要求目录与官方
> **Auto Mode 选择器完全一致**，该标志遂改为**硬性过滤** —— 代价是
> `glm-5.1` / `qwen-3.5` 等「可调用但官方不展示」的模型不再出现在目录里
> （目录 47 → 29）。这是**有意的取舍**（对齐官方 UI），不是回归；
> 被过滤的模型若已被持久化为会话模型，`resolveModel` 仍能解析。
> 需要临时放宽时改 `parseTraeBatchModelList` 的过滤条件，不要动
> `isTraeModelCallable`（那里管的是「必然调不通」）。

#### 远端参数必须消费（这一条曾被整段漏掉）

- `context_window_tokens.dev` → `contextWindow`。⚠️ 常规会话用 `dev`
  （条目形如 `{dev:200000, max:1000000}`）；`max` 只在**开启 Max 模式**时才声明
  （见下「TRAE 的 Max 模式」），无脑采信 `max` 会让 DSH 以为有 1M 窗口而实际请求被拒。
- `model_detail_list[].max_tokens` → `maxOutputTokens`。实测**主流模型是 32000**
  （旧兜底表写的 131072 / 128000 是估值，**已被推翻**）；多条明细优先取 `__dev` 那条，
  Max 模式那条（`__max`）另存为 `maxModeOutputTokens`。
- `reasoning_effort_config` → `reasoningConfig`（见下「TRAE 的推理强度档位」）。

**真实缺陷**：接口 `TraeRemoteModel` 早已声明这两个字段、`contextWindowFor` /
`maxOutputTokensFor` 也在读，但解析器**从未填充** → 远端值被静默忽略、恒回退兜底表
估值。现由 `parseTraeBatchModelList` 填充，兜底表数值同步修正为 200000 / 32000。

#### TRAE 的推理强度档位（`reasoning_effort_config`）

真实条目：

```json
"reasoning_effort_config": {
  "default_level": "high",
  "options": ["light", "high", "extra_high"],
  "support_thinking": true
}
```

要点：

- **`options` 是单值字符串**，既是产品侧档位名、也是发给上游 `reasoning_effort` 的
  wire 值。⚠️ 这与 LobsterAI 的 `level` / `openclawLevel` **双字段**形态不同 ——
  不要照搬那张映射表；TRAE 的展示名表（`TRAE_EFFORT_NAMES`）**只用于美化**，
  不参与 wire 取值。
- 不声明 `reasoning` 的两种情形：**远端没有该配置**（UI 显示「当前模型未提供
  推理等级」）与 **`support_thinking === false`**（远端明确说不支持思考）。
  后者若照旧声明档位，会让用户选一个发了也没用的值。
- ⚠️ **默认档取「最强档」，不采信远端的 `default_level`**：上游那个是它自己的保守
  默认（实测多为 `high`，而最高档常是 `extra_high`）。用户要求「所有模型默认用 max」，
  故 `strongestTraeEffort` 按三条规则逐级退化挑默认值：
  1. `options` 里显式含 `max` → 用它；
  2. 否则取 `TRAE_EFFORT_RANK` 里排名最高的（`light < high < extra_high < xhigh < max`）；
  3. 全都未登记（上游新增档位）→ 取数组**末项**（远端按强度升序给出）。
  `TRAE_EFFORT_RANK` **只用于挑默认档**，不参与 wire 取值。
- `defaultEffort` 必须落在 `efforts` 内 —— DSH 会拿它直接发请求，给一个不存在的
  档位会抛 `UNSUPPORTED_REASONING_EFFORT`。因为取值来自 `options` 本身，天然满足。
  实测 DSH 侧物化逻辑：`dsh-llm` 的 `LlmRuntime` 在 `requested ?? reasoning.defaultEffort`
  处把默认档写进 `config.reasoningEffort`（调用方不传时），并校验成员关系 ——
  所以**只声明 `defaultEffort` 即可**，适配器不必自己补发 `reasoning_effort`。
- 下发：`stream()` 把 `options.reasoningEffort` 原样写进 `reasoning_effort`，
  **不做白名单校验**（校验只会把「远端新增档位」变成静默丢弃）。
- ⚠️ `options` 为**对象数组**（`{level, openclawLevel}`）时取 `openclawLevel`、
  回退 `level` —— 这是防御性兼容：上游若改成双字段形态，解析不会退化成空数组。

#### TRAE 的 Max 模式（1M 上下文，**默认开启**）

`display_config.max_mode === true` 的模型支持 **Max 模式**（1M 窗口）。协议逆向自
`Trae2api-cn/src/trae_remote_client.py:249-397`（`_max_mode_requested` /
`_max_mode_fields`），要点：

- **不能只把 `max_tokens` 调大**：上游按 `strategy=max` +
  `model_auto_selection.strategy=max` 判定「这是 Max 会话」，缺了它们只会被当成
  常规会话、按 200K 校验，然后拒绝 1M 的输入。三件套
  （`context_window_size` / `prompt_max_tokens` / `max_tokens`）必须**成套**下发。
- 常量：1M 窗口 / **936K** 提示词预算 / **64K** 输出上限 / `mode_type: 1`
  （`TRAE_MAX_CONTEXT_TOKENS` 等）。936K < 1M 是刻意的 —— 给输出留位。
- ⚠️ **默认开启**（用户要求「上下文用最大的那一档」）：`resolveMaxModeFlag` 只有
  见到显式假值（`DSH_TRAE_MAX_MODE=0`/`false`/`no`/`off`）才关闭。**不要**改回
  `isTruthyFlag`（那是「默认关」语义，混用会让开关静默失效）。
- ⚠️ **三个条件缺一不可**（`TraeAdapter.maxModeFor`）：
  1. 产品级 `DSH_TRAE_MAX_MODE` **未关**（默认开；Max 会话计费倍率不同，要省额度时设 `0`）；
  2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套 Max 参数，
     CN 项目原注释明写 *"Never fabricate max limits for a model the account config
     does not mark"*，上游会拒；
  3. `DSH_TRAE_MAX_MODELS` 白名单（留空/含 `*` = 全部）。
- 未标 `max_mode` 的模型即便开关为开也**仍走 `dev`(200K)** —— 开启不会让任何模型失败，
  这部分「最大的那一档」就是它自己能用的最大档。
- **注入点在 `clampTraeMaxTokens` 之后**：Max 会话的输出上限由 `__max` 明细声明
  （实测 `custom_model_1M__max` 384000 vs `__dev` 64000），被 64K clamp 覆盖会让
  Max 请求与常规请求的输出预算相同、失去意义。
- `resolveModel` 同步切换：Max 生效时 `contextWindow` 用 `max`（1M）、
  `defaultMaxTokens` 用 `maxModeOutputTokens`；未生效时仍用 `dev`（200K）。
  **两者绝不能混用** —— 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，
  上游按 200K 校验后拒绝。

#### ⚠️ TRAE **支持图片**，但必须逐模型判定（Issue #IKHDKC）

**真实缺陷**（用户报障「TRAE字节 模型不支持图片」）：早期 `inputModalitiesFor`
恒返回 `['text']`（参数名是 `_model`，即**刻意忽略模型**），理由写的是
「SOLO 通道未见图片能力」。后果不只是「少个功能」——`inputModalities` 是
**DSH 的准入闸门**，图片在**附件入库阶段**就被拒
（`session/attachment-invalid`），用户看到「当前模型不支持图片，请切换支持
图片的模型」，而报错把原因指向**模型**，真实原因是**插件**。

**实测证伪**（2026-09-21，真实凭据）：

1. 远端目录**一直**在 `display_config.multimodal` 里声明该能力 —— 它与
   `max_mode` / `is_custom_model` 是**同一层级的相邻字段**，当初读了一个漏了另一个
   （52 个可调用条目中 27 个为 `true`；本插件可见集 19 个中 15 个为 `true`）；
2. **直发图片，模型真的看得见**：纯红图答「红色」、纯蓝图答「蓝色」、
   不带图答「无法确定」—— 三次答案不同，且无图时思考链明说「并没有提供图片」。
   ⚠️ 只验「不报错」不够：**静默丢图同样不报错**，必须做这种三连对照；
3. **反向对照定死判据**：`multimodal: false` 的模型（`DeepSeek-V4-Pro-Official`）
   收到图后答「无法确定」、思考链说「但没有图片」，**与不带图的回答一致**
   → 该标志是**权威准入判据**，不能按 provider 一刀切。

⚠️ **两个字段是两种独立能力，不可合并**：`multimodal`（用户贴图）与
`tool_response_multimodal`（工具结果图能否回传）。实测 `deepseek-v4.1-flash`
前者 `true`、后者 `false`；Doubao / Kimi 系列两者皆 `true`。
本插件**只消费 `multimodal`**，另一个仅保留信息。

⚠️ **请求形态无需协议逆向**：`transformToSOLOBody` 对**数组形态的 content
原样透传**，所以 OpenAI 的 `{type:'image_url',image_url:{url}}`（data URL）
直发即被接受 —— 与 buddy / lobsterai 适配器**完全同款**，没有 TRAE 专属转换。

落点（四处）：

1. `src/trae.ts`：`TraeRemoteModel` 加 `multimodal` / `toolResponseMultimodal`，
   `parseTraeConfigEntry` 与 `maxMode` 相邻处读取（含 PascalCase 回退）；
2. `inputModalitiesFor(model)` 改为 `remoteMeta.get(model)?.multimodal === true
   ? ['text','image'] : ['text']`（**未声明按不支持**，不臆造能力）；
3. `listModels` / `resolveModel` **两个出口**都改用它（漏一个闸门仍会拦图）；
4. `stream()`：按模型判定 —— 声明支持则读 `readImage` 字节转 data URL
   （`collectImages` 递归收集 + `userContentParts` 递归序列化，
   **两侧必须对称**）；不支持则明确报错且**不发请求**。

⚠️ `readImage` 必须由 `index.ts` 桥接（`makeReadImage(ctx)`）。缺失时收到图片
报「需要附件服务」而**不是**静默丢图；字节读取失败时留 `[image unavailable]`
占位符（空 Map 不能降级为 undefined，否则占位符也被跳过）。

#### 修法落点（四处）

1. `parseTraeBatchModelList`（`src/trae.ts`）按通道合并目录，每条记上 `function`
   与三个标志；同一 `config_name` 出现在多个 function 时**后面的覆盖前面的**
   （后面的条目带更完整的 `reasoning_effort_config` / `model_detail_list`）。
   同时执行三条硬性过滤：`usage !== 'chat_completion'` / `config_switch === false` /
   `is_invisible_to_user === true` 全部剔除。
2. `TraeAdapter.listModels` 过滤掉 `is_custom_model === true` 与 `isHidden === true`
   （`remoteMeta` 保留全量，已持久化的模型 id 仍可解析）。
3. `TraeAdapter.channelFor(model)` → `transformToSOLOBody(body, undefined, channel)`：
   **发送时按该模型所属通道下发 `function`**，查不到才回退 `product.function`。
4. `traeStreamErrorMessage` 给 `4001` 追加「模型不被上游接受」，同时**保留**上游原文
   与错误码。其余错误码保持原文，**不做无依据的解释**。

> ⚠️ `hideInternalModels`（`DSH_TRAE_HIDE_INTERNAL`）与 `isTraeModelUsable` 的
> `hideInternal` 参数**已废弃**：`is_invisible_to_user` 现在是**硬性过滤**，因为
> 目录要与官方 Auto Mode 选择器一致。字段保留仅为兼容既有 profile。
> `channels` 默认已改为 `['solo_agent', 'solo_work_lite', 'solo_agent_remote']`，
> 首位 `solo_agent` 对应截图 Auto Mode 的模型列表。

#### 真实 CN IDE 的其它情报（Reqable 抓包，`Trae CN.exe 3.3.94`）

- 头：`x-ide-version: 3.3.94` / `20260820`、`x-app-version: default`、
  `package-type: stable_cn`、`x-lgw-req-sdk-type: 3`、UA `TraeClient/TTNet`；
  `x-machine-id` 是 **64 hex**、`x-device-id` 是 **16 位数字** —— 与本插件的
  32hex/32hex **不同**（本插件走的是旧 SOLO 协议，勿照搬）。
- `llm_utils_chat` / `create_agent_task` 的**请求体是加密的**（配 `x-helios` /
  `x-medusa` / `x-neptune` / `x-request-pin` / `x-requested-at`）。实测**仅换版本头
  解不开**加密的那批模型（`deepseek-v4-flash` 等仍失败）→ 门槛是加密信封本身，
  属独立工作量，**尚未实现**。
- 另有 22 个 function（`chat_v3` 58 / `builder_v3` 51 / `solo_coder` 46 / `solo_agent`
  66 …）与非对话通道（`multimodal` / `system_diagnosis`）；本插件只默认启用实测过的
  `solo_work_lite` + `solo_agent_remote`（`DSH_TRAE_CHANNELS` 可覆盖）。

> **排除性证据**（都做过，别重复走）：消息序列化 / `tools.parameters` / 多轮
> `tool_calls`+`tool` 结果、`max_tokens`（64000 与 128000）**全部通过**；
> 兜底表 id 也都真实存在；`X-Ide-Version` 的旧归因**未复现**（`glm-5.3` 在
> `0.1.43` 与 `0.1.52` 下都通过）。
> ⚠️ 曾经把上面的 ③ 误判为「突发限流」和「host 不匹配」——两次都是错的。
> **全 4001 时先检查自己发的头**，再怀疑上游。

### ⚠️ 登录回调**没有** `code`：直接回传 token，参数名是 `auth_callback_url`

**真实缺陷**（用户报障「网页一直停在认证中的界面」）：早期实现按 OAuth 惯例
把 TRAE 当成标准的授权码流程，于是：

1. 登录 URL 只发了 5 个参数，且回调地址用了 `callback_url` / `redirect_uri` ——
   **真实参数名是 `auth_callback_url`**。名字错了 TRAE 拿不到回调地址，
   登录页既不跳转也不回传任何东西；
2. 回调解析去找 `?code=` —— 而真实回调**根本没有该参数**，它直接回传
   `refreshToken` / `userInfo` / `userJwt`。于是 `parseTraeCallback` 恒判失败
   → 回调服务器回 400 → `result` Promise **永不落定**
   → 前端 `login.poll` 永远拿不到 `done:true` → **一直显示「认证中」**。

正确的登录 URL 是 **18 个参数**（唯一权威：`login.sh:47-72` /
Go 端 `BuildLoginURL`）：`login_version=1`、`auth_from=solo`、
`login_channel=native_ide`、`plugin_version=2.3.62834`、`auth_type=local`、
`client_id`、`redirect=0`、`login_trace_id`（hex16，回调据此反查 pending）、
`auth_callback_url`、`machine_id`、`device_id` 与 `x_machine_id` / `x_device_id`
/ `x_device_brand=PC` / `x_device_type=PC` / `x_os_version=1.0` /
`x_app_version` / `x_app_type=stable`。

真实回调形态：

```
http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
```

要点：

- `plugin_version`（`2.3.62834`）与 `ideVersion`（`0.1.52`）是**两个独立字段**：
  前者给登录门户，后者是 chat 端点的模型准入版本，不可混用
- 解析容错对齐 `login.sh:153-166`：`refreshToken` 缺失时回退
  `userJwt.RefreshToken`；两者都缺才用 `userJwt.Token` 兜底
- ⚠️ 回调的 `userInfo` 字段名是 **`TenantID`**（不是 `EnterpriseID`），
  且中文昵称存在**双重编码**乱码（实测 `Óû§8847309959`），
  须按 `fixNicknameMojibake` 回转，修不好则回退「用户+uid末4位」
- `device_id` 是 **hex32**（`login.sh:34` 的 `openssl rand -hex 16`），
  早期误用「16 位纯数字」（那是 CodeBuddy 的签到格式）

#### ⚠️ 但「带 `code` 的回调」**不是**无效回调（第二次修正，避免过度断言）

上面那条结论只说明「token 直传」是**当时实测的**流程，**不能**推广成
「带 `code` 即非法」。`Trae2api-cn/src/main.py:478-484` 的注释写明了真相：

```
1. 新流程 (code_challenge): callback 会带 authCodeInfo / code 等参数
2. 老流程 (refreshToken):    callback 直接带 refreshToken=xxx
```

**两套流程并存**。若把带 `code` 的回调一律判为「无效」，一旦上游把登录门户
切到 PKCE 新流程，**合法回调会被误判为失败**，症状与「一直认证中」一模一样，
而报错文案（「缺少 refreshToken」）会把排查方向带偏。

正确做法：`parseTraeCallbackDetailed` 对两种形态**都返回结果**，用
`authCodeFlow: true` 区分，并给出「上游返回了 PKCE 授权码，本实现暂不支持该
流程」这种**指向真实原因**的文案。注意 `authCodeInfo` 可能是 JSON
（`{code:...}`）也可能是**纯 code 字符串**，两种都要认。

> 教训：把「某次实测没见到 X」写成「X 一定不存在」是很危险的断言 ——
> 它会把未来的正常情况判成故障，且错误信息指向错误的方向。

#### ⚠️ 无效回调**必须落定结果 Promise**（第二个「一直认证中」根因）

`startTraeLoginFlow` 与 `startCallbackServer`（`src/trae-oauth.ts`）**两个**
回调处理器里，解析失败的分支早期都只写了：

```ts
res.writeHead(400, ...); res.end(...); return   // ← 没有 resolve 也没有 reject
```

结果 Promise 悬空 → 前端 `login.poll` 永远拿不到 `done:true` →
**界面永久停在「认证中」**，只能等 10 分钟超时。

这与「参数名写错」是**两个独立根因、同一个症状**：修好协议解析并不能顺带
修掉它，必须单独保证「**任何**回调路径都落定 Promise」。
`startCallbackServer` 是 `TraeAuth` / RPC 实际走的路径，漏改它同样致命 ——
两处都要有 `reject(...)`。

回归用例：`tests/unit/trae-oauth.spec.ts` 的「无任何可用参数的回调也必须落定
结果」。注意用例必须**先挂拒绝处理器再触发回调**，否则窗口期内它是未处理拒绝。

### ⚠️ 本地回调服务器：listen 失败必须先注册 `error`，否则崩掉整个宿主

`startTraeLoginFlow` / `startCallbackServer`（`src/trae-oauth.ts`）里，
`server.listen()` 的失败（最典型 `EADDRINUSE`：端口被占用）是**通过
`'error'` 事件异步抛出**的，**不属于 Promise 链** —— `await` 一个内部调用
`listen()` 的 Promise **捕获不到**它。

**真实缺陷**（用户报障，进程级崩溃）：早期实现直接 `server.listen(18080)`，
没给 `'error'` 注册处理器。于是 18080 被占用时：

- 该错误逃过 RPC 层的 `try/catch`；
- 成为**进程级 unhandled error**，把**整个 DSH 宿主**打挂；
- 用户看到的不是可读文案，而是一整堆
  `Error: listen EADDRINUSE: address already in use :::18080` + 堆栈 + 进程退出。

修法（`listenOrReject`，三处缺一不可）：

1. **在 `listen()` 之前**注册 `'error'`，把首个错误转成 Promise reject，
   让 RPC 层能照常返回规范错误响应；
2. 启动成功后把一次性处理器**降级为常驻监听** —— 运行期也可能出现 `'error'`
   （如 EMFILE），没有监听者会再次变成进程级崩溃；
3. 绑定 **`127.0.0.1`** 而非 `::`/`0.0.0.0`：这是本地 OAuth 回调，绑定所有
   网卡会让同局域网的机器也能投递伪造的 `?code=`，把攻击者的授权码写进用户
   凭据（`src/login.ts` 与 `src/lobsterai-oauth.ts` 同样只绑回环）。

配套：端口被占用时**回退到系统分配的随机端口**（`listenWithFallback`），
而不是直接失败。TRAE 的 `redirect_uri` 是我们自己构造并随登录 URL 下发的，
服务端原样回跳 —— 因此端口不固定也能工作。**注意顺序**：必须先 `listen`
拿到实际端口，**再**构造 `redirect_uri`（否则回调会打到没人监听的地址）。
这与 CodeArts 的 `listenOnCallbackPort` 同思路。

> 排查提示：Windows 上 `::` 与 `127.0.0.1` 是**两套可共存的栈**。写「端口占用」
> 的测试时，占位方必须绑与服务端**相同的地址族**，否则产品侧仍能绑定成功，
> 用例变成假阳性（本模块的 `tests/unit/trae-oauth.spec.ts` 踩过这个坑）。

### ⚠️ 错误分类必须先判更严重的类别

`classifyTraeError` 的判定顺序里，**`quota-exceeded`（4008）必须排在 `soft-rate`（4011）之前**。

两者可能同时出现在一个响应体里（网关把多个错误码拼在 msg 中）。`quota-exceeded` 需长冷却，`soft-rate` 只需短冷却 —— 让较轻的类别抢先命中，会让一个已耗尽额度的账号在 60 秒后被反复重试，用户看到的却是「稍后再试」。**真实缺陷**：早期实现把 4011 放在前面，`tests/unit/trae-errors.spec.ts` 已锁死该顺序。

### ⚠️ 续期的终态判定要看三种依据

`TraeAuth.refreshCredential` 判定「需重新登录」有三种独立依据，缺任一种都会让用户卡在无解的重试里：

1. HTTP 401 / 403（状态码最权威）
2. 分类结果为 `session-dead`
3. **拿到了 2xx、响应体也是 JSON，却没有 `accessToken`** —— 对齐 Go 的 `refresh_failed: no token in response — re-login required` 与 `LobsteraiAuth` 的同款处理。这不是瞬时故障，重试一万次也不会有 token

反之，**传输层失败（网络抖动）与 5xx 必须是可重试的普通 Error**，否则一次瞬时故障就让用户重新登录。另外响应体要**先取文本再解析**（不要直接 `response.json()`）：凭据失效时网关返回 HTML，`json()` 抛出的 `Unexpected token '<'` 对用户毫无意义。

### ⚠️ TRAE 签到：请求头与设备身份必须对齐真实客户端（`trae-mate` 实证）

**真实缺陷**（用户报障「模型没问题了，但签到有问题」）。参考实现
`E:\Workplace\APP\Tauri\trae-mate\src-tauri\src\checkin.rs` 是**能正确签到**的版本，
与旧实现有三处根本差异（旧实现在此之前只有 6 个精简头 + `{"req_source":2}`）：

| 维度 | 旧实现（失败） | trae-mate（成功） |
|---|---|---|
| 请求头 | 6 个（`Content-Type` / `Accept` / UA / `Authorization` / `X-User-Region` / `X-Device-Id`） | **约 20 个**客户端头 |
| 设备号 | `deriveCheckinDeviceId(credential.device_id, gen)`（32 hex） | **基于 `user_id` 确定性派生的 15 位数字** |
| claim body | `{"req_source":2}` | **`{}`** |

要点（`traeCheckinHeaders` 已全部落地）：

- **设备身份是「每账号一套、稳定派生」**，不是从凭据的 `device_id` 取。三件套
  （对齐 `device_map.rs`，salt 各不同）：
  - `X-Device-Id`：15 位数字（`seededDigits(15, uid, 'devid')`）
  - `X-Market-User-Id`：UUID v4（`seededStream(uid,'market',16)`，置 version/variant 位）
  - `Vscode-Sessionid`：64 hex（`seededStream(uid,'sess',32)`）
  同一 `uid` 永远得到同一套值 → 多账号天然互异，规避「每设备每天一次」配额。
- 新增头：`X-Market-Client-Id` / `X-Lgw-Req-Sdk-Type: 3` / `Package-Type: stable_cn` /
  `X-Lscbd-Aid: 787976` / `X-Lscbd-Platform` / `App-Version` / `X-Tt-Trace-Id` /
  `X-Request-Id`（**每请求刷新**）/ `Sec-Fetch-*`。
- **签到与余额都要用完整头**（`postJson` 统一走 `traeCheckinHeaders`）；
  `traeUgHeaders` 保留给其它 Ug 场景。
- **积分余额 body 改为 `{"require_usage": true, "req_source": 2}`**（不是 `{}`）——
  不带它拿不到 `usage`，余额会恒等于额度。
- **9074 不再换设备号重试**：设备身份已由 `uid` 确定性决定、每账号独立，
  「换个派生 id 立刻成功」的旧前提不成立。命中 9074 时归为 `BusinessError`（300s 冷却）
  并如实上报。
- ⚠️ **claim 响应不含积分数，必须补查 status**：`checkin_credits/claim` 的完整响应
  就是 `{"code":0,"message":"success"}`。**真实用户报障**：「领取积分显示成功但是加
  0 积分」—— 早期实现读 claim 响应的 `credits`，而该字段根本不存在，故**恒为 0**。
  所得数值只在 **status 端点**的 `credits` 字段里（实测 `150`，与积分余额中
  「签到奖励」包的 `credits_limit:150` 吻合）。现在 `claimTraeDailyCheckin` 在
  `code === 0` 后补查一次 status；补查失败时 `credit` 为 0 但**仍是 claimed**
  （不因补查失败而把成功判成失败）。
- ⚠️ **claim 对「今天已签到」是幂等的**：实测重复领取同样返回
  `{code:0, message:"success"}`，与真正成功**无法区分**。因此 `credits.claimAll`
  的 TRAE 分支**必须开启状态预检**（`collectClaimResults` 的 `precheckStatus` 保持
  默认 true 并注入 `fetchStatus`）—— 早期照抄 LobsterAI 传了 `precheckStatus: false`
  （那是「LobsterAI 领取流程内部已做 slot/context 预检」的理由，TRAE 没有这回事），
  于是已签到的账号被报成「领取成功」。判据只能是 status 的 `checked_in`。
  已有源码级守卫（`tests/unit/jet-hub-rpc.spec.ts` 的「TRAE 的 claim 分支开启状态预检」）。
- **错误分类**（`classifyTraeCheckinError`，对齐 `cooldown.rs`）：
  `200+1005 → PlanLimit(12h)` / `429 → SoftRate(60s)` / `401 → SessionDead(永久)` /
  `404 → NotFound(60s)` / `5xx → Server(600s)` / `4xx → Client(600s)` /
  `业务码非0 → BusinessError(300s)`。
- ⚠️ **网络异常与业务失败必须分开**：`postJson` 区分 `httpStatus === 0`（传输层失败，
  可重试）与有状态码（业务失败，**不**重试）。重试只针对前者。

> 旧实现里 `deriveCheckinDeviceId` / `AccountPool.traeCheckinDeviceGeneration*` /
> `TRAE_CHECKIN_BUSY_CODE` 的轮换链路**保留但不再被调用**，仅为兼容既有账号条目；
> 新语义下设备号由 `uid` 派生，无需持久化代次。

### ⚠️ 历史超过约 500K 字符时上游会**静默断流**

上游在请求体过大时会**不发错误码、直接结束事件流** —— 日志里看到的只是「模型
没有回复」，不是任何 4xx/5xx。CN 项目为此设了两道闸门
（`TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 与 `TRAE_REMOTE_QUERY_MAX_CHARS=480000`）。

`trimTraeHistory`（`src/trae-adapter.ts`）取其下沿作默认预算
（`DSH_TRAE_MAX_HISTORY_CHARS` 可覆盖），三条约束：

1. **从最早的非系统消息开始丢**，最近历史（尤其本轮工具结果）必须保住；
2. ⚠️ **以「轮」为单位裁剪，绝不切断 tool_call / tool 配对** —— 带 `tool_calls`
   的 assistant 必须连同其后的 `role:'tool'` 结果一起丢，丢一半会被上游 400 拒绝；
3. **system 消息永不裁剪**（不假设它都在开头，用逐条标记而非下标切片）。

⚠️ **裁剪必须在 `serializeTraeMessages` 之后**做 —— 裁的是 OpenAI wire 消息，
不是 DSH 原生块。

### ⚠️ 空响应（静默 EOF）只允许在**首个事件之前**重试一次

上游有时会「HTTP 200、会话创建成功、一个事件都不发就结束流」。`consumeSse`
用 `sawAnyUpstreamEvent` 标记是否收到过**任何**可解析事件，并在**一个都没有**时
抛 `TRANSPORT`（可重试），由 `stream()` 重试**一次**。

- ⚠️ **一旦已有 output / usage / tool_calls 事件就绝不重放**：重放会让上游
  **重复计费**，并可能**重复执行工具**（对齐 CN 项目的
  `TRAE_REMOTE_WORK_FALLBACK` 语义）
- ⚠️ **不能把空响应当成正常的空 finish**：那会让用户看到「模型回复为空」这种
  毫无线索的结果，且不触发任何重试

### 单次输出上限收敛到 64K（`clampTraeMaxTokens`）

CN 项目实测：SOLO CN 的 agent-remote 模型单次响应上限 **64000 tokens**，并明确
警告「客户端索要 131072 会把上游打成 4xx」（`model_limits.py:9-23`）。

故 `clampTraeMaxTokens` 默认把 `max_tokens` 收敛到 **64000**
（`DSH_TRAE_MAX_COMPLETION_TOKENS` 可覆盖，设 `0` 表示关闭收敛）。

> **后续实测补正（2026-09-19）**：远端 `model_detail_list[].max_tokens` 对**主流
> 模型声明的就是 32000**（不是 64000，也不是兜底表旧值的 128000）。现在该值被
> 真正消费并写进 `resolveModel` 的 `defaultMaxTokens`，所以这个 64000 收敛在实际
> 请求里通常**不会生效**（32K 已低于阈值）—— 它保留为「上游没声明时」的最后一道
> 保险。若某模型远端声明偏大，调大 `DSH_TRAE_MAX_COMPLETION_TOKENS` 即可。

### 机器指纹轮换默认**关闭**（`DSH_TRAE_ROTATE_MACHINE_ID`）

CN 项目每 3~5 次请求主动换 `machine_id` 以「降低 IDE 端点风控」
（`trae_client.py:211-224`）。但这与本地既定约束
「`machine_id` 登录后**绝不重新生成**」冲突 —— 它换来抗风控，代价是设备身份漂移，
而上游按 `machine_id` 标识设备，换值可能要求重新登录。

故该能力**默认关闭**，仅在显式设 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时按每 4 次
请求递增一代（`deriveRotatingMachineId`）。它是出现**集中 401/风控**时的第一个
可尝试开关。

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

#### ⚠️ 但**展示名**必须用 `level`（Issue #IKHCZF）

**`id` 与 `name` 的来源不同，不能都取 `openclawLevel`**：

| 字段 | 来源 | 理由 |
|---|---|---|
| `efforts[].id` | **`openclawLevel`** | DSH 把它原样写进 `reasoning_effort`，必须是服务端认的取值（无 `max`） |
| `efforts[].name` | **`level`** | 纯展示；产品侧（IDE）显示的就是 `Max` |

**真实缺陷**（用户报障 / Issue #IKHCZF「最强思考档显示为 XHigh，与产品侧命名 Max
不一致」）：早期两处都用 `openclawLevel`，于是最强档显示 **XHigh** —— 用户按 IDE 里的
「Max」找，界面上却只有「XHigh」，以为缺了最高档。根因是把「wire 值」与「展示名」
当成同一个概念。

⚠️ `EFFORT_NAMES` 因此**必须同时登记 `max` 与 `xhigh`**（前者给 `level` 查，
后者给 `openclawLevel` 回退查）。对照 `buddy-adapter.ts` 的同类表：它同样两者都登记
—— buddy 无双字段（id 即 wire 值），故不存在这个坑。

实测（2026-09-20，真实凭据，28 个模型）：`level` 取值 `{off, high, max}`、
`openclawLevel` 取值 `{off, high, xhigh}`，8 个模型含 `max→xhigh`。
修复后 `id=xhigh / name=Max` —— **wire 行为不变，仅展示名纠正**。

### SSE 的 `delta.content` / `delta.reasoning_content` 会显式返回 `null`

真实形态（实测 335 帧）：一个模型要么走 content、要么走 reasoning_content，**另一侧恒为 `null`**（227 帧 `content=null`）。解析必须用 `typeof x === 'string'` 而非 `!== undefined` —— 只判 undefined 会让 `.length` 在 null 上崩溃，表现为**每轮对话第一帧就报 `Cannot read properties of null`**。

### 图片输入

远端声明 `supportsImage` 的模型**真的**接受图片：服务端收 OpenAI 兼容的 `{type:'image_url', image_url:{url}}` data URL（实测模型能正确识别图片内容）。**唯一**接受的形态就是它 —— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。

- 能力按**模型**判定（`inputModalitiesFor`），不是按 provider 一刀切
- `stream()` 里 `ensureRemoteModels()` 必须在图片判定**之前**调用，否则 `remoteMeta` 尚空、会把支持图片的模型误判为不支持
- 工具结果内嵌图片（`read_image`）不能留在 `role:'tool'` 消息里（该角色 content 只能是字符串），须提升为**其后的独立 user 消息**；`userContentParts` 与 `collectImages` 必须**对称递归**，否则深层图片会被静默吞掉
- 只声明 `inputModalities` 而不实现比不声明**更糟**：DSH 在 `LlmRuntime` 里按它决定是否把图片投影成文本占位符，声明支持就必须真支持

## 「+ 新建账号」必须两步式返回 loginUrl（五个 provider 一致）

`account.create` 对**全部五个 provider** 都必须在**用户完成授权之前**返回
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
- `qoder`：`QoderAuth.startLogin()`（`src/qoder-auth.ts`），底层 `startQoderLoginFlow`（`src/qoder-oauth.ts`）—— 它是**设备码轮询**，不起本地回调服务器，故没有端口/超时收尾问题
- `trae`：`TraeAuth.startLogin()`（`src/trae-auth.ts`），底层 `startTraeLoginFlow`（`src/trae-oauth.ts`）。默认回调 `http://127.0.0.1:18080/authorize`；该端口被占用时**自动回退到随机端口**（`redirect_uri` 随之重算，服务端原样回跳，故功能不受影响）。登录 URL 需带 `client_id` / `machine_id` / `device_id`

要点：

- 阻塞式 `runOAuthFlow` / `runLobsteraiLoginFlow` / `runTraeLoginFlow` **保留**（CLI、e2e 仍用），
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

### ⚠️ 默认实现的签名必须**显式适配**，不能用 `as unknown as` 硬转

**真实缺陷**（用户报障）：CodeBuddy 一键领取 4 个账号**全部失败**，错误是
**`fetcher is not a function`**。

根因：`claimDailyCheckin` / `fetchCheckinStatus` / `fetchCreditBalance` 的真实
签名是 **`(credential, product, fetcher)`**，而 `CreditsEndpointDeps` 把 `claim`
声明为 `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
`collectClaimResults` 里历史写法是

```ts
const claim = deps.claim ?? (claimDailyCheckin as unknown as NonNullable<…>)
```

那个 `as unknown as` 把签名不匹配**压了过去** —— TypeScript 不再报错，但调用点
`claim(credential, product, entry)` 的第三个实参是 `entry`，它落进 **`fetcher`
的位置**，运行时 `fetcher(...)` 就抛 `TypeError: fetcher is not a function`。

修法：**显式包装**默认实现，把 `deps.fetcher`（或全局 `fetch`）送进第三参
（`CreditsEndpointDeps.fetcher`）。**加新的默认实现时必须照此办理** ——
一旦用 `as unknown as` 掩盖签名差异，就会重演这个 bug。

⚠️ **为什么长期没被发现**：`makeDeps()` **总是注入 `claim` / `fetchStatus`**，
于是真实的默认实现路径**从未被任何用例覆盖**。回归用例
（`jet-hub-rpc.spec.ts` 的「第三参必须是 fetcher」）刻意**不注入** deps，
走真实默认实现并断言请求真的发出去了。

⚠️ 只有 **buddy / workbuddy** 走这条默认路径（其余三个 provider 都在自己的分支里
显式注入 `claim`），所以故障面恰好是 CodeBuddy 系。

**四套协议完全不同**的实现，各自独立：

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

**TRAE** —— `src/trae-credits.ts`（两步，字节 TRAE；详见上「TRAE 签到」小节）：

- 状态查询 `POST /trae/api/v2/ug/checkin_credits/status`（body `{}`，读 `checked_in` / `credits` / `enable`）
- 领取 `POST /trae/api/v2/ug/checkin_credits/claim`（body **`{}`**）
- 认证走 **`traeCheckinHeaders`**（`Cloud-IDE-JWT` + 约 20 个客户端头 + **基于 `uid` 派生**的
  `X-Device-Id` / `X-Market-User-Id` / `Vscode-Sessionid`），**不带** SOLO 专属头
  （`X-Ide-Version` / `X-Machine-Id` 等）
- ⚠️ 设备身份**每个账号必须互异**（由 `uid` 确定性派生保证）：同一天两账号共用会被
  「该设备已签到」拦截；为空则报 9004
- 幂等：重复领取返回非零业务码（实测 `9074` 为「签到人数过多」），判定以响应体 `code` 为准
- 失败时经 `classifyTraeCheckinError` 带上 `errorType` / `cooldownSecs`（见上小节的分类表）

四套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 两套协议共用

**积分余额（Credits Balance）** 也是**四套端点**，但语义一致（「查不到」与「余额为 0」严格区分）：

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

**TRAE** —— `POST /trae/api/v2/pay/ide_user_ent_usage`（body **`{"require_usage": true, "req_source": 2}`**）：

- 响应 `user_entitlement_pack_list[]`，每项 `entitlement_base_info.quota.credits_limit` 为额度、`usage.credits_amount` 为已用
- 余额 = `∑(credits_limit - credits_amount)`；`credits_limit <= 0` 的条目跳过（与 Go 端 `EntUsage` 同口径）
- ⚠️ **必须带 `require_usage: true`**：不带时上游不返回 `usage` 明细，`credits_amount` 恒缺省为 0，余额会等于额度总额（虚高）。头同样走 `traeCheckinHeaders`

四者共同的约定：

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
| `qoder` | ✓（`sash/api/v2/me/usage`，只需 Bearer） | ✗（未见签到接口） |
| `trae` | ✓ | ✓（`checkin_credits` 两步流程） |

> ⚠️ `qoder` **必须显式登记**，不能省略：上面那条「能力矩阵与 `PROVIDERS` 条目集合相等」的断言要求两者同步，而 qoder 必然要进 `PROVIDERS`（否则面板不渲染）。
>
> ⚠️ **早期把 qoder 误判为两项皆无**（登记成 `balance:false`），根因有二，都值得记住：
> 1. **只按 `/api/` 前缀搜端点**，而余额挂在 **`/sash/`** 下 → 漏检；
> 2. **误以为用量端点也需要 WASM 签名** —— 实测只需 `Bearer` + `Cosy-ClientType`。
>
> **余额与签到彼此独立**：不能因为「没有签到接口」就推断「也查不到余额」。

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，当时 CodeArts 无积分能力，面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障。**门控机制保留至今**，用于挡住真正未登记的 provider
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期 workbuddy 指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。
