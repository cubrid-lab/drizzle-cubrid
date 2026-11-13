// Foreign-dialect boundary guard (#192, ADR 0003, ADR 0007).
//
// Usage:
//   node scripts/check-dialect-boundary.mjs src [--update-baseline]
//   node scripts/check-dialect-boundary.mjs package <unpacked package dir> [--update-baseline]
//   node scripts/check-dialect-boundary.mjs package --pack [--update-baseline]
//     (--pack runs `npm pack` on the built dist and scans the result)
//
// Scans drizzle-cubrid's own sources (`src`) or an unpacked npm tarball
// (`package`: the published ESM, CJS and .d.ts files) for:
//   - import:     a `drizzle-orm/...` subpath outside ADR 0007's neutral list,
//                 or a foreign database driver package
//   - identifier: a foreign dialect's class or builder name (MySqlDialect,
//                 mysqlTable, PgTable, SQLiteSession, ...) in code
//   - mode:       a foreign backend mode or dialect setting in code
//   - internal:   Drizzle-internal access in native code (src/native/**)
//                 outside src/native/internal.ts
// Comments are ignored, so explanatory text does not trip the guard.
//
// The 0.x code still depends on Drizzle's MySQL classes. Each of those
// findings is pinned in scripts/dialect-boundary-baseline.json by file, rule
// and match. Any finding not in the baseline fails, and so does a baseline
// entry that no longer occurs, so the baseline can only shrink unless a PR
// visibly regenerates it. Native code (src/native/**) can never be baselined.
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Drizzle subpaths native code may import (ADR 0007, decision 1); '' is the root. */
export const NEUTRAL_DRIZZLE_SUBPATHS = new Set([
	'',
	'casing',
	'column',
	'column-builder',
	'entity',
	'operations',
	'query-builders/select.types',
	'query-promise',
	'relations',
	'sql/sql',
	'table',
	'utils',
]);

/** Database driver packages for other backends. */
const FOREIGN_DRIVER_PACKAGES =
	/^(mysql2?|mariadb|pg|postgres|better-sqlite3|sqlite3|@libsql\/.*|@planetscale\/.*|@neondatabase\/.*|@vercel\/postgres|@tidbcloud\/.*|@electric-sql\/.*|@op-engineering\/.*|@singlestore\/.*)$/;

const FOREIGN_IDENTIFIER =
	/\b(?:MySql[A-Za-z0-9_]*|mysql(?:Table|Enum|Schema|View|TableCreator)|Pg[A-Z][A-Za-z0-9_]*|pg(?:Table|Enum|Schema|View)|SQLite[A-Za-z0-9_]*|sqlite(?:Table|View)|SingleStore[A-Za-z0-9_]*|singlestore(?:Table|Schema)|Gel[A-Z][A-Za-z0-9_]*|gel(?:Table|Schema))\b/g;

const FOREIGN_MODE =
	/(?:\bdialect\s*:\s*['"`](?:mysql|postgresql|sqlite|singlestore|gel|turso)['"`]|['"`]planetscale['"`])/g;

const NATIVE_DIR = 'src/native/';
const NATIVE_SHIM = 'src/native/internal.ts';

