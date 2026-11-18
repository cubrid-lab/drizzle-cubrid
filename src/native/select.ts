// The native SELECT builder (#158). Result types come from Drizzle's neutral
// `query-builders/select.types`, so they match Drizzle's other dialects; SQL
// generation and row mapping are in dialect.ts.

import { aliasedTable, Subquery } from 'drizzle-orm';
import { Column, type ColumnBaseConfig, type UpdateColConfig } from 'drizzle-orm/column';
import type { ColumnDataType } from 'drizzle-orm/column-builder';
import { entityKind, is } from 'drizzle-orm/entity';
import type { SelectedFields, SelectedFieldsFlat } from 'drizzle-orm/operations';
import type {
	AppendToNullabilityMap,
	AppendToResult,
	BuildSubquerySelection,
	GetSelectTableName,
	GetSelectTableSelection,
	JoinNullability,
	SelectMode,
	SelectResult,
	SelectResultField,
} from 'drizzle-orm/query-builders/select.types';
import { QueryPromise } from 'drizzle-orm/query-promise';
import {
	type ColumnsSelection,
	noopDecoder,
	type Placeholder,
	type Query,
	SQL,
	type SQLWrapper,
	sql,
} from 'drizzle-orm/sql/sql';
import { Table } from 'drizzle-orm/table';
import type { Assume, DrizzleTypeError, Simplify, ValidateShape } from 'drizzle-orm/utils';
import { getTableColumns } from 'drizzle-orm/utils';
import type { CubridColumn } from './columns/common.js';
import {
	assertSetOperandCodecs,
	type CubridCompoundConfig,
	type CubridDialect,
	type CubridJoinType,
	type CubridOrderByItem,
	type CubridSelectConfig,
	type CubridSelectSource,
	type CubridSetOperator,
	compoundFields,
	compoundSelects,
	fillPlaceholderValues,
	mapRow,
	markSubqueryField,
	markSubquerySources,
	type OrderedField,
	orderSelectedFields,
	outputName,
	readsTemporal,
	sourceName,
	subqueryFieldSource,
} from './dialect.js';
import { getSqlDecoder } from './internal.js';
import type { CubridSession, CubridStreamOptions } from './session.js';
import { CubridTable } from './table.js';

/**
 * What `select()` takes: Drizzle's selected fields, plus a subquery as a
 * field. drizzle-orm 0.45 types allow that and 0.44 types do not, so it is
 * spelled out here for the whole supported range.
 */
export type CubridSelectedFields = Record<
	string,
	| SelectedFields<CubridColumn, CubridTable>[string]
	| Subquery
	| Record<string, SelectedFieldsFlat<CubridColumn>[string] | Subquery>
>;

type IsUnion<T, TAll = T> = T extends unknown ? ([TAll] extends [T] ? false : true) : never;

type OneColumnError = SQL<DrizzleTypeError<'You can only select one column in the subquery'>>;

/** The value of a subquery selected as a field: its one field's, or a type error as in drizzle-orm 0.45. */
type ScalarSubqueryField<TFields> = [keyof TFields] extends [never]
	? OneColumnError
	: IsUnion<keyof TFields> extends true
		? OneColumnError
		: TFields[keyof TFields] extends Column | SQL | SQL.Aliased
			? SQL<SelectResultField<TFields[keyof TFields]>>
			: OneColumnError;

/**
 * A selection with each top-level subquery field typed as the `sql` value it
 * is read as, so Drizzle's select result types (0.44 and 0.45 alike) give its
 * one field's type. A subquery inside an object stays one, which Drizzle
 * types `never` and the select refuses.
 */
