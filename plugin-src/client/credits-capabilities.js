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
 * | `workbuddy` | ✓                   | ✗ 国际版后端无签到接口        |
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
 *   （**仅 CodeBuddy 中国版**有；WorkBuddy 国际版内核里只有
 *   `get-dosage-notify` 用量通知）；LobsterAI 用 `client-activities` 的
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
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Qoder：余额（`sash/api/v2/me/usage`）+ 每日领取
  // （`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`，
  // 2026-09-21 由 keylog 解密抓包解出）。
  // 显式登记而非省略 —— 单测要求本表与 PROVIDERS 同步。
  qoder: Object.freeze({ balance: true, dailyCheckin: true }),
  // TRAE：余额与签到都有（`/trae/api/v2/pay/ide_user_ent_usage` +
  // `checkin_credits/status` → `checkin_credits/claim`，见 `src/trae-credits.ts`）。
  trae: Object.freeze({ balance: true, dailyCheckin: true }),
  // Cline：**只有余额**，没有签到。
  //
  // 余额：`GET /api/v1/users/{accountId}/balance`
  // （实测 `{data:{userId, balance:500000}, success:true}`，见 `src/cline-credits.ts`）。
  //
  // ⚠️ `dailyCheckin: false` 的依据是**对整个 sidecar 二进制做字符串扫描**：
  // `checkin` / `check-in` / `daily` / `campaign` 均无任何 Cline 业务端点命中
  // （`campaign` 的命中是 PostHog 的 UTM 参数与 feature-flag 事件属性；
  // `daily` 是 YAML cron 别名与 Blob 导出频率枚举）。
  // 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来 Cline 增加
  // 签到，需按 Qoder 那次教训重新采集（见 AGENTS.md 的对应章节）。
  cline: Object.freeze({ balance: true, dailyCheckin: false }),
  // Loomy（讯飞）：三项能力齐全，且是**唯一**有第三项（新手任务）的渠道。
  //
  // 余额：`GET /api/v1/points/records`（**只读**）—— 刻意不用 `first-login`，
  //   那是写端点，在面板挂载这种高频路径上调用会意外触发签到。
  // 每日签到：`POST /api/v1/points/first-login`。⚠️ 语义是「触发每日赠送额度」
  //   而不是「+5000 积分」：实测 `dailyBalance = dailyQuota - dailyConsumed`
  //   （4992 = 5000 - 8），消耗后不回补。
  // 新手任务：`GET/POST /api/v1/onboarding/tasks*`，8 个任务合计 **10000 分**，
  //   **一次性**（每号只能领一次），故必须与每日签到分开成一个独立按钮 ——
  //   混进「一键签到」会导致每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
  loomy: Object.freeze({ balance: true, dailyCheckin: true, onboardingTasks: true }),
  // Raccoon Work（商汤小浣熊）：余额 + **一次性**登录奖励。
  //
  // 余额：`GET /api/web/points/v1/balance`（**只读**，实测返回
  //   `{available_points, daily_points, reward_points, topup_points}`）。
  //
  // ⚠️ **不登记 `dailyCheckin`，且这不是遗漏** —— 实测「每日 300 积分」是
  //   **服务端按日自动发放**的（账单里 `biz_type: 'daily_grant'`，
  //   该账号 13:30 注册、13:31 即到账），**没有可调用的签到端点**。
  //   把它实现成签到按钮会让用户每次点击都必然失败 ——
  //   与 CodeArts 早期「对不支持的 provider 无条件发请求」是同一类缺陷。
  //
  // 登录奖励：`POST /api/web/desktop/v1/login/points/grant`，3000 分，
  //   **幂等一次性**（已领过返回 `granted:false` 且账单里能看到上一次记录）。
  //   语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
  //   `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
  //   ⚠️ 该端点**需要** `X-Client-Platform` 头（值见 RaccoonProduct.clientPlatform）。
  raccoon: Object.freeze({ balance: true, onboardingTasks: true }),
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
