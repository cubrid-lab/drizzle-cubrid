import { defineConfig } from 'tsup';

export default defineConfig({
	// ADR 0010: `index` is the root entry, drizzle-cubrid, built from the native
	// dialect. package.json maps drizzle-cubrid/native to the same dist/index.*
	// files, so both specifiers load one module instance with one set of classes;
	// no separate `native` bundle is built.
	// `legacy` is drizzle-cubrid/legacy, the deprecated 0.x API; it shares no
	// module with the native entries.
	// `native-migrator` is drizzle-cubrid/migrator and drizzle-cubrid/native/migrator
	// (#163); it imports no native module at runtime, so bundling it on its own
	// creates no second copy of a native class.
	entry: { index: 'src/native/index.ts', legacy: 'src/legacy.ts', 'native-migrator': 'src/native/migrator.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: ['drizzle-orm', 'cubrid-client'],
});
