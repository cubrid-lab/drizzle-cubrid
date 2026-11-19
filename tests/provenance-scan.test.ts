import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findRuns, tokenize } from '../scripts/check-provenance.mjs';

// Controls for the similarity scan of scripts/check-provenance.mjs (#220,
// docs/PROVENANCE.md): a renamed copy of drizzle-orm code must be found, also
// after a template literal, which a plain scanner would mis-tokenise.

type Token = { raw: string; norm: string; line: number };
type Run = { file: string; start: number; end: number; tokens: number };

/** The TypeScript source of an installed drizzle-orm module, from its source map. */
function upstream(module: string): string {
	const map = JSON.parse(
		readFileSync(join(__dirname, '..', 'node_modules', 'drizzle-orm', `${module}.js.map`), 'utf8'),
	);
	return map.sourcesContent[0];
}

function runs(ours: string, theirs: string, field: 'raw' | 'norm', min: number): Run[] {
	return findRuns(
		[{ name: 'src/probe.ts', tokens: tokenize(ours) }],
		[{ name: 'upstream.ts', tokens: tokenize(theirs) }],
		field,
		min,
	);
}

const longest = (found: Run[]) => Math.max(0, ...found.map((r) => r.tokens));

/** Renames MySql to Cubrid and sql to q, and reindents with spaces. */
const disguise = (text: string) =>
	text
		.replace(/MySql/g, 'Cubrid')
		.replace(/\bsql\b/g, 'q')
		.replace(/\t/g, '  ');

describe('tokenize', () => {
	it('splits template literals and regular expressions as the parser does', () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text with a template literal, scanned, not run.
		const tokens: Token[] = tokenize('const a = `x${b}y${c}z`; const r = /a\\/b`/g; f(a); // `c`');
		expect(tokens.map((t) => t.raw)).toEqual([
			'const',
			'a',
			'=',
			'`x${',
			'b',
			'}y${',
			'c',
			'}z`',
			';',
			'const',
			'r',
			'=',
			'/a\\/b`/g',
			';',
			'f',
			'(',
			'a',
			')',
			';',
		]);
	});

	it('skips comments and JSDoc', () => {
		expect(tokenize('/** doc `x */\n// line `y\nlet a = 1; /* `z */').map((t) => t.raw)).toEqual([
			'let',
			'a',
			'=',
			'1',
			';',
		]);
	});
});

describe('similarity controls', () => {
	it('finds a renamed, reindented excerpt of mysql-core/dialect.ts', () => {
		const dialect = upstream('mysql-core/dialect');
		const excerpt = dialect.split('\n').slice(300, 420).join('\n');
		expect(longest(runs(disguise(excerpt), dialect, 'norm', 50))).toBeGreaterThan(200);
	});

	it('finds a renamed copy of MySql2Session placed after template literals', () => {
		const session = upstream('mysql2/session');
		const copy = session.slice(
			session.indexOf('export class MySql2Session'),
			session.indexOf('export class MySql2Transaction'),
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: source text with template literals, scanned, not run.
		const before = 'const message = `table ${name} has ${count} rows`;\nconst other = `x ${message} y`;\n';
		const found = runs(before + disguise(copy), session, 'norm', 50);
		expect(longest(found)).toBeGreaterThan(300);
		expect(found[0].start).toBeGreaterThanOrEqual(3);
		expect(longest(runs(before + copy, session, 'raw', 25))).toBeGreaterThan(300);
	});

	it('reports nothing for unrelated code', () => {
		const code = 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n'.repeat(3);
		expect(runs(code, upstream('mysql2/session'), 'norm', 50)).toEqual([]);
	});
});
