# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

---

## 📚 分册索引（必读）

本文件只保留**规则与约定**。完整证据、推导过程、实测数据、排查脚本与历史缺陷
记录在下列分册中 —— **改动相关代码前请先读对应分册**。

> ⚠️ **规则本身在本文件里是完整的**。分册补充的是「为什么这么定」与「出错时怎么查」。
> 出现异常现象、或要推翻某条规则时，**必须**先读分册，别重复已记录过的排查路径。

| 分册 | 覆盖内容 | 何时必读 |
|---|---|---|
| [`docs/agents/trae.md`](docs/agents/trae.md) | TRAE 四条协议的坑、通道路由、推理档位、Max 模式、图片判定 | 改 `src/trae*.ts` |
| [`docs/agents/pricing.md`](docs/agents/pricing.md) | 计费倍率解析差异、`maxOutputTokens` 下发、同名消歧、X-Domain | 改展示名 / 请求头 / 输出上限 |
| [`docs/agents/credits.md`](docs/agents/credits.md) | 五个 provider 的签到协议、幂等判据、能力矩阵门控 | 改 `src/*-credits.ts` / `credits-capabilities.js` |
| [`docs/agents/antigravity.md`](docs/agents/antigravity.md) | 两条通道选路、八条防封号硬性约束、协议字段位置 | 改 `src/antigravity*.ts` |
| [`docs/agents/catalog-gating.md`](docs/agents/catalog-gating.md) | 模型黑名单、账号门控、`listAllModels` 契约、两步式登录 | 改 `listModels` / `model.list` RPC |
| [`docs/agents/qoder.md`](docs/agents/qoder.md) | Qoder 积分端点实测、幂等判据、`openai-compat.ts` 边界 | 改 `src/qoder*.ts` / `openai-compat.ts` |

---

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件演进涵盖了七个 LLM provider 路由核心骨架及其区域版本，全量支持 **14 个 provider**，分属 8 套互不相同的协议族：

| 协议族 | provider | 特点 |
|---|---|---|
| 腾讯 CodeBuddy 系 | `buddy` / `buddy-intl` / `workbuddy-cn` / `workbuddy` | 同一 CLI 内核与认证协议，差异**全在 `endpoint`** |
| 有道 LobsterAI | `lobsterai` | 本地回调 + authCode 换 token |
| 阿里 Qoder | `qoder` / `qoder-cn` | PKCE 设备码轮询 + **加密推理端点**（WASM 签名） |
| 字节 TRAE | `trae` / `trae-intl` | ExchangeToken 轮换 + 载荷双向转换（OpenAI ↔ SOLO） |
| 华为 CodeArts | `codearts` | `SDK-HMAC-SHA256` 签名 |
| Google Antigravity | `antigravity` | 本机凭据复用，**不进账号池** |
| Cline | `cline` | WorkOS 设备码轮询 + 免费模型识别 + 5 档思考强度 |
| 讯飞 Loomy | `loomy` | 微信扫码 + 手机号/短信登录 + 智能余额选号 |
| 商汤小浣熊 | `raccoon` | 二维码扫码/手机验证码 + AES-128 加密 + 积分签到 |

⚠️ **区域版各占一个 provider**：CodeBuddy `buddy`(国内)/`buddy-intl`(国际)、
WorkBuddy `workbuddy-cn`(国内)/`workbuddy`(国际)、Qoder `qoder`(国际)/`qoder-cn`(国内)、
TRAE `trae`(国内)/`trae-intl`(国际)。两侧端点与登录态**互不相通**，凭据各自独立。

### 协议族的硬性差异（改代码前必读）

- **CodeBuddy 系**：`endpoint` 中国版 `copilot.tencent.com` / 国际版
  `www.workbuddy.ai`、`www.codebuddy.ai`。**模型池由 endpoint 决定**，
  故不可当作全局常量。相邻产品共用一个适配器类，差异由产品配置承载。
- **LobsterAI**：与腾讯系**完全不同源**（登录方式、请求头、续期载荷、签到流程、
  版本号来源都不同）。**不共用 `BuddyProduct` 类型** —— 其中 `apiDomain` /
  `productCode` / `attributionName` / `userAgentByModelFamily` /
  `appendSessionParams` 对它全部无意义。独立一套 `src/lobsterai*.ts`。
