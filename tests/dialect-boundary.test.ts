import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { compare, scanText, scanTree, stripComments, summarize } from '../scripts/check-dialect-boundary.mjs';
import baseline from '../scripts/dialect-boundary-baseline.json';

// Canaries for the foreign-dialect boundary guard (#192, ADR 0003, ADR 0007):
// each rule must catch a deliberately introduced violation.

const rules = (file: string, text: string, scope = 'src') =>
	scanText(file, text, scope).map((f: { rule: string; match: string }) => `${f.rule}:${f.match}`);

describe('import rule', () => {
	it('catches foreign dialect and driver imports in every syntax', () => {
		expect(rules('src/a.ts', "import { mysqlTable } from 'drizzle-orm/mysql-core';")).toContain(
			'import:drizzle-orm/mysql-core',
		);
		expect(rules('src/a.ts', "export * from 'drizzle-orm/pg-core';")).toContain('import:drizzle-orm/pg-core');
		expect(rules('src/a.ts', "const m = await import('drizzle-orm/sqlite-core');")).toContain(
			'import:drizzle-orm/sqlite-core',
		);
		expect(rules('dist/index.cjs', 'var x = require("drizzle-orm/singlestore-core/index.js");', 'package')).toContain(
			'import:drizzle-orm/singlestore-core/index.js',
		);
		expect(rules('src/a.ts', "import 'drizzle-orm/mysql2';")).toContain('import:drizzle-orm/mysql2');
		expect(rules('src/a.ts', "import mysql from 'mysql2';")).toContain('import:mysql2');
		expect(rules('src/a.ts', "import { Pool } from 'pg';")).toContain('import:pg');
	});

	it('catches Drizzle subpaths outside the neutral list, including internal caches', () => {
		expect(rules('src/a.ts', "import type { Cache } from 'drizzle-orm/cache/core/cache';")).toEqual([
			'import:drizzle-orm/cache/core/cache',
		]);
		expect(rules('src/a.ts', "import { DrizzleError } from 'drizzle-orm/errors';")).toEqual([
			'import:drizzle-orm/errors',
		]);
	});

	it('allows the root entry and the neutral subpaths of ADR 0007', () => {
		const neutral = [
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
		];
		for (const spec of neutral) {
			expect(rules('src/a.ts', `import { x } from '${spec}';`)).toEqual([]);
		}
		expect(rules('src/a.ts', "import { createClient } from 'cubrid-client';")).toEqual([]);
	});
});

describe('identifier and mode rules', () => {
	it('catches foreign dialect class and builder names in code', () => {
		const found = rules(
			'src/a.ts',
			'class D extends MySqlDialect {}\nconst t = mysqlTable("t", {});\nlet p: PgTable; let s: SQLiteSession; let g: SingleStoreTable;',
		);
		expect(found).toEqual(
			expect.arrayContaining([
				'identifier:MySqlDialect',
				'identifier:mysqlTable',
				'identifier:PgTable',
				'identifier:SQLiteSession',
				'identifier:SingleStoreTable',
			]),
		);
	});

	it('catches foreign backend modes and dialect settings', () => {
		expect(rules('src/a.ts', "drizzle(client, { mode: 'planetscale' });")).toEqual(["mode:'planetscale'"]);
		expect(rules('drizzle.config.ts', "export default { dialect: 'mysql' };")).toEqual(["mode:dialect: 'mysql'"]);
	});

	it('ignores comments, but not code next to them', () => {
		expect(
			rules('src/a.ts', "// Drizzle's MySqlDialect uses mode: 'planetscale'\n/* mysqlTable */ const a = 1;"),
		).toEqual([]);
		expect(rules('src/a.ts', '/* note */ class D extends MySqlDialect {}')).toEqual(['identifier:MySqlDialect']);
	});
});

