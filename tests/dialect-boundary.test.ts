import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compare, main, scanText, scanTree, summarize } from '../scripts/check-dialect-boundary.mjs';
import baseline from '../scripts/dialect-boundary-baseline.json';

// Canaries for the foreign-dialect boundary guard (#192, ADR 0003, ADR 0007):
// each rule must catch a deliberately introduced violation, and legitimate
// native code must pass.

const SCRIPT = join(__dirname, '..', 'scripts', 'check-dialect-boundary.mjs');

const found = (file: string, text: string, scope = 'src') =>
	scanText(file, text, scope).map((f: { rule: string; match: string }) => `${f.rule}:${f.match}`);
const native = (text: string) => found('src/native/x.ts', text);

describe('import rule', () => {
	it.each([
		["import { mysqlTable } from 'drizzle-orm/mysql-core';", 'import:drizzle-orm/mysql-core'],
		["import type { MySqlTable } from 'drizzle-orm/mysql-core';", 'import:drizzle-orm/mysql-core'],
		["export { pgTable } from 'drizzle-orm/pg-core';", 'import:drizzle-orm/pg-core'],
		["export * as s from 'drizzle-orm/sqlite-core';", 'import:drizzle-orm/sqlite-core'],
		["import {\n  a,\n  b,\n} from 'drizzle-orm/singlestore-core';", 'import:drizzle-orm/singlestore-core'],
		["import 'drizzle-orm/mysql2';", 'import:drizzle-orm/mysql2'],
		["const m = await import('drizzle-orm/mysql-core');", 'import:drizzle-orm/mysql-core'],
		['const m = await import(`drizzle-orm/mysql-core`);', 'import:drizzle-orm/mysql-core'],
		["import x = require('drizzle-orm/mysql-core');", 'import:drizzle-orm/mysql-core'],
		["const r = createRequire(import.meta.url)('drizzle-orm/mysql-core');", 'import:drizzle-orm/mysql-core'],
		["type T = typeof import('drizzle-orm/mysql-core').MySqlTable;", 'import:drizzle-orm/mysql-core'],
		['/// <reference types="mysql2" />\nexport {};', 'import:mysql2'],
		["import mysql from 'mysql2';", 'import:mysql2'],
		["import mysql from 'mysql2/promise';", 'import:mysql2/promise'],
		["import { Pool } from 'pg/lib';", 'import:pg/lib'],
		["import type { Cache } from 'drizzle-orm/cache/core/cache';", 'import:drizzle-orm/cache/core/cache'],
		["import { DrizzleError } from 'drizzle-orm/errors';", 'import:drizzle-orm/errors'],
	])('catches %s', (code, finding) => {
		expect(native(code)).toContain(finding);
	});

	it('catches require() in the packed CommonJS build', () => {
		expect(found('dist/index.cjs', 'var x = require("drizzle-orm/mysql-core/index.js");', 'package')).toContain(
			'import:drizzle-orm/mysql-core/index.js',
		);
	});

	it('allows the root entry, the neutral subpaths of ADR 0007 and cubrid-client', () => {
		for (const spec of [
			'drizzle-orm',
			'drizzle-orm/casing',
			'drizzle-orm/column',
			'drizzle-orm/column-builder',
			'drizzle-orm/entity',
			'drizzle-orm/operations',
			'drizzle-orm/query-builders/select.types',
			'drizzle-orm/query-promise',
			'drizzle-orm/relations',
			'drizzle-orm/sql/sql',
			'drizzle-orm/table',
			'drizzle-orm/utils',
			'cubrid-client',
		]) {
			expect(native(`import { x } from '${spec}';`)).toEqual([]);
		}
	});
});

