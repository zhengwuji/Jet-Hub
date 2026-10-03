/**
 * 各 provider 的积分能力矩阵 —— Jet Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧积分端点对**三套互不相同的协议**分派（见 `src/jet-hub-rpc.ts`）：
 * CodeBuddy 系经 `productById(provider)` 取产品配置，LobsterAI 与 CodeArts
 * 各自提前分支。未登记的 provider 仍会落到 `bad-request`，因此客户端必须
 * 在发请求之前按本表门控 —— 历史缺陷正是「对不支持的 provider 无条件发请求」：
 * 早期 CodeArts 两项能力皆无，客户端却在面板挂载时对所有 provider 调用
 * `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[jet-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy' || provider === 'workbuddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider    | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-------------|---------------------|------------------------------|
 * | `codearts`  | ✓ 华为签名          | ✓ 华为签名                   |
 * | `buddy`     | ✓                   | ✓                            |
 * | `workbuddy` | ✓                   | ✗ 签到活动未开启（活动位本区域不下发） |
 * | `lobsterai` | ✓                   | ✓ `client-activities` 三步流程 |
 * | `qoder`     | ✓ `sash/api/v2/me/usage` | ✗ 未见签到接口            |
 * | `trae`      | ✓                   | ✓ `checkin_credits/*`        |
 * | `cline`     | ✓ `/api/v1/users/{id}/balance` | ✗ 后端无签到接口  |
 *
 * - `balance`：CodeBuddy 系用 `POST /v2/billing/meter/get-user-resource`
 *   （CodeBuddy 与 WorkBuddy 国际版**通用**，仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 用 `GET /api/user/profile-summary`；CodeArts 用
 *   `GET /snap-manager/v1/statistics/plugin`（与账户类型检测同一响应）；
 *   Qoder 用 `GET /sash/api/v2/me/usage`（见 `src/qoder-credits.ts`）。
 *   见 README「积分余额」。
 * - `dailyCheckin`：CodeBuddy 系用 `checkin-activity-status` + `daily-checkin`
 *   （**国内系**均有：`buddy` / `buddy-intl` / `workbuddy-cn`；`workbuddy`
 *   国际版端点也在，但该区域的活动位不下发 ⇒ `active:false`，故登记 false）；
 *   LobsterAI 用 `client-activities` 的
 *   slot → context → check_in 三步（见 `src/lobsterai-credits.ts`）；
 *   CodeArts 用 `/v1/ops/delivery` + `/v1/ops/claim`(+`confirm`)
 *   （见 `src/codearts-credits.ts`）；Qoder 用
 *   `/sash/api/v1/me/campaigns` 列出活动再逐个
 *   `POST …/{campaignId}/claim`（见 `src/qoder-credits.ts`）。
 * - `qoder` **两项都有**。⚠️ 早期误判为「两项皆无」，原因有二：
 *   ① 只按 `/api/` 前缀搜索端点，而它挂在 **`/sash/`** 下、且只需
 *   Bearer + `Cosy-ClientType`（不需要 WASM 签名，实测返回
 *   `addOnQuota.remaining: 100`）；
 *   ② 随后又误判「无签到」—— 依据是 `/sash/api/v1/me/campaigns` 返回
 *   `claimable:false, campaigns:[]`，但那是**当天已领**的正常表现
 *   （活动每日 10:00（UTC+8）刷新）。2026-09-21 用 keylog 解密抓包
 *   拿到了领取端点与幂等证据（`replayed:true`）。
 *   **教训**：「某次实测没看到」不能推广成「不存在」。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 */

