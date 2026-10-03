/**
 * Jet Hub RPC —— 模型目录开关端点（`model.list` / `model.setDisabled` /
 * `model.setAllDisabled`）。
 *
 * 从 `src/jet-hub-rpc.ts` 的巨型 `switch`（P1-⑤ 纯结构重构）按领域整体搬出，
 * **分支体逐字节保持原样**。
 *
 * ⚠️ 展示列表必须走适配器实例的 `listAllModels()`（`deps.modelAdapters`），
 * 不能用 `ctx.llm.listModels()` —— 后者按黑名单过滤，被关闭的模型会退化成裸 id。
 * ⚠️ 写完黑名单必须 `broadcastCatalogChanged`，否则客户端目录缓存永不失效。
 */

import type { RpcModelListRequest, RpcModelListResponse, RpcModelSetDisabledRequest, RpcModelSetDisabledResponse, RpcModelSetAllDisabledRequest, RpcModelSetAllDisabledResponse } from '../types.js'
import type { RpcResult, JetHubRpcContext, JetHubRpcServices, JetHubModelHelpers } from './contracts.js'

/** `model.*` 端点处理器所需依赖（由 `src/jet-hub-rpc.ts` 装配）。 */
export type ModelEndpointDeps = JetHubRpcContext
  & Pick<JetHubRpcServices, 'modelAdapters'>
  & Pick<JetHubModelHelpers, 'llmServiceOf' | 'broadcastCatalogChanged'>

