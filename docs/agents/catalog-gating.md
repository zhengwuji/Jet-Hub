# 模型目录：黑名单、账号门控与两步式登录

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**：完整保留证据、推导、示例与排查记录。
> 主文件只留「规则 + 索引」；改动相关代码前请先读本分册——**规则本身在主文件里是完整的，
> 本分册补充的是「为什么」与「怎么排查」**。

模型黑名单机制、无账号门控、listAllModels 契约、两步式 loginUrl 返回时序。改动 listModels / model.list RPC 前必读。

---
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


---

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

⚠️ **六个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
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


---

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


---

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