/** 单个 provider 的积分能力。 */
export const CREDITS_CAPABILITIES = Object.freeze({
  codearts: Object.freeze({ balance: true, dailyCheckin: true }),
  buddy: Object.freeze({ balance: true, dailyCheckin: true }),
  // CodeBuddy 国际版：与国内版同一套积分协议，仅端点不同（www.codebuddy.ai）。
  'buddy-intl': Object.freeze({ balance: true, dailyCheckin: true }),
  // WorkBuddy 国际版（www.workbuddy.ai）：**端点存在但活动位不下发**。
  // 2026-10-01 用真实凭据实测：该区域 `checkin-activity-status` 返回
  // `active:false` / `total_credits:0` / `start_time:""`，`daily-checkin`
  // 返回 `code 10001`「**签到活动未开启或已过期**」。
  // ⚠️ 这里登记 false 是**结果正确、理由须改**：旧注释称「后端无签到接口」，
  // 实测证伪（对照组探针：候选路径 401 vs 随机路径 404，端点确实存在）。
  // 且 `code 10001` 在两个区域**语义不同** —— 国内系是「今天已签到，请明天
  // 再来」，国际版是「活动未开启」，故不能只看 code 就断定已签到。
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  // WorkBuddy 国内版（copilot.tencent.com）：**有真实可用的每日签到**。
  // 2026-10-01 用池里两个真实账号实测：`checkin-activity-status` 返回
  // `active:true today_checked_in:true streak_days:2 daily_credit:100
  // total_credits:200`（连续 2 天、每日 100 积分）；`daily-checkin`
  // 重放返回 `code 10001`「今天已签到，请明天再来」（与 src/credits.ts:57
  // 的 CODE_ALREADY_CLAIMED 一致，余额不变）。
  // 旧登记 false 是**缺陷**：该区域自 2026-09-30 起有「Buddy加油站」活动
  // （season 10），用户实际损失了每日 100 积分的领取入口。
  'workbuddy-cn': Object.freeze({ balance: true, dailyCheckin: true }),
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder：余额（`sash/api/v2/me/usage`）+ 每日领取
  // （`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`，
  // 2026-09-21 由 keylog 解密抓包解出）。
  // 显式登记而非省略 —— 单测要求本表与 PROVIDERS 同步。
  qoder: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder 国内版（Qoder CN）：与上面同一套积分协议，只是端点不同
  // （openapi.qoder.com.cn / gateway.qoder.com.cn）。登录态独立，故单列。
  'qoder-cn': Object.freeze({ balance: true, dailyCheckin: true }),
  // TRAE：余额与签到都有（`/trae/api/v2/pay/ide_user_ent_usage` +
  // `checkin_credits/status` → `checkin_credits/claim`，见 `src/trae-credits.ts`）。
  trae: Object.freeze({ balance: true, dailyCheckin: true }),
  // TRAE 国际版：同一套签到协议，端点走 trae.ai 系。
  'trae-intl': Object.freeze({ balance: true, dailyCheckin: true }),
  // Cline：**只有余额**，没有签到。
  cline: Object.freeze({ balance: true, dailyCheckin: false }),
  // Loomy（讯飞）：三项能力齐全，且是**唯一**有第三项（新手任务）的渠道。
  loomy: Object.freeze({ balance: true, dailyCheckin: true, onboardingTasks: true }),
  // Raccoon Work（商汤小浣熊）：余额 + **一次性**登录奖励。
  raccoon: Object.freeze({ balance: true, onboardingTasks: true }),
  // ZCode（智谱 / Z.AI 编码代理客户端）：**只有余额**（套餐额度）。
  //
  // ⚠️ 没有每日签到，也**不登记** `onboardingTasks`：ZCode 的运营玩法是
  // 「限时套餐领取」，而那条链**每条请求都要一枚阿里云验证码令牌**，令牌只能由
  // 桌面端 WebView 铸造（阿里云侧有铸造风控，Node 侧无 DOM 铸不出来）。
  // 本插件是宿主侧 Node 进程，做不到，故如实登记为不支持 ——
  // 与 AGENTS.md「不支持的 provider 必须如实返回 null 状态，不得臆造」同一取舍。
  // 面板因此不会渲染「一键领取积分」按钮，也不会发起必然失败的请求。
  zcode: Object.freeze({ balance: true, dailyCheckin: false }),
  // ZCode 国际版（Z.AI）：同一套协议、同一份实现，只是推理平面不同。
  'zcode-intl': Object.freeze({ balance: true, dailyCheckin: false }),
  // AutoClaw（智谱 autoglm）国内/国际两版：**余额 + 每日签到**都有。
  // 签到走 `POST /autoclaw-proxy/proxy/autoclaw-task-complete` body
  // `{task_id:'daily_signin'}`；幂等判据是**响应体字段**
  //（`already_completed === true` 一律算「今天已签到」），
  // 重复领取同样返回 HTTP 200 + `success:false` —— **不能只看状态码**。
  autoclaw: Object.freeze({ balance: true, dailyCheckin: true }),
  'autoclaw-intl': Object.freeze({ balance: true, dailyCheckin: true }),
  // Accio（阿里 Accio Work）国际/国内两版：**只有余额**（`/api/entitlement/quota`
  // 的用量百分比），**没有签到** —— 上游全包检索无「签到 / checkin」活动。
  accio: Object.freeze({ balance: true, dailyCheckin: false }),
  'accio-cn': Object.freeze({ balance: true, dailyCheckin: false }),
  // CatPaw（美团）：**只有余额**（`GET https://catx.nocode.cn/api/gateway/credit/balance`，
  // 该端点只认 `X-Auth-Token` 头 —— `X-Passport-Token` / `Cookie` / `Authorization`
  // 全部 401）。上游**没有**每日签到活动。
  catpaw: Object.freeze({ balance: true, dailyCheckin: false }),
  // 「粘贴 API Key」族（Command Code / OpenCode Zen）：**两项都没有**，
  // 且是刻意的负能力登记。
  //
  // 与其它 provider 的根本差异：本族的额度由**用户自己接的那个平台**决定，
  // 本插件既没有该平台的账号体系，也不知道其计费口径 —— 两家都只提供
  // 「余额/额度不足」的错误码，没有任何查询端点（实测：`/usage`、`/credits`、
  // `/balance` 全部 404）。若在这里猜一个端点，只会得到「每次打开面板都发
  // 一个必然失败的请求」。
  //
  // ⚠️ 一个 provider 一行，**必须与 `jet-hub.js` 的 `KEYED_PROVIDER_IDS`
  // 及 `src/keyed-product.ts` 的 `ALL_KEYED_PRODUCTS` 等集**（由
  // `tests/unit/plugin.spec.ts` 与 `scripts/lint.mjs` 双向锁死）。
  commandcode: Object.freeze({ balance: false, dailyCheckin: false }),
  'opencode-zen': Object.freeze({ balance: false, dailyCheckin: false }),
});

