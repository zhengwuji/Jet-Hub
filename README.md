# dsh-codearts-auth

deepseek-harness 插件：执行 CodeArts（华为云）登录流程，默认走新式 IAM OAuth
（portal `/authorize` 授权 → 本地 `/oauth/callback` 回调 → STS token 端点换取含
`refresh_token` 的凭据），到期前静默续期，无需再次打开浏览器；旧 ticket 流程保留
为显式回退（`flow: 'ticket'`）。插件还注册一个 `codearts` LLM provider 路由，使该
凭证可直接用于 CodeArts 后端模型调用。

此外插件内置另外两个 provider 路由：

- **buddy（腾讯 CodeBuddy）** — 见 [buddy provider](#buddy-provider)；
  另支持「一键领取积分」（每日签到）。
- **workbuddy（腾讯 WorkBuddy 国际版）** — 见 [WorkBuddy provider](#workbuddy-provider)。
- **lobsterai（有道 LobsterAI / 龙虾）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。

`codearts` 面板同样支持**积分账户检测、积分余额与「一键领取积分」**
（华为云「每日签到得积分」活动，走 `SDK-HMAC-SHA256` 签名）——
见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)。

四个 provider 的 Jet Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
是否出现在对话框的模型选择里（黑名单制，默认全部显示）——
见 [模型列表开关](#模型列表开关黑名单)。

## 安装

该包尚未发布到 npm registry。提供两种安装方式：**git 仓库安装**（推荐，自动拉取
并构建）和**源码目录安装**（本地开发联调）。

### 方式一：从 git 仓库安装（推荐）

先在 profile 的 `pnpm-workspace.yaml` 中放行该包的 build 脚本
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git: true
```

再用 `dsh plugin add` 从 gitee 拉取并安装：

```sh
dsh plugin --profile <name> add "https://gitee.com/iJetLi/deepseek-harness-codearts.git"
```

`add` 以 `git+https` 方式安装，pnpm 会运行 `prepare` 脚本自动构建 `lib/`，无需
手动 `pnpm build`。每次升级时重新 `add` 即可拉取最新版本并重建。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再用 `dsh plugin install` 将本地检出安装为 pnpm `link:`
依赖（指向本目录）：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`，否则 dsh 启动时
> 报 `ERR_MODULE_NOT_FOUND: ... dsh-codearts-auth/lib/index.js`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

- `/codearts-login` — 在浏览器中打开华为云 portal 授权页；授权后，插件经本地
  `/oauth/callback` 回调收取 `code`，并由 STS token 端点换取含 `refresh_token` 的
  AK/SK/SecurityToken 凭据。
- `/codearts-status` — 显示 `configured`、`source`、`expiresAt`、
  `refreshable` 以及最新的 `refreshError`。
- `/codearts-refresh` — 手动静默续期凭据（refresh_token 换取；无 refresh_token 时提示重新登录）。
- 编程式调用：`ctx.codeartsAuth.login()`、`ctx.codeartsAuth.status()`、
  `ctx.codeartsAuth.refresh()`、`ctx.codeartsAuth.logout()`。

## LLM provider

插件在 `ctx.llm` 上注册了一个 `codearts` provider 路由（OpenAI 兼容端点
`https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`）。每个模型请求都使用
存储的 AK/SK/SecurityToken 按华为 `SDK-HMAC-SHA256` 方案签名，并附带
`Chat-Id`/`Session-Id` 请求头。默认广告的模型为 GLM-5.2、GLM-5.1、
GLM-5、GLM-5.3 Flash（`glm-5.3-flash`，1M 上下文）、盘古
openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
以及 DeepSeek V4 deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费
Tokens 福利）。
登录后在 dsh Models 页面选择该 provider 即可。

> 注 1：CodeArts Agent IDE 模型列表显示的 flash ID 为 `deepseek-v4-flash-0731`
> （带日期后缀），但后端实际注册的可用 ID 是 `deepseek-v4-flash`（无后缀）。
> 用 `deepseek-v4-flash-0731` 调用会返回 `InferHub.002002009.404 The model is
> not registered`，因此本插件只注册无后缀的 `deepseek-v4-flash`。
>
> 注 2：`glm-5.3-flash`（GLM-5.3 Flash，2026-08 加入，1M 上下文）是 benefit
> （免费额度）模型：其 chat 请求必须携带 `maas_type: benefit` 请求头且该头
> 参与 `SDK-HMAC-SHA256` 签名，否则后端返回 `InferHub.002002009.404 The model
> is not registered`。适配器已自动处理，无需手动配置。
> （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）

凭据来自默认的新式 IAM OAuth 流程（含 `refresh_token`）。请求发起时会解析最新
凭据，若已过期则先静默续期，再用新 AK/SK/SecurityToken 签名，无需重新打开浏览器。

除 `codearts` 外，插件另注册两个独立的腾讯系路由：`buddy`（见
[buddy provider](#buddy-provider)）与 `workbuddy`（见
[WorkBuddy provider](#workbuddy-provider)）。三者互不覆盖，可同时使用。

## 凭证

- Ref：`CODEARTS_ACCESS_TOKEN`（POSIX 标识符格式的凭证 ref）。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。
- `status()` 报告 `configured`、`source`、`expiresAt`、`refreshable` 和
  `refreshError`。

## 续期（refresh）

- 默认登录流程为**新式 IAM OAuth**（PKCE + DPoP）：portal `/authorize` 授权 → 本地
  `/oauth/callback` 回调收取 `code` → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
  换取含 `refresh_token` 的凭据。
- 凭据在过期前 1 小时静默续期（`getFirstRefreshTime` 语义：距过期 ≤1h 立即刷，
  否则 `now+1h` 叠加随机秒偏移），全程无浏览器、无人工操作。
- 刷新失败后 10 分钟重试（异常网络 1 分钟）；`refresh_token` 失效后停止续期并提示
  重新登录（原因会体现在 `status().refreshError` 中）。
- 旧 ticket 流程保留为显式回退：`/codearts-login` 默认走 OAuth；编程式调用
  `ctx.codeartsAuth.login({ flow: 'ticket' })`。ticket 凭据没有 `refresh_token`，
  其续期仍意味着重新运行浏览器登录流程。
- 手动续期：`/codearts-refresh` 或 `ctx.codeartsAuth.refresh()`。
- 续期定时器是 unref 的，在 `logout()` 和插件卸载时停止。
- 运行时依赖新增 `jose`（用于 DPoP JWS 签发，与 CodeArts Agent 插件实现一致）。

## 开发

- `pnpm test` — 单元测试（快速，无网络）。
- `pnpm test:e2e` — 针对华为线上端点的真实登录流程；需要在打开的浏览器中由人工
  点击授权按钮（续期为静默刷新，无需再次点击）。
- `pnpm typecheck`、`pnpm build:all`。

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`（生成 `.js`、`.d.ts` 和 source
  map）。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（Jet Hub 设置页的客户端 bundle，由 `exports["./client"]`
  引用）。它**不在** `tsc` 的编译范围内，必须单独构建。
- `pnpm build:all` — 依次执行上面两步（`build` + `build:client`），是完整的构建。
- `pnpm typecheck` — 只做类型检查（`tsc --noEmit`），不产出文件，可在构建前快速
  验证。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。只执行 `pnpm build`
会漏掉客户端 bundle，dsh 启动时会因 `exports["./client"]` 指向的文件不存在而
加载失败（Jet Hub 设置页不显示），请改用 `pnpm build:all`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 安装到 profile 之前先构建

详见「安装」小节。`dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:`
依赖运行 `prepare` 脚本，因此必须先 `pnpm build:all` 生成 `lib/`（含客户端
bundle）。

## 工作原理

默认登录流程（新式 IAM OAuth，PKCE + DPoP）：

1. 生成 PKCE 配对与 DPoP ES256 密钥对，并启动本地 `127.0.0.1` 回调服务器。
2. 构造 portal `/authorize` URL 并打开华为云授权页面。
3. 授权后浏览器回调本地 `/oauth/callback`，携带授权码 `code`。
4. 向 STS token 端点（`sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）用
   `code` 换取含 `refresh_token` 的凭据 JSON，并存储到 `CODEARTS_ACCESS_TOKEN` 下。
5. 凭据到期前静默续期（见「续期（refresh）」），无需再次打开浏览器。

旧 ticket 流程保留为显式回退（编程式调用 `ctx.codeartsAuth.login({ flow: 'ticket' })`）：
生成 `ticket_id`，打开 `devcloud.cn-north-4.huaweicloud.com/doer/redirect` 认证页，
回调后轮询 snap-manager ticket 端点（120 × 1 秒）获取临时凭证；此类凭据没有
`refresh_token`，其续期仍意味着重新运行浏览器登录流程。

## buddy provider

独立路由 `buddy`（腾讯 CodeBuddy，OpenAI 兼容端点
`https://copilot.tencent.com/v2/chat/completions`），Bearer `access_token` 鉴权。

登录采用 external-link-v2 轮询式（与 CodeArts 的本地回调服务器不同，CodeBuddy
不起本地端口，而是轮询后端 API）：

1. `POST /v2/plugin/auth/state?platform=ide` → 取得 `state` 与 `authUrl`。
2. 打开浏览器到 `https://www.codebuddy.cn/login/?platform=ide&state=...`。
3. 轮询 `GET /v2/plugin/auth/token?state=...`（1 秒间隔、5 分钟超时）→ 令牌；
   错误码 `11217` 表示 token 未就绪，继续轮询。
4. 轮询 `GET /v2/plugin/login/account?state=...` → 账户信息；错误码 `12151`
   表示账户信息未就绪，继续轮询。
5. 续期：`POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 头提交
   refresh_token。

- **登录入口：Jet Hub 设置页的 CodeBuddy 面板**（支持多账号与账号池自动切换）。
  已不再注册斜杠命令 —— 设置面板已覆盖登录、状态查看与续期，命令式入口冗余。
- 编程式调用：`ctx.buddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 模型列表：以内置的产品目录为准（`src/product.ts` 的 `fallbackModels`），
  远端 `GET /v3/config` 可用时优先采用其元数据。
- 请求头：除 `Authorization: Bearer` 外，还需 `X-Domain`、`X-Product`、
  `X-Product-Code` 以及伪装为 `CodeBuddyIDE/1.106.1` 的 `User-Agent`。
- 凭据 ref：`BUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
  `expires_at` 的 JSON 字符串。

> **流式工具调用 id 稳定性**：CodeBuddy 仅首个工具调用分片携带真实 id
> （`chatcmpl-tool-xxx`），后续参数分片只有 `index`。适配器按 index 缓存并沿用
> 真实 id（缺失时回退 `call_{index}`），保证同一工具的所有分片 id 一致——否则
> 跨轮次（每轮都从 `call_0` 重新编号）会把 `tool/result` 配对到错误的历史条目。

## WorkBuddy provider（国际版）

独立路由 `workbuddy`（腾讯 **WorkBuddy 国际版 / WorkBuddy AI**），与
[buddy provider](#buddy-provider) **同源**：共用同一 CLI 内核与同一认证协议
（cli-external-link 轮询式），Bearer `access_token` 鉴权。差异收敛在
`src/product.ts` 的产品配置里：

| 项 | CodeBuddy（中国） | WorkBuddy（国际版） |
|---|---|---|
| `endpoint` | `https://copilot.tencent.com` | **`https://www.workbuddy.ai`** |
| `platform` | `ide` | **`workbuddy-ai`** |
| 登录 URL 附加参数 | 无 | **`version` / `loginSessionId`** |
| `pluginVersion` | — | `5.5.2` |

**模型列表不能与中国版共用**：两者的路径与响应解析完全相同
（`GET /v3/config` → `data.data.models` / `data.data.agents`），差异只来自
`endpoint` —— 不同区域的后端返回不同模型池（中国版含 glm / hy / deepseek 系，
国际版含 claude / gpt / gemini / kimi 系）。因此 `endpoint` 必须随产品切换，
不能被当成全局常量。

登录流程与 CodeBuddy 一致（`auth/state` → 浏览器授权 → 轮询 `auth/token` →
轮询 `login/account`），仅身份标识与端点按上表区分。`X-Product-Code` 为
`workbuddy`，`X-Domain` 随 `apiDomain` 切换为 `www.workbuddy.ai`。

**没有每日签到积分**：国际版后端不提供**签到**接口（内核中只有
`/v2/billing/meter/get-dosage-notify` 用量通知），因此 Jet Hub 的 WorkBuddy
面板**不显示「一键领取积分」按钮**；签到领取在 CodeBuddy 面板完成。

> **但积分余额（Credits Balance）可以查。** 签到与余额是两项独立能力：国际版
> 确实没有签到，但**有**积分余额查询接口，见下节。不要因为"没有签到"就推断
> 也查不到余额。

- **登录入口：Jet Hub 设置页的 WorkBuddy 面板**（支持多账号与账号池自动切换）。
  同样不注册斜杠命令。
- 编程式调用：`ctx.workbuddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 凭据 ref：
  - 单账号：`WORKBUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
    `expires_at` 的 JSON 字符串（与 `BUDDY_ACCESS_TOKEN` 同构）。
  - 多账号：`WORKBUDDY_ACCOUNT_<UUID_SHORT>`，由 Jet Hub 设置页「+ 新建账号」
    登录时自动生成并登记到账号池；每条账号记录带 `provider: 'workbuddy'`，
    与 CodeBuddy 的 `BUDDY_ACCOUNT_*` 相互隔离，不会串用凭据或限流标记。
- **从中国版升级**：本插件早期版本把 `workbuddy` 指向中国版
  （`copilot.tencent.com`）。启动时会自动清理凭据 `domain` 与当前
  `apiDomain` 不符的旧账号（这类凭据在新端点必然失败），清理结果记入日志，
  请在 Jet Hub 重新登录。
- 续期：与 CodeBuddy 共用同一套机制，插件启动后每 30 分钟对可续期账号静默刷新
  （`refresh_token` 经 `X-Refresh-Token` 头提交），无需重新打开浏览器。
- 请求头、模型列表拉取与流式工具调用 id 处理均与 CodeBuddy 一致，详见上一节。

### 与 Jet Hub 设置页的关系

Jet Hub（设置页）的账号面板按 provider 分组展示，WorkBuddy 是其中一栏：

- 面板提供账号列表、新建账号（浏览器登录入池）、启用/停用、删除、**拖拽排序**，
  以及「重测 / 重测所有 / 重置 / 重置所有」限流标记操作，行为与 CodeBuddy
  面板一致，但只操作 `provider: 'workbuddy'` 的账号。
- 账号卡片展示 credentialRef、有效期（含「自动续期」标记）、限流状态与**积分
  余额**（见下节）。「一键领取积分」按钮**仅 CodeBuddy 面板提供**，结果来自
  RPC 端点 `credits.claimAll`（实现见 `src/jet-hub-rpc.ts`，签到客户端见
  `src/credits.ts`）。
- 后端另实现了 `credits.status`（查询某 provider 下全部启用账号的签到状态），
  但**前端尚无消费者**：`plugin-src/client/jet-hub.js` 只调用 `credits.claimAll`，
  `credits.status` 目前仅供外部脚本或直接 RPC 调用使用。
- 对应 LLM provider 的设置命名空间为 `llm-workbuddy`。

### 「+ 新建账号」必须走两步式登录（四个 provider 一致）

`account.create` 对**全部四个 provider** 都遵守同一契约：**在用户完成授权之前
就返回 `loginUrl`**，由前端立即 `window.open`，后台再异步等回调。

这不是风格偏好，而是浏览器安全模型的硬约束：`window.open` 只在用户点击后的
**transient activation** 窗口（约 5 秒）内被允许。若 `account.create` 阻塞到
用户授权完成才返回（数十秒），拿到 URL 时手势早已过期，弹窗必被拦截并返回
`null`，前端若兜底执行 `window.location.href = loginUrl`，就会把**整个设置页**
导航到外部登录页 —— 用户报障「codearts 新建账号应该弹出新的页面，现在主页面
直接跳转过去了」正是此因。

| provider | 后端实现 | 前端交互 |
|---|---|---|
| `buddy` / `workbuddy` | `runBuddyLoginFlow` 不 await，立即返回 URL | 弹小窗 + 轮询 `login.poll` |
| `codearts` | `CodeArtsAuth.startLogin()` | 同上 |
| `lobsterai` | `LobsteraiAuth.startLogin()` | 同上 |

- 两步式的入口在 `src/login.ts` 的 `startOAuthFlow` 与 `src/lobsterai-oauth.ts`
  的 `startLobsteraiLoginFlow`；原阻塞式 `runOAuthFlow` /
  `runLobsteraiLoginFlow` 保留（CLI、e2e 仍用），现由前者实现。
- 两步式路径**没有外层 `try/finally` 兜底**，故超时与「结果落定即关闭回调
  服务器」都收在 `start*` 内部，避免泄漏监听端口。
- 前端**不再**保留 `window.location.href` 兜底：弹窗被拦截时改为展示一个可点击
  的登录链接（`loginUrlForManual`），轮询照常进行，用户手动打开也能完成登录。
- 回归测试见 `tests/unit/jet-hub-rpc.spec.ts` 的
  「account.create 必须立即返回 loginUrl」：用「授权永不完成」的替身模拟用户
  尚未操作 —— 旧实现会超时失败，新实现立即返回。

### 账号拖拽排序（顺序 = 选号优先级）

Jet Hub 各 provider 面板的账号卡片可**拖动调整顺序**，卡片左上角显示序号。

**这不是纯 UI 装饰**：账号列表的数组顺序就是 `getAvailableAccount` 的候选
优先级 —— 自动选号、以及限流后换号重试，都按这个顺序取「第一个可用账号」。
把常用账号拖到前面，它就会优先被使用。

语义是「**手动顺序优先，限流豁免**」：

- 顺序完全由用户决定（不按任何服务端字段重排）；
- 但当前正处于**限流期**的账号会被跳过，不会选到 —— 即使它排在第一位。

> ⚠️ 早期实现有一个 `candidates.sort((a,b) => resetAtA - resetAtB)`（按限流
> 重置时间最早到期优先）。它会让拖拽形同虚设：用户把某账号拖到首位，只要
> 另一个账号的重置时间更早，实际选中的仍是后者。该排序已移除，
> `tests/unit/account-pool.spec.ts` 有回归用例锁死。

交互细节：

- 拖动整张卡片，或抓住左侧的 `⠿` 手柄；
- 插入位置按指针落在目标卡片的**上半 / 下半**决定（前插 / 后插），
  并以卡片上方或下方的蓝线指示。只支持「前插」时把卡片往下拖一格会变成
  空操作，因此必须区分方向；
- 顺序**乐观更新**（本地先变、再提交），失败则回滚并提示；
- 提交期间禁用拖拽，避免并发提交互相覆盖；
- 只有 1 个账号时不启用拖拽（排序无意义）。

实现：RPC `account.reorder` → `AccountPool.reorderAccounts()`
（只动本 provider 占用的下标，其他 provider 账号位置不变）；
前端拖拽逻辑在 `plugin-src/client/account-order.js`（纯函数，可单测）。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**两个产品通用**——CodeBuddy 中国版与 WorkBuddy 国际版都实现同一接口
（只是 baseURL 随 `product.endpoint` 切换）：

```
POST /v2/billing/meter/get-user-resource    body {}
```

### 模型列表开关（黑名单）

Jet Hub 面板标题栏的「**显示列表**」按钮展开该 provider 的**全部模型**，每个模型
后面带一个开关，**默认打开**。关闭后该模型不再出现在对话框的模型选择列表里。

采用**黑名单制**：只有被显式关闭的模型会被隐藏，未记录的模型（含服务端后续新增的
模型）一律默认显示。这与白名单制的关键差别在于——新模型上线时无需任何配置就会
自动出现在选择器里，不会被静默挡在门外。

- 开关状态持久化在 `jet-hub` settings 命名空间的 `disabledModels` 字段
  （形如 `{ buddy: { 'glm-5.2': true } }`），与账号池同处一个 namespace。
- 模型列表来自 `ctx.llm.listModels()`，**即对话框模型选择器读取的同一份目录**
  （会话控制器的 `buildModelCatalog`），因此设置页展示的模型与实际可选集合始终
  一致，不会出现「设置里有、选择器里没有」的错位。
- 过滤发生在适配器的 `listModels`（`src/llm-adapter.ts` / `src/buddy-adapter.ts` /
  `src/lobsterai-adapter.ts`），
  每次调用都直接读账号池的黑名单，因此**改开关后下一轮模型目录刷新即生效**，
  无需重启或重建适配器。
- **只影响目录播报，不改变路由能力**：被关闭的模型仍可被 `resolveModel` 解析、
  仍能正常收发请求。这是 DSH 对 `listModels` 的约定（目录是建议性的，缺省不构成
  请求拒绝）。好处是已有会话若正用着某个被关闭的模型，不会被强制中断。
- 开关按 provider 隔离，CodeArts / CodeBuddy / WorkBuddy / LobsterAI 四份黑名单互不影响。
- 相关 RPC 端点：`model.list`（列出模型并回填 `disabled`）、`model.setDisabled`
  （打开/关闭单个模型），实现见 `src/jet-hub-rpc.ts`。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**支持范围**：四个 provider 都支持，但**三套协议各不相同**：

**CodeBuddy 中国版与 WorkBuddy 国际版**（同一接口，只是 baseURL 随
`product.endpoint` 切换）：

```
POST /v2/billing/meter/get-user-resource    body {}
```

**LobsterAI**：`GET /api/user/profile-summary` → `data.totalCreditsRemaining`。

**CodeArts**（华为云，见 `src/codearts-credits.ts`）：

```
GET {snapEngineUrl}/snap-manager/v1/statistics/plugin
```

余额取自响应的 `metrics[]` 中 `usageTotalPackageCredit` 的
`package_credit_remain`（**不累加**基础/按需/赠送分类明细——它们是总额的
构成项，相加会重复计算）。非积分计费账户不显示「查询失败」，而是如实提示
「Token 计费账户，无积分余额」——那是账户类型差异，不是故障。

> 能力矩阵在 `plugin-src/client/credits-capabilities.js`，由客户端在
> **请求前**判定，而非等后端返回错误再吞掉。
>
> 历史缺陷：早期客户端在面板挂载时对所有 provider 无条件调用
> `credits.balances`，而当时 CodeArts 没有积分能力，于是每次打开 CodeArts
> 面板都会在控制台报 `unsupported provider: codearts`，并把每个账号卡片的
> 「积分」渲染成「查询失败」。修法是不发起该请求——后端 `productById()` 的
> 拒绝是正确的契约行为，不该被当作运行时故障展示。

### 一键领取积分（每日签到）

**四个 provider 中三个提供**该按钮（三套签到协议完全不同，实现各自独立）。
WorkBuddy 国际版后端没有签到接口，故其面板不显示。

在 Jet Hub 对应面板标题栏点击「**一键领取积分**」，插件会对该面板下
**全部账号**顺序执行每日签到领取：

> **含已停用账号。** 停用只影响账号池的自动选择与限流切换，不改变账号本身
> 是否已签到——用户点「一键领取」时期望所有账号都尝试一遍。

**CodeBuddy（两步）**：

1. 先查签到活动状态（`POST /v2/billing/meter/checkin-activity-status`）；
2. 活动未开启或今日已签到则跳过领取请求，只报告状态；
3. 否则调用领取端点（`POST /v2/billing/meter/daily-checkin`）领取当日积分。

**LobsterAI（三步，见 `src/lobsterai-credits.ts`）**：

1. 查活动槽位（`GET /api/client-activities/slot`，带固定的
   `placement` / `containerApiVersion` / `platform` 参数）；
2. 查活动上下文（`GET /api/client-activities/{code}/context`），
   读 `claimedToday` 与 `actions` 决定是否可领；
3. 领取（`POST /api/client-activities/{code}/actions/check_in`，
   请求带客户端幂等键 `idempotencyKey`）。

> LobsterAI 的 `clientVersion` 是签到**必填**参数，由插件动态拉取
> （`api-overmind.youdao.com` 的更新接口，缓存 12 小时）；
> 拉取失败时回退内置兜底版本并在日志告警 —— 比参考实现的
> 「取不到就完全放弃签到」更宽容。

**CodeArts（四步，见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)）**：
账户类型检测 → 活动列表预检 → `POST /v1/ops/claim` →（必要时）
`POST /v1/ops/confirm`。

完成后按钮下方给出结果摘要（如「3 个账号领取成功（+300 积分），1 个今日已领取」）。
领取按账号隔离：单个账号凭据缺失、损坏或请求失败不会中断整批，只计入失败数；
摘要**只显示各类计数**（如「1 个失败」），不展示每个账号的失败原因——原因保留在
`results[].outcome.message` 中，需要时请通过 RPC 响应或日志查看。

几点实现约定：

- 领取是**顺序执行**的，避免并发触发风控；账号较多时需要等待片刻。
- **CodeBuddy** 重复领取是幂等的：服务端返回 HTTP 400 + `code 10001`（「今天已签到，
  请明天再来」），插件把它识别为 `already-claimed` 而非失败。
- **LobsterAI** 的幂等由**客户端**保证：请求带 `idempotencyKey`，且领取前先读
  `context` 的 `claimedToday` 与 `actions`；重复领取会被识别为 `already-claimed`。
- **CodeArts** 的幂等由**活动列表预检**保证：没有幂等键、也没有「今天已签到」
  业务码可依赖，唯一的保护是 `claimable` / `status` 预检（见下节）。
- CodeBuddy 的状态查询用 `checkin-activity-status` 而非 `checkin-status`；后者返回
  占位数据（`active:false`、`checkin_dates:null`），会让人误判为活动未开启。
- CodeBuddy 的请求**不需要** `X-Device-Token`（图灵盾）——已实测验证。
- LobsterAI 的签到**不需要签名**，只用 `Authorization: Bearer`；也**不发**腾讯系的
  `X-Domain` / `X-Product` / `X-Product-Code` 头。

想单独验证领取闭环（会真实改动账号当日签到状态）可运行
`pnpm test:e2e:workbuddy-claim`、`pnpm test:e2e:lobsterai-claim` 或
`pnpm test:e2e:codearts-claim`，说明见 `tests/e2e/README.md`。

### CodeArts 积分（华为云「每日签到得积分」）

实现见 `src/codearts-credits.ts`。活动规则见
[华为云官方文档](https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.html)：
完成每日签到得 **1000 积分**，积分自发放起 30 天内有效；**活动参与者限定
「已经升级到积分计费模式的用户」**——这正是必须先做账户类型检测的原因。

#### 认证走签名，不走 Cookie（关键结论）

官方文档给出的是**网页版**路径（`https://codearts.huaweicloud.com/portal/...`），
那是 portal BFF 接口，**依赖浏览器会话 Cookie**：实测不带 Cookie 时，无论是否
携带 AK/SK 签名，都返回 IAM 登录跳转 HTML（HTTP 200 + `text/html`）。
本插件没有可用的浏览器会话，因此**不能**复用那条路径。

可用的是**码道 IDE 直连**的 `snap-access` 端点，它接受
**`SDK-HMAC-SHA256` 签名**——与本仓库 `src/sign.ts` 逐字一致，
凭据就是现有的 `CodeArtsCredential`，**无需任何新的登录流程**。
协议逆向自本机安装的码道 IDE（`out/main.js` 的 `PackageInfoService`、
`out/vs/workbench/workbench.desktop.main.js` 的 `ActivityWelfarePane`）：

| 用途 | 端点（base = `snapEngineUrl`） |
|---|---|
| **账户类型检测** | `GET /snap-manager/v1/statistics/plugin` |
| 活动列表 | `GET /v1/ops/delivery?channel=IDE` |
| 领取 | `POST /v1/ops/claim` `{ campaignId, channel: 'IDE' }` |
| 领取确认 | `POST /v1/ops/confirm` `{ campaignId }` |

`snapEngineUrl` = `https://snap-access.cn-north-4.myhuaweicloud.com`
（与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` **同域**）。

所有请求需带 `Agent-Type: PromptCenter` 与 `X-Language: zh-cn`，但
**这两个头必须在签名之后追加，绝不能参与签名计算**：

> ⚠️ **实测（2026-09-18）**：把它们作为 `signRequestHuawei` 的 `extraHeaders`
> 传入（即进入 canonical request 与 SignedHeaders），服务端会回
> `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；
> 改为**签名后追加**则同一端点返回 200 与真实数据。
>
> 这与 `src/models.ts` 的 `fetchSignedGet` 一致 —— 其参数注释明确写着
> 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。
> 本模块早期版本误当作签名头，界面因此显示「积分：账户信息查询失败」。
> 回归测试见 `tests/unit/codearts-credits.spec.ts` 的
> 「Agent-Type / X-Language 不得出现在 SignedHeaders 中」。
>
> 注意 `src/llm-adapter.ts` 的 `maas_type: benefit` 是**反例** —— 那个头确实
> 需要参与签名（见其注释），不要据此推断其他头也该签名。

非 2xx 响应会把服务端的 `error_code` / `error_msg` 带进提示文案
（`describeHttpFailure`）。这一点很关键：只报 `HTTP 401` 会让「签名头位置错」
「AK 调用超限（`AK access failed to reach the limit`）」「凭据过期」这些
**处置方式完全不同**的问题看起来一模一样。

#### 账户类型检测

```
GET /snap-manager/v1/statistics/plugin
  → package.is_credit_package === true   ⇒ 积分账户（可领取）
  → package.is_token_package   === true  ⇒ 旧的 Token 计费账户（活动范围外）
```

领取流程**第一步**就判它：非积分账户返回 `inactive`（正常业务状态），
而不是 `failed`——后者会让用户去排查并不存在的故障。

#### 领取流程与幂等

1. 查账户类型 —— 查询失败 → `failed`；非积分账户 → `inactive`；
2. 查活动列表，取 `type === 'USER_LOGIN'` 的那项（**不是** `INVITE_USER` /
   `NEW_USER_REGISTER` / `STUDENT_CERTIFIED`，那些不是每日签到）；
3. 不可领取且 `status` ∈ {`CLAIMED`,`CONFIRMED`,`CONSUMED`} → `already-claimed`；
   其余不可领取 → `inactive`；
4. `POST /v1/ops/claim`；响应 `id !== null` 时补 `POST /v1/ops/confirm`
   （漏掉会让积分停在「待确认」而不入账）；
5. 成功 → `claimed`。

第 3 步是**唯一的幂等保护**：本协议没有幂等键，也没有服务端「今天已签到」
业务码可依赖，故预检不能省。

#### ⚠️ 活动列表的字段类型/名字与直觉不符

实测（2026-09-18）`GET /v1/ops/delivery` 的一个 item：

```json
{ "campaignId": 1, "type": "USER_LOGIN", "title": "每日签到领1000 积分",
  "benefitAmount": 1000, "benefitUnit": "CREDIT", "claimable": true,
  "status": "ELIGIBLE", "pendingCount": 1, "pendingTotalAmount": 1000 }
```

三个与直觉不符之处，任一处理错都会导致**领取失败或金额为 0**：

| 字段 | 真实形态 | 踩坑后果 |
|---|---|---|
| `campaignId` | **数字** `1`，不是字符串 | 用只收字符串的解析会得空串 → 判 `failed`「缺少 campaignId」 |
| 可领积分 | 字段名是 **`benefitAmount`** | 读 `amount`（不存在）→ 恒为 0 |
| `status` | 不可领取时是 **`null`** | 解析必须容忍 null |

> **真实缺陷**：上述前两条叠加，导致点「一键领取积分」后显示
> 「1 个活动未开启，1 个失败」——**积分实际没有领到**。
> 第一个账号（Token 计费）判 `inactive` 是正确的；第二个（积分账户）
> 因 `campaignId` 解析为空而失败。
>
> 早期单测没抓到，是因为用例喂的是**编造的** `campaignId: 'c-1'` 与
> `amount: 1000`。现在的用例直接使用上面这份实测字段集合。

#### 领取结果会逐账号显示原因

面板的领取摘要除计数外，还会列出每个账号的**具体原因**
（如「xxx：失败 — 活动缺少 campaignId，无法领取」）。这不是装饰：
上述缺陷最初只能靠翻代码 + 抓包定位，就是因为 UI 只显示「1 个失败」。
后端一直返回 `results[].outcome.message`，前端不该丢掉它。

#### ⚠️ refresh_token 是一次性轮换的

华为的 `refresh_token` **用一次即作废**（服务端回
`STS5.1806 the refresh token has been used`）。因此：

- 任何刷新都必须**立刻回写**新凭据，否则该账号只能重新登录；
- `tests/e2e/codearts-credential.ts` 只读凭据、**绝不刷新**——探针消耗掉
  refresh_token 会让用户的账号失效。这个坑在开发本功能时已真实踩过一次。

## LobsterAI provider（有道龙虾）

独立路由 `lobsterai`（有道 **LobsterAI**），OpenAI 兼容端点
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，
Bearer `access_token` 鉴权。

该 provider 与腾讯系**协议完全不同**，因此实现是独立一套
（`src/lobsterai*.ts`），只共用架构模式（产品配置驱动、账号池、限流切换、
模型黑名单）。关键差异：

| 项 | 腾讯系（CodeBuddy / WorkBuddy） | LobsterAI |
|---|---|---|
| 登录方式 | 轮询后端 API（无本地服务器） | **本地回调服务器**收 `authCode` 后换 token |
| 登录/API 域名 | 同一个 `endpoint` | **两个域名**（portal 与 apiBase） |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` | 仅 `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` |
| 续期请求体 | 只带 `refreshToken`（走 `X-Refresh-Token` 头） | 还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid` |
| `clientVersion` | 编译期常量 | **运行时从第三方接口动态拉取** |
| 每日签到 | 两步（状态 + 领取） | **三步**（slot + context + check_in） |
| 图片输入 | 支持 | **不支持**（`inputModalities` 仅 `text`） |
| 思考等级 | 支持（按模型声明档位） | **不声明**（是否支持未实测） |

> 上表是 **LobsterAI 与腾讯系**的对照。第三个协议族 **CodeArts（华为云）** 的
> 差异见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)：它用
> `SDK-HMAC-SHA256` **签名**（无 Bearer）、领取为**四步**
> （账户类型 + 活动列表 + claim + confirm），且 `refresh_token` **一次性轮换**。

- **登录入口：Jet Hub 设置页的 LobsterAI 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.lobsteraiAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()` / `resolveClientVersion()`。
- 凭据 ref：
  - 单账号：`LOBSTERAI_ACCESS_TOKEN`；
  - 多账号：`LOBSTERAI_ACCOUNT_<UUID_SHORT>`，由 Jet Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` 外，
  还持久化 `uuid` / `first_keyfrom` / `latest_keyfrom` 三个**身份字段** ——
  它们是续期请求体的必填项，丢失会导致静默续期失败、只能重新登录。
- 模型列表：远端 `GET /api/models/available` 优先（它是权威来源），
  失败时回退 `src/lobsterai-product.ts` 的 19 个内置模型。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  **终态判定比参考实现更精确**：只有 HTTP 401/403 或业务码 40100/40101
  才判为 `refresh_token` 失效；网络抖动走可重试路径，不会误让用户重新登录。

> **已知待实测项**（见 `docs/lobsterai-integration-plan.md` §7.2）：
> 是否支持 `reasoning_effort`、各模型真实上下文窗口（内置表统一填 131072，
> 是桥接层的估计值）、图片输入、`prompt_cache_key`。这些在实现里都取了
> **保守默认**（不声明 / 不发送），不会因未知而失败。
