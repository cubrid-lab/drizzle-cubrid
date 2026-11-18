// drizzle-cubrid/native/migrator without a database (#163): splitting and
// checking migration SQL, reading a folder (names, numbering, checksums), and
// migrate() over a fake client (refusals before any statement, dry run,
// failures, records read again under the lock). The live behavior is in
// tests/integration.test.ts. It lives outside tests/native because it needs
// Node's fs types, which the native type-check project does not have.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relations } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { int as legacyInt } from '../src/columns';
import {
	bigint,
	cubridTable,
	drizzle,
	generateInitialMigration,
	integer,
	primaryKey,
	unique,
	varchar,
} from '../src/native/index';
import { parseMigrationSql } from '../src/native/migration-sql';
import { CubridMigrationError, type CubridMigrationFile, migrate, readMigrationFiles } from '../src/native/migrator';
import { cubridTable as legacyTable } from '../src/table';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'dz-migrations-'));
	folders.push(dir);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, '..'), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

const messages = (text: string) => parseMigrationSql(text).issues.map((issue) => issue.message);

async function rejection(promise: Promise<unknown>): Promise<CubridMigrationError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(CubridMigrationError);
	return error as CubridMigrationError;
}

describe('parseMigrationSql', () => {
	it("splits at ';' outside strings, quoted names and comments, with each statement's line", () => {
		const text = [
			'-- header; not a statement',
			"CREATE TABLE \"a;b\" (s VARCHAR(10) DEFAULT 'x;y''z', [c;d] INT);",
			'/* block; comment */ INSERT INTO "a;b" VALUES (\'1\', 2); // trailing; comment',
			'',
			';;',
			'ALTER TABLE "a;b" ADD COLUMN n INT',
		].join('\n');
		const { statements, issues } = parseMigrationSql(text);
		expect(issues).toEqual([]);
		expect(statements).toEqual([
			{ sql: "CREATE TABLE \"a;b\" (s VARCHAR(10) DEFAULT 'x;y''z', [c;d] INT)", line: 2 },
			{ sql: 'INSERT INTO "a;b" VALUES (\'1\', 2)', line: 3 },
			{ sql: 'ALTER TABLE "a;b" ADD COLUMN n INT', line: 6 },
		]);
	});

	it('accepts CUBRID forms that look like MySQL ones', () => {
		expect(
			messages(
				[
					'CREATE TABLE t (id INT AUTO_INCREMENT(10, 2) PRIMARY KEY, "engine" VARCHAR(5), q VARCHAR(9) DEFAULT \'why?\') AUTO_INCREMENT = 100 CHARSET utf8 COLLATE utf8_bin',
					'-- a comment with ? and # and `ticks`',
					'ALTER TABLE t CHANGE COLUMN q q VARCHAR(20)',
					'CREATE OR REPLACE VIEW v AS SELECT id FROM t',
					"UPDATE cars SET engine = 'V8' WHERE engine = 'V6'",
					'SELECT id FROM t WHERE (engine = 1)',
					'CREATE TABLE t2 AS SELECT id FROM t WHERE engine = 1',
				].join(';\n'),
			),
		).toEqual([]);
	});

	it.each([
		['CREATE TABLE `users` (id INT)', /Backtick-quoted identifier `users`.*\("users"\)/],
		['CREATE TABLE t (id INT);\n--> statement-breakpoint\nCREATE TABLE u (id INT)', /drizzle-kit's separator/],
		['CREATE TABLE t (id INT) /*!50100 PARTITION BY HASH(id) */', /conditional comment is MySQL syntax/],
		['CREATE TABLE t (id INT) # note', /'#' comment is MySQL syntax/],
		['INSERT INTO t VALUES (?)', /'\?' parameter/],
		['BEGIN', /BEGIN controls the transaction, which migrate\(\) owns/],
		['START TRANSACTION', /START controls the transaction/],
		['COMMIT', /COMMIT controls the transaction/],
		['ROLLBACK WORK', /ROLLBACK controls the transaction/],
		['SAVEPOINT s1', /SAVEPOINT controls the transaction/],
		['SET TRANSACTION ISOLATION LEVEL 4', /SET controls the transaction/],
		['USE testdb', /USE is a MySQL statement/],
		['DELIMITER //', /DELIMITER is a MySQL statement/],
		['LOCK TABLES t WRITE', /LOCK is a MySQL statement/],
		["XA START 'x'", /XA controls the transaction/],
		["SET SYSTEM PARAMETERS 'lock_timeout=5'", /SET SYSTEM PARAMETERS changes server or session settings/],
		['ALTER TABLE t ENGINE = InnoDB', /ENGINE= is a MySQL table option/],
		['CREATE PROCEDURE p() AS BEGIN NULL', /CREATE PROCEDURE is not supported in migrations/],
		['create or replace function f() return int as begin return 1', /CREATE FUNCTION is not supported/],
		['CREATE TABLE t (id INT UNSIGNED)', /UNSIGNED is a MySQL type modifier/],
		['CREATE TABLE t (id INT ZEROFILL)', /ZEROFILL is a MySQL type modifier/],
		['CREATE TABLE t (id INT) ENGINE=InnoDB', /ENGINE= is a MySQL table option/],
		['CREATE TABLE t (id INT) DEFAULT CHARSET=utf8', /DEFAULT CHARSET is a MySQL table option/],
		['CREATE TABLE t (id INT) DEFAULT CHARACTER SET utf8', /DEFAULT CHARACTER is a MySQL table option/],
		["INSERT INTO t VALUES ('open", /Unterminated string literal/],
		['CREATE TABLE "open (id INT)', /Unterminated quoted identifier/],
		['CREATE TABLE [open (id INT)', /Unterminated bracketed identifier/],
		['CREATE TABLE t (id INT) /* open', /Unterminated \/\* comment/],
	])('refuses %j', (text, message) => {
		const found = messages(text);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(message);
	});

	it('reports the file, line and column of each issue', () => {
		const { issues } = parseMigrationSql('CREATE TABLE t (\n  id INT UNSIGNED,\n  `x` INT\n)', '0001_x.sql');
		expect(issues.map(({ file, line, column }) => [file, line, column])).toEqual([
			['0001_x.sql', 3, 3],
			['0001_x.sql', 2, 10],
		]);
	});
});

describe('generateInitialMigration', () => {
	const users = cubridTable('users', {
		id: integer().primaryKey().autoIncrement(),
		name: varchar({ length: 50 }).notNull().default("o'neil?"),
		visits: bigint({ mode: 'bigint' }).notNull().default(0n),
	});
	const memberships = cubridTable(
		'memberships',
		{ userId: integer().notNull(), groupId: integer().notNull(), code: varchar({ length: 5 }) },
		(t) => [primaryKey({ columns: [t.userId, t.groupId] }), unique('uq_code').on(t.code)],
	);
	const usersRelations = relations(users, ({ many }) => ({ memberships: many(memberships) }));

	it('writes CREATE TABLE for each native table, in order, as SQL the migrator accepts', () => {
		const text = generateInitialMigration({ users, usersRelations, memberships });
		expect(text).toBe(
			[
				'-- Initial schema, generated by generateInitialMigration() from drizzle-cubrid/native.',
				'',
				'CREATE TABLE "users" (',
				'\t"id" INTEGER AUTO_INCREMENT NOT NULL PRIMARY KEY,',
				"\t\"name\" VARCHAR(50) DEFAULT 'o''neil?' NOT NULL,",
				'\t"visits" BIGINT DEFAULT 0 NOT NULL',
				');',
				'',
				'CREATE TABLE "memberships" (',
				'\t"userId" INTEGER NOT NULL,',
				'\t"groupId" INTEGER NOT NULL,',
				'\t"code" VARCHAR(5),',
				'\tPRIMARY KEY ("userId", "groupId"),',
				'\tCONSTRAINT "uq_code" UNIQUE ("code")',
				');',
				'',
			].join('\n'),
		);
		const parsed = parseMigrationSql(text);
		expect(parsed.issues).toEqual([]);
		expect(parsed.statements).toHaveLength(2);
		expect(generateInitialMigration([memberships])).toContain('CREATE TABLE "memberships"');
	});

	it('refuses foreign tables, duplicate names and a schema without tables', () => {
		const legacy = legacyTable('legacy', { id: legacyInt('id') });
		expect(() => generateInitialMigration({ legacy })).toThrow(/legacy is not a drizzle-cubrid\/native table/);
		expect(() => generateInitialMigration([users, cubridTable('USERS', { id: integer() })])).toThrow(
			/USERS appears more than once/,
		);
		expect(() => generateInitialMigration({ usersRelations })).toThrow(/found no drizzle-cubrid\/native table/);
	});
});

describe('readMigrationFiles', () => {
	it('accepts the example folder, whose first migration is generateInitialMigration() output', async () => {
		const migrationsFolder = join(__dirname, '..', 'examples', 'migration', 'migrations');
		const files = await readMigrationFiles(migrationsFolder);
		expect(files.map((f) => f.fileName)).toEqual(['0001_initial.sql', '0002_add_email.sql']);
		const firstUsers = cubridTable('users', {
			id: integer().primaryKey().autoIncrement(),
			name: varchar({ length: 50 }).notNull(),
		});
		expect(readFileSync(join(migrationsFolder, '0001_initial.sql'), 'utf8')).toBe(
			generateInitialMigration([firstUsers]),
		);
	});

	it('reads migrations in number order with SHA-256 checksums, ignoring other files', async () => {
		const dir = folder({
			'0002_add_email.sql': 'ALTER TABLE "users" ADD COLUMN "email" VARCHAR(100);\r\n',
			'0001_create_users.sql': 'CREATE TABLE "users" ("id" INT PRIMARY KEY);\nCREATE INDEX "ix" ON "users" ("id");\n',
			'README.md': 'not a migration',
			'notes/0003_x.sql': 'ignored: subfolder',
		});
		const files = await readMigrationFiles(dir);
		expect(files.map((f) => [f.id, f.name, f.fileName, f.statements.length])).toEqual([
			[1, 'create_users', '0001_create_users.sql', 2],
			[2, 'add_email', '0002_add_email.sql', 1],
		]);
		// CRLF line ends are read as LF, so a checkout's line-end setting does not change the checksum.
		expect(files[1]!.checksum).toBe(
			createHash('sha256').update('ALTER TABLE "users" ADD COLUMN "email" VARCHAR(100);\n').digest('hex'),
		);
	});

	it('follows symbolic links to migration files and ignores links to folders', async () => {
		const target = folder({ 'real/0001_create.sql': twoMigrations['0001_create.sql'], 'real/sub/x.txt': '' });
		const dir = folder({});
		symlinkSync(join(target, 'real', '0001_create.sql'), join(dir, '0001_create.sql'));
		symlinkSync(join(target, 'real', 'sub'), join(dir, '0002_dir.sql'));
		const files = await readMigrationFiles(dir);
		expect(files.map((f) => [f.fileName, f.checksum])).toEqual([
			['0001_create.sql', sha(twoMigrations['0001_create.sql'])],
		]);
		symlinkSync(join(target, 'missing.sql'), join(dir, '0002_broken.sql'));
		const broken = await rejection(readMigrationFiles(dir));
		expect([broken.code, broken.message]).toEqual([
			'invalid-folder',
			expect.stringMatching(/0002_broken.sql in the migrations folder .* is a symbolic link that cannot be followed/),
		]);
	});

	it('refuses a folder without any migration file, as a likely wrong path', async () => {
		const error = await rejection(readMigrationFiles(folder({ 'README.md': 'x' })));
		expect([error.code, error.message]).toEqual([
			'invalid-folder',
			expect.stringMatching(/holds no migration file .*; check the path/),
		]);
	});

	it('ignores a leading UTF-8 byte order mark in the checksum and the SQL', async () => {
		const plain = 'CREATE TABLE "t" ("id" INT);\n';
		const [file] = await readMigrationFiles(folder({ '0001_bom.sql': `\uFEFF${plain.replace('\n', '\r\n')}` }));
		expect(file!.checksum).toBe(sha(plain));
		expect(file!.statements).toEqual([{ sql: 'CREATE TABLE "t" ("id" INT)', line: 1 }]);
	});

	it('refuses file names that are not migrations, including down migrations', async () => {
		const error = await rejection(
			readMigrationFiles(folder({ '0001_init.sql': 'SELECT 1', 'init.sql': '', '0002_init.down.sql': '' })),
		);
		expect(error.code).toBe('invalid-folder');
		expect(error.issues.map((i) => [i.file, i.message.slice(0, 30)]).sort()).toEqual([
			['0002_init.down.sql', 'Down migrations are not suppor'],
			['init.sql', 'Not a migration file name: use'],
		]);
	});

	it.each([
		[{ '0002_a.sql': 'SELECT 1' }, /The first migration must be number 1, not 2/],
		[{ '0001_a.sql': 'SELECT 1', '0003_b.sql': 'SELECT 1' }, /Migration number 3 follows 1/],
		[{ '0001_a.sql': 'SELECT 1', '1_b.sql': 'SELECT 1' }, /Migration number 1 is also used by 0001_a.sql/],
	])('refuses gaps and duplicates: %j', async (files, message) => {
		const error = await rejection(readMigrationFiles(folder(files)));
		expect(error.code).toBe('invalid-sequence');
		expect(error.message).toMatch(message);
	});

	it('refuses a drizzle-kit folder, a missing folder, empty files and unsafe SQL in any file', async () => {
		const kit = await rejection(
			readMigrationFiles(folder({ '0000_init.sql': 'CREATE TABLE `a` (id int)', 'meta/_journal.json': '{}' })),
		);
		expect([kit.code, kit.message]).toEqual([
			expect.any(String),
			expect.stringMatching(/drizzle-kit migrations folder/),
		]);
		const missing = await rejection(readMigrationFiles(join(tmpdir(), 'dz-no-such-folder-163')));
		expect(missing.code).toBe('invalid-folder');
		expect(missing.cause).toBeDefined();
		const unsafe = await rejection(
			readMigrationFiles(
				folder({
					'0001_ok.sql': 'CREATE TABLE "t" (id INT);',
					'0002_empty.sql': '-- nothing yet\n',
					'0003_bad.sql': 'CREATE TABLE t2 (id INT UNSIGNED) ENGINE=InnoDB;\nCOMMIT;',
				}),
			),
		);
		expect(unsafe.code).toBe('invalid-sql');
		expect(unsafe.issues.map((i) => [i.file, i.line])).toEqual([
			['0002_empty.sql', 1],
			['0003_bad.sql', 1],
			['0003_bad.sql', 1],
			['0003_bad.sql', 2],
		]);
		expect(unsafe.message).toMatch(/0003_bad.sql:1:25: UNSIGNED is a MySQL type modifier/);
	});
});

/**
 * A cubrid-client stand-in that keeps the migration tables in memory. Its
 * transaction() undoes the recorded rows when the callback rejects.
 */
function fakeDatabase(
	options: {
		failOn?: RegExp;
		onLock?: (state: FakeState) => void;
		createdByOther?: RegExp;
		lockRowByOther?: boolean;
	} = {},
) {
	const state: FakeState = { tables: new Set(), records: [], lockRow: false, log: [], transactions: [] };
	const respond = async (sql: string, params: readonly unknown[] = []): Promise<unknown[]> => {
		state.log.push(sql);
		if (options.failOn?.test(sql)) throw new Error(`fake failure: ${sql}`);
		if (sql.startsWith('select "class_name" from "db_class"')) {
			return state.tables.has(String(params[0])) ? [{ class_name: params[0] }] : [];
		}
		const create = /^create table if not exists "(\w+)"/.exec(sql);
		if (create) {
			state.tables.add(create[1]!.toLowerCase());
			// Another session created it between the server's check and the create.
			if (options.createdByOther?.test(sql)) throw new Error('-65: already exists');
			return [];
		}
		if (/^select 1 from "\w+_lock"/.test(sql)) return state.lockRow ? [{ 1: 1 }] : [];
		if (/^insert into "\w+_lock"/.test(sql)) {
			state.lockRow = true;
			if (options.lockRowByOther) throw new Error('unique violation');
			return [];
		}
		if (/^update "\w+_lock"/.test(sql)) {
			options.onLock?.(state);
			return [];
		}
		if (/^select "id", "name", "checksum" from/.test(sql)) return state.records.map((r) => ({ ...r }));
		if (/^insert into "\w+" \("id", "name", "checksum", "applied_at"\)/.test(sql)) {
			expect(sql).toMatch(/DATETIME'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}'\)$/);
			state.records.push({ id: Number(params[0]), name: String(params[1]), checksum: String(params[2]) });
		}
		return [];
	};
	const client = {
		query: respond,
		execute: async () => ({ affectedRows: 0 }),
		async transaction<T>(callback: (tx: typeof client) => Promise<T>, txOptions?: unknown): Promise<T> {
			state.transactions.push(txOptions);
			const before = state.records.length;
			try {
				return await callback(client);
			} catch (error) {
				state.records.length = before;
				throw new Error('Transaction failed.', { cause: error });
			}
		},
	};
	return { db: drizzle(client, { binding: 'literal' }), state };
}