export type CubridScalarSelection<TSelection> = {
	[K in keyof TSelection]: TSelection[K] extends Subquery
		? ScalarSubqueryField<TSelection[K]['_']['selectedFields']>
		: TSelection[K];
};

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
		} else if (is(value, Subquery)) {
			throw new Error(
				`Subquery field ${name} is a scalar subquery; inside a subquery select it as sql\`\${query}\`.as('name') with the unaliased query`,
			);
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

function orderItems<TSelection>(items: OrderItems<TSelection>, fields: TSelection): CubridOrderByItem[] {
	const [first] = items;
	if (typeof first === 'function') {
		const result = first(fields);
		return Array.isArray(result) ? result : [result];
	}
	return items as CubridOrderByItem[];
}

/** A subquery of a select or set operation, whose SQL names every field (see `outputName`). */
function subqueryOf(
	config: CubridSelectConfig | CubridCompoundConfig,
	fields: Record<string, unknown>,
	alias: string,
	query: SQL,
): Subquery & Record<string, unknown> {
	for (const key of Object.keys(fields)) {
		if (key === '_' || key === 'getSQL') throw new Error(`A subquery field cannot be named ${key}`);
	}
	const aliased = aliasFields(fields, alias);
	const subquery = new Subquery(query, aliased, alias);
	markSubquerySources(subquery, config);
	return Object.assign(subquery, aliased);
}

type SubqueryOf<
	TSelection extends ColumnsSelection,
	TNullabilityMap extends Record<string, JoinNullability>,
	TAlias extends string,
> = CubridSubquery<TAlias, CubridAliasedSelection<BuildSubquerySelection<TSelection, TNullabilityMap>, TAlias>>;

/** A native select or set operation whose rows are `TRow`: what a set operator takes. */
export interface CubridSetOperand<TRow> extends SQLWrapper {
	readonly _: { readonly result: TRow[] };
}

/** The right-hand select of a set operator, or a type error naming the keys `TRow` lacks. */
export type CubridSetOperandRight<TValue extends CubridSetOperand<TRow>, TRow> = TValue extends {
	readonly _: { readonly result: (infer TValueRow)[] };
}
	? ValidateShape<TValueRow, TRow, TValue>
	: TValue;

type CubridSetOperandRest<TValue extends readonly CubridSetOperand<TRow>[], TRow> = TValue extends [
	infer First extends CubridSetOperand<TRow>,
	...infer Rest extends CubridSetOperand<TRow>[],
]
	? [CubridSetOperandRight<First, TRow>, ...CubridSetOperandRest<Rest, TRow>]
	: TValue;

/** `union(left, right, ...rest)` and the other standalone set operators. */
export type CubridSetOperatorFn = <
	TSelection extends ColumnsSelection,
	TSelectMode extends SelectMode,
	TNullabilityMap extends Record<string, JoinNullability>,
	TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	TRest extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>[],
>(
	left: CubridSetOperationSource<TSelection, TSelectMode, TNullabilityMap>,
	right: CubridSetOperandRight<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	...rest: CubridSetOperandRest<TRest, SelectResult<TSelection, TSelectMode, TNullabilityMap>>
) => CubridSetOperation<TSelection, TSelectMode, TNullabilityMap>;

/** What the callback form of `.union((ops) => …)` receives. */
export interface CubridSetOperators {
	union: CubridSetOperatorFn;
	unionAll: CubridSetOperatorFn;
	intersect: CubridSetOperatorFn;
	intersectAll: CubridSetOperatorFn;
	except: CubridSetOperatorFn;
	exceptAll: CubridSetOperatorFn;
}

type SetOperandArgument<TValue extends CubridSetOperand<TRow>, TRow> =
	| CubridSetOperandRight<TValue, TRow>
	| ((setOperators: CubridSetOperators) => CubridSetOperandRight<TValue, TRow>);

interface Operand {
	session: CubridSession;
	dialect: CubridDialect;
	config: CubridSelectState | CubridCompoundConfig;
}

/** The session, dialect and query of every native select and set operation. */
const operands = new WeakMap<object, Operand>();

function operandOf(value: unknown, where: string): Operand {
	const operand = typeof value === 'object' && value !== null ? operands.get(value) : undefined;
	if (!operand) throw new TypeError(`${where} needs a drizzle-cubrid/native select or set operation`);
	return operand;
}

/** The first select of a set operation, whose fields and joins the result has. */
function firstSelect(config: CubridSelectState | CubridCompoundConfig): CubridSelectState {
	return compoundSelects(config)[0] as CubridSelectState;
}

function setOperation<
	TSelection extends ColumnsSelection,
	TSelectMode extends SelectMode,
	TNullabilityMap extends Record<string, JoinNullability>,
>(
	left: CubridSetOperationSource<TSelection, TSelectMode, TNullabilityMap>,
	operator: CubridSetOperator,
	all: boolean,
	right: unknown,
): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
	const name = `${operator}${all ? 'All' : ''}()`;
	const { session, dialect, config } = operandOf(left, name);
	const resolved = typeof right === 'function' ? right(setOperators) : right;
	const other = operandOf(resolved, name);
	const [leftFields, rightFields] = [compoundFields(config), compoundFields(other.config)];
	const keys = (fields: OrderedField[]) => fields.map(({ path }) => path.join('.'));
	const [leftKeys, rightKeys] = [keys(leftFields), keys(rightFields)];
	if (leftKeys.join(',') !== rightKeys.join(',')) {
		throw new Error(
			`${name}: the selects have different fields (${leftKeys.join(', ')} and ${rightKeys.join(', ')}); every select of a set operation needs the same keys in the same order`,
		);
	}
	assertSetOperandCodecs(leftFields, rightFields, name);
	const operation = { operator, all, right: other.config };
	const compound: CubridCompoundConfig =
		'operations' in config && config.orderBy.length === 0 && config.limit === undefined && config.offset === undefined
			? { ...config, operations: [...config.operations, operation] }
			: { first: config, operations: [operation], orderBy: [] };
	return new CubridSetOperation<TSelection, TSelectMode, TNullabilityMap>(session, dialect, compound);
}

