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
import { fillPlaceholders, sql } from 'drizzle-orm/sql/sql';
import type { Query, SQL } from 'drizzle-orm/sql/sql';
import { type Assume } from 'drizzle-orm/utils';
import * as drizzleUtils from 'drizzle-orm/utils';

type QueryRow = Record<string, unknown>;

export type CubridRawQueryResult = QueryRow[];

/** Transaction settings `cubrid-client` accepts in `transaction(callback, options)`. */
export interface CubridTransactionOptions {
	isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

export interface CubridQueryable {
	query<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
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

/** Keeps `primary` as the thrown error and records `secondary` on it for diagnosis. */
function attachRollbackError(primary: unknown, secondary: unknown): void {
	if (primary instanceof Error && !('rollbackError' in primary)) {
		Object.defineProperty(primary, 'rollbackError', {
			value: secondary,
			configurable: true,
			writable: true,
		});
	}
}

interface CubridSessionOptions {
	logger?: Logger;
	mode: Mode;
}

const mapResultRow = (drizzleUtils as unknown as {
	mapResultRow: (
		fields: SelectedFieldsOrdered,
		row: unknown[],
		joinsNotNullableMap: Record<string, boolean> | undefined,
	) => unknown;
}).mapResultRow;

function toRowArray(row: unknown): unknown[] {
	if (Array.isArray(row)) {
		return row;
	}

	if (row && typeof row === 'object') {
		return Object.values(row as QueryRow);
	}

	return [row];
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

export class CubridPreparedQuery<T extends MySqlPreparedQueryConfig> extends MySqlPreparedQuery<T> {
	static override readonly [entityKind] = 'CubridPreparedQuery';

	constructor(
		private client: CubridQueryable,
		private queryString: string,
		private params: unknown[],
		private logger: Logger,
		cache: Cache | undefined,
		queryMetadata:
			| { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }
			| undefined,
		cacheConfig: WithCacheConfig | undefined,
		private fields: SelectedFieldsOrdered | undefined,
		private customResultMapper?: (rows: unknown[][]) => T['execute'],
		private generatedIds?: Record<string, unknown>[],
		private returningIds?: SelectedFieldsOrdered,
	) {
		super(cache, queryMetadata, cacheConfig);
	}

	async execute(placeholderValues: Record<string, unknown> = {}): Promise<T['execute']> {
		const params = fillPlaceholders(this.params, placeholderValues);
		this.logger.logQuery(this.queryString, params);

		if (!this.fields && !this.customResultMapper) {
			const result = await this.client.query(this.queryString, params);
			if (this.returningIds) {
				const meta = result[0] as QueryRow | undefined;
				const insertId = toNumber(meta?.insertId);
				const affectedRows = toNumber(meta?.affectedRows);

				if (insertId !== undefined && affectedRows !== undefined) {
					const returningResponse: Record<string, unknown>[] = [];
					for (let rowOffset = 0; rowOffset < affectedRows; rowOffset++) {
						const generated = this.generatedIds?.[rowOffset];
						for (const column of this.returningIds) {
							if (!is(column.field, Column)) {
								continue;
							}

							const key = column.path[0];
							const fieldMeta = column.field as Column & {
								autoIncrement?: boolean;
								defaultFn?: (() => unknown) | undefined;
							};

							if (column.field.primary && fieldMeta.autoIncrement) {
								returningResponse.push({ [key]: insertId + rowOffset });
								continue;
							}

							if (fieldMeta.defaultFn && generated && key in generated) {
								returningResponse.push({ [key]: generated[key] });
							}
						}
					}

					return returningResponse as T['execute'];
				}
			}

			return result as T['execute'];
		}

		const rows = await this.client.query(this.queryString, params);
		const rowArrays = rows.map(toRowArray);

		if (this.customResultMapper) {
			return this.customResultMapper(rowArrays);
		}

		const joinsNotNullableMap = (this as unknown as {
			joinsNotNullableMap: Record<string, boolean> | undefined;
		}).joinsNotNullableMap;

		return rowArrays.map((row) => mapResultRow(this.fields!, row, joinsNotNullableMap)) as T['execute'];
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

	constructor(
		private client: CubridQueryable,
		dialect: MySqlDialect,
		private schema: RelationalSchemaConfig<TSchema> | undefined,
		private options: CubridSessionOptions,
	) {
		super(dialect);
		this.logger = options.logger ?? new NoopLogger();
		this.mode = options.mode;
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
		) as PreparedQueryKind<CubridPreparedQueryHKT, T>;
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
				// unchanged; a failed rollback is kept on it as `rollbackError`.
				if (callbackFailure && driverError !== callbackFailure.error) {
					const rollbackError = (driverError as { rollbackError?: unknown } | null)?.rollbackError;
					if (rollbackError !== undefined) {
						attachRollbackError(callbackFailure.error, rollbackError);
					}
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
				attachRollbackError(error, rollbackError);
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
