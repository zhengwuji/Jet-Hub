# e2e 测试说明（重要：部分用例会消耗真实积分）

本目录下的用例会访问**真实线上后端**。请务必按下表理解每个文件的行为，
不要用「一把梭跑整个目录」的方式运行。

## ⚠️ 会消耗模型积分（发真实 chat/completions 请求）

| 文件 | 闸门 | 说明 |
|------|------|------|
| `buddy-models.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 用适配器拉取 CodeBuddy 模型并逐个发一次对话 |
| `buddy-cache-probe.e2e.spec.ts` | `DSH_BUDDY_E2E=1` + `DSH_BUDDY_E2E_CONFIRM=yes` | 直连 `/v2/chat/completions`，发 3 组前缀做缓存对比 |
| `buddy-pool-probe.e2e.spec.ts` | `DSH_BUDDY_POOL_E2E=1` + `DSH_BUDDY_POOL_E2E_CONFIRM=yes` | 用账号池凭据走完整 LLM 链路 |
| `buddy-ratelimit-probe.e2e.spec.ts` | `DSH_BUDDY_RATELIMIT_E2E=1` + `DSH_BUDDY_RATELIMIT_E2E_CONFIRM=yes` | 对记录「限额重置」的账号实发一次请求，**判定是否真限流** |
| `trae-channels-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` | 拉真实多通道目录，并用**真实适配器**对 `glm-5.1`（agent 通道）与 `glm-5-turbo`（work 通道）各发一条最短消息 —— **验证「模型只在列出它的通道里可调用」**。消耗 2 次极小额度 |
| `antigravity-local.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1` + `DSH_ANTIGRAVITY_E2E_CONFIRM=yes` | 走 IDE 本地私有通道发一条真实消息并取回回复。请求由 IDE 自己发出，但**确实计费**，故默认不执行 |
| `cline-chat-probe.e2e.spec.ts` | `DSH_CLINE_CHAT_E2E=1` + `DSH_CLINE_CHAT_E2E_CONFIRM=yes` | **默认只请求 `cline-free/deepseek-v4.1-flash`**（用户指定的日常验证模型）。其余 4 个免费模型需 `DSH_CLINE_CHAT_E2E_ALL_FREE=1` 才遍历。**付费模型一律拒绝请求**（见下「Cline 探针的付费保护」） |

> LobsterAI **没有**发 chat 请求的 e2e —— 它的对话链路可在 Jet Hub 里人工验证
> （选一个模型发一句话即可），单独写探针的边际价值低于维护成本。
> 认证与签到已有只读探针（见下表）。

## 不消耗模型积分

| 文件 | 闸门 | 说明 |
|------|------|------|
| `qoder-chat-probe.e2e.spec.ts` | `DSH_QODER_CHAT_E2E=1` + `DSH_QODER_CHAT_E2E_CONFIRM=yes` | 发一次推理请求验证 SSE，并**验证续期接受本插件生成的 `machine_id`**。默认模型 `qmodel_38max`（**免费额度**）；设 `DSH_QODER_MODEL` 可换付费模型（那时会消耗积分） |
| `v4-models.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash / pro（**每日 1000 万免费 Tokens**） |
| `v4-large-write.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash 大文件写入（同上，免费额度） |
| `login.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | 只走 CodeArts 浏览器登录与凭据换取 |
| `buddy-login-probe.e2e.spec.ts` | `DSH_BUDDY_PROBE=1` | 只打印登录流程原始响应，不发模型请求 |
| `workbuddy-claim-probe.e2e.spec.ts` | `DSH_WORKBUDDY_CLAIM_E2E=1` + `DSH_WORKBUDDY_CLAIM_E2E_CONFIRM=yes` | 真实领取积分（不改模型额度，但会改动账号当日签到状态） |
| `antigravity.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1`（只读）<br>`+ DSH_ANTIGRAVITY_E2E_CONFIRM=yes`（发出站请求） | 读本机 IDE 凭据 → 官方客户端续期 → `loadCodeAssist` 认证。**两级闸门**：默认只跑只读用例（零网络） |
| `antigravity-local.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1`（只读）<br>`+ DSH_ANTIGRAVITY_E2E_CONFIRM=yes`（消耗配额） | 发现 language_server → 拉模型清单 → 建会话。**第一级全部打向 `127.0.0.1`，零出站流量**；只有第二级才真实推理 |
| `lobsterai-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` | **只读**：凭据结构、客户端版本号动态解析、签到槽位/上下文、积分余额。**不签到、不发模型请求** |
| `lobsterai-claim-probe.e2e.spec.ts` | `DSH_LOBSTERAI_E2E=1` + `DSH_LOBSTERAI_CLAIM_E2E_CONFIRM=yes` | 真实签到（会改动当日签到状态；**不消耗模型积分**，且重复运行幂等） |
| `codearts-credits-probe.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | **只读**：凭据结构、**账户类型检测**（`is_credit_package`）、积分余额、活动列表。**绝不领取** |
| `codearts-claim-probe.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` + `DSH_CODEARTS_CLAIM_E2E_CONFIRM=yes` | 真实领取积分（会改动当日领取状态；**不消耗模型积分**，重复运行幂等） |
| `qoder-probe.e2e.spec.ts` | `DSH_QODER_E2E=1` | **只读**：凭据结构（含 `machine_id`）、令牌对 `/api/v1/userinfo` 的有效性、静态兜底模型表。**不发模型请求、不续期** |
| `qoder-credits-probe.e2e.spec.ts` | `DSH_QODER_E2E=1` | **只读**：**逐账号**签到状态（`dailyCredit` / `todayCheckedIn` / 活动 key），并校验**设备身份（`Cosy-MachineToken` + `Cosy-MachineType`）确实生效**。**绝不领取**。⚠️ 覆盖「多账号下第二个账号看不到可领活动」这一缺陷 —— 单测配置刻意禁用了 `runtime-info.exe`（见下「Qoder 设备身份为何只能在 e2e 里验证」），故它唯一的自动化回归就在这里 |
| `trae-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` | **只读**：凭据结构（含 machine_id / device_id）、积分余额、签到状态、远端模型列表。**不签到、不发模型请求** |
| `trae-claim-probe.e2e.spec.ts` | `DSH_TRAE_E2E=1` + `DSH_TRAE_CLAIM_E2E_CONFIRM=yes` | 真实签到（会改动当日签到状态；**不消耗模型积分**，且重复运行幂等） |
| `cline-probe.e2e.spec.ts` | `DSH_CLINE_E2E=1` | **只读**：凭据结构（含 `account_id` 与 `workos:` 前缀）、**前缀不可剥的现场证据**（带前缀 200 / 剥掉 401）、积分余额（打印原始值供核对单位）、远端 `free` 集合与 `/models` 目录。**不发模型请求、不续期** |

> CodeArts deepseek-v4 系列使用华为云免费福利额度（每日 1000 万免费 Tokens），
> 不产生额外费用，因此 `DSH_CODEARTS_E2E=1` 不需要确认变量。
> glm-5.3-flash 等其他 benefit 模型不在本测试集内。如有添加务必标注消耗情况。

## 运行方式

**永远显式指定文件**，不要运行整个目录：

```bash
# 只做认证（安全）
pnpm test:e2e:login

