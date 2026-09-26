# Jet Hub - DeepSeek Harness 凭据管理与多账号统一网关插件

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-DeepSeek%20Harness%20%7C%20DSH%20Desktop-orange.svg)](#)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.0.0-green.svg)](#)

**Jet Hub** 是专为 **DeepSeek Harness (DSH Desktop)** 深度定制的第三方多模型渠道凭据托管与统一接入网关插件。

它支持将 **华为云 CodeArts**、**腾讯 CodeBuddy（国内版/国际版）**、**腾讯 WorkBuddy（国内版/国际版）**、**Google Antigravity（本地私有直连）**、**有道 LobsterAI（龙虾）**、**阿里系 Qoder** 以及 **字节跳动 TRAE** 等平台的 AI 模型无缝接入 DSH 环境中，提供现代化的图形管理面板、多账号池智能轮换、每日签到积分自动领取、后台静默自动续期、以及与 DSH 模型目录的动态联动管理。

此外插件内置以下 provider 路由：

- **buddy（腾讯 CodeBuddy 国内版）** / **buddy-intl（国际版）** — 见
  [buddy provider](#buddy-provider)；国内版支持「一键领取积分」（每日签到）。
- **workbuddy-cn（腾讯 WorkBuddy 国内版）** / **workbuddy（国际版）** — 见
  [WorkBuddy provider](#workbuddy-provider)。国内版后端同样没有签到接口。
- **lobsterai（有道 LobsterAI / 龙虾）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。
- **qoder（阿里系 Qoder 国际版）** / **qoder-cn（国内版）** — 见
  [Qoder provider](#qoder-provider)；
  **支持积分余额与每日领取**（每日 100 Credits，10:00（UTC+8）刷新）；
  走**加密推理端点**，模型池与客户端一致（含 Qwen3.8 系列）。
- **trae（字节跳动 TRAE 国内版）** / **trae-intl（国际版）** — 见
  [TRAE provider](#trae-provider字节跳动-trae)。
- **cline（Cline 桌面端 / API）** — 见 [Cline provider](#cline-provider)；
  WorkOS 设备码登录，支持免费模型识别。
- **loomy（讯飞 Loomy 办公助手）** — 见 [Loomy provider](#loomy-provider讯飞办公助手)；
  支持微信扫码登录、积分余额、每日额度签到与新手任务 10000 积分。
- **raccoon（商汤小浣熊 Raccoon Work）** — 见 [Raccoon provider](#raccoon-provider)；
  支持扫码/短信登录、6 个商汤日日新模型、积分与一次性登录奖励。
- **antigravity（Google Antigravity IDE）** — 见
  [Antigravity 渠道](#antigravity-渠道google-antigravity-ide)；
  走**本机凭据复用 / 本地私有通道**，不独立登录、不进账号池。

> **国内版与国际版各占一个 provider**（共 14 个）。两侧端点与登录态
> **互不相通**，因此凭据也各自独立保存，绝不串用 —— 在对应面板登录哪一侧的账号，
> 就只走那一侧的端点。

`codearts` 面板同样支持**积分账户检测、积分余额与「一键领取积分」**
（华为云「每日签到得积分」活动，走 `SDK-HMAC-SHA256` 签名）——
见 [CodeArts 积分](#codearts-积分华为云每日签到得积分)。

八个 provider 的 Jet Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
是否出现在对话框的模型选择里（黑名单制，默认全部显示）——
见 [模型列表开关](#模型列表开关黑名单)。

---

## 目录

- [✨ 更新日志](#-更新日志)
- [🌟 核心特性](#-核心特性)
- [🤖 支持渠道与模型](#-支持渠道与模型)
- [🏗️ 架构设计与工作原理](#️-架构设计与工作原理)
- [📦 安装教程](#-安装教程)
- [📖 详细使用教程](#-详细使用教程)
- [🔄 动态模型联动机制说明](#-动态模型联动机制说明)
- [❓ 常见问题排查 (FAQ)](#-常见问题排查-faq)
- [💻 本地开发与测试](#-本地开发与测试)
- [📄 开源协议](#-开源协议)

---

## ✨ 更新日志

### v0.4.0 (最新发布)

本次为全功能重大版本升级：全量合并 Gitee 上游 41 个最新提交，接入 3 个全新 Provider（**Cline、讯飞星火 Loomy、商汤小浣熊 Raccoon**），支持矩阵扩展至 **14 个 Provider**，并新增多款最新大语言模型与全局一键签到，同时彻底解决了 DSH Desktop 宿主兼容性与启动故障。

- 🚀 **全新接入 3 个重量级 Provider（支持矩阵扩展至 14 个）**：
  - 🦝 **商汤小浣熊 Raccoon (`raccoon`)**：
    - 支持微信二维码扫码登录与手机短信验证码登录双模式；
    - 接入 6 款商汤日日新系列主力模型（`SenseChat 5.0` 系列）；
    - 支持积分余额实时查询、每日签到积分以及 3000 积分新用户登录奖励领取；
    - 采用 AES-128 加密通信协议与自动保活会话。
  - ⚡ **讯飞星火 Loomy (`loomy`)**：
    - 支持微信扫码登录与手机号短信登录；
    - 接入 8 款讯飞星火模型池（含 Spark Lite / Pro / Max 等）；
    - **智能余额选号算法**：按各账号余额实施智能负载均衡，优先消耗每日赠送的临时额度，并提供「锁定永久积分」开关，防止宝贵的永久积分被非预期扣除；
    - 支持新手任务 10000 积分领取与每日额度签到。
  - 🤖 **Cline 桌面端 (`cline`)**：
    - 基于 WorkOS 设备码标准 OAuth 流程授权，支持无缝轮询登录；
    - 完整支持官方模型池与免费模型智能辨识；
    - 原生内置 5 档思考强度控制（Off、Low、Medium、High、Max）。
- 🧠 **前沿模型更新与能力增强**：
  - **CodeBuddy / WorkBuddy**：接入腾讯混元最新 `deepseek-v4.1-flash` 等系列模型；
  - **Qoder / Qoder-CN**：全面适配阿里千问 `Qwen3.8` 系列模型；设备指纹协议升级为实时生成桌面身份，彻底解决多账号签到误报「今日已领取」或「无活动」的问题；
  - **TRAE / TRAE-Intl**：修复思考档位被空档位通道覆盖的问题，采信上游 `default_level`；全量打通 Max 模式 1M 上下文与多模态图片输入能力；
  - **Google Antigravity**：支持纯本地语言服务器回环通道（`127.0.0.1`）直连与双通道自适应选路，零指纹泄漏，极致防封。
- 🎁 **全局一键签到与自动化**：
  - Jet Hub 页面顶部新增「**一键签到**」按钮，单次点击自动轮询并签到所有支持积分的渠道（CodeBuddy、LobsterAI、CodeArts、Qoder、TRAE、Loomy、Raccoon）；
  - 完善账号池每日签到状态检测与幂等防重。
- 🛡️ **死循环守卫与标签解析纠错**：
  - 新增 **Prose Loop Guard**（正文死循环守卫），自动检测并截断模型长文本复读异常；
  - 新增针对 `</think:hex>` 异常转义标签的自动剥离与内容归位。
- 🐛 **DSH Desktop 启动兼容性硬核修复**：
  - 针对 DSH Desktop 宿主环境内嵌 `@deepseek-ai/schemastery` 缺少 `.volatile()` 方法导致的 `TypeError: Schema.dict(...).default(...).volatile is not a function` 顶层崩溃，增加安全探测与优雅降级回退；
  - 解决因插件导入崩溃引发 DSH 进入恢复模式并报错 `HTTP 404` 的问题，确保在全版本 DSH Desktop 下即装即用、开箱即活。
- 🎨 **UI 与用户体验优化**：
  - 修复深色模式下模型列表开关不可见、搜索框样式错位与弹窗跳动；
  - 优化账号启用/停用与模型列表的动态联动；
  - 账号池支持自由拖拽排序，拖拽顺序即为智能选号优先级。
- 🧪 **工程质量与单测矩阵**：
  - 全量 115 个测试套件，**2664 个单元测试 100% 全部通过**。

### v0.3.0

本次为大版本合并：接入 Gitee 侧 43 个提交（三个新服务商 + 一批真实缺陷修复），
并新增国内外区域支持。

- 🌐 **新增国内外双版本支持（按官方是否分区域决定，不臆造）**：
  - **Qoder 国内版 `qoder-cn`**：与已有的 `qoder`（国际版）并列。
    官方是**同一代码库的两个构建**（客户端 `runtime-info.json` 里 version 与
    git commit 相同，仅 `build.site` 分 `global` / `cn`），差异全在域名：
    `qoder.cn` / `openapi.qoder.com.cn` / `gateway.qoder.com.cn`。
    ⚠️ 国内版的**公开推理与加密推理是同一个 host**（国际版才是两个不同 host）。
  - **TRAE 国际版 `trae-intl`**：与已有的 `trae`（国内版）并列。
    `www.trae.ai` / `api.trae.ai` / `api5-normal-alisg.mchost.guru`。
  - **LobsterAI 只有国内版**（有道单一端点），**按需不新增国际版**。
  - 两侧登录态互不相通，故凭据 ref 各自独立（`QODER_CN_ACCESS_TOKEN` /
    `TRAE_INTL_ACCESS_TOKEN`），不会串用。
- 🆕 **接入三个全新服务商（来自 Gitee 合并）**：
  - **`lobsterai`（有道 LobsterAI / 龙虾）**：本地回调 + authCode 换 token，
    `client-activities` 三步签到；四个 provider 中最独立的一套协议。
  - **`qoder`（阿里系 Qoder）**：PKCE 设备码轮询登录、**加密推理端点**
    （请求体与签名头由客户端内嵌 WASM 生成，本插件直接调用其导出函数）、
    静态模型表（含 Qwen3.8 系列）、积分余额与每日领取。
  - **`trae`（字节跳动 TRAE）**：ExchangeToken 轮换续期、`Cloud-IDE-JWT` 鉴权、
    请求体需从 OpenAI 转 SOLO 格式、响应是 SOLO 自定义 SSE（需反向转换）。
- 🐛 **修复两个 provider 面板成「空壳」导致账号变砖（真实缺陷）**：
  合并时把服务端产品配置从 4 个收敛成 2 个，但客户端面板列表没同步收敛，
  于是 `buddy-intl` 与 `workbuddy-cn` 出现「面板在、后端无实例」：
  - 账号池里对应 provider 的账号成**孤儿**（能看见但无法续期、无法删除）；
  - 两者的 settings namespace 未注册 → 模型设置页在
    `refFor → deriveKeyRef(provider)` 处抛 `provider.toUpperCase is not a function`；
  - 账号卡片「刷新」按钮落到 `default` 分支抛 `Unknown provider`。
  现已补齐产品配置、Auth 实例、适配器、namespace 与刷新分派，
  并新增**不变量测试**锁死「客户端列出的每个 provider 都必须有服务端实例」。
- 🐛 **补回 SSE 内联错误的上下文超限识别**：CodeBuddy 有时把 400 错误塞进
  **HTTP 200 的正常 SSE 帧**，该路径走不到 HTTP 状态码映射，导致溢出信号丢失、
  压缩子系统不触发、**长会话越过窗口后卡死**。现按源码风格识别并归为
  `CONTEXT_WINDOW_EXCEEDED`。
- 🐛 **修复后的其他缺陷（来自 Gitee 合并）**：
  - 停用账号不续期导致凭据失效（`refreshAll` 误按 `enabled` 过滤）；
  - 换号在 server/client 类错误下实际从未发生（账号池未排除已试账号）；
  - `tool-result` / 用户图片被静默丢弃，模型看不到 `read_image` 的图；
  - 国际版 WorkBuddy 英文 6004 限流无法触发账号切换；
  - LobsterAI 模型列表恒为空导致静默回退兜底表、远端新模型不可见。
- ✨ **新增功能（来自 Gitee 合并）**：
  - **账号池支持拖拽排序**，顺序即选号优先级（`account.reorder`）；
  - 模型选择列表**显示计费倍率**并区分同名模型（`x0.79→x0.50` 形态）；
  - 设置页「**显示列表**」开关，被关闭的模型仍显示正确展示名（含倍率）；
  - 没有已登录账号的 provider **不显示其模型**（减少模型选择列表臃肿）；
  - CodeArts 支持**积分账户检测与每日签到领取**；
  - TRAE 支持**图片输入**（逐模型判定，见 Issue #IKHDKC）。
- 🎨 **免费模型实时标注**：三个 provider 统一展示形态 ——
  `buddy` 为 `x0.00→免费`（含时段窗口推算）、`qoder` / `trae` 为 `· 免费`。
  倍率与免费标记均**实时按当前时刻推算**，不照搬采集快照。
- 🧪 **测试体系**：1561 / 1563 通过。余 2 项为 oauth 用例的本地端口竞态
  （隔离运行全部通过，且在合并前的基线上同样偶发，与本次改动无关）。

### v0.2.1

- 🐛 **修复 CodeBuddy (国际版) 无账号时在 DSH 模型列表中残留泄露的缺陷**：
  - **前置凭据鉴权防护**：在 `BuddyAdapter.listModels` 与 `resolveModel` 前置增加 `resolveCredential` 校验，未配置或未启用账号时直接返回空模型列表，彻底杜绝无账号状态下静态兜底模型（如 deepseek-v4.1-flash 等）错误暴露给前端的问题。
  - **账号池动态变更感知 (`onAccountsChanged`)**：监听账号池变更事件，在用户添加、删除或停用账号时，自动原子清空已缓存的远端模型列表及上下文限制，保证 DSH 模型目录能够实时联动刷新，不留任何死锁或僵尸配置。
- 🛡️ **管理端 RPC 健壮性与超时保护**：
  - 前端控制面板向后端发起 RPC 调用（`account.list`、`account.probe`、`account.credits` 等）时引入 10 秒超时防护（`AbortSignal.timeout(10000)`），彻底解决后端服务未就绪时界面无限转圈卡死的问题。
  - 优化错误提示展示，明确区分连接超时与服务未启动状态，给出直观的重启/重试排查指引。
- 🎨 **Jet Hub 面板交互与样式优化**：
  - 完善支持静默自动续期（`REFRESHABLE_PROVIDERS`）的提供方名单（包含 codearts、buddy、buddy-intl、workbuddy-cn、workbuddy 等）；
  - 顶部操作栏（重测所有/重置受限/新建账号）启用弹性自适应布局（`flex-wrap`），适配多分辨率与不同面板宽度；
  - 引入 `info` 紫色色调提示气泡，状态展示层次更分明。
- 🚀 **自动化部署脚本增强 (`deploy-antigravity.ps1`)**：
  - 部署到 DSH Desktop 运行时（`F:\Users\Administrator\AppData\Local\Programs\DSH Desktop`）时，自动检测并安全清理旧的遗留产物；
  - 保持逐文件 SHA256 无损比对与 Node 语法自检。
- 🧪 **单元测试体系健全**：
  - 补充 `tests/unit/buddy-adapter.spec.ts` 中无可用账号时的防护回归用例，70 个单测全部 100% 通过。

### v0.2.0

- 🚀 **全新支持 Google Antigravity 本地私有直连通道**：
  - **零凭据配置、极速直连**：无需配置 API Key、OAuth Token 或翻找本地凭据文件，启动 Antigravity IDE 即可自动无缝直连本地 `language_server` 进程。
  - **14+ 前沿顶级模型原貌体验**：完整支持 `Gemini 3.8 Flash (High)`、`Gemini 3.7 Flash`、`Gemini 3.1 Pro (High)`、`GPT-OSS 120B (Medium)`、`Claude 3.7 Sonnet (Thinking)`、`Claude 3.5 Sonnet` 等全部官方模型。
  - **自适应选路与智能探针**：提供本地 IDE 运行状态实时探活（端口扫描、PID 提取、模型数量统计）与自诊断能力。
  - **多轮会话精准映射与竞态防护 (Cascade Session Persistence & Race Protection)**：
    - DSH Desktop 会话与 Antigravity IDE Cascade 会话 1:1 锚定复用，杜绝每次提问反复新建对话框。
    - 引入**多轮基线锚定机制 (`baselineTrajectory`)**：彻底解决语言服务器异步写入与轮询时序竞态，确保多轮问答每轮精准流式返回对应新答复，杜绝“答非所问 / 重复上一轮旧回复”问题。
- 🎁 **腾讯 CodeBuddy / WorkBuddy 每日积分签到与一键领取**：
  - 新增状态查询与一键领积分功能，支持多账号顺序安全领取，幂等防风控。
  - Jet Hub 管理面板提供直观的「一键领取积分」按钮与分类计数摘要。
- ⚡ **Jet Hub 现代化 WebComponent 控制台升级**：
  - 新增 Antigravity 状态卡片、一键诊断与重测。
  - 多账号启停、一键测速、限流自动标记与故障转移。
  - 动态 Provider 注册与清理（删除账号后模型列表中自动移除对应 Provider，不留僵尸配置）。

---

## 🌟 核心特性

1. **全渠道平台原生适配**
   - **华为云 CodeArts Agent**：基于 IAM OAuth2 授权与 STS 临时凭据，接入华为 Snap-Access 网关，完整支持 `SDK-HMAC-SHA256` 鉴权与实时推理。
   - **腾讯 CodeBuddy / WorkBuddy**：完整支持国内版（`copilot.tencent.com`）与国际版（`codebuddy.ai` / `workbuddy.ai`）全系生态。
   - **Google Antigravity**：本地 IDE 私有 RPC 隧道直连，零凭据依赖，随 IDE 启动即用。
2. **多账号池管理与智能轮换 (Account Pool)**
   - 支持在单一平台下配置多个账号。
   - 自动检测账号健康状态、配额与限流情况，支持跨账号轮换或故障转移，轻松突破单账号频率上限。
3. **静默自动保活与平滑续期 (Auto-Refresh)**
   - 后台调度器以 30 分钟为周期自动巡检所有已启用账号。
   - 在 Access Token 或临时凭证过期前通过 Refresh Token 自动静默置换新凭证，保障日常会话不中断。
4. **动态模型目录联动（按需加载，干净整洁）**
   - **有账号则自动挂载**：在 Jet Hub 中成功配置账号后，DSH“设置 -> 模型”列表会自动挂载对应 Provider。
   - **无账号则自动清理**：当删除某渠道下的所有账号且无遗留凭据时，模型列表中会自动注销并隐藏对应 Provider（例如删除华为云账号后，`CodeArts Agent` 会自动消失），杜绝僵尸配置堆叠。
5. **深度集成 DSH Desktop 原生 UI**
   - 在 DSH 设置菜单中直接嵌入 Jet Hub 凭据管理看板，提供多账号列表、状态探针、一键测速、每日领积分等丰富操作。

---

## 🤖 支持渠道与模型

| 渠道 Provider | 支持环境 / 版本 | 认证与连接方式 | 代表性支持模型 |
| :--- | :--- | :--- | :--- |
| **Antigravity (Google)** | Antigravity IDE (Windows/macOS) | 本地私有 RPC 直连（零配置，自动发现） | `Gemini 3.8 Flash (High)`、`Gemini 3.7 Flash`、`Gemini 3.1 Pro (High)`、`GPT-OSS 120B (Medium)`、`Claude 3.7 Sonnet (Thinking)`、`Claude 3.5 Sonnet` 等 14+ 模型 |
| **CodeArts Agent** | 华为云 CodeArts | 华为云 IAM 统一认证 + STS 临时凭据 | `deepseek-v4-pro`、`deepseek-v4-lite`、`deepseek-v3`、`deepseek-r1`、`qwen-2.5-coder`、`codearts-snap` 等 |
| **CodeBuddy (国内版)** | 腾讯云 CodeBuddy | 微信扫码 / 手机验证码 / 腾讯 OAuth | `deepseek-v3`、`deepseek-r1`、`glm-5.3`、`glm-4-plus`、`kimi-k3`、`hunyuan-standard` 等 14 款精选模型 |
| **CodeBuddy (国际版)** | CodeBuddy AI Global | 国际版 GitHub / Google / Email 登录 | 国际版全系模型支持 |
| **WorkBuddy (国内/国际)**| 腾讯 WorkBuddy 生态 | 微信扫码 / 企业微信 / 国际版 OAuth | `GPT-6-Astra`、`GPT-5.6-Sol`、`GPT-5.6-Terra`、`GPT-5.5`、`Gemini-3.5-Flash`、`GLM-5.3` 等 20 款生态模型 |

---

## 🏗️ 架构设计与工作原理

```
   ┌──────────────────────────────────────────────────────────┐
   │                    DSH Desktop (前端)                    │
   │   [设置 -> Jet Hub 面板]          [设置 -> 模型列表]     │
   └───────────────┬───────────────────────────▲──────────────┘
                   │ RPC (jet-hub/*)           │ 动态 Provider 注册/注销
                   ▼                           │
   ┌───────────────────────────────────────────┴──────────────┐
   │                  Jet Hub 插件核心 (Cordis)                │
   │                                                          │
   │   ┌───────────────┐   ┌──────────────────────────────┐   │
   │   │  AccountPool  ├──►│ syncConfigurableProviders    │   │
   │   │  多账号池持久化│   │ 动态模型目录广播与增删        │   │
   │   └───────┬───────┘   └──────────────────────────────┘   │
   │           │                                              │
   │           │ 自动保活调度                                 │
   │   ┌───────▼───────┐   ┌──────────────────────────────┐   │
   │   │ Auto Refresh  │   │ LLM Adapters 统一适配层      │   │
   │   │ 30分钟静默巡检│   │ - AntigravityLocalAdapter    │   │
   │   │               │   │ - CodeArtsAdapter            │   │
   │   │               │   │ - BuddyAdapter (Code/Work)   │   │
   │   └───────────────┘   └───────────────┬──────────────┘   │
   └───────────────────────────────────────┼──────────────────┘
                                           ▼
   ┌──────────────────────────────────────────────────────────┐
   │                     模型推理与网关接入                    │
   │   - Google Antigravity: 本地 Language Server RPC 隧道    │
   │   - 华为云 CodeArts: Snap Access (IAM / STS 签名)        │
   │   - 腾讯 CodeBuddy / WorkBuddy: Copilot OpenAPI / Meter  │
   └──────────────────────────────────────────────────────────┘
```

1. **凭据隔离**：账号敏感 Token 保存在 DSH 内部凭据系统（`.credentials.yaml`），配置元数据保存在 `settings.yaml`，保障多账号安全性。
2. **事件总线**：账号的增添、删除、开关状态切换统一通过 `AccountPool.notifyAccountsChanged` 广播。
3. **动态同步**：收到广播后，`syncConfigurableProviders` 计算当前活跃渠道集合，调用 `ctx.llm.registerConfigurableProviders` 原子替换模型目录，实现与界面的毫秒级联动。
4. **Antigravity 本地直连**：通过自动发现本机的 `language_server_windows_x64` 进程及对应的监听端口和 CSRF Token，以本地 loopback 方式完成推理通信，不依赖外部公共 API，零风控风险。

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

### 步骤二：使用 Antigravity (Google) 本地模型
1. 只要本机已安装并启动 **Antigravity IDE**，Jet Hub 会自动检测到本地服务（显示绿色已连接、监听端口与可用模型数）。
2. 直接切换到 DSH **设置 -> 模型 (Models)** 页面。
3. 在提供方列表中找到 **Antigravity (Google)**，选择您心仪的模型（如 `Gemini 3.8 Flash (High)`、`Claude 3.7 Sonnet (Thinking)` 或 `GPT-OSS 120B`）。
4. 在主对话窗口即可直接提问，支持完整的流式响应与长会话多轮交互。

### 步骤三：添加华为云与腾讯账号
1. 在 Jet Hub 界面左侧选择需要添加的目标渠道（例如：`CodeArts (华为云)` 或 `CodeBuddy (国内版)`）。
2. 点击右上角的 **+ 新建账号** 按钮。
3. 系统会自动调起默认系统浏览器，打开官方授权登录页面：
   - **华为云**：登录您的华为云账户并点击“确认授权”。
   - **CodeBuddy / WorkBuddy**：支持微信扫码、手机号验证码或企业微信授权。
4. 授权成功后，浏览器会重定向到本地回调端口，Jet Hub 将自动完成 Token 兑换，并展示“账号授权成功”提示。
5. 此时返回 Jet Hub，界面将展示当前账号的昵称、账号 ID、过期时间与有效状态。

### 步骤四：账号运维与每日积分
- **一键测速 (重测所有 / 单账号重测)**：点击卡片上的测速按钮，系统会向对应平台发送探针请求，返回当前网络延迟与连通状态。
- **每日领积分 (CodeBuddy 专属)**：CodeBuddy 渠道卡片提供了“一键领取 / 签到”按钮，可直接获取官方每日免费赠送额度。
- **启用 / 停用账号**：通过开关按钮可以临时停用某个账号，被停用的账号不会参与模型调用。
- **删除账号**：点击垃圾桶图标即可移除不再使用的账号。

---

## 🔄 动态模型联动机制说明

为了防止用户在卸载或清理账号后，设置中心残留大量无法使用的空白 Provider，Jet Hub 引入了严格的**动态生命周期同步**规范：

- **展示原则**：只有**至少存在一个已启用有效账号**的渠道，才会在“设置 -> 模型”中注册可见。
- **清理原则**：当某个渠道的账号被**全部删除**（或处于未配置状态）时，插件会自动撤销该渠道的 Provider 声明。
- **无感刷新**：无需重启 DSH Desktop，删除账号的瞬间，模型列表即刻自动刷新脱挂。

---

## ❓ 常见问题排查 (FAQ)

#### Q1：使用 Antigravity 模型时提示“IDE 未运行”？
- **原因**：Antigravity 本地通道通过连接本机运行的 Antigravity IDE 语言服务提供推理。
- **解决办法**：请启动 Antigravity IDE 软件并保持在后台运行，Jet Hub 即可在数秒内自动建立连接。

#### Q2：Antigravity 多轮对话中会反复新建对话框吗？
- **不会**。Jet Hub 内部实现了会话锚定机制，在同一 DSH 对话内会持续复用同一 IDE Cascade 会话，并在发送消息时实施严格的轨迹时序保护，确保多轮问答连续自然。

#### Q3：点击“+ 新建账号”后浏览器打开了，但显示连接被拒绝或 404？
- **原因**：本地授权回调服务监听在 `10000` 以上端口（华为云与各大 OAuth 门户的要求）。
- **解决办法**：请检查是否有代理软件（如 Clash、V2Ray 等）拦截了 `127.0.0.1` 本地回环流量，建议在代理软件中将 `127.0.0.1` 和 `localhost` 加入 Bypass 直连白名单。

#### Q4：为什么我在 Jet Hub 中删除了华为云账号，模型列表里还有 CodeArts？
- **原因**：这是因为旧版本插件采用静态无条件注册。
- **解决办法**：请确保已更新至最新版本的 Jet Hub 插件代码，新版已全面支持 `onAccountsChanged` 动态注销逻辑，删除后即自动消失。

#### Q5：账号到期后需要手动重新登录吗？
- **不需要**。只要授权时获取到了 Refresh Token，后台调度器会在到期前自动续期。仅当官方服务端主动注销凭证（例如修改密码、撤销授权）时，才需要重新点击登录。

---

## 💻 本地开发与测试

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

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

**登录入口：Jet Hub 设置页的 CodeArts 面板**（与其余五个 provider 一致）。

⚠️ **不注册任何斜杠命令**。早期的 `/codearts-login`、`/codearts-status`、
`/codearts-refresh` 三个命令已移除 —— 登录、状态查看与续期统一在 Jet Hub 完成。
编程式调用仍可用：`ctx.codeartsAuth.login()` / `startLogin()` /
`refreshAccountCredential(refName)` / `refreshAll(pool)`。

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

除 `codearts` 外，插件另注册六个独立的 provider 路由：`buddy`（见
[buddy provider](#buddy-provider)）、`workbuddy`（见
[WorkBuddy provider](#workbuddy-provider)）、`lobsterai`（见
[LobsterAI provider](#lobsterai-provider有道龙虾)）、`qoder`（见
[Qoder provider](#qoder-provider)）、`trae`（见
[TRAE provider](#trae-provider字节跳动-trae)）与 `cline`（见
[Cline provider](#cline-provider)）。七者互不覆盖，可同时使用。

## 凭证

- ⚠️ **只支持账号池**：每个账号的凭据存储在 `CODEARTS_ACCOUNT_XXX`（Ref 为 POSIX
  标识符格式的凭证 ref），由 Jet Hub 设置页管理。
- **单凭据模式已移除**：早期那条「登录写固定 ref `CODEARTS_ACCESS_TOKEN`、
  适配器在账号池取不到时回退读它」的路径已删除。固定的
  `CODEARTS_ACCESS_TOKEN` 不再被写入或读取 —— 若你此前只用它登录过，
  模型列表会变空，请在 Jet Hub 的 CodeArts 面板重新登录一次。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。

## 续期（refresh）

- 默认登录流程为**新式 IAM OAuth**（PKCE + DPoP）：portal `/authorize` 授权 → 本地
  `/oauth/callback` 回调收取 `code` → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
  换取含 `refresh_token` 的凭据。
- 凭据在过期前 1 小时静默续期（`getFirstRefreshTime` 语义：距过期 ≤1h 立即刷，
  否则 `now+1h` 叠加随机秒偏移），全程无浏览器、无人工操作。
- 刷新失败后 10 分钟重试（异常网络 1 分钟）；`refresh_token` 失效后停止续期并提示
  重新登录。
- 旧 ticket 流程保留为显式回退：编程式调用
  `ctx.codeartsAuth.login({ flow: 'ticket' })`。ticket 凭据没有 `refresh_token`，
  其续期仍意味着重新运行浏览器登录流程。
- **续期按账号**：`refreshAccountCredential(refName)`（账号卡片的「刷新」按钮）
  与 `refreshAll(pool)`（定时调度器）。早期的 `refresh()` / `logout()` /
  `status()` / `scheduleRefresh()` / `scheduleModelRefresh()` 只服务于单凭据路径，
  已随该模式一并移除。
- 运行时依赖新增 `jose`（用于 DPoP JWS 签发，与 CodeArts Agent 插件实现一致）。

### ⚠️ 停用的账号同样会被续期

`refreshAll()` 与续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号仍然出现在 Jet Hub 里，也仍然参与积分领取。

> **真实缺陷**：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，点「一键领取
> 积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
> 根因是两处都按 `enabled` 过滤：
>
> - `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
>   → 停用期间 `refresh_token` 一路放到失效；
> - `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
>   → **所有账号都停用时，续期定时器根本不启动**。
>
> 用户重新启用后拿到的是死凭据，只能重新登录。四个 provider 的 `refreshAll`
> 与调度器都必须保持只看 `refreshable`。

### 凭据失效时不再抛 `Unexpected token '<'`

积分请求原本直接 `await response.json()`。凭据失效时腾讯网关返回的是
**HTML 错误页**，于是抛出 `Unexpected token '<', "<html> <h"... is not valid
JSON` —— 用户既不知道发生了什么，也看不出该重新登录。

现在先取文本再解析，非 JSON 时给出可读原因：

- HTTP 401/403 → 「凭据已失效（HTTP 401），请重新登录该账号」
- 其他状态 → 「服务端返回了非 JSON 响应（HTTP 502）：&lt;片段&gt;」

`src/credits.ts`（CodeBuddy 系）与 `src/lobsterai-credits.ts` 都已按此处理。

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

### 单次输出上限（`max_tokens`）

**远端下发 `maxOutputTokens`，适配器必须消费它并写进请求体。** 这是「回答被
截断、UI 报『已达到输出 token 上限』」的唯一根因修复。

- 请求体 `max_tokens` 取值优先级：
  **`options.maxTokens`（DSH 注入）→ 远端 `data.models[].maxOutputTokens` → 产品兜底表**。
  三者皆无则**不发该字段**，交回网关默认值（不编造数值）。
- `resolveModel()` 同时把该值声明为 `defaultMaxTokens`。DSH 只在调用方未显式
  给值时用声明的默认值兜底；适配器不声明就等于把上限永久交给网关默认。
- ⚠️ **远端非法值必须过滤**：DSH 对 `defaultMaxTokens` 有硬校验（非安全整数
  或 ≤0 直接抛 `INVALID_MODEL_MAX_TOKENS`，整轮对话起不来），故远端是外部
  输入，`0` / 负数 / `NaN` 一律视为未声明（见 `positiveMaxTokens`）。

实测（2026-09-19，`node scripts/dump-max-output.mjs`）：

| 模型 | 中国版 scoped 端点 | 中国版 `/v3/config` | 国际版 `/v3/config` |
|---|---|---|---|
| `deepseek-v4.1-flash` | 128000 | 131072 | 128000 |
| `deepseek-v4-pro` | 128000 | 131072 | — |
| `deepseek-v4-flash` | 50000 | 50000 | — |
| `hy4-preview` | 64000 | 64000 | 64000 |

⚠️ **网关默认值恰好是 32000**（远端 `auto` / `glm-4.6` / `kimi-k2.6` 等模型
声明的就是 32000），这正是未下发 `max_tokens` 时 `deepseek-v4.1-flash` 在
32000 处被截断的原因 —— 不是「网关固定上限」，而是上游声明的额度被适配器丢了。

网关**确实接受** `max_tokens` 且**精确生效**（`node scripts/verify-max-tokens.mjs`，
国际版 `deepseek-v4.1-flash`，当时处于官方限免期 `credit: 0`）：

| 请求 | 结果 |
|---|---|
| 不带 `max_tokens` | HTTP 200，`finish_reason=stop` |
| `max_tokens: 128000` | HTTP 200，接受 |
| `max_tokens: 64` | HTTP 200，**`finish_reason=length`、`completion_tokens=64`** |

第三行是关键证据：输出被精确截断在 64，证明该字段被服务端真实消费，而不是
被静默忽略。

> **单次请求 ≠ 单轮**：每个 step 都是独立请求、各有各的预算。因此
> 「拆多步写文件」仍是超出单次额度时最有效的手段；`max_tokens` 只是把单次
> 额度提升到上游声明的真实值。
>
> **思考档位与输出预算共享同一额度**：`reasoning_tokens` 计入
> `completion_tokens`（实测 `thinking` 内容与正文同池），故思考开到 `max`
> 时正文更早撞上上限。

### 模型计费倍率与同名模型

模型切换列表里每个模型后面会显示它的**计费倍率**：

```
Deepseek-V4.1-Flash · x0.03
GLM-5.3 · x0.79→x0.50          ← 有促销活动时显示 原价→促销价
```

倍率拼在**模型名**（`name`）后面，而不是说明（`description`）里 ——
composer 的模型切换菜单**只渲染 `name`**，`description` 仅用于 `/model` 弹窗。
`name` 纯属展示，DSH 的选择与持久化只用 `id`，所以附加价格不会影响会话。

各 provider 的倍率字段**形态互不相同**，实现里是分开解析的：

| provider | 远端字段 | 真实形态 |
|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | 字符串 `"x0.29"`（可为空串） |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | 字符串 `"0.50x"`（**x 在后**）；`factor: 0` = 免费。⚠️ **只由 `/v3/config` 下发**，企业模型端点没有；且须按 `schedule` 判时段 |
| `lobsterai` | `data[].costMultiplier` | 裸数字 `0.05` |
| `qoder` | 目录 `chat[].price_factor` | 裸数字，**`0` = 免费** |
| `trae` | `display_contact_config.consumption_rate.data.rate` | **裸数字** `0.08`；`0` = 免费（⚠️ `display_contact_config` 本身是 **JSON 字符串**，须二次解析） |
| `codearts` | 无 | 两个目录端点都不含计费字段 |

腾讯系的促销值带 `schedule`（每日时段 + 有效期 + 时区），**必须按当前时间本地
推算此刻是否生效**，不能只看 `enabled`；`factor: 0` 表示**免费**（如
`hy4-preview` 的夜间免费），只有**没有时间窗口**的 `"0x"` 才当作「已结束」占位。

TRAE 的活动折扣只用**当前确实生效**的那一档：`activity_discount.enable` 为
`true` 也可能是「无折扣」（`discount_type: "none"`、原价==折后价，实测 `off_peak`
型即如此），照显会得到 `x0.13→x0.13`；已过 `end_at` 的活动同样不展示。

Qoder 的免费模型（`price_factor: 0`）显示为「免费」而不是 `x0`；有错峰折扣的
模型在**折扣时段内**显示「原价→折后价」，时段外只显示原价：

```
Qwen3.8-Flash · 免费
Qwen3.8-Max · x0.5→x0.2          ← 22:00–08:00（UTC+8）内
Qwen3.8-Max · x0.5               ← 时段外
DeepSeek-V4-Pro · x0.5
```

> ⚠️ **折扣形态三个 provider 统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
> buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
> 中文角标」（`x0.2 错峰 4 折`），问题有二：① 看不出原价与折扣幅度；
> ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。

> ⚠️ `credits` 与 `discountedCredits` 的 `x` **位置相反**（`"x0.29"` vs
> `"0.50x"`）。早期版本只认前缀写法，导致促销价被静默丢弃。
>
> ⚠️ **腾讯系两个端点下发的模型 id 集合不同，必须取并集** —— 促销可能只挂在
> 其中一个端点独有的 id 上。实测 `hy4-preview-f`（新用户限时免费）**只由
> `/v3/config` 下发**且被 agent 引用，而 scoped 端点给的是 `hy4-preview`
> （无促销）。只采信 scoped 就会显示 `x0.29` 而 IDE 显示免费（用户报障
> 「hy4 preview 现在 ide 是免费我们还是 0.29」）。**不同账号下发的变体 id
> 也不同**，排查时须多账号对照。
>
> ⚠️ **腾讯系的促销只在 `/v3/config` 下发，企业模型端点没有** —— 而后者被优先
> 返回，所以早期实现**永远不显示促销**（用户报障「codebuddy 的倍率显示也是
> 没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。现补取促销表并合并。
> 且**必须按 `schedule` 判此刻是否生效**（`glm-5.2` 夜间/白天是两条互补活动，
> 不看时段会全天显示折扣价）；**`factor: 0` 是「免费」而非「已结束」**
> （`hy4-preview` 夜间免费，用户报障「夜间 0，现在显示 0.29」）。
> ⚠️ `/v3/config` **有 UA 校验**，UA 不对返回 HTTP 200 + `code:12403`，
> 极易误判为「该端点没有促销数据」。
>
> ⚠️ 产品兜底表是**白名单**（不在表里的 id 会被丢弃），但**被 agent 引用的
> 模型例外保留**（服务端自己的「可选」信号）—— 否则 `hy4-preview-f` 会被丢掉。
> 判据**不是**猜 id 后缀（`-f`/`-x`/`-sg` 含义各异，猜错会放进不可用的模型）。
>
> ⚠️ Qoder 的字段是 `price_factor`，**不是** `cost_multiplier`（后者是
> LobsterAI 的）。而 `price_factor: 0` 是**合法的免费值**，不能用 `> 0`
> 过滤掉。
>
> ⚠️ 倍率**不能**放进 `description`：那在切换模型列表里根本不可见
> （用户报障「消耗倍率没有显示在切换模型列表的后面」）。
>
> ⚠️ **Qoder 的错峰时段按 `windowStart`/`windowEnd` 本地推算，不采信目录的
> `promotion.active`** —— 后者是目录下发那一刻的快照，客户端长时间不重启
> 就会与真实时段脱节（用户在时段外看到折后价、或时段内看不到折扣）。
> 生效价由 `beforePromotionPriceFactor × discountFactor` 推出（实测三条全部吻合）。
> **真实缺陷**：早期表里存的是「采集时刻的生效价」却当成恒定值展示，
> 且 14 个模型的数值本身也是过期估值（`smodel` 写 3.2 实际 8），
> 用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。

#### 同名模型会自动区分

服务端会给**不同 id 配同一个展示名**，实测三组：

| 模型 id | 远端展示名 | 实际差异 |
|---|---|---|
| `deepseek-v4.1-flash` / `deepseek-v4.1-flash-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，倍率 x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

由于选择器按展示名渲染，这些会变成无法区分的重复条目（用户报障：
「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」——IDE 按展示名
归并，本插件按 id 列出）。二者是**不同区域的独立计费实体**，不能简单丢弃其一，
故对撞车的 id 求公共前缀、把剩余段追加到名字后：

```
Deepseek-V4.1-Flash · x0.00        (deepseek-v4.1-flash)
Deepseek-V4.1-Flash · x0.03 SG     (deepseek-v4.1-flash-sg)
Hy3 · x0.00                        (hy3)
Hy3 · x0.05 X                      (hy3-x)
```

用公共前缀而不是硬编码 `-sg`，是因为撞车组会随服务端上新变化（本次实测三组
里只有一组带 `-sg`）。LobsterAI 实测无同名（28 个模型 0 组重名），故不做消歧。

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

### 没有已登录账号就不显示该 provider（目录门控）

**需求**：若某供应商没有已登录的账号，就不显示该供应商的所有模型 —— 这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。

**机制**：DSH 的 `buildModelCatalog` 显式 `.filter(group => group.models.length > 0)`
（注释 *"successful non-empty provider groups"*），所以适配器 `listModels`
返回**空数组**即可让整个 provider 分组从模型选择器消失 —— **无需任何前端改动**。

- **判据是「凭据能否解析」**，不是「有没有账号条目」：登出（`logout()`）只清凭据、
  保留条目，若只看条目则登出后模型仍会显示，门控形同虚设。
- **不看 `enabled`**：停用只影响自动选号，与「是否已登录」无关。把所有账号停用的
  用户仍能看到模型（与「续期只看 `refreshable`」是同一条约定）。
- ⚠️ **CodeArts 是唯一保留单凭据模式的 provider**：它额外把
  `CODEARTS_ACCESS_TOKEN` 计入判据，只用单凭据登录的老用户不会受影响。
  其余五个 provider 只看账号池。
- ⚠️ **返回空数组而非抛错**：抛错会被归入 catalog 的 `failures`，界面反而多出
  一条 provider 报错。
- ⚠️ **不影响路由**：`routableProviders` 单独生成（不经该 filter），已持久化的
  模型仍可正常收发 —— 与黑名单同一契约。
- ⚠️ **门控只作用于对话框目录**；Jet Hub 的「显示列表」（`listAllModels`）仍列出
  全部模型，否则用户关掉模型后连开关都看不到、无法重新打开。
- **判据不可用时保守放行**（无账号池 / 替身未实现 / 读凭据异常）：门控是展示优化
  而非安全边界，宁多勿少。
- 开关：`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`（**默认开启**，设 `0`/`false`/`no`/`off`
  可关闭）。实现见 `src/account-pool.ts` 的 `hasLoggedInAccount` /
  `providerCatalogVisible`。

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

## Qoder provider

独立路由 `qoder`（阿里系 AI 编程 IDE **Qoder**）。**推理走加密端点**
（请求体与签名头由客户端自带的 WASM 生成），因此能拿到与客户端
**完全一致**的模型池（含 Qwen3.8 系列）。详见下方「两条推理路径」。

该 provider 与其余四者**协议都不同源**，实现是独立一套
（`src/qoder*.ts` + `src/qoder-wasm.ts` + `src/qoder-envelope.ts`
+ 复用的 `src/openai-compat.ts`）：

| 项 | 其余四个 provider | Qoder |
|---|---|---|
| 登录方式 | OAuth 回调 / external-link 轮询 / 本地回调 | **PKCE 设备码轮询**（不开监听端口） |
| 续期请求体 | 只带 `refresh_token`（+ 各自身份字段） | 还要带 **`machine_id`** |
| 推理鉴权 | 华为 HMAC / 纯 Bearer | **请求体加密 + 签名头**（不能自行构造） |
| 模型列表 | 远端接口（权威） | **本地静态表**（远端需签名）+ 加密端点使用目录 key |
| 积分能力 | 余额 ✓（`sash/api/v2/me/usage`）/ 签到 ✗ |

### 登录（设备码轮询）

浏览器打开 `https://qoder.com/device/selectAccounts?...`（PKCE `S256` +
`client_id`），用户在网页完成授权后，插件轮询
`https://openapi.qoder.sh/api/v1/deviceToken/poll` 取回
`{ token, refresh_token }`。

- **`404` 表示「用户尚未完成授权」，不是错误**，必须继续轮询
  （官方客户端同样如此）。实测依据：该端点返回 404 而任意不存在的路径
  返回 401，说明它被网关豁免认证、由业务层报「会话未就绪」。
- **必须走两步式**：`account.create` 在用户授权**之前**返回 `loginUrl`，
  由前端立即 `window.open`（浏览器 transient activation 约束，
  见 [+ 新建账号](#-新建账号必须走两步式登录四个-provider-一致)）。

### 两条推理路径（**认两套不同的模型名**）

这是本项目**最容易踩的坑**。Qoder 有两个推理端点：

| 路径 | 端点 | 模型名 | 能力 |
|---|---|---|---|
| **加密（本插件使用）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；**能拿到 Qwen3.8 系列** |
| 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash` / `qwen-plus`） | 标准 OpenAI 格式；**目录 key 一律被拒** |

⚠️ **两个 host 不同**（`api2` vs `api2-v2`），混用会 404。

**真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后**没收到回复就终止**」。
根因是早期把**目录 key 发给了公开端点**（得到 `Unsupported model`，
且该错误帧又被解析器静默吞掉）。

随后又误判为「目录 key 不可用」，把模型表换成了通用名 —— 于是拿到的是
**Qwen3.5 / Qwen-2.5**，而不是目录里的 Qwen3.8 系列（用户再次报障）。

### 加密推理（`src/qoder-wasm.ts`）

Qoder 的**真实**推理链路要求请求体加密、并带一套服务端认可的身份签名头，
否则请求被拒。客户端把实现该协议的 WASM 内嵌在自身产物里，本插件按
wasm-bindgen 约定把它接起来**复用**（`src/qoder-wasm.ts`）。

- **不是「破解密码学」** —— WASM 自己就导出了成对的编解码函数，我们只是
  调用它，等同「用客户端自己的钥匙开自己的锁」。
- **响应不需要解密** —— 只在每帧外套一层信封，内层是标准 OpenAI chunk；
  `src/qoder-envelope.ts` 负责剥信封，剥完交给 `src/openai-compat.ts`。
- ⚠️ **签名头必须原样透传**，不能用 `Bearer <token>` 覆盖（会被判签名无效）。

> 实现细节（glue 约定、请求体字段、签名载荷、三个已踩过的坑）记录在
> **不入库**的内部文档 `docs/qoder-encryption-notes.md` 中 ——
> 该文档含逆向分析，刻意不随仓库分发。

### 工具调用（tools）

加密端点认 **OpenAI 风格**的工具描述，落在请求体**顶层** `tools`：

```jsonc
"tools": [{ "type": "function",
            "function": { "name": "read", "description": "…", "parameters": { … } } }]
```

assistant 的工具调用挂 `tool_calls`，工具结果用 `role:"tool"` + `tool_call_id`。

⚠️ **真实缺陷**（用户报障）：「使用本插件的 qoder 的 qwen3.8-flash，
执行任务出现任务调用 xml 泄露任务终止」。两处根因：

1. 适配器**从不消费 `options.tools`**（其余四个 provider 都消费），且
   `qoder-wasm.ts` 把请求体的 `tools` **硬编码为 `[]`** → 模型在 wire 上
   拿不到任何函数 schema，只能用**正文里的 XML 文本**臆造工具调用，
   harness 认不出 → 任务终止；
2. history 过滤器写成「只留 `content` 为字符串的消息」，而 assistant 带工具
   调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条被丢，`role:"tool"` 的
   `tool_call_id` 也被丢 → 模型看不到自己调用过什么，反复重调同一工具或
   凭空编造结果（与 TRAE 那条同型缺陷一致）。

⚠️ **别照抄 Anthropic 风格**：客户端另有 `tool_use` / `input_schema` /
`tool_use_id` 一套，那是给 **Anthropic BYOK** 用的分支，本端点不吃。

⚠️ **加密端点的请求体本地不可解**，无法靠抓包验证 —— 故 payload 构造抽成
纯函数 `buildQoderInferPayload()`，由 `buildQoderTools()` /
`buildQoderHistory()` 与端到端替身共同锁死（`tests/unit/qoder-tools.spec.ts`）。

### 「没有任何报错就中断」已修

症状：UI 上**看不到任何错误**，任务却停在了半路（`turn/end` 是 `completed`）。

**根因**：`consumeOpenAiSse` 把「**没收到 `finish_reason`** 且**没有工具调用**」
直接判成 `{kind:'stop'}` —— 而 `stop` 是「模型正常答完」的信号。于是**被掐断的
连接伪装成正常结束**，harness 认为本轮已完成，任务就此中断。

真实案例（2026-09-23，`qoder`/`qfmodel`）：某步的 chunk 流只有
`block-start(text) → text → usage → block-end → finish{stop}`，**没有任何
tool-call 分片**，而正文以冒号「：」结尾（模型正要调工具），`outputTokens=118`
远未触上限；相邻的**正常步**则多出 `block-start(tool-call) → tool-call-chunks`。

**修复**：判据改为「**连接结束的方式**」—— 既没有显式 `finish_reason`、
也没有 `[DONE]`，就报 `max-tokens`（不完整、可重试），不再报 `stop`。

同时修掉两个同族缺陷（都表现为「无报错中断」）：

- **网关形态错误帧被整帧丢弃**：`{"stackTrace":[…],"message":"…","statusCodeValue":400}`
  既没有 `code` 也没有 `error`、也没有 `choices`，早期解析器所有条件都不命中；
- **响应根本不是 SSE**（网关直接回了一段 JSON，没有任何 `data:` 帧）：
  早期静默空结束，现抛错并**带上原文片段**。

> 排查这类问题用 `node scripts/inspect-session.mjs`（只读）——它能把会话日志
> （zstd 压缩的 JSONL）里的**原始 chunk 流**还原出来。用法见 `AGENTS.md`。
> 回归用例 `tests/unit/qoder-silent-stop.spec.ts`。

### 模型列表：17 个目录 key（**实测数据**）

`listModels` 是**静态表**（不发网络请求）—— 远端目录需签名，运行时不做。

表里是客户端目录下发的 **17 个 key**，全部实测可用：

| 分组 | 模型 |
|---|---|
| Qoder 档位 | `auto` / `ultimate` / `performance` / `efficient` |
| 内部代号 | `smodel`(Sonus) / `cmodel`(Cantus) |
| **Qwen** | `qmodel_38max`(3.8-Max) / **`qfmodel`(3.8-Flash)** / `qmodel_latest`(3.7-Max) / `qmodel`(3.7-Plus) |
| Kimi | `kmodel_latest`(K3) / `kmodel`(K2.8-Preview) |
| GLM | `gmodel`(5.3) / `gfmodel`(5.3-Flash) |
| DeepSeek | `dmodel`(V4-Pro) / `dfmodel`(Flash) |
| MiniMax | `mmodel`(M3) |

⚠️ **请求体必须带 `business` 字段** —— 缺了服务端会把请求路由到故障节点，
而**其余模型恰好不受影响**，所以现象像「只有 `qfmodel` 一个模型坏掉」，
极易误判成「服务端故障」。**判据是「Qoder IDE 能否用同一模型」**：
IDE 能用即说明是我们的请求缺东西。

**免费额度模型**（`is_free=true`）：`qmodel_38max` 与 `qfmodel`。
e2e 探针默认用 `qmodel_38max` 以免消耗积分。

- 该表**会逐渐过时**（新模型上线后不会自动出现）；
- 按 DSH 约定「`listModels` 结果仅供参考」，**表外的 key 仍可手动指定**；
- 需要刷新时按下方「升级 WASM」流程重新采集，并**逐个验证可推理**再入库。

### 升级 WASM（Qoder 版本更新时）

Qoder 升级后签名协议可能变化，表现为**难以解释的 `Signature invalid`**
或 `[FAIL]node:...`。此时刷新：

```bash
pnpm qoder:wasm            # 自动取本机 Qoder 最新版本的内嵌 WASM
pnpm qoder:wasm 0.3.5      # 或指定版本
pnpm build:assets          # 同步到 lib/
```

脚本取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE
**实际运行**不同的版本。刷新后**务必实测一次对话**（`qfmodel` 或
`qmodel_38max`）确认签名仍被接受。

### 积分余额（Credits Balance）

`qoder` 面板**支持积分余额**：

```
GET https://openapi.qoder.sh/sash/api/v2/me/usage
Authorization: Bearer <token>
Cosy-ClientType: 5
```

⚠️ 两个易错点：

1. **路径前缀是 `/sash/`**，不是 `/api/`。早期因为只按 `/api/` 前缀搜索
   而误判「Qoder 无积分端点」。
2. **余额不只在 `userQuota` 里**。实测某账号 `userQuota.remaining = 0`
   而 `addOnQuota.remaining = 100`（资源包）；只读 `userQuota` 会显示 0。

该端点**只需 Bearer**，不需要模型列表那样的 WASM 签名。企业版账号
（`displayMode: "enterprise"`）不下发额度数字、只给外部链接，此时返回
「查询失败」而非 0。

### 每日领取（每日 100 Credits）

```
GET  https://openapi.qoder.sh/sash/api/v1/me/campaigns
POST https://openapi.qoder.sh/sash/api/v1/me/campaigns/{campaignId}/claim   ← body 空
```

活动**每日 10:00（UTC+8）刷新**，领取后 30 天有效。

⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样返回
**200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是上一次领取的
旧时间。只看状态码会把「今天已领」误报成「领取成功 +100」。

⚠️ 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'` ——
实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。

> **这段协议是抓包解出来的**：早期依据 `/sash/api/v1/me/campaigns` 返回
> `claimable:false` 判定「Qoder 无签到」，真相是**那天已领**。

### 凭据与续期

- **登录入口：Jet Hub 设置页的 Qoder 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 凭据 ref：单账号 `QODER_ACCESS_TOKEN`；多账号
  `QODER_ACCOUNT_<UUID_SHORT>`（由 Jet Hub「+ 新建账号」生成）。
- 凭据结构：`security_oauth_token` 与 `access_token` **双写同值**
  （服务端取用顺序是前者优先），外加 `refresh_token` / `expire_time` /
  `refresh_token_expire_time` / **`machine_id`**。
- ⚠️ **`machine_id` 必须持久化**：续期请求体需要它。本插件生成**随机 UUID**
  并随凭据保存（不复制官方客户端的硬件指纹逻辑 —— 那依赖 `@napi-rs` 原生
  模块取 SMBIOS UUID，属设备指纹且不可移植）。**这是本实现最大的未验证
  假设**：若服务端校验设备一致性，续期会被拒。`pnpm test:e2e:qoder-chat`
  的续期用例专门验证这一点。
- 续期：与其他 provider 同一调度器（启动后每 30 分钟对**可续期**账号静默
  刷新）。终态判定：HTTP 401/403 或响应缺 token → `RefreshTokenExpiredError`
  （停止重试）；网络抖动与 5xx 走可重试路径。

### 适用范围

**仅支持国际版**（`qoder.com` / `qoder.sh`）。中国版（`qoder.com.cn`）的
端点与 client id 不同，本实现未覆盖。

## TRAE provider（字节跳动 TRAE）

独立路由 `trae`（字节跳动 **TRAE**），走 SOLO 免费对话通道，
端点 `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`，
以 `Cloud-IDE-JWT <token>` 头鉴权。

该 provider 是**第三个独立协议族**（实现见 `src/trae*.ts`），与腾讯系、
LobsterAI 都不同源。它也是唯一一个**请求与响应都要转换**的 provider：

| 项 | 其它 provider | TRAE |
|---|---|---|
| 消息序列化 | 有（`tool-call` → `tool_calls`） | **必须有**（DSH 原生块 → OpenAI wire）；漏掉会让**模型看不到工具调用与结果**（真实缺陷，已修复） |
| 请求体 | 基本透传 OpenAI 格式 | **必须转换**为 SOLO 格式（`function: "solo_work_lite"`、`config_name`、`tools.parameters` 序列化为字符串、`tool_calls.function` → `function_call`） |
| 响应流 | OpenAI 标准 SSE | **SOLO 自定义事件**（`output` / `token_usage` / `done` / `error`），需转成 OpenAI chunk |
| 鉴权头 | `Bearer` / 签名 | `Cloud-IDE-JWT` + 十余个 `X-*` 身份头 |
| 换 token | 轮询 / authCode | **ExchangeToken**（`refresh_token` 会**轮换**） |
| 设备指纹 | 无 | **必须持久化** `machine_id` 与 `device_id`（均为 32 位 hex） |
| **登录回调** | 各不相同 | **老流程直接回传 token**（`refreshToken` / `userInfo` / `userJwt`）；**并存 PKCE 新流程**（带 `code` / `authCodeInfo`），两套都要认；参数名是 **`auth_callback_url`** |
| 回调端口 | 各不同 | 默认 `127.0.0.1:18080`，**被占用时自动回退随机端口** |
| 图片输入 | Buddy / LobsterAI 支持 | **支持**，但**逐模型**判定（远端 `display_config.multimodal`；本插件可见集里约 15/19 为 `true`） |
| 历史长度 | 无硬约束 | 超约 **500K 字符上游会静默断流** → 自动裁剪（保最新、不切断工具配对） |
| 单次输出上限 | 采信远端声明 | 收敛到 **64000**（上游安全线，可配） |
| 模型列表 | `GET` | `POST /api/ide/v1/get_detail_param`（响应 `config_info_list[]`） |

> **图片输入（逐模型）**：判据是远端 `display_config.multimodal`。
> `true` → 声明 `['text','image']` 并把图片转成 `{type:'image_url',image_url:{url}}`
> 的 data URL 发出；`false` / 未声明 → 收到图片时明确报错且**不发请求**。
>
> 实测（2026-09-21）：直发纯红图答「红色」、纯蓝图答「蓝色」、不带图答「无法确定」
> —— 三次答案不同，证明模型真读到了像素。而 `multimodal: false` 的模型
> （如 `DeepSeek-V4-Pro-Official`）收到图后答「无法确定」、思考链明说「但没有图片」，
> 与不带图的回答一致 → 该标志是**权威准入判据**。
>
> ⚠️ **用户贴图**与**工具结果内嵌图**是两个独立字段
> （`multimodal` / `tool_response_multimodal`）：实测 `deepseek-v4.1-flash`
> 前者 `true`、后者 `false`，不可合并判断。

- **登录入口：Jet Hub 设置页的 TRAE 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.traeAuth.login()` / `startLogin()` / `status()` / `refresh()` /
  `logout()` / `fetchModels()`。
- 凭据 ref：
  - 单账号：`TRAE_ACCESS_TOKEN`；
  - 多账号：`TRAE_ACCOUNT_<UUID_SHORT>`，由 Jet Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` /
  `uid` 外，还持久化 **`machine_id`** 与 **`device_id`**（两者均为 32 位 hex）：
  - `machine_id` 是设备指纹，续期时**绝不可重新生成**（服务端按它标识设备）；
  - `device_id` 是签到设备号，**账号间必须互异** —— 同一天两账号共用会被
    「该设备已签到」拦截，为空则签到报 9004。
- 登录 URL 含 **18 个参数**（对齐唯一权威实现 `login.sh`），包括
  `auth_from=solo`、`login_channel=native_ide`、`plugin_version`、
  `login_trace_id` 与 `x_*` 客户端形态系列。少发参数会让登录页停在授权中。
- **两套回调流程都要认**：
  - **老流程**（当前 `auth_type=local` 实际走的）：直接回传 token，形如
    `?refreshToken=...&userInfo={...}&userJwt={...}`，不做授权码交换；
  - **新流程**（PKCE）：回带 `code` / `authCodeInfo`。本实现会**识别**它并给出
    「上游走了 PKCE 流程，暂不支持」的**精确报错**，而不是笼统地说
    「缺少 refreshToken」（把合法回调误判为无效会把排查方向带偏）。
  另外 `userInfo` 的中文昵称存在双重编码乱码，插件会自动回转修复。
- ⚠️ **任何回调路径都必须落定登录结果 Promise**：早期实现里解析失败分支只
  `res.end()` 就 return，导致 `login.poll` 永远拿不到 `done:true`，
  前端**永久停在「认证中」**。这与「参数名写错」是两个独立根因、同一个症状。
- 模型列表：走**批量**端点 `POST /api/ide/v1/batch_get_detail_param`（真实 CN IDE
  的用法），**一次拉取多个「通道」（`function`）各自一套模型目录**；失败时回退
  `src/trae-product.ts` 的 32 个内置模型。
- ⚠️ **模型只在列出它的通道里可调用**。实测：`glm-5.1` 在 `solo_agent_remote`
  正常、在 `solo_work_lite` 回流内 `4001`；`glm-5-turbo` / `sagitta` 恰好相反。
  因此插件会**按每个模型所属通道分别下发 `function`** —— 旧实现把 `function`
  写死 `solo_work_lite`，agent 专有模型一用就报
  `trae: We're sorry, the param is invalid. (code=4001)`。
- ⚠️ **两种「不可用」要分开看**：
  - `display_config.is_custom_model === true`（需在 IDE 内自行绑定供应商）
    → **必然 4001，插件剔除**。实测 2026-09-19 该账号有 5 个，但**该名单已过期**
    （复测 2026-09-20：3 个下架、2 个转为 `false` 可调用，全目录 custom 条目数为 0）
    —— 判据是**标志的值**而非模型名，别把某一刻的快照写成规则。
  - `is_invisible_to_user === true`（**官方 picker 不展示**）→ **硬性剔除**，
    使目录与官方 Auto Mode 选择器一致（代价是看不到 `glm-5.1` 等可调用模型）。
  - 若仍选中了不可调用的模型（如会话里持久化的旧 id），报错文案会直接点明
    「模型不被上游接受」，而不是让人去查参数格式。
- **远端参数会被消费**：`context_window_tokens.dev` → 上下文窗口
  （实测主流 **200000**；`max` 的 1M 需官方 max_mode，本插件不实现）；
  `model_detail_list[].max_tokens` → 输出上限（实测主流 **32000**）。
- **`4001` 还有一个自伤成因**：请求头里 `Content-Type` 与 `content-type`
  各写一次会被 `Headers` 合并成 `"application/json, application/json"`，
  上游回 HTTP 400 + `code=4001`。写探针时请用 `new Headers(base).set(...)`。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  终态判定有三条依据（HTTP 401/403、`session-dead` 分类、2xx 但无 `accessToken`）；
  网络抖动与 5xx 走可重试路径。
- 失败模式：`4008`（`ide_credits` 耗尽）与 `1005`（plan 权益不足）是最主要的
  两个，会被分类为需要冷却的类别并触发多账号轮换。
- **签到所得积分如实上报**：`checkin_credits/claim` 的响应**只有**
  `{"code":0,"message":"success"}`，**不含积分数** —— 故领取成功后会补查一次
  `checkin_credits/status`（其 `credits` 字段即所得，实测 `150`，与积分余额里
  「签到奖励」包的 `credits_limit` 吻合）。早期从 claim 响应读 `credits`，
  于是恒为 0，界面显示「领取成功 **+0 积分**」。
- **已签到必须靠状态判定**：claim 对「今天已签到」是**幂等**的，重复领取同样返回
  `code:0`，与真正成功**无法区分** —— 故 `claimAll` 的 TRAE 分支**必须开启状态
  预检**（`checked_in`），不能用 `precheckStatus: false`，否则已签到的账号会被
  报成「领取成功」。
- **签到 `9074`（人数过多）不再换设备号重试**：设备身份已由 `uid` 确定性派生、
  每账号独立，「换个 id 就能成功」的前提不成立。命中即归为业务错误（300s 冷却）
  并如实上报。
- **空响应（HTTP 200 但零事件）重试一次**，且**仅在首个模型事件之前** ——
  已有输出后绝不放，避免重复计费与重复执行工具。
- 可调环境变量：
  - `DSH_TRAE_CHANNELS`（默认 `solo_work_lite,solo_agent_remote`）要拉取的通道，
    **顺序即优先级**（前面的通道优先决定同名模型走哪个通道）；
  - `DSH_TRAE_HIDE_INTERNAL=1` 连官方隐藏的条目一并从目录剔除（与真实 CN IDE
    的选择器一致，代价是看不到 `glm-5.1` 等可调用模型）；
  - `DSH_TRAE_MAX_COMPLETION_TOKENS`（默认 `64000`，设 `0` 关闭收敛）；
  - `DSH_TRAE_MAX_HISTORY_CHARS`（默认 `480000`）；
  - `DSH_TRAE_ROTATE_MACHINE_ID=1`（**默认关闭**）启用机器指纹轮换以应对集中风控。

> 尚未实现：真实 CN IDE 的 `llm_utils_chat` / `create_agent_task` **请求体是加密的**
> （配 `x-helios` / `x-medusa` / `x-neptune`）；实测仅换版本头解不开依赖它的模型
> （`deepseek-v4-flash` 等）。属独立工作量。

> 实现依据见 `docs/trae-integration-plan.md`（协议逆向自
> [`trae2api`](https://github.com/Sliverkiss/traework2api) 及其衍生项目）。

## Cline provider

Cline（[cline.bot](https://cline.bot)）桌面端的账号与模型路由。协议全部由本机
Cline 产物逆向 + 实测得出（2026-09-25），与其余六个 provider **都不同源**：

| 维度 | 本 provider 的取值 |
|------|-------------------|
| 登录 | **WorkOS 设备码轮询**（`api.workos.com`，不起本地监听端口） |
| 鉴权头 | `Authorization: Bearer workos:<jwt>` —— **前缀不可剥** |
| 推理 | **标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`） |
| 续期 | `POST {apiBase}/api/v1/auth/refresh`，body `{refreshToken, grantType}` |
| 积分 | 余额有；**签到无**（后端没有签到接口） |

### 登录（设备码轮询）

Jet Hub 的 Cline 面板点「+ 新建账号」→ 浏览器打开授权页并显示用户码 →
在浏览器完成授权 → 插件自动换取凭据。全程**不需要**本地回调端口。

⚠️ **`authorization_pending` 不是错误**：它是「用户还没在浏览器里点授权」，
插件会继续轮询（与 Qoder 的「404 表示尚未授权」同类语义）。`slow_down` 会
**累积退避**后再轮询。

### 免费模型

Cline 的免费模型由远端 `GET /api/v1/ai/cline/recommended-models` 的 **`free`
数组**动态下发，插件在模型列表里把它们的名字标成 `· 免费`，例如：

```
Space Bunny Alpha · 免费
MiMo-V2.6-Flash · 免费
DeepSeek V4.1 Flash · 免费
Gemini 3.8 Flash · 免费
Muse Spark 1.3 Contributor · 免费
```

⚠️ **免费与付费是两组不同的模型 id**，不是同一模型的两种档位：

| 免费（`free` 数组下发） | 按量计费（同名前缀不同） |
|---|---|
| `cline-free/deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` |

插件的判定基于**完整 id**（远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/`
前缀 ∪ 静态兜底），**不做名字模糊匹配** —— 否则会把付费条目误标为免费，
用户按免费预期使用却被计费。

⚠️ 免费资格是**服务端随时可撤销**的营销状态，故插件每次都从远端重新取，
不在代码里硬编码任何免费模型名。

### 思考强度

模型选择器旁提供 `None / Low / Medium / High / Extra` 五档，与 Cline IDE 一致，
默认 **High**。

- `None` = 不思考（实测不传 `reasoning_effort` 时模型本就不思考）
- `Extra` 对应上游的 `max` 档 —— 内嵌目录里的 `xhigh` 实测与 `high` 无可辨差异，
  故跳过它，把真正的最高档留给 `Extra`

⚠️ 档位数据来自 Cline 客户端内嵌的模型目录，**远端接口不下发**（`/api/v1/models`
只有 `{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`）。对不在该目录里的模型，五档是统一给的 ——
上游不认识的档位会被**静默忽略**（不会导致请求失败，最坏是「开关无效」）。

⚠️ 声明默认档位 High 意味着**默认会思考**：未手动选择时插件会带上
`reasoning_effort: 'high'`，思考 token 计入 `completion_tokens`。想要完全不思考，
在选择器里选 `None` 即可。

### Gemini 系模型的两个 400（已修）

`cline-free/gemini-3.8-flash` 曾「发消息即失败」。错误体里一次请求有**两个
provider 尝试、两个不同的错误**，是两个独立根因：

| provider | 错误 | 根因 |
|---|---|---|
| `vertex` | `maxOutputTokens 131072 超出 1..65537` | 兜底表数值填错，应为 **65536** |
| `google` | `tools[..].properties[permission].enum[3]: cannot be empty` | 工具 schema 的 `enum` 含空串 |

- **上限**：该模型不在客户端内嵌目录里，曾经照抄其它免费模型填了 `131072`；
  实测上限是 **65536**。适配器的 `clampClineMaxTokens` 也会把越界值收敛。
- **工具 schema**：harness 下发的工具集里某些 `enum` 带空字符串成员，Gemini 系
  严格校验直接 400。插件从不自己造 enum（原样透传 `tool.parameters`），
  但请求是我们发的，故由 `sanitizeClineToolParameters()` 递归清洗：
  只删空串、保留数值枚举、全空则丢弃 `enum` 键、递归下钻嵌套层。

⚠️ 故障**不是必现的** —— 上游会依次 fallback 多个 provider，命中哪个就暴露哪个
错误。别因为「重发一次就通了」而误判为偶发故障。

### 「API 密钥无效」不一定是真的凭据问题

部分模型（实测 `cline-free/muse-spark-1.3-contributor`）在该地区不可用，Cline 返回：

```
403 {"error":"access forbidden: … is not available in your region","success":false}
```

⚠️ 这条 403 与凭据无关，但 DSH 客户端对 `AUTH` 错误码一律显示「API 密钥无效」，
真实原因会被完全掩盖。

插件已按响应体文案识别地域限制（不能只看状态码 —— 同一批 403 里也有真凭据问题），
命中时**跳过无意义的续期**，并以 `PERMISSION_DENIED` 抛出真实原因，例如：

```
cline: access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region
```

这类模型无法在本地区使用，可在 Jet Hub 的「显示列表」里关掉，换用其它免费模型。

### 积分余额

Jet Hub 的 Cline 账号卡片会显示账户余额（`GET /api/v1/users/{accountId}/balance`）。
**没有「一键领取积分」按钮** —— Cline 后端没有签到接口（对 sidecar 做全量字符串
扫描，`checkin` / `campaign` 等均无业务端点命中）。

### 适用范围

- 需要**已登录 Cline 账号**（Jet Hub 面板登录，或用免费账号）；
- 模型列表**全部列出**（含付费模型），免费的带 `· 免费` 标记；
  可在 Jet Hub 的「显示列表」里逐个关闭不需要的；
- 图片输入按模型判定（内嵌目录 `capabilities` 含 `images`）。

### 图标

面板图标是**从本机 Cline 安装目录提取的官方图标**（`icons\app\macos\classic.png`，
品牌紫底），不是手绘的 —— 早期版本曾按印象画了个「C 形弧线」，与真实标志不符。

需要重新提取（例如 Cline 换了图标，或想换主题）时：

```bash
node scripts/extract-cline-icon.mjs                    # classic（默认），48×48
node scripts/extract-cline-icon.mjs --theme=midnight   # 换主题
node scripts/extract-cline-icon.mjs --dry-run          # 只报告不改文件
pnpm build:client                                      # 改完必须重建
```

官方提供 `classic` / `chip` / `hologram` / `midnight` 四套主题，脚本默认取
`classic`：`midnight`（exe 内嵌的默认主题）是近黑底，与 Qoder 图标在 20×20 下
难以区分；`chip` 的电路板纹理缩小后退化成噪点；`hologram` 在白底容器里对比度不足。

### e2e 探针

```
pnpm test:e2e:cline        # 只读：凭据/前缀证据/余额/免费集合，零 token 消耗
pnpm test:e2e:cline-chat   # ⚠️ 发一次推理：默认只发 cline-free/deepseek-v4.1-flash
```

⚠️ 推理探针**默认只请求一个免费模型**。其余免费模型需显式设置
`DSH_CLINE_CHAT_E2E_ALL_FREE=1` 才遍历；**付费模型一律被拒绝**（避免免费资格
被撤销后按付费价刷 token）。详见 `tests/e2e/README.md`。

### 排查脚本（只读）

`scripts/probe-cline-endpoints.mjs`（按关键词提取 sidecar 二进制字符串窗口）、
`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
`probe-cline-balance.mjs`、`probe-cline-chat.mjs`。
## Loomy provider（讯飞办公助手）

`loomy` 是本插件第 8 个、也是**与其余七者都不同源**的 provider。生产环境：

| 用途 | base URL |
|---|---|
| 推理 / 模型列表 / 积分 / 新手任务 | `https://loomyad.xunfei.cn/api/v1` |
| 讯飞账号（CAccount） | `https://account.xfinfr.com` |

⚠️ 这两个域名是**生产**地址，不要改用测试环境。

### ⚠️ 五个与其余 provider 不同的地方

1. **登录是短信验证码**（唯一一个）。其余 7 个都是「返回 `loginUrl` →
   前端 `window.open` → 轮询 `login.poll`」；短信登录没有 URL 可打开，
   故 `account.create` 返回 `loginMode: 'sms'`（缺省视为 `'url'`，
   既有 provider 行为不变），前端渲染验证码表单，
   走 `login.sendSms` / `login.submitSms` 两个端点。

2. **不能续期**（唯一一个）。Loomy **没有任何 refresh 端点** ——
   `session` 是登录时向服务端声明 `expire: 1209600`（14 天）得来的。
   故 `isLoomyRefreshable()` 恒 `false`，`refresh()` /
   `refreshAccountCredential()` 只做**有效性探测**（失效即提示重新登录），
   `refreshAll()` 只探测**已过期**的账号。这是**诚实标记**，
   不是遗漏 —— 账号卡片会如实显示「凭证过期，请重新登录」。
   `scheduleRefresh()` / `stop()` 因此是**有意为之的空实现**。

3. **两套认证头**。`/chat/completions` **只认** `Authorization: Bearer <session>`，
   而 `/models`、`/points/*`、`/onboarding/*` **只认** `token: <session>`。
   带错的那个会得到 HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。
   `loomyChatHeaders()` 两个都发（官方客户端也如此）。
   实测交叉矩阵（`pnpm test:e2e:loomy` 会现场验证）：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

4. **新手任务是纯 API 直领**，不需要模拟真实用户行为。
   实测服务端**不校验任何前置行为**：直接对 8 个任务发
   `POST /api/v1/onboarding/tasks/complete`（body 只有 `{"key":...}`）即可拿满
   **10000 积分**，一个模型 token 都不花。
   ⚠️ 这与 WorkBuddy 相反（后者需要发对话、建定时任务、上报埋点事件链）。
   若将来服务端加了校验，降级路径是「用 `qwen3.8-flash`（x0.8，全表最便宜）
   模拟真实动作」。

5. **积分是两个池、分开计算**：
   - **永久积分**（`balance`）：注册奖励 5000 + 新手任务 10000
   - **每日赠送池**（`dailyBalance`）：每天 5000，**消耗后不回补**

   「一键签到」= `POST /api/v1/points/first-login`（官方在登录后立即调用它），
   语义是**触发每日额度重置**，**不是**「+5000 积分」。
   幂等判据是响应体的 `alreadyProcessed`，故已初始化时映射成
   `already-claimed` 而非虚报 `claimed`。
   余额查询走 `GET /api/v1/points/records`（**只读**，无副作用）——
   刻意不用 `first-login`，否则「打开面板」会悄悄触发签到。

### 模型与倍率

远端 `GET /api/v1/models` 返回 11 条，按 `type === 'chat'` 过滤得 **8 条**。
⚠️ 过滤判据必须是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
模型的输入模态含 `image`（能看图），那不是生图模型。

⚠️ **倍率在 `name` 字符串里**，没有独立字段（实测搜 `credit`/`multiplier`/
`price`/`factor`/`rate` 全部 0 命中），且三种括号风格混用，故由
`loomyDisplayName()` 规范化为 `MiniMax M3 · x4.0` 形态。

| 模型 | 倍率 | 上下文 |
|---|---|---|
| `deepseek-v4-flash-0731` | x3.0 | 1048576 |
| `MiniMax-M3` | x4.0 | 1048576 |
| `Kimi-k2.6` | x6.5 | 262144 |
| `qwen-3.8-max` | x12.0 | 1000000 |
| `GLM-5.3-Flash` | x0.8 | 1048576 |
| `qwen3.8-flash` | x0.8 | 1000000 |
| `spark-x` | x0.1 | 1048576 |
| `mimo-v2.5` | x3.3 | 1048576 |

⚠️ **`spark-x` 的上下文有已知分歧**：远端声明 `1048576`，而 Loomy 客户端用
本地表 `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
本插件**先采信远端**；若实测长上下文被拒，改兜底表的该值为 262144。

### 能力矩阵

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

`onboardingTasks` 是**第三项能力位**，与 `dailyCheckin` **语义独立**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

### 多账号负载均衡（按余额优先选号）

⚠️ Loomy **不会因积分耗尽而报错** —— 实测今日赠送额度（每天 5000）用完后，
服务端**继续扣永久积分且照常返回**（静默降级）。因此本插件既有的
「限流 → 自动换号」机制对它**无效**：会一直消耗同一个号。

故 Loomy 有一层**独立的选号策略**（在「未停用 + 该模型未受限」的候选内）：

| 优先级 | 判据 | 理由 |
|---|---|---|
| 1 | `dailyBalance > 0` | 今日额度**每天刷新、不用会浪费**，优先消耗它 |
| 2 | `permanentBalance > 0` | 只剩永久积分（不会过期，可继续用） |
| 3 | 其余（含**查询失败**） | 无可用余额 |

- **同档内保持你在 Jet Hub 拖拽的手动顺序**（不按余额大小重排）
- 余额查询**带 60 秒缓存**，避免每轮对话重复查所有账号
- 查询失败的账号归入**最后一档**（宁可先用能确认余额的号）

### 锁定永久积分

面板上的「锁定永久积分」按钮可**保住永久积分**（设置持久化，重启后仍生效）：

| 状态 | 行为 |
|---|---|
| 解锁（默认） | 今日额度用尽后**继续用永久积分** |
| **锁定** | **只消耗今日额度**；今日额度用尽的账号视为不可用 |

锁定后若所有账号的今日额度都用尽，请求会报**明确错误**提示你解锁或等明日
刷新 —— 而不是偷偷用掉永久积分。

### ⚠️ 为什么 Loomy 没有「重测 / 重置」按钮

那组按钮用于清除**模型限流标记**，而 Loomy **不返回限流错误**（积分耗尽时
静默降级为扣永久积分），重测永远测不出限流、还会白烧积分，故对它隐藏。

### 账号卡片

两个积分池**分开显示**（用户要求）：`永久 15000 · 每日 4992`。
其余 provider 的多个同类资源包仍显示「N/M 个资源包有效」，两种形态互斥。

### e2e 探针

```
pnpm test:e2e:loomy        # 只读：凭据/两套头交叉验证/模型目录/任务/两池余额，零消耗
pnpm test:e2e:loomy-chat   # ⚠️ 发一次推理：默认 qwen3.8-flash（x0.8，最便宜）
```

⚠️ 对话探针的闸门是 `DSH_LOOMY_CHAT_E2E=1` **且**
`DSH_LOOMY_CHAT_E2E_CONFIRM=yes`，`max_tokens` 压到 16（单次约 1 积分）。

---

## Raccoon Work provider（商汤小浣熊）

`raccoon` 是本插件第 9 个 provider。生产环境：

### ⚠️ 与其余 provider 不同的地方

1. **登录：微信扫码 + 短信双路径，由本地页承载**（与 Loomy 同型）。

2. **短信登录需要阿里云滑块验证码**。手机号必须 **AES-128-CFB** 加密

3. **每日 300 积分没有端点**。实测「每日积分发放」是**服务端按日自动发放**的
   （账单 `biz_type: 'daily_grant'`，该账号 13:30 注册、13:31 即到账），
   **不存在可调用的签到接口**。故能力矩阵**不登记 `dailyCheckin`** ——
   登记了会让按钮每次点击都必然失败（与 CodeArts 早期「对不支持的 provider
   无条件发请求」是同一类缺陷）。

4. **一次性登录奖励是独立来源**：`POST /api/web/desktop/v1/login/points/grant`
   给 3000 分，**幂等一次性**（已领过返回 `granted:false`，
   且账单里能看到上一次记录）。语义与 Loomy 的新手任务同构，
   故登记为 `onboardingTasks`，复用同一套 `onboarding.status` / `onboarding.claim`
   端点与 UI。⚠️ 该端点**需要** `X-Client-Platform` 头
   （`desktop-windows` / `desktop-macos` / `desktop-linux`），猜错会被拒。

5. **`Raccoon-Auto` 不暴露**。它是客户端 i18n 条目（`modelPicker.auto`）渲染的
   **「自动选模」入口**，倍率写死为 `1 倍`，**不在远端 `model_catalog` 里** ——
   直接发给 `chat/completions` 会 404。其语义（按消息内容正则打标后从候选池
   选模型）与 DSH「模型选择是会话级固定」的模型相冲，且选出的模型不可预测、
   难排查。用户可直接选 `sn-deepseek-v4-1-flash`（`ability_level: 3`、
   带 `auto` 标签，即自动选模在复杂任务下最可能选中的那个）。

### 模型目录（6 个 `visible:true`）

倍率取 `billing_effective_multiplier`（**当前生效价**，已含促销），
展示为 ` · x倍率` / ` · 免费` / ` · x原价→x折后价`：

| 模型 | 原价 | 生效价 | 展示 |
|---|---|---|---|
| `sn-sensenova-6-8-flash` | 0.5 | **0** | `SenseNova-6.8-Flash · 免费` |
| `sn-sensenova-6-8-flash-lite` | 0.5 | **0** | `SenseNova-6.8-Flash-Lite · 免费` |
| `sn-glm-5-3` | 0.75 | 0.75 | `GLM-5-3 · x0.75` |
| `sn-kimi-k3` | 1 | 1 | `Kimi-K3 · x1` |
| `sn-glm-5-3-flash` | 0.2 | **0.1** | `GLM-5-3-Flash · x0.2→x0.1` |
| `sn-deepseek-v4-1-flash` | 0.25 | 0.25 | `DeepSeek-V4.1-Flash · x0.25` |

另有 3 个 `visible:false` 的 `raccoon-*` 内部模型（自动选模的候选池），
**不在模型选择器中暴露**。

### ⚠️ 零客户端依赖（硬约束）

本 provider **运行时完全不读客户端数据** —— 不读
`%APPDATA%\office-raccoon\Local Storage\leveldb`、不读
`~/.box-agent/config/auth.json`、不解客户端 sqlite/leveldb。

### 能力矩阵

```js
raccoon: { balance: true, onboardingTasks: true }
```

⚠️ **没有 `dailyCheckin`**，理由见上文第 3 条。

### e2e 探针

```
pnpm test:e2e:raccoon        # 只读：凭据/模型目录/倍率/积分余额/账单，零消耗
pnpm test:e2e:raccoon-chat   # ⚠️ 发推理：验证标准 OpenAI SSE 与 reasoning_content
pnpm test:e2e:raccoon-tools  # ⚠️ 发推理：验证 **tools 被端点接受**（返回结构化 tool_calls）
```

⚠️ 后两个的闸门是 `DSH_RACCOON_{CHAT,TOOLS}_E2E=1` **且**
`..._CONFIRM=yes`，`max_tokens` 压到 64–256（单次消耗很小）。

⚠️ **`raccoon-tools` 的判据是「响应里有结构化 `tool_calls`」**，
不是「模型在正文里说它想调用工具」—— 后者正是 Qoder / TRAE 踩过的缺陷形态
（插件没把 `tools` 发出去，模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。