describe('native-import rule', () => {
	it('catches native code reaching the MySQL-based 0.x modules through relative imports', () => {
		expect(native("import { CubridSession } from '../session.js';")).toEqual(['native-import:../session.js']);
		expect(native("import { cubridTable } from '../index.js';")).toEqual(['native-import:../index.js']);
		expect(found('src/native/deep/x.ts', "export * from '../../table.js';")).toEqual(['native-import:../../table.js']);
		expect(native("const s = await import('../driver.js');")).toEqual(['native-import:../driver.js']);
	});

	it('catches native code reaching 0.x modules through the ~/ alias or the package name', () => {
		expect(native("import { CubridSession } from '~/session.js';")).toEqual(['native-import:~/session.js']);
		expect(native("import { cubridTable } from 'drizzle-cubrid';")).toEqual(['native-import:drizzle-cubrid']);
		expect(native("export * from 'drizzle-cubrid/columns';")).toEqual(['native-import:drizzle-cubrid/columns']);
		expect(native("const m = await import('drizzle-cubrid');")).toEqual(['native-import:drizzle-cubrid']);
		expect(native("import { x } from '~/native/internal.js';")).toEqual([]);
	});

	it('allows native code only an import allowlist, so new path aliases cannot reach 0.x modules', () => {
		expect(native("import { CubridSession } from 'src/session.js';")).toEqual(['native-import:src/session.js']);
		expect(native("import { x } from '@/session.js';")).toEqual(['native-import:@/session.js']);
		expect(native("import { z } from 'zod';")).toEqual(['native-import:zod']);
		expect(native("import { createClient } from 'cubrid-client';")).toEqual([]);
		expect(native("import { readFileSync } from 'node:fs';")).toEqual([]);
		expect(native("import { eq } from 'drizzle-orm';")).toEqual([]);
		expect(native("import { x } from 'drizzle-orm/mysql-core';")).toEqual(['import:drizzle-orm/mysql-core']);
	});

	it('allows relative imports that stay inside src/native', () => {
		expect(native("import { x } from './internal.js';")).toEqual([]);
		expect(found('src/native/deep/x.ts', "import { y } from '../columns.js';")).toEqual([]);
		expect(found('src/session.ts', "import { x } from './driver.js';")).toEqual([]);
	});
});

describe('identifier and mode rules', () => {
	it('catches foreign dialect names as identifiers, in any capitalisation, and as whole strings', () => {
		expect(
			native(
				'class D extends MySqlDialect {}\nclass E extends MySQLDialect {}\nconst { mysqlTable: t } = m;\nlet p: PgTable; let s: SQLiteSession; let g: SingleStoreTable;',
			),
		).toEqual(
			expect.arrayContaining([
				'identifier:MySqlDialect',
				'identifier:MySQLDialect',
				'identifier:mysqlTable',
				'identifier:PgTable',
				'identifier:SQLiteSession',
				'identifier:SingleStoreTable',
			]),
		);
		expect(native("if (column.columnType === 'MySqlEnumColumn') {}")).toEqual(['identifier:MySqlEnumColumn']);
	});

	it('catches foreign backend modes and dialect settings, with plain or quoted keys', () => {
		expect(native("drizzle(client, { mode: 'planetscale' });")).toEqual(['mode:planetscale']);
		expect(found('drizzle.config.ts', "export default { dialect: 'mysql' };")).toContain('mode:dialect: mysql');
		expect(found('drizzle.config.ts', "export default { 'dialect': 'postgresql' };")).toContain(
			'mode:dialect: postgresql',
		);
		expect(found('drizzle.config.ts', "export default { dialect: 'mysql2' };")).toContain('mode:dialect: mysql2');
	});

	it('does not flag unrelated names, prose in strings or comments', () => {
		expect(native('const SQLiteral = 1; const Gelato = 2; const pgSize = 3; const cubridTable = 4;')).toEqual([]);
		expect(native("const message = 'Drizzle MySqlDialect is not used';")).toEqual([]);
		expect(native("// MySqlDialect from 'drizzle-orm/mysql-core'\n/* mode: 'planetscale' */ export {};")).toEqual([]);
	});
});

