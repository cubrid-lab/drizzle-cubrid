// drizzle-cubrid/native/migrator: applies a folder of CUBRID SQL migrations
// (#163, ADR 0009, docs/MIGRATIONS.md).
//
// A migration is a file `<number>_<name>.sql` of CUBRID statements separated
// by ';'. migrate() checks every file and the record of applied migrations
// before it changes anything, then applies each pending migration in its own
// transaction together with its record row. CUBRID 11.4 rolls DDL back with
// the transaction (measured, see ADR 0009), so a failed migration leaves
// nothing behind. It never uses drizzle-kit, another database's migration
// code or SQL generated for another database.
//
// This entry is bundled on its own, so it imports nothing from the native
// modules at runtime: a second copy of their classes would not be the ones the
// caller's tables and database were built with.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm/sql/sql';
import { type CubridMigrationIssue, type CubridMigrationStatement, parseMigrationSql } from './migration-sql.js';

export type { CubridMigrationIssue, CubridMigrationStatement };

/** What a `CubridMigrationError` is about; see docs/MIGRATIONS.md. */
export type CubridMigrationErrorCode =
	/** `migrate()`'s config is not valid. */
	| 'invalid-config'
	/** The migrations folder cannot be read, or holds a file that is not a migration. */
	| 'invalid-folder'
	/** The migration numbers are not 1, 2, 3, … without gaps or duplicates. */
	| 'invalid-sequence'
	/** A migration's SQL cannot be applied: foreign syntax, transaction control, or no statement. */
	| 'invalid-sql'
	/** The applied migrations recorded in the database do not match the files. */
	| 'applied-mismatch'
	/** A statement of a migration failed; its transaction was rolled back. */
	| 'statement-failed';

/** Every refusal of the migrator: nothing of the failing step is applied. */
export class CubridMigrationError extends Error {
	override readonly name = 'CubridMigrationError';
	readonly code: CubridMigrationErrorCode;
	/** The problems found, each with its file and position where known. */
	readonly issues: readonly CubridMigrationIssue[];
	/** The migration that failed, for `'statement-failed'`. */
	readonly migration?: { id: number; name: string };
	/** The failing statement (1-based index and its SQL), for `'statement-failed'`. */
	readonly statement?: { index: number; line: number; sql: string };

	constructor(
		code: CubridMigrationErrorCode,
		message: string,
		details: {
			issues?: readonly CubridMigrationIssue[];
			migration?: { id: number; name: string };
			statement?: { index: number; line: number; sql: string };
			cause?: unknown;
		} = {},
	) {
		const issues = details.issues ?? [];
		const listed = issues.map((i) => `\n  ${i.file ? `${i.file}:` : ''}${i.line}:${i.column}: ${i.message}`).join('');
		super(`${message}${listed}`, details.cause === undefined ? undefined : { cause: details.cause });
		this.code = code;
		this.issues = issues;
		if (details.migration) this.migration = details.migration;
		if (details.statement) this.statement = details.statement;
	}
}

/** One migration file, read and checked. */
export interface CubridMigrationFile {
	/** The number before the first `_`: 1 for `0001_init.sql`. */
	id: number;
	/** The part after the first `_`, without `.sql`: `init`. */
	name: string;
	fileName: string;
	/** SHA-256 (hex) of the file's text with CRLF line ends read as LF. */
	checksum: string;
	/** The statements, in order, without the `;` that ends them, with the line each starts on. */
	statements: CubridMigrationStatement[];
}

export interface CubridMigrationConfig {
	/** The folder of `<number>_<name>.sql` files. */
	migrationsFolder: string;
	/**
	 * The table that records applied migrations (default
	 * `__drizzle_cubrid_migrations`). A second table, `<name>_lock`, holds the
	 * row that serializes concurrent `migrate()` calls.
	 */
	migrationsTable?: string;
	/** Check everything and report what would be applied, without changing the database. */
	dryRun?: boolean;
}

export interface CubridMigrationResult {
	/** The migrations this call applied, in order (none for a dry run or when up to date). */
	applied: CubridMigrationFile[];
	/** The migrations not applied yet: those a dry run would apply, and none after a run. */
	pending: CubridMigrationFile[];
}

/** A statement runner: the native `CubridTransaction`. */
export interface CubridMigrationSession {
	execute(query: SQLWrapper | string): Promise<unknown[]>;
}

