# Qoder 积分与共享协议层

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**。
> 主文件只留「规则 + 索引」；本分册保留完整的端点实测、幂等判据推导与排查记录。

覆盖 `src/qoder-credits.ts`、`src/qoder*.ts` 与 `src/openai-compat.ts`。

---
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

---

### ⚠️ Qoder 每日领取：端点由 **keylog 解密抓包** 解出（2026-09-21）

```
GET  {openApiBase}/sash/api/v1/me/campaigns
POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
```

请求头同上（Bearer + `Cosy-ClientType`，**无需签名**）。

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
「列表非空」判）：服务端在「今天已领」时清空 `campaigns`，若据此判
`active:false`，`collectClaimResults` 会先命中「活动未开启」分支，
把「今天已领」误报成「签到活动未开启」。

⚠️ **RPC 分支须传 `precheckStatus: false`** —— `claimQoderDailyCheckin`
自带活动列表查询，否则会重复发一次 GET（与 LobsterAI 传 false 同理）。

---

### ⚠️ `openai-compat.ts` 只服务 qoder，不要顺手重构既有适配器

`src/openai-compat.ts` 把「消息序列化 + SSE 消费」抽成共享实现给 **qoder 适配器**用。`buddy-adapter.ts` / `lobsterai-adapter.ts` **刻意不改用它** —— 那两份实现已被大量单测与线上流量验证，重构它们属于与本任务无关的高风险改动。若将来要统一，应作为独立任务并配以逐条对拍测试。

它承载的教训（改它时必须保留）：`delta.content` / `delta.reasoning_content` 会显式返回 **`null`**（必须 `typeof === 'string'` 判定）；孤儿工具调用须剔除（否则后端 400 且坏历史被反复重放）；`function.name` 只允许非空覆盖；残缺参数**不补 `{}`**（补了会让 harness 报 schema 错误而非重试）。

`trae` 同样**完全独立**（第五个脉系，独立一套 `src/trae*.ts`），且差异点与其他四者都不一样：认证用 **ExchangeToken 轮换 refreshToken**（不是轮询、也不是 authCode 交换）；鉴权头是 `Cloud-IDE-JWT <token>` 加十余个 `X-*` 身份头；**请求体需要从 OpenAI 格式转换为 SOLO 格式**（`function` / `config_name` / `tools.parameters` 序列化等）；**响应是 SOLO 自定义 SSE 事件**（`output` / `token_usage` / `done` / `error`），必须自行解析并转成 OpenAI chunk；凭据还必须持久化 `machine_id` 与 `device_id`（均为 **32 位 hex**，分别用作设备指纹与签到设备号，后者账号间必须互异）。**登录回调默认直接回传 token**（`auth_callback_url` 参数，老流程没有 `code`；但也并存 PKCE 新流程，两套都要认），详见下「TRAE 协议要点」。实现见 `docs/trae-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI、CodeArts、Qoder 与 TRAE 五个面板提供** —— 只有国际版 WorkBuddy 不提供（其后端没有签到接口）。五者是**五套互不相同的协议**（见下「积分领取」）。

插件另提供 `antigravity`（Google Antigravity IDE）路由，走**路径 A：本机凭据复用**——只读复用 IDE 自身的 OAuth 登录态，不独立登录、不进账号池。硬性约束见下文「Antigravity 渠道的硬性约束」。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` 编译宿主侧 + `esbuild` 打包客户端）
- **语言**：TypeScript
- **许可**：MIT
