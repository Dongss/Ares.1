import { defineConfig } from 'vitest/config';

// Tests that call real agent CLIs. They cost money and need a logged-in CLI,
// so they are not part of `npm test`. Run with `npm run test:real`.
export default defineConfig({
  test: {
    include: ['test/real/**/*.test.ts'],
    testTimeout: 300_000,
  },
});