/**
 * What `migrate()` needs from the database: the native `drizzle()` database
 * of `drizzle-cubrid/native` over a cubrid-client client or pool.
 */
export interface CubridMigrationDatabase extends CubridMigrationSession {
	transaction<T>(
		transaction: (tx: CubridMigrationSession) => Promise<T>,
		config?: { isolationLevel?: 'read committed' },
	): Promise<T>;
}

const FILE_NAME = /^(\d+)_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const DEFAULT_TABLE = '__drizzle_cubrid_migrations';

/**
 * Reads and checks every migration of `folder`, without a database: names,
 * numbering and SQL. Rejects with a `CubridMigrationError` listing every
 * problem. Files that do not end in `.sql` and subfolders are ignored, except
 * drizzle-kit's `meta/_journal.json`, which is refused.
 */
export async function readMigrationFiles(folder: string): Promise<CubridMigrationFile[]> {
	let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch (error) {
		throw new CubridMigrationError('invalid-folder', `Cannot read the migrations folder ${folder}`, { cause: error });
	}
	if (entries.some((entry) => entry.isDirectory() && entry.name === 'meta')) {
		const meta: string[] = await readdir(join(folder, 'meta')).catch(() => []);
		if (meta.includes('_journal.json')) {
			throw new CubridMigrationError(
				'invalid-folder',
				`${folder} is a drizzle-kit migrations folder (meta/_journal.json); drizzle-kit generates SQL for another database and is not supported. Use a folder of CUBRID <number>_<name>.sql files`,
			);
		}
	}
	const issues: CubridMigrationIssue[] = [];
	const found: { id: number; name: string; fileName: string }[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/\.sql$/i.test(entry.name)) continue;
		const match = FILE_NAME.exec(entry.name);
		if (!match) {
			issues.push({
				file: entry.name,
				line: 1,
				column: 1,
				message: /\.down\.sql$/i.test(entry.name)
					? 'Down migrations are not supported: migrate() only applies migrations forward; undo a change with a new migration'
					: 'Not a migration file name: use <number>_<name>.sql, for example 0001_create_users.sql (name: letters, digits, _ and -)',
			});
			continue;
		}
		found.push({ id: Number(match[1]), name: match[2]!, fileName: entry.name });
	}
	if (issues.length > 0) {
		throw new CubridMigrationError(
			'invalid-folder',
			`The migrations folder ${folder} holds files that are not migrations`,
			{
				issues,
			},
		);
	}
	found.sort((a, b) => a.id - b.id || a.fileName.localeCompare(b.fileName));
	found.forEach((file, index) => {
		const previous = found[index - 1];
		if (previous && previous.id === file.id) {
			issues.push({
				file: file.fileName,
				line: 1,
				column: 1,
				message: `Migration number ${file.id} is also used by ${previous.fileName}`,
			});
		} else if (file.id !== (previous?.id ?? 0) + 1) {
			issues.push({
				file: file.fileName,
				line: 1,
				column: 1,
				message:
					previous === undefined
						? `The first migration must be number 1, not ${file.id}`
						: `Migration number ${file.id} follows ${previous.id}: numbers must go up by 1 without gaps`,
			});
		}
	});
	if (issues.length > 0) {
		throw new CubridMigrationError(
			'invalid-sequence',
			`The migrations in ${folder} are not numbered 1, 2, 3, … in order`,
			{ issues },
		);
	}
	const files: CubridMigrationFile[] = [];
	for (const file of found) {
		const text = (await readFile(join(folder, file.fileName), 'utf8')).replace(/\r\n/g, '\n');
		const parsed = parseMigrationSql(text, file.fileName);
		issues.push(...parsed.issues);
		if (parsed.statements.length === 0 && parsed.issues.length === 0) {
			issues.push({ file: file.fileName, line: 1, column: 1, message: 'The migration has no statement' });
		}
		files.push({
			...file,
			checksum: createHash('sha256').update(text, 'utf8').digest('hex'),
			statements: parsed.statements,
		});
	}
	if (issues.length > 0) {
		throw new CubridMigrationError(
			'invalid-sql',
			`The migrations in ${folder} contain SQL that drizzle-cubrid will not apply; nothing was applied`,
			{ issues },
		);
	}
	return files;
}

