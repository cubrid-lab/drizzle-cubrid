// The native SELECT builder (#158). Result types come from Drizzle's neutral
// `query-builders/select.types`, so they match Drizzle's other dialects; SQL
// generation and row mapping are in dialect.ts.

import { aliasedTable, Subquery } from 'drizzle-orm';
import { Column, type ColumnBaseConfig, type UpdateColConfig } from 'drizzle-orm/column';
import type { ColumnDataType } from 'drizzle-orm/column-builder';
import { entityKind, is } from 'drizzle-orm/entity';
import type { SelectedFields } from 'drizzle-orm/operations';
import type {
	AppendToNullabilityMap,
	AppendToResult,
	BuildSubquerySelection,
	GetSelectTableName,
	GetSelectTableSelection,
	JoinNullability,
	SelectMode,
	SelectResult,
} from 'drizzle-orm/query-builders/select.types';
import { QueryPromise } from 'drizzle-orm/query-promise';
import {
	type ColumnsSelection,
	fillPlaceholders,
	noopDecoder,
	type Placeholder,
	type Query,
	SQL,
	type SQLWrapper,
	sql,
} from 'drizzle-orm/sql/sql';
import { Table } from 'drizzle-orm/table';
import type { Assume, DrizzleTypeError, Simplify } from 'drizzle-orm/utils';
import { getTableColumns } from 'drizzle-orm/utils';
import type { CubridColumn } from './columns/common.js';
import {
	type CubridDialect,
	type CubridJoinType,
	type CubridOrderByItem,
	type CubridSelectConfig,
	type CubridSelectSource,
	mapRow,
	markSubqueryField,
	type OrderedField,
	orderSelectedFields,
	outputName,
	readsTemporal,
	sourceName,
	subqueryFieldSource,
} from './dialect.js';
import { getSqlDecoder } from './internal.js';
import type { CubridSession } from './session.js';
import { CubridTable } from './table.js';

/** A native table or a native subquery: what `from()` and the joins accept. */
export type CubridSource = CubridTable | Subquery;

/**
 * The fields of a subquery made with `.as(alias)`, re-pointed at the alias.
 * `sql` fields keep Drizzle's `SQL.Aliased` type, but at runtime they are
 * plain `sql` expressions reading `"alias"."name"` (`fieldAlias` is
 * undefined), because Drizzle renders an `SQL.Aliased` in a condition as its
 * bare name, which CUBRID can find ambiguous.
 */
export type CubridAliasedSelection<TSelection, TAlias extends string> = Simplify<{
	[K in keyof TSelection]: TSelection[K] extends Column
		? CubridColumn<
				Assume<UpdateColConfig<TSelection[K]['_'], { tableName: TAlias }>, ColumnBaseConfig<ColumnDataType, string>>
			>
		: TSelection[K] extends SQL.Aliased | DrizzleTypeError<string>
			? TSelection[K]
			: TSelection[K] extends ColumnsSelection
				? CubridAliasedSelection<TSelection[K], TAlias>
				: never;
}>;

/** A subquery made with `.as(alias)`: a `Subquery` whose fields are also its properties. */
export type CubridSubquery<TAlias extends string, TSelection extends ColumnsSelection> = Subquery<TAlias, TSelection> &
	TSelection;

type DefaultNullability<TTableName extends string | undefined> = TTableName extends string
	? Record<TTableName, 'not-null'>
	: Record<string, never>;

type JoinedSelect<
	TTableName extends string | undefined,
	TSelection extends ColumnsSelection,
	TSelectMode extends SelectMode,
	TNullabilityMap extends Record<string, JoinNullability>,
	TJoined extends CubridSource,
	TJoinType extends CubridJoinType,
> = CubridSelect<
	TTableName,
	Assume<
		AppendToResult<
			TTableName,
			TSelection,
			GetSelectTableName<TJoined>,
			Assume<GetSelectTableSelection<TJoined>, SelectedFields<Column, Table>>,
			TSelectMode
		>,
		ColumnsSelection
	>,
	TSelectMode extends 'partial' ? 'partial' : 'multiple',
	AppendToNullabilityMap<TNullabilityMap, GetSelectTableName<TJoined>, TJoinType>
>;

type Condition<TSelection> = SQL | undefined | ((fields: TSelection) => SQL | undefined);
type OrderItems<TSelection> =
	| [CubridOrderByItem, ...CubridOrderByItem[]]
	| [(fields: TSelection) => CubridOrderByItem | CubridOrderByItem[]];

function selectionOf(source: CubridSelectSource): Record<string, unknown> {
	return is(source, Subquery) ? source._.selectedFields : getTableColumns(source);
}

function assertSource(source: unknown, where: string): asserts source is CubridSource {
	if (!(source instanceof CubridTable) && !is(source, Subquery)) {
		throw new TypeError(`${where} needs a drizzle-cubrid/native table or a subquery made with .as()`);
	}
}

/**
 * A subquery's column as seen from outside: the column `"alias"."key.path"`,
 * with the original column's codec. Its table is Drizzle's public
 * `aliasedTable()`, so `getTableName()` gives the alias.
 */
