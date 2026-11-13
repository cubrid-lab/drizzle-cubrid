import { Column } from 'drizzle-orm/column';
import type { Cache } from 'drizzle-orm/cache/core/cache';
import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import { entityKind, is } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { NoopLogger } from 'drizzle-orm/logger';
import type { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { SelectedFieldsOrdered } from 'drizzle-orm/mysql-core/query-builders/select.types';
import type {
	Mode,
	MySqlSession as MySqlSessionBase,
	MySqlPreparedQueryConfig,
	MySqlPreparedQueryHKT,
	MySqlQueryResultHKT,
	MySqlTransaction as MySqlTransactionBase,
	MySqlTransactionConfig,
	PreparedQueryKind,
} from 'drizzle-orm/mysql-core/session';
import { MySqlPreparedQuery, MySqlSession, MySqlTransaction } from 'drizzle-orm/mysql-core/session';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import { fillPlaceholders, SQL, sql } from 'drizzle-orm/sql/sql';
import type { Query } from 'drizzle-orm/sql/sql';
import { type Assume } from 'drizzle-orm/utils';
import * as drizzleUtils from 'drizzle-orm/utils';

import { isCubridTemporalColumn, TEMPORAL_COLUMN_TYPES } from './columns/temporal.js';
import { assertUtcDecoding } from './timezone.js';

type QueryRow = Record<string, unknown>;

/** What cubrid-client's `execute()` reports for INSERT, UPDATE and DELETE. */
export interface CubridExecuteResult {
	affectedRows: number;
	/** The generated AUTO_INCREMENT value; a `bigint` beyond `Number.MAX_SAFE_INTEGER`. */
	lastInsertId?: number | bigint;
}

/**
 * Rows for a SELECT. For INSERT, UPDATE and DELETE built with Drizzle's query
 * builders it is an empty array carrying `affectedRows` and, when the server
 * reported one, `lastInsertId`.
 */
export type CubridRawQueryResult = QueryRow[] & Partial<CubridExecuteResult>;

/**
 * How statement values reach the server.
 *
 * - `'prepared'` (default): typed binds through cubrid-client's
 *   `queryPrepared()`/`executePrepared()`, so no value ever becomes SQL text.
 * - `'literal'`: the driver writes each value into the SQL text as an escaped
 *   literal (`query()`/`execute()`). One round trip fewer per statement.
 */
export type CubridBinding = 'prepared' | 'literal';

/** Transaction settings `cubrid-client` accepts in `transaction(callback, options)`. */
export interface CubridTransactionOptions {
	isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

export interface CubridQueryable {
	query<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
	/**
	 * With `{ rowMode: 'array' }`, each row is an array of its values in
	 * select-list order (cubrid-client 1.4.0 and later). Drizzle maps selected
	 * fields by position, so this keeps columns whose labels repeat, such as
	 * `users.id` and `posts.id` in a join.
	 */
	query<T extends readonly unknown[] = unknown[]>(
		sql: string,
		params: readonly unknown[],
		options: { rowMode: 'array' },
	): Promise<T[]>;
	/** `query()` with the values sent as typed binds (cubrid-client 1.3.0 and later). */
	queryPrepared?<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
	queryPrepared?<T extends readonly unknown[] = unknown[]>(
		sql: string,
		params: readonly unknown[],
		options: { rowMode: 'array' },
	): Promise<T[]>;
	/** `execute()` with the values sent as typed binds (cubrid-client 1.3.0 and later). */
	executePrepared?(sql: string, params?: readonly unknown[]): Promise<CubridExecuteResult>;
	/**
	 * Runs `callback` on a connection the driver owns for the whole transaction,
	 * then commits, or rolls back if the callback throws. `CubridClient` and
	 * `CubridPool` from `cubrid-client` provide it. When present, Drizzle
	 * transactions use it, so unrelated statements on the shared client cannot
	 * join or end the transaction.
	 */
	transaction?<T>(
		callback: (tx: CubridQueryable) => Promise<T>,
		options?: CubridTransactionOptions,
	): Promise<T>;
	/**
	 * Runs INSERT, UPDATE or DELETE and reports what it changed. `CubridClient`,
	 * `CubridPool` and their transaction clients provide it (cubrid-client 1.3.0
	 * and later). Without it, writes still run through `query()` but report no
	 * counts, and `$returningId()` is refused.
	 */
	execute?(sql: string, params?: readonly unknown[]): Promise<CubridExecuteResult>;
	beginTransaction?(): Promise<void>;
	commit?(): Promise<void>;
	rollback?(): Promise<void>;
}

const SUPPORTED_ISOLATION_LEVELS = new Set(['read committed', 'repeatable read', 'serializable']);

/**
 * Turns Drizzle's MySQL-shaped transaction config into the options
 * `cubrid-client` understands. CUBRID has no READ UNCOMMITTED level, no
 * read-only transaction mode and no consistent-snapshot start, so those are
 * refused before a connection is taken rather than silently ignored.
 */
function toDriverTransactionOptions(
	config: MySqlTransactionConfig | undefined,
): CubridTransactionOptions | undefined {
	if (!config) {
		return undefined;
	}
	if (config.accessMode !== undefined) {
		throw new Error(`CUBRID transactions do not support accessMode '${config.accessMode}'`);
	}
	if (config.withConsistentSnapshot) {
		throw new Error('CUBRID transactions do not support withConsistentSnapshot');
	}
	if (config.isolationLevel === undefined) {
		return undefined;
	}
	if (!SUPPORTED_ISOLATION_LEVELS.has(config.isolationLevel)) {
		throw new Error(
			`CUBRID does not support isolation level '${config.isolationLevel}'; use 'read committed', 'repeatable read' or 'serializable'`,
		);
	}
	return { isolationLevel: config.isolationLevel as CubridTransactionOptions['isolationLevel'] };
}

/**
 * Records `value` on the error being rethrown, for diagnosis, without replacing
 * that error. Skips values that are not extensible errors and keeps a property
 * that is already set.
 */
function attachDiagnostic(primary: unknown, key: 'rollbackError' | 'transactionError', value: unknown): void {
	if (primary instanceof Error && Object.isExtensible(primary) && !(key in primary)) {
		Object.defineProperty(primary, key, {
			value,
			configurable: true,
			enumerable: true,
			writable: true,
		});
	}
}

interface CubridSessionOptions {
	logger?: Logger;
	mode: Mode;
	/** Defaults to `'prepared'`. */
	binding?: CubridBinding;
}

/**
 * The client as the session uses it: with `'prepared'` binding, `query()` and
 * `execute()` go to the driver's typed-binding methods, so the statement code
 * and the transaction client need no separate path. A client without typed
 * binding is refused rather than silently falling back to SQL literals.
 */
function withBinding(client: CubridQueryable, binding: CubridBinding | undefined): CubridQueryable {
	const mode = binding ?? 'prepared';
	if (mode === 'literal') {
		return client;
	}
	if (mode !== 'prepared') {
		throw new Error(`Unknown binding '${String(binding)}'; use 'prepared' or 'literal'`);
	}
	if (typeof client.queryPrepared !== 'function') {
		throw new Error(
			"The CUBRID client has no queryPrepared() for typed binding (cubrid-client 1.3.0 or later); pass { binding: 'literal' } to drizzle() to send values as SQL literals",
		);
	}
	const bound: CubridQueryable = {
		query: client.queryPrepared.bind(client) as CubridQueryable['query'],
	};
	if (typeof client.executePrepared === 'function') {
		bound.execute = client.executePrepared.bind(client);
	} else if (typeof client.execute === 'function') {
		// Writes would lose their affected-row counts and keys rather than use the
		// literal execute(); refuse instead of changing what a write reports.
		throw new Error(
			"The CUBRID client has execute() but no executePrepared() for typed binding; pass { binding: 'literal' } to drizzle() or add executePrepared()",
		);
	}
	if (typeof client.transaction === 'function') {
		bound.transaction = client.transaction.bind(client);
	}
	if (typeof client.beginTransaction === 'function') {
		bound.beginTransaction = client.beginTransaction.bind(client);
	}
	if (typeof client.commit === 'function') {
		bound.commit = client.commit.bind(client);
	}
	if (typeof client.rollback === 'function') {
		bound.rollback = client.rollback.bind(client);
	}
	return bound;
}

const mapResultRow = (drizzleUtils as unknown as {
	mapResultRow: (
		fields: SelectedFieldsOrdered,
		row: unknown[],
		joinsNotNullableMap: Record<string, boolean> | undefined,
	) => unknown;
}).mapResultRow;

const ARRAY_ROWS = { rowMode: 'array' } as const;

/** How drizzle-orm's MySqlCountBuilder starts the statement behind `db.$count()`. */
const DRIZZLE_COUNT_PREFIX = 'select count(*) as count from ';

/**
 * A column whose value is written as SQL, such as a SET/MULTISET/SEQUENCE
 * literal, cannot take a placeholder for the whole value: Drizzle encodes the
 * placeholder's value only when the statement runs, after the SQL text is
 * fixed, and would hand the SQL fragment to the driver as a parameter.
 */
function assertNoSqlParams(params: unknown[]): void {
	if (params.some((param) => is(param, SQL))) {
		throw new Error(
			'A placeholder was used for a column whose value is written as SQL (a SET, MULTISET or SEQUENCE column); pass the value directly instead of sql.placeholder()',
		);
	}
}

/**
 * Converts a generated key to the column's JavaScript type, such as `bigint`
 * for `bigint({ mode: 'bigint' })`. Refuses a key the column type would round.
 */
function toKeyValue(column: Column, lastInsertId: number | bigint): unknown {
	const value = column.mapFromDriverValue(lastInsertId);
	if (typeof lastInsertId === 'bigint' && typeof value === 'number' && BigInt(value) !== lastInsertId) {
		throw new Error(
			`Generated key ${lastInsertId} of column ${column.name} is not exact as a number; declare the column with { mode: 'bigint' }`,
		);
	}
	return value;
}

function withExecuteResult(rows: QueryRow[], meta: CubridExecuteResult): CubridRawQueryResult {
	const result: CubridRawQueryResult = rows;
	result.affectedRows = meta.affectedRows;
	if (meta.lastInsertId !== undefined) {
		result.lastInsertId = meta.lastInsertId;
	}
	return result;
}

/**
 * Object rows cannot be mapped by position: a repeated column label keeps only
 * one value and the key order is not the select-list order. Refuse them rather
 * than mapping values to the wrong fields.
 */
function assertArrayRow(row: unknown): unknown[] {
	if (Array.isArray(row)) {
		return row;
	}
	throw new Error(
		`The CUBRID client returned a non-array row (${row === null ? 'null' : typeof row}) for { rowMode: 'array' }; drizzle-cubrid needs cubrid-client 1.4.0 or later, or a client whose query() supports rowMode 'array'`,
	);
}

/** The column a selected field is decoded with: the column itself, or `sql.mapWith(column)`. */
function decoderOf(field: unknown): unknown {
	if (is(field, Column)) {
		return field;
	}
	if (is(field, SQL)) {
		return (field as unknown as { decoder?: unknown }).decoder;
	}
	if (is(field, SQL.Aliased)) {
		return (field.sql as unknown as { decoder?: unknown }).decoder;
	}
	return undefined;
}

/** A date or time column, or a collection column whose element is one. */
function readsTemporal(field: unknown): boolean {
	const decoder = decoderOf(field);
	if (isCubridTemporalColumn(decoder)) {
		return true;
	}
	const elementType = (
		decoder as { config?: { fieldConfig?: { element?: { config?: { columnType?: unknown } } } } } | undefined
	)?.config?.fieldConfig?.element?.config?.columnType;
	return is(decoder, Column) && typeof elementType === 'string' && TEMPORAL_COLUMN_TYPES.has(elementType);
}

export class CubridPreparedQuery<T extends MySqlPreparedQueryConfig> extends MySqlPreparedQuery<T> {
	static override readonly [entityKind] = 'CubridPreparedQuery';

	constructor(
		private client: CubridQueryable,
		private queryString: string,
		private params: unknown[],
		private logger: Logger,
		cache: Cache | undefined,
		private statementMetadata:
			| { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }
			| undefined,
		cacheConfig: WithCacheConfig | undefined,
		private fields: SelectedFieldsOrdered | undefined,
		private customResultMapper?: (rows: unknown[][]) => T['execute'],
		private generatedIds?: Record<string, unknown>[],
		private returningIds?: SelectedFieldsOrdered,
		/**
		 * The client as the application created it, before `binding` wrapped it:
		 * its time zone setting decides whether date and time columns can be read.
		 */
		private zoneClient?: CubridQueryable,
	) {
		super(cache, statementMetadata, cacheConfig);
	}

	async execute(placeholderValues: Record<string, unknown> = {}): Promise<T['execute']> {
		const params = fillPlaceholders(this.params, placeholderValues);
		assertNoSqlParams(params);
		this.logger.logQuery(this.queryString, params);

		if (!this.fields && !this.customResultMapper) {
			if (this.returningIds) {
				return (await this.executeReturningIds(params)) as T['execute'];
			}
			const type = this.statementMetadata?.type;
			const isWrite = type === 'insert' || type === 'update' || type === 'delete';
			if (isWrite && typeof this.client.execute === 'function') {
				const meta = await this.client.execute(this.queryString, params);
				return withExecuteResult([], meta) as T['execute'];
			}
			return (await this.client.query(this.queryString, params)) as T['execute'];
		}

		const zoneClient = this.zoneClient ?? this.client;
		if (this.fields?.some((selected) => readsTemporal(selected.field))) {
			await assertUtcDecoding(zoneClient);
		}

		const rows = await this.client.query(this.queryString, params, ARRAY_ROWS);
		const rowArrays = rows.map(assertArrayRow);

		if (this.customResultMapper) {
			// Relational queries carry no fields to check before sending.
			if (rowArrays.some((row) => row.some((cell) => cell instanceof Date))) {
				await assertUtcDecoding(zoneClient);
			}
			return this.customResultMapper(rowArrays);
		}

		const joinsNotNullableMap = (this as unknown as {
			joinsNotNullableMap: Record<string, boolean> | undefined;
		}).joinsNotNullableMap;

		return rowArrays.map((row) => mapResultRow(this.fields!, row, joinsNotNullableMap)) as T['execute'];
	}

	/**
	 * `$returningId()`: the keys of the rows an INSERT created. AUTO_INCREMENT
	 * keys come from the `lastInsertId` the server reports, which is the first
	 * key of the statement. CUBRID does not promise that the keys of a multi-row
	 * INSERT are consecutive, so those are refused before anything is sent
	 * rather than derived. `$defaultFn` keys are the values Drizzle generated.
	 */
	private async executeReturningIds(params: unknown[]): Promise<Record<string, unknown>[]> {
		const returningIds = this.returningIds!;
		const columns = returningIds.filter((column) => is(column.field, Column));
		const isAutoIncrementKey = (column: SelectedFieldsOrdered[number]): boolean => {
			const field = column.field as Column & { autoIncrement?: boolean };
			return field.primary && field.autoIncrement === true;
		};
		const rowCount = this.generatedIds?.length ?? 0;
		if (columns.some(isAutoIncrementKey) && rowCount !== 1) {
			throw new Error(
				rowCount === 0
					? '$returningId() cannot report AUTO_INCREMENT keys of INSERT ... SELECT on CUBRID'
					: '$returningId() can report an AUTO_INCREMENT key only for an INSERT of one row on CUBRID; insert the rows one at a time',
			);
		}
		if (typeof this.client.execute !== 'function') {
			throw new Error('$returningId() needs a client with execute() (cubrid-client 1.3.0 or later)');
		}

		const meta = await this.client.execute(this.queryString, params);
		const response: Record<string, unknown>[] = [];
		for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
			const generated = this.generatedIds?.[rowOffset];
			for (const column of columns) {
				const key = column.path[0]!;
				if (isAutoIncrementKey(column)) {
					// affectedRows is 2 when onDuplicateKeyUpdate() updated an existing
					// row; CUBRID still reports a consumed AUTO_INCREMENT value then,
					// which is no row's key.
					if (meta.lastInsertId !== undefined && meta.affectedRows === 1) {
						response.push({ [key]: toKeyValue(column.field as Column, meta.lastInsertId) });
					}
					continue;
				}
				const field = column.field as Column & { defaultFn?: (() => unknown) | undefined };
				if (field.defaultFn && generated && key in generated) {
					response.push({ [key]: generated[key] });
				}
			}
		}
		return response;
	}

	override async *iterator(): AsyncGenerator<T['iterator']> {
		throw new Error('Streaming is not supported by the CUBRID driver');
	}
}

export class CubridSession<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends MySqlSession<CubridQueryResultHKT, CubridPreparedQueryHKT, TFullSchema, TSchema> {
	static override readonly [entityKind] = 'CubridSession';

	private logger: Logger;
	private mode: Mode;
	private client: CubridQueryable;
	/** The client before `withBinding()`; see `CubridPreparedQuery`. */
	private zoneClient: CubridQueryable;

	constructor(
		client: CubridQueryable,
		dialect: MySqlDialect,
		private schema: RelationalSchemaConfig<TSchema> | undefined,
		private options: CubridSessionOptions,
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.mode = options.mode;
		this.client = withBinding(client, options.binding);
		this.zoneClient = client;
	}

	prepareQuery<T extends MySqlPreparedQueryConfig>(
		query: Query,
		fields: SelectedFieldsOrdered | undefined,
		customResultMapper?: (rows: unknown[][]) => T['execute'],
		generatedIds?: Record<string, unknown>[],
		returningIds?: SelectedFieldsOrdered,
		queryMetadata?: { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] },
		cacheConfig?: WithCacheConfig,
	): PreparedQueryKind<CubridPreparedQueryHKT, T> {
		return new CubridPreparedQuery(
			this.client,
			query.sql,
			query.params,
			this.logger,
			undefined,
			queryMetadata,
			cacheConfig,
			fields,
			customResultMapper,
			generatedIds,
			returningIds,
			this.zoneClient,
		) as PreparedQueryKind<CubridPreparedQueryHKT, T>;
	}

	/**
	 * `db.$count()`. Drizzle's MySQL count names its column `count`, a reserved
	 * word in CUBRID, and reads a mysql2-shaped `[rows, fields]` result. The
	 * alias is dropped and the count read by position instead.
	 */
	override async count(countSql: SQL): Promise<number> {
		const query = this.dialect.sqlToQuery(countSql);
		if (!query.sql.startsWith(DRIZZLE_COUNT_PREFIX)) {
			throw new Error(
				`Unexpected $count() SQL from this drizzle-orm version; expected it to start with '${DRIZZLE_COUNT_PREFIX}'`,
			);
		}
		const countQuery = `select count(*) from ${query.sql.slice(DRIZZLE_COUNT_PREFIX.length)}`;
		// $count() is never prepared with placeholder values; this reports a
		// sql.placeholder() in the filter as Drizzle does for other statements.
		const params = fillPlaceholders(query.params, {});
		assertNoSqlParams(params);
		this.logger.logQuery(countQuery, params);
		const rows = await this.client.query(countQuery, params, ARRAY_ROWS);
		const [row] = rows.map(assertArrayRow);
		if (row === undefined) {
			throw new Error('$count() returned no row');
		}
		// COUNT(*) is a BIGINT, which cubrid-client returns as a bigint.
		return Number(row[0]);
	}

	async all<T = unknown>(query: SQL): Promise<T[]> {
		const querySql = this.dialect.sqlToQuery(query);
		this.logger.logQuery(querySql.sql, querySql.params);
		const rows = await this.client.query(querySql.sql, querySql.params);
		return rows as T[];
	}

	async transaction<T>(
		transaction: (
			tx: MySqlTransactionBase<CubridQueryResultHKT, CubridPreparedQueryHKT, TFullSchema, TSchema>,
		) => Promise<T>,
		config?: MySqlTransactionConfig,
	): Promise<T> {
		if (typeof this.client.transaction === 'function') {
			const options = toDriverTransactionOptions(config);
			if (options !== undefined && this.client.transaction.length < 2) {
				// cubrid-client before 1.3.0 has transaction(callback) only and would
				// silently run at the server's default isolation level. A wrapper
				// declared as `(...args)` also has length 0 and is refused here.
				throw new Error(
					"isolationLevel needs a client whose transaction() declares an options parameter (cubrid-client 1.3.0 or later)",
				);
			}
			let callbackFailure: { error: unknown } | undefined;
			const run = async (txClient: CubridQueryable): Promise<T> => {
				// Every statement in the callback, including savepoints, runs on the
				// connection the driver reserved for this transaction.
				const txSession = new CubridSession<TFullSchema, TSchema>(
					txClient,
					this.dialect,
					this.schema,
					this.options,
				);
				const tx = new CubridTransaction<TFullSchema, TSchema>(
					this.dialect,
					txSession as unknown as MySqlSessionBase,
					this.schema,
					0,
					this.mode,
				);
				try {
					return await transaction(tx);
				} catch (error) {
					callbackFailure = { error };
					throw error;
				}
			};
			try {
				return options === undefined
					? await this.client.transaction(run)
					: await this.client.transaction(run, options);
			} catch (driverError) {
				// cubrid-client wraps a callback failure in its own TransactionError.
				// Rethrow the callback's error itself, so Drizzle's rollback signal
				// (TransactionRollbackError) and application errors reach the caller
				// as the same object. The driver's error (with its rollbackError,
				// closeError and outcomeUnknown) is kept as `transactionError`, and a
				// failed rollback also as `rollbackError`.
				if (callbackFailure && driverError !== callbackFailure.error) {
					const rollbackError = (driverError as { rollbackError?: unknown } | null)?.rollbackError;
					if (rollbackError !== undefined) {
						attachDiagnostic(callbackFailure.error, 'rollbackError', rollbackError);
					}
					attachDiagnostic(callbackFailure.error, 'transactionError', driverError);
					throw callbackFailure.error;
				}
				throw driverError;
			}
		}

		// Fallback for custom queryables without transaction(): BEGIN/COMMIT on the
		// same connection. Only safe when nothing else uses that connection at the
		// same time.
		const tx = new CubridTransaction<TFullSchema, TSchema>(
			this.dialect,
			this as unknown as MySqlSessionBase,
			this.schema,
			0,
			this.mode,
		);

		if (typeof this.client.beginTransaction === 'function') {
			if (config) {
				const setTransactionConfigSql = this.getSetTransactionSQL(config);
				if (setTransactionConfigSql) {
					await tx.execute(setTransactionConfigSql);
				}
			}
			await this.client.beginTransaction();
		} else {
			if (config) {
				const setTransactionConfigSql = this.getSetTransactionSQL(config);
				if (setTransactionConfigSql) {
					await tx.execute(setTransactionConfigSql);
				}
				const startTransactionSql = this.getStartTransactionSQL(config);
				await tx.execute(startTransactionSql ?? sql`begin`);
			} else {
				await tx.execute(sql`begin`);
			}
		}

		try {
			const result = await transaction(tx);
			if (typeof this.client.commit === 'function') {
				await this.client.commit();
			} else {
				await tx.execute(sql`commit`);
			}
			return result;
		} catch (error) {
			if (typeof this.client.rollback === 'function') {
				await this.client.rollback();
			} else {
				await tx.execute(sql`rollback`);
			}
			throw error;
		}
	}
}