describe('comment stripping', () => {
	it('keeps strings, template literals and regular expressions intact', () => {
		const text =
			"const r = /`[^`]*`|'(?:[^']|'')*'|\\/\\/[^\\n]*/g; // gone\nconst u = 'https://x//y'; const d = a / b;";
		expect(stripComments(text)).toBe(
			"const r = /`[^`]*`|'(?:[^']|'')*'|\\/\\/[^\\n]*/g; \nconst u = 'https://x//y'; const d = a / b;",
		);
	});

	it('does not let quotes inside a regular expression hide later code', () => {
		const text = 'const r = /[\'"`]/g;\nclass D extends MySqlDialect {}';
		expect(rules('src/a.ts', text)).toEqual(['identifier:MySqlDialect']);
	});

	it('keeps line numbers for findings after block comments', () => {
		const [finding] = scanText('src/a.ts', '/*\n\n*/\nclass D extends MySqlDialect {}');
		expect(finding?.line).toBe(4);
	});
});

describe('internal rule (native code only)', () => {
	const internalUse = [
		"const columns = table[Symbol.for('drizzle:Columns')];",
		'if (column.shouldDisableInsert()) skip();',
		'const t = table as unknown as Record<symbol, unknown>;',
		'const decode = field.decoder;',
	].join('\n');

	it('catches Drizzle internal access in src/native outside the shim', () => {
		expect(rules('src/native/select.ts', internalUse)).toEqual([
			"internal:Symbol.for('drizzle:",
			'internal:.shouldDisableInsert',
			'internal:as unknown as',
			'internal:.decoder',
		]);
	});

	it("allows it in the shim, in 0.x code and for the dialect's own this.decoder", () => {
		expect(rules('src/native/internal.ts', internalUse)).toEqual([]);
		expect(rules('src/session.ts', internalUse)).toEqual([]);
		expect(rules('src/native/codec.ts', 'return this.decoder(value);')).toEqual([]);
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
		expect(compare([finding('src/a.ts'), finding('src/a.ts'), finding('src/a.ts')], known, 'src')[0]).toMatch(
			/rose from 2 to 3/,
		);
		expect(compare([finding('src/a.ts')], known, 'src')[0]).toMatch(/fell from 2 to 1: shrink the baseline/);
		expect(compare([], known, 'src')[0]).toMatch(/no longer occurs/);
	});

	it('never accepts findings in native code, baselined or not', () => {
		const native = finding('src/native/table.ts');
		const known = summarize([native], 'src');
		expect(compare([native], known, 'src')).toEqual([
			'baseline entry for native code is not allowed: src/native/table.ts import drizzle-orm/mysql-core',
			'src/native/table.ts:1 import "drizzle-orm/mysql-core" is not allowed in native code',
		]);
	});

	it('keeps src and package baselines apart', () => {
		const known = summarize([finding('dist/index.js')], 'package');
		expect(compare([finding('dist/index.js')], known, 'src')[0]).toMatch(/new import/);
	});
});

describe('repository scan', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it('matches the checked-in baseline for src', () => {
		const findings = scanTree(join(__dirname, '..'), 'src', 'src');
		expect(compare(findings, baseline.entries, 'src')).toEqual([]);
	});

	it('detects a banned import planted in a copy of the source tree', () => {
		dir = mkdtempSync(join(tmpdir(), 'boundary-'));
		mkdirSync(join(dir, 'src', 'native'), { recursive: true });
		writeFileSync(join(dir, 'src', 'native', 'table.ts'), "import { mysqlTable } from 'drizzle-orm/mysql-core';\n");
		const problems = compare(scanTree(dir, 'src', 'src'), [], 'src');
		expect(problems.sort()).toEqual([
			'src/native/table.ts:1 identifier "mysqlTable" is not allowed in native code',
			'src/native/table.ts:1 import "drizzle-orm/mysql-core" is not allowed in native code',
		]);
	});

	it('refuses to report success when there is nothing to scan', () => {
		dir = mkdtempSync(join(tmpdir(), 'boundary-'));
		expect(() => scanTree(dir as string, 'src', 'src')).toThrow(/Nothing to scan/);
	});
});
