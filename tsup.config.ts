import { defineConfig } from 'tsup';

export default defineConfig({
	// `native` is the experimental drizzle-cubrid/native entry (#157); it shares no module with the root.
	entry: { index: 'src/index.ts', native: 'src/native/index.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ['drizzle-orm', 'cubrid-client'],
});
