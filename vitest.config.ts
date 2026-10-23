import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@kernelpai/core': src('./packages/core/src/index.ts'),
      '@kernelpai/journal': src('./packages/journal/src/index.ts'),
      '@kernelpai/providers': src('./packages/providers/src/index.ts'),
      '@kernelpai/router': src('./packages/router/src/index.ts'),
      '@kernelpai/budget': src('./packages/budget/src/index.ts'),
      '@kernelpai/executor': src('./packages/executor/src/index.ts'),
      '@kernelpai/tools': src('./packages/tools/src/index.ts'),
      '@kernelpai/packs': src('./packages/packs/src/index.ts'),
      '@kernelpai/memory': src('./packages/memory/src/index.ts'),
      '@kernelpai/kernel/protocol': src('./packages/kernel/src/protocol.ts'),
      '@kernelpai/kernel': src('./packages/kernel/src/index.ts'),
      '@kernelpai/orchestrator': src('./packages/orchestrator/src/index.ts'),
      '@kernelpai/learning': src('./packages/learning/src/index.ts'),
      '@kernelpai/server': src('./packages/server/src/index.ts'),
    },
  },
  test: {
    // Many suites drive real git repositories and WebSocket servers; on CI runners
    // (Windows above all) git alone can take seconds. A real hang still fails at 60 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test-helpers/**',
        'apps/cli/src/bin.ts',
        'apps/studio/src/main.tsx',
        'apps/studio-tui/src/bin.tsx',
        '**/index.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      reporter: ['text', 'json-summary'],
    },
  },
});