- **Qoder**：独立一套 `src/qoder*.ts`。**两条推理路径认两套模型名且 host 不同**
  （加密走 `api2.qoder.sh` 认目录 key / 公开走 `api2-v2.qoder.sh` 认通用名，
  混用 404）。加密请求体的签名头**必须原样透传**，用 `Bearer` 覆盖会被判签名无效。
  ⚠️ 改 `qoder-wasm.ts` 前先读**不入库**的 `docs/qoder-encryption-notes.md`。
- **TRAE**：独立一套 `src/trae*.ts`，**请求体与响应都要转换**。详见
  [trae 分册](docs/agents/trae.md)。
- **`src/openai-compat.ts` 只服务 qoder**。`buddy-adapter.ts` /
  `lobsterai-adapter.ts` **刻意不改用它** —— 那两份已被大量单测与线上流量验证，
  重构属无关高风险改动。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` + `esbuild` + `.wasm` 资源复制）
- **语言**：TypeScript　**许可**：MIT

## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧 `tsc` → `lib/`；客户端 `esbuild`
  （`plugin-src/client/build.mjs`）→ `lib/client/jet-hub.js`；
  `scripts/copy-assets.mjs` 复制 `.wasm`（**`tsc` 不搬非 TS 资源**）。
  三者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all`。
- **测试**：Vitest
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端，按 provider 分列，**均有闸门默认跳过**，
    哪些消耗模型积分见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致

## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore） |
| `tests/unit/` | 单元测试 |
| `docs/agents/` | **AGENTS.md 分册**（见上方索引） |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `scripts/` | 构建辅助、只读探针脚本 |

## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials`，ref 格式遵循 POSIX 标识符
- LLM provider 通过 `ctx.llm.registerAdapter()` / `registerConfigurableProviders()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

所有 `ctx.xxxAuth` 服务遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName)` — 按凭据 ref 续期**指定账号**
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：所有 provider 的登录/状态/续期**全部**在 Jet Hub 完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`。`refreshModels()` **签名改为接收 `pool`**。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 门控判据因此**完全一致**：都只看账号池，`extraCredentialRefs` 参数已删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关。

**真实缺陷**：两处都按 `enabled` 过滤 →
`refreshAll()` 里停用期间 refresh_token 一路放到失效；
调度器的 `accounts.some(a => a.refreshable && a.enabled)` 让
**所有账号都停用时续期定时器根本不启动**。用户重新启用后拿到死凭据，只能重新登录。

所有 provider 的 `refreshAll` 与调度器**都必须保持只看 `refreshable`**。

### ⚠️ 客户端列出的 provider 必须与服务端注册**一一对应**（面板不得成空壳）

**铁律**：`plugin-src/client/jet-hub.js` 的 `PROVIDERS` 列表里**每一个** id，
都必须在服务端有对应的 **provider 路由 + 适配器 + settings namespace**。
两侧集合必须相等 —— 客户端列了而服务端没注册，就是**空壳面板**。

**真实缺陷**：合并时把服务端产品从 4 个收敛成 2 个，**但客户端列表没同步收敛**。
`buddy-intl` 与 `workbuddy-cn` 成空壳，三处后果：

| 后果 | 表现 |
|---|---|
| 账号成**孤儿** | 账号池里的 `workbuddy-cn` 能看见，但**无法续期、无法删除** |
| 设置页**崩溃** | namespace 未注册 → `refFor → deriveKeyRef(provider)` 抛 `provider.toUpperCase is not a function` |
| 「刷新」**报错** | `account.refresh` 的 switch 缺这两条 → 落 `default` 抛 `Unknown provider` |

**新增/删除 provider 的完整清单**（漏一处就出上面三类问题）：

1. `src/<product>.ts` — 产品配置常量 + 加进该族的 `ALL_*_PRODUCTS`
2. `src/index.ts` — `new XxxAuth(ctx, { product })`、`registerXxxLlm(...)`
3. `src/index.ts` — `registerProviderSettings(...)` 里加 **`llm-${product.id}`**
4. `src/index.ts` — `refreshAllCredentials()` 与**两个** `ctx.effect` 清理块
5. `src/index.ts` — `modelAdapters` 映射（「显示列表」要用 `listAllModels()`）
6. `src/index.ts` — `registerJetHubRpc(...)` 实参
7. `src/jet-hub-rpc.ts` — 区域族分派 Map（`buddyServices` / `qoderServices` / `traeServices`）
8. `src/jet-hub-rpc.ts` — `account.refresh` 的 switch 分支（**最容易漏**）
9. `plugin-src/client/jet-hub.js` — `PROVIDERS` 面板项
10. `plugin-src/client/credits-capabilities.js` — 能力表（**必须与 PROVIDERS 等集**）

**由测试锁死**（`tests/unit/plugin.spec.ts`）：
- 「客户端列出的每个 provider 都有服务端实例（防面板空壳）」—— 直接比对两个集合；
- 「能力矩阵覆盖 PROVIDERS 中的每一个 provider」—— 断言两集合排序后相等。
  ⚠️ 该断言的正则必须写成 `([a-z][a-z0-9-]*)` 才能匹配带连字符的区域 id；
  早期写成 `([a-z]+)` 时这些 provider **完全搜不到**，断言形同虚设。

**为什么不能「悄悄收敛」**：面板是**用户可见入口**。面板在而服务端无实例时，
用户点进去什么都不工作，且已有账号**静默变砖**（数据还在、功能全无）。
要收敛必须两侧同时收敛，并给出账号迁移方案。

各 provider 的登录/续期机制不同（见分册与 README.md），
但均通过 `ctx.credentials` 统一管理凭据生命周期。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间保存账号索引，
凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，查询均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池
  （写死 `'buddy'` 会让其它产品永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；
  全部耗尽才抛 `QUOTA_EXCEEDED`

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，会让手动顺序形同虚设。
  现语义是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，
  正处于限流期的账号已被 `filter` 排除。
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**。
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错
  （少了会静默掉到末尾、多了说明前后端状态不一致）。
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` +
  纯逻辑 `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在
  目标卡片上半/下半判定）。只支持「插入到目标之前」时，
  把卡片**往下拖一格是空操作**。插入线指示必须与实际落点一致。
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标。

---

## 🔒 规则速查（铁律合集）

以下每条都是**硬性约束**。细节与原委见对应分册。

### 单次输出上限必须下发，不能只用来过滤
📖 [pricing 分册](docs/agents/pricing.md)

腾讯系两个端点都下发 `data.models[].maxOutputTokens`。它是权威的单次请求输出额度，
适配器**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`。

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值。
- ⚠️ **远端是外部输入，非法值必须过滤**：DSH 对 `defaultMaxTokens` 有硬校验，
  `0` / 负数 / `NaN` 会抛 `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**。
- `reasoning_tokens` **计入** `completion_tokens`：思考与正文共享额度。
  「单次请求」≠「单轮」——每 step 独立预算。

### 计费倍率必须写进 `name`，不是 `description`
📖 [pricing 分册](docs/agents/pricing.md)

- ⚠️ composer 的**模型切换菜单只渲染 `name`**（`ModelSelect` 里只有
  `title: model.name` 与 `children: model.name`，**完全不读 `description`**）。
  `description` 只在 `/model` 弹窗用。
- `name` **纯属展示**，DSH 的选择与持久化只用 `id`，故附加价格不会污染会话历史。
- 四个 provider 的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 |
|---|---|---|
| `buddy` / `workbuddy*` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前） |
| 同上 | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）** |
| `lobsterai` | `data[].costMultiplier` | **裸数字** `0.05` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = 免费 |
| `trae` | `display_contact_config.consumption_rate.data.rate` | **裸数字**；该字段本身是 **JSON 字符串，须二次 `JSON.parse`** |

- ⚠️ **`0` 一律是「免费」而非「无倍率」**（三个 provider 皆然），
  用 `> 0` 过滤会恰好漏掉用户最关心的免费模型。展示为「免费」而非 `x0`。
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**。「已结束」由有效期表达。
- ⚠️ **必须按 `schedule` / 窗口本地推算此刻是否生效，不能只看 `enabled` / `active`**：
  后者是采集时刻的快照，窗口切换后即失真。
- ⚠️ **促销与模型 id 集合两个端点可能不同，必须取并集**；促销只由 `/v3/config` 下发。
- ⚠️ **`/v3/config` 有 UA 校验**，UA 不对返回 **HTTP 200** 但正文是错误码，极易误判。
- 折扣统一用「**原价→折后价**」箭头（`x0.79→x0.50`），不附中文角标（与数字冗余）。
- **同名模型必须消歧**：远端给不同 id 配同一 `name` 会让列表出现重复条目。
  用**公共前缀**切分追加变体标记；⚠️ 不要硬编码 `-sg`、也不要取 id 最后一段。
  ⚠️ 消歧必须基于**未过滤的全量集合**，否则名字会随开关跳变。

### 模型黑名单与目录门控
📖 [catalog-gating 分册](docs/agents/catalog-gating.md)

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开。
- 过滤点在适配器的 `listModels`，每次调用实时读，改开关后无需重建适配器。
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发。
- ⚠️ `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方字段，
  否则一次账号操作会把模型开关清空（反之亦然）。
