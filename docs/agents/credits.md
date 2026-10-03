# 积分领取（每日签到）与能力判定

> 本文件是 [AGENTS.md](../../AGENTS.md) 的**分册**：完整保留证据、推导、示例与排查记录。
> 主文件只留「规则 + 索引」；改动相关代码前请先读本分册——**规则本身在主文件里是完整的，
> 本分册补充的是「为什么」与「怎么排查」**。

九个协议族的签到/任务领取差异、幂等判据、能力矩阵门控。改动 src/*-credits.ts 或 credits-capabilities.js 前必读。

---
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

**七套协议完全不同**的实现，各自独立：

**Qoder** —— `src/qoder-credits.ts`（2026-09-21 由 keylog 解密抓包解出）：

- 状态查询：`GET /sash/api/v1/me/campaigns`（**只需 Bearer + `Cosy-ClientType`**）
- 领取：`POST /sash/api/v1/me/campaigns/{campaignId}/claim`（**body 空**）
- 幂等：重复领取返回 **HTTP 200 + `replayed:true`**（且不含 `benefit`、
  `claimedAt` 是旧时间）—— 判定**以响应体 `replayed` 为准**，不能只看 HTTP 状态
- 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`
- 活动每日 10:00（UTC+8）刷新，领取后 30 天有效

**CodeBuddy 系（buddy / buddy-intl / workbuddy / workbuddy-cn）** —— `src/credits.ts`：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`，判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖
- ⚠️ **`code:10001` 在两区域语义不同**（2026-10-01 实测）：国内系是
  「今天已签到，请明天再来」，国际版是「签到活动未开启或已过期」。两者都被
  `claimDailyCheckin` 归为 `already-claimed`（非致命，不影响资金），但若给
  国际版开放按钮需按区域区分文案。
- ⚠️ **端点存在性 ≠ 活动存在性**（本次修正的核心教训）：四个区域**都有**这两个
  端点（对照组探针：候选路径 401 vs 随机 404 路径），差异只在**活动位**：
  - `buddy` / `buddy-intl` / `workbuddy-cn` → `active:true`，有活动
  - `workbuddy`（国际版）→ `active:false` / `total_credits:0` / `start_time:""`，无活动
  旧文档称「国际版内核里连 `checkin-status` / `daily-checkin` 字面量都没有 ⇒ 无接口」
  ——**已证伪**：内核字面量是打包器视角，这两个端点由 IDE 前端直接调用。
  该错误结论曾导致 `workbuddy-cn` 被连带误登记为 `dailyCheckin:false`（见下表）。

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

**Loomy** —— `src/loomy-credits.ts`（讯飞；签到只触发每日额度，**没有**「已领」业务码）：

- 一键签到 `POST /api/v1/points/first-login`（body `{}`），登录成功后官方客户端也会立刻调它
- 余额/详情 `fetchLoomyCreditBalance` / `fetchLoomyCreditDetail`（**未签到时「今日额度」字段缺省，不要硬编码 5000**，额度随活动变）
- 适配器侧入口 `LoomyAuth.claimDailyQuota(credential)`（`src/loomy-auth.ts:461`，用户要的「一键签到」）；`LoomyAuth` 的登录流程里也会主动调 `claimLoomyDailyQuota`（`src/loomy-auth.ts:206` 与 `:244`），与官方客户端行为一致

**Raccoon** —— `src/raccoon-credits.ts`（商汤小浣熊；AES-128 加密请求）：

- 签到 `claimRaccoonLoginReward`（**写端点**，探针只断言其存在、不调用）
- 余额 `fetchRaccoonCreditBalance`、新手任务 `fetchRaccoonOnboardingStatus`
- ⚠️ 手机号等字段要过 AES-128 加密，密钥 `RACCOON_PHONE_CIPHER_SECRET`（`src/raccoon.ts:43`，值 `senseraccoon2023`，来自渲染层公开 JS）属**公共逆向协议常量**，脱敏时**不得改动**（改了生产直接瘫痪）

七套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 两套协议共用

**积分余额（Credits Balance）** 是**每族一套端点**（下表只详列四族代表性的，其余见各 provider 分册），但语义一致（「查不到」与「余额为 0」严格区分）：

**CodeBuddy 系（buddy / buddy-intl / workbuddy / workbuddy-cn）** —— `POST /v2/billing/meter/get-user-resource`：

- body `{}`；响应**双层嵌套**：`data.Response.Data.Accounts[]`（签到是单层 `data`，此处最易解析错）
- 总额用各包 `CapacityRemainPrecise` 相加（实测 247.87+100=347.87），**不用**截断过的 `TotalDosage`（347）
- 包名回退链：`PackageName` → `SubProductName` → `PackageCode`
- 该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），静态搜索找不到，靠真实凭据实测发现

**LobsterAI** —— `GET /api/user/profile-summary`：

- 取 `data.totalCreditsRemaining`
- **不要**用 `/api/user/quota`：它只有 `freeCreditsTotal=300`，不含活动积分
  （但**排查**时它是极好的独立对照组，见下条）
- ⚠️ **「余额真的为 0」与「查不到」必须分开**（真实缺陷，2026-10-03）：免费额度用光时
  服务端如实返回 `totalCreditsRemaining: 0` + `creditItems: []`，信封 `code: 0`。
  早期判据写成 `total === 0 && packages.length === 0 ⇒ null`，而 `readNumber` 对
  「字段缺失」与「字段值为 0」都返回 0 —— 两件语义相反的事被压成同一个值，于是
  **余额 0 被报成「余额查询失败」**，卡片永远停在失败态。
  判据必须是**原始字段能否解析为数字**：字段存在（含 0、含字符串 `'0'`）即真实余额，
  只有字段缺失且无任何明细才算「查不到」。排查该账号时可用 `/api/user/quota` 交叉确认
  （实测 `freeCreditsTotal: 300 / freeCreditsUsed: 300 / freeCreditsRemaining: 0`）。

**CodeArts** —— `GET /snap-manager/v1/statistics/plugin`（与账户类型检测**同一响应**）：

- 取 `metrics[]` 中 `usageTotalPackageCredit` 的 `package_credit_remain`；**不累加**基础/按需/赠送分类明细（它们是总额的构成项，相加会重复计算）
- 非积分账户的文案是「Token 计费账户，无积分余额」而非「查询失败」——账户类型差异不是故障。实现走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因

**TRAE** —— 基址取 `product.ugHost`、路径取 `product.entUsagePath`（body **`{"require_usage": true, "req_source": 2}`**）：

| 区域 | 基址 | 路径 |
|---|---|---|
| 国内 `trae` | `api.trae.cn` | `/trae/api/v2/pay/ide_user_ent_usage` |
| 国际 `trae-intl` | **`ug-normal.trae.ai`** | **`/trae/api/v1/pay/ide_user_ent_usage`**（v1） |

- ⚠️ **国际版不是 `api.trae.ai`，路径也不是 v2**（真实缺陷，2026-10-03）：`api.trae.ai`
  只承载 `/cloudide/api/v3/trae/*` 认证类接口，`/trae/api/*` 一律网关 404（同 host 的
  `GetUserInfo` 对同一凭据返回 200 + `AIRegion: SG`，证明凭据有效、就是没有该服务）。
  真实站点与路径来自 TRAE 官网 `account-setting` 的 bundle：`GetIdeUserEntUsage` →
  `genBaseURL("/trae/api/v1/pay/ide_user_ent_usage")`，且该模块导出 `ug-normal.trae.ai`。
  **教训**：国际版与国内版的差异**不只在域名，连路径版本号都不同**，所以两者都必须
  由产品配置承载（`ugHost` + `entUsagePath`），不能有任何一处写死。
- 响应 `user_entitlement_pack_list[]`，每项 `entitlement_base_info.quota.credits_limit` 为额度、`usage.credits_amount` 为已用
- 余额 = `∑(credits_limit - credits_amount)`；`credits_limit <= 0` 的条目跳过（与 Go 端 `EntUsage` 同口径）
- ⚠️ **必须带 `require_usage: true`**：不带时上游不返回 `usage` 明细，`credits_amount` 恒缺省为 0，余额会等于额度总额（虚高）。头同样走 `traeCheckinHeaders`
- ⚠️ **用量计费（`is_dollar_usage_billing: true`）没有 credits 口径**：国际版 Free plan 的
  `credits_limit` 恒为 0，只认 `credits_limit > 0` 会**一个包都产不出 ⇒ 返回 null ⇒
  面板恒显示「余额查询失败」**。此时改列请求额度（与官网 usage 页同款字段，单位「次」）：
  高级模型请求 `advanced_model_request_limit`、快速 `premium_model_fast_request_limit`、
  慢速 `premium_model_slow_request_limit`、自动补全 `auto_completion_limit`。
- ⚠️ **「有效」判定不能恒真**：`active` 原为硬编码 `true`，套餐到期后仍显示
  「N/N 个资源包有效」并把失效额度算进总额（`expiredTotal` 更是从不累加）。
  官网 bundle 的判据是 **`pack.status === d.it.Active`**（`Active` 实测为 `1`；
  **不是** `ent_status` —— 后者在 bundle 里根本不是权益字段，只作为 `progress_status` /
  `present_status` 的子串出现），到期时间取 `expire_time || entitlement_base_info.end_time`
  （秒级）。未知 `status` **保守视为有效**，避免把未知当失效造成可见回退。
  失效包不计入 `total` 而计入 `expiredTotal`，并把到期时间写入 `cycleEndTime` /
  `expiredTime` 供卡片 tooltip 复用。

上述各族共同的约定：

- 累加后 `roundCredits` 规整两位小数（多包浮点噪声会放大成 655.67000031）
- 失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0
- RPC：`credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮


---

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断：

| provider | `balance` | `dailyCheckin` |
|---|---|---|
| `codearts` | ✓ | ✓（华为云签名四步流程） |
| `buddy` | ✓ | ✓ |
| `buddy-intl` | ✓ | ✓ |
| `workbuddy` | ✓ | ✗（端点存在，但**该区域活动位不下发**：`active:false`、`code 10001`「签到活动未开启或已过期」） |
| `workbuddy-cn` | ✓ | ✓（2026-10-01 修正：曾误登记为 ✗。实测 `active:true, streak_days:2, daily_credit:100, total_credits:200`，「Buddy加油站」season 10。同路径同请求头，仅端点区域不同，与 `buddy`/`buddy-intl` 同型） |
| `lobsterai` | ✓ | ✓（`client-activities` 三步流程） |
| `qoder` | ✓（`sash/api/v2/me/usage`，只需 Bearer） | ✓（`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`） |
| `qoder-cn` | ✓ | ✓ |
| `trae` | ✓ | ✓（`checkin_credits` 两步流程） |
| `trae-intl` | ✓ | ✓ |
| `cline` | ✓（`/api/v1/users/{id}/balance`） | ✗（后端无签到接口） |
| `loomy` | ✓ | ✓（`POST /api/v1/points/first-login`，幂等无「已领」业务码） |
| `raccoon` | ✓ | ✗（积分入口是**一次性登录奖励 / 新手任务**，不是每日签到） |

> 表中每行是一个**协议族**的取值（区域变体 `buddy-intl` / `workbuddy-cn` / `qoder-cn` / `trae-intl` 与 `cline` / `loomy` / `raccoon` 都已在上表列出）——**真正的真相源是 `plugin-src/client/credits-capabilities.js`，本表只是导览**；新增 provider 必须在那个文件里逐项登记，`tests/unit/credits-capabilities.spec.ts` 有断言锁死它与面板 `PROVIDERS` 集合相等。

> ⚠️ `qoder` **必须显式登记**，不能省略：上面那条「能力矩阵与 `PROVIDERS` 条目集合相等」的断言要求两者同步，而 qoder 必然要进 `PROVIDERS`（否则面板不渲染）。
>
> ⚠️ **早期把 qoder 误判为两项皆无**（登记成 `balance:false`），根因有二，都值得记住：
> 1. **只按 `/api/` 前缀搜端点**，而余额挂在 **`/sash/`** 下 → 漏检；
> 2. **误以为用量端点也需要 WASM 签名** —— 实测只需 `Bearer` + `Cosy-ClientType`。
>
> **余额与签到彼此独立**：不能因为「没有签到接口」就推断「也查不到余额」。

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，当时 CodeArts 无积分能力，面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障。**门控机制保留至今**，用于挡住真正未登记的 provider
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等