function checkConfig(config: CubridMigrationConfig): { folder: string; table: string; dryRun: boolean } {
	if (typeof config !== 'object' || config === null) {
		throw new CubridMigrationError('invalid-config', 'migrate() needs a config object with migrationsFolder');
	}
	for (const key of Object.keys(config)) {
		if (key !== 'migrationsFolder' && key !== 'migrationsTable' && key !== 'dryRun') {
			throw new CubridMigrationError(
				'invalid-config',
				`Unknown migrate() option '${key}'; it accepts migrationsFolder, migrationsTable and dryRun`,
			);
		}
	}
	const { migrationsFolder, migrationsTable = DEFAULT_TABLE, dryRun = false } = config;
	if (typeof migrationsFolder !== 'string' || migrationsFolder === '') {
		throw new CubridMigrationError('invalid-config', 'migrationsFolder must be a non-empty path');
	}
	if (typeof migrationsTable !== 'string' || !TABLE_NAME.test(migrationsTable)) {
		throw new CubridMigrationError(
			'invalid-config',
			`migrationsTable must be 1 to 100 letters, digits or _, starting with a letter or _, not ${JSON.stringify(migrationsTable)}`,
		);
	}
	if (typeof dryRun !== 'boolean') throw new CubridMigrationError('invalid-config', 'dryRun must be true or false');
	return { folder: migrationsFolder, table: migrationsTable, dryRun };
}

interface AppliedRecord {
	id: number;
	name: string;
	checksum: string;
}

async function appliedRecords(session: CubridMigrationSession, table: string): Promise<AppliedRecord[]> {
	const rows = (await session.execute(
		sql`select ${sql.identifier('id')}, ${sql.identifier('name')}, ${sql.identifier('checksum')} from ${sql.identifier(table)} order by ${sql.identifier('id')}`,
	)) as Record<string, unknown>[];
	return rows.map((row) => ({ id: Number(row.id), name: String(row.name), checksum: String(row.checksum) }));
}

/**
 * Compares the recorded migrations with the files: the records must be
 * migrations 1 to k of the folder, with the same names and checksums.
 */
function checkAppliedMigrations(
	records: readonly AppliedRecord[],
	files: readonly CubridMigrationFile[],
	table: string,
): void {
	const issues: CubridMigrationIssue[] = [];
	records.forEach((record, index) => {
		const file = files[record.id - 1];
		const where = { file: file?.fileName ?? `${record.id}_${record.name}.sql`, line: 1, column: 1 };
		if (record.id !== index + 1) {
			issues.push({
				...where,
				message: `${table} records migration ${record.id} where migration ${index + 1} was expected: the record has a gap`,
			});
		} else if (file === undefined) {
			issues.push({
				...where,
				message: `Migration ${record.id} (${record.name}) is recorded as applied but has no file in the folder`,
			});
		} else if (file.name !== record.name) {
			issues.push({
				...where,
				message: `Migration ${record.id} was applied as '${record.name}' but the file is named '${file.name}'; applied migrations must not be renamed`,
			});
		} else if (file.checksum !== record.checksum) {
			issues.push({
				...where,
				message: `The file changed after it was applied (checksum ${file.checksum}, applied ${record.checksum}); applied migrations must not be edited: add a new migration instead`,
			});
		}
	});
	if (issues.length > 0) {
		throw new CubridMigrationError(
			'applied-mismatch',
			`The migrations recorded in ${table} do not match the migrations folder; no further migration was applied`,
			{ issues },
		);
	}
}

async function tableExists(db: CubridMigrationSession, table: string): Promise<boolean> {
	const rows = await db.execute(
		sql`select ${sql.identifier('class_name')} from ${sql.identifier('db_class')} where ${sql.identifier('class_name')} = ${table.toLowerCase()}`,
	);
	return rows.length > 0;
}

