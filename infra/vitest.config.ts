import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'lambda/**/__tests__/**/*.test.ts'],
    // CDK の synth は esbuild のバンドルを走らせるので既定のタイムアウトでは足りない
    testTimeout: 60_000,
  },
});
