import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Live tests hit testnet; run them with `npm run test:live`.
    exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
  },
});