interface FakeState {
	tables: Set<string>;
	records: { id: number; name: string; checksum: string }[];
	lockRow: boolean;
	log: string[];
	transactions: unknown[];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const twoMigrations = {
	'0001_create.sql': 'CREATE TABLE "t" ("id" INT PRIMARY KEY);',
	'0002_alter.sql': 'ALTER TABLE "t" ADD COLUMN "n" INT;\nCREATE INDEX "ix_n" ON "t" ("n");',
};
const names = (files: CubridMigrationFile[]) => files.map((f) => f.fileName);

describe('migrate() over a fake client', () => {
	it('applies pending migrations in order with their records, then does nothing on a rerun', async () => {
		const { db, state } = fakeDatabase();
		const migrationsFolder = folder(twoMigrations);
		const result = await migrate(db, { migrationsFolder });
		expect([names(result.applied), result.pending]).toEqual([['0001_create.sql', '0002_alter.sql'], []]);
		expect(state.records).toEqual([
			{ id: 1, name: 'create', checksum: sha(twoMigrations['0001_create.sql']) },
			{ id: 2, name: 'alter', checksum: sha(twoMigrations['0002_alter.sql']) },
		]);
		expect([...state.tables]).toEqual(['__drizzle_cubrid_migrations', '__drizzle_cubrid_migrations_lock']);
		// One 'read committed' transaction per migration.
		expect(state.transactions).toEqual([{ isolationLevel: 'read committed' }, { isolationLevel: 'read committed' }]);
		expect(state.log.filter((s) => !/drizzle_cubrid/.test(s))).toEqual([
			'CREATE TABLE "t" ("id" INT PRIMARY KEY)',
			'ALTER TABLE "t" ADD COLUMN "n" INT',
			'CREATE INDEX "ix_n" ON "t" ("n")',
		]);
		state.log.length = 0;
		expect(await migrate(db, { migrationsFolder })).toEqual({ applied: [], pending: [], ahead: [] });
		expect(state.log.some((s) => /^(CREATE|ALTER|update)/.test(s))).toBe(false);
	});

	it('goes on when another migrate() created a migration table or the lock row at the same time', async () => {
		const { db, state } = fakeDatabase({ createdByOther: /create table/, lockRowByOther: true });
		const result = await migrate(db, { migrationsFolder: folder(twoMigrations) });
		expect(result.applied).toHaveLength(2);
		const failing = fakeDatabase({ failOn: /^create table if not exists "__drizzle_cubrid_migrations_lock"/ });
		await expect(migrate(failing.db, { migrationsFolder: folder(twoMigrations) })).rejects.toThrow(/fake failure/);
		expect(state.records).toHaveLength(2);
	});

	it('reports the plan of a dry run without creating or changing anything', async () => {
		const { db, state } = fakeDatabase();
		const migrationsFolder = folder(twoMigrations);
		const plan = await migrate(db, { migrationsFolder, migrationsTable: 'app_migrations', dryRun: true });
		expect([plan.applied, names(plan.pending)]).toEqual([[], ['0001_create.sql', '0002_alter.sql']]);
		expect(state.log).toEqual([
			'select "class_name" from "db_class" where "class_name" = ? and "owner_name" = upper(current_user)',
		]);
		await migrate(db, { migrationsFolder, migrationsTable: 'app_migrations' });
		state.records.pop();
		const rest = await migrate(db, { migrationsFolder, migrationsTable: 'APP_migrations', dryRun: true });
		expect(names(rest.pending)).toEqual(['0002_alter.sql']);
	});

	it('refuses a changed, renamed or missing applied migration before running any statement', async () => {
		const { db, state } = fakeDatabase();
		await migrate(db, { migrationsFolder: folder({ '0001_create.sql': twoMigrations['0001_create.sql'] }) });
		const cases: [Record<string, string | undefined>, RegExp][] = [
			[
				{ ...twoMigrations, '0001_create.sql': 'CREATE TABLE "t" ("id" BIGINT PRIMARY KEY);' },
				/0001_create.sql:1:1: The file changed after it was applied/,
			],
			[
				{ ...twoMigrations, '0001_make.sql': twoMigrations['0001_create.sql'], '0001_create.sql': undefined },
				/applied as 'create' but the file is named 'make'/,
			],
		];
		for (const [files, message] of cases) {
			state.log.length = 0;
			const present = Object.fromEntries(Object.entries(files).filter(([, text]) => text !== undefined));
			const error = await rejection(migrate(db, { migrationsFolder: folder(present as Record<string, string>) }));
			expect([error.code, error.message]).toEqual(['applied-mismatch', expect.stringMatching(message)]);
			expect(state.log.some((s) => /^(ALTER|CREATE INDEX|update)/.test(s))).toBe(false);
		}
		state.records.push({ id: 2, name: 'alter', checksum: 'x' }, { id: 4, name: 'later', checksum: 'y' });
		const error = await rejection(migrate(db, { migrationsFolder: folder(twoMigrations) }));
		expect(error.code).toBe('applied-mismatch');
		expect(error.issues.map((i) => i.message)).toEqual([
			expect.stringMatching(/^The file changed after it was applied/),
			expect.stringMatching(/records migration 4 where migration 3 was expected: the record has a gap/),
		]);
	});

	it('applies nothing when the database is ahead of the folder, and reports the newer records', async () => {
		const { db, state } = fakeDatabase();
		await migrate(db, { migrationsFolder: folder(twoMigrations) });
		// An older version of the application, whose folder ends at migration 1.
		const older = folder({ '0001_create.sql': twoMigrations['0001_create.sql'] });
		state.log.length = 0;
		const expected = [{ id: 2, name: 'alter', checksum: sha(twoMigrations['0002_alter.sql']) }];
		expect(await migrate(db, { migrationsFolder: older })).toEqual({ applied: [], pending: [], ahead: expected });
		expect((await migrate(db, { migrationsFolder: older, dryRun: true })).ahead).toEqual(expected);
		expect(state.log.some((s) => /^(CREATE|ALTER|update|insert)/.test(s))).toBe(false);
		// Its own migrations are still checked.
		const edited = folder({ '0001_create.sql': 'CREATE TABLE "t" ("id" BIGINT PRIMARY KEY);' });
		expect((await rejection(migrate(db, { migrationsFolder: edited }))).code).toBe('applied-mismatch');
	});

	it('stops at a failing statement with its migration, statement and the driver error', async () => {
		const { db, state } = fakeDatabase({ failOn: /"broken"/ });
		const migrationsFolder = folder({
			...twoMigrations,
			'0003_broken.sql': 'ALTER TABLE "t" ADD COLUMN "m" INT;\n\nALTER TABLE "broken" ADD COLUMN "x" INT;',
			'0004_after.sql': 'CREATE TABLE "after" (id INT);',
		});
		const error = await rejection(migrate(db, { migrationsFolder }));
		expect(error.code).toBe('statement-failed');
		expect(error.migration).toEqual({ id: 3, name: 'broken' });
		expect(error.statement).toEqual({ index: 2, line: 3, sql: 'ALTER TABLE "broken" ADD COLUMN "x" INT' });
		expect(error.message).toMatch(
			/^Migration 0003_broken.sql failed at statement 2 of 2; its transaction is rolled back/,
		);
		expect((error.cause as Error).message).toMatch(/fake failure/);
		expect(state.records.map((r) => r.id)).toEqual([1, 2]);
		expect(state.log.some((s) => s.includes('"after"'))).toBe(false);
	});

	it('skips a migration another migrate() applied while it waited for the lock', async () => {
		const migrationsFolder = folder(twoMigrations);
		let raced = false;
		const { db, state } = fakeDatabase({
			onLock: (s) => {
				if (raced) return;
				raced = true;
				s.records.push({ id: 1, name: 'create', checksum: sha(twoMigrations['0001_create.sql']) });
			},
		});
		const result = await migrate(db, { migrationsFolder });
		expect(names(result.applied)).toEqual(['0002_alter.sql']);
		expect(state.log).not.toContain('CREATE TABLE "t" ("id" INT PRIMARY KEY)');
	});

	it('refuses a bad config, a transaction and a non-database', async () => {
		const { db } = fakeDatabase();
		const migrationsFolder = folder(twoMigrations);
		const cases: [unknown, unknown, RegExp][] = [
			[db, undefined, /needs a config object/],
			[db, { migrationsFolder: '' }, /migrationsFolder must be a non-empty path/],
			[db, { migrationsFolder, migrationsTable: 'bad-name' }, /migrationsTable must be/],
			[db, { migrationsFolder, migrationsTable: 'x'.repeat(101) }, /migrationsTable must be/],
			[db, { migrationsFolder, dryRun: 'yes' }, /dryRun must be true or false/],
			[db, { migrationsFolder, migrationsSchema: 'x' }, /Unknown migrate\(\) option 'migrationsSchema'/],
			[{}, { migrationsFolder }, /needs the database returned by drizzle\(client\) from drizzle-cubrid\/native/],
			[
				{ query: async () => [], transaction: async () => undefined },
				{ migrationsFolder },
				/not a cubrid-client client or pool/,
			],
		];
		for (const [database, config, message] of cases) {
			const error = await rejection(migrate(database as never, config as never));
			expect([error.code, error.message]).toEqual(['invalid-config', expect.stringMatching(message)]);
		}
		const error = await rejection(db.transaction((tx) => migrate(tx, { migrationsFolder })));
		expect(error.message).toMatch(/not a transaction/);
	});
});
