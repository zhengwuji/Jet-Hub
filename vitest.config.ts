import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 单测隔离：Jet Hub 的文件后端默认落在 `$DSH_HOME/jet-hub/state.json`，
 * 若不在测试环境里改写，用例会污染真实用户的 `~/.dsh`。
 * 需要自建目录的用例自行覆盖 `DSH_JET_HUB_STATE_DIR`。
 */
const jetHubStateDir = mkdtempSync(join(tmpdir(), 'dsh-jet-hub-test-'))

/**
 * Qoder 设备身份：**测试里绝不能真的 spawn `runtime-info.exe`**。
 *
 * 那个可执行文件由 Qoder 桌面端分发，单次约 3.8 秒（还有 0.8 秒的暖启动）。
 * 若不禁用：① 整个套件明显变慢；② 用例结果随「开发机是否装了桌面端」而变；
 * ③ 断言会拿到**实时身份**而不是用例准备的 fixture，从而假失败。
 *
 * 指向不存在的路径即等价于「未安装」，代码会退回读 `machine_token.json`
 * （与纯插件登录用户的行为一致），用例因此可精确断言。
 */
const noSuchRuntimeInfo = join(jetHubStateDir, 'no-such-runtime-info')

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    env: {
      DSH_JET_HUB_STATE_DIR: jetHubStateDir,
      QODER_RUNTIME_INFO: noSuchRuntimeInfo,
    },
  },
})
