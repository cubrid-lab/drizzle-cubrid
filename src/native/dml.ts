// Native INSERT, UPDATE and DELETE (#159). SQL generation is in dialect.ts;
// every statement form below was run on CUBRID 11.4 (see docs/NATIVE_API.md).
// Results are cubrid-client's `affectedRows` and `lastInsertId`, never derived.

import { Column } from 'drizzle-orm/column';
import { entityKind, is } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import { fillPlaceholders, Placeholder, type Query, SQL, type SQLWrapper } from 'drizzle-orm/sql/sql';
import { getTableName } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';
import { CubridColumn } from './columns/common.js';
import type {
	CubridDeleteConfig,
	CubridDialect,
	CubridInsertConfig,
	CubridInsertRow,
	CubridOrderByItem,
	CubridUpdateConfig,
} from './dialect.js';
import { CubridQueryBuilder, CubridSelect } from './select.js';
import type { CubridDmlResult, CubridSession, CubridWriteOptions } from './session.js';
import type { CubridTable } from './table.js';

/** `null` for an `.autoIncrement()` column, which makes the server generate the value. */
type AutoIncrementNull<TColumns, K> = K extends keyof TColumns
	? TColumns[K] extends { _: { isAutoincrement: true } }
		? null
		: never
	: never;

/**
 * One row for `insert().values()`: the table's insert type, where any value
 * may also be `sql` or a placeholder, and an `.autoIncrement()` column may be
 * `null` (the server generates the value, as for a missing one).
 */
export type CubridInsertValue<TTable extends CubridTable> = {
	[K in keyof TTable['$inferInsert']]:
		| TTable['$inferInsert'][K]
		| SQL
		| Placeholder
		| AutoIncrementNull<TTable['_']['columns'], K>;
} & {};

/** The values of `update().set()` and `onDuplicateKeyUpdate({ set })`: any column, as a value or `sql`. */
export type CubridUpdateSet<TTable extends CubridTable> = {
	[K in keyof TTable['$inferInsert']]?: TTable['$inferInsert'][K] | SQL | Placeholder;
} & {};

type ReturnedKeyColumns<TColumns extends Record<string, Column>> = {
	[K in keyof TColumns as TColumns[K]['_']['isPrimaryKey'] extends true
		? TColumns[K]['_']['isAutoincrement'] extends true
			? K
			: TColumns[K]['_']['hasRuntimeDefault'] extends true
				? K
				: never
		: never]: TColumns[K]['_']['data'];
};

/** A row of `$returningId()`: the `.primaryKey()` columns with `.autoIncrement()` or `$defaultFn()`. */
export type CubridReturningId<TTable extends CubridTable> = ReturnedKeyColumns<TTable['_']['columns']> & {};

/** What `insert().select()` takes: a native select (`CubridSelect`). */
export interface CubridInsertSelectQuery extends SQLWrapper {
	getSelectedFields(): Record<string, unknown>;
}

/** An INSERT, UPDATE or DELETE built once; run it with `execute(placeholderValues)`. */
export class CubridPreparedWrite<TResult> {
	static readonly [entityKind]: string = 'CubridPreparedWrite';

	constructor(
		private readonly session: CubridSession,
		private readonly query: Query,
		private readonly map: (result: CubridDmlResult, placeholderValues: Record<string, unknown>) => TResult,
		private readonly options?: CubridWriteOptions,
	) {}

	async execute(placeholderValues: Record<string, unknown> = {}): Promise<TResult> {
		const params = fillPlaceholders(this.query.params, placeholderValues);
		return this.map(await this.session.write(this.query.sql, params, this.options), placeholderValues);
	}
}

function sameResult(result: CubridDmlResult): CubridDmlResult {
	return result;
}

/** `db.insert(table)`: give it `values()` or `select()`. */
export class CubridInsertBuilder<TTable extends CubridTable> {
	static readonly [entityKind]: string = 'CubridInsertBuilder';

	constructor(
		private readonly table: TTable,
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
	) {}

	/**
	 * One row or an array of rows (an empty array is refused). A column a row
	 * leaves out gets its `$defaultFn()` value, else its `$onUpdateFn()` value
	 * when it has no `.default()`, else the `DEFAULT` keyword.
	 */
	values(value: CubridInsertValue<TTable>): CubridInsert<TTable>;
	values(values: CubridInsertValue<TTable>[]): CubridInsert<TTable>;
	values(values: CubridInsertValue<TTable> | CubridInsertValue<TTable>[]): CubridInsert<TTable> {
		const rows: CubridInsertRow[] = Array.isArray(values) ? values : [values];
		if (rows.length === 0) throw new Error('insert().values() needs at least one row');
		for (const row of rows) {
			if (typeof row !== 'object' || row === null || is(row, SQL)) {
				throw new TypeError('insert().values() takes objects of column values by property key');
			}
		}
		return new CubridInsert(this.session, this.dialect, { table: this.table, values: rows });
	}

