// Type check of an installed drizzle-cubrid tarball's declarations, run by CI
// in the Node 18 consumer project; it installs TypeScript and @types/node
// there without saving them.
// - Native binary column types (#216), with and without Node's types:
//   CubridBytes must be Buffer for a consumer with @types/node and Uint8Array
//   for one without.
// - The export layout (ADR 0010): the root and drizzle-cubrid/native have the
//   same types, a removed 0.x name fails to compile when used from the root,
//   and drizzle-cubrid/legacy still type-checks the 0.x API.
// Usage (from the consumer directory): node packed-types-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
	const compilerOptions = {
		strict: true,
		noEmit: true,
		module: 'nodenext',
		moduleResolution: 'nodenext',
		target: 'es2022',
		skipLibCheck: true,
		types: ['node'],
	};
	writeFileSync(join(dir, 'tsconfig.layout.json'), JSON.stringify({ compilerOptions, files: ['layout.ts'] }));
	execFileSync(npx, ['tsc', '-p', join(dir, 'tsconfig.layout.json')], { stdio: 'inherit' });
	console.log('export layout (root = native, /native alias, /migrator, /legacy): ok');
} finally {
	rmSync(dir, { recursive: true, force: true });
}