# 登录流程原始响应探针（安全，不发模型请求）
pnpm test:e2e:buddy-probe

# ⚠️ 会消耗 CodeBuddy 积分
pnpm test:e2e:buddy

# ⚠️ 判定「限额重置」徽章是否属实（默认测 deepseek-v4.1-flash）
pnpm test:e2e:buddy-ratelimit

# ⚠️ 会消耗 CodeArts 积分
pnpm test:e2e:codearts

# ⚠️ 会真实领取积分（改动当日签到状态）
pnpm test:e2e:workbuddy-claim

# Antigravity：复用本机 IDE 凭据做认证链路验证
# 前提：本机已安装 Antigravity IDE 且已完成 Google 账号登录
pnpm test:e2e:antigravity          # 只读：读凭据 + 解析校验（零网络）
pnpm test:e2e:antigravity:full     # 追加：token 续期 + Cloud Code 端点调用

# Antigravity：本地私有通道（方案 B，**当前主用通道**）
# 前提：Antigravity IDE 必须正在运行
pnpm test:e2e:antigravity-local      # 只读：发现进程 + 模型清单 + 建会话（全打 127.0.0.1，零出站）
pnpm test:e2e:antigravity-local:full # ⚠️ 追加：真实发一条消息（消耗账号配额）

> **两条 Antigravity 测试的区别**：`antigravity` 系列验证**方案 A**（插件直连
> Google 公共 API，本机实测 403 `SUBSCRIPTION_REQUIRED`）；`antigravity-local`
> 系列验证**方案 B**（借用 IDE 自己的 language_server 发请求，实测可用）。
> 插件运行时默认走 B，A 仅作可选降级。

