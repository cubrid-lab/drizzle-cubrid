// Foreign-dialect boundary guard (#192, ADR 0003, ADR 0007).
//
// Usage:
//   node scripts/check-dialect-boundary.mjs src [--update-baseline]
//   node scripts/check-dialect-boundary.mjs package <unpacked package dir> [--update-baseline]
//   node scripts/check-dialect-boundary.mjs package --pack [--update-baseline]
//     (--pack runs `npm pack` on the built dist and scans the result)
//   --baseline=<path> uses another baseline file (for tests)
//
// Files are parsed with the TypeScript compiler, so comments never count and
// strings, template literals and regular expressions cannot hide code.
// Rules:
//   - import:     a module specifier (import, export ... from, import(),
//                 require(), import x = require(), import("…") types,
//                 /// <reference types>, or a loader call with a string)
//                 naming a drizzle-orm subpath outside ADR 0007's neutral
//                 list or a driver package for another database
//   - identifier: a foreign dialect's class or builder name (MySqlDialect,
//                 mysqlTable, PgTable, SQLiteSession, ...), as an identifier
//                 or a whole string
//   - mode:       a foreign backend mode or `dialect` setting
//   - internal:   in native code (src/native/**) outside src/native/internal.ts,
//                 Drizzle internal access: Symbol.for('drizzle:…'),
//                 .shouldDisableInsert, .decoder on anything but `this`
//                 (also destructured or via Reflect.get), and any cast
//                 through `unknown`, `any` or `never`
//   - native-import: in native code, an import that leaves src/native through
//                 a relative path, the `~/` alias or the package's own name,
//                 since the 0.x modules are built on Drizzle's MySQL classes
//
// The 0.x code still depends on Drizzle's MySQL classes. Each of those
// findings is pinned in scripts/dialect-boundary-baseline.json by scope,
// file, rule and match, with a count. A new or larger finding fails, and so
// does an entry that no longer occurs, so the baseline only shrinks unless a
// PR visibly regenerates it. Native code (src/native/**) can never be
// baselined.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

/** Driver packages for other databases, with any subpath (mysql2/promise, pg/lib). */
const FOREIGN_DRIVER =
	/^(?:mysql2?|mariadb|pg|pg-native|postgres|better-sqlite3|sqlite3|@libsql\/[^/]+|@planetscale\/[^/]+|@neondatabase\/[^/]+|@vercel\/postgres|@tidbcloud\/[^/]+|@electric-sql\/[^/]+|@op-engineering\/[^/]+|@singlestore\/[^/]+)(?:\/.*)?$/;

/** A foreign dialect's class, builder or column-type name. */
const FOREIGN_NAME =
	/^(?:(?:MySql|MySQL|MYSQL|Mysql|mysql)(?:[A-Z0-9_]|$)|(?:Pg|PG)(?:[A-Z]|$)|pg(?:Table|Enum|Schema|View|Core)|(?:SQLite|Sqlite|sqlite)(?:[A-Z]|$)|(?:SingleStore|Singlestore|singlestore)(?:[A-Z]|$)|(?:Gel|gel)(?:Table|Schema|Column|Dialect|Session|Database|[A-Z][a-z]+Builder))/;

const FOREIGN_DIALECT_SETTING = /^(?:mysql2?|postgres(?:ql)?|pg|sqlite|singlestore|gel|turso|planetscale)$/i;

const NATIVE_DIR = 'src/native/';
const NATIVE_SHIM = 'src/native/internal.ts';

/** The banned specifier, or undefined when it is allowed. */
export function bannedSpecifier(spec) {
	if (spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/')) {
		const sub =
			spec === 'drizzle-orm' ? '' : spec.slice('drizzle-orm/'.length).replace(/(?:\/index)?\.(?:js|cjs|mjs)$/, '');
		return NEUTRAL_DRIZZLE_SUBPATHS.has(sub) ? undefined : spec;
	}
	return FOREIGN_DRIVER.test(spec) ? spec : undefined;
}