const INTERNAL_ACCESS = [
	{ name: "Symbol.for('drizzle:", re: /Symbol\.for\(\s*['"`]drizzle:/g },
	{ name: '.shouldDisableInsert', re: /\.shouldDisableInsert\b/g },
	{ name: 'as unknown as', re: /\bas\s+unknown\s+as\b/g },
	// `.decoder` on anything but `this`, so the dialect's own codec members pass.
	{ name: '.decoder', re: /(?<!\bthis)\.decoder\b/g },
];

const SCANNED_EXTENSIONS = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;

// After these characters a `/` starts a regular expression, not a division.
const REGEX_PREFIX = new Set([
	'',
	'(',
	',',
	'=',
	':',
	'[',
	'!',
	'&',
	'|',
	'?',
	'{',
	'}',
	';',
	'+',
	'-',
	'*',
	'%',
	'<',
	'>',
	'~',
	'^',
]);

/**
 * Removes comments; keeps strings, template literals and regular expressions
 * intact so quotes inside them are not mistaken for strings. Line structure is
 * preserved so findings keep their line numbers.
 */
export function stripComments(text) {
	let out = '';
	let i = 0;
	const prevSignificant = () => {
		const trimmed = out.trimEnd();
		if (/\breturn$|\btypeof$|\bcase$|\bin$|\bof$/.test(trimmed)) return '(';
		return trimmed.slice(-1);
	};
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === '/' && next !== '/' && next !== '*' && REGEX_PREFIX.has(prevSignificant())) {
			let inClass = false;
			out += c;
			i++;
			while (i < text.length && text[i] !== '\n') {
				const ch = text[i];
				out += ch;
				i++;
				if (ch === '\\') {
					out += text[i] ?? '';
					i++;
				} else if (ch === '[') inClass = true;
				else if (ch === ']') inClass = false;
				else if (ch === '/' && !inClass) break;
			}
			continue;
		}
		if (c === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
				if (text[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			out += c;
			i++;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === '\\') {
					out += text[i] + (text[i + 1] ?? '');
					i += 2;
					continue;
				}
				out += text[i];
				i++;
			}
			out += text[i] ?? '';
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(['"])([^'"]+)\1/g;

function lineOf(text, index) {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * Findings for one file. `file` is the path relative to the scan root, with
 * forward slashes; `scope` is 'src' or 'package'.
 */
export function scanText(file, text, scope = 'src') {
	const code = stripComments(text);
	const findings = [];
	const add = (rule, match, index) => findings.push({ file, rule, match, line: lineOf(code, index) });

	for (const m of code.matchAll(SPECIFIER)) {
		const spec = m[2];
		if (spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/')) {
			const sub = spec === 'drizzle-orm' ? '' : spec.slice('drizzle-orm/'.length).replace(/\.(?:js|cjs|mjs)$/, '');
			if (!NEUTRAL_DRIZZLE_SUBPATHS.has(sub)) add('import', spec, m.index);
		} else if (FOREIGN_DRIVER_PACKAGES.test(spec)) {
			add('import', spec, m.index);
		}
	}
	for (const m of code.matchAll(FOREIGN_IDENTIFIER)) add('identifier', m[0], m.index);
	for (const m of code.matchAll(FOREIGN_MODE)) add('mode', m[0].replace(/\s+/g, ' '), m.index);

	if (scope === 'src' && file.startsWith(NATIVE_DIR) && file !== NATIVE_SHIM) {
		for (const { name, re } of INTERNAL_ACCESS) {
			for (const m of code.matchAll(re)) add('internal', name, m.index);
		}
	}
	return findings;
}

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === 'node_modules') continue;
		if (statSync(full).isDirectory()) files.push(...walk(full));
		else if (SCANNED_EXTENSIONS.test(entry)) files.push(full);
	}
	return files;
}

/** Scans every source file under `root/dirName` and returns findings keyed relative to `root`. */
export function scanTree(root, dirName, scope) {
	const base = join(root, dirName);
	if (!existsSync(base)) throw new Error(`Nothing to scan: ${base} does not exist`);
	const files = walk(base);
	if (files.length === 0) throw new Error(`Nothing to scan: no source files under ${base}`);
	return files.flatMap((full) =>
		scanText(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'), scope),
	);
}

function key(entry) {
	return `${entry.scope}\u0000${entry.file}\u0000${entry.rule}\u0000${entry.match}`;
}

/** Groups findings into baseline entries with counts. */
export function summarize(findings, scope) {
	const counts = new Map();
	for (const f of findings) {
		const k = key({ scope, ...f });
		const prev = counts.get(k);
		if (prev) prev.count++;
		else counts.set(k, { scope, file: f.file, rule: f.rule, match: f.match, count: 1 });
	}
	return [...counts.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Compares findings with the baseline entries of the same scope. Returns the
 * problems: new or increased findings, stale entries, and any finding in
 * native code (never allowed).
 */
export function compare(findings, baselineEntries, scope) {
	const problems = [];
	const actual = summarize(findings, scope);
	const allowed = new Map(baselineEntries.filter((e) => e.scope === scope).map((e) => [key(e), e]));

	for (const entry of baselineEntries) {
		if (entry.scope === 'src' && entry.file.startsWith(NATIVE_DIR)) {
			problems.push(`baseline entry for native code is not allowed: ${entry.file} ${entry.rule} ${entry.match}`);
		}
	}
	for (const a of actual) {
		const lines = findings
			.filter((f) => f.file === a.file && f.rule === a.rule && f.match === a.match)
			.map((f) => f.line)
			.join(', ');
		if (a.scope === 'src' && a.file.startsWith(NATIVE_DIR)) {
			problems.push(`${a.file}:${lines} ${a.rule} "${a.match}" is not allowed in native code`);
			allowed.delete(key(a));
			continue;
		}
		const b = allowed.get(key(a));
		if (!b) problems.push(`${a.file}:${lines} new ${a.rule} "${a.match}" (x${a.count})`);
		else if (a.count > b.count)
			problems.push(`${a.file}:${lines} ${a.rule} "${a.match}" rose from ${b.count} to ${a.count}`);
		else if (a.count < b.count)
			problems.push(
				`${a.file} ${a.rule} "${a.match}" fell from ${b.count} to ${a.count}: shrink the baseline (--update-baseline)`,
			);
		allowed.delete(key(a));
	}
	for (const stale of allowed.values()) {
		problems.push(
			`${stale.file} ${stale.rule} "${stale.match}" no longer occurs: remove it from the baseline (--update-baseline)`,
		);
	}
	return problems;
}

const BASELINE = fileURLToPath(new URL('./dialect-boundary-baseline.json', import.meta.url));

function main(argv) {
	const [scope, dir, ...rest] = argv;
	const update = argv.includes('--update-baseline');
	let findings;
	if (scope === 'src') {
		findings = scanTree(fileURLToPath(new URL('..', import.meta.url)), 'src', 'src');
	} else if (scope === 'package' && dir === '--pack') {
		const repo = fileURLToPath(new URL('..', import.meta.url));
		const tmp = mkdtempSync(join(tmpdir(), 'dialect-boundary-'));
		try {
			const [packed] = JSON.parse(
				execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], {
					cwd: repo,
					encoding: 'utf8',
				}),
			);
			execFileSync('tar', ['-xzf', join(tmp, packed.filename), '-C', tmp]);
			findings = scanTree(join(tmp, 'package'), '.', 'package');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	} else if (scope === 'package' && dir && dir !== '--update-baseline') {
		findings = scanTree(dir, '.', 'package');
	} else {
		console.error('Usage: check-dialect-boundary.mjs src | package <dir> | package --pack [--update-baseline]');
		return 2;
	}
	void rest;
	const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { entries: [] };

	if (update) {
		const native = findings.filter((f) => scope === 'src' && f.file.startsWith(NATIVE_DIR));
		if (native.length > 0) {
			for (const f of native) console.error(`${f.file}:${f.line} ${f.rule} "${f.match}" is not allowed in native code`);
			return 1;
		}
		const others = baseline.entries.filter((e) => e.scope !== scope);
		baseline.entries = [...others, ...summarize(findings, scope)].sort((a, b) => key(a).localeCompare(key(b)));
		writeFileSync(BASELINE, `${JSON.stringify(baseline, null, '\t')}\n`);
		console.log(`Baseline updated for ${scope}: ${summarize(findings, scope).length} entries`);
		return 0;
	}

	const problems = compare(findings, baseline.entries, scope);
	const debt = summarize(findings, scope);
	const files = new Set(debt.map((d) => d.file)).size;
	const line = `Foreign-dialect boundary (${scope}): ${findings.length} known 0.x findings in ${files} files, ${problems.length} problems`;
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
	for (const p of problems) console.error(`::error::${p}`);
	return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2));
}
