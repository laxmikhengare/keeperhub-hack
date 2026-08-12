import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only our own suites. Foundry vendors OpenZeppelin and forge-std into
    // contracts/lib, and vitest will otherwise try to run their fixtures.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'contracts/**', 'runs/**'],
  },
});