/** Creates the record and lock tables and the lock row when missing (autocommitted). */
async function prepareTables(db: CubridMigrationDatabase, table: string, lock: string): Promise<void> {
	// CUBRID 11.4 fails CREATE TABLE IF NOT EXISTS with -65 (already exists)
	// when another session created the table since the check (measured with two
	// concurrent migrate() calls), so a table that exists afterwards is fine.
	const create = async (name: string, columns: SQL) => {
		try {
			await db.execute(sql`create table if not exists ${sql.identifier(name)} (${columns})`);
		} catch (error) {
			if (!(await tableExists(db, name))) throw error;
		}
	};
	await create(
		table,
		sql`${sql.identifier('id')} INTEGER NOT NULL PRIMARY KEY, ${sql.identifier('name')} VARCHAR(255) NOT NULL, ${sql.identifier('checksum')} VARCHAR(64) NOT NULL, ${sql.identifier('applied_at')} DATETIME NOT NULL`,
	);
	await create(
		lock,
		sql`${sql.identifier('id')} INTEGER NOT NULL PRIMARY KEY, ${sql.identifier('generation')} BIGINT NOT NULL`,
	);
	const hasRow = async () =>
		(await db.execute(sql`select 1 from ${sql.identifier(lock)} where ${sql.identifier('id')} = 1`)).length > 0;
	if (await hasRow()) return;
	try {
		await db.execute(
			sql`insert into ${sql.identifier(lock)} (${sql.identifier('id')}, ${sql.identifier('generation')}) values (1, 0)`,
		);
	} catch (error) {
		// Another migrate() inserted it first.
		if (!(await hasRow())) throw error;
	}
}

/** `DATETIME'YYYY-MM-DD HH:MM:SS.mmm'` of the current UTC time. */
function utcNow(): string {
	return `DATETIME'${new Date().toISOString().replace('T', ' ').replace('Z', '')}'`;
}

/**
 * Applies the pending migrations of `config.migrationsFolder` to `db`, the
 * native `drizzle()` database. Everything is checked before the first
 * statement: file names and numbering, the SQL of every file, and the
 * recorded migrations (names and checksums). Each pending migration then runs
 * in its own `'read committed'` transaction, which first takes the lock row
 * (so concurrent calls apply each migration once), runs the statements in
 * order, records the migration and commits. A failed statement rolls the
 * migration back and rejects with a `'statement-failed'` error; migrations
 * before it stay applied. Running it again when up to date changes nothing.
 */
export async function migrate(
	db: CubridMigrationDatabase,
	config: CubridMigrationConfig,
): Promise<CubridMigrationResult> {
	const { folder, table, dryRun } = checkConfig(config);
	if (
		typeof db?.execute !== 'function' ||
		typeof db.transaction !== 'function' ||
		typeof (db as { rollback?: unknown }).rollback === 'function'
	) {
		throw new CubridMigrationError(
			'invalid-config',
			"migrate() needs the database from drizzle-cubrid/native's drizzle(), not a transaction: it runs each migration in a transaction of its own",
		);
	}
	const lock = `${table}_lock`;
	const files = await readMigrationFiles(folder);
	if (dryRun) {
		const records = (await tableExists(db, table)) ? await appliedRecords(db, table) : [];
		checkAppliedMigrations(records, files, table);
		return { applied: [], pending: files.slice(records.length) };
	}
	await prepareTables(db, table, lock);
	const records = await appliedRecords(db, table);
	checkAppliedMigrations(records, files, table);

	const applied: CubridMigrationFile[] = [];
	for (const file of files.slice(records.length)) {
		const done = await db.transaction(
			async (tx) => {
				// Held until this transaction ends: another migrate() waits here.
				await tx.execute(
					sql`update ${sql.identifier(lock)} set ${sql.identifier('generation')} = ${sql.identifier('generation')} + 1 where ${sql.identifier('id')} = 1`,
				);
				// Read again under the lock: another migrate() may have applied more.
				const records = await appliedRecords(tx, table);
				checkAppliedMigrations(records, files, table);
				if (records.length >= file.id) return false;
				for (const [index, statement] of file.statements.entries()) {
					try {
						await tx.execute(statement.sql);
					} catch (error) {
						throw new CubridMigrationError(
							'statement-failed',
							`Migration ${file.fileName} failed at statement ${index + 1} of ${file.statements.length}; its transaction is rolled back, so none of its statements stay applied and it is not recorded. Migrations before it stay applied. Fix the file and run migrate() again. Statement (line ${statement.line}): ${statement.sql.slice(0, 200)}`,
							{
								migration: { id: file.id, name: file.name },
								statement: { index: index + 1, line: statement.line, sql: statement.sql },
								cause: error,
							},
						);
					}
				}
				await tx.execute(
					sql`insert into ${sql.identifier(table)} (${sql.identifier('id')}, ${sql.identifier('name')}, ${sql.identifier('checksum')}, ${sql.identifier('applied_at')}) values (${file.id}, ${file.name}, ${file.checksum}, ${sql.raw(utcNow())})`,
				);
				return true;
			},
			{ isolationLevel: 'read committed' },
		);
		if (done) applied.push(file);
	}
	return { applied, pending: [] };
}
