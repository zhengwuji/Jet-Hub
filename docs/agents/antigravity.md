# Antigravity 渠道硬性约束（防封号）

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**：完整保留证据、推导、示例与排查记录。
> 主文件只留「规则 + 索引」；改动相关代码前请先读本分册——**规则本身在主文件里是完整的，
> 本分册补充的是「为什么」与「怎么排查」**。

两条通道的选路规则与八条防封号硬性约束、协议字段位置、实测状态。改动 src/antigravity*.ts 前必读。

---
## Antigravity 渠道的硬性约束（防封号）

`antigravity` 渠道**不属于** `BuddyProduct` 体系，`ALL_PRODUCTS` 中**没有**
它的条目。以下约束是刻意的架构决策，修改时必须保持：

1. **不得把 antigravity 加入 `ALL_PRODUCTS`**。该数组会被 `index.ts` 用于
   创建多账号服务实例并接入 `refreshAll` / 限流自动切换。Google 侧对
   「同一账号被多客户端高频轮换」的判定远比腾讯侧严格。
2. **不得给 `AntigravityAdapter` 传入 `accountPool`**。它固定单账号、串行、
   限速（`MIN_REQUEST_GAP_MS`，两次请求间隔 ≥ 1s）。
3. **`state.vscdb` 必须以 `readOnly: true` 打开**。IDE 运行时该库处于 WAL
   模式，写入会与 IDE 争锁并可能损坏凭据。
4. **不得伪造客户端身份标识**。`buddy-adapter.ts` 会设置
   `User-Agent: CodeBuddyIDE/...` 来伪装成 IDE 客户端 —— 那是腾讯侧的做法，
   **不要复制到 antigravity 适配器**。Google 侧对指纹不匹配极其敏感。
5. **续期默认交给 IDE**。IDE 自行续期并写回 `state.vscdb`，而
   `readAntigravityCredential()` 每次调用都重新读取，天然拿到最新 token。
   `refreshAntigravityToken()` 仅在显式配置 `refresh` 实现时才被调用
   （用于 IDE 长期未运行、库中 token 已失效的场景）。

凭据解析链路（base64 → protobuf → sentinel entry → payload 解包 → token 字段）
的字段位置与实测依据见 `src/antigravity.ts` 文件头注释；改动前务必先读该注释。

### 两条通道（自适应选路：方案 B 优先，方案 A 降级）

插件对 Antigravity 实现了两条互斥通道，由适配器**按账号实际可用性自动选路**
（`AntigravityLocalAdapter.probeChannels()`）：

| 通道 | 实现文件 | 出网方式 | 本机实测 |
|------|----------|----------|----------|
| **B（首选）** | `src/antigravity-local.ts` + `src/antigravity-local-adapter.ts` | 请求打向 `127.0.0.1`，由 **IDE 自己的 language_server** 转发 | ✅ 可用 |
| A（降级） | `src/antigravity.ts` + `src/antigravity-adapter.ts` | 插件自己直连 `cloudcode-pa.googleapis.com` | ❌ 403 `SUBSCRIPTION_REQUIRED` |

**为什么 B 比 A 更安全**：A 是「冒充 IDE」—— 服务端会看到同一 token 的第二个
客户端，TLS 指纹、连接模式、时序都与 IDE 不同；B 是「借用 IDE」—— 请求由 IDE
自己的进程发出，对 Google 而言与「用户在 IDE 里正常提问」完全无法区分（因为它就是）。

#### 自适应选路规则（`probeChannels()`）

| 本地通道 | 公共通道 | 结果 |
|----------|----------|------|
| 可用 | **不探测** | `local` —— 本地能用就不问 Google，少一次出站即少一分指纹暴露 |
| 不可用 | 探测 → 200 | `public`（自动降级） |
| 不可用 | 探测 → 401/403 | `unavailable` + 列出两条路各自的原因与下一步 |
| 不可用 | `allowPublicFallback: false` | `unavailable`（完全不碰公共 API） |

要点（改动时勿破坏）：

1. **本地通道的判据是 `Heartbeat` 通过**，不是「能拉到模型清单」。清单只是
   advisory 的展示数据；把它当判据会让一次瞬时抖动把可用渠道误报为不可用。