# 安全：LobsterAI 只读探针（凭据/版本号/签到槽位/余额，不签到）
pnpm test:e2e:lobsterai

# ⚠️ 会真实签到（改动当日签到状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:lobsterai-claim

# 安全：CodeArts 只读探针（凭据/账户类型/积分余额/活动列表，绝不领取）
pnpm test:e2e:codearts-credits

# ⚠️ 会真实领取积分（改动当日领取状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:codearts-claim

# 安全：Qoder 只读探针（凭据结构/令牌有效性/模型表，不发模型请求、不续期）
pnpm test:e2e:qoder

# 安全：Qoder 积分只读探针（逐账号签到状态 + 设备身份是否生效；绝不领取）
pnpm test:e2e:qoder-credits

# ⚠️ 发一次 Qoder 推理请求（默认 qmodel_38max（Qwen3.8-Max）**免费**，不消耗积分）
pnpm test:e2e:qoder-chat

# 安全：TRAE 只读探针（凭据/余额/签到状态/远端模型列表，不签到）
pnpm test:e2e:trae

# ⚠️ 会真实签到（改动当日签到状态；不消耗模型积分，重复运行幂等）
pnpm test:e2e:trae-claim

# ⚠️ 会消耗极小额度：验证多通道目录与「按模型路由通道」
pnpm test:e2e:trae-channels

# 安全：Cline 只读探针（凭据/前缀证据/余额/免费集合，不发模型请求、不续期）
pnpm test:e2e:cline

