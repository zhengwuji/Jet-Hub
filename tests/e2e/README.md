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
| `antigravity-local.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1` + `DSH_ANTIGRAVITY_E2E_CONFIRM=yes` | 走 IDE 本地私有通道发一条真实消息并取回回复。请求由 IDE 自己发出，但**确实计费**，故默认不执行 |

## 不消耗模型积分

| 文件 | 闸门 | 说明 |
|------|------|------|
| `v4-models.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash / pro（**每日 1000 万免费 Tokens**） |
| `v4-large-write.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | deepseek-v4-flash 大文件写入（同上，免费额度） |
| `login.e2e.spec.ts` | `DSH_CODEARTS_E2E=1` | 只走 CodeArts 浏览器登录与凭据换取 |
| `buddy-login-probe.e2e.spec.ts` | `DSH_BUDDY_PROBE=1` | 只打印登录流程原始响应，不发模型请求 |
| `workbuddy-claim-probe.e2e.spec.ts` | `DSH_WORKBUDDY_CLAIM_E2E=1` + `DSH_WORKBUDDY_CLAIM_E2E_CONFIRM=yes` | 真实领取积分（不改模型额度，但会改动账号当日签到状态） |
| `antigravity.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1`（只读）<br>`+ DSH_ANTIGRAVITY_E2E_CONFIRM=yes`（发出站请求） | 读本机 IDE 凭据 → 官方客户端续期 → `loadCodeAssist` 认证。**两级闸门**：默认只跑只读用例（零网络） |
| `antigravity-local.e2e.spec.ts` | `DSH_ANTIGRAVITY_E2E=1`（只读）<br>`+ DSH_ANTIGRAVITY_E2E_CONFIRM=yes`（消耗配额） | 发现 language_server → 拉模型清单 → 建会话。**第一级全部打向 `127.0.0.1`，零出站流量**；只有第二级才真实推理 |

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
```

> **两条 Antigravity 测试的区别**：`antigravity` 系列验证**方案 A**（插件直连
> Google 公共 API，本机实测 403 `SUBSCRIPTION_REQUIRED`）；`antigravity-local`
> 系列验证**方案 B**（借用 IDE 自己的 language_server 发请求，实测可用）。
> 插件运行时默认走 B，A 仅作可选降级。

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
