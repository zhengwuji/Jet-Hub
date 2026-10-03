/**
 * **不变量：客户端列出的每个 provider 都能被「刷新」按钮分派到自己的服务。**
 *
 * 为什么需要这条派生式断言：`account.refresh` 的 switch 每加一个 provider 就多一条
 * 分支，而漏掉的那条**不会**让任何既有测试变红 —— 它只在用户点账号卡片上的「刷新」
 * 时炸出 `Unknown provider: xxx`。历史上已经踩过两次：
 *
 * 1. `workbuddy` 分支缺失（原实现只判 codearts / buddy）；
 * 2. `buddy-intl` / `workbuddy-cn` 分支缺失（`CODEBUDDY_INTL.id` / `WORKBUDDY_CN.id`）；
 * 3. `byok` 分支缺失（加 BYOK provider 时漏了 `account.refresh` 的 switch ——
 *    它没有真正意义上的「续期」，但**仍然必须**有一条分支走有效性探测，
 *    否则账号卡片的「刷新」按钮会抛 `Unknown provider: byok`）。
 *
 * 本文件不再逐个 `it(...)` 手抄 provider 名，而是：
 * - 从 `plugin-src/client/jet-hub.js` 的 PROVIDERS 列表**派生** id 集合（唯一真相源）；
 * - 对每个 id 走一次真实的 `account.refresh` 往返，断言 `success === true` 且
 *   服务替身收到的 credentialRef 就是该账号自己的 ref（不是默认单凭据 ref）。
 *
 * 于是「新增 provider 但忘了加 refresh 分支」会立刻在这里失败，而不是等用户报障。
 *
 * ## 「粘贴 Key」族（commandcode / opencode）的特殊处理
 *
 * 它们的「刷新」语义是**有效性探测**（打一次平台 chat 端点），且服务不是具名
 * 字段而是一张 `keyed` Map（见 `JetHubRpcServices`）。故它们在
 * `RPC_SERVICE_FIELD` 之外单独登记，替身按 provider id 建、塞进同一张 Map。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { registerJetHubRpc, type JetHubRpcServices } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

/** 采集到的「某服务被要求刷新的 credentialRef」。 */
interface RefreshCall {
  service: string
  credentialRef: string
}

/**
 * provider id → `JetHubRpcServices` 的**具名字段**（P1-⑤ 起不再是位置参数）。
 *
 * 位置参数时代这里是一份「顺序数组」：顺序错位不会报错，只会把请求发给错误的
 * 服务，而且新增 provider 时漏改一处测试就会静默错位。现在字段名即身份 ——
 * 少接 / 接错字段是**编译错误**，故本表只用于「按 provider id 构造替身」，不再
 * 承载任何位置契约；「服务名 ↔ provider id」的对应改由下面的面板交叉校验与
 * 「刷的是自己的 credentialRef」断言反向验证。
 *
 * ⚠️ 只收**一对一具名字段**的 provider。`keyed` Map 里的 provider 见
 * `KEYED_PROVIDER_IDS`（多个 provider 共用一个字段，放进本表会破坏下面的
 * 「字段不重复」断言）。
 */
const RPC_SERVICE_FIELD: Record<string, keyof JetHubRpcServices> = {
  codearts: 'codearts',
  buddy: 'buddy',
  'buddy-intl': 'buddyIntl',
  workbuddy: 'workbuddy',
  'workbuddy-cn': 'workbuddyCn',
  lobsterai: 'lobsterai',
  qoder: 'qoder',
  'qoder-cn': 'qoderCn',
  trae: 'trae',
  'trae-intl': 'traeIntl',
  cline: 'cline',
  loomy: 'loomy',
  raccoon: 'raccoon',
  // ZCode 两个地区：**没有** refresh 端点（上游不提供），但账号卡片的
  // 「刷新」仍必须有一条分支 —— 语义是**有效性探测 + 如实报错**，
  // 否则会抛 `Unknown provider: zcode`（与 byok 那次同一形态的缺陷）。
  zcode: 'zcode',
  'zcode-intl': 'zcodeIntl',
  // AutoClaw 两个地区：有 refresh_token 轮换（`400002` 时降级重试）。
  autoclaw: 'autoclaw',
  'autoclaw-intl': 'autoclawIntl',
  // Accio 两个地区：有 refresh_token 轮换（401 后走 force=true 强制续期）。
  accio: 'accio',
  'accio-cn': 'accioCn',
  // CatPaw（美团）：**没有 refreshToken、没有续期端点**，但账号卡片的
  // 「刷新」仍必须有一条分支（语义是有效性探测 + 如实报错）。
  catpaw: 'catpaw',
}

