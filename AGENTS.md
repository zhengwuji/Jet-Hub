# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）、`lobsterai`（有道 **LobsterAI** / 龙虾）、`qoder`（阿里系 **Qoder**）、`trae`（字节跳动 **TRAE**）、`cline`（**Cline** 桌面端 / Cline API）与 `loomy`（讯飞 **Loomy** 办公助手）七个 LLM provider 路由。

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
6. **`options.tools` 必须真的下发到请求体顶层 `tools`，且工具历史要保留 `tool_calls` / `tool_call_id`**（**OpenAI 风格，不是 Anthropic 风格**）。
   客户端源码依据：`$Hc(A)` 把工具序列化成
   `{type:'function', function:{name, description?, parameters?}}`，写入请求体**顶层**
   `tools`（`A6e()`：`tools: o?.tools ?? []`）；assistant 的工具调用由 `t2c()` 转成
   `tool_calls:[{id, type:'function', index, function:{name, arguments}}]`；
   工具结果由 `A2c()` 产出 `{role:'tool', content, tool_call_id}`。
   ⚠️ **另有一条 Anthropic 风格分支**（`IOc()` 的 `input_schema` + `tool_use_id`），
   那是给 **Anthropic BYOK** 用的，加密端点**不吃那套** —— 别照它实现。
   ⚠️ **真实缺陷**（用户报障）：「使用本插件的 qoder 的 qwen3.8-flash，执行任务出现
   任务调用 xml 泄露任务终止」。两处根因：① `src/qoder-adapter.ts` **从不消费
   `options.tools`**（其余四个适配器都消费），`qoder-wasm.ts` 又把请求体的 `tools`
   **硬编码为 `[]`** → 模型在 wire 上拿不到任何函数 schema，只能用**正文里的 XML 文本**
   臆造工具调用，harness 认不出 → 任务终止；② 适配器的 history 过滤器写成
   「只留 `content` 为字符串的消息」，而 assistant 带工具调用时 `content` 是 **`null`**
   （OpenAI 规范）→ 整条被丢，且 `role:'tool'` 的 `tool_call_id` 也被丢 → 模型看不到
   自己调用过什么，反复重调同一工具或凭空编造结果（与 TRAE 那条同型缺陷一致）。
   ⚠️ **加密端点的请求体本地不可解**，无法靠抓包验证 —— 故把 payload 构造抽成纯函数
   `buildQoderInferPayload()`（`src/qoder-wasm.ts`），再由 `buildQoderTools()` /
   `buildQoderHistory()`（`src/qoder-adapter.ts`）单测锁死。
   排查脚本 `scripts/probe-qoder-tools.mjs`（只读，打印上述三个客户端函数的定义；
   ⚠️ 解码函数名与 XOR 密钥**随版本会变**，脚本会自行探测）。回归用例
   `tests/unit/qoder-tools.spec.ts`。

⚠️ **`src/qoder-auth-wasm.wasm`（298 KB）随插件分发**，构建时由 `scripts/copy-assets.mjs` 复制到 `lib/`（`tsc` 不搬 `.wasm`）。`build:all` 已含该步骤。

⚠️ **WASM 提取自 Qoder `0.3.4`**（runtime `1.1.57`）。升级方式：

```
pnpm qoder:wasm            # 自动取 .qoder-versions 下版本号最高的
pnpm qoder:wasm 0.3.5      # 指定版本
pnpm build:assets          # 同步到 lib/
```

取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE **实际运行**不同的版本
（实测 IDE 跑 0.3.4）。刷新后**必须实测一次对话**（`qfmodel` / `qmodel_38max`）确认签名仍被接受。

它**积分余额与每日领取都有**（能力矩阵登记为 `{balance:true, dailyCheckin:true}`），并复用 `src/openai-compat.ts` 的 OpenAI 协议层共享实现（消息序列化 / SSE 消费 / 错误归类）。详见 README 的「Qoder provider」章节与 `docs/superpowers/specs/2026-09-19-qoder-provider-design.md`。

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

### ⚠️ Qoder 每日领取：端点由 **keylog 解密抓包** 解出（2026-09-21）

```
GET  {openApiBase}/sash/api/v1/me/campaigns
POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
```

**请求头（`/sash/` 端点必需四项）**：`Authorization: Bearer` + `Cosy-ClientType: '10'`
+ **`Cosy-MachineToken` + `Cosy-MachineType`（成对）**，**无需签名**。

⚠️ **两个条件缺一不可，且是「必要但不充分」的叠加关系**（真实缺陷，
2026-09-25 定位并**端到端修复验证**：插件领取成功、余额 0→100）：

| 请求头 | `/sash/api/v1/me/campaigns` 响应 |
|---|---|
| `Cosy-ClientType: '5'`（CLI 身份） | `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}` |
| `Cosy-ClientType: '10'` + 无 machine 头 | `showCampaign:true, claimable:false`，**1 条 `VIEW_DETAILS`** |
| `Cosy-ClientType: '10'` + MachineToken + MachineType | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
| ＋MachineToken/MachineType **去掉任一个** | ❌ 退回 1 条（**必须成对**） |
| 单独加 `Cosy-MachineId`/`Version`/`OS`/`Hostname`/`Code` | ❌ 均无效（**都不是必需项**） |

⚠️ **`'10'` 单独不够** —— 这是被 PR !11 的错误结论误导过的地方。它只让服务端
回一条 `VIEW_DETAILS`（`claimable:false`），**没有** `CLAIM_BENEFIT`，于是插件
筛出 0 个可领活动并误报「今天已领」。**真正决定下发可领活动的是成对的
machine 头**。实现见 `src/qoder-machine.ts`。

⚠️ **值的来源可自给自足，不需要抓包**：`%APPDATA%\Qoder\SharedClientCache\
cache\machine_token.json` 的 `token` → `Cosy-MachineToken`、`type` →
`Cosy-MachineType`。实测该文件即使 `updateAt` 很旧（179 天前）token 仍有效。
读不到时**保守降级**（不带这两个头，回到修复前行为）——纯插件登录、未装
Qoder 桌面端的用户没有该文件，不能让积分功能整体失败。

⚠️ **`'10'` 的来源是官方常量**，不是猜的：Qoder 桌面端 `app.asar` 里有
`Mh = Object.freeze({ clientType: 10, businessProduct: 'app', sessionType: 'app' })`，
native 另有 `rl = Object.freeze({ clientType: 10, businessProduct: 'app' })`。

⚠️ **不要合并两处 client_type**：`clientMetadata.client_type`（`'5'` + `cli`）
是**推理请求体**加密信封 `metadata` 用的（源码 `Fp()` 的 CLI 默认值），
与 `/sash/` 的 HTTP 头**是两个不同身份**。改动前先在 `qoder-adapter.ts`
确认用途，别把推理那条链路一起改掉。

⚠️ **用户症状是「插件报今日已领取、但官方能领」**：`campaigns:[]` 或只有
`VIEW_DETAILS` 会让 `claimableCampaigns()` 筛出 0 个 →
`claimQoderDailyCheckin` 返回 `already-claimed`，**把「服务端没下发数据」
误报成「今天已领」**。排查时**不要只看这个文案**，先确认上述四个头是否齐全。

⚠️ **「今天已领」的正确判据不是「列表为空」**（2026-09-21 抓包实测的
**领取前后对照**，这是该判据可靠性的直接证据）：

| 时刻 | `claimable` | 那条 `CLAIM_BENEFIT` 的 `claimStatus` | 列表 |
|---|---|---|---|
| 领取前 | `true` | `CLAIMABLE` | 非空 |
| 领取后 | `false` | `CLAIMED` | **仍非空** |

即**领取成功后服务端并不清空列表**，只是把该条改成 `CLAIMED`。故判据必须是
「存在 `CLAIM_BENEFIT` 且 `CLAIMED`」，而「列表为空 / 只有 `VIEW_DETAILS`」
应判**未领**。方向取保守：误报未领最多让用户多点一次（服务端幂等，回
`replayed:true`，无害）；误报已领会让其**真的错过当天积分**。

⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样返回
**200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是**上一次
领取的旧时间**（实测请求发生在 09-21、而 `claimedAt` 是 09-18）。
只看状态码会把「今天已领」误报成「领取成功 +100」。

⚠️ **请求体必须是空串**（抓包实测 `content-length: 0`）。

