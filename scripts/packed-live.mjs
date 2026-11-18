// Runs the live CUBRID suite against a packed npm tarball instead of src (#164).
//
// Usage: node scripts/packed-live.mjs <package.tgz> <consumer dir> [locked|floor] [report dir]
//
// It installs the tarball with drizzle-orm and cubrid-client (the lockfile
// versions, or the floors of the peer ranges in package.json) into a new
// consumer project outside this repository, copies tests/integration.test.ts
// there and runs it with every `../src/<entry>` import pointing at the
// installed package, so the code under test is the tarball's ESM build. Two
// test helpers that are not public are taken from src without touching the
// package: createTableSql (src/native/ddl.ts, copied with its imports pointed at
// drizzle-cubrid/native) and the RELATIONAL_KEY_CHUNK constant. Any other
// `../src/...` import stays unresolved and fails the run. A CommonJS smoke test
// (scripts/packed-live-cjs.cjs) then exercises require() of both entry points
// against the same server.
//
// It writes live-results.json (vitest JSON, for check-live-results.mjs),
// evidence.json and evidence.md to the report dir (default: <consumer>/report)
// and exits non-zero if anything failed. CUBRID_TEST_* select the server, as
// for `npm run integration`.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

const [tarballArg, consumerArg, peers = 'locked', reportArg] = process.argv.slice(2);
if (!tarballArg || !consumerArg)
	fail('Usage: packed-live.mjs <package.tgz> <consumer dir> [locked|floor] [report dir]');
if (peers !== 'locked' && peers !== 'floor') fail(`Unknown peer selection ${peers}; use locked or floor`);
const tarball = resolve(tarballArg);
const consumer = resolve(consumerArg);
const report = resolve(reportArg ?? join(consumer, 'report'));
if (!existsSync(tarball)) fail(`No tarball at ${tarball}`);
// Inside the repository, a dependency missing from the consumer would resolve
// from the repository's node_modules (and drizzle-cubrid from its dist).
const inside = relative(repo, consumer);
if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
	fail(`The consumer ${consumer} must be outside ${repo}`);
if (existsSync(consumer) && readdirSync(consumer).length > 0) fail(`The consumer ${consumer} must be new or empty`);

const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const locked = (name) => {
	const version = lock.packages?.[`node_modules/${name}`]?.version;
	if (!version) fail(`${name} is not in package-lock.json`);
	return version;
};
const floor = (name) => {
	const range = manifest.peerDependencies?.[name];
	const version = /^>=\s*(\d+\.\d+\.\d+)(\s|$)/.exec(range ?? '')?.[1];
	if (!version) fail(`Cannot derive the ${name} floor from peerDependencies "${range}"`);
	return version;
};
const wanted = {
	'drizzle-orm': peers === 'floor' ? floor('drizzle-orm') : locked('drizzle-orm'),
	'cubrid-client': peers === 'floor' ? floor('cubrid-client') : locked('cubrid-client'),
};
// The test runner is installed in a second step (see below), at the versions
// this repository's own tests run with.
const runner = { vitest: locked('vitest'), vite: locked('vite') };

const bytes = readFileSync(tarball);
const sha512 = createHash('sha512').update(bytes);
const integrity = `sha512-${sha512.copy().digest('base64')}`;
const sha512Hex = sha512.digest('hex');
const packed = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));

mkdirSync(join(consumer, 'tests', 'support'), { recursive: true });
mkdirSync(report, { recursive: true });
writeFileSync(
	join(consumer, 'package.json'),
	`${JSON.stringify({ name: 'drizzle-cubrid-packed-live', private: true, type: 'module' }, null, 2)}\n`,
);
const npm = (args) => execFileSync('npm', args, { cwd: consumer, stdio: 'inherit' });
npm([
	'install',
	'--save-exact',
	'--ignore-scripts',
	'--no-audit',
	'--no-fund',
	tarball,
	...Object.entries(wanted).map(([name, version]) => `${name}@${version}`),
]);
// Only the package and its peers go through npm's peer resolution above. The
// runner's own optional peers (@vitest/browser-*, @vitest/ui, ...) are not
// part of what is verified, and npm 10 (Node 22's npm) crashes resolving them
// for vitest 5.1.0 once a newer vitest is published ("Cannot read properties
// of null (reading 'edgesOut')"). vite, the runner's one required peer, is
// therefore pinned explicitly.
npm([
	'install',
	'--save-exact',
	'--ignore-scripts',
	'--no-audit',
	'--no-fund',
	'--legacy-peer-deps',
	...Object.entries(runner).map(([name, version]) => `${name}@${version}`),
]);

// Prove what is installed: the tarball itself, byte for byte, and the peers asked for.
const require = createRequire(join(consumer, 'package.json'));
const installedVersion = (name) =>
	JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8')).version;
for (const [name, version] of Object.entries({ ...wanted, ...runner })) {
	if (installedVersion(name) !== version) fail(`${name} ${installedVersion(name)} installed, ${version} wanted`);
}
const consumerLock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
const entry = consumerLock.packages?.['node_modules/drizzle-cubrid'];
if (entry?.integrity !== integrity) {
	fail(`Installed drizzle-cubrid integrity ${entry?.integrity} is not the tarball's ${integrity}`);
}
if (installedVersion('drizzle-cubrid') !== packed.version) fail('Installed drizzle-cubrid is not the tarball version');
for (const specifier of ['drizzle-cubrid', 'drizzle-cubrid/native']) {
	const path = require.resolve(specifier);
	if (!path.startsWith(join(consumer, 'node_modules', 'drizzle-cubrid', 'dist'))) {
		fail(`${specifier} resolves to ${path}, not the installed tarball`);
	}
}