function setOperator(operator: CubridSetOperator, all: boolean): CubridSetOperatorFn {
	return (left, right, ...rest) => {
		let result = setOperation(left, operator, all, right);
		for (const next of rest) result = setOperation(result, operator, all, next);
		return result;
	};
}

/** `UNION`: rows of either select, without duplicates. */
export const union: CubridSetOperatorFn = setOperator('union', false);
/** `UNION ALL`: rows of every select, duplicates kept. */
export const unionAll: CubridSetOperatorFn = setOperator('union', true);
/** `INTERSECT`: distinct rows that every select returns. */
export const intersect: CubridSetOperatorFn = setOperator('intersect', false);
/** `INTERSECT ALL`: rows that every select returns, each as often as the select that returns it least. */
export const intersectAll: CubridSetOperatorFn = setOperator('intersect', true);
/** `EXCEPT`: distinct rows of the left select that the right one does not return. */
export const except: CubridSetOperatorFn = setOperator('except', false);
/** `EXCEPT ALL`: rows of the left select, each as often as it occurs there more than in the right one. */
export const exceptAll: CubridSetOperatorFn = setOperator('except', true);

const setOperators: CubridSetOperators = { union, unionAll, intersect, intersectAll, except, exceptAll };

/**
 * A select or set operation that set operators can be called on. The result
 * has the first select's fields and types; rows are mapped by position.
 */
