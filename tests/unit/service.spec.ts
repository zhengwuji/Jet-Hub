import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLoginFlow, runOAuthFlow } from '../../src/login.js'
import { RefreshTokenExpiredError, exchangeRefreshToken, generateDpopKeyPair } from '../../src/oauth.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from '../../src/service.js'

vi.mock('../../src/login.js', () => ({
  runLoginFlow: vi.fn(),
  runOAuthFlow: vi.fn(),
}))

vi.mock('../../src/oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/oauth.js')>()
  return {
    ...actual,
    // 默认仍走真实实现；仅「refresh_token 失效」用例临时改为抛 RefreshTokenExpiredError。
    exchangeRefreshToken: vi.fn(actual.exchangeRefreshToken),
  }
})

const mockedRunLoginFlow = vi.mocked(runLoginFlow)
const mockedRunOAuthFlow = vi.mocked(runOAuthFlow)
const mockedExchangeRefreshToken = vi.mocked(exchangeRefreshToken)

/** 所有已创建的 service；afterEach 统一 stop()。 */
const services: CodeArtsAuth[] = []

/** 最小化的内存凭据提供者，形状与 ctx.credentials 一致。 */
class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) {
    return { configured: this.store.has(ref), source: this.store.has(ref) ? 'fake' : undefined, writable: true }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

function makeContext(): { ctx: Context; credentials: FakeCredentials } {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  return { ctx, credentials }
}

/** 新建并登记一个 service，保证 afterEach 能 stop() 掉它。 */
function newService(ctx: Context, options: { fetcher?: typeof fetch } = {}): CodeArtsAuth {
  const service = new CodeArtsAuth(ctx, options)
  services.push(service)
  return service
}

/**
 * 账号池替身：只实现 service 用到的两个方法
 * （`listAccountsByProvider` 给 refreshModels 取凭据、`listAccounts` 给 refreshAll）。
 */
function makePool(entries: Array<{ id: string; credentialRef: string; refreshable?: boolean }>) {
  const accounts = entries.map(e => ({
    id: e.id,
    provider: 'codearts',
    nickname: e.id,
    enabled: true,
    credentialRef: e.credentialRef,
    createdAt: 0,
    refreshable: e.refreshable ?? true,
  }))
  return {
    listAccountsByProvider: () => accounts,
    listAccounts: async () => accounts,
    updateAccount: vi.fn(async () => {}),
  } as never
}

/** 永不打真实网络的 stub fetch：即使定时器意外触发，刷新也只走 mock。 */
const mockFetcher = vi.fn(async () => new Response(JSON.stringify({
  credentials: {
    access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    expiration: '2026-08-16T00:00:00Z',
  },
  refresh_token: 'RT',
}), { status: 200 }))

afterEach(() => {
  for (const service of services) service.stop()
  services.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('CodeArtsAuth', () => {
  it('registers as ctx.codeartsAuth on construction', () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    // cordis 通过其反射层提供服务，因此不保证
    // 身份相等（`===`）；instanceof 和名称才是契约。
    expect(ctx.codeartsAuth).toBeInstanceOf(CodeArtsAuth)
    expect(ctx.codeartsAuth.name).toBe('codeartsAuth')
  })

  it('login stores the flow access value under the given ref', async () => {
    mockedRunOAuthFlow.mockResolvedValue({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login({ refName: 'CODEARTS_ACCOUNT_1' })
    expect(await credentials.resolve('CODEARTS_ACCOUNT_1')).toEqual({ value: 'json-credential', source: 'fake' })
    expect(result).toMatchObject({ access: 'json-credential', expires: 1234, loginUrl: 'https://login' })
    expect(String(result.ref)).toBe('CODEARTS_ACCOUNT_1')
  })

  it('login forwards flow options and propagates failures', async () => {
    mockedRunOAuthFlow.mockRejectedValue(new Error('CodeArts login timed out'))
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    await expect(service.login({ maxAttempts: 1 })).rejects.toThrow('CodeArts login timed out')
    expect(mockedRunOAuthFlow).toHaveBeenCalledWith({ maxAttempts: 1 })
  })

  it('login registers the account into the pool when accountId/pool are given', async () => {
    mockedRunOAuthFlow.mockResolvedValue({
      access: JSON.stringify({
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT', user_name: 'someone',
      }),
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://login',
    })
    const { ctx } = makeContext()
    const addAccount = vi.fn(async () => {})
    const pool = { addAccount } as never
    const service = newService(ctx, { fetcher: mockFetcher })
    await service.login({ refName: 'CODEARTS_ACCOUNT_1', accountId: 'codearts-1', pool })
    expect(addAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codearts-1',
      provider: 'codearts',
      credentialRef: 'CODEARTS_ACCOUNT_1',
      refreshable: true,
    }))
  })

  it('login falls back to the fixed ref when refName is omitted (兼容既有签名)', async () => {
    // 单凭据模式已移除，但 refName 缺省值仍保留 —— 该 ref 不再有读取方。
    mockedRunOAuthFlow.mockResolvedValue({ access: 'legacy', expires: 1, loginUrl: 'https://login' })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login()
    expect(String(result.ref)).toBe(CODEARTS_CREDENTIAL_REF)
    expect(await credentials.resolve(CODEARTS_CREDENTIAL_REF)).toBeDefined()
  })
})

describe('CodeArtsAuth OAuth login', () => {
  it('login defaults to the oauth flow and reports refreshable: true', async () => {
    mockedRunOAuthFlow.mockResolvedValue({
      access: '{"access_key_id":"AK","secret_access_key":"SK","security_token":"ST","expires_at":"2026-08-15T00:00:00Z","refresh_token":"RT"}',
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://codearts.huaweicloud.com/portal/authorize?...',
    })
    const { ctx, credentials } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login({ refName: 'CODEARTS_ACCOUNT_1' })
    expect(mockedRunOAuthFlow).toHaveBeenCalled()
    expect(mockedRunLoginFlow).not.toHaveBeenCalled()
    expect(result.refreshable).toBe(true)
    const stored = JSON.parse((await credentials.resolve('CODEARTS_ACCOUNT_1'))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('RT')
  })

  it('login(flow: ticket) falls back to the legacy ticket flow', async () => {
    mockedRunLoginFlow.mockResolvedValue({
      access: '{"access_key_id":"AK","secret_access_key":"SK","security_token":"ST","expires_at":"2026-08-15T00:00:00Z"}',
      expires: Date.parse('2026-08-15T00:00:00Z'),
      loginUrl: 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect?...',
    })
    const { ctx } = makeContext()
    const service = newService(ctx, { fetcher: mockFetcher })
    const result = await service.login({ flow: 'ticket' })
    expect(mockedRunLoginFlow).toHaveBeenCalled()
    expect(result.refreshable).toBe(false)
  })
})

/**
 * 续期只有**按账号**这一条路径（`refreshAccountCredential`）。
 *
 * ⚠️ 早期的 `refresh()`（读写固定单凭据 ref）与 `status()` / `logout()` /
 * `scheduleRefresh()` / `scheduleModelRefresh()` 已随单凭据模式一并移除 ——
 * 它们的用例也相应替换为按账号续期的用例。
 */
describe('CodeArtsAuth 按账号续期', () => {
  it('refreshAccountCredential exchanges the refresh_token and rewrites the credential', async () => {
    const { ctx, credentials } = makeContext()
    const { privateKeyJwk } = await generateDpopKeyPair()
    await credentials.set('CODEARTS_ACCOUNT_1', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
      refresh_token: 'RT', code_verifier: 'VERIFIER', dpop_private_key_jwk: privateKeyJwk,
      domain_id: 'DOMAIN', user_id: 'USER', user_name: 'NAME',
    }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2',
        expiration: '2026-08-16T00:00:00Z',
      },
      refresh_token: 'RT2',
    }), { status: 200 }))
    const service = newService(ctx, { fetcher })
    await service.refreshAccountCredential('CODEARTS_ACCOUNT_1')
    const stored = JSON.parse((await credentials.resolve('CODEARTS_ACCOUNT_1'))!.value) as Record<string, string>
    expect(stored.refresh_token).toBe('RT2')
    expect(mockedRunLoginFlow).not.toHaveBeenCalled()
    // 验证请求体（mock fetch 被 exchangeRefreshToken 调用）：
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/oauth2/tokens')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
    // 刷新后无变化字段（domain_id/user_id/user_name 等）必须被保留。
    expect(stored.domain_id).toBe('DOMAIN')
    expect(stored.user_id).toBe('USER')
    expect(stored.user_name).toBe('NAME')
  })

  it('refreshAccountCredential reports an explicit error when the credential lacks refresh fields', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('CODEARTS_ACCOUNT_1', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expires_at: '',
    }))
    const service = newService(ctx)
    await expect(service.refreshAccountCredential('CODEARTS_ACCOUNT_1')).rejects.toThrow(/refresh_token/)
  })

  it('refreshAccountCredential reports an error when the credential is missing', async () => {
    const { ctx } = makeContext()
    const service = newService(ctx)
    await expect(service.refreshAccountCredential('CODEARTS_ACCOUNT_MISSING')).rejects.toThrow('凭据未配置')
  })

  it('refreshAccountCredential propagates RefreshTokenExpiredError from the backend', async () => {
    const { ctx, credentials } = makeContext()
    const { privateKeyJwk } = await generateDpopKeyPair()
    await credentials.set('CODEARTS_ACCOUNT_1', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-14T12:00:00Z',
      refresh_token: 'RT', code_verifier: 'VERIFIER', dpop_private_key_jwk: privateKeyJwk,
    }))
    mockedExchangeRefreshToken.mockRejectedValue(new RefreshTokenExpiredError('invalid_grant'))
    const service = newService(ctx)
    await expect(service.refreshAccountCredential('CODEARTS_ACCOUNT_1'))
      .rejects.toBeInstanceOf(RefreshTokenExpiredError)
  })
})

