// Type check of an installed drizzle-cubrid tarball's native binary column
// types (#216), with and without Node's types: CubridBytes must be Buffer for
// a consumer with @types/node and Uint8Array for one without. Run by CI in the
// Node 18 consumer project; it installs TypeScript and @types/node there
// without saving them.
// Usage (from the consumer directory): node packed-types-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
execFileSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', 'typescript@5', '@types/node@18'], {
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
} finally {
	rmSync(dir, { recursive: true, force: true });
}
