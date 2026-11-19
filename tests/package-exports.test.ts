// The package's export map (ADR 0010): the root entry is the native dialect,
// drizzle-cubrid/native resolves to the very same files (one module instance,
// so one set of classes), drizzle-cubrid/migrator is drizzle-cubrid/native/migrator,
// and the 0.x API is only at drizzle-cubrid/legacy. The packed tarball is
// exercised by scripts/packed-exports-smoke.cjs and scripts/packed-live*.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tsup from '../tsup.config';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const entry = (name: string) => ({
	import: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
	require: { types: `./dist/${name}.d.cts`, default: `./dist/${name}.cjs` },
});

describe('package.json exports', () => {
	it('has exactly the root, its native alias, the migrator (two paths) and the legacy entry', () => {
		expect(Object.keys(manifest.exports).sort()).toEqual(
			['.', './legacy', './migrator', './native', './native/migrator'].sort(),
		);
	});

	it('maps the root and drizzle-cubrid/native to the same native build, for ESM, CJS and types', () => {
		expect(manifest.exports['.']).toEqual(entry('index'));
		expect(manifest.exports['./native']).toEqual(manifest.exports['.']);
	});

	it('maps drizzle-cubrid/migrator and drizzle-cubrid/native/migrator to the same files', () => {
		expect(manifest.exports['./native/migrator']).toEqual(entry('native-migrator'));
		expect(manifest.exports['./migrator']).toEqual(manifest.exports['./native/migrator']);
	});

	it('maps drizzle-cubrid/legacy to the 0.x build', () => {
		expect(manifest.exports['./legacy']).toEqual(entry('legacy'));
	});

	it('maps every subpath in typesVersions for moduleResolution node10, which ignores exports', () => {
		expect(manifest.typesVersions).toEqual({
			'*': {
				legacy: ['./dist/legacy.d.ts'],
				migrator: ['./dist/native-migrator.d.ts'],
				native: ['./dist/index.d.ts'],
				'native/migrator': ['./dist/native-migrator.d.ts'],
			},
		});
		const subpaths = Object.keys(manifest.exports)
			.filter((k) => k !== '.')
			.map((k) => k.slice(2));
		for (const sub of subpaths) {
			expect(manifest.typesVersions['*'][sub]).toEqual([manifest.exports[`./${sub}`].import.types]);
		}
	});

	it('keeps main, module and types on the root entry for tools that ignore exports', () => {
		expect([manifest.main, manifest.module, manifest.types]).toEqual([
			'./dist/index.cjs',
			'./dist/index.js',
			'./dist/index.d.ts',
		]);
	});

	it('builds the root from src/native and the legacy entry from src/legacy.ts, with no separate native bundle', () => {
		const config = Array.isArray(tsup) ? tsup[0] : tsup;
		expect(config.entry).toEqual({
			index: 'src/native/index.ts',
			legacy: 'src/legacy.ts',
			'native-migrator': 'src/native/migrator.ts',
		});
		expect(config.format).toEqual(['esm', 'cjs']);
		expect(config.dts).toBe(true);
	});

	it('keeps Node 18 as the minimum runtime (ADR 0006)', () => {
		expect(manifest.engines.node).toBe('>=18.0.0');
	});
});