/**
 * 各 provider 是否具备「**模型限流**」这一机制（即服务端会因限流而拒绝请求）。
 *
 * ## 为什么需要它（真实发现）
 *
 * Loomy **不会返回限流错误**：实测今日赠送额度（每天 5000）用完后，服务端
 * 继续扣永久积分且照常返回（静默降级）。因此「重测 / 重置」这组按钮对它
 * **毫无意义** —— 重测永远测不出限流，重置也没有标记可清。
 * 用户报障：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。
 *
 * ## 为什么「未登记 = 视为有限流」（与上面的积分能力约定**相反**）
 *
 * 积分能力的约定是「默认关闭」（未登记就不发请求，避免必然失败的请求）。
 * 但限流按钮**是既有 UI**：若这里也默认关闭，将来新增 provider 时忘记登记，
 * 会让老用户**凭空失去**「重测 / 重置」按钮 —— 那是可见的功能回退。
 * 故这里默认**开启**，只有明确知道「该渠道不会限流」时才显式登记 `false`。
 */
export const RATE_LIMIT_CAPABILITIES = Object.freeze({
  // Loomy（讯飞）：**不返回限流错误** —— 积分耗尽时静默降级为扣永久积分，
  // 故「重测 / 重置」这组按钮对它无意义（重测还会白烧积分）。
  loomy: Object.freeze({ rateLimit: false }),
  // CatPaw（美团）：上游**没有任何 429 判定**（原项目全仓 grep 429 零命中），
  // 也没有多账号轮换或可解析的限额码 —— 「重测 / 重置」按钮同样无意义。
  catpaw: Object.freeze({ rateLimit: false }),
});

