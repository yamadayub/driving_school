import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
      // SEC-010/RV-P2-001: 公開経路 lib/queries.ts（`import 'server-only'`）を結合テストから
      // 検証するためのスタブ差し替え。理由は tests/integration/stubs/server-only.ts を参照。
      'server-only': resolve(__dirname, 'tests/integration/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.int.ts'],
    environment: 'node',
    globals: true,
    // dev DB(.env) を process.env に読み込む（Prisma の datasource url 解決に必要）
    setupFiles: ['./tests/integration/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
