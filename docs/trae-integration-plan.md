# TRAE Provider 集成方案

> 基于 `E:\Workplace\APP\Golang\trae2api`（Go）与 `E:\Workplace\Agent\trae-api-proxy`（Python）逆向分析。
> 将字节跳动 TRAE IDE 的 SOLO 免费对话通道包装为 DSH provider。

---

## 1. 协议关系：TRAE 与本插件现有 provider 的对比

TRAE 的 SOLO 通道与**现有三个脉系都不同源**，属全新脉系：

| 维度 | TRAE SOLO | CodeBuddy 系 | LobsterAI 系 | CodeArts |
|------|-----------|-------------|-------------|---------|
| 认证 | refreshToken → ExchangeToken（轮换制） | external-link 轮询式 | authCode → exchange（本地回调） | PKCE OAuth + 本地回调 |
| 请求头 | Cloud-IDE-JWT + X-* 系列 | Bearer + X-Product/X-Domain | Bearer + X-LobsterAI-Client-* | SDK-HMAC-SHA256 签名 |
| chat 端点 | POST /api/agent/v3/llm_utils_chat | POST /v2/chat/completions | POST /api/proxy/v1/chat/completions | POST /api/v2/chat/completions |
| 载荷转换 | OpenAI → SOLO (function, config_name) | 透传 OpenAI 格式 | 透传 OpenAI 格式 | 透传 + 签名 |
| SSE 格式 | SOLO 自定事件（非 OpenAI 标准） → 转 OpenAI | 标准 OpenAI SSE | 标准 OpenAI SSE | 标准 OpenAI SSE |
| 模型列表 | POST /api/ide/v1/get_detail_param | GET /v3/config | GET /api/models/available | GET /v2/agent/model-service/... |
| 签到 | POST /trae/api/v2/ug/checkin_credits/claim | POST /v2/billing/meter/daily-checkin | client-activities 三步 | SDK 签名 + ops/claim+confirm |
| 积分余额 | POST /trae/api/v2/pay/ide_user_ent_usage | POST /v2/billing/meter/get-user-resource | GET /api/user/profile-summary | GET /snap-manager/v1/statistics/plugin |

**结论**：TRAE SOLO 是**完全不同源**的新脉系，需按路径 B（新建独立文件集）实现。

---

## 2. 协议详解（来源：Go `trae2api` 源码 + 文档）

### 2.1 API 端点（constants.go）

| 用途 | 方法 | 路径 | Host |
|------|------|------|------|
| 对话 | POST | `/api/agent/v3/llm_utils_chat` | `trae-api-cn.mchost.guru` |
| 模型列表 | POST | `/api/ide/v1/get_detail_param` | `trae-api-cn.mchost.guru` |
| 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `api.trae.com.cn` |
| 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | `api.trae.com.cn` |
| 签到状态 | POST | `/trae/api/v2/ug/checkin_credits/status` | `api.trae.cn` |
| 签到领取 | POST | `/trae/api/v2/ug/checkin_credits/claim` | `api.trae.cn` |
| 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | `api.trae.cn` |

### 2.2 认证流程

```
登录:
  machine_id = randomHex(16)    ← 32 hex 字符
  device_id = randomDigits(16)  ← 16 位纯数字
  loginURL = https://www.trae.cn/authorization?client_id=en1oxy7wnw8j9n&machine_id=...&device_id=...&redirect_uri=http://127.0.0.1:18080/authorize
  → 用户浏览器授权 → TRAE 回调 redirect_uri?code=...&state=...
  → POST ExchangeToken { ClientID, RefreshToken: code, ClientSecret: "-", UserID: "" }
  → 返回 { Result: { Token, TokenExpireAt, RefreshToken, RefreshExpireAt } }
  → POST GetUserInfo (带 Cloud-IDE-JWT header)
  → 返回 { Result: { UserID, ScreenName, EnterpriseID } }
  → 落盘 trae-{uid}.json

续期:
  POST ExchangeToken { ClientID, RefreshToken: <旧refreshToken>, ClientSecret: "-", UserID: "" }
  → 返回新 Token + 新 RefreshToken（轮换）
  → 保留原 machine_id/device_id/uid

凭据文件格式（嵌套形）:
  { auth: { accessToken, refreshToken, expiresAt, domain, apiHost, machineId, deviceId },
    account: { uid, enterpriseId, nickname } }
```

### 2.3 对话流程

```
POST /api/agent/v3/llm_utils_chat
Headers:
  Authorization: Cloud-IDE-JWT <accessToken>
  X-Cloudide-Token: <accessToken>
  X-Ide-Token: <accessToken>
  X-Uid: <uid>
  X-App-Id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
  X-Ide-Version: 0.1.52
  X-Ide-Version-Code: 20260811
  X-App-Version-Code: 20260811
  X-Ide-Version-Type: stable
  X-Device-Type: macos
  X-OS-Version: macOS 15.7.4
  X-Device-Brand: Apple
  X-Machine-Id: <machineId>
  X-Device-Id: <deviceId>
  Request-Traffic-Type: prod
  Accept: text/event-stream (stream=true) | application/json (stream=false)

Body (OpenAI → SOLO 转换 payload.go):
  {
    messages: ...,           // content 字符串转 [{type:"text",text:...}]
    function: "solo_work_lite",
    stream: true,            // 强制 true
    config_name: "<model>", // model 映射到 config_name
    model: "<model>",
    tools: ...,              // OpenAI format → SOLO format
    tool_choice: ...,        // 字符串归一化
  }

SSE 事件流（SOLO 自定义格式）:
  event:metadata     → { model, session_id, ... }
  event:timing_cost  → { name, elapsed }
  event:output       → { response, reasoning_content, tool_calls }
  event:extra_info   → 完整 thinking
  event:token_usage  → { prompt_tokens, completion_tokens, total_tokens, reasoning_tokens }
  event:done         → { finish_reason }
  event:error        → { code, message }

必须转换为 OpenAI SSE 格式:
  data: {"choices":[{"delta":{"content":...}}]}
  data: [DONE]
```

