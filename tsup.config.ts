import { defineConfig } from 'tsup';

export default defineConfig({
	// `native` is the experimental drizzle-cubrid/native entry (#157); it shares no module with the root.
	// `native-migrator` is drizzle-cubrid/native/migrator (#163); it imports no native module at
	// runtime, so bundling it on its own creates no second copy of a native class.
	entry: { index: 'src/index.ts', native: 'src/native/index.ts', 'native-migrator': 'src/native/migrator.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ['drizzle-orm', 'cubrid-client'],
});