/** 从客户端源码派生 provider id 集合（与面板列表同一真相源）。 */
function panelProviderIds(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
  const ids = [...clientSource.matchAll(/\{\s*id:\s*'([a-z][a-z0-9-]*)',\s*label:/g)].map((m) => m[1]!)
  if (ids.length === 0) {
    throw new Error('未能从 plugin-src/client/jet-hub.js 解析出任何 provider id（正则或文件结构已变）')
  }
  return ids
}

/**
 * 「粘贴 Key」族的 provider id（共用 `JetHubRpcServices.keyed` 这一张 Map）。
 *
 * ⚠️ 这份名单的真相源在 `src/keyed-product.ts` 的 `ALL_KEYED_PRODUCTS`。
 * 这里手抄是为了让本不变量**不依赖服务端实现** —— 若从服务端表派生，
 * 服务端漏掉一个平台时测试会跟着漏，这条断言就形同虚设。
 * 两者的一致性由 `plugin.spec.ts` 的面板等集断言与
 * `scripts/lint.mjs` 的 `provider-panel-parity` 双向守住。
 */
const KEYED_PROVIDER_IDS: readonly string[] = ['commandcode', 'opencode-zen']

/** 构造只记录调用的服务替身。 */
function makeServiceStub(name: string, calls: RefreshCall[]) {
  return {
    refreshAccountCredential: vi.fn(async (ref: string) => { calls.push({ service: name, credentialRef: ref }) }),
    refresh: vi.fn(async () => { calls.push({ service: `${name}.refresh(default)`, credentialRef: '' }) }),
  }
}

/** 构造账号池替身。 */
function makePool(accounts: ProviderAccountEntry[]) {
  return {
    listAllAccounts: async () => accounts,
    listAccounts: async (provider: string) => accounts.filter((a) => a.provider === provider),
    updateAccount: async () => {},
  }
}

function entry(provider: string, credentialRef: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    nickname: '测试号',
    enabled: true,
    credentialRef,
    createdAt: 1,
    refreshable: true,
  }
}

/** 驱动一次 `account.refresh` RPC，返回服务调用记录与结果载荷。 */
async function callRefresh(
  accounts: ProviderAccountEntry[],
  accountId: string,
): Promise<{ calls: RefreshCall[]; value: { success: boolean; error?: string } }> {
  const calls: RefreshCall[] = []
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx = {
    connection: {
      fetch: {
        register: (options: { fetch: (request: Request) => Promise<Response> }) => { handler = options.fetch },
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ configured: false }),
    },
    get: () => undefined,
    // `connection` 由生产代码惰性注入（见 jet-hub-rpc.ts 头注释），替身须复刻。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
  }

  // ⚠️ 具名对象：字段名即身份（P1-⑤ 之前是「第 N 个位置实参」，接错位不报错）。
  registerJetHubRpc(ctx as never, {
    pool: makePool(accounts) as never,
    codearts: makeServiceStub('codearts', calls) as never,
    buddy: makeServiceStub('buddy', calls) as never,
    buddyIntl: makeServiceStub('buddy-intl', calls) as never,
    workbuddy: makeServiceStub('workbuddy', calls) as never,
    workbuddyCn: makeServiceStub('workbuddy-cn', calls) as never,
    lobsterai: makeServiceStub('lobsterai', calls) as never,
    qoder: makeServiceStub('qoder', calls) as never,
    qoderCn: makeServiceStub('qoder-cn', calls) as never,
    trae: makeServiceStub('trae', calls) as never,
    traeIntl: makeServiceStub('trae-intl', calls) as never,
    cline: makeServiceStub('cline', calls) as never,
    loomy: makeServiceStub('loomy', calls) as never,
    raccoon: makeServiceStub('raccoon', calls) as never,
    zcode: makeServiceStub('zcode', calls) as never,
    zcodeIntl: makeServiceStub('zcode-intl', calls) as never,
    autoclaw: makeServiceStub('autoclaw', calls) as never,
    autoclawIntl: makeServiceStub('autoclaw-intl', calls) as never,
    accio: makeServiceStub('accio', calls) as never,
    accioCn: makeServiceStub('accio-cn', calls) as never,
    catpaw: makeServiceStub('catpaw', calls) as never,
    // 「粘贴 Key」族（commandcode / opencode）：它们**没有** refresh 端点，
    // 这个替身的 `refreshAccountCredential` 语义是**有效性探测**（打一次平台
    // chat 端点），但对外仍是同一个入口 —— 故它们同样必须出现在这张 Map 里，
    // 否则「刷新」按钮会抛 `Unknown provider: commandcode`。
    //
    // ⚠️ 用 Map 而不是具名字段：本族会继续增加平台，具名字段会让每加一个平台
    // 都要改 `JetHubRpcServices` 接口（历史上「漏改一处就出空壳面板」的成因）。
    keyed: new Map(KEYED_PROVIDER_IDS.map(id => [id, makeServiceStub(id, calls) as never])),
  })
  const response = await handler!(new Request('http://127.0.0.1/api/jet-hub', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: 'jet-hub',
      payload: { method: 'account.refresh', payload: { accountId } },
    }),
  }))
  const body = await response.json() as {
    result: { ok: boolean; value?: { success: boolean; error?: string } }
  }
  return { calls, value: body.result.value! }
}