	/**
	 * `INSERT … SELECT`. Each selected field's key names the table column it
	 * is written to; columns the select leaves out get their DDL default
	 * (`$defaultFn()` is not applied). Nothing is read back, so no date or time
	 * value is decoded and the UTC-decoding check does not apply.
	 */
	select(query: CubridInsertSelectQuery | ((qb: CubridQueryBuilder) => CubridInsertSelectQuery)): CubridInsert<TTable> {
		const select = typeof query === 'function' ? query(new CubridQueryBuilder(this.session, this.dialect)) : query;
		if (!(select instanceof CubridSelect)) {
			throw new TypeError('insert().select() takes a drizzle-cubrid/native select or a callback returning one');
		}
		const columns = getTableColumns(this.table);
		const tableName = getTableName(this.table);
		const target = Object.entries(select.getSelectedFields()).map(([key, field]) => {
			const column = columns[key];
			if (!column) {
				throw new Error(`insert().select(): selected field ${key} is not a column of ${tableName}`);
			}
			if (!is(field, Column) && !is(field, SQL) && !is(field, SQL.Aliased)) {
				throw new Error(`insert().select(): selected field ${key} must be a column or sql, not an object or table`);
			}
			return column;
		});
		return new CubridInsert(this.session, this.dialect, {
			table: this.table,
			select: { query: select, columns: target },
		});
	}
}

/** An INSERT. Await it, or call `execute()`, `prepare()` or `toSQL()`. */
export class CubridInsert<TTable extends CubridTable> extends QueryPromise<CubridDmlResult> implements SQLWrapper {
	static override readonly [entityKind]: string = 'CubridInsert';

	declare readonly _: { readonly table: TTable };

	constructor(
		protected readonly session: CubridSession,
		protected readonly dialect: CubridDialect,
		protected readonly config: CubridInsertConfig,
	) {
		super();
	}

	/**
	 * `ON DUPLICATE KEY UPDATE "col" = value, …`, with the values encoded by
	 * their columns. Drizzle's MySQL `values(col)` / `sql\`values(...)\`` form
	 * is not supported: CUBRID 11.4 rejects it (#189).
	 */
	onDuplicateKeyUpdate(config: { set: CubridUpdateSet<TTable> }): this {
		this.config.onDuplicateKeyUpdate = config.set;
		return this;
	}

	/**
	 * The keys of the inserted rows: the `.primaryKey()` columns with
	 * `.autoIncrement()` or `$defaultFn()`. An AUTO_INCREMENT key comes from
	 * the driver's `lastInsertId` and is reported only for an INSERT of one
	 * row; see docs/NATIVE_API.md.
	 */
	$returningId(): CubridInsertReturningId<TTable> {
		return new CubridInsertReturningId(this.session, this.dialect, this.config);
	}

	getSQL(): SQL {
		return this.dialect.buildInsertQuery(this.config).query;
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	/** Builds the SQL once, generating `$defaultFn()` values once; `execute()` takes placeholder values. */
	prepare(): CubridPreparedWrite<CubridDmlResult> {
		return new CubridPreparedWrite(this.session, this.toSQL(), sameResult);
	}

	override async execute(): Promise<CubridDmlResult> {
		return this.prepare().execute();
	}
}

function isAutoIncrement(column: Column): boolean {
	return column instanceof CubridColumn && column.autoIncrement;
}

/** `insert(...).$returningId()`: resolves to the inserted rows' keys. */
export class CubridInsertReturningId<TTable extends CubridTable>
	extends QueryPromise<CubridReturningId<TTable>[]>
	implements SQLWrapper
{
	static override readonly [entityKind]: string = 'CubridInsertReturningId';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly config: CubridInsertConfig,
	) {
		super();
	}