// The suite and the two helpers it takes from src.
copyFileSync(join(repo, 'tests', 'integration.test.ts'), join(consumer, 'tests', 'integration.test.ts'));
const ddl = readFileSync(join(repo, 'src', 'native', 'ddl.ts'), 'utf8').replace(
	/from '\.\/[^']+\.js';/g,
	"from 'drizzle-cubrid/native';",
);
if (/['"]\.\.?\//.test(ddl)) fail('src/native/ddl.ts has a relative import that drizzle-cubrid/native cannot replace');
writeFileSync(join(consumer, 'tests', 'support', 'ddl.ts'), ddl);
const chunk = /export const RELATIONAL_KEY_CHUNK = (\d+);/.exec(
	readFileSync(join(repo, 'src', 'native', 'relational.ts'), 'utf8'),
)?.[1];
if (!chunk) fail('RELATIONAL_KEY_CHUNK not found in src/native/relational.ts');
writeFileSync(join(consumer, 'tests', 'support', 'relational.ts'), `export const RELATIONAL_KEY_CHUNK = ${chunk};\n`);
writeFileSync(
	join(consumer, 'vitest.config.mjs'),
	`import { defineConfig } from 'vitest/config';

// The settings of vitest.integration.config.ts, with src replaced by the package.
export default defineConfig({
	resolve: {
		alias: [
			{ find: /^\\.\\.\\/src\\/(columns|driver|table|types)$/, replacement: 'drizzle-cubrid' },
			{ find: /^\\.\\.\\/src\\/native\\/index$/, replacement: 'drizzle-cubrid/native' },
			{ find: /^\\.\\.\\/src\\/native\\/(ddl|relational)$/, replacement: ${JSON.stringify(join(consumer, 'tests', 'support'))} + '/$1.ts' },
		],
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/integration.test.ts'],
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
`,
);
copyFileSync(join(repo, 'scripts', 'packed-live-cjs.cjs'), join(consumer, 'packed-live-cjs.cjs'));

const results = join(report, 'live-results.json');
// A stale report from an earlier run must never be read as this run's result.
rmSync(results, { force: true });
const esm = spawnSync(
	'npx',
	[
		'vitest',
		'run',
		'--config',
		'vitest.config.mjs',
		'--reporter=verbose',
		'--reporter=json',
		`--outputFile.json=${results}`,
	],
	{ cwd: consumer, stdio: 'inherit' },
);
const cjs = spawnSync('node', ['packed-live-cjs.cjs'], {
	cwd: consumer,
	stdio: ['ignore', 'pipe', 'inherit'],
	encoding: 'utf8',
});
process.stdout.write(cjs.stdout ?? '');
const serverVersion = /^CUBRID server version: (.+)$/m.exec(cjs.stdout ?? '')?.[1] ?? 'unknown';

let counts = 'no report';
if (existsSync(results)) {
	const r = JSON.parse(readFileSync(results, 'utf8'));
	counts = `${r.numTotalTests} total, ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, ${r.numTodoTests} todo`;
}
const git = (args) => {
	try {
		return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
};
const evidence = {
	package: `${packed.name}@${packed.version}`,
	tarball: tarball.split('/').pop(),
	sha512: sha512Hex,
	integrity,
	gitSha: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
	gitRef: process.env.GITHUB_REF ?? git(['rev-parse', '--abbrev-ref', 'HEAD']),
	peers,
	node: process.version,
	drizzleOrm: installedVersion('drizzle-orm'),
	cubridClient: installedVersion('cubrid-client'),
	vitest: installedVersion('vitest'),
	cubridServer: serverVersion,
	cubridImage: process.env.CUBRID_IMAGE ?? 'unknown',
	timezone: process.env.TZ ?? 'unset',
	esmSuite: { exitCode: esm.status, counts },
	cjsSmoke: { exitCode: cjs.status },
};
writeFileSync(join(report, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
const markdown = [
	`### Packed-package live CUBRID gate (${peers} peers)`,
	'',
	'| | |',
	'| --- | --- |',
	`| Package | \`${evidence.package}\` (\`${evidence.tarball}\`) |`,
	`| Tarball sha512 | \`${evidence.sha512}\` |`,
	`| Tarball integrity | \`${evidence.integrity}\` |`,
	`| Git | \`${evidence.gitSha}\` (${evidence.gitRef}) |`,
	`| CUBRID server \`version()\` | \`${evidence.cubridServer}\` |`,
	`| CUBRID image | \`${evidence.cubridImage}\` |`,
	`| Node | \`${evidence.node}\` (TZ=${evidence.timezone}) |`,
	`| drizzle-orm | \`${evidence.drizzleOrm}\` |`,
	`| cubrid-client | \`${evidence.cubridClient}\` |`,
	`| ESM live suite (vitest ${evidence.vitest}) | exit ${esm.status}: ${counts} |`,
	`| CJS smoke (both entry points) | exit ${cjs.status} |`,
	'',
].join('\n');
writeFileSync(join(report, 'evidence.md'), markdown);
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

if (esm.status !== 0) fail(`The live suite against ${evidence.tarball} failed`);
if (cjs.status !== 0) fail(`The CommonJS smoke test against ${evidence.tarball} failed`);