export abstract class CubridSetOperationSource<
		TSelection extends ColumnsSelection,
		TSelectMode extends SelectMode,
		TNullabilityMap extends Record<string, JoinNullability>,
	>
	extends QueryPromise<SelectResult<TSelection, TSelectMode, TNullabilityMap>[]>
	implements SQLWrapper
{
	static override readonly [entityKind]: string = 'CubridSetOperationSource';

	declare readonly _: {
		readonly selection: TSelection;
		readonly selectMode: TSelectMode;
		readonly nullabilityMap: TNullabilityMap;
		readonly result: SelectResult<TSelection, TSelectMode, TNullabilityMap>[];
	};

	abstract getSQL(): SQL;

	/** `UNION` with another select or set operation of the same fields. */
	union<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'union', false, right);
	}

	/** `UNION ALL`. */
	unionAll<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'union', true, right);
	}

	/** `INTERSECT`. */
	intersect<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'intersect', false, right);
	}

	/** `INTERSECT ALL` (bag semantics, as CUBRID 11.4 evaluates it). */
	intersectAll<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'intersect', true, right);
	}

	/** `EXCEPT`. */
	except<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'except', false, right);
	}

	/** `EXCEPT ALL` (bag semantics, as CUBRID 11.4 evaluates it). */
	exceptAll<TValue extends CubridSetOperand<SelectResult<TSelection, TSelectMode, TNullabilityMap>>>(
		right: SetOperandArgument<TValue, SelectResult<TSelection, TSelectMode, TNullabilityMap>>,
	): CubridSetOperation<TSelection, TSelectMode, TNullabilityMap> {
		return setOperation(this, 'except', true, right);
	}
}

/**
 * What the callback of `insert().select((qb) => …)` receives: `select()` and
 * `selectDistinct()` as on the database.
 */
export class CubridQueryBuilder {
	static readonly [entityKind]: string = 'CubridQueryBuilder';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
	) {}

	select(): CubridSelectBuilder<undefined>;
	select<TSelection extends CubridSelectedFields>(fields: TSelection): CubridSelectBuilder<TSelection>;
	select(fields?: CubridSelectedFields): CubridSelectBuilder<ColumnsSelection | undefined> {
		return new CubridSelectBuilder(this.session, this.dialect, fields, false);
	}

	selectDistinct(): CubridSelectBuilder<undefined>;
	selectDistinct<TSelection extends CubridSelectedFields>(fields: TSelection): CubridSelectBuilder<TSelection>;
	selectDistinct(fields?: CubridSelectedFields): CubridSelectBuilder<ColumnsSelection | undefined> {
		return new CubridSelectBuilder(this.session, this.dialect, fields, true);
	}
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
			: Assume<CubridScalarSelection<TSelection>, ColumnsSelection>,
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
 * result type. Await it, or call `execute()`, `prepare()`, `iterator()` or
 * `toSQL()`.
 */
export class CubridSelect<
		TTableName extends string | undefined,
		TSelection extends ColumnsSelection,
		TSelectMode extends SelectMode,
		TNullabilityMap extends Record<string, JoinNullability> = DefaultNullability<TTableName>,
	>
	extends CubridSetOperationSource<TSelection, TSelectMode, TNullabilityMap>
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
		operands.set(this, { session, dialect, config });
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
		return orderItems(items, this.config.fields as TSelection);
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

	/** The selected fields by key, as `insert().select()` reads them. */
	getSelectedFields(): Record<string, unknown> {
		return this.config.fields;
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	/** This query as a subquery for `from()`, a join or another query's condition. */
	as<TAlias extends string>(alias: TAlias): SubqueryOf<TSelection, TNullabilityMap, TAlias> {
		return subqueryOf(
			this.config,
			this.config.fields,
			alias,
			this.dialect.buildSelectQuery(this.config, true),
		) as SubqueryOf<TSelection, TNullabilityMap, TAlias>;
	}

	/**
	 * Builds the SQL once for `execute()`; `iterator()` sends it rendered for
	 * literals (see `CubridPreparedSelect`). Both take the values of
	 * `sql.placeholder()`s. Nothing is prepared on the server.
	 */
	prepare(): CubridPreparedSelect<SelectResult<TSelection, TSelectMode, TNullabilityMap>> {
		return this.prepared(false);
	}

	private prepared(stream: boolean): CubridPreparedSelect<SelectResult<TSelection, TSelectMode, TNullabilityMap>> {
		const fields = orderSelectedFields(this.config.fields);
		const nullability = this.config.joins.length > 0 ? { ...this.config.nullability } : undefined;
		const [query, streamQuery] = renderBoth(this.dialect, this.session, this.getSQL(), stream);
		return new CubridPreparedSelect(this.session, query, fields, nullability, undefined, streamQuery);
	}

	override execute(): Promise<SelectResult<TSelection, TSelectMode, TNullabilityMap>[]> {
		return this.prepared(false).execute();
	}

	/**
	 * Streams the rows with cubrid-client's `stream()`, decoded as `execute()`
	 * decodes them; see `CubridPreparedSelect.iterator()`.
	 */
	iterator(
		placeholderValues: Record<string, unknown> = {},
		options?: CubridStreamOptions,
	): AsyncGenerator<SelectResult<TSelection, TSelectMode, TNullabilityMap>, void, undefined> {
		return this.prepared(true).iterator(placeholderValues, options);
	}
}

