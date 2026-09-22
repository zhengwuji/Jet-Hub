# TRAE（字节跳动）协议要点

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**：完整保留证据、推导、示例与排查记录。
> 主文件只留「规则 + 索引」；改动相关代码前请先读本分册——**规则本身在主文件里是完整的，
> 本分册补充的是「为什么」与「怎么排查」**。

TRAE provider 的完整逆向记录：四条协议的坑、通道路由、推理档位、Max 模式、图片能力判定。改动 src/trae*.ts 前必读。

---
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