function subqueryColumn(column: Column, alias: string, name: string): Column {
	const table = aliasedTable(column.table, alias);
	return new Proxy(column, {
		get(target, prop, receiver) {
			if (prop === 'table') return table;
			if (prop === 'name') return name;
			if (prop === 'keyAsName') return false;
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * The fields of a subquery, re-pointed at its alias: each one refers to the
 * output name its key path got in the subquery (`"alias"."key.path"`), in the
 * select list and in conditions alike.
 */
function aliasFields(fields: Record<string, unknown>, alias: string, prefix: string[] = []): Record<string, unknown> {
	const aliased: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		const path = [...prefix, key];
		const name = outputName(path, value);
		if (is(value, SQL.Aliased) || (is(value, SQL) && subqueryFieldSource(value) !== undefined)) {
			const decoder = getSqlDecoder(is(value, SQL) ? value : value.sql) ?? noopDecoder;
			aliased[key] = markSubqueryField(sql`${sql.identifier(alias)}.${sql.identifier(name)}`.mapWith(decoder), alias);
		} else if (is(value, SQL)) {
			throw new Error(`Subquery field ${name} is raw sql without a name; give it one with sql\`...\`.as('name')`);
		} else if (is(value, Table)) {
			aliased[key] = aliasFields(getTableColumns(value), alias, path);
		} else if (is(value, Column)) {
			aliased[key] = subqueryColumn(value, alias, name);
		} else if (typeof value === 'object' && value !== null) {
			aliased[key] = aliasFields(value as Record<string, unknown>, alias, path);
		}
	}
	return aliased;
}

export class CubridSelectBuilder<TSelection extends ColumnsSelection | undefined> {
	static readonly [entityKind]: string = 'CubridSelectBuilder';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly fields: TSelection,
		private readonly distinct: boolean,
	) {}

	from<TFrom extends CubridSource>(
		source: TFrom,
	): CubridSelect<
		GetSelectTableName<TFrom>,
		TSelection extends undefined
			? Assume<GetSelectTableSelection<TFrom>, ColumnsSelection>
			: Assume<TSelection, ColumnsSelection>,
		TSelection extends undefined ? 'single' : 'partial'
	> {
		assertSource(source, 'from()');
		const name = sourceName(source);
		return new CubridSelect(this.session, this.dialect, {
			fields: this.fields ?? selectionOf(source),
			partial: this.fields !== undefined,
			distinct: this.distinct,
			source,
			joins: [],
			groupBy: [],
			orderBy: [],
			forUpdate: false,
			nullability: { [name]: true },
		});
	}
}

interface CubridSelectState extends CubridSelectConfig {
	/** Whether the fields were given to select(); otherwise they are the tables' columns. */
	partial: boolean;
	/** Source name → whether its columns are never NULL from a join. */
	nullability: Record<string, boolean>;
}

/**
 * A SELECT. Methods change the query and return it, as Drizzle's builders do;
 * a join returns a new object over the same query, since it changes the
 * result type. Await it, or call `execute()`, `prepare()` or `toSQL()`.
 */
export class CubridSelect<
		TTableName extends string | undefined,
		TSelection extends ColumnsSelection,
		TSelectMode extends SelectMode,
		TNullabilityMap extends Record<string, JoinNullability> = DefaultNullability<TTableName>,
	>
	extends QueryPromise<SelectResult<TSelection, TSelectMode, TNullabilityMap>[]>
	implements SQLWrapper
{
	static override readonly [entityKind]: string = 'CubridSelect';

	declare readonly _: {
		readonly tableName: TTableName;
		readonly selection: TSelection;
		readonly selectMode: TSelectMode;
		readonly nullabilityMap: TNullabilityMap;
		readonly result: SelectResult<TSelection, TSelectMode, TNullabilityMap>[];
	};

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly config: CubridSelectState,
	) {
		super();
	}

	private join<TJoined extends CubridSource, TJoinType extends CubridJoinType>(
		type: TJoinType,
		source: TJoined,
		on: SQL | undefined,
	): JoinedSelect<TTableName, TSelection, TSelectMode, TNullabilityMap, TJoined, TJoinType> {
		assertSource(source, `${type} join`);
		const config = this.config;
		const name = sourceName(source);
		if (name in config.nullability) {
			throw new Error(`${name} is already used in this query; give the table or subquery another alias`);
		}
		if (!config.partial) {
			if (config.joins.length === 0) config.fields = { [sourceName(config.source)]: config.fields };
			config.fields[name] = selectionOf(source);
		}
		if (type === 'left') config.nullability[name] = false;
		else if (type === 'right') {
			for (const key of Object.keys(config.nullability)) config.nullability[key] = false;
			config.nullability[name] = true;
		} else config.nullability[name] = true;
		config.joins.push({ type, source, on });
		return new CubridSelect(this.session, this.dialect, config);
	}

	innerJoin<TJoined extends CubridSource>(source: TJoined, on: SQL | undefined) {
		return this.join('inner', source, on);
	}

	/** LEFT JOIN: the joined fields are `null` (or the joined object is) where nothing matched. */
	leftJoin<TJoined extends CubridSource>(source: TJoined, on: SQL | undefined) {
		return this.join('left', source, on);
	}

	/** RIGHT JOIN: the fields of every earlier table become nullable. */
	rightJoin<TJoined extends CubridSource>(source: TJoined, on: SQL | undefined) {
		return this.join('right', source, on);
	}

	crossJoin<TJoined extends CubridSource>(source: TJoined) {
		return this.join('cross', source, undefined);
	}

	private condition(condition: Condition<TSelection>): SQL | undefined {
		return typeof condition === 'function' ? condition(this.config.fields as TSelection) : condition;
	}

	private items(items: OrderItems<TSelection>): CubridOrderByItem[] {
		const [first] = items;
		if (typeof first === 'function') {
			const result = first(this.config.fields as TSelection);
			return Array.isArray(result) ? result : [result];
		}
		return items as CubridOrderByItem[];
	}

	where(where: Condition<TSelection>): this {
		this.config.where = this.condition(where);
		return this;
	}

	groupBy(...columns: OrderItems<TSelection>): this {
		this.config.groupBy = this.items(columns);
		return this;
	}

	having(having: Condition<TSelection>): this {
		this.config.having = this.condition(having);
		return this;
	}

	/** ORDER BY; use Drizzle's `asc()` and `desc()` for the direction. */
	orderBy(...columns: OrderItems<TSelection>): this {
		this.config.orderBy = this.items(columns);
		return this;
	}

	limit(limit: number | Placeholder): this {
		this.config.limit = limit;
		return this;
	}

	/** OFFSET; CUBRID needs a `limit()` with it. */
	offset(offset: number | Placeholder): this {
		this.config.offset = offset;
		return this;
	}

	/**
	 * `FOR UPDATE`, which locks the selected rows until the transaction ends;
	 * use it inside a transaction. CUBRID has no shared locks and no
	 * NOWAIT/SKIP LOCKED, so anything else is refused.
	 */
	for(strength: 'update', config?: Record<string, never>): this {
		if (strength !== 'update') {
			throw new Error(`CUBRID supports only FOR UPDATE, not for('${String(strength)}')`);
		}
		if (config && Object.keys(config).length > 0) {
			throw new Error(`CUBRID FOR UPDATE takes no options (${Object.keys(config).join(', ')})`);
		}
		this.config.forUpdate = true;
		return this;
	}

	/** Returns the query typed for dynamic building (`qb = qb.where(...)`). */
	$dynamic(): this {
		return this;
	}

	getSQL(): SQL {
		return this.dialect.buildSelectQuery(this.config);
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	/** This query as a subquery for `from()`, a join or another query's condition. */
	as<TAlias extends string>(
		alias: TAlias,
	): CubridSubquery<TAlias, CubridAliasedSelection<BuildSubquerySelection<TSelection, TNullabilityMap>, TAlias>> {
		for (const key of Object.keys(this.config.fields)) {
			if (key === '_' || key === 'getSQL') throw new Error(`A subquery field cannot be named ${key}`);
		}
		const fields = aliasFields(this.config.fields, alias);
		const query = this.dialect.buildSelectQuery(this.config, true);
		return Object.assign(new Subquery(query, fields, alias), fields) as CubridSubquery<
			TAlias,
			CubridAliasedSelection<BuildSubquerySelection<TSelection, TNullabilityMap>, TAlias>
		>;
	}

	/** Builds the SQL once; `execute()` takes the values of `sql.placeholder()`s. */
	prepare(): CubridPreparedSelect<SelectResult<TSelection, TSelectMode, TNullabilityMap>> {
		const fields = orderSelectedFields(this.config.fields);
		const query = this.toSQL();
		const nullability = this.config.joins.length > 0 ? { ...this.config.nullability } : undefined;
		return new CubridPreparedSelect(this.session, query, fields, nullability);
	}

	override execute(): Promise<SelectResult<TSelection, TSelectMode, TNullabilityMap>[]> {
		return this.prepare().execute();
	}
}

/** A SELECT built once; run it with `execute(placeholderValues)`. */
export class CubridPreparedSelect<TRow> {
	static readonly [entityKind]: string = 'CubridPreparedSelect';

	private readonly temporal: boolean;

	constructor(
		private readonly session: CubridSession,
		private readonly query: Query,
		private readonly fields: readonly OrderedField[],
		private readonly nullability: Record<string, boolean> | undefined,
	) {
		this.temporal = fields.some(({ field }) => readsTemporal(field));
	}

	async execute(placeholderValues: Record<string, unknown> = {}): Promise<TRow[]> {
		const params = fillPlaceholders(this.query.params, placeholderValues);
		const rows = await this.session.selectRows(this.query.sql, params, this.temporal);
		return rows.map((row) => mapRow(this.fields, row, this.nullability) as TRow);
	}
}
