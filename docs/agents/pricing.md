# 计费倍率、单次输出上限与 X-Domain

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**：完整保留证据、推导、示例与排查记录。
> 主文件只留「规则 + 索引」；改动相关代码前请先读本分册——**规则本身在主文件里是完整的，
> 本分册补充的是「为什么」与「怎么排查」**。

各 provider 的计费倍率解析差异、maxOutputTokens 下发规则、同名模型消歧、X-Domain 归属头。改动展示名或请求头前必读。

---
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


---

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


---

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期 workbuddy 指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。