/**
 * The query of `execute()` (for the session's binding) and of `iterator()`
 * (for `'literal'`, since cubrid-client's `stream()` sends literals), from
 * `statement`, the SQL built when the query was prepared, so a later change
 * to the builder changes neither. Under `'literal'` both are one rendering;
 * otherwise the literal form is rendered only when a stream needs it, and
 * the typed form only when `execute()` may.
 */
function renderBoth(
	dialect: CubridDialect,
	session: CubridSession,
	statement: SQL,
	stream: boolean,
): [Query | (() => Query), Query | (() => Query)] {
	if (session.binding === 'literal') {
		const literal = dialect.sqlToQuery(statement, 'literal');
		return [literal, literal];
	}
	const literal = () => dialect.sqlToQuery(statement, 'literal');
	return stream ? [() => dialect.sqlToQuery(statement), literal()] : [dialect.sqlToQuery(statement), literal];
}

/**
 * A set operation (`union`, `unionAll`, `intersect`, `intersectAll`, `except`,
 * `exceptAll`). Its rows have the first select's fields, decoded by their
 * codecs. `orderBy()` takes fields of the first select (sent as positions),
 * and `limit()`/`offset()` apply to the result; a set operator called after
 * them makes the ordered result an operand.
 */
export class CubridSetOperation<
	TSelection extends ColumnsSelection,
	TSelectMode extends SelectMode,
	TNullabilityMap extends Record<string, JoinNullability>,
> extends CubridSetOperationSource<TSelection, TSelectMode, TNullabilityMap> {
	static override readonly [entityKind]: string = 'CubridSetOperation';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly config: CubridCompoundConfig,
	) {
		super();
		operands.set(this, { session, dialect, config });
	}

	/** ORDER BY on the result; use the first select's fields, with `asc()` and `desc()`. */
	orderBy(...columns: OrderItems<TSelection>): this {
		this.config.orderBy = orderItems(columns, firstSelect(this.config).fields as TSelection);
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

	/** Returns the query typed for dynamic building. */
	$dynamic(): this {
		return this;
	}

	getSQL(): SQL {
		return this.dialect.buildCompoundQuery(this.config);
	}

	toSQL(): Query {
		return this.dialect.sqlToQuery(this);
	}

	/** This set operation as a subquery; its fields are the first select's. */
	as<TAlias extends string>(alias: TAlias): SubqueryOf<TSelection, TNullabilityMap, TAlias> {
		return subqueryOf(
			this.config,
			firstSelect(this.config).fields,
			alias,
			this.dialect.buildCompoundQuery(this.config, true),
		) as SubqueryOf<TSelection, TNullabilityMap, TAlias>;
	}

	/** Builds the SQL once, as `CubridSelect.prepare()` does. */
	prepare(): CubridPreparedSelect<SelectResult<TSelection, TSelectMode, TNullabilityMap>> {
		return this.prepared(false);
	}

	private prepared(stream: boolean): CubridPreparedSelect<SelectResult<TSelection, TSelectMode, TNullabilityMap>> {
		const [query, streamQuery] = renderBoth(this.dialect, this.session, this.getSQL(), stream);
		const first = firstSelect(this.config);
		const nullability = first.joins.length > 0 ? { ...first.nullability } : undefined;
		const temporal = compoundSelects(this.config).some((select) =>
			orderSelectedFields(select.fields).some(({ field }) => readsTemporal(field)),
		);
		return new CubridPreparedSelect(
			this.session,
			query,
			compoundFields(this.config),
			nullability,
			temporal,
			streamQuery,
		);
	}

	override execute(): Promise<SelectResult<TSelection, TSelectMode, TNullabilityMap>[]> {
		return this.prepared(false).execute();
	}

	/** Streams the result rows; see `CubridPreparedSelect.iterator()`. */
	iterator(
		placeholderValues: Record<string, unknown> = {},
		options?: CubridStreamOptions,
	): AsyncGenerator<SelectResult<TSelection, TSelectMode, TNullabilityMap>, void, undefined> {
		return this.prepared(true).iterator(placeholderValues, options);
	}
}

