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
});

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