/**
 * `refreshModels` 现在**必须接收账号池**：单凭据模式移除后，固定 ref
 * `CODEARTS_ACCESS_TOKEN` 不再被读取，凭据只能来自账号池条目。
 */
describe('CodeArtsAuth refreshModels', () => {
  it('从账号池里取第一个可用账号的凭据拉取模型', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('CODEARTS_ACCOUNT_1', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { models: [{ id: 'm1', name: 'M1' }] },
    }), { status: 200 }))
    const service = newService(ctx, { fetcher })
    await service.refreshModels(makePool([{ id: 'ca-1', credentialRef: 'CODEARTS_ACCOUNT_1' }]))
    expect(fetcher).toHaveBeenCalled()
  })

  it('⚠️ 账号池为空时返回空列表（不再回退读单凭据 ref）', async () => {
    const { ctx, credentials } = makeContext()
    // 即便固定 ref 下有凭据，也不该被读取。
    await credentials.set(CODEARTS_CREDENTIAL_REF, JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    }))
    const fetcher = vi.fn()
    const service = newService(ctx, { fetcher })
    expect(await service.refreshModels(makePool([]))).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('跳过凭据缺失的账号，用后面可用的账号', async () => {
    const { ctx, credentials } = makeContext()
    await credentials.set('CODEARTS_ACCOUNT_2', JSON.stringify({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
    }))
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const service = newService(ctx, { fetcher })
    await service.refreshModels(makePool([
      { id: 'ca-1', credentialRef: 'CODEARTS_ACCOUNT_1' }, // 凭据不存在
      { id: 'ca-2', credentialRef: 'CODEARTS_ACCOUNT_2' },
    ]))
    expect(fetcher).toHaveBeenCalled()
  })
})