export class CubridTransaction<
	TFullSchema extends Record<string, unknown>,
	TSchema extends TablesRelationalConfig,
> extends MySqlTransaction<CubridQueryResultHKT, CubridPreparedQueryHKT, TFullSchema, TSchema> {
	static override readonly [entityKind] = 'CubridTransaction';

	constructor(
		dialect: MySqlDialect,
		session: MySqlSessionBase,
		schema: RelationalSchemaConfig<TSchema> | undefined,
		nestedIndex: number,
		mode: Mode,
	) {
		super(dialect, session, schema, nestedIndex, mode);
		this.dialectRef = dialect;
		this.sessionRef = session;
	}

	private dialectRef: MySqlDialect;
	private sessionRef: MySqlSessionBase;

	async transaction<T>(
		transaction: (
			tx: MySqlTransactionBase<CubridQueryResultHKT, CubridPreparedQueryHKT, TFullSchema, TSchema>,
		) => Promise<T>,
	): Promise<T> {
		const savepointName = `sp${this.nestedIndex + 1}`;
		const tx = new CubridTransaction<TFullSchema, TSchema>(
			this.dialectRef,
			this.sessionRef,
			this.schema,
			this.nestedIndex + 1,
			this.mode,
		);

		await tx.execute(sql.raw(`savepoint ${savepointName}`));
		try {
			return await transaction(tx);
		} catch (error) {
			try {
				await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
			} catch (rollbackError) {
				attachDiagnostic(error, 'rollbackError', rollbackError);
			}
			throw error;
		}
	}
}

export interface CubridQueryResultHKT extends MySqlQueryResultHKT {
	type: CubridRawQueryResult;
}

export interface CubridPreparedQueryHKT extends MySqlPreparedQueryHKT {
	type: CubridPreparedQuery<Assume<this['config'], MySqlPreparedQueryConfig>>;
}