⚠️ **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`** ——
实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。

⚠️ **为什么曾经误判「Qoder 无签到」**：`/sash/api/v1/me/campaigns` 当时返回
`{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此下了结论。
真相是**那天已领** —— 活动**每日 10:00（UTC+8）刷新**（响应里
`description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
**教训：「某次实测没看到」不能推广成「不存在」**，这与 TRAE「带 code 的
回调」那次是同一类错误。

⚠️ **`CheckinStatus.active` 必须恒为 `true`**（拿到响应即 true，不按
「列表非空」判）：服务端在活动不同阶段都可能回空列表（如请求头不全时），
若据此判 `active:false`，`collectClaimResults` 会先命中「活动未开启」分支，
把「今天已领」误报成「签到活动未开启」。

⚠️ **但「今天已领」不可反推成「列表为空」** —— 2026-09-21 抓包实测领取前后
对照显示：**领取成功后列表仍非空**，只是那条 `CLAIM_BENEFIT` 的
`claimStatus` 由 `CLAIMABLE` 变 `CLAIMED`、顶层 `claimable` 变 `false`。
正确判据见上「Qoder 每日领取」章节。

⚠️ **RPC 分支须传 `precheckStatus: false`** —— `claimQoderDailyCheckin`
自带活动列表查询，否则会重复发一次 GET（与 LobsterAI 传 false 同理）。

### ⚠️ `openai-compat.ts` 只服务 qoder，不要顺手重构既有适配器

`src/openai-compat.ts` 把「消息序列化 + SSE 消费」抽成共享实现给 **qoder 适配器**用。`buddy-adapter.ts` / `lobsterai-adapter.ts` **刻意不改用它** —— 那两份实现已被大量单测与线上流量验证，重构它们属于与本任务无关的高风险改动。若将来要统一，应作为独立任务并配以逐条对拍测试。

它承载的教训（改它时必须保留）：`delta.content` / `delta.reasoning_content` 会显式返回 **`null`**（必须 `typeof === 'string'` 判定）；孤儿工具调用须剔除（否则后端 400 且坏历史被反复重放）；`function.name` 只允许非空覆盖；残缺参数**不补 `{}`**（补了会让 harness 报 schema 错误而非重试）。

`trae` 同样**完全独立**（第五个脉系，独立一套 `src/trae*.ts`），且差异点与其他四者都不一样：认证用 **ExchangeToken 轮换 refreshToken**（不是轮询、也不是 authCode 交换）；鉴权头是 `Cloud-IDE-JWT <token>` 加十余个 `X-*` 身份头；**请求体需要从 OpenAI 格式转换为 SOLO 格式**（`function` / `config_name` / `tools.parameters` 序列化等）；**响应是 SOLO 自定义 SSE 事件**（`output` / `token_usage` / `done` / `error`），必须自行解析并转成 OpenAI chunk；凭据还必须持久化 `machine_id` 与 `device_id`（均为 **32 位 hex**，分别用作设备指纹与签到设备号，后者账号间必须互异）。**登录回调默认直接回传 token**（`auth_callback_url` 参数，老流程没有 `code`；但也并存 PKCE 新流程，两套都要认），详见下「TRAE 协议要点」。实现见 `docs/trae-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI、CodeArts、Qoder 与 TRAE 五个面板提供** —— 只有国际版 WorkBuddy 与 Cline 不提供（两者的后端都没有签到接口）。各面板是**互不相同的协议**（见下「积分领取」）。

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

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`traeAuth`、`clineAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName)` — 按凭据 ref 续期**指定账号**（账号卡片「刷新」按钮）
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：七个 provider 的登录/状态/续期**全部**在 Jet Hub 设置页完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**（用户要求）：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `login`/`startLogin` 的 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`（后两者当时就没有调用方）。
  `refreshModels()` **签名改为接收 `pool`** —— 它原先直接读固定 ref，
  移除单凭据后会恒返回空列表。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （注意代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 七个 provider 的门控判据因此**完全一致**：都只看账号池，
  `providerCatalogVisible` 的 `extraCredentialRefs` 参数已随之删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次
  （用户已确认接受该行为，不做自动迁移）。

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

用户重新启用后拿到的是死凭据，只能重新登录。七个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，`QoderAuth` 注册为 `qoderAuth`，`TraeAuth` 注册为 `traeAuth`，`ClineAuth` 注册为 `clineAuth`，互不覆盖。

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
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

## ⚠️ DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息（消息形状双兼容）

**真实缺陷**（用户报障）：升级到 DSH **0.1.7** 后，带工具调用的会话出现
「**没有工具调用就认为对话结束**而提前停止」或「**模型陷入循环思考**」。

### 根因：`tool-result` 包裹块被删除，工具调用被整体剔除

0.1.7 重构了消息模型：

| | ≤0.1.6 | 0.1.7 |
|---|---|---|
| 工具结果承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **一等 `role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
| `ContentBlockMap` | 含 `'tool-result'` | **删除 `'tool-result'`**，新增 `'tool-addition'`/`'tool-removal'` |
| 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
| `StreamChunk`（插件产出） | — | **逐字节未变** |

⚠️ **`StreamChunk` 没变，所以产出侧（`stream()`）完全不用改** —— 坏的只是
**消费**方向（harness 传给适配器的 `options.messages`）。

各适配器都按 `type === 'tool-result'` 识别工具结果，该判据在 0.1.7 下**恒不命中**：

1. 工具输出被当成普通 user 消息下发，`tool_call_id` 关联丢失；
2. `resolveToolPairing` 的 `allResultIds` 恒为**空集**
   → `usable.every(block => allResultIds.has(...))` 恒 false
   → **assistant 的 `tool_calls` 被整体剔除**。

wire 上于是完全没有工具调用记录，模型看到的是「我说了段话，用户回了段工具输出」。

**实测**（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
修复前保留 **0** 条工具调用，修复后 **512** 条，与 0.1.5 形状对照完全一致。

⚠️ **0.1.7 没有任何协议协商机制**：`packages/llm` 里 `LlmAdapter` / `GenerateOptions`
都没有版本协商字段（搜到的 `protocolVersion` 全属 ACP，与 LLM 适配器无关）。
所以**不能靠协商规避**，必须让代码同时认两种形状。

### 修法：形状归一化层，不改五个序列化实现

新增 **`src/message-shape.ts`**，把 0.1.7 形状**降级**为既有代码已理解的 0.1.5
形状，各入口只插一次调用：

- `normalizeHarnessMessages(messages)` —— 一等 `tool` 消息 → 包回
  `{role:'user', content:[{type:'tool-result',...}]}`；`developer` 消息**丢弃**
  （它只承载工具增删元数据，不是对话内容）；其余原样透传。
- `detectMessageShape(messages)` —— 判据用**形状**而非版本号（沿用
  `settings-compat.ts` 的能力探测先例），且**同时出现两种形态时以 `tool-role` 为准**
  （升级期会话可能混合；判成 legacy 会让新形态结果被漏掉，等于没修）。

⚠️ **`content` 数组必须整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。

⚠️ **`developer` 的剥离与形状探测相互独立**：`detectMessageShape` 只回答「工具
结果长什么样」，而 `developer` 是 0.1.7 专有角色，**无论有没有工具结果都要剥离**。
两者必须分别求值，否则「无工具结果的会话」会把 `developer` 当普通 user 消息下发。

⚠️ **无需改动时返回原数组引用**（`===`），保证 0.1.5 路径**逐字节**不受影响。

落点（6 处）：`sse.ts` 的 `resolveToolPairing`（共享防线，须自身独立正确）、
`llm-adapter.ts` / `openai-compat.ts` / `buddy-adapter.ts` /
`lobsterai-adapter.ts` / `trae-adapter.ts` 的 `serializeMessages`。
`qoder-adapter.ts` 复用 `openai-compat.serializeMessages`，自动受益。

⚠️ **`resolveToolPairing` 的 `content` 参数放宽为可选**（归一化层产出的类型允许
缺 content；函数内部本就按「非数组即视为空」处理）。这是**纯放宽**，不改变行为。

### 回归用例

- `tests/unit/message-shape.spec.ts` —— 探测/归一化/幂等/身份返回/真实字段布局
  （含 `source.callId` 回退：顶层 `toolCallId` 缺失时不能丢 id）。
- `tests/unit/message-shape-adapters.spec.ts` —— **核心不变式**：同一份语义数据按
  两种形状喂入，`serializeMessages` 输出**逐字节等价**。比逐个断言字段更强，
  且对实现方式中立。
- `tests/unit/session-replay.spec.ts` —— **真实会话回放**（离线只读，无网络）。
  自造 fixture 可能在真实数据上失效，故用真实会话锁死。需 `DSH_SESSION_FIXTURE`
  指向导出文件，未设则**干净 skip**（⚠️ 文件必须**惰性读取** —— `describe.skipIf`
  仍会执行回调体收集用例，顶层 `readFileSync(undefined)` 会让整份套件变成
  Failed Suite 而非 skip）。
- `scripts/export-session-messages.mjs` —— 只读导出真实会话消息。
  ⚠️ 必须用 `createSessionFormatCatalogWithChildren([])`（**不是**默认 catalog）：
  V3→V4 迁移要求显式提供子会话事实，无子会话时传**空数组**，否则 `createStage`
  抛 `SessionFormatUnsupportedMigrationError`。

⚠️ **验证「修复有效」必须做反向验证**：临时让 `normalizeHarnessMessages` 恒返回
原数组（= 修复前行为），确认用例**会失败**。否则可能写出一组恒真的同义反复。

## ⚠️ 持久化：DSH 0.1.7 移除 `settings.register()` 之后（Issue IKI7WT）

**真实缺陷**：升级到 DSH **0.1.7-rc.1** 后，Jet Hub 的**账号列表与模型黑名单
无法持久化**（重启即回到空列表，等于所有 provider 都"未登录"，模型目录也因
门控被隐藏）。

**根因**：0.1.7 把 `ctx.settings` 从 `SettingsProvider` 换成 **`SettingsForms`**：

| | ≤0.1.6 | 0.1.7-rc.1 |
|---|---|---|
| 注册方式 | `settings.register(ns, schema)` → owner scope（`get`/`replace`） | **没有 `register`**；命名空间 = **profile 条目 id** |
| 可见字段 | 该 namespace 的全部字段 | 只投影本条目 Config 中标了 **`.volatile()`** 的字段 |
| 写入路径 | provider 文档（旧 `settings.yaml`） | `update/replace/mutate` → profile 的 `cordis.patch.yml` |

因此 `if (typeof settings.register !== 'function')` 这条**看似安全的降级分支**
恒成立：账号池退化为纯内存。启动日志实证
`[jet-hub] settings 服务不可用，账号列表仅存在于内存中`（旧文案有误导性，
实际是"API 没了"而不是"服务没挂"）。

**修法**（`src/jet-hub-store.ts` + `src/settings-compat.ts`）：

- 持久化后端按**能力探测**：`settings.register` 可用 → 沿用老契约（数据仍在
  settings 文档，行为与 ≤0.1.6 完全一致）；否则 → 插件自有文档
  **`$DSH_HOME/jet-hub/state.json`**（同步读 + 原子写 tmp+rename）。
- ⚠️ **不要把这类运行时状态塞进插件 Config 的 volatile 字段**：限流每命中一次
  就要写一次，而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader
  协调 —— 把易变数据混进用户手写的配置层，代价与风险都不划算。
- **`settingsNs` 必须跟着改**：0.1.7 起它只能是 profile 条目 id，故
  `settingsNamespaceFor(ctx, 'llm-<id>')` 解析为**本插件条目 id**
  （官方适配器同做法：`ctx.fiber.entry?.options.id`）。拿不到条目 id 时退回旧名，
  此时该 provider 在模型设置页显示为「未配置」，**不影响路由与收发**。
- **必须导出带 `.volatile()` 字段的 `Config`**：`SettingsForms.describe()` 只收录
  「有 volatile 字段」的条目，否则模型设置页把本插件的 provider 判为既非
  "已配置"也非"可添加"。本插件自带 Jet Hub 页面，故同时调
  `settings.configure({ auto: false }, ctx.fiber)` 关掉自动生成的表单。
- ⚠️ **`.volatile()` 需要 schemastery ≥ 3.18.4**（本地曾是 3.18.2，只有
  3.18.4 才有该方法）；且 `volatile()` 会把 cosmokit 的 `Volatile<T>` 带进
  `Config` 的公开类型，故 `@deepseek-ai/cosmokit` 必须是本包依赖，否则
  `tsc` 报 TS2742。

**老数据恢复**（0.1.7 把 `$DSH_HOME/settings.yaml` 改名为 `.imported`，并按
「section id = 条目 id」导入；`jet-hub` 不对应任何条目 → 该段**导入失败、成为
孤儿**）：

- 插件在状态文档**缺失**时，会从 `.credentials.yaml` 的 `refs:` 反推账号
  （只读键名，不引 YAML 依赖 —— 运行时不保证能解析 `yaml`/`js-yaml`）。
  这是**保底**：能还原"有哪些账号/用哪个 credentialRef"，
  但**拿不回昵称、顺序、enabled 与限流标记**。
- 精确还原用一次性脚本 `scripts/import-jet-hub-legacy-settings.mjs`
  （默认**预演**，`--write` 才落盘）：直接解析旧文档的 `jet-hub` 段，
  保留昵称/顺序/enabled/限流与黑名单；有任何条目缺
  `id`/`provider`/`credentialRef` 就整体拒绝写入（不导入半截数据）。
  ⚠️ 模型 id 含 `.` 与 `-`（如 `deepseek-v4.1-flash`），字段正则必须放行，
  早期写成 `[\w]*` 会让限流标记**静默全丢**。
- 排查脚本：`scripts/verify-jet-hub-persistence.mjs`（用**已构建 lib/** 以 0.1.7
  契约验证落盘与跨实例读回）、`scripts/preview-jet-hub-recovery.mjs`
  （只读预演凭据反推）。回归用例：`tests/unit/jet-hub-store.spec.ts`、
  `tests/unit/account-pool.spec.ts`（「0.1.7 契约」段）。
- ⚠️ 单测必须隔离状态目录：`vitest.config.ts` 把 `DSH_JET_HUB_STATE_DIR`
  指向一次性临时目录，否则文件后端会污染真实 `~/.dsh`。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

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

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **七个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## ⚠️ Cline provider：`workos:` 前缀不可剥、免费集合动态下发

`cline` 是**第六个脉系**（独立一套 `src/cline*.ts`）。协议全部由本机 Cline 桌面端
产物逆向 + 实测得出（2026-09-25）：

- 二进制 `C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
- 真实凭据 `C:\Users\Jet\.cline\data\settings\providers.json`
- 排查脚本（只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取二进制字符串
  窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
  `probe-cline-balance.mjs`、`probe-cline-chat.mjs`
- 设计文档：`docs/superpowers/specs/2026-09-25-cline-provider-design.md`

### ⚠️ 坑 1：`Authorization` 必须原样带 `workos:` 前缀（剥掉即 401）

源码 `resolveApiKey` **原样使用存储值**，而 Cline 磁盘上存的就是
`workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
（`decodeJwtPayload(token.replace(/^workos:/, ""))`），**从不出现在请求头构造里**。

实测（`tests/e2e/cline-probe.e2e.spec.ts` 会现场复验，同一凭据）：

| Authorization | `/api/v1/users/me` |
|---|---|
| `Bearer workos:eyJ…`（**原样**） | **200** |
| `Bearer eyJ…`（剥掉前缀） | **401** |

⚠️ 401 文案是 *"make sure you're using the latest version of Cline and
re-authenticate your Cline account."* —— 与真实原因**毫不相干**，会让人误判成
「客户端版本过旧」。实现见 `clineBearerValue`（幂等补齐，两种形态都接受）。

### ⚠️ 坑 2：免费模型是**独立 id**，且只由 `recommended-models` 下发

`cline-free/deepseek-v4.1-flash`（免费）与 `deepseek/deepseek-v4.1-flash`
（按量计费）是**两个不同条目**。绝不可用「名字含 deepseek」之类模糊匹配判免费 ——
那会让用户按免费预期使用却被计费。

两个端点**必须都打**，理由各有实测依据：

| 端点 | 内容 | 认证 |
|---|---|---|
| `GET /api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
| `GET /api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id**，无 name/上下文 | 需要 |

⚠️ 实测 `/models` 的 460 个 id 里 **`cline-free/*` 零命中** —— 免费模型**只**由
`recommended-models` 下发。这就是「只调 `/models` 会看不到任何免费模型」的原因。
`tests/e2e/cline-probe.e2e.spec.ts` 用断言锁死了这一事实（若某天 `/models` 也开始
下发它们，该用例会失败并提示可简化实现）。

判定规则（`isClineFreeModel`，**不硬编码模型名**）：
远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表 `isFree`。
与 CodeArts benefit 集合同一约定。

⚠️ **兜底表不足以覆盖免费集合**：sidecar 内嵌目录缺
`cline-free/gemini-3.8-flash`（远端 `free` 有），故 `cline-product.ts` 的兜底表
手工补上了它 —— 否则离线时用户看不到截图里的那个模型。

⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型（`cline-pass/*`），
按订阅额度计费。实测 14 个，误判为免费会误导用户。

### ⚠️ 坑 3：思考字段是 `delta.reasoning`，不是 `reasoning_content`

实测 Cline SSE 形如
`{"delta":{"reasoning":"The","reasoning_details":[…]}}`，而
`reasoning_content` 是 Qoder / buddy 的形态。`src/openai-compat.ts` 的
`consumeOpenAiSse` 因此**同时认两者**（`delta?.reasoning_content ?? delta?.reasoning`）。
只认前者会让 Cline 的思考内容被静默丢弃（表现为「模型不思考」，且 reasoning
档位切换看似无效）。e2e 探针实测已确认思考内容真的产出。

### ⚠️ 坑 4：思考档位**远端不下发**，只能来自客户端内嵌目录

IDE 的模型选择器旁有思考强度菜单（`None / Low / Medium / High / Extra`），
但**远端两个模型端点都不下发档位**：`/api/v1/models` 只有
`{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`。sidecar 内 `/api/v1/` 的 21 个路径中也没有
任何模型详情端点（`/api/v1/users/me/remote-config` 返回 `{"data":null}`）。

档位只存在于 `code-sidecar.exe` 内嵌的 `BUILTIN_MODEL_CATALOG` 的
`reasoningOptions`，而那张表覆盖不了远端 460 个 id。故 `CLINE_REASONING_EFFORTS`
对**所有**模型统一给 5 档。

⚠️ **`id`（wire 值）与 `name`（展示名）不是同一个概念**。最高档的对应关系
（`Extra` → `max`）是**行为实测**出来的，不是反推的：

| effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
|---|---|
| 不传 / `none` | 0（**不传 = 不思考**） |
| `low` | 67 |
| `medium` | 379 |
| `high` | 294 |
| `xhigh` | **259（与 high 无可辨差异 → 伪档位）** |
| `max` | **1192（high 的 4 倍 → 最高档）** |

若只按名字对齐（`xhigh` → 显示成 XHigh），会给用户一个**实测无差异的档位**，
而真正的最高档 `max` 反被跳过。旁证：sidecar 权重表
`{ max:1, xhigh:0.95, high:0.8, ... }` 同样确认 `max` 在 `xhigh` 之上。

⚠️ **上游对不认识的档位静默忽略而非报错**（实测 `reasoning_effort: 'banana'`
返回 HTTP 200、思考量为 0）—— 故 `stream()` 里**绝不能加白名单校验**：
校验既无必要，又会把上游未来新增的档位变成静默丢弃。

⚠️ **声明 `defaultEffort` 会改变默认行为**：实测不传档位时模型完全不思考，
而 DSH 在用户未选择时自动采用 `model.reasoning.defaultEffort`。本插件默认
`high`（对齐 IDE 截图的选中态），代价是思考 token 计入 `completion_tokens`。

⚠️ 统一给档位的**已知局限**：对不在内嵌目录里的模型，档位是猜的 ——
最坏情况是「开关无效」（上游静默忽略），不会是「请求失败」。

排查脚本：`scripts/probe-cline-reasoning.mjs`（纯本地，只读）、
`scripts/probe-cline-effort-compare.mjs`（**消耗免费额度**，多次采样对比档位）。
设计文档：`docs/superpowers/specs/2026-09-25-cline-reasoning-effort-design.md`。

### ⚠️ 坑 5：Gemini 系有两个**独立**的 400，且各自只在部分 provider 上暴露

用户报障（2026-09-25）：给 `cline-free/gemini-3.8-flash` 发消息即失败。错误体里
一次请求有**两个 provider 尝试、两个不同的错误**：

| provider | 错误 |
|---|---|
| `vertex` | `maxOutputTokens value of 131072 but the supported range is from 1 to 65537` |
| `google` | `tools[0].function_declarations[34].parameters.properties[permission].enum[3]: cannot be empty` |

⚠️ **不要只修一个** —— 上游会依次 fallback，命中哪个 provider 就暴露哪个错误，
路由一漂移就复发。

**根因 1（我们的错）：兜底表数值凭印象填。** `cline-free/gemini-3.8-flash` 不在
sidecar 内嵌目录里，当初手工补表时照抄了其它免费模型的 `131072`；而同名
`google/gemini-3.8-flash` 的实测值是 **65536**，上游上限即 65536。
这与 Qoder 那条「本表数值必须逐条对照，不要凭印象填」是**同类错误**。

**根因 2（必现）：工具 schema 的 `enum` 含空串。** harness 下发的工具集里某些
参数的 `enum` 带空字符串成员，Gemini 系严格校验直接 400。
⚠️ 本适配器**从不自己造 enum**（`stream()` 原样透传 `tool.parameters`），
脏数据来自上游 harness —— 但请求是我们发的，只能在我们这侧拦住。
`sanitizeClineToolParameters()` 递归清洗，三条边界：只删空串（保留数值枚举）、
全空则丢弃 `enum` 键（空 `enum` 同样非法）、递归下钻 `properties` / `items`。

⚠️ **排障时注意：这两个 400 都不是必现的。** 实测同一 `max_tokens=131072`
连发 3 次都返回 200（那几轮没命中 vertex）。判定依据是错误体里的
`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
不是重试次数 —— 别因为「重发一次就通了」而误判为偶发。

⚠️ 顺带：本机 `~/.cline/data/settings/providers.json` 里的 `accessToken` **常常过期**
（实测过期 1 小时，直接请求得到 401），排查前先续期；续期返回的是**裸** JWT，
必须补 `workos:` 前缀才能用（坑 1）。

排查 / 验证脚本：`scripts/probe-cline-gemini-400b.mjs`（对照复现两个根因）、
`scripts/verify-cline-gemini-fix.mjs`（走已编译 `lib/` 的端到端验证，三个场景）。
均**消耗免费额度**。

### ⚠️ 坑 6：403 不都是凭据问题 —— 地域限制会被误报成「API 密钥无效」

用户报障（2026-09-25）：`cline-free/muse-spark-1.3-contributor` 提示
「**API 密钥无效**」，但凭据是好的。

该中文文案**不是本插件抛的** —— 它来自 DSH 客户端 `failureMessage()`：

```js
return code === "AUTH" ? t("message.failure.auth") : message
```

即**只要错误码是 `AUTH`，真实原因就被替换成「API 密钥无效」**；非 `AUTH` 则
原样显示 message。而 `httpErrorCode()` 把 401/403 **一律**映射成 `AUTH`。

⚠️ Cline 对「该地区不可用」的模型也返回 **403**：

```
403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
     is not available in your region","success":false}
```

于是故障链是：403 → 当作凭据过期 → **白跑一次续期**（续期还会成功，所以不提前
报错）→ 重试仍 403 → 归成 `AUTH` → UI 显示「API 密钥无效」。真实原因彻底丢失，
用户以为要去重新登录。

修法：`isClineRegionForbidden()` 按**响应体文案**识别（不能按状态码一刀切 ——
同一批 403 里既有真凭据问题也有地域限制），命中时**跳过续期**并抛
`PERMISSION_DENIED`（该码不在 DSH 默认可重试集合内，不会反复重试）。

⚠️ 顺带修了 `errorDetail()`：Cline 的错误体是 `{error: "<文案>", success:false}`，
而该函数原本只认 `code` / `message` / `msg` → 整个 JSON 原样返回，用户看到一坨
裸 JSON。现已补 `error`（字符串与嵌套对象两种形态都认）。这是**共享函数**，
Qoder 同样受益，改动已由全量单测覆盖。

排查 / 验证脚本：`scripts/probe-cline-muse-403.mjs`（直接看真实状态码）、
`scripts/verify-cline-region-fix.mjs`（走 `lib/` 验证错误码与续期次数）。
均**消耗免费额度**。

### 登录：WorkOS 设备码（与 Qoder 同为轮询式，但判据形态不同）

```
POST {workOsBase}/user_management/authorize/device   → device_code / user_code / verification_uri
轮询 POST {workOsBase}/user_management/authenticate  → 200 {access_token, refresh_token}
     grant_type=urn:ietf:params:oauth:grant-type:device_code
POST {apiBase}/api/v1/auth/register  body {accessToken, refreshToken}
  → {success:true, data:{accessToken, refreshToken, expiresAt, userInfo:{clineUserId, email}}}
```

⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它是「用户还没在浏览器里
点授权」。与 Qoder 的「404 表示尚未授权」是同一类语义，但**判据形态完全不同**
（Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段）。`slow_down` 必须**累积
退避**（源码 `intervalSeconds += 1`）。

⚠️ **响应套 `{success, data}` 信封，字段名是驼峰** `accessToken`（不是
`access_token`）。判据是 `success && data.accessToken`（源码
`requireClineTokenResponse`），只看裸字段会把失败信封当成功。

### 续期：字段名是驼峰 `refreshToken` + `grantType`

```
POST {apiBase}/api/v1/auth/refresh
body: { "refreshToken": <refresh>, "grantType": "refresh_token" }
```

⚠️ **不是 OAuth 标准的 `refresh_token` / `grant_type`**（源码 `refreshClineToken`）。
两者都必填；写错字段名服务端不会明确报「缺字段」，而是回一个泛化的认证失败。

### 积分余额：只有余额，**没有签到**

```
GET {apiBase}/api/v1/users/{accountId}/balance
  → { data: { userId, balance: 500000 }, success: true }
```

⚠️ **`userId` 用凭据里的 `account_id`（`usr-…`），不是 JWT 的 `sub`（`user_…`）**：
实测传 `sub` 返回 `400 {"error":"Invalid request format"}`。

⚠️ **401 的响应体是 `{error:"…"}`，没有 `success` 字段** —— 解析器必须两种失败形态
都认，否则 401 会落到误导性的「响应缺少 data 字段」，把服务端给的唯一有用线索丢掉
（真实缺陷，已由 `tests/unit/cline-credits.spec.ts` 锁死）。

⚠️ **余额单位**：实测 `balance: 500000`。按 1e-5 USD 解释为 **$5.00**，与 Cline
公开的新账号赠额一致 —— 这是选取 `CLINE_BALANCE_SCALE = 100000` 的独立锚点。
⚠️ **不要用 `/usages` 的 `costUsd` 反推该系数**：实测单次记录
`{creditsUsed:0, costUsd:1320, totalTokens:49}`，按 1e-5 解释会是 $269/1M token
（flash 档不可能），说明两者**口径不同**。只读 e2e 探针会打印原始值供核对。

**签到不存在**：对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` /
`campaign` 均无任何 Cline 业务端点命中（`campaign` 的命中是 PostHog 的 UTM 参数与
feature-flag 事件属性；`daily` 是 YAML cron 别名与 Blob 导出频率枚举）。故能力矩阵
登记为 `{balance:true, dailyCheckin:false}`（与 WorkBuddy 国际版同例）。
⚠️ 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来增加签到，需按
Qoder 那次教训重新采集。

### e2e 闸门（付费保护，**请勿削弱**）

```
DSH_CLINE_E2E=1                          只读探针（凭据/前缀证据/余额/免费集合）
DSH_CLINE_CHAT_E2E=1 + ..._CONFIRM=yes   默认**只**请求 cline-free/deepseek-v4.1-flash
DSH_CLINE_CHAT_E2E_ALL_FREE=1            才遍历其余 4 个免费模型
```

理由：免费资格是**服务端随时可撤销**的营销状态。无条件遍历「远端此刻说免费」的
那批模型，某天某个转为计费后，一次 e2e 就会**按付费价刷 token**。

`assertFreeModel()` 是安全边界：任何 `isFree === false` 的模型（无论来自
`DSH_CLINE_MODEL` 还是远端列表）都**直接抛错、不发请求**；遍历分支还做逐个二次确认
（已不在**当前** free 集合中即跳过）。

### ⚠️ 面板图标必须从官方资源提取，**不得凭印象手绘**

**真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。

初版 `CLINE_ICON` 是**凭印象手绘**的内联 SVG（「深色圆角方块 + 白色 C 形弧线」），
与 Cline 真实标志完全不符 —— 真实标志是**顶部带凸起的圆角方块 + 中间两条竖线 +
左右两侧尖角**，品牌紫底。

**教训：品牌图标必须从官方资源提取。** 修法与工具：

- 官方图标**就在安装目录里**，不必从 exe 抠 PE 资源：
  ```
  %LOCALAPPDATA%\Cline\icons\app\{classic,chip,hologram,midnight}.png   148×148
  %LOCALAPPDATA%\Cline\icons\app\macos\*.png                            1024×1024  ← 用这个
  ```
  （`cline-app.exe` 内嵌的主图标只有 **32×32** 且是 **midnight** 主题，不适合。）
- 提取脚本 **`scripts/extract-cline-icon.mjs`**（纯 Node，**零第三方依赖**：
  PNG 解码/编码用内置 `zlib` 手写，只支持官方图标的
  bit depth 8 + color type 6/2 + 非隔行）：
  ```
  node scripts/extract-cline-icon.mjs                    # classic，48×48，写入 jet-hub.js
  node scripts/extract-cline-icon.mjs --dry-run
  node scripts/extract-cline-icon.mjs --theme=midnight --size=64
  node scripts/extract-cline-icon.mjs --out=icon.png     # 另存供目视
  ```
- **主题选 classic（品牌紫 `#7271E5`）**，理由：`midnight`（exe 内嵌的默认主题）
  是近黑底，与 **Qoder 图标的深蓝黑 `#1f2a3f`** 在容器实际尺寸 **20×20** 下
  几乎无法区分，列表里会混淆；`chip`（绿色电路板）缩到 20×20 后纹理退化成噪点；
  `hologram` 在白底容器里对比度不足。另：紫色在当前 7 个 provider 图标里**未被占用**。
- ⚠️ **缩放必须做 alpha 加权（预乘）平均**：图标边缘是抗锯齿的半透明像素，
  直接对未预乘 RGB 平均会混入透明区的黑色，产出**发黑的描边**。
- ⚠️ 脚本的替换逻辑用**全局匹配、只保留一行**：单次 `String.replace` 一旦
  文件里出现重复的 `const CLINE_ICON` 声明就会残留 → esbuild 直接报
  `The symbol "CLINE_ICON" has already been declared`（开发期踩过一次），
  现在重复运行幂等且能自愈重复行。
- **回归测试 `tests/unit/cline-icon.spec.ts`**：锁定 ① 必须是结构完整的 **PNG**
  （防退回手绘 SVG）、② 尺寸 48×48、③ 与「从官方 `classic.png` 重新提取」
  **逐字节一致**（无 Cline 安装时该条干净跳过）。
  已做**反向验证**：把前缀改回 `data:image/svg+xml` 后 4 条用例失败。

### 其它

- 推理端点是**标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`），
  故复用 `src/openai-compat.ts` 全套（消息序列化 / SSE 消费 / 错误归类），与 Qoder 同做法。
- 客户端标识头（推理与账号端点都带）：`HTTP-Referer: https://cline.bot`、
  `X-Title: Cline`、`X-IS-MULTIROOT: false`、`X-CLIENT-TYPE: cline-sdk`。
- `max_tokens` 上界收敛到 **943718**（内嵌目录最大 `maxTokens`，取自
  `muse-spark-1.3-contributor`），不自行编造更大值。
- 单元测试 6 个文件：`cline.spec.ts` / `cline-models.spec.ts` / `cline-oauth.spec.ts` /
  `cline-credits.spec.ts` / `cline-auth.spec.ts` / `cline-adapter.spec.ts`。
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
- ⚠️ **改完插件必须重建 `lib/` 并重启 DSH 才生效**：宿主侧代码在 DSH 启动时从
  `lib/index.js` 载入，不热重载（只有 `plugin-src/client/` 的客户端 bundle 有 HMR）。
  **排查「改了没效果」时先看这两个时间**：`lib/index.js` 的 mtime 与 DSH 进程的启动时间 ——
  进程早于产物就说明跑的是旧代码。

#### ⚠️ 「没有任何报错就中断」怎么查

这类现象**无法靠读代码推断**，必须回到会话记录。DSH 把每次请求的**原始 chunk 流**
也记进了 `assistant/message` 事件（`data.stream`），据此可还原真相：

```bash
node scripts/inspect-session.mjs list zed                      # 找会话（工作区关键字）
node scripts/inspect-session.mjs turns <会话文件>               # 每轮结束原因（先定位可疑轮次）
node scripts/inspect-session.mjs brief <会话文件> assistant/message 700
node scripts/inspect-session.mjs stream <会话文件> <seq>        # 该步的原始 chunk 流（关键证据）
```

会话日志位于 `~/.dsh/sessions/<工作区转义名>/<session-id>/session.v3.jsonl.zstd`
（**zstd 压缩的 JSONL**；工作区名把 `\` `/` `:` 换成 `-`，如
`D:\jet\code\rust\zed` → `--D-jet-code-rust-zed--`）。

判据（真实案例，2026-09-23，`qoder`/`qfmodel`）：同轮相邻两步对照 ——

| 步骤 | chunk 流 | finish |
|---|---|---|
| 正常步 | `block-start(text) → text → block-start(tool-call) → tool-call-chunks → block-end×2` | `tool-calls` |
| 中断步 | `block-start(text) → text →`（**无任何 tool-call**）`→ usage → block-end` | `stop` |

即：模型写完「让我检查 X：」后流就结束了。**`turn/end` 是 `completed`**，
UI 上完全看不到错误。

⚠️ 两个可能成因，**不要凭猜认定**：
1. **连接被掐断**（没有 `finish_reason`、也没有 `[DONE]`）→ 已由
   `consumeOpenAiSse` 的 `truncatedStream` 判定改为报 `max-tokens`（可重试）；
2. **模型确实输出了 `finish_reason: stop`** 却没产出工具调用（模型抖动）→
   本层无从强制，但此时**行为可与 (1) 区分**：修复后 (1) 会重试、(2) 仍是 `stop`。
   若重启后再现且仍不重试，说明是 (2)，需换思路（如减少单步工具数量）。

**其它已修的同族缺陷**（都表现为「无报错中断」，改 `openai-compat.ts` 时务必保留）：

- **网关形态错误帧被整帧丢弃**：帧形如
  `{"stackTrace":[...],"message":"...","statusCodeValue":400}` ——
  **既没有 `code` 也没有 `error`、也没有 `choices`**，早期解析器所有条件都不命中。
  现按 `statusCodeValue >= 400` 或带 `stackTrace` 判为错误并抛出。
- **响应根本不是 SSE**（网关直接回了 JSON，没有任何 `data:` 帧）：
  早期同样静默空结束。现抛错并**带上原文片段**，否则用户只能看到一个没有原因的失败。

回归用例：`tests/unit/qoder-silent-stop.spec.ts`。

#### ⚠️ 名称为空的 `tool_call` 会**跨 provider 传染**，让整条会话报废

**真实缺陷**（用户报障，2026-09-23）：在 zed 会话里给
`workbuddy/deepseek-v4.1-flash` 发一条**带图片**的任务，**每次都**报：

```json
{"code":11133,"msg":"the request parameters were rejected by the model provider",
 "extError":{"code":"model_param_invalid","param":"","StatusCode":400}}
```

⚠️ 该文案**不指出是哪个字段**，且与图片、工具、思考档位全都无关 —— 极易误判成
「这个模型不支持图片」。**逐项排除法**（`scripts/probe-workbuddy-image.mjs`
与 `scripts/confirm-empty-tool-name.ts` 已固化）：

| 被排除的假设 | 实测反证 |
|---|---|
| 图片 wire 形态（`{type:'image'}` / 裸 base64 / `image_url`） | 正确形态一律 200；错误形态报 **11101**（parse failed），不是 11133 |
| 33 个工具的 schema（逐个单测 + 全量） | 全部 200 |
| `thinking` / `reasoning_effort` / `max_tokens` | 单独去掉后**仍** 400 |
| input + `max_tokens` 超上下文 | `max_tokens` 降到 **64** 仍 400；短历史 + `max_tokens: 900000` 反而 200 |
| 重复 `tool_call_id`、中段 system 消息 | 变换后仍 400 |

**真凶**：会话历史里有一条 **`name:''` 的 `tool_call`**：

```json
{"type":"tool-call","id":"call_25e97a78849f449da444fc72","name":"","arguments":"{}"}
```

**实测最小复现**（wire 上的 `function.name` → 上游结果）：

| `function.name` | 结果 |
|---|---|
| `"read"` | 200 |
| `"unknown_tool"`（**不存在的**工具名） | 200 ← 上游**只校验非空，不校验存在性** |
| `""` / `null` / 缺失 | **400 code 11133** |

**来源是 qoder**（所以叫「跨 provider 传染」）：其 SSE 偶发一个**完全没有 `name`
字段**的 tool-call 分片（实测 seq=693：`{index:2, id:'call_25e9…', args:[""]}`），
早期 `openai-compat.ts` 在 `block-end` 处 `name: block.name ?? ''` 把它落成空串块 →
harness 执行得到 `unknown tool ""` → 该坏块被**持久化进会话** → 用户切到 workbuddy
后每次请求原样重放 → 400。

**两处修复，缺一不可**：

1. **消费侧（源头，`src/openai-compat.ts`）**：名字可用**之前不发射任何 chunk**
   （连 `block-start` 都不发）。
   ⚠️ **只跳过收尾的 `block-end` 是不够的** —— 上游 `BlockAssembler.assemble()`
   对没有 `block-end` 的 partial 同样会组装出 `name: partial.toolCallName ?? ''`。
   必须让该块**一个 chunk 都不产出**。名字稍后到达时，把**已累积的参数一次性补发**，
   故正常形态（首片即带 name）行为不变。
   同一修法已施加到 `buddy-adapter.ts` / `llm-adapter.ts`（含两条 DSML 分支）/
   `lobsterai-adapter.ts` / `trae-adapter.ts`。
2. **序列化侧（存量会话自愈，`src/sse.ts` 的 `resolveToolPairing`）**：
   发请求前剔除**名称不可用**的 tool_call 及其结果，让**已经坏掉的会话**无需重开即可恢复。
   - 判据用 `hasUsableToolName()`，**不能写成 `String(name).length > 0`** ——
     `undefined` / `null` 经 `String()` 会变成 `"undefined"` / `"null"` 这类**非空**
     字符串，「缺名字」会被误判成「有名字」。
   - **不得连累同批的合法调用**：实测线上形态正是「一个无名 + 一个合法 `pwsh`」，
     整批丢弃会白白损失一次有效调用。结果按 id 匹配，剔一个不破坏另一个的配对。
3. 丢弃了无名调用且**没有**留下任何可用调用时，`finish` 报 `max-tokens`（可重试）
   而非 `stop` —— 否则又是一次「模型本意调工具、harness 却认为正常答完」的无报错中断。

回归用例：`tests/unit/sse.spec.ts`（`resolveToolPairing` / `hasUsableToolName`）、
`tests/unit/qoder-silent-stop.spec.ts`（消费侧不产出空名字块）。
验收脚本：`scripts/verify-workbuddy-image-fix-e2e.ts`（**用线上那条报废会话的真实历史**
重放，判据是修复后 HTTP 200）。

#### ⚠️ 思考死循环会烧满输出额度（Reasoning Loop Guard）

**真实缺陷**（用户报障，2026-09-23）：`workbuddy/deepseek-v4.1-flash` 报
「已达到输出 token 上限，回答被截断」。

⚠️ **先排除一个错误假设**：用户最初怀疑「切换模型后沿用了旧模型的参数」。
**实测否定** —— DSH 的 `prepareCall` → `resolveCallWithInfo` 按**当前**模型解析
`maxTokens`（`dsh-llm/lib/index.js:2111`）；且同一会话 turn 1 **未做任何切换**
就爆额度，切到 lobsterai 后连续两轮正常 `completed`。问题跟着**模型**走。

**真因**：模型思考陷入病态重复：

```
Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
```

`reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出。
实测三步全部 `reasoningTokens == outputTokens == 128000`、**无 text 块、无工具调用**。

**判据**（`createReasoningLoopDetector`，`src/sse.ts`）：尾部 3000 字符窗口内
「非空行 ≥40 且去重行比例 <0.35」判为局部循环，且**循环状态须持续 ≥2000 字符**。

⚠️ **「持续体量」这一层不可省**：实测 seq=401 在 14848/15795（94%）处被判局部
循环，但它随即**自愈并产出了工具调用** —— 其持续体量仅 1024，被 2000 正确排除；
三个真死循环的持续体量是 435,968 ~ 509,184。正常样本窗口去重率最低 0.149、
死循环 0.017~0.031（**5 倍余量**），实测**零误报**。

判据选型（正常 109 条 / 死循环 6 条真实样本）：

| 判据 | 正常误报 | 死循环命中 |
|---|---|---|
| n-gram 重复占比 | 0/109 | 2/3 |
| **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
| 尾部行周期 | 0/109 | 1/3 |

**中断动作**：丢弃后续思考增量 → **`reader.cancel()` 中止上游**（真正止损，见下）
→ 收尾发**截断后的 reasoning block**（保留 `cutAt` 前的干净前缀）
→ `finish` 报 **`max-tokens`**（标记为不完整，由用户/上层决定是否继续）。

⚠️ **「止损」这一步不可省**（终审 C1，已实测）：只跳过**下行**累积/发射、却把流读到底，
则上游继续生成、**128000 token 照烧**（实测上游 200 帧被读 **200 帧**；守卫在 ~2304
字符即命中，即 99.5% 额度仍被消耗）。且报障会话的 `turn/end` **本来就是 `max-tokens`**
（分支前 `finishReason === 'length'` 已报同样 reason）—— 不止损就等于没修。

四个必须保留的实现要点：

1. **`block-end` 是权威覆盖**（实测 `scripts/verify-blockend-override.ts`）：
   即便前面已 yield 全部重复 delta，收尾发截断后的 block 即可，**无需撤回**。
2. **命中后 `reader.cancel()` + `break` 出 SSE 读取循环**（止损）。
   ⚠️ **`break` 必须放在内层行循环之后、外层读取循环的末尾** —— 这样同一 chunk 里
   已到达的 `usage` / `[DONE]` 仍会被处理。放进内层 `while` 会整块跳过本 chunk
   剩余行（**实测踩过**：五处首次插入全部误落内层，typecheck 与多数用例都不报错，
   只有「同帧 usage」用例抓到）。
   ⚠️ **绝不能 abort `options.signal`** —— 那是**调用方**信号，abort 会被上层报成
   「用户取消」而非**标记为不完整**的 `max-tokens`（DSH 在 `max-tokens` 时
   **不自动重试** —— `dsh-agent-loop` 直接 `return {kind:'max-tokens'}`，
   UI 提示「发送"继续"可让模型接着输出」，即由**用户**决定是否继续）。
   只 cancel reader。
   ⚠️ `reader.cancel()` 必须 `.catch(() => {})`：连接已断时会抛错，不吞掉会把
   「正常止损」变成一次失败。
   ⚠️ **不得用 `continue`**（Task 2 审查发现、已实测复现）：`continue` 跳过本帧
   **剩余全部**处理，而 `usage` 与 `tool_calls` 都在 reasoning 分支**之后** ——
   「reasoning + usage 同帧」时 usage 被静默丢弃（实测：混合帧收到 **0 个** usage
   chunk，对照组 **1 个**）。正确写法是 `if (!loopDetected) { … }` 只包住累积与发射。
3. **`loopDetected` 的 finish 优先级高于 `tool_calls`** —— 循环中生成的工具
   调用参数不可信；且若无任何可用调用，落到 `stop` 会让任务**静默中断**
   （与「无报错中断」同族）。
4. **思考判据只喂 `reasoning`** —— 正文里的重复（代码块、列表）在思考通道是正常输出。
   ⚠️ 但**正文有自己的独立守卫**，见下节（2026-09-25 补充）。

开关 `DSH_REASONING_LOOP_GUARD` —— **默认开启**，仅显式假值关闭（与
`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 同为「默认开」语义，用独立的
`resolveReasoningLoopGuardFlag`，不要与 `isTruthyFlag` 混用）。

六个适配器全部接入（含 codearts 的 `reasoning` 与 `<thought>` **两条**出口）。
回归用例：`tests/unit/reasoning-loop.spec.ts`（判据）、
`tests/unit/reasoning-loop-adapter.spec.ts`（各适配器中断行为）；
fixture 为**真实会话文本**（`tests/fixtures/reasoning-*.txt`）。

#### ⚠️ 正文（text 通道）死循环：必须**独立实例**且**绝不 `cancel()`**

**真实缺陷**（用户报障，2026-09-25）：唯一活动 session（`lilishop-go` /
`workbuddy/hy4-preview-f`）出现**正文**循环，用户问「是只能处理思考不能处理
正文吗？还是这个循环还不够长？」

**答案：两者都不是 —— 是通道没接。** 旧实现六个落点**全部只喂 reasoning
增量**，正文分支从不调 `observe`。用**真实检测器**回放该会话正文，三段
**全部命中**（远超阈值，不是「不够长」）：

| seq | 正文长度 | 非空行 | 去重行 | 去重率 | 检测器 |
|---|---|---|---|---|---|
| 34752 | 4,641 | 486 | 20 | 0.0412 | HIT，cutAt=752 |
| 34768 | 8,875 | 416 | 39 | 0.0938 | HIT，cutAt=880 |
| 34823 | 34,406 | 2,711 | 473 | 0.1745 | HIT，cutAt=3256 |
| 35069 | 138,852 | — | — | — | HIT，撞满 `maxTokens: 64000` |

判据（去重率 < 0.35 且持续 ≥ 2000 字符）与思考侧**完全相同**，直接复用
`createReasoningLoopDetector`。

⚠️ **必须与思考守卫分成两个实例**：判据看**尾部 3000 字符窗口**的行去重率，
两条通道混进同一窗口会互相稀释，使守卫**双双失效**；共用一个 `cutAt` 也会
让一条通道的截断点错切另一条。

⚠️ **与思考守卫的语义差异（最关键，别照抄）**：思考死循环时模型**不产出工具
调用**，故命中即可 `reader.cancel()` 止损。但正文循环**不一样** —— 实测三段的
wire 帧顺序恒为

```
block-start(text) → text-chunks(循环正文) → block-start(tool-call)
  → tool-call-chunks → usage → block-end(tool-call) → block-end(text) → finish: tool-calls
```

**工具调用在循环正文之后才到达**，且调用有效、任务能继续。故正文守卫：
**只截断文本，绝不 `reader.cancel()`、绝不改 `finish` reason**。若照搬
`cancel()`，会把这些有效调用**整块丢掉**，把「能继续的任务」变成「什么都不做
就结束」—— 比循环本身更糟。

⚠️ **误报余量比思考侧更宽**（全语料 155 会话 / **32,725 步**实测）：

| 量 | 正常正文 | 命中样本 | 余量 |
|---|---|---|---|
| 窗口最低去重率 | **0.7667** | 最高 0.0387 | **19.8 倍** |
| 最长连续 looping 体量 | **0** | 3,937 ~ 8,064 | — |

正文命中 **4 次，全部是真循环**；其余 32,721 步零误报。
排查脚本 `scripts/measure-prose-loop-margin.mjs`、
`scripts/analyze-prose-loop-false-positive.mjs`；
回归用例 `tests/unit/prose-loop-guard.spec.ts`。

#### ⚠️ `</think:hex>` 闭标签：思考被上游塞进 `content` 通道

**同一缺陷的另一半。** `hy4-preview-f` 把**思考**写进 `content`（正文），只在
思考段末尾留一个 `</think:6124c78e>` **闭标签**。实测该会话 93 步里只有 **9 步**
的 reasoning 通道非空 —— 思考 9,563 字符 vs 正文 64,043 字符。

全语料普查（155 会话）：含标签 **28 步**，**开标签 0 个**、闭标签 28 个，
hex 恒为 `6124c78e`（会话级）；只出现在 `workbuddy/hy4-preview-f`（25）
与 `workbuddy/deepseek-v4.1-flash`（3）。

**判据**（`splitThinkTaggedContent`，`src/sse.ts`）：
- 以**最后一个**闭标签为界，标签**前** → reasoning 块、标签**后** → text 块；
- ⚠️ **只认闭标签，不猜开标签**：开标签恒缺失，仅见开标签时无法确定「思考到哪
  结束」，**不切分**（保持原样比猜错安全）；
- ⚠️ **无标签返回 `undefined`**，保证 99.6% 的普通响应**逐字节不变**；
- ⚠️ **必须在收尾做，不能逐帧**：标签会跨帧到达（`</think:61` + `24c78e>`）；
- ⚠️ **归位时必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为 reasoning
  块的**权威**，只改 `blocks` 条目不生效（测试直接暴露过这个坑）；
- ⚠️ **归位后正文可能为空串**（实测 seq=34768 形态）—— 空块会污染会话且违反
  DSH 的 `EMPTY_RESPONSE` 契约，故**不发空 text 块**（思考段已归位，仍有产出）。

⚠️ **引用判据不可省（否则误伤正常正文）**：标签可能只是被模型**讨论/复述**。
实测 28 处里 **3 处是反引号包裹的行内引用**（含排查本缺陷时复述该标签字面量的
正文）。判据「标签是否被反引号/围栏代码块包裹」分离度 **3/3 与 25/25，零交叉**。

回归用例 `tests/unit/think-tag-split.spec.ts`；真实会话端到端回放
`scripts/verify-prose-loop-replay.ts`（用会话里保存的**真实 wire 分片**重建 SSE，
喂真实 `BuddyAdapter`，断言**工具零丢失**）。

#### ⚠️ 行首 `course` / `课` 泄漏 token 会污染提示词

**真实缺陷**（用户报障，2026-09-23）：`deepseek-v4.1-flash` 的输出与思考中
「经常一行开头带一个中文『课』或英文『course』」。

实测形态（全库核实 295 会话 / 307 万行）：

| 事实 | 数据 |
|---|---|
| `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
| `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
| 位置分布 | 行首 **2347**、行中仅 28（后者全是排查期间的会话文字） |
| 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |

100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源）。

⚠️ **`课查` / `课修` 是「泄漏 + 模型循环」两个问题叠加**（用户补充，已证实）：
泄漏 token 后面直接跟模型正文/循环短句（`课查。` 895 次、`课跑。` 308、
`课修。` 307…）。这也解释了为何量极大 —— 模型一旦进入循环，每轮迭代都带一个泄漏前缀。

**判据**（`stripCourseLeak`，`src/sse.ts`）：

```
行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
  且后接 ∈ {空格, \t, \n, \r, 块尾}   → 删
行首（同上）的 `课`                     → 删
```

⚠️ **判据刻意不用白名单** —— 实测反证：泄漏就是**单个 `课` 字**，后面接任意正文，
故「`课` + 某字」永远可能是「泄漏 + 正文」的偶然组合：

| 曾以为要保护的词 | 数据真相 |
|---|---|
| `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
| `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
| `课程`(23) | **全在中部**，且全是排查期间的会话文字，非模型输出 |

`course` 后接**不接字母**是为保守（避免误删 `courseware`）；实测行首
`course` 后接非空白出现 **0 次**，故不影响覆盖率。

**两处落点，缺一不可**：

1. **消费侧（新输出）**：各适配器 `block-end` 处调 `stripCourseLeakIfEnabled` ——
   清洗已组装的块。放这里而非流式增量，是因为判据需要「行首」上下文，
   而增量里 `course` 可能跨 chunk 到达（`cou` + `rse`）。
   实测 `block-end` 是**权威覆盖**，改文本即生效（与死循环截断同机制）。
2. **序列化侧（存量自愈）**：`stripCourseLeakFromHistoryContent` 在
   `serializeMessages` 里清洗**已持久化**的历史。⚠️ **只清 `role === 'assistant'`**
   —— 判据只对模型自己的输出成立，**清洗用户输入等于篡改用户的话**；
   `tool-call` 的 `arguments` 也不清（是 JSON，改了破坏解析）。

**开关注入**：`DSH_COURSE_LEAK_STRIP` —— **默认开启**，仅显式假值
（`0`/`false`/`no`/`off`）关闭。用独立的 `resolveCourseLeakStripFlag`，
不要与 `isTruthyFlag`（默认关）混用。

⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
这样的句子开头，会变成「程设计已完成。」。实测 **0/2346**，但原理上非零。
若将来实测出现真实误删，应改为「行首 课 + 白名单词」的保护式判据
（但那时需先证明白名单不会被「泄漏 + 正文」的偶然组合绕过）。
⚠️ 判据**不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删
（实测泄漏都出现在自然语言段落，围栏内无此形态，故接受该简化）。

**实测效果**：全库 **2771 行泄漏 → 0 残留**；正常用法零误伤
（`of course` / ` recourse` / `研讨课` / `重要的一课` / `课程设计` 均保留）。
回归用例 `tests/unit/course-leak-strip.spec.ts`（33 条）；
端到端脚本 `scripts/verify-course-leak-e2e.ts`。

#### ⚠️ 纯空白思考会画出「空 Think 块」；零内容块响应必须报 `EMPTY_RESPONSE`

**真实缺陷**（用户报障，2026-09-23）：UI 上出现**空的思考（Think）块**。

实测：`deepseek-v4.1-flash` 偶发只输出**一个空格**当思考 —— 全库 **2233 个**
`trim()` 为空的 reasoning 块，`block.text` **全部是 `" "`**，且 wire 上
`reasoning-chunks.texts` 就是 `[" "]`；**上游为它计了 1 个 token**
（`usage.reasoningTokens=1`，2232/2232）⇒ **空格是模型真实生成的**，非适配器伪造。
分布：`buddy/deepseek-v4.1-flash` 1398 + `workbuddy/deepseek-v4.1-flash` 835。
（脚本 `scripts/trace-empty-reasoning.ts`、`scripts/analyze-reasoning-tokens.ts`。）

⚠️ **两个必须记住的机理**：

**① 「只改出口判据」不够 —— `BlockAssembler` 会用 `partial.text` 组装出残缺块。**
```js
assemble(partial, index) {
  if (partial.block) return partial.block                              // 有 block-end → 用它
  case "reasoning": return { type: "reasoning", text: partial.text }   // 无 → 用累积文本
```
⇒ 只要发过 `block-start`，即便**一个 `block-end` 都不发**，收尾仍会组装出块
（这正是「空 Think 块」的成因）。故必须**从一开始就不发任何 chunk**
（连 `block-start` 都不发）—— 与「空名字 `tool_call`」的修法**完全同型**。
实测脚本 `scripts/verify-empty-reasoning-fix.ts`。

**② 零内容块响应必须报 `EMPTY_RESPONSE`，不能报 `stop`。**
压制空块会引出**新退化形态**：若某响应本来只有那个空白 reasoning 块
（无 text、无 tool-call），就会产出「零块 + `finish: stop`」—— DSH 契约明令禁止：
> Providers occasionally emit a degenerate completion (a terminal stop with zero
> output); adapters classify it as this failure instead of yielding an empty
> assistant message, because **an empty message silently ends the turn with
> nothing for the user or the loop to act on**.

官方范本 `dsh-llm-deepseek`（`lib/index.js` 的 `translate()`）：
```js
reason.kind === "stop" && order.length === 0
  ? { kind: "error", failure: { message: "…no content", code: EMPTY_RESPONSE_CODE } }
  : reason
```
实测频率 **1/30404**（`scripts/quantify-empty-response-risk.ts`）。
这与本项目已两次踩过的同族坑（空名 `tool_call`、死循环）完全同型。

**判据与落点**：

| 位置 | 作用 |
|---|---|
| `src/sse.ts` 的 `createBlankReasoningSuppressor()` | 纯空白思考**一个 chunk 都不发**；转正那次**补发已累积全部文本**（含前导空格）。判据在**整块**（`["a"," "]` → `'a '` 保留），非单片 |
| `src/sse.ts` 的 `resolveEmptyResponseReason(reason, blockCount)` | 零块且原为 `stop` ⇒ `error`/`EMPTY_RESPONSE`；**只在 `kind === 'stop'` 时改写**（故 `loopDetected`/`length`/无名 tool_call/`tool-calls` 优先级全保留） |
| 5 个适配器的 reasoning 发射点（**6 处**，codearts 有两条出口） | 用 helper 的产出替代「无条件建块 + 发 chunk」 |
| 5 个适配器的 `finish` 出口 | `blockCount` = **实际发出的 `block-end` 数**，**不是 `blocks.length`** |

⚠️ **`blockCount` 必须数「实发块」。** 反例：`reasoning_content: '课'`
（本项目已知的真实泄漏 token）会让 helper **建块**，但收尾被
`stripCourseLeakIfEnabled` 洗成空串 ⇒ **实发 0 块而 `blocks.length === 1`**。
用 `blocks.length` 会把这种响应误判成「有 1 块」而报 `stop`（静默结束）。
审查据此实测：把 5 处换成 `blocks.length` 后 34/34 仍通过 —— **曾是测试盲区**，
`tests/unit/empty-response.spec.ts` 已补用例钉住它。

⚠️ **codearts 有两条 reasoning 出口**（`src/llm-adapter.ts:1113-1123` 自称
「漏一条就等于漏一条路径」）：① `delta.content` → `DsmlContentExtractor` 解析
`<thought>` → `emitDsmlFeed`；② `delta.reasoning_content` → `thinking`。
**两条共用同一个 helper 实例**（否则各自累积会错乱）。
回归测试必须**两条都覆盖** —— 审查发现只覆盖出口② 时，出口① 若回归
会**静默**放回空 Think 块（`tests/unit/blank-reasoning-adapter.spec.ts` 的
`A'/B'/C'/D'` 专组负责出口①）。

⚠️ **不得改动发送侧**：`buddy-adapter.ts` 的 `reasoning_content: reasoning` 是
**无条件写入**的（注释：推理模型缺失该字段会 400）。删掉存储侧空块后
`reasoning === ''` 但**字段依然存在** ⇒ 不会 400。**绝不可**改成条件写入。

**开关**：无独立开关（正确性修复，非可选项）。

回归用例：`tests/unit/blank-reasoning.spec.ts`（helper 语义）、
`tests/unit/blank-reasoning-adapter.spec.ts`（块层面「零 chunk」+ 出口①）、
`tests/unit/empty-response.spec.ts`（`finish` 归类 + `blockCount` 判据）。

★ **测试写法教训**（本任务反复踩到，值得单列）：

- **只断言 `finish` 不够**：空块回归时 `finish` 可能仍是 `EMPTY_RESPONSE`
  （因为 `blockCount` 仍为 0），必须**同时断言「没发任何 chunk」**。
- **测试注释里的论证必须有实测支撑**。本项目连续三次凭推理写下断言
  （「没有 D 则 A/B/C 全绿」等），**全部被自己的变异实验证伪**：
  C 与 D 都经过 `feed` 的「转正」分支，故**无法构造只打 D 的变异**。
  注释应**只写实测事实**（附「曾写进注释 / 变异 / 实测 / 结论」表格）。
- **变异测试是唯一能证明断言有判别力的手段**。用「恒真断言」或「只看测试通过」
  都会漏掉盲区 —— 本项目两次靠变异测试发现缺口（`blockCount` 盲区、
  出口① 无覆盖）。
- ⚠️ 变异实验脚本必须 `try/finally` 恢复，并在结束时用
  `git diff --quiet -- <file>` **确认无残留**（否则污染后续提交）。

### ⚠️ `tests/` 不在 `pnpm typecheck` 覆盖内

`tsconfig.json` 的 `include` **只有 `["src"]`** ⇒ `tests/` 的类型错误**不会**被
`pnpm typecheck` 发现。实测把 `tests/` 一并纳入后有 **108 个既有类型错误**
（`HeadersInit` 未定义、`ContentBlock[]` 赋值不兼容、`plugin-src/*.js` 缺声明等），
属独立工程。

⚠️ **新增/修改测试文件后，务必单独跑一次类型检查**（否则 `tests/` 里的类型错误
会被静默放过 —— 本任务已发生过一次：收紧 `src/` 的类型签名后 `pnpm typecheck`
仍 exit 0，但测试文件里有一处 TS2345）：

```
npx tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --esModuleInterop --types node --lib ES2023 --rootDir . <你的测试文件>
```

#### ⚠️ 测试 fixture 必须保持 LF（`core.autocrlf` 会造成假失败）

本机 `git config core.autocrlf=true`，checkout 时会把仓库里的 LF 转成 CRLF。
而 `tests/fixtures/reasoning-*.txt` 是**真实会话文本提取**，其**字符偏移被测试精确断言**
（`reasoning-loop.spec.ts` 的 `cutAt === 1536/1600`）—— 凭空多出的 3082 个 `\r`
会把偏移推到 **1792** ⇒ **两个断言失败**，且**在纯基线上同样失败**，
极易误判成「刚改的代码坏了」。

根治：`.gitattributes` 的 **`tests/fixtures/** text eol=lf`**。

⚠️ **必须是 `text eol=lf`，不能写成 `-text`**（初版写错，经审查实测纠正）：
- `-text`（不规范化）只挡**检出**期转换，**挡不住入库污染** —— 实测工作区是 CRLF 时
  `git add` 会把 48338 字节（含 617 个 `\r`）写进索引（HEAD 本为 47721），
  此后 `checkout` 把这些 `\r` 发给所有人，**偏移断言对全仓库永久失败**；
- `text eol=lf` 同时具备两项能力：检出写 LF，**入库时把 CRLF 规范化回 LF**。

用 `**` 而非 `*`：gitattributes 的单星**不跨目录**（实测子目录为 `unspecified`）。

**自查**：`git ls-files --eol -- tests/fixtures/` 应全是 `i/lf w/lf`。

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

## 「+ 新建账号」必须两步式返回 loginUrl（六个 provider 一致）

`account.create` 对**全部六个 provider** 都必须在**用户完成授权之前**返回
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

**五套协议完全不同**的实现，各自独立：

**Qoder** —— `src/qoder-credits.ts`（2026-09-21 由 keylog 解密抓包解出）：

- 状态查询：`GET /sash/api/v1/me/campaigns`
  （**必需 Bearer + `Cosy-ClientType:'10'` + `Cosy-MachineToken`/`Cosy-MachineType` 成对**；
  ⚠️ 少了 machine 头只会拿到 1 条 `VIEW_DETAILS`，**看不到可领活动** —— 见上「Qoder 每日领取」）
- 领取：`POST /sash/api/v1/me/campaigns/{campaignId}/claim`（**body 空**）
- 幂等：重复领取返回 **HTTP 200 + `replayed:true`**（且不含 `benefit`、
  `claimedAt` 是旧时间）—— 判定**以响应体 `replayed` 为准**，不能只看 HTTP 状态
- 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`
- 活动每日 10:00（UTC+8）刷新，领取后 30 天有效

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
| `qoder` | ✓（`sash/api/v2/me/usage`，只需 Bearer） | ✓（`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`） |
| `trae` | ✓ | ✓（`checkin_credits` 两步流程） |

> ⚠️ `qoder` **必须显式登记**，不能省略：上面那条「能力矩阵与 `PROVIDERS` 条目集合相等」的断言要求两者同步，而 qoder 必然要进 `PROVIDERS`（否则面板不渲染）。
>
> ⚠️ **早期把 qoder 误判为两项皆无**（登记成 `balance:false`），根因有二，都值得记住：
> 1. **只按 `/api/` 前缀搜端点**，而余额挂在 **`/sash/`** 下 → 漏检；
> 2. **误以为用量端点也需要 WASM 签名** —— 实测只需 `Bearer` + `Cosy-ClientType`
>    （**活动端点还额外需要成对的 machine 头**，用量端点则不需要：
>    实测它对这两个头不敏感）。
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

## ⚠️ Loomy（讯飞）provider：五个不能凭直觉改的点

`loomy` 是第 8 个 provider，与其余七者**都不同源**。实现是独立一套
`src/loomy*.ts`（`loomy-product` / `loomy` / `loomy-sign` / `loomy-oauth` /
`loomy-onboarding` / `loomy-credits` / `loomy-auth` / `loomy-adapter`），
适配器复用 `src/openai-compat.ts`（实测是标准 OpenAI 兼容 + 标准 SSE，与 qoder 同形）。

**真实依据**：2026-09-26 用本机登录态对生产端点逐项实测。
以下五条都有实测证据，**不要按其余 provider 的直觉改**：

1. **两套认证头（最容易踩）**：`/chat/completions` 只认
   `Authorization: Bearer <session>`；`/models`、`/points/*`、
   `/onboarding/*` 只认 `token: <session>`。带错的会得到 HTTP 200 +
   `{"code":"100002","desc":"缺少 token"}` —— 看着像「登录失效」，
   实为头用错了。实测交叉矩阵：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

   `loomyChatHeaders()` 两个都发（官方 `llm-completion.js:149-151` 也如此）。
   ⚠️ `Bearer ` 前缀**必需**：无前缀同样回 `100002`。

2. **没有 refresh 端点，`isLoomyRefreshable()` 恒 `false`**。
   `session` 是登录时声明 `expire: 1209600`（14 天）得来的，凭据里**没有**
   `refresh_token`。故 `refresh()` / `refreshAccountCredential()` 是**有效性探测**
   而非续期（探测走 `GET /points/records?pageSize=1`，只读零消耗），
   `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
   ⚠️ **不要**为了让 `refreshAll` 有活干而把 `refreshable` 改成 true ——
   那会让 UI 假装能续期，实际每次探测都失败。
   ⚠️ `scheduleRefresh()` / `stop()` 是**有意为之的空实现**：`RefreshScheduler`
   的意义是「过期前 1 小时自动续期」，Loomy 无法续期，武装它只会得到
   「触发 → 探测 → 必然抛错 → 停止」的空转。保留空实现是**契约要求**
   （`index.ts` 对全部 provider 统一调用）。

3. **新手任务服务端不校验前置行为**：直接 `POST /onboarding/tasks/complete`
   （body 仅 `{"key":...}`）即可拿满 10000 分，**零 token 消耗**。
   8 个任务：`first_message` 500 / `pick_skill` 1000 / `generate_ppt` 1500 /
   `set_schedule` 1000 / `install_skill` 1500 / `configure_remote` 1000 /
   `create_soul` 1500 / `share_soul` 2000。
   这与 workbuddy2api-panel 的做法**相反**（那边要模拟真实行为、
   上报埋点事件链）。**不要**「照 workbuddy 那样」去发对话/建定时任务 ——
   那是白花积分。若将来服务端加了校验，再走「用 `qwen3.8-flash`
   （x0.8，全表最便宜）模拟真实动作」的降级路径。
   ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
   ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算
   （官方 `onboarding-service.js:177-183` 明说不信任）。

4. **倍率在 `name` 字符串里**，没有独立字段，且三种括号风格混用
   （`MiniMax M3 （x4.0）` 全角带空格 / `Qwen 3.8 Max (x12.0)` 半角 /
   `GLM 5.3 Flash(x0.8)` 半角无空格）。故用 `loomyDisplayName()` 规范化。
   ⚠️ `splitLoomyRate()` **必须同时认两种形态**：远端原值（末尾括号）
   **和**已规范化的 `{name} · x{n}` —— 兜底表（`loomy-product.ts`）存的就是后者。
   早期只认括号形态，于是 `resolveModel` 无法从兜底表名去掉倍率，
   返回 `Spark X2.5 · x0.1` 而非 `Spark X2.5`（实现时暴露的真实缺陷）。
   该函数**幂等**，单测锁死。
   ⚠️ chat 模型过滤判据是 **`type === 'chat'`**，不能看 `input_modalities`
   —— 5 个 chat 模型的输入模态含 `image`（能看图），不是生图模型。

5. **积分是两个池**：永久（`balance`）与每日赠送（`dailyBalance`）分开计算。
   每日额度由 `POST /points/first-login` 触发（官方登录后立即调用），
   语义是**触发额度重置**而非「+5000 积分」：
   实测 `dailyBalance = dailyQuota - dailyConsumed`（4992 = 5000 - 8），
   消耗后不回补。故「一键签到」用 `alreadyProcessed` 判幂等并映射成
   `already-claimed`，**不是** `claimed`。
   ⚠️ **余额查询必须走只读的 `GET /points/records`**，不能用 `first-login`
   —— 后者是**写**端点，在「打开面板」这种高频路径上调用会意外触发签到。
   ⚠️ `dailyQuota` **只在 `first-login` 响应里**，`points/records` 不返回它，
   故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。

### 短信登录：唯一没有 loginUrl 的 provider

其余 7 个都是「`account.create` 返回 `loginUrl` → 前端 `window.open` →
轮询 `login.poll`」。短信登录**没有 URL 可打开**，故扩展了登录契约：

- `RpcCreateAccountRequest` 加可选 `phone`
- `RpcCreateAccountResponse` 加可选 `loginMode: 'url' | 'sms'`
  ⚠️ **缺省必须视为 `'url'`** —— 既有 7 个 provider 不传该字段，
  行为必须逐字节不变
- 新增 `login.sendSms` / `login.submitSms` 两个端点

⚠️ **msgid 用内存暂存表**（`pendingSmsMsgid`），**不写进 `ctx.credentials`**
—— 它是一次性中间态（5 分钟有效），写凭据会污染命名空间，且它不含任何秘密。

⚠️ **短信登录失败不删占位账号条目**：用户多半只是验证码输错，保留条目让他能重试。

⚠️ **前端短信分支绝不能回退到 `window.location.href`** —— 那会把整个设置页
导航走（与 `createAccount` 的既有约定同因，见「+ 新建账号」章节）。

### 能力矩阵第三项：`onboardingTasks`

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立，不能互相推断**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

⚠️ 客户端**不调用** `onboarding.status`：`onboarding.claim` 的响应已带回
`earned`/`total`/逐任务明细，足以渲染进度，再发一次只读查询纯属多余请求。

### 账号卡片：两个积分池分开显示

`CreditBalanceRow` 对「恰好两个包且名字为 `永久积分` / `每日赠送`」的形态
显示 `永久 15000 · 每日 4992`；其余 provider 的多个同类资源包仍显示
「N/M 个资源包有效」。两种形态互斥（`isLoomyTwoPools`）。

### ⚠️ AccessKey 明文入库（用户明确同意）

`src/loomy-product.ts` 内含从 Loomy 客户端解密得到的讯飞账号 AccessKey。
它**只用于讯飞账号端点**（`account.xfinfr.com` 的登录签名），与业务/推理端点无关
（后者用用户登录后的 `session`），故泄露不涉及任何用户数据。

⚠️ **具体值、解密算法与口令、脚本清单见不入库的
`docs/loomy-protocol-notes.md`** —— 不要把它们写进 README / AGENTS.md。

### 新增 provider 时的位置参数陷阱（本次踩过）

`registerJetHubRpc` 与 `registerJetHubEndpoints` 的 auth 实例是**位置参数**。
新增 Loomy 时，三个既有测试因把参数列表写死而假失败：

- `tests/unit/qoder-wiring.spec.ts`（正则只允许一个 provider 插在 trae 后）
- `tests/unit/cline-adapter.spec.ts`（`toContain` 写死整串）
- `tests/unit/jet-hub-rpc.spec.ts`（9 个 `{}` 占位，新签名要 10 个 →
  `modelAdapters` 错位落到 `loomy` 形参上）

三处已改为**对 provider 数量中立**的断言（`[\w, ]*` / 显式补占位并注明原因）。
**再加 provider 时请沿用这种写法**，不要写死整串。