- ⚠️ **设置页目录必须走 `listAllModels()`，不能复用 `listModels()`**：
  后者按黑名单过滤，被关闭的模型会退化成裸 id，**倍率与展示名随之丢失**。
- ⚠️ **`ctx.llm` 不透传自定义方法**，所以适配器实例必须由 `index.ts` 收集成
  `modelAdapters` 传给 `registerJetHubRpc`。加新 provider 时别忘两处：
  `listAllModels()` + 在 `modelAdapters` 里登记。
- **目录门控**：没有已登录账号的 provider 返回**空数组**即被 DSH 隐藏
  （`buildModelCatalog` 会 `.filter(g => g.models.length > 0)`）。
  ⚠️ **必须返回 `[]` 而绝不能抛错**（抛错会被归入 `failures`，界面反而多一条报错）。
  ⚠️ **不影响路由** —— DSH 约定 "Catalog membership is advisory and never
  changes routing"，已持久化的模型仍可正常收发。
- 门控判据是**凭据能否解析**（`hasLoggedInAccount`），**不是**「有没有账号条目」；
  **不看 `enabled`**（停用只影响选号）。判据不可用时**保守放行**。
- 门控开关 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，
  只有显式假值才关闭（与 `isTruthyFlag` 的「默认关」语义相反，勿混用）。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**（无账号时省一次 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开。

### 两步式登录必须立即返回 loginUrl
📖 [catalog-gating 分册](docs/agents/catalog-gating.md)

所有 provider 的「新建账号」都是**两步式**：先返回 `loginUrl`，后台再等回调。
⚠️ **不得改回阻塞式**（等用户授权完才返回）—— 那时浏览器手势早已过期，
`window.open` 必被拦截，且前端会退化成导航跳转，**把整个设置页导航到外部登录页**。

### 积分领取（每日签到）
📖 [credits 分册](docs/agents/credits.md)

- 五个面板提供签到：CodeBuddy、LobsterAI、CodeArts、Qoder、TRAE。
  **WorkBuddy 国内版与国际版都没有**（后端无签到接口）。
- ⚠️ **幂等判据是响应体字段，不是 HTTP 状态码**：重复领取同样返回 200 / `code:0`，
  必须看响应体（如 Qoder 的 `replayed:true`、CodeBuddy 的 `code:10001`）。
- ⚠️ **不支持签到的 provider 必须如实返回 `null` 状态**，不得臆造状态对象。
- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用** ——
  停用只影响账号池选号，与「该账号今天领了没」无关。
- ⚠️ **默认实现的签名必须显式适配**，不能用 `as unknown as` 硬转。

### 积分能力必须在请求前判定
📖 [credits 分册](docs/agents/credits.md)