/**
 * 该 provider 的请求是否会因**模型限流**被拒（决定是否渲染「重测 / 重置」）。
 *
 * ⚠️ 默认 `true`（未登记即视为有限流），理由见 {@link RATE_LIMIT_CAPABILITIES}。
 */
export function supportsRateLimit(provider) {
  return RATE_LIMIT_CAPABILITIES[provider]?.rateLimit !== false;
}

/**
 * 该 provider 是否支持「锁定永久积分」（只允许消耗每日赠送额度）。
 *
 * ⚠️ 目前只有 Loomy 具备：它有两个独立的积分池（永久 / 每日赠送），
 * 而其他渠道的积分模型不同（无「永久 vs 每日」的区分）。
 *
 * 为 false 时面板**不得**渲染该按钮，也不得发起 `loomy.permanentLock`。
 */
export function supportsPermanentLock(provider) {
  return provider === 'loomy';
}

/**
 * 该 provider 是否能查询积分余额。
 *
 * 为 false 时调用方**不得**发起 `credits.balances`，也不应渲染账号卡片的
 * 「积分」行与面板的「刷新积分」按钮 —— 否则卡片会永远停在「查询失败」。
 */
export function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}

/**
 * 该 provider 是否能执行每日签到领取（一键领取积分）。
 *
 * 为 false 时面板不渲染该按钮（WorkBuddy 国际版后端无接口）。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}

/**
 * 全部**支持每日签到**的渠道 id 列表，顺序固定（= 本表声明顺序）。
 *
 * 供 Jet Hub 页头的「一键签到」遍历使用。
 *
 * ⚠️ **必须从本表推导，不要另写一份渠道字面量**：
 * 本表已是能力判定的唯一真相源，且 `credits-capabilities.spec.ts` 守着它与
 * `PROVIDERS` 同步。硬编码 `['codearts','buddy',…]` 会在将来某渠道开放或
 * 下线签到时**静默漂移** —— 表现为「新渠道永远不被签到」或
 * 「对已下线渠道发必然失败的请求」（后者正是 CodeArts 历史缺陷的形态）。
 *
 * 顺序即执行顺序（调用方串行执行），故它同时决定了请求的先后；
 * 保持本表声明顺序即可，不额外排序。
 */
export function checkinProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsDailyCheckin);
}

/**
 * 该 provider 是否支持「新手任务」一次性领取。
 *
 * ⚠️ 与 {@link supportsDailyCheckin} **语义独立，不能互相推断**：
 * - `dailyCheckin`：**每天**有收益（每日额度刷新）
 * - `onboardingTasks`：**一次性**（每号只能领一次固定总额）
 *
 * 目前只有 Loomy 具备后者。为 false 时面板**不得**渲染「领取新手任务」按钮，
 * 也不得发起 `onboarding.status` / `onboarding.claim`。
 */
export function supportsOnboardingTasks(provider) {
  return CREDITS_CAPABILITIES[provider]?.onboardingTasks === true;
}

/**
 * 全部**支持新手任务**的渠道 id 列表。
 *
 * 供「一键领取全部渠道新手任务」之类的批量入口使用（当前未实现，
 * 保留以便扩展）。**必须从能力表推导**，理由同 {@link checkinProviders}。
 */
export function onboardingTaskProviders() {
  return Object.keys(CREDITS_CAPABILITIES).filter(supportsOnboardingTasks);
}
