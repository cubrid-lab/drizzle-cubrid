// Provenance and distribution checks (#220, docs/PROVENANCE.md).
//
// Usage:
//   node scripts/check-provenance.mjs pack
//     Packs the built package (run `npm run build` first) with `npm pack` and
//     checks what would be published, network-free: only package.json,
//     README.md, LICENSE, THIRD_PARTY_NOTICES.md and dist/**, with every entry
//     file; LICENSE is the MIT text; THIRD_PARTY_NOTICES.md carries the
//     Apache-2.0 text and dist/legacy.* keeps the attribution comment of the
//     0.x files; drizzle-orm and cubrid-client are peer dependencies, imported
//     and not bundled; every source map lists only files under src/ (esbuild
//     lists every bundled input, so a bundled dependency would appear as
//     node_modules/...) and embeds them as they are in the repository.
//
//   node scripts/check-provenance.mjs similarity [--version=<v>]... [--upstream=<dir>]...
//       [--min-raw=<tokens>] [--min-normalized=<tokens>]
//     Compares src/**/*.ts with drizzle-orm's TypeScript source and prints
//     every run of identical tokens at least --min-raw tokens long (default
//     50), and every run of the same token shape (identifiers, strings and
//     numbers normalised) at least --min-normalized tokens long (default
//     100). Comments and whitespace never count. Each --version downloads that
//     drizzle-orm release with `npm pack` (network) and reads the TypeScript
//     source embedded in its source maps; each --upstream reads .ts files from
//     a directory instead. Defaults to the installed drizzle-orm version.
//     Hits are leads for a manual review, not findings: record the review in
//     docs/PROVENANCE.md. Exits 1 when there is a hit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTERNALS = ['drizzle-orm', 'cubrid-client'];
const ENTRIES = ['index', 'legacy', 'native-migrator'];
const TOP_LEVEL = ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const REQUIRED = [
	...TOP_LEVEL,
	...ENTRIES.flatMap((e) => ['.js', '.cjs', '.d.ts', '.d.cts', '.js.map', '.cjs.map'].map((x) => `dist/${e}${x}`)),
];

function walk(dir, filter, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules') walk(path, filter, out);
		} else if (filter(path)) out.push(path);
	}
	return out;
}

function packInto(cwd, spec, dest) {
	const [packed] = JSON.parse(
		execFileSync('npm', ['pack', ...(spec ? [spec] : []), '--ignore-scripts', '--json', '--pack-destination', dest], {
			cwd,
			encoding: 'utf8',
		}),
	);
	execFileSync('tar', ['-xzf', join(dest, packed.filename), '-C', dest]);
	return join(dest, 'package');
}

function checkPack() {
	const problems = [];
	const tmp = mkdtempSync(join(tmpdir(), 'provenance-'));
	try {
		const pkg = packInto(REPO, null, tmp);
		const files = walk(pkg, () => true).map((f) => relative(pkg, f).split(sep).join('/'));
		for (const file of REQUIRED) if (!files.includes(file)) problems.push(`missing from the package: ${file}`);
		for (const file of files) {
			if (!TOP_LEVEL.includes(file) && !file.startsWith('dist/')) {
				problems.push(`unexpected file in the package: ${file}`);
			}
		}
		const license = readFileSync(join(pkg, 'LICENSE'), 'utf8');
		if (!license.startsWith('MIT License') || !/^Copyright \(c\) /m.test(license)) {
			problems.push('LICENSE is not the MIT license text with a copyright line');
		}
		const notices = readFileSync(join(pkg, 'THIRD_PARTY_NOTICES.md'), 'utf8');
		if (
			!notices.includes('Apache License') ||
			!notices.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
		) {
			problems.push('THIRD_PARTY_NOTICES.md does not carry the Apache-2.0 license text');
		}
		const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
		if (manifest.license !== 'MIT') problems.push(`package.json license is ${manifest.license}, not MIT`);
		for (const name of EXTERNALS) {
			if (manifest.dependencies?.[name] || !manifest.peerDependencies?.[name]) {
				problems.push(`${name} must be a peer dependency only`);
			}
		}
		for (const file of files.filter((f) => /\.c?js$/.test(f))) {
			const code = readFileSync(join(pkg, file), 'utf8');
			// drizzle-orm's own classes carry these entityKind names; drizzle-cubrid's never do.
			if (/\[(?:\w+\.)?entityKind\]\s*=\s*["'](?:SQL|Table|Column|MySqlDialect|MySqlSession)["']/.test(code)) {
				problems.push(`${file}: contains drizzle-orm classes (bundled instead of imported)`);
			}
			// The Apache-2.0 attribution of the 0.x files (THIRD_PARTY_NOTICES.md) must survive bundling.
			if (/^dist\/legacy\.c?js$/.test(file) && !code.includes('Apache License, Version 2.0')) {
				problems.push(`${file}: lost the drizzle-orm attribution comment of src/session.ts and src/driver.ts`);
			}
		}
		for (const file of files.filter((f) => f.endsWith('.map'))) {
			const map = JSON.parse(readFileSync(join(pkg, file), 'utf8'));
			const base = dirname(file);
			for (const source of map.sources ?? []) {
				const resolved = normalize(join(base, source)).split(sep).join('/');
				if (!resolved.startsWith('src/') || resolved.includes('node_modules')) {
					problems.push(`${file}: bundles ${source}, which is not repository source`);
				}
			}
			(map.sources ?? []).forEach((source, i) => {
				const local = join(REPO, normalize(join(base, source)));
				const content = map.sourcesContent?.[i];
				if (content != null && existsSync(local) && readFileSync(local, 'utf8') !== content) {
					problems.push(`${file}: embedded source of ${source} differs from the repository file (stale build?)`);
				}
			});
		}
		console.log(`packed ${manifest.name}@${manifest.version}: ${files.length} files`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	return problems;
}

/** Tokens with comments and whitespace removed: { raw, norm, line }. */
function tokenize(text) {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const lineOf = (pos) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	const out = [];
	let kind = scanner.scan();
	while (kind !== ts.SyntaxKind.EndOfFileToken) {
		const raw = scanner.getTokenText();
		let norm = raw;
		if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) norm = 'I';
		else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) norm = 'S';
		else if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) norm = 'N';
		else if (kind >= ts.SyntaxKind.TemplateHead && kind <= ts.SyntaxKind.TemplateTail) norm = 'T';
		out.push({ raw, norm, line: lineOf(scanner.getTokenStart()) });
		kind = scanner.scan();
	}
	return out;
}