/**
 * A SELECT built once: the SQL text, its parameters and the row mapping are
 * kept, and each `execute(placeholderValues)` or `iterator(placeholderValues)`
 * fills the `sql.placeholder()` values and sends the statement again. It is
 * not a server-side prepared statement: cubrid-client prepares, runs and
 * closes a statement on the server for every execution.
 */
export class CubridPreparedSelect<TRow> {
	static readonly [entityKind]: string = 'CubridPreparedSelect';

	private query: Query | (() => Query);
	/** The query rendered for literals, which `iterator()` sends; rendered on first use. */
	private streamQuery: Query | (() => Query);

	constructor(
		private readonly session: CubridSession,
		query: Query | (() => Query),
		private readonly fields: readonly OrderedField[],
		private readonly nullability: Record<string, boolean> | undefined,
		/** Whether any select reads a date or time column (see `readsTemporal`). */
		private readonly temporal = fields.some(({ field }) => readsTemporal(field)),
		streamQuery: Query | (() => Query) = query,
	) {
		this.query = query;
		this.streamQuery = streamQuery;
	}

	/**
	 * Runs the statement with these placeholder values. A placeholder without
	 * a value is refused before anything is sent.
	 */
	async execute(placeholderValues: Record<string, unknown> = {}): Promise<TRow[]> {
		if (typeof this.query === 'function') this.query = this.query();
		const { sql, params: kept } = this.query;
		const params = fillPlaceholderValues(kept, placeholderValues);
		const rows = await this.session.selectRows(sql, params, this.temporal);
		return rows.map((row) => mapRow(this.fields, row, this.nullability) as TRow);
	}

	/**
	 * The rows one at a time from cubrid-client's `stream()`, decoded as
	 * `execute()` decodes them. cubrid-client sends a stream's values as SQL
	 * literals whatever the binding, so the SQL is the one `binding: 'literal'`
	 * gives. Placeholders, options and the transaction are checked when it is
	 * called, before anything is sent; the statement is sent on the first
	 * read. The stream holds its connection (a pool's, or a client's shared
	 * one) until the rows run out, the loop ends early (`break`, `return()`,
	 * a throw) or a read fails; each of those closes the cursor and releases
	 * the connection. Refused inside `db.transaction()`. See docs/NATIVE_API.md.
	 */
	iterator(
		placeholderValues: Record<string, unknown> = {},
		options?: CubridStreamOptions,
	): AsyncGenerator<TRow, void, undefined> {
		if (typeof this.streamQuery === 'function') this.streamQuery = this.streamQuery();
		const { sql, params: kept } = this.streamQuery;
		const params = fillPlaceholderValues(kept, placeholderValues);
		const rows = this.session.streamRows(sql, params, this.temporal, options);
		const { fields, nullability } = this;
		return (async function* () {
			// A row that fails to decode ends the loop, which closes the stream.
			for await (const row of rows) yield mapRow(fields, row, nullability) as TRow;
		})();
	}
}