describe('parsing cannot be tricked into hiding code', () => {
	it.each([
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text with a template literal, on purpose
		"const q = `${`//`}`; import { MySqlDialect } from 'drizzle-orm/mysql-core';",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text with a template literal, on purpose
		"const q = `${'`'}`; const u = 'a//b'; import { MySqlDialect } from 'drizzle-orm/mysql-core';",
		"if (ok) /'/.test(s);\nconst u = 'http://x'; import { MySqlDialect } from 'drizzle-orm/mysql-core';",
		"const r = /['\"`]/g;\nimport { MySqlDialect } from 'drizzle-orm/mysql-core';",
		"const s = '/* not a comment'; import { MySqlDialect } from 'drizzle-orm/mysql-core'; const e = '*/';",
	])('still sees the import after %s', (code) => {
		expect(native(code)).toEqual(['import:drizzle-orm/mysql-core', 'identifier:MySqlDialect']);
	});

	it('reports the line of each finding', () => {
		const [finding] = scanText('src/native/x.ts', '/*\n\n*/\nclass D extends MySqlDialect {}');
		expect(finding?.line).toBe(4);
	});
});

describe('internal rule (native code only)', () => {
	const internalUse = [
		"const columns = table[Symbol.for('drizzle:Columns')];",
		"const other = table[Symbol['for']('drizzle:Name')];",
		'if (column.shouldDisableInsert()) skip();',
		"if (column['shouldDisableInsert']()) skip();",
		'const t = table as unknown as Record<symbol, unknown>;',
		'const u = <Record<symbol, unknown>>(<unknown>table);',
		'const decode = field.decoder;',
		"const decode2 = field['decoder'];",
		'const { decoder } = field;',
		"const d3 = Reflect.get(field, 'decoder');",
		'const v = table as any as T;',
		'const w = <T>(<never>table);',
	].join('\n');

	it('catches every form of Drizzle internal access in src/native outside the shim', () => {
		expect(native(internalUse)).toEqual([
			"internal:Symbol.for('drizzle:",
			"internal:Symbol.for('drizzle:",
			'internal:.shouldDisableInsert',
			'internal:.shouldDisableInsert',
			'internal:cast through unknown',
			'internal:cast through unknown',
			'internal:.decoder',
			'internal:.decoder',
			'internal:.decoder',
			'internal:.decoder',
			'internal:cast through any',
			'internal:cast through never',
		]);
	});

	it("allows it in the shim, in 0.x code and for the dialect's own this.decoder", () => {
		expect(found('src/native/internal.ts', internalUse)).toEqual([]);
		expect(found('src/session.ts', internalUse)).toEqual([]);
		expect(native('return this.decoder(value);')).toEqual([]);
		expect(native("const key = Symbol.for('cubrid:own');")).toEqual([]);
	});
});

describe('baseline ratchet', () => {
	const finding = (file: string, match = 'drizzle-orm/mysql-core') => ({ file, rule: 'import', match, line: 1 });

	it('fails on a new finding, a rising count, a falling count and a stale entry', () => {
		const known = summarize([finding('src/a.ts'), finding('src/a.ts')], 'src');
		expect(compare([finding('src/a.ts'), finding('src/a.ts')], known, 'src')).toEqual([]);
		expect(compare([finding('src/a.ts'), finding('src/a.ts'), finding('src/b.ts')], known, 'src')).toEqual([
			'src/b.ts:1 new import "drizzle-orm/mysql-core" (x1)',
		]);
		expect(compare([finding('src/a.ts'), finding('src/a.ts'), finding('src/a.ts')], known, 'src')).toEqual([
			'src/a.ts:1, 1, 1 import "drizzle-orm/mysql-core" rose from 2 to 3',
		]);
		expect(compare([finding('src/a.ts')], known, 'src')[0]).toMatch(/fell from 2 to 1: shrink the baseline/);
		expect(compare([], known, 'src')[0]).toMatch(/no longer occurs/);
	});

	it('never accepts findings in native code, baselined or not', () => {
		const nativeFinding = finding('src/native/table.ts');
		expect(compare([nativeFinding], summarize([nativeFinding], 'src'), 'src')).toEqual([
			'baseline entry for native code is not allowed: src/native/table.ts import drizzle-orm/mysql-core',
			'src/native/table.ts:1 import "drizzle-orm/mysql-core" is not allowed in native code',
		]);
	});

	it('keeps src and package baselines apart', () => {
		const known = summarize([finding('dist/index.js')], 'package');
		expect(compare([finding('dist/index.js')], known, 'src')[0]).toMatch(/new import/);
	});
});