### 2.4 模型列表

```
POST /api/ide/v1/get_detail_param
Body: { function: "solo_work_lite", config_names: null, need_prompt: false,
        current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null }

Response:
  { config_info_list: [
      { config_name: "glm-5.2", display_config: { display_name: "GLM-5.2" },
        model_detail_list: [{ model_name: "glm-5.2" }] },
      ...
    ]}
```

### 2.5 错误码（client.go Classify + solosse.go Kind）

| code | 含义 | 处理 |
|------|------|------|
| 1005 | plan 权益不足 | 长冷却（12h） |
| 4008 | 配额超限（ide_credits 耗尽） | 等重置/签到 |
| 4011 | 请求频率超限 | 短冷却（60s） |
| 401 + body 含 token/login | session 失效 | 需重新登录 |
| 429 | 软限流 | 短冷却（60s） |

### 2.6 签到（checkin_credits）

```
状态: POST /trae/api/v2/ug/checkin_credits/status → body {}
  Headers: Cloud-IDE-JWT + X-User-Region: CN + X-Device-Id
  响应: { checked_in: bool, credits: int64, enable: bool }

领取: POST /trae/api/v2/ug/checkin_credits/claim → body {"req_source":2}
  响应: { code: 0, message: "success" }
  重复领取: { code: 9074, message: "当前使用人数太多" }
```

### 2.7 积分余额

```
POST /trae/api/v2/pay/ide_user_ent_usage → body {}
  响应: { user_entitlement_pack_list: [
    { entitlement_base_info: { quota: { credits_limit: 2000 } },
      usage: { credits_amount: 0.5 } }
  ]}
  remain = ∑(credits_limit - credits_amount)
```

---

## 3. 实现方案

### 3.1 文件清单（新增）

| 文件 | 职责 | 参考源 |
|------|------|--------|
| `src/trae.ts` | 协议常量、凭据结构、纯函数、请求头构造 | `src/lobsterai.ts` / `src/buddy.ts` |
| `src/trae-product.ts` | 产品配置（TraeProduct 接口 + TRAE 常量） | `src/lobsterai-product.ts` |
| `src/trae-auth.ts` | 认证服务（Service 子类） | `src/lobsterai-auth.ts` |
| `src/trae-adapter.ts` | LLM 适配器（LlmAdapter 子类） | `src/lobsterai-adapter.ts` |
| `src/trae-oauth.ts` | 登录流程（ExchangeToken + GetUserInfo） | `src/lobsterai-oauth.ts` |
| `src/trae-errors.ts` | 错误分类 | `src/lobsterai-errors.ts` |
| `src/trae-credits.ts` | 签到 + 积分余额 | `src/lobsterai-credits.ts` |

### 3.2 修改的文件

| 文件 | 改动 |
|------|------|
| `src/index.ts` | 注册 settingsNs、创建 auth 实例、注册 adapter、加入续期调度、传入 RPC |
| `src/jet-hub-rpc.ts` | account.create 分支、account.refresh switch case、credits.* 分支 |
| `plugin-src/client/credits-capabilities.js` | 登记 trae 的积分能力 |

### 3.3 凭据结构

```typescript
interface TraeCredential {
  access_token: string         // 与 AccountPool.findAccountIdByCredential 一致
  refresh_token: string        // ExchangeToken 会轮换此值
  expires_at?: string          // 毫秒时间戳字符串（统一格式）
  uid: string                  // 账号唯一 ID
  nickname: string
  machine_id: string           // 设备指纹（32 hex）
  device_id: string            // 签到用设备号（16位纯数字）
  domain?: string              // "trae.cn"
  api_host?: string            // ExchangeToken 的 host，默认 https://api.trae.com.cn
  enterprise_id?: string
}
```

### 3.4 登录流程（两步式）

与 CodeArts/LobsterAI 相同的两步式模式：
1. `startLogin()` → 生成 machine_id/device_id，构建 loginURL，起本地回调服务器，立即返回 `{ loginUrl, result, close }`
2. 回调触发后，ExchangeToken(code) → GetUserInfo → 落盘

### 3.5 LLM 适配器的关键决策

| 决策项 | 处理方案 | 依据 |
|--------|---------|------|
| stream 是否恒为 true | 是（强制转换为流式） | payload.go 强制设置 |
| prompt_cache_key | 不发 | 未在 TRAE 协议中实测 |
| 图片支持 | 不支持（纯文本） | SOLO 通道未见图片能力 |
| thinking/reasoning | 透传 output 事件的 reasoning_content | solosse.go 正向处理 |
| 载荷转换 | 独立模块转换 OpenAI→SOLO | payload.go 逻辑移植 |
| SSE 解析 | 独立 SOLO→OpenAI 转换器 | solosse.go 逻辑移植 |

---

## 4. 实现步骤

详见下文各文件的实现纲要。