能力矩阵（`plugin-src/client/credits-capabilities.js`）是唯一真相源，
`supportsCreditBalance` / `supportsDailyCheckin` **分别**判定两项能力。
为 false 时**不得**发起对应请求，也不应渲染相关 UI。
⚠️ 该表必须与 `PROVIDERS` 列表**等集**（由单测断言）。

### Antigravity 渠道硬性约束（防封号）
📖 [antigravity 分册](docs/agents/antigravity.md)

**八条不可破坏的约束**（架构决策，非风格偏好）：

1. **不得加入 `ALL_PRODUCTS`** —— 该数组会用于创建多账号实例并接入 `refreshAll` /
   限流轮换，而 Google 侧对「同一账号被多客户端高频轮换」的判定远比腾讯侧严格。
2. **不得给 `AntigravityAdapter` 传入 `accountPool`** —— 固定单账号、串行、限速
   （两次请求间隔 ≥ 1s）。
3. **`state.vscdb` 必须以 `readOnly: true` 打开** —— IDE 运行时该库处于 WAL 模式，
   写入会争锁并可能损坏凭据。
4. **不得伪造客户端身份标识** —— 不要复制 `buddy-adapter.ts` 的
   `User-Agent: CodeBuddyIDE/...` 伪装做法；Google 侧对指纹不匹配极敏感。
5. **续期默认交给 IDE** —— IDE 自行续期并写回；每次调用都重读凭据。
6. **方案 B 不读 `state.vscdb`** —— 账号身份由 IDE 运行时决定。
7. **方案 B 不发 `Authorization`** 与任何自定义业务头（本地 loopback 只需
   `Content-Type` 与 `x-codeium-csrf-token`）。
8. **CSRF token 不得落日志、不得持久化** —— 所有错误信息构造处都要经过 `redact()`。
9. **发现流程不得硬编码端口** —— 端口与 token 随 IDE 重启变化，必须每次动态确认配对。

**两个致命字段位置**（写错就完全不通）：
- 鉴权头名是 **`x-codeium-csrf-token`**，不是 `x-csrf-token`。
- 模型**必须**放在 `SendUserCascadeMessage.cascadeConfig.plannerConfig.planModel`，
  取值是 `MODEL_PLACEHOLDER_*` **原样字符串**。放到 `StartCascade.requestedModel`
  （那是枚举）或 `requestedModelId` 都会在执行时报错。
- 回复**没有服务端流式**，只能轮询 `GetCascadeTrajectory`；模型文本在
  `steps[].plannerResponse.modifiedResponse`（回退 `.response`）。

**自适应选路**：本地通道可用就不探测公共 API（少一次出站即少一分指纹暴露）；
本地不可用才降级。⚠️ 本地通道的判据是 **`Heartbeat` 通过**，不是「能拉到模型清单」
（清单只是 advisory，当判据会让瞬时抖动误报为不可用）。

⚠️ **不要**把 `generateContent` 的 403 当成「插件写错了」去改鉴权代码 ——
本机实测该账号未开通对应公共 API（`loadCodeAssist` 返回 200 说明凭据本身有效）。

### TRAE 协议要点
📖 [trae 分册](docs/agents/trae.md)（**必读**，36 KB 完整记录）

- ⚠️ **必须先做「消息序列化」，再做载荷转换**。DSH 交给适配器的是**原生块结构**，
  不是 OpenAI wire 格式。漏了这一步 → 模型看不到自己调用过什么、也看不到工具返回值，
  **全程无报错**，极难排查。
- **请求体必须转换**（不能透传）；`tools[].function.parameters` 必须序列化为
  **JSON 字符串**，故 tools 必须在转换**之前**放进源对象。
- **响应是 SOLO 自定义 SSE**，必须自行解析并转成 OpenAI chunk。
- **凭据必须持久化 `machine_id` 与 `device_id`**（均 32 位 hex）。
  ⚠️ `machine_id` **续期时绝不可重新生成**；`device_id` **账号间必须互异**。
- **模型只在列出它的通道里可调用**（发错通道 → 流内 `4001`）。
  ⚠️ 用 `batch_get_detail_param`（**不是** `get_detail_param`）。
- ⚠️ **写探针时务必用 `new Headers(base).set(...)`**，不要用对象展开叠同名头
  （大小写不同会被 `append` 合并成非法值）。
