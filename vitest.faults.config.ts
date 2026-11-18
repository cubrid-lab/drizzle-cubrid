import { defineConfig } from 'vitest/config';

// Fault-injection tests (`npm run integration:faults`): they restart, pause
// and kill the CUBRID server, so they run alone, never with the live suite or
// `npm test`.
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/faults.test.ts'],
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
