# Jet Hub - DeepSeek Harness 凭据管理与多账号统一网关插件

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness%20%7C%20DSH%20Desktop-orange.svg)](#)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.0.0-green.svg)](#)

**Jet Hub** 是专为 **DeepSeek Harness (DSH Desktop)** 深度定制的第三方多模型渠道凭据托管与统一接入网关插件。

它支持将**华为云 CodeArts**、**腾讯 CodeBuddy（国内版/国际版）**、**腾讯 WorkBuddy（国内版/国际版）** 等平台的 AI 模型无缝接入 DSH 环境中，提供现代化的图形管理面板、多账号池智能轮换、后台静默自动续期、以及与 DSH 模型目录的动态联动管理。

---

## 目录

- [核心特性](#-核心特性)
- [支持渠道与模型](#-支持渠道与模型)
- [架构设计与工作原理](#-架构设计与工作原理)
- [安装教程](#-安装教程)
- [详细使用教程](#-详细使用教程)
- [动态模型联动机制说明](#-动态模型联动机制说明)
- [常见问题排查 (FAQ)](#-常见问题排查-faq)
- [本地开发与编译](#-本地开发与编译)
- [开源协议](#-开源协议)

---

## 🌟 核心特性

1. **全渠道平台原生适配**
   - **华为云 CodeArts Agent**：基于 IAM OAuth2 授权与 STS 临时凭据，接入华为 Snap-Access 网关，完整支持 `SDK-HMAC-SHA256` 鉴权与实时推理。
   - **腾讯 CodeBuddy / WorkBuddy**：完整支持国内版（`copilot.tencent.com`）与国际版（`codebuddy.ai` / `workbuddy.ai`）全系生态。
2. **多账号池管理与智能轮换 (Account Pool)**
   - 支持在单一平台下配置多个账号。
   - 自动检测账号健康状态、配额与限流情况，支持跨账号轮换或故障转移，轻松突破单账号频率上限。
3. **静默自动保活与平滑续期 (Auto-Refresh)**
   - 后台调度器以 30 分钟为周期自动巡检所有已启用账号。
   - 在 Access Token 或临时凭证过期前通过 Refresh Token 自动静默置换新凭证，保障日常会话不中断。
4. **动态模型目录联动（按需加载，干净整洁）**
   - **有账号则自动挂载**：在 Jet Hub 中成功配置账号后，DSH“设置 -> 模型”列表会自动挂载对应 Provider。
   - **无账号则自动清理**：当删除某渠道下的所有账号且无遗留凭据时，模型列表中会自动注销并隐藏对应 Provider（例如删除华为云账号后，`CodeArts Agent` 会自动消失），杜绝僵尸配置堆叠。
5. **深度集成 DSH Desktop 流式与思考生态**
   - 严格对齐 DSH LLM 协议标准，完整支持 SSE 流式分块传输。
   - 完美适配大模型深度思考链（`<think>...</think>` 推理内容折叠展示）。
   - 支持超长上下文窗口及多模态图文输入。
6. **现代化可视化控制面板 (Jet Hub UI)**
   - 基于 WebComponent 构建的高颜值界面，集成于 DSH 侧边栏与设置中心。
   - 提供直观的多 Tab 切换、账号测速（Ping/Probe）、一键签到领积分、一键启用/禁用等管理功能。

---

## 🎯 支持渠道与模型

| 渠道标识 | 界面显示名称 | 服务端点 | 认证方式 | 代表模型 | 独家特性 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `codearts` | **CodeArts Agent** | `snap-access.cn-north-4.myhuaweicloud.com` | 华为云 IAM OAuth | GLM-5.2 / GLM-5.3-Flash / DeepSeek-V4 | SDK-HMAC 签名、自动换取 STS 凭证 |
| `buddy` | **CodeBuddy (国内版)** | `copilot.tencent.com` | 腾讯 OAuth / 扫码 / 验证码 | DeepSeek-V4-Pro / GLM-5.3 / MiniMax-M3 | 每日签到领积分、额度实时查询 |
| `buddy-intl` | **CodeBuddy (国际版)** | `codebuddy.ai` | 国际站 OAuth 授权 | GPT-6-Astra / GPT-5.6-Sol / Gemini-3.5-Flash | 海外高规格模型直连 |
| `workbuddy-cn`| **WorkBuddy (国内版)** | `copilot.tencent.com` | 企微 / 企业协同凭据 | DeepSeek-V4-Flash / GLM-5.2 / Kimi-K3 | 企业/团队专属配额支持 |
| `workbuddy` | **WorkBuddy (国际版)** | `workbuddy.ai` | 国际企业工作站授权 | GPT-5.6-Terra / GPT-5.5 / Kimi-K3 | 全球化多模型智能路由 |

---

## 🏗️ 架构设计与工作原理

```
   ┌──────────────────────────────────────────────────────────┐
   │                    DSH Desktop (前端)                    │
   │   [设置 -> Jet Hub 面板]          [设置 -> 模型配置列表]   │
   └───────────────┬──────────────────────────▲───────────────┘
                   │ RPC (jet-hub/*)          │ 动态 Provider 注册/注销
                   ▼                          │
   ┌──────────────────────────────────────────────────────────┐
   │                  Jet Hub 插件核心 (Cordis)                │
   │                                                          │
   │   ┌──────────────────┐          ┌────────────────────┐   │
   │   │  AccountPool     ├─────────►│ syncConfigurable   │   │
   │   │  多账号池持久化   │ 事件广播  │ Providers          │   │
   │   └────────┬─────────┘          └────────────────────┘   │
   │            │                                             │
   │            ▼                                             │
   │   ┌──────────────────┐          ┌────────────────────┐   │
   │   │ Auto Refresh     │          │ LLM Adapters       │   │
   │   │ 周期静默续期     │          │ CodeArts / Buddy   │   │
   │   └──────────────────┘          └─────────┬──────────┘   │
   └───────────────────────────────────────────┼──────────────┘
                                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │                     云端模型网关 API                      │
   │   - 华为云 Snap Access (IAM / STS 签名)                   │
   │   - 腾讯云 Copilot / CodeBuddy / WorkBuddy API           │
   └──────────────────────────────────────────────────────────┘
```

1. **凭据隔离**：账号敏感 Token 保存在 DSH 内部凭据系统（`.credentials.yaml`），配置元数据保存在 `settings.yaml`，保障多账号安全性。
2. **事件总线**：账号的增添、删除、开关状态切换统一通过 `AccountPool.notifyAccountsChanged` 广播。
3. **动态同步**：收到广播后，`syncConfigurableProviders` 计算当前活跃渠道集合，调用 `ctx.llm.registerConfigurableProviders` 原子替换模型目录，实现与界面的毫秒级联动。

---

## 📦 安装教程

### 方式一：通过 Git 仓库直接安装（推荐）

在 DSH Desktop 所属运行环境或通过终端执行命令：

```bash
dsh plugin --profile web add "https://github.com/zhengwuji/Jet-Hub.git"
```

> **提示**：安装过程中，`pnpm` 会自动调用 `prepare` 脚本编译生成产物，无需额外手动打包。

---

### 方式二：本地源码编译与部署

如果你下载了本项目源码或需要进行二次开发：

1. **克隆代码仓库**：
   ```bash
   git clone https://github.com/zhengwuji/Jet-Hub.git
   cd Jet-Hub
   ```

2. **安装依赖并编译**：
   ```bash
   pnpm install
   pnpm build:all
   ```

3. **部署至 DSH 插件目录**：
   将编译后的目录整体放置或软链接到 DSH Desktop 的 profile 扩展目录中：
   - **Windows 生产目录**：
     `%APPDATA%\dsh-desktop\harness\profiles\.generations\live\dsh-codearts-auth+0.1.0+xxxx\node_modules\dsh-codearts-auth`
   - 重启 DSH Desktop 即可生效。

---

## 📖 详细使用教程

### 步骤一：进入 Jet Hub 管理界面
1. 启动 **DSH Desktop**。
2. 点击左侧工具栏底部的 **设置 (Settings)** 图标。
3. 在左侧菜单列表中找到并点击 **Jet Hub**，即可打开凭据与多账号管理中心。

### 步骤二：添加新账号
1. 在 Jet Hub 界面左侧选择需要添加的目标渠道（例如：`CodeArts (华为云)` 或 `CodeBuddy (国内版)`）。
2. 点击右上角的 **+ 新建账号** 按钮。
3. 系统会自动调起默认系统浏览器，打开官方授权登录页面：
   - **华为云**：登录您的华为云账户并点击“确认授权”。
   - **CodeBuddy / WorkBuddy**：支持微信扫码、手机号验证码或企业微信授权。
4. 授权成功后，浏览器会重定向到本地回调端口，Jet Hub 将自动完成 Token 兑换，并展示“账号授权成功”提示。
5. 此时返回 Jet Hub，界面将展示当前账号的昵称、账号 ID、过期时间与有效状态。

### 步骤三：账号管理与功能操作
- **一键测速 (重测所有 / 单账号重测)**：点击卡片上的测速按钮，系统会向对应平台发送探针请求，返回当前网络延迟与连通状态。
- **每日领积分 (CodeBuddy 专属)**：CodeBuddy 渠道卡片提供了“一键领取 / 签到”按钮，可直接获取官方免费赠送额度。
- **启用 / 停用账号**：通过开关按钮可以临时停用某个账号，被停用的账号不会参与模型调用。
- **删除账号**：点击垃圾桶图标即可移除不再使用的账号。

### 步骤四：在模型列表中使用
1. 账号添加成功后，切换到设置菜单中的 **模型 (Models)** 分页。
2. 此时对应的 Provider（例如 `CodeBuddy (国内版)` 或 `CodeArts Agent`）已自动挂载至列表中。
3. 点击提供商卡片右侧的 **编辑**，可以选择当前会话使用的默认模型（如 `deepseek-v4-pro`、`glm-5.3` 等）。
4. 在主聊天窗口直接提问，即可享受全速无缝的模型推理体验。

---

## 🔄 动态模型联动机制说明

为了防止用户在卸载或清理账号后，设置中心残留大量无法使用的空白 Provider，Jet Hub 引入了严格的**动态生命周期同步**规范：

- **展示原则**：只有**至少存在一个已启用有效账号**的渠道，才会在“设置 -> 模型”中注册可见。
- **清理原则**：当某个渠道的账号被**全部删除**（或处于未配置状态）时，插件会自动撤销该渠道的 Provider 声明。
- **无感刷新**：无需重启 DSH Desktop，删除账号的瞬间，模型列表即刻自动刷新脱挂。

---

## ❓ 常见问题排查 (FAQ)

#### Q1：点击“+ 新建账号”后浏览器打开了，但显示连接被拒绝或 404？
- **原因**：本地授权回调服务监听在 `10000` 以上端口（华为云与各大 OAuth 门户的要求）。
- **解决办法**：请检查是否有代理软件（如 Clash、V2Ray 等）拦截了 `127.0.0.1` 本地回环流量，建议在代理软件中将 `127.0.0.1` 和 `localhost` 加入 Bypass 直连白名单。

#### Q2：为什么我在 Jet Hub 中删除了华为云账号，模型列表里还有 CodeArts？
- **原因**：这是因为旧版本插件采用静态无条件注册。
- **解决办法**：请确保已更新至最新版本的 Jet Hub 插件代码，新版已全面支持 `onAccountsChanged` 动态注销逻辑，删除后即自动消失。

#### Q3：账号到期后需要手动重新登录吗？
- **不需要**。只要授权时获取到了 Refresh Token，后台调度器会在到期前自动续期。仅当官方服务端主动注销凭证（例如修改密码、撤销授权）时，才需要重新点击登录。

#### Q4：多账号如何轮换？
- 当配置了多个同一渠道的账号时，系统会自动挑选当前处于健康、未被限流的账号执行请求。若遇到单账号频率超限（TPM/RPM Rate Limit），适配器会自动捕获并尝试调度备用账号。

---

## 💻 本地开发与编译

本项目采用 TypeScript + ESM 构建体系，UI 部分采用原生现代 WebComponent (Lit 架构)。

```bash
# 1. 安装项目依赖
pnpm install

# 2. 静态类型检查
pnpm typecheck

# 3. 运行全量单元测试
pnpm test

# 4. 执行全量构建 (TS 编译 + 前端打包)
pnpm build:all
```

构建完成后产物分布如下：
- `lib/`：后端 TypeScript 编译产物与适配器核心。
- `lib/client/jet-hub.js`：打包完成的前端客户端面板脚本。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 许可协议开源。