describe('repository and command line', () => {
	let dir: string | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	const tree = (files: Record<string, string>) => {
		dir = mkdtempSync(join(tmpdir(), 'boundary-'));
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(dir, path, '..'), { recursive: true });
			writeFileSync(join(dir, path), text);
		}
		return dir;
	};
	const quiet = () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	};

	it('matches the checked-in baseline for src', () => {
		const findings = scanTree(join(__dirname, '..'), 'src', 'src');
		expect(compare(findings, baseline.entries, 'src')).toEqual([]);
	});

	it('exits 0 for a clean tree, 1 for a planted violation and 2 for bad arguments', () => {
		quiet();
		const root = tree({ 'src/native/table.ts': "import { cubridTable } from './internal.js';\n" });
		const baselinePath = join(root, 'baseline.json');
		expect(main(['src'], { root, baseline: baselinePath })).toBe(0);
		writeFileSync(join(root, 'src/native/table.ts'), "import { mysqlTable } from 'drizzle-orm/mysql-core';\n");
		expect(main(['src'], { root, baseline: baselinePath })).toBe(1);
		expect(main([], { root, baseline: baselinePath })).toBe(2);
		expect(main(['package'], { root, baseline: baselinePath })).toBe(2);
		expect(main(['src', 'extra'], { root, baseline: baselinePath })).toBe(2);
	});

	it('refuses to baseline native findings and records 0.x findings', () => {
		quiet();
		const root = tree({
			'src/native/table.ts': "import { mysqlTable } from 'drizzle-orm/mysql-core';\n",
			'src/session.ts': "import { MySqlSession } from 'drizzle-orm/mysql-core/session';\n",
		});
		const baselinePath = join(root, 'baseline.json');
		expect(main(['src', '--update-baseline'], { root, baseline: baselinePath })).toBe(1);
		rmSync(join(root, 'src/native/table.ts'));
		expect(main(['src', '--update-baseline'], { root, baseline: baselinePath })).toBe(0);
		const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
		expect(written.entries.map((e: { rule: string; match: string }) => `${e.rule}:${e.match}`)).toEqual([
			'identifier:MySqlSession',
			'import:drizzle-orm/mysql-core/session',
		]);
		expect(main(['src'], { root, baseline: baselinePath })).toBe(0);
	});

	it('fails instead of passing when there is nothing to scan', () => {
		quiet();
		const root = tree({ 'README.md': 'no sources' });
		expect(main(['src'], { root, baseline: join(root, 'baseline.json') })).toBe(1);
		expect(main(['package', join(root, 'missing')], { root, baseline: join(root, 'baseline.json') })).toBe(1);
	});

	it('runs as a script and writes the step summary', () => {
		const root = tree({ 'pkg/dist/index.js': "import { MySqlDialect } from 'drizzle-orm/mysql-core';\n" });
		const summary = join(root, 'summary.md');
		const run = spawnSync(
			process.execPath,
			[SCRIPT, 'package', join(root, 'pkg'), `--baseline=${join(root, 'none.json')}`],
			{
				encoding: 'utf8',
				env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
			},
		);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('::error::dist/index.js:1 new import "drizzle-orm/mysql-core" (x1)');
		expect(run.stderr).toContain('::error::dist/index.js:1 new identifier "MySqlDialect" (x1)');
		expect(readFileSync(summary, 'utf8')).toMatch(/Foreign-dialect boundary \(package\): 2 known 0\.x findings/);
		expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
	});
});
