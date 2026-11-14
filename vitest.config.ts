import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/integration.test.ts'],
		// Type-level tests of drizzle-cubrid/native, checked with tsc (tests/ is outside the root tsconfig).
		typecheck: {
			enabled: true,
			include: ['tests/native/**/*.test-d.ts'],
			tsconfig: './tests/native/tsconfig.json',
		},
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/index.ts'],
			thresholds: {
				statements: 95,
				branches: 95,
				functions: 95,
				lines: 95,
			},
		},
	},
});