- **Max 模式默认开启**：只有远端 `display_config.max_mode === true` 的模型才走 1M，
  ⚠️ **绝不**给未标记的模型硬套 Max 参数。
- **图片能力必须逐模型判定**（远端 `display_config.multimodal`），
  ⚠️ 不能按 provider 一刀切 —— 未声明即按不支持，不臆造能力。

### LobsterAI 模型列表
📖 [catalog-gating 分册](docs/agents/catalog-gating.md)

- ⚠️ **思考档位的 wire 值是 `openclawLevel`，不是 `level`**；
  但**展示名**必须用 `level`。
- ⚠️ **SSE 的 `delta.content` / `delta.reasoning_content` 会显式返回 `null`**，
  必须 `typeof === 'string'` 判定。
- 远端模型参数必须消费（不能只看 id/name）。

### X-Domain 必须跟随产品
📖 [pricing 分册](docs/agents/pricing.md)

`X-Domain` 头取**产品的 `apiDomain`**，不是凭据里的 domain。凭据可能来自旧版本产品，
用错会把请求发到错误的区域端点。

---

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all`（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档（**改到某分册覆盖的模块时，同步更新该分册**）

### 新增 provider

按上文「新增/删除 provider 的完整清单」10 项逐条落实，
并补一条 `plugin.spec.ts` 的面板一致性断言。

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量（如 `DSH_CODEARTS_E2E=1`），
  部分用例需在打开的浏览器中人工点击授权
- 构建错误检查 `lib/` 是否存在以及 `tsconfig.json` 的 include/exclude

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络
- E2E 按 provider 分开（`pnpm test:e2e:*`），**均带闸门默认跳过**
- ⚠️ oauth 类用例会起本地 HTTP server，**并行跑偶发端口竞态**；
  排查失败时先**隔离运行单个文件**再判断是否真失败

## ⚠️ Loomy（讯飞）provider：协议要点与负载均衡

- **两套认证头**：chat 推理用 Bearer 头（`Bearer <token>`），而业务与模型端点使用 token 头（`token: <token>`）。
- **不可续期**：Loomy 服务端没有 refresh 端点，因此 `isLoomyRefreshable` 恒为 false（凭据失效需重新登录）。
- **新手任务**：纯 API 直领新手任务奖励积分，无需客户端环境。
- **负载均衡与选号策略**：
  - Loomy 不会因积分耗尽报错，而是**静默降级**为扣永久积分，既有报错换号机制无效。
  - 必须由适配器在 `resolveCredential` 中接收 `modelId` 并透传，先过滤「未停用 + 该模型未受限」的候选账号，再按余额分档：优先消耗每日赠送额度，其次消耗永久积分。
  - 档内保持手动拖拽顺序，查询失败归最后一档；调用 `getAvailableAccount` 兜底。
- **位置参数注意点**：`registerJetHubRpc` 采用位置参数传递各 provider 服务实例，新增服务时需严格维护形参位置顺序，避免错位。

## LLM Provider 约定

- provider 名称（**11 个**）：`codearts` / `buddy` / `buddy-intl` / `workbuddy-cn` /
  `workbuddy` / `lobsterai` / `qoder` / `qoder-cn` / `trae` / `trae-intl` / `antigravity`
  - ⚠️ 必须与 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` **完全一致**
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名
  - `buddy` / `workbuddy*`：Bearer access_token + 自定义头（`X-Product-Code` 随产品切换）
  - `antigravity`：Bearer access_token（Google OAuth）+ Cloud Code 私有协议
  - `lobsterai`：Bearer + `X-LobsterAI-Client-*`（**无签名**）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**；余额端点另走 `Bearer`
  - `trae`：`Cloud-IDE-JWT <token>` + 十余个 `X-*` 身份头（**无签名**）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- **产品配置平行而非继承**：`BuddyProduct`（`src/product.ts`）/
  `LobsteraiProduct` / `QoderProduct` / `TraeProduct` 各自独立。
  同源产品共用适配器类，差异全部由产品配置驱动；新增同源产品只需加一份配置并注册实例。
