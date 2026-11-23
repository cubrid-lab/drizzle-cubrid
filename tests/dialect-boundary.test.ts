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
		["declare module 'drizzle-orm/mysql-core' { interface X {} }", 'import:drizzle-orm/mysql-core'],
	])('catches %s', (code, finding) => {
		expect(native(code)).toContain(finding);
	});

	it('catches require() in the packed CommonJS build', () => {
		expect(found('dist/legacy.cjs', 'var x = require("drizzle-orm/mysql-core/index.js");', 'package')).toContain(
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

	it.each([
		["const r = require; r('../../session.js');", 'native-import:require alias'],
		["const req = createRequire(import.meta.url); req('../../session.js');", 'native-import:createRequire'],
		["import { createRequire as cr } from 'node:module'; cr(url)('../../session.js');", 'native-import:node:module'],
		["import { createRequire as cr } from 'node:module'; cr(url)('../../session.js');", 'native-import:createRequire'],
		["const req = module.createRequire(url); req('../x.js');", 'native-import:createRequire'],
		["import m from 'module'; m.createRequire(url)('../x.js');", 'native-import:module'],
		["const r = module.require; r('../x.js');", 'native-import:require alias'],
	])('catches the loader bypass %s', (code, finding) => {
		expect(native(code)).toContain(finding);
	});

	it('allows direct require() calls of allowed modules and node: built-ins other than node:module', () => {
		expect(native("const c = require('cubrid-client'); const m = module.require('./x.js');")).toEqual([]);
		expect(native("import { readFileSync } from 'node:fs';")).toEqual([]);
	});

	it('does not mistake ordinary calls with a string argument for imports', () => {
		expect(native("const n = toSafeInteger('SMALLINT', value); const s = Symbol('cubrid');")).toEqual([]);
		expect(native("const m = module.require('../session.js');")).toEqual(['native-import:../session.js']);
		expect(native("const r = createRequire(import.meta.url)('zod');")).toEqual([
			'native-import:zod',
			'native-import:createRequire',
		]);
		expect(native("const w = wrap('drizzle-orm/mysql-core');")).toEqual(['import:drizzle-orm/mysql-core']);
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

describe('native-dynamic rule (native code only)', () => {
	it.each([
		["const r = eval('1');", 'native-dynamic:eval'],
		["const r = (0, eval)('1');", 'native-dynamic:eval'],
		["const e = eval; e('1');", 'native-dynamic:eval'],
		["const r = globalThis.eval('1');", 'native-dynamic:eval'],
		["const r = globalThis['eval']('1');", 'native-dynamic:["eval"]'],
		["const f = new Function('return 1');", 'native-dynamic:Function'],
		["const f = Function('return 1');", 'native-dynamic:Function'],
		["const F = Function; F('return 1');", 'native-dynamic:Function'],
		["const f = new globalThis.Function('return 1');", 'native-dynamic:Function'],
		["const f = global['Function']('return 1');", 'native-dynamic:["Function"]'],
		["const f = (() => 1).constructor('return process')();", 'native-dynamic:.constructor()'],
		["const f = fn['constructor']('return process');", 'native-dynamic:.constructor()'],
		['const m = await import(name);', 'native-dynamic:import(expression)'],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text for the scanner
		['const m = await import(`./${name}.js`);', 'native-dynamic:import(expression)'],
		['const m = await import();', 'native-dynamic:import(expression)'],
		['const m = require(name);', 'native-dynamic:require(expression)'],
		["const m = require('./' + name);", 'native-dynamic:require(expression)'],
		['const m = module.require(name);', 'native-dynamic:require(expression)'],
		['const m = createRequire(url)(name);', 'native-dynamic:require(expression)'],
		["const r = module['require']; ", 'native-dynamic:["require"]'],
		['const r = module[`require`];', 'native-dynamic:["require"]'],
		["const c = process['createRequire'];", 'native-dynamic:["createRequire"]'],
		["const r = Reflect.get(module, 'require');", 'native-dynamic:["require"]'],
		["const { ['require']: r } = module;", 'native-dynamic:["require"]'],
		['const { eval: e } = globalThis; e(x);', 'native-dynamic:{ eval }'],
		['const { Function: F } = globalThis;', 'native-dynamic:{ Function }'],
		['const { Function } = globalThis;', 'native-dynamic:{ Function }'],
		["const { 'eval': e } = globalThis;", 'native-dynamic:["eval"]'],
		['const { constructor: C } = fn;', 'native-dynamic:{ constructor }'],
		['globalThis["ev" + "al"]("1");', 'native-dynamic:global[expression]'],
		['const k = "eval"; globalThis[k]("1");', 'native-dynamic:global[expression]'],
		['global[k]("1");', 'native-dynamic:global[expression]'],
		['Reflect.get(globalThis, "ev" + "al");', 'native-dynamic:global[expression]'],
		['Reflect.get(globalThis, k);', 'native-dynamic:global[expression]'],
		["setTimeout('doIt()', 1);", 'native-dynamic:setTimeout(string)'],
		['globalThis.setInterval(`x`, 1);', 'native-dynamic:setInterval(string)'],
	])('catches %s', (code, finding) => {
		expect(native(code)).toContain(finding);
	});

	it('scans the packed native entries but no other packed file', () => {
		for (const entry of [
			'dist/index.js',
			'dist/index.cjs',
			'dist/native.js',
			'dist/native.cjs',
			'dist/native-migrator.js',
			'dist/native-migrator.cjs',
		]) {
			expect(found(entry, 'const r = eval(x);', 'package')).toEqual(['native-dynamic:eval']);
			expect(found(entry, "const m = module['require'];", 'package')).toEqual(['native-dynamic:["require"]']);
		}
		expect(found('dist/legacy.js', 'const r = eval(x); const m = require(name);', 'package')).toEqual([]);
		expect(found('src/session.ts', 'const r = eval(x); const m = import(name);')).toEqual([]);
		expect(found('dist/native.d.ts', 'declare const f: Function;', 'package')).toEqual([]);
	});

	it.each(['node:vm', 'node:worker_threads', 'node:child_process', 'node:module'])(
		'blocks %s through the native import allowlist',
		(spec) => {
			expect(native(`import x from '${spec}';`)).toEqual([`native-import:${spec}`]);
			expect(native(`const x = await import('${spec}');`)).toEqual([`native-import:${spec}`]);
		},
	);

	it('does not flag bundler require shims or ordinary computed keys in packed native entries', () => {
		const shim = [
			'var __require = typeof require !== "undefined" ? require : (x) => { throw Error(\'Dynamic require of "\' + x + \'" is not supported\'); };',
			'var __require2 = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, { get: (a, b) => (typeof require !== "undefined" ? require : a)[b] }) : x)(function(x) { return x; });',
			'__require("node:fs");',
		].join('\n');
		expect(found('dist/native.cjs', shim, 'package').filter((f) => f.startsWith('native-dynamic'))).toEqual([]);
		expect(
			found(
				'dist/native.js',
				'var a = obj[key]; var b = Reflect.get(obj, key); setTimeout(fn, 1); const { a: c } = o;',
				'package',
			),
		).toEqual([]);
		expect(
			native('const a = obj[key]; const b = Reflect.get(obj, key); setTimeout(() => 1, 5); const { a: c } = o;'),
		).toEqual([]);
	});

	it('does not flag literal loads, comments, messages, types or look-alike names', () => {
		expect(native("const c = require('cubrid-client'); const m = await import('./internal.js');")).toEqual([]);
		expect(native("const m = await import(`./internal.js`); const n = module.require('cubrid-client');")).toEqual([]);
		expect(native("// eval(x) and new Function('y') and import(z)\n/* module['require'] */ export {};")).toEqual([]);
		expect(native("throw new Error('eval is not allowed'); const s = 'Function'; const t = `require`;")).toEqual([]);
		expect(
			native("const o = { eval: 1, Function: 2, function: 3 }; o.eval; o.Function; o.function; o['function'];"),
		).toEqual([]);
		expect(native('class C { eval() {} Function = 1; static function() {} }')).toEqual([]);
		expect(native('type F = Function; const g: Function | undefined = undefined; const h = typeof g;')).toEqual([]);
		expect(native('const ok = value instanceof Function; const p = Function.prototype.toString;')).toEqual([]);
		expect(native('const n = this.constructor.name; const c = new this.constructor(1);')).toEqual([]);
		expect(native("const k = row['evaluate']; const v = label('eval', x); const w = map['required'];")).toEqual([]);
	});

	it('is never accepted by the baseline, in src or in the package', () => {
		const f = scanText('dist/native.js', 'eval(x);', 'package');
		expect(compare(f, summarize(f, 'package'), 'package')).toEqual([
			'baseline entry for native code is not allowed: dist/native.js native-dynamic eval',
			'dist/native.js:1 native-dynamic "eval" is not allowed in native code',
		]);
	});

	it('never accepts a baselined finding in the packed root entry or its declarations (ADR 0010)', () => {
		for (const file of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts']) {
			const f = scanText(file, "import { MySqlDialect } from 'drizzle-orm/mysql-core';", 'package');
			const problems = compare(f, summarize(f, 'package'), 'package');
			expect(problems).toContain(`${file}:1 identifier "MySqlDialect" is not allowed in native code`);
			expect(problems).toContain(
				`baseline entry for native code is not allowed: ${file} import drizzle-orm/mysql-core`,
			);
		}
		// The deprecated 0.x entry keeps its ratchet.
		const legacy = scanText('dist/legacy.d.ts', "import { MySqlDialect } from 'drizzle-orm/mysql-core';", 'package');
		expect(compare(legacy, summarize(legacy, 'package'), 'package')).toEqual([]);
	});

	it('fails the command and refuses --update-baseline for a packed native entry', () => {
		const dir = mkdtempSync(join(tmpdir(), 'boundary-'));
		try {
			mkdirSync(join(dir, 'pkg/dist'), { recursive: true });
			writeFileSync(join(dir, 'pkg/dist/native.js'), 'export const f = new Function(code);\n');
			const baselinePath = join(dir, 'b.json');
			const args = [SCRIPT, 'package', join(dir, 'pkg'), `--baseline=${baselinePath}`];
			expect(spawnSync(process.execPath, args, { encoding: 'utf8' }).status).toBe(1);
			expect(spawnSync(process.execPath, [...args, '--update-baseline'], { encoding: 'utf8' }).status).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
		const known = summarize([finding('dist/legacy.js')], 'package');
		expect(compare([finding('dist/legacy.js')], known, 'src')[0]).toMatch(/new import/);
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

	it('pins packed 0.x findings only under the deprecated legacy entry (ADR 0010)', () => {
		const files = new Set(baseline.entries.filter((e) => e.scope === 'package').map((e) => e.file));
		expect([...files].sort()).toEqual(['dist/legacy.cjs', 'dist/legacy.d.cts', 'dist/legacy.d.ts', 'dist/legacy.js']);
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
		const root = tree({ 'pkg/dist/legacy.js': "import { MySqlDialect } from 'drizzle-orm/mysql-core';\n" });
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
		expect(run.stderr).toContain('::error::dist/legacy.js:1 new import "drizzle-orm/mysql-core" (x1)');
		expect(run.stderr).toContain('::error::dist/legacy.js:1 new identifier "MySqlDialect" (x1)');
		expect(readFileSync(summary, 'utf8')).toMatch(/Foreign-dialect boundary \(package\): 2 known 0\.x findings/);
		expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
	});
});

// Each bypass named in #192 is planted in a native file of a temporary tree
// and must fail the command; legitimate native code must pass it.
describe('native code loading bypasses, planted in a fixture tree', () => {
	let dir: string | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	const run = (text: string) => {
		dir = mkdtempSync(join(tmpdir(), 'boundary-bypass-'));
		mkdirSync(join(dir, 'src', 'native'), { recursive: true });
		writeFileSync(join(dir, 'src', 'native', 'planted.ts'), text);
		const errors: string[] = [];
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(console, 'error').mockImplementation((message: string) => errors.push(message));
		const code = main(['src'], { root: dir, baseline: join(dir, 'baseline.json') });
		return { code, errors };
	};

	it.each([
		['eval', "export const r = eval('1');\n", 'native-dynamic "eval"'],
		['new Function', "export const f = new Function('return 1');\n", 'native-dynamic "Function"'],
		['Function()', "export const f = Function('return 1');\n", 'native-dynamic "Function"'],
		[
			'new x.constructor',
			"export const f = new (() => 1).constructor('return 1');\n",
			'native-dynamic "new .constructor()"',
		],
		[
			'new (x.constructor) in parentheses',
			"export const f = new ((() => 1).constructor)('return 1');\n",
			'native-dynamic "new .constructor()"',
		],
		[
			'import(expression)',
			'export const load = (name: string) => import(name);\n',
			'native-dynamic "import(expression)"',
		],
		['import() of a foreign driver', "export const m = import('mysql2/promise');\n", 'import "mysql2/promise"'],
		['import() of pg', "export const m = import('pg');\n", 'import "pg"'],
		[
			'import() of a foreign dialect',
			"export const m = import('drizzle-orm/mysql-core');\n",
			'import "drizzle-orm/mysql-core"',
		],
		[
			'module.require(expression)',
			'export const m = (n: string) => module.require(n);\n',
			'native-dynamic "require(expression)"',
		],
		[
			'module.require of a 0.x module',
			"export const m = module.require('../session.js');\n",
			'native-import "../session.js"',
		],
		[
			'globalThis.require(expression)',
			'export const m = (n: string) => globalThis.require(n);\n',
			'native-dynamic "require(expression)"',
		],
		['globalThis.require alias', 'export const r = globalThis.require;\n', 'native-import "require alias"'],
		[
			'createRequire()',
			"import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\n",
			'native-import "createRequire"',
		],
		['obj["require"]', "export const r = module['require'];\n", 'native-dynamic "["require"]"'],
		['module[expression]', "export const r = module['req' + 'uire'];\n", 'native-dynamic "module[expression]"'],
		[
			'(module)[expression]',
			"export const r = (module as NodeModule)!['req' + 'uire'];\n",
			'native-dynamic "module[expression]"',
		],
		['module.constructor', 'export const l = module.constructor._load;\n', 'native-dynamic "module.constructor"'],
		[
			'getBuiltinModule',
			"export const vm = process.getBuiltinModule('node:vm');\n",
			'native-dynamic "getBuiltinModule"',
		],
	])('reports %s', (_name, text, finding) => {
		const { code, errors } = run(text);
		expect(code).toBe(1);
		expect(errors.join('\n')).toContain(`src/native/planted.ts:`);
		expect(errors.join('\n')).toContain(`${finding} is not allowed in native code`);
	});

	it('passes legitimate native code', () => {
		const { code, errors } = run(
			[
				"import { readFileSync } from 'node:fs';",
				"import { sql } from 'drizzle-orm';",
				"import { quote } from './internal.js';",
				'export class Row { clone() { return new (this.constructor as new () => Row)(); } }',
				'export class Copy { copy() { return new this.constructor(); } }',
				"export const load = () => import('./internal.js');",
				"export const client = () => import('cubrid-client');",
				'export const kind = (x: object) => x.constructor.name;',
				"export const evaluate = (row: Record<string, unknown>, k: string) => row[k] ?? row['required'];",
				'export const isModule = typeof module !== "undefined" && module.exports;',
				"export const message = 'eval, new Function and require are refused here';",
				'// eval(x); import(y); module.require(z); process.getBuiltinModule(w)',
				'export { readFileSync, sql, quote };',
			].join('\n'),
		);
		expect(errors).toEqual([]);
		expect(code).toBe(0);
	});
});