function scriptKind(file) {
	return /\.(?:ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function stringValue(node) {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/**
 * Findings for one file. `file` is the path relative to the scan root, with
 * forward slashes; `scope` is 'src' or 'package'.
 */
export function scanText(file, text, scope = 'src') {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
	const inNative = scope === 'src' && file.startsWith(NATIVE_DIR);
	const checkInternals = inNative && file !== NATIVE_SHIM;
	const findings = [];
	const add = (rule, match, pos) => {
		findings.push({ file, rule, match, line: source.getLineAndCharacterOfPosition(pos).line + 1 });
	};

	const checkSpecifier = (spec, pos) => {
		const banned = bannedSpecifier(spec);
		if (banned) add('import', banned, pos);
		if (inNative) {
			// Native code may import only within src/native: not through a relative
			// path, the `~/` alias for src/, or the package's own name, all of
			// which reach the MySQL-based 0.x modules.
			let target;
			if (spec.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), spec));
			else if (spec.startsWith('~/')) target = posix.normalize(`src/${spec.slice(2)}`);
			if (spec === 'drizzle-cubrid' || spec.startsWith('drizzle-cubrid/')) add('native-import', spec, pos);
			else if (target !== undefined && !target.startsWith(NATIVE_DIR)) add('native-import', spec, pos);
		}
	};

	for (const ref of [...source.typeReferenceDirectives, ...source.referencedFiles]) {
		checkSpecifier(ref.fileName, ref.pos);
	}

	const visit = (node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
			const spec = stringValue(node.moduleSpecifier);
			if (spec !== undefined) checkSpecifier(spec, node.moduleSpecifier.getStart(source));
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const spec = stringValue(node.moduleReference.expression);
			if (spec !== undefined) checkSpecifier(spec, node.moduleReference.expression.getStart(source));
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			const spec = stringValue(node.argument.literal);
			if (spec !== undefined) checkSpecifier(spec, node.argument.getStart(source));
		} else if (ts.isCallExpression(node)) {
			// import('x'), require('x'), createRequire(...)('x'), or any other
			// loader-shaped call whose first argument is a string.
			const spec = stringValue(node.arguments[0]);
			const callee = node.expression;
			const loader =
				callee.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(callee) || ts.isCallExpression(callee);
			const nativeLocal = inNative && /^(?:\.|~\/|drizzle-cubrid(?:\/|$))/.test(spec ?? '');
			if (spec !== undefined && loader && (bannedSpecifier(spec) || nativeLocal)) {
				checkSpecifier(spec, node.arguments[0].getStart(source));
			}
		}

		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
			if (FOREIGN_NAME.test(node.text)) add('identifier', node.text, node.getStart(source));
		} else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			if (/^[A-Za-z_$][\w$]*$/.test(node.text) && FOREIGN_NAME.test(node.text)) {
				add('identifier', node.text, node.getStart(source));
			}
			if (node.text === 'planetscale') add('mode', 'planetscale', node.getStart(source));
		}

		if (ts.isPropertyAssignment(node)) {
			const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
			const value = stringValue(node.initializer);
			if (name === 'dialect' && value !== undefined && FOREIGN_DIALECT_SETTING.test(value)) {
				add('mode', `dialect: ${value}`, node.getStart(source));
			}
		}

		if (checkInternals) {
			const notThis = (expr) => expr.kind !== ts.SyntaxKind.ThisKeyword;
			if (ts.isPropertyAccessExpression(node)) {
				if (node.name.text === 'shouldDisableInsert')
					add('internal', '.shouldDisableInsert', node.name.getStart(source));
				if (node.name.text === 'decoder' && notThis(node.expression))
					add('internal', '.decoder', node.name.getStart(source));
			} else if (ts.isElementAccessExpression(node)) {
				const name = stringValue(node.argumentExpression);
				if (name === 'shouldDisableInsert') add('internal', '.shouldDisableInsert', node.getStart(source));
				if (name === 'decoder' && notThis(node.expression)) add('internal', '.decoder', node.getStart(source));
			} else if (ts.isCallExpression(node)) {
				const callee = node.expression;
				const isSymbolFor =
					(ts.isPropertyAccessExpression(callee) &&
						callee.name.text === 'for' &&
						callee.expression.getText(source) === 'Symbol') ||
					(ts.isElementAccessExpression(callee) &&
						stringValue(callee.argumentExpression) === 'for' &&
						callee.expression.getText(source) === 'Symbol');
				const symbolKey = stringValue(node.arguments[0]);
				if (isSymbolFor && (symbolKey === undefined || symbolKey.startsWith('drizzle:'))) {
					add('internal', "Symbol.for('drizzle:", node.getStart(source));
				}
			} else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
				// `as unknown`, `as any` and `as never` all let a cast reach any member.
				const kind = node.type.kind;
				if (kind === ts.SyntaxKind.UnknownKeyword) add('internal', 'cast through unknown', node.getStart(source));
				else if (kind === ts.SyntaxKind.AnyKeyword) add('internal', 'cast through any', node.getStart(source));
				else if (kind === ts.SyntaxKind.NeverKeyword) add('internal', 'cast through never', node.getStart(source));
			} else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
				// const { decoder } = sql
				const property = node.propertyName ?? node.name;
				const name = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
				if (name === 'decoder' || name === 'shouldDisableInsert') add('internal', `.${name}`, node.getStart(source));
			}
			if (
				ts.isCallExpression(node) &&
				node.expression.getText(source) === 'Reflect.get' &&
				['decoder', 'shouldDisableInsert'].includes(stringValue(node.arguments[1]) ?? '')
			) {
				add('internal', `.${stringValue(node.arguments[1])}`, node.getStart(source));
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(source);
	return findings;
}

