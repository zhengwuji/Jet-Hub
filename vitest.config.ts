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

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    env: {
      DSH_JET_HUB_STATE_DIR: jetHubStateDir,
    },
  },
})