# ⚠️ 发一次 Cline 推理请求（**默认只发 cline-free/deepseek-v4.1-flash**，免费模型）
pnpm test:e2e:cline-chat
```

## ⚠️ Cline 探针的付费保护（请勿削弱）

Cline 的免费资格是**服务端动态下发的营销状态**（`GET /api/v1/ai/cline/recommended-models`
的 `free` 数组），**随时可能被撤销或改为计费**。因此若探针无条件遍历
「远端此刻说是免费」的那批模型，某天某个模型转为计费后，一次 e2e 就会
**按付费价刷掉真实 token**。

三重闸门（`tests/e2e/cline-chat-probe.e2e.spec.ts`）：

```
DSH_CLINE_CHAT_E2E=1                必需
DSH_CLINE_CHAT_E2E_CONFIRM=yes      必需（防误跑）
DSH_CLINE_CHAT_E2E_ALL_FREE=1       可选：才遍历其余 4 个免费模型
```

默认行为：**只请求 `cline-free/deepseek-v4.1-flash`**（用户指定的日常验证模型）。

另有 `assertFreeModel()` 作为**安全边界**：任何 `isFree === false` 的模型
（无论来自 `DSH_CLINE_MODEL` 环境变量还是远端列表）都会**直接抛错、不发请求**。
`DSH_CLINE_MODEL` 指向付费模型同样会被拒绝 —— 这是刻意设计，不要为了
「临时测一下」而绕过它。

⚠️ 遍历分支里还做了**逐个二次确认**：即使模型在目录里标着免费，
若它已不在**当前**远端 `free` 集合中，也会跳过（避免用过期快照去请求）。

> **CodeArts 凭据必须新鲜**：其 `refresh_token` 是**一次性轮换**的（用一次即
> 作废，服务端回 `STS5.1806 the refresh token has been used`）。两个 CodeArts
> 积分探针都**只读凭据、不刷新**，因此凭据过期时会如实报签名请求失败 ——
> 此时请在 Jet Hub 重新登录，或等续期调度跑过一轮，**不要**为此给探针加刷新逻辑。

> **Qoder 探针要先看续期**：`qoder-chat-probe` 里「续期」用例比「推理」更重要。
> Qoder 官方客户端用**硬件指纹**派生 `machine_id`，而本插件用**随机 UUID**
> （见设计文档 §8）。若续期返回 4xx（非 401），说明服务端校验了设备标识，
> 该假设被推翻 —— 此时必须改用硬件指纹派生，否则用户每天都要重新登录。

## Qoder 设备身份为何只能在 e2e 里验证

Qoder 的 `/sash/` 端点要求一对待定的设备身份头
（`Cosy-MachineToken` + `Cosy-MachineType`，**缺一即失效**），
由桌面端的 `runtime-info.exe` **实时生成**。

⚠️ **单测刻意禁用了这个可执行文件**：`vitest.config.ts` 把 `QODER_RUNTIME_INFO`
指向不存在的路径。理由有三 ——

1. 单次 spawn 实测约 **3.8 秒**，不禁用会让整个单测套件明显变慢；
2. 用例结果会随「开发机是否装了 Qoder 桌面端」而变；
3. 断言会拿到**实时身份**而非用例准备的 fixture，从而假失败。

代价是：**「实时生成身份」这条主路径在单测里根本不执行**。
所以下面两件事**只能**在 e2e 里验证（`vitest.e2e.config.ts` 不设该变量）：

- 实时生成的身份能否让服务端**下发可领活动**（`CLAIM_BENEFIT`）；
- **多账号**场景下每个账号是否都能拿到（历史缺陷②：初版读陈旧的
  `machine_token.json` 缓存，导致第二个账号在一键领取里被报
  「当前没有可领取的活动」，而 IDE 里可领）。

因此 `qoder-credits-probe.e2e.spec.ts` 的**逐账号**断言不可改成只测第一个账号
—— 那正是缺陷②唯一会漏网的地方。

> 单账号时该缺陷**不可能**被覆盖：探针会打印提示而不 fail（单账号是合法状态），
> 别把提示当噪音删掉。

## 限流真实性判定

`buddy-ratelimit-probe.e2e.spec.ts` 回答一个运维问题：Jet Hub 账号卡片显示
「限额重置」时，**该账号此刻到底还受不受限**。

徽章只比较 `modelRateLimits[model] > Date.now()`，是**历史事件的快照**，
不代表此刻的真实可用性。用例把两件事分开测，以定位差异来源：

- **A. 直连** `/v2/chat/completions`（绕过适配器与账号池）→ 服务端的真实答复；
- **B. 适配器链路** → 插件实际会发生什么。

判定：A 返回 200 且有正文即**未真限流**（徽章记录已失效）；A 返回
429/6004 且含「频率限制」即**确实受限**。可设 `DSH_BUDDY_MODEL` 换被测模型。

本地记录的重置时间取自信道错误体里的「将在 … UTC+8 重置」。服务端在重置
时间到达前提前放行是常见的，因此**徽章显示超额使用、实际仍能正常回复**
并不矛盾。

## 设置页的「重测 / 重置」

同一套判定也提供在设置页（Jet Hub）上，无需跑 e2e：

| 按钮 | 行为 | 是否发请求 |
|------|------|-----------|
| **重测**（每个账号） | 对该账号每个限流标记的模型实发一条最小消息，正常返回才清除该标记 | 是（消耗额度） |
| **重测所有**（面板标题） | 对全部账号（**含已停用**）执行上述重测，顺序逐个执行 | 是（消耗额度） |
| **重置**（每个账号） | 直接清除该账号的全部限流标记 | 否 |
| **重置所有**（面板标题） | 直接清除全部账号（含已停用）的限流标记 | 否 |

实现见 `src/account-probe.ts`，RPC 端点为
`account.retest` / `account.retestAll` / `account.reset` / `account.resetAll`。
探测复用真实适配器（BuddyAdapter / CodeArtsAdapter）走完整请求链路，且
**不传 accountPool**——避免「重测 A 账号」顺带污染其他账号的标记。

## 单元测试

`pnpm test`（默认）只跑 `tests/unit/**`，**全部使用桩函数，不发起任何网络请求**，
可以放心频繁运行。

## 为什么默认全部 skip

e2e 用例在未设置闸门时通过 `describe.skip` 整体跳过，报告里显示为
`skipped`，不会产生任何网络调用。这样做是为了防止：

- CI 或其他开发者误跑而消耗配额；
- CodeBuddy 的 14 天免费试用期结束后（2026-09-10 止）在付费账号上产生真实费用。