function upstreamFromVersion(version, tmp) {
	const dest = mkdtempSync(join(tmp, `drizzle-orm-${version}-`));
	const pkg = packInto(tmp, `drizzle-orm@${version}`, dest);
	const files = [];
	for (const mapFile of walk(pkg, (p) => p.endsWith('.js.map'))) {
		const map = JSON.parse(readFileSync(mapFile, 'utf8'));
		(map.sources ?? []).forEach((source, i) => {
			const content = map.sourcesContent?.[i];
			if (content == null) return;
			const path = normalize(join(dirname(relative(pkg, mapFile)), source))
				.split(sep)
				.join('/')
				.replace(/^(\.\.\/)+/, '');
			files.push({ name: `drizzle-orm@${version}/${path}`, text: content });
		});
	}
	return files;
}

function upstreamFromDir(dir) {
	return walk(dir, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts')).map((p) => ({
		name: relative(dir, p).split(sep).join('/'),
		text: readFileSync(p, 'utf8'),
	}));
}

function findRuns(ours, theirs, field, min) {
	const K = 20;
	const index = new Map();
	for (const file of theirs) {
		for (let j = 0; j + K <= file.tokens.length; j++) {
			const key = file.tokens
				.slice(j, j + K)
				.map((t) => t[field])
				.join('\u0000');
			const list = index.get(key);
			if (!list) index.set(key, [[file, j]]);
			else if (list.length < 64) list.push([file, j]);
		}
	}
	const runs = [];
	for (const file of ours) {
		const tokens = file.tokens;
		let i = 0;
		while (i + K <= tokens.length) {
			const key = tokens
				.slice(i, i + K)
				.map((t) => t[field])
				.join('\u0000');
			let best = null;
			for (const [other, j] of index.get(key) ?? []) {
				let n = K;
				while (
					i + n < tokens.length &&
					j + n < other.tokens.length &&
					tokens[i + n][field] === other.tokens[j + n][field]
				)
					n++;
				if (!best || n > best.n) best = { other, j, n };
			}
			if (best && best.n >= min) {
				runs.push({
					ours: `${file.name}:${tokens[i].line}-${tokens[i + best.n - 1].line}`,
					theirs: `${best.other.name}:${best.other.tokens[best.j].line}-${best.other.tokens[best.j + best.n - 1].line}`,
					tokens: best.n,
					text: tokens
						.slice(i, i + Math.min(best.n, 30))
						.map((t) => t.raw)
						.join(' '),
				});
				i += best.n;
			} else i++;
		}
	}
	return runs;
}

function checkSimilarity(argv) {
	const opt = (name, fallback) => {
		const flag = argv.find((a) => a.startsWith(`--${name}=`));
		return flag ? flag.slice(name.length + 3) : fallback;
	};
	const minRaw = Number(opt('min-raw', 50));
	const minNorm = Number(opt('min-normalized', 100));
	let versions = argv.filter((a) => a.startsWith('--version=')).map((a) => a.slice(10));
	const dirs = argv.filter((a) => a.startsWith('--upstream=')).map((a) => a.slice(11));
	if (versions.length === 0 && dirs.length === 0) {
		versions = [JSON.parse(readFileSync(join(REPO, 'node_modules/drizzle-orm/package.json'), 'utf8')).version];
	}
	const tmp = mkdtempSync(join(tmpdir(), 'provenance-upstream-'));
	try {
		const upstream = [...versions.flatMap((v) => upstreamFromVersion(v, tmp)), ...dirs.flatMap(upstreamFromDir)];
		if (upstream.length === 0) return ['no upstream TypeScript source found'];
		const theirs = upstream.map((f) => ({ name: f.name, tokens: tokenize(f.text) }));
		const ours = walk(join(REPO, 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.d.ts')).map((p) => ({
			name: relative(REPO, p).split(sep).join('/'),
			tokens: tokenize(readFileSync(p, 'utf8')),
		}));
		console.log(
			`compared ${ours.length} files in src/ with ${theirs.length} upstream files (${[...versions.map((v) => `drizzle-orm@${v}`), ...dirs].join(', ')})`,
		);
		const problems = [];
		for (const [field, min] of [
			['raw', minRaw],
			['norm', minNorm],
		]) {
			for (const run of findRuns(ours, theirs, field, min)) {
				problems.push(
					`${field === 'raw' ? 'identical' : 'same shape'} ${run.tokens} tokens: ${run.ours} ~ ${run.theirs}\n    ${run.text}`,
				);
			}
		}
		return problems;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const [mode, ...rest] = process.argv.slice(2);
let problems;
if (mode === 'pack') problems = checkPack();
else if (mode === 'similarity') problems = checkSimilarity(rest);
else {
	console.error('Usage: check-provenance.mjs pack | similarity [--version=<v>]... [--upstream=<dir>]...');
	process.exit(2);
}
for (const p of problems) console.error(p);
console.log(problems.length === 0 ? 'provenance check passed' : `${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