/** 处理 `model.*` 端点方法。 */
export async function handleModelMethod(
  method: string,
  payload: unknown,
  deps: ModelEndpointDeps,
  _signal: AbortSignal,
): Promise<RpcResult> {
  const { ctx, pool, modelAdapters, llmServiceOf, broadcastCatalogChanged, } = deps

  switch (method) {
      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case 'model.list': {
        const req = payload as RpcModelListRequest
        const llm = llmServiceOf(ctx)
        if (llm === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
        }
        let models: Array<{ id: string; name: string }>
        try {
          models = await llm.listModels(req.provider)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
        }
        // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
        // 下一次 listModels 就会应用新的过滤结果。
        const disabledMap = pool.listDisabledModels(req.provider)
        // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：所有适配器
        // 的 listModels 内部都会实时 `filter(m => !disabledModelsFor(provider).has(m.id))`。
        // 若直接对这个结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
        // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
        // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
        // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
        //
        // 因此设置页的目录必须以**未过滤**的全量为准：
        // - 优先用适配器提供的 `listAllModels()`（不套黑名单，且带**最终展示名**，
        //   含倍率与同名消歧）；
        // - 它不存在时（外部/旧适配器）退化为「listModels 结果 + 黑名单补回裸 id」，
        //   此时关闭项只能显示 id（历史行为）。
        //
        // ⚠️ 展示名必须来自**不套黑名单**的全量目录而非裸 id：用户报障
        // 「关闭的就没有显示倍率，关闭的应该也显示倍率」—— 根因正是补回时只有
        // id 可用。适配器实例由 `registerJetHubRpc` 的 `modelAdapters` 传入
        // （DSH 的 `ctx.llm` 只保证 `listModels`，不透传自定义方法）。
        // 对话框模型选择器读的仍是过滤后的 `listModels`，可见性行为完全不变。
        const catalogSource = modelAdapters?.[req.provider]
        const all = catalogSource?.listAllModels()
        let catalog: Array<{ id: string; name: string }>
        if (all !== undefined) {
          // ✅ 全量目录在此分支是**权威且完整**的：`listAllModels()` 刻意**不套
          //    黑名单**（见适配器里的实现），所以每一个「被关闭的模型」都仍在
          //    这个数组里。于是**不需要**再拿黑名单去补任何东西。
          //
          // ⚠️ 这里曾有一句「保底」补回逻辑，把黑名单里 `!known.has(id)` 的键
          //    也 push 成 `{ id, name: id }`。它的注释写着「正常不会发生」——
          //    但真实故障（2026-10-04，用户报障「Accio 国内版怎么有 76 个模型，
          //    已隐藏 41 个」）证明它**会发生**，而且后果很刺眼：
          //
          //      上游目录真实 42 个模型，黑名单里却有 34 条**旧 id**（Accio 把
          //      对外 id 从上游混淆代号改成可读 slug 之后，旧键就永久留在了
          //      settings 里）。补回逻辑把这 34 条渲染成模型条目，于是
          //      `42 + 34 = 76 个模型`，且它们 `disabled: true` →
          //      `已隐藏 34 + 7 = 41 个`。用户看到的是「列表里多出一堆看不见的
          //      混淆 id」，而且**再也删不掉**（列表里没有它们的可读身份）。
          //
          //    判据：在全量目录已知的前提下，**黑名单里任何不在目录中的键都只能是
          //    过期残留**（上游下架、或我们改过对外 id），它不对应任何可路由的模型。
          //    把它渲染成条目既无法选中、也无法解释，只会污染计数。
          //    真正的修法是**改 id 时同步迁移黑名单**（见 AGENTS.md 的铁律），
          //    而不是在读取侧把残留键假装成模型。
          catalog = [...all]
        } else {
          const listedIds = new Set(models.map((model) => model.id))
          const filteredOut = Object.keys(disabledMap)
            .filter((id) => disabledMap[id] === true && !listedIds.has(id))
          catalog = [
            ...models.map((model) => ({ id: model.id, name: model.name })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            ...filteredOut.map((id) => ({ id, name: id })),
          ]
        }
        const value: RpcModelListResponse = {
          models: catalog.map((model) => ({
            id: model.id,
            name: model.name,
            disabled: disabledMap[model.id] === true,
          })),
        }
        return { ok: true, value }
      }
      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
      //
      // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
      // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
      // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
      // 磁盘、界面一直显示旧目录。
      case 'model.setDisabled': {
        const req = payload as RpcModelSetDisabledRequest
        if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } }
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true)
        ctx.logger.info(
          `[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }
      /**
       * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
       * 「打开全部 / 关闭全部」）。
       *
       * 两个方向的语义**刻意不对称**（需求明确规定）：
       *
       * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
       *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
       *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
       * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
       *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
       *   才能被清掉（按目录删的话它们永远留在配置里）。
       *
       * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
       * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
       * 的黑名单。批量端点只落盘一次、只广播一次。
       */
      case 'model.setAllDisabled': {
        const req = payload as RpcModelSetAllDisabledRequest
        // ⚠️ `disabled` **不做默认值猜测**：缺失或非布尔一律拒绝。默认成 true 会
        // 让一次字段名写错的前端改动静默关闭用户全部模型；默认成 false 则反向
        // 静默打开 —— 两个方向都是灾难性且难察觉的。
        if (typeof req.provider !== 'string' || typeof req.disabled !== 'boolean') {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'provider 与 disabled（布尔）必填' },
          }
        }
        if (req.disabled) {
          // 关闭全部：先取全量目录，再一次性写入黑名单。
          let ids: string[]
          const all = modelAdapters?.[req.provider]?.listAllModels()
          if (all !== undefined) {
            ids = all.map((model) => model.id)
          } else {
            const llm = llmServiceOf(ctx)
            if (llm === undefined) {
              // 目录读不出来就**不落盘**：否则会写入一个不完整的黑名单，
              // 用户看到「关了一半」且无从判断原因。
              return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
            }
            try {
              ids = (await llm.listModels(req.provider)).map((model) => model.id)
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
            }
          }
          await pool.setModelsDisabled(req.provider, ids)
          ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的全部 ${ids.length} 个模型`)
        } else {
          // 打开全部：纯本地操作，不读目录 —— 目录故障时用户仍应能把开关全打开。
          await pool.clearDisabledModels(req.provider)
          ctx.logger.info(`[jet-hub] 打开 ${req.provider} 的全部模型`)
        }
        // 只广播一次：批量不等于逐条广播。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetAllDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }
      default: return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