const SCANNED = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) files.push(...walk(full));
		else if (SCANNED.test(entry)) files.push(full);
	}
	return files;
}

/** Scans every source file under `root/dirName` and returns findings keyed relative to `root`. */
export function scanTree(root, dirName, scope) {
	const base = join(root, dirName);
	let files;
	try {
		files = walk(base);
	} catch (error) {
		throw new Error(`Nothing to scan: ${base} cannot be read (${error.code ?? error.message})`);
	}
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
	const allowed = new Map(baselineEntries.filter((e) => e.scope === scope).map((e) => [key(e), e]));

	for (const entry of baselineEntries) {
		if (entry.scope === 'src' && entry.file.startsWith(NATIVE_DIR)) {
			problems.push(`baseline entry for native code is not allowed: ${entry.file} ${entry.rule} ${entry.match}`);
		}
	}
	for (const a of summarize(findings, scope)) {
		const lines = findings
			.filter((f) => f.file === a.file && f.rule === a.rule && f.match === a.match)
			.map((f) => f.line)
			.join(', ');
		const b = allowed.get(key(a));
		allowed.delete(key(a));
		if (a.scope === 'src' && a.file.startsWith(NATIVE_DIR)) {
			problems.push(`${a.file}:${lines} ${a.rule} "${a.match}" is not allowed in native code`);
		} else if (!b) {
			problems.push(`${a.file}:${lines} new ${a.rule} "${a.match}" (x${a.count})`);
		} else if (a.count > b.count) {
			problems.push(`${a.file}:${lines} ${a.rule} "${a.match}" rose from ${b.count} to ${a.count}`);
		} else if (a.count < b.count) {
			problems.push(
				`${a.file} ${a.rule} "${a.match}" fell from ${b.count} to ${a.count}: shrink the baseline (--update-baseline)`,
			);
		}
	}
	for (const stale of allowed.values()) {
		problems.push(
			`${stale.file} ${stale.rule} "${stale.match}" no longer occurs: remove it from the baseline (--update-baseline)`,
		);
	}
	return problems;
}

const DEFAULT_BASELINE = fileURLToPath(new URL('./dialect-boundary-baseline.json', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

function readBaseline(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return { entries: [] };
		throw error;
	}
}

function scanPacked(repo) {
	const tmp = mkdtempSync(join(tmpdir(), 'dialect-boundary-'));
	try {
		const [packed] = JSON.parse(
			execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], {
				cwd: repo,
				encoding: 'utf8',
			}),
		);
		execFileSync('tar', ['-xzf', join(tmp, packed.filename), '-C', tmp]);
		return scanTree(join(tmp, 'package'), '.', 'package');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Runs the check and returns the exit code: 0 clean, 1 problems, 2 usage
 * error. `options.root` and `options.baseline` let tests use a temporary tree.
 */
export function main(argv, options = {}) {
	const root = options.root ?? REPO;
	const baselineFlag = argv.find((a) => a.startsWith('--baseline='));
	const baselinePath = options.baseline ?? (baselineFlag ? baselineFlag.slice('--baseline='.length) : DEFAULT_BASELINE);
	const update = argv.includes('--update-baseline');
	const args = argv.filter((a) => a !== '--update-baseline' && a !== baselineFlag);
	const [scope, dir] = args;
	let findings;
	try {
		if (scope === 'src' && args.length === 1) findings = scanTree(root, 'src', 'src');
		else if (scope === 'package' && dir === '--pack' && args.length === 2) findings = scanPacked(root);
		else if (scope === 'package' && dir && args.length === 2) findings = scanTree(dir, '.', 'package');
		else {
			console.error('Usage: check-dialect-boundary.mjs src | package <dir> | package --pack [--update-baseline]');
			return 2;
		}
	} catch (error) {
		console.error(`::error::${error.message}`);
		return 1;
	}
	const baseline = readBaseline(baselinePath);

	if (update) {
		const native = findings.filter((f) => scope === 'src' && f.file.startsWith(NATIVE_DIR));
		if (native.length > 0) {
			for (const f of native) console.error(`${f.file}:${f.line} ${f.rule} "${f.match}" is not allowed in native code`);
			return 1;
		}
		const fresh = summarize(findings, scope);
		baseline.entries = [...baseline.entries.filter((e) => e.scope !== scope), ...fresh].sort((a, b) =>
			key(a).localeCompare(key(b)),
		);
		writeFileSync(baselinePath, `${JSON.stringify(baseline, null, '\t')}\n`);
		console.log(`Baseline updated for ${scope}: ${fresh.length} entries`);
		return 0;
	}

	const problems = compare(findings, baseline.entries, scope);
	const files = new Set(findings.map((f) => f.file)).size;
	const line = `Foreign-dialect boundary (${scope}): ${findings.length} known 0.x findings in ${files} files, ${problems.length} problems`;
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
	for (const p of problems) console.error(`::error::${p}`);
	return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2));
}