	getSQL(): SQL {
		return this.dialect.buildInsertQuery(this.config).query;
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	/**
	 * Builds the SQL once. Refuses, before anything is sent, an INSERT … SELECT,
	 * a multi-row INSERT into a table with an AUTO_INCREMENT key (CUBRID does
	 * not promise that a statement's keys are consecutive, so they are not
	 * derived from `lastInsertId`) and a multi-row `onDuplicateKeyUpdate()`
	 * (which rows were inserted is not reported).
	 */
	prepare(): CubridPreparedWrite<CubridReturningId<TTable>[]> {
		const keys = Object.entries(getTableColumns(this.config.table)).filter(
			([, column]) => column.primary && (isAutoIncrement(column) || column.defaultFn !== undefined),
		);
		if (this.config.select) {
			throw new Error(
				'$returningId() cannot report the keys of INSERT ... SELECT on CUBRID; select the rows back by a unique column',
			);
		}
		const rowCount = this.config.values?.length ?? 0;
		const autoIncrement = keys.some(([, column]) => isAutoIncrement(column));
		if (rowCount !== 1 && autoIncrement) {
			throw new Error(
				'$returningId() can report an AUTO_INCREMENT key only for an INSERT of one row on CUBRID, which does not promise consecutive keys for a multi-row INSERT; insert the rows one at a time',
			);
		}
		const upsert = this.config.onDuplicateKeyUpdate !== undefined;
		if (rowCount !== 1 && upsert && keys.length > 0) {
			throw new Error(
				'$returningId() with onDuplicateKeyUpdate() needs an INSERT of one row: CUBRID does not report which rows were inserted and which updated',
			);
		}
		const { query, inserted } = this.dialect.buildInsertQuery(this.config);
		const map = (result: CubridDmlResult, placeholderValues: Record<string, unknown>) => {
			// With ON DUPLICATE KEY UPDATE, CUBRID reports affectedRows 2 whenever
			// the row conflicted (changed or not): no row then has the written key.
			if (upsert && result.affectedRows !== 1) return [];
			const rows: Record<string, unknown>[] = [];
			for (const written of inserted) {
				const row: Record<string, unknown> = {};
				for (const [key, column] of keys) {
					let value = written[key];
					if (is(value, Placeholder)) value = placeholderValues[value.name];
					// A key written as sql is unknown.
					if (is(value, SQL)) continue;
					if (value !== undefined && value !== null) {
						// As read back: a number given for a bigint key is reported as a bigint.
						row[key] = column.mapFromDriverValue(column.mapToDriverValue(value));
					} else if (isAutoIncrement(column) && result.affectedRows === 1) {
						// The server generated the key (none given, or NULL).
						if (result.lastInsertId === undefined) {
							throw new Error(
								`$returningId(): the row was inserted (affectedRows 1), but CUBRID reported no generated key for AUTO_INCREMENT column ${column.name}; do not retry the insert`,
							);
						}
						row[key] = column.mapFromDriverValue(result.lastInsertId);
					}
				}
				if (Object.keys(row).length > 0) rows.push(row);
			}
			return rows as CubridReturningId<TTable>[];
		};
		// AUTO_INCREMENT keys come from the keys the server says this INSERT
		// generated (GET_GENERATED_KEYS), never from the session's last insert
		// id, which cubrid-client leaves out when it equals the value seen
		// before. CUBRID 11.0-11.4 refuses the request, before inserting, for a
		// table with an INSERT trigger (-983).
		const options: CubridWriteOptions | undefined = autoIncrement ? { generatedKeys: true } : undefined;
		return new CubridPreparedWrite(this.session, this.dialect.sqlToQuery(query), map, options);
	}

	override async execute(): Promise<CubridReturningId<TTable>[]> {
		return this.prepare().execute();
	}
}

/** `db.update(table)`: give it `set()`. */
export class CubridUpdateBuilder<TTable extends CubridTable> {
	static readonly [entityKind]: string = 'CubridUpdateBuilder';

	constructor(
		private readonly table: TTable,
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
	) {}

	/** The new values; `undefined` ones are left out, and a set with none is refused. */
	set(values: CubridUpdateSet<TTable>): CubridUpdate<TTable> {
		if (!Object.values(values).some((value) => value !== undefined)) {
			throw new Error('update().set() needs at least one value to set');
		}
		return new CubridUpdate(this.session, this.dialect, { table: this.table, set: values, orderBy: [] });
	}
}

/** An UPDATE. Await it, or call `execute()`, `prepare()` or `toSQL()`. */
export class CubridUpdate<TTable extends CubridTable> extends QueryPromise<CubridDmlResult> implements SQLWrapper {
	static override readonly [entityKind]: string = 'CubridUpdate';

	declare readonly _: { readonly table: TTable };

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly config: CubridUpdateConfig,
	) {
		super();
	}

	where(where: SQL | undefined): this {
		this.config.where = where;
		return this;
	}

	/** ORDER BY, which decides the rows `limit()` updates. */
	orderBy(...columns: CubridOrderByItem[]): this {
		this.config.orderBy = columns;
		return this;
	}

	limit(limit: number | Placeholder): this {
		this.config.limit = limit;
		return this;
	}

	$dynamic(): this {
		return this;
	}

	getSQL(): SQL {
		return this.dialect.buildUpdateQuery(this.config);
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	prepare(): CubridPreparedWrite<CubridDmlResult> {
		return new CubridPreparedWrite(this.session, this.toSQL(), sameResult);
	}

	override async execute(): Promise<CubridDmlResult> {
		return this.prepare().execute();
	}
}

/**
 * A DELETE. Await it, or call `execute()`, `prepare()` or `toSQL()`. It has no
 * `orderBy()`: CUBRID 11.4 rejects DELETE with ORDER BY (#189).
 */
export class CubridDelete<TTable extends CubridTable> extends QueryPromise<CubridDmlResult> implements SQLWrapper {
	static override readonly [entityKind]: string = 'CubridDelete';

	declare readonly _: { readonly table: TTable };

	private readonly config: CubridDeleteConfig;

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		table: TTable,
	) {
		super();
		this.config = { table };
	}

	where(where: SQL | undefined): this {
		this.config.where = where;
		return this;
	}

	limit(limit: number | Placeholder): this {
		this.config.limit = limit;
		return this;
	}

	$dynamic(): this {
		return this;
	}

	getSQL(): SQL {
		return this.dialect.buildDeleteQuery(this.config);
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	prepare(): CubridPreparedWrite<CubridDmlResult> {
		return new CubridPreparedWrite(this.session, this.toSQL(), sameResult);
	}

	override async execute(): Promise<CubridDmlResult> {
		return this.prepare().execute();
	}
}