describe('account.refresh 分派不变量（每个面板 provider 都必须可刷新）', () => {
  it('客户端列出的每个 provider 都有 refresh 分支，且刷的是自己的 credentialRef', async () => {
    const ids = panelProviderIds()
    expect(ids.length).toBeGreaterThan(0)

    for (const provider of ids) {
      const ref = `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_1`
      const { calls, value } = await callRefresh([entry(provider, ref)], `${provider}-1`)

      expect(value.success, `${provider}: ${value.error ?? ''}`).toBe(true)
      expect(value.error, provider).toBeUndefined()
      // 必须落到「与 provider 同名」的服务，而不是别的位置参数：
      // 位置错位时会记录成另一个服务名。
      expect(calls, provider).toEqual([{ service: provider, credentialRef: ref }])
      // 绝不能退化成刷默认单凭据 ref（BUDDY_ACCESS_TOKEN 那一类）。
      expect(calls.some((c) => c.service.includes('refresh(default)')), provider).toBe(false)
    }
  })

  it('未知 provider 仍然报错（不静默成功）', async () => {
    const { value } = await callRefresh([entry('mystery', 'MYSTERY_ACCOUNT_1')], 'mystery-1')
    expect(value.success).toBe(false)
    expect(value.error).toMatch(/Unknown provider/)
  })

  it('每个具名字段都有对应的面板 provider（服务名 ↔ provider id 同名）', async () => {
    // 本用例的意义：上面那条断言依赖替身的服务名与真实字段一一对应。
    // P1-⑤ 之前这里锁的是「位置参数顺序必须与 src/index.ts 的调用点一致」——
    // 顺序漂移（例如新增 provider 插在中间）只会静默把请求发给错误的服务；
    // 现在字段名即身份，少接 / 接错字段是编译错误，故只需守住
    // 「面板列出的每个 id 都有替身，且没有两个 provider 共用同一个字段」。
    const ids = panelProviderIds()
    for (const [provider, field] of Object.entries(RPC_SERVICE_FIELD)) {
      expect(ids, `具名字段 ${field}（provider ${provider}）在客户端面板列表里找不到对应 provider`).toContain(provider)
    }
    const fields = Object.values(RPC_SERVICE_FIELD)
    expect(new Set(fields).size, 'RPC_SERVICE_FIELD 里有重复的具名字段').toBe(fields.length)
  })

  it('「粘贴 Key」族的 provider 都在面板里（否则空壳面板）', () => {
    // 反向断言：本族共用一个 Map 字段，故上面的「逐字段对面板」循环覆盖不到它们。
    // 漏了这条的话，服务端加了 `opencode` 而客户端面板没加，用户就完全看不到它，
    // 而所有既有用例仍然是绿的。
    const ids = panelProviderIds()
    for (const provider of KEYED_PROVIDER_IDS) {
      expect(ids, `「粘贴 Key」族的 ${provider} 在客户端面板列表里找不到`).toContain(provider)
    }
  })
})