2. **公共通道只探认证**（`loadCodeAssist`），**不发推理请求** —— 探测不消耗配额。
3. 探测结果带 **60 秒 TTL**；面板「重测」按钮传 `force: true` 绕过缓存
   （`force` 同时使实例缓存与模型清单缓存失效）。
4. `allowPublicFallback` **默认 `true`**（用 `!== false` 判定）。用户的诉求是
   「有权限就能用」，而不是「必须手动改配置」。设 `false` 则完全不碰公共 API。
5. 公共通道探测到 **401 表示 IDE 里的 OAuth 凭据已过期**（实测本机会出现），
   此时本地通道往往**仍然可用** —— 因为 B 根本不用那份 token。

面板通过 RPC `antigravity.channelProbe` 取探测结论，显示
「✅ 本地私有通道 / ⚠️ 公共 API 降级 / ❌ 当前不可用」及逐条原因。

#### 方案 B 额外的硬性约束

除上方 1~5 条外，`src/antigravity-local*.ts` 还须保持：

6. **不读 `state.vscdb`**。方案 B 全程不碰凭据文件，账号身份由 IDE 运行时决定。
   （这是与方案 A 最大的实现差异，不要为「省一次进程发现」而把凭据读取混进来。）
7. **不发 `Authorization`**，也不发任何自定义业务头。本地 loopback 只需要
   `Content-Type` 与 `x-codeium-csrf-token` 两个头。
8. **CSRF token 不得落日志、不得持久化**。所有错误信息构造处都要经过 `redact()`。
9. **发现流程不得硬编码端口**。端口与 token 都随 IDE 重启变化，必须每次用
   `Heartbeat` 的 CSRF 校验结果动态确认配对。

#### 方案 B 的两个致命字段位置（写错就完全不通）

1. 鉴权头名是 **`x-codeium-csrf-token`**，不是 `x-csrf-token`。写错报
   `missing CSRF token`；头名对但 token 与端口不配对报 `invalid CSRF token`。
2. 模型**必须**放在 `SendUserCascadeMessage.cascadeConfig.plannerConfig.planModel`，
   取值是 `MODEL_PLACEHOLDER_*` **原样字符串**。放到 `StartCascade.requestedModel`
   （那是枚举，传字符串直接 400）或 `requestedModelId` 都会在执行时报
   `failed to construct executor: neither PlanModel nor RequestedModel specified.`

3. 回复**没有服务端流式**，只能轮询 `GetCascadeTrajectory`；模型文本在
   `steps[].plannerResponse.modifiedResponse`（回退 `.response`）。

协议细节、枚举值、错误码、示例响应全部记录在 **`docs/antigravity-local-rpc.md`**，
改动前必读。

### 实测状态：公共 API 需要账号侧授权（2026-09）

**IDE 可用 ≠ 公共 API 可用**，两者是不同授权体系：

- Antigravity IDE 的 agent 走**本地 language_server 私有通道**（命令行为
  `--cloud_code_endpoint ... --subclient_type ide`），该通道正常工作；
- 同一份 OAuth 凭据调用**公共** Cloud Code API 时，实测被拒：
  - `/v1internal:generateContent` → 403 `SUBSCRIPTION_REQUIRED`
  - `aiplatform.googleapis.com` → 400 `RESOURCE_PROJECT_INVALID`
  - `generativelanguage.googleapis.com` → 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
  - 而 `/v1internal:loadCodeAssist` → **200**（凭据认证本身通过）

因此：**不要**把 `generateContent` 的 403 当成"插件写错了"去改鉴权代码；
它是账号未开通对应公共 API。适配器的 `diagnoseRejection()` 已按原因分类
给出中文诊断，待账号获得授权后无需改代码即可使用。

两个已修复的真实缺陷（改动时勿回退）：

- `sleep()` **不能**使用 `.unref()`：限速闸门的定时器被 unref 后，若进程内
  无其他 pending 工作会让 `for await` 静默挂死（既不抛错也不结束）。
- 401/403 分支**不能**用 `response.clone()` 读错误体：clone 后原 body 进入
  被派生状态，后续读取会阻塞。改为一次性 `response.text()`。

