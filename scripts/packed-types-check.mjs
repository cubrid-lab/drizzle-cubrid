// Type check of an installed drizzle-cubrid tarball's declarations, run by CI
// in the Node 18 consumer project; it installs TypeScript and @types/node
// there without saving them.
// - Native binary column types (#216), with and without Node's types:
//   CubridBytes must be Buffer for a consumer with @types/node and Uint8Array
//   for one without.
// - The export layout (ADR 0010): the root and drizzle-cubrid/native have the
//   same types, a removed 0.x name fails to compile when used from the root,
//   and drizzle-cubrid/legacy still type-checks the 0.x API, under both
//   `moduleResolution: nodenext` (package.json exports) and `node10`
//   (package.json typesVersions).
// - Declarations that name no global of the DOM lib or @types/node (#252): a
//   consumer with `lib: ["es2022"]`, no @types/node and `skipLibCheck: false`
//   compiles every entry, and a real AbortSignal, from Node's types or from lib
//   dom, is accepted as the `signal` of `iterator()`. drizzle-orm's own
//   declarations (Buffer, TextDecoder, mysql2, gel, ...) need Node's types or
//   other packages and fail under `skipLibCheck: false` whatever this package
//   does, so these cases ignore errors under node_modules/drizzle-orm and
//   assert there are none anywhere else. cubrid-client 1.6.0 and later
//   compile without Node's types, so its declarations are checked too: the
//   consumer must install a cubrid-client of at least that version.
// Usage (from the consumer directory): node packed-types-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The skipLibCheck: false cases check cubrid-client's declarations, which
// compile without Node's types only from 1.6.0.
const client = JSON.parse(readFileSync(join('node_modules', 'cubrid-client', 'package.json'), 'utf8')).version;
const [major, minor] = client.split('.').map(Number);
if (major < 1 || (major === 1 && minor < 6)) {
	throw new Error(`packed-types-check needs cubrid-client 1.6.0 or later in the consumer, found ${client}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Exact versions, so a new TypeScript or @types/node release cannot fail this
// step on its own: TypeScript is the repository's locked version.
execFileSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', 'typescript@5.9.3', '@types/node@18.19.130'], {
	stdio: 'inherit',
});

const schema = `import { binary, cubridTable, integer, set, varbinary } from 'drizzle-cubrid/native';
export const t = cubridTable('t', {
	id: integer().primaryKey(),
	hash: binary({ length: 4 }).notNull(),
	data: varbinary({ length: 8 }),
	parts: set({ element: varbinary({ length: 2 }) }),
});
export type Row = typeof t.$inferSelect;
export type NewRow = typeof t.$inferInsert;
`;

const cases = {
	node: `import { type NewRow, type Row } from './schema.js';
export const same: Row['hash'] extends Buffer ? (Buffer extends Row['hash'] ? true : false) : false = true;
export const row: NewRow = { id: 1, hash: Buffer.from('ab', 'hex'), data: null, parts: [Buffer.from([1]), null] };
export const text: string = ({} as Row).hash.toString('hex');
// @ts-expect-error a binary value is bytes, not hex text
export const bad: NewRow = { id: 1, hash: 'cafe' };
`,
	plain: `import { type NewRow, type Row } from './schema.js';
export const same: Row['hash'] extends Uint8Array ? (Uint8Array extends Row['hash'] ? true : false) : false = true;
export const row: NewRow = { id: 1, hash: new Uint8Array(4) };
// @ts-expect-error a binary value is bytes, not hex text
export const bad: NewRow = { id: 1, hash: 'cafe' };
`,
};

// The export layout, checked once with Node's types.
const layout = `import * as root from 'drizzle-cubrid';
import * as native from 'drizzle-cubrid/native';
import * as legacy from 'drizzle-cubrid/legacy';
import { migrate } from 'drizzle-cubrid/migrator';
import { migrate as nativeMigrate } from 'drizzle-cubrid/native/migrator';
export const sameTable: typeof root.cubridTable = native.cubridTable;
export const sameDatabase: typeof native.CubridDatabase = root.CubridDatabase;
export const sameMigrate: typeof migrate = nativeMigrate;
const t = root.cubridTable('t', { id: root.integer().primaryKey(), tags: root.set({ element: root.varchar({ length: 9 }) }) });
export const where = root.eq(t.id, 1);
// @ts-expect-error cubridSet() is a 0.x export: use set({ element }), or drizzle-cubrid/legacy
root.cubridSet('tags');
// @ts-expect-error mysqlEnum is not exported by the root entry
export { mysqlEnum } from 'drizzle-cubrid';
export const old = legacy.cubridTable('old', { id: legacy.int('id').primaryKey(), tags: legacy.cubridSet('tags') });
`;

// `iterator()`'s signal, with the signal each environment has (#252).
const signalSource = (
	signal,
) => `import { cubridTable, integer, type CubridDatabase, type CubridStreamOptions } from 'drizzle-cubrid';
export const t = cubridTable('t', { id: integer().primaryKey() });
declare const db: CubridDatabase;
export const options: CubridStreamOptions = { signal: ${signal} };
export const stream = db.select().from(t).iterator(undefined, { literal: true, signal: ${signal} });
// @ts-expect-error a signal is an object, not a string
export const bad: CubridStreamOptions = { signal: 'abort' };
`;

const entries = `import * as root from 'drizzle-cubrid';
import * as native from 'drizzle-cubrid/native';
import * as migrator from 'drizzle-cubrid/migrator';
import * as nativeMigrator from 'drizzle-cubrid/native/migrator';
import * as legacy from 'drizzle-cubrid/legacy';
export const all = [root, native, migrator, nativeMigrator, legacy];
`;

// cubrid-client's own CubridClient and CubridPool are accepted by drizzle(),
// root and legacy. Its array-row query() and stream() take
// `params: QueryParams | undefined`, which an interface typing `params` as
// `readonly unknown[]` rejects once Node's types make QueryParam concrete.
const driverSource = `import { createClient, createPool } from 'cubrid-client';
import { drizzle } from 'drizzle-cubrid';
import { drizzle as legacyDrizzle } from 'drizzle-cubrid/legacy';
const config = { host: 'localhost', database: 'demodb', user: 'dba' };
export const nativeClient = drizzle(createClient(config));
export const nativePool = drizzle(createPool(config));
export const legacyClient = legacyDrizzle(createClient(config));
export const legacyPool = legacyDrizzle(createPool(config));
export async function transactionClients() {
	const client = createClient(config);
	const pool = createPool(config);
	await client.transaction(async (tx) => [drizzle(tx), legacyDrizzle(tx)]);
	await pool.transaction(async (tx) => [drizzle(tx), legacyDrizzle(tx)]);
	await pool.connection(async (connection) => [drizzle(connection), legacyDrizzle(connection)]);
	const scope = await client.beginTransactionScope();
	return [drizzle(scope), legacyDrizzle(scope)];
}
`;

// [name, lib, types, source]: skipLibCheck is false in all of them.
const strictCases = [
	['strict-no-libs', ['es2022'], [], entries + signalSource('{ aborted: false }') + driverSource],
	['strict-node-signal', ['es2022'], ['node'], signalSource('new AbortController().signal') + driverSource],
	['strict-dom-signal', ['es2022', 'dom'], [], signalSource('new AbortController().signal') + driverSource],
];

const dir = mkdtempSync(join(process.cwd(), 'types-check-'));
try {
	writeFileSync(join(dir, 'schema.ts'), schema);
	for (const [name, source] of Object.entries(cases)) {
		writeFileSync(join(dir, `${name}.ts`), source);
		const compilerOptions = {
			strict: true,
			noEmit: true,
			module: 'nodenext',
			moduleResolution: 'nodenext',
			target: 'es2022',
			// drizzle-orm's own declarations need other databases' packages.
			skipLibCheck: true,
			types: name === 'node' ? ['node'] : [],
			...(name === 'node' ? {} : { lib: ['es2022'] }),
		};
		writeFileSync(
			join(dir, `tsconfig.${name}.json`),
			JSON.stringify({ compilerOptions, files: ['schema.ts', `${name}.ts`] }),
		);
		execFileSync(npx, ['tsc', '-p', join(dir, `tsconfig.${name}.json`)], { stdio: 'inherit' });
		console.log(`binary column types, ${name === 'node' ? 'with' : 'without'} @types/node: ok`);
	}
	writeFileSync(join(dir, 'layout.ts'), layout);
	// nodenext reads package.json `exports`; node10 (TypeScript's default for
	// `module: commonjs`) ignores them and needs `typesVersions` for every subpath.
	for (const [resolution, module] of [
		['nodenext', 'nodenext'],
		['node10', 'commonjs'],
	]) {
		const compilerOptions = {
			strict: true,
			noEmit: true,
			module,
			moduleResolution: resolution,
			target: 'es2022',
			skipLibCheck: true,
			types: ['node'],
		};
		const config = join(dir, `tsconfig.layout-${resolution}.json`);
		writeFileSync(config, JSON.stringify({ compilerOptions, files: ['layout.ts'] }));
		execFileSync(npx, ['tsc', '-p', config], { stdio: 'inherit' });
		console.log(`export layout (root = native, /native alias, /migrator, /legacy), ${resolution}: ok`);
	}
	for (const [name, lib, types, source] of strictCases) {
		writeFileSync(join(dir, `${name}.ts`), source);
		const config = join(dir, `tsconfig.${name}.json`);
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					module: 'nodenext',
					moduleResolution: 'nodenext',
					target: 'es2022',
					skipLibCheck: false,
					lib,
					types,
				},
				files: [`${name}.ts`],
			}),
		);
		let output = '';
		let failed = false;
		try {
			execFileSync(npx, ['tsc', '-p', config, '--pretty', 'false'], { encoding: 'utf8', stdio: 'pipe' });
		} catch (error) {
			failed = true;
			output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
		}
		const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
		// A tsc that fails without reporting a type error did not check anything.
		if (failed && errors.length === 0) {
			console.error(output);
			throw new Error(`${name}: tsc failed without a type error`);
		}
		const own = errors.filter((line) => !/(^|[\\/])node_modules[\\/]drizzle-orm[\\/]/.test(line));
		if (own.length > 0) {
			console.error(own.join('\n'));
			throw new Error(`${name}: ${own.length} type error(s) outside drizzle-orm's own declarations`);
		}
		console.log(
			`skipLibCheck: false, lib ${lib.join('+')}, types [${types.join()}] (${name}): ok, ${errors.length} error(s) in drizzle-orm ignored`,
		);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
