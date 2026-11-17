// Relational queries for drizzle-cubrid/native (#158): `db.query.<table>.findMany()`
// and `findFirst()` on Drizzle's v1 `relations()`.
//
// CUBRID has no LATERAL, and its JSON aggregation loses value types, so each
// level of `with` is loaded with one SELECT per relation (chunked
// `WHERE key IN (...)`) through the native select compiler, and the rows are
// stitched in JS. Every value is decoded by its column codec, as in `select()`.
// Result types are Drizzle's neutral `BuildQueryResult`. See docs/NATIVE_API.md.

import { and } from 'drizzle-orm';
import { Column } from 'drizzle-orm/column';
import { entityKind, is } from 'drizzle-orm/entity';
import { QueryPromise } from 'drizzle-orm/query-promise';
import {
	type BuildQueryResult,
	type DBQueryConfig,
	getOperators,
	getOrderByOperators,
	normalizeRelation,
	One,
	type RelationalSchemaConfig,
	type TableRelationalConfig,
	type TablesRelationalConfig,
} from 'drizzle-orm/relations';
import { fillPlaceholders, SQL, sql } from 'drizzle-orm/sql/sql';
import { getTableName, getTableUniqueName } from 'drizzle-orm/table';
import type { KnownKeysOnly } from 'drizzle-orm/utils';
import { CubridCollection } from './columns/collections.js';
import { describeValue } from './columns/common.js';
import {
	type CubridDialect,
	type CubridOrderByItem,
	type CubridSelectConfig,
	mapRow,
	type OrderedField,
	readsTemporal,
} from './dialect.js';
import type { CubridSession } from './session.js';
import { CubridTable } from './table.js';

/**
 * Parent keys per `IN (...)` list. CUBRID 11.4 ran `IN` lists of 100,000
 * bound values; a statement per 1,000 keys keeps the SQL text and the bind
 * list small.
 */
export const RELATIONAL_KEY_CHUNK = 1000;

const CONFIG_KEYS: ReadonlySet<string> = new Set(['columns', 'with', 'extras', 'where', 'orderBy', 'limit', 'offset']);

/** The relation `key` of a level, with the level that loads its rows. */
interface RelationPlan {
	key: string;
	one: boolean;
	/** Columns of the parent table that hold the key. */
	fields: Column[];
	/** Columns of the related table that `fields` match, in the same order. */
	references: Column[];
	/**
	 * Per reference, what the related rows are matched on in JavaScript: the
	 * column itself, or (when the parent column has another SQL type or codec)
	 * the column cast to the parent column's SQL type, decoded by its codec.
	 */
	stitch: (Column | SQL)[];
	plan: LevelPlan;
}

/** One table of a relational query: what it selects, filters and loads next. */
interface LevelPlan {
	table: CubridTable;
	/** The select list: result columns, extras, then the key columns the result does not show. */
	fields: (Column | SQL)[];
	/** Result keys with their position in `fields`. */
	shown: { key: string; index: number }[];
	/** The position of each key column and stitch key in `fields`. */
	keyIndex: Map<Column | SQL, number>;
	where?: SQL;
	orderBy: CubridOrderByItem[];
	limit?: number;
	/** Only at the root: Drizzle's types take no nested offset. */
	offset?: number;
	relations: RelationPlan[];
}

interface LoadedRow {
	values: unknown[];
	related: Record<string, LoadedRow[]>;
}

function limitValue(value: unknown, name: string, path: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`${path}: ${name} must be a non-negative integer, not ${describeValue(value)}; relational queries take no sql.placeholder() (prepared relational queries are #165)`,
		);
	}
	return value;
}

/** An object option of a query config (`columns`, `with`, or what `extras` gives) as entries. */
function entriesOf(value: unknown, name: string, path: string): [string, unknown][] {
	if (value === undefined) return [];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${path}: ${name} must be an object, not ${describeValue(value)}`);
	}
	return Object.entries(value);
}

/** `where`, `orderBy` or `extras`: the value, or what its callback returns for the table's columns. */
function resolve(value: unknown, columns: Record<string, Column>, operators: object): unknown {
	return typeof value === 'function' ? value(columns, operators) : value;
}

function orderByItems(value: unknown, path: string): CubridOrderByItem[] {
	const items: unknown[] = value === undefined ? [] : Array.isArray(value) ? value : [value];
	return items.map((item) => {
		if (!is(item, Column) && !is(item, SQL)) {
			throw new TypeError(`${path}: orderBy takes columns and sql, not ${describeValue(item)}`);
		}
		return item;
	});
}

/** A SQL type without its length, precision and scale (`CHAR(5)` → `CHAR`). */
function baseType(column: Column): string {
	return column.getSQLType().replace(/\(.*$/, '').trim().toUpperCase();
}

/**
 * Key types whose values CUBRID 11.4 compares by value and casts without
 * changing a matching value: exact numbers with each other, CHAR(n) with
 * CHAR(m) (both space-padded), and VARCHAR/STRING with each other.
 * CHAR against VARCHAR is not one: the server matched a VARCHAR value
 * against CHAR column values but not a CHAR value against VARCHAR ones.
 */
const KEY_FAMILIES: readonly ReadonlySet<string>[] = [
	new Set(['SMALLINT', 'INTEGER', 'BIGINT', 'NUMERIC']),
	new Set(['CHAR']),
	new Set(['VARCHAR', 'STRING']),
];

/**
 * What the related rows are matched on for one key column pair: the
 * reference itself when both columns have the same SQL type and codec,
 * otherwise `cast(reference as <parent type>)` read by the parent's codec, so
 * both sides decode alike (`CHAR(10)` → `CHAR(5)`, `NUMERIC(10,3)` →
 * `NUMERIC(10,2)`, `INTEGER` → `BIGINT`). Other pairs are refused.
 */
function stitchKey(field: Column, reference: Column, path: string): Column | SQL {
	const type = field.getSQLType();
	if (type === reference.getSQLType() && field.constructor === reference.constructor) return reference;
	const [left, right] = [baseType(field), baseType(reference)];
	if (!KEY_FAMILIES.some((family) => family.has(left) && family.has(right))) {
		throw new Error(
			`${path}: key ${field.name} (${type}) and ${reference.name} (${reference.getSQLType()}) have types that cannot be matched reliably; give both columns the same type`,
		);
	}
	return sql`cast(${reference} as ${sql.raw(type)})`.mapWith(field);
}

/** Builds the plan of a level, refusing what cannot be loaded before any statement is sent. */
function planLevel(
	schema: RelationalSchemaConfig<TablesRelationalConfig>,
	tableConfig: TableRelationalConfig,
	config: unknown,
	path: string,
	incoming: (Column | SQL)[],
): LevelPlan {
	const table = schema.fullSchema[tableConfig.tsName];
	if (!(table instanceof CubridTable)) {
		throw new TypeError(`${path}: ${tableConfig.tsName} is not a drizzle-cubrid/native table`);
	}
	const columns = tableConfig.columns;
	const query = new Map(config === true ? [] : entriesOf(config, 'the query config', path));
	for (const [key, value] of query) {
		if (value !== undefined && !CONFIG_KEYS.has(key))
			throw new Error(`${path}: unknown relational query option '${key}'`);
	}

	// As in Drizzle: any `true` selects only the `true` columns, otherwise the
	// named `false` columns are left out; `columns: {}` selects none.
	let shownColumns = Object.keys(columns);
	if (query.get('columns') !== undefined) {
		const named = entriesOf(query.get('columns'), 'columns', path).filter(
			([key, value]) => value !== undefined && Object.hasOwn(columns, key),
		);
		const include = named.some(([, value]) => value === true);
		shownColumns =
			named.length === 0
				? []
				: include
					? named.filter(([, value]) => value === true).map(([key]) => key)
					: shownColumns.filter((key) => !named.some(([name]) => name === key));
	}

	const fields: (Column | SQL)[] = [];
	const shown: LevelPlan['shown'] = [];
	for (const key of shownColumns) {
		shown.push({ key, index: fields.length });
		fields.push(columns[key] as Column);
	}
	for (const [key, value] of entriesOf(resolve(query.get('extras'), columns, { sql }), 'extras', path)) {
		if (!is(value, SQL.Aliased)) {
			throw new TypeError(
				`${path}: extra ${key} must be a sql expression with .as('name'), not ${describeValue(value)}`,
			);
		}
		shown.push({ key, index: fields.length });
		fields.push(value.sql);
	}

	const relations: RelationPlan[] = [];
	for (const [key, value] of entriesOf(query.get('with'), 'with', path)) {
		// As in Drizzle, a falsy entry loads nothing.
		if (!value) continue;
		const childPath = `${path}.${key}`;
		const relation = Object.hasOwn(tableConfig.relations, key) ? tableConfig.relations[key] : undefined;
		if (!relation) throw new Error(`${path}: ${tableConfig.tsName} has no relation ${key}`);
		const normalized = normalizeRelation(schema.schema, schema.tableNamesMap, relation);
		const tsName = schema.tableNamesMap[getTableUniqueName(relation.referencedTable)];
		const target = tsName === undefined ? undefined : schema.schema[tsName];
		if (!target) {
			throw new Error(`${childPath}: table ${getTableName(relation.referencedTable)} is not in the schema`);
		}
		if (normalized.fields.length === 0 || normalized.fields.length !== normalized.references.length) {
			throw new Error(`${childPath}: the relation needs as many fields as references`);
		}
		const collection = [...normalized.fields, ...normalized.references].find(
			(column) => column instanceof CubridCollection,
		);
		if (collection) {
			throw new Error(`${childPath}: ${collection.name} is a collection column, which cannot be a relation key`);
		}
		const one = is(relation, One);
		const child = new Map(value === true ? [] : entriesOf(value, 'with', childPath));
		// Only what Drizzle's types allow: a one relation takes no where,
		// orderBy, limit or offset, and a nested many relation no offset.
		const refused = (one ? ['where', 'orderBy', 'limit', 'offset'] : ['offset']).filter(
			(option) => child.get(option) !== undefined,
		);
		if (refused.length > 0) {
			throw new Error(
				`${childPath}: a ${one ? 'one' : 'nested many'} relation takes no ${refused.join(' or ')}, as in Drizzle's types`,
			);
		}
		const stitch = normalized.fields.map((field, i) => stitchKey(field, normalized.references[i] as Column, childPath));
		relations.push({
			key,
			one,
			fields: normalized.fields,
			references: normalized.references,
			stitch,
			plan: planLevel(schema, target, value, childPath, stitch),
		});
	}

	if (fields.length === 0 && relations.length === 0) {
		throw new Error(`${path}: no fields selected for ${tableConfig.tsName}`);
	}
	const keyIndex = new Map<Column | SQL, number>();
	for (const column of [...incoming, ...relations.flatMap((relation) => relation.fields)]) {
		if (keyIndex.has(column)) continue;
		const index = fields.indexOf(column);
		if (index >= 0) keyIndex.set(column, index);
		else {
			keyIndex.set(column, fields.length);
			fields.push(column);
		}
	}

	const where = resolve(query.get('where'), columns, getOperators());
	if (where !== undefined && !is(where, SQL)) {
		throw new TypeError(`${path}: where must be a sql condition, not ${describeValue(where)}`);
	}
	const orderBy = orderByItems(resolve(query.get('orderBy'), columns, getOrderByOperators()), path);
	const limit = limitValue(query.get('limit'), 'limit', path);
	// An offset of 0 changes nothing, and alone it would need a limit.
	const offset = limitValue(query.get('offset'), 'offset', path) || undefined;
	if (offset !== undefined && limit === undefined) {
		throw new Error(`${path}: CUBRID needs a limit with offset; add limit or remove offset`);
	}
	return { table, fields, shown, keyIndex, where, orderBy, limit, offset, relations };
}

/** A key as one string, comparing values the way their codecs decoded them (`1` and `1n` are one key). */
function keyString(values: readonly unknown[]): string {
	return JSON.stringify(
		values.map((value) => {
			if (typeof value === 'bigint' || typeof value === 'number') return `n${value}`;
			if (value instanceof Date) return `d${value.getTime()}`;
			if (typeof value === 'string' || typeof value === 'boolean') return `${typeof value}:${value}`;
			throw new TypeError(`A relation key decoded to ${describeValue(value)}, which cannot be matched`);
		}),
	);
}

/**
 * `"t"."a" in (?, ?)`, or `("t"."a", "t"."b") in ((?, ?), (?, ?))` for a
 * composite key. Each value is encoded by the parent column it was read from
 * (a BIGINT key may be referenced by an INTEGER column); the server compares
 * across numeric types. A CHAR key is sent as `cast(? as CHAR(n))` by the dialect.
 */
function keyFilter(relation: RelationPlan, keys: readonly unknown[][]): SQL {
	const { fields, references } = relation;
	const params = (key: readonly unknown[]) =>
		sql.join(
			key.map((value, i) => sql.param(value, fields[i] as Column)),
			sql`, `,
		);
	if (references.length === 1) {
		return sql`${references[0]} in (${sql.join(keys.map(params), sql`, `)})`;
	}
	const tuples = keys.map((key) => sql`(${params(key)})`);
	return sql`(${sql.join([...references], sql`, `)}) in (${sql.join(tuples, sql`, `)})`;
}

function fieldMap(fields: readonly (Column | SQL)[]): Record<string, Column | SQL> {
	return Object.fromEntries(fields.map((field, index) => [`f${index}`, field]));
}

/**
 * The SELECT of one level. A many relation with a limit is ranked
 * per parent with `row_number() over (partition by <references> order by …)`
 * in a derived table and filtered on the rank.
 */
function buildLevelQuery(
	dialect: CubridDialect,
	plan: LevelPlan,
	filter: SQL | undefined,
	references: readonly Column[],
): SQL {
	const where = and(filter, plan.where);
	const select = (config: Partial<CubridSelectConfig> & Pick<CubridSelectConfig, 'fields'>, names = false) =>
		dialect.buildSelectQuery(
			{ distinct: false, source: plan.table, joins: [], groupBy: [], orderBy: [], forUpdate: false, ...config },
			names,
		);
	const ranked = references.length > 0 && plan.limit !== undefined;
	if (!ranked) {
		return select({
			fields: fieldMap(plan.fields),
			where,
			orderBy: plan.orderBy,
			limit: plan.limit,
			offset: plan.offset,
		});
	}
	const order = plan.orderBy.length > 0 ? sql` order by ${sql.join(plan.orderBy, sql`, `)}` : undefined;
	const rank = sql`row_number() over (partition by ${sql.join([...references], sql`, `)}${order})`;
	const inner = select({ fields: { ...fieldMap(plan.fields), __rn: rank }, where }, true);
	const alias = sql.identifier('__rq');
	const rn = sql`${alias}.${sql.identifier('__rn')}`;
	const list = sql.join(
		plan.fields.map((_, index) => sql`${alias}.${sql.identifier(`f${index}`)}`),
		sql`, `,
	);
	return sql`select ${list} from (${inner}) ${alias} where ${rn} <= ${plan.limit} order by ${rn}`;
}

async function loadLevel(
	session: CubridSession,
	dialect: CubridDialect,
	plan: LevelPlan,
	filter: SQL | undefined,
	references: readonly Column[],
): Promise<LoadedRow[]> {
	const query = dialect.sqlToQuery(buildLevelQuery(dialect, plan, filter, references));
	const ordered: OrderedField[] = plan.fields.map((field, index) => ({ path: [`f${index}`], field }));
	const temporal = ordered.some(({ field }) => readsTemporal(field));
	const rows = await session.selectRows(query.sql, fillPlaceholders(query.params, {}), temporal);
	return rows.map((row) => {
		const mapped = mapRow(ordered, row, undefined);
		return { values: ordered.map(({ path }) => mapped[path[0] as string]), related: {} };
	});
}

/** Loads every relation of `plan` for `rows`, one statement per relation and key chunk, then the next level. */
async function loadRelations(
	session: CubridSession,
	dialect: CubridDialect,
	plan: LevelPlan,
	rows: LoadedRow[],
): Promise<void> {
	for (const relation of plan.relations) {
		const parentKey = (row: LoadedRow) =>
			relation.fields.map((column) => row.values[plan.keyIndex.get(column) as number]);
		const keys = new Map<string, unknown[]>();
		for (const row of rows) {
			const key = parentKey(row);
			if (key.every((value) => value !== null)) keys.set(keyString(key), key);
		}
		const children: LoadedRow[] = [];
		const all = [...keys.values()];
		for (let start = 0; start < all.length; start += RELATIONAL_KEY_CHUNK) {
			const chunk = all.slice(start, start + RELATIONAL_KEY_CHUNK);
			const loaded = await loadLevel(session, dialect, relation.plan, keyFilter(relation, chunk), relation.references);
			// One chunk can return very many rows: no spread into push().
			for (const child of loaded) children.push(child);
		}
		await loadRelations(session, dialect, relation.plan, children);
		const groups = new Map<string, LoadedRow[]>();
		for (const child of children) {
			const key = keyString(relation.stitch.map((key) => child.values[relation.plan.keyIndex.get(key) as number]));
			const group = groups.get(key);
			if (group) group.push(child);
			else groups.set(key, [child]);
		}
		for (const row of rows) {
			const key = parentKey(row);
			row.related[relation.key] = key.some((value) => value === null) ? [] : (groups.get(keyString(key)) ?? []);
		}
	}
}

/** The result object of a row: a new object for every place the row appears. */
function materialize(plan: LevelPlan, row: LoadedRow): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const { key, index } of plan.shown) result[key] = row.values[index];
	for (const relation of plan.relations) {
		const related = row.related[relation.key] ?? [];
		if (relation.one) {
			const [first] = related;
			result[relation.key] = first ? materialize(relation.plan, first) : null;
		} else {
			result[relation.key] = related.map((child) => materialize(relation.plan, child));
		}
	}
	return result;
}

/**
 * `db.query.<table>.findMany()` or `findFirst()`. Await it or call
 * `execute()`. Its statements run on one connection: the transaction's inside
 * `db.transaction()`, otherwise a `'repeatable read'` transaction of its own
 * when it loads relations (see docs/NATIVE_API.md).
 */
export class CubridRelationalQuery<TResult> extends QueryPromise<TResult> {
	static override readonly [entityKind]: string = 'CubridNativeRelationalQuery';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly schema: RelationalSchemaConfig<TablesRelationalConfig>,
		private readonly tableConfig: TableRelationalConfig,
		private readonly config: object,
		private readonly mode: 'many' | 'first',
	) {
		super();
	}

	/** Not supported yet: relational queries run several statements, and prepared ones are #165. */
	prepare(): never {
		throw new Error(
			'prepare() is not supported on relational queries yet (#165); await the query, or use select().prepare()',
		);
	}

	override async execute(): Promise<TResult> {
		const root = this.tableConfig.tsName;
		const config = this.mode === 'first' ? { ...this.config, limit: 1 } : this.config;
		const plan = planLevel(this.schema, this.tableConfig, config, root, []);
		const run = async (session: CubridSession) => {
			const rows = await loadLevel(session, this.dialect, plan, undefined, []);
			await loadRelations(session, this.dialect, plan, rows);
			return rows.map((row) => materialize(plan, row));
		};
		const rows = plan.relations.length > 0 ? await this.session.consistentRead(run) : await run(this.session);
		return (this.mode === 'first' ? rows[0] : rows) as TResult;
	}
}

/** `db.query.<table>`: `findMany()` and `findFirst()`, typed by Drizzle's neutral relational types. */
export class CubridRelationalQueryBuilder<
	TSchema extends TablesRelationalConfig,
	TFields extends TableRelationalConfig,
> {
	static readonly [entityKind]: string = 'CubridNativeRelationalQueryBuilder';

	constructor(
		private readonly session: CubridSession,
		private readonly dialect: CubridDialect,
		private readonly schema: RelationalSchemaConfig<TSchema>,
		private readonly tableConfig: TFields,
	) {}

	findMany<TConfig extends DBQueryConfig<'many', true, TSchema, TFields>>(
		config?: KnownKeysOnly<TConfig, DBQueryConfig<'many', true, TSchema, TFields>>,
	): CubridRelationalQuery<BuildQueryResult<TSchema, TFields, TConfig>[]> {
		return new CubridRelationalQuery(this.session, this.dialect, this.schema, this.tableConfig, config ?? {}, 'many');
	}

	findFirst<TSelection extends Omit<DBQueryConfig<'many', true, TSchema, TFields>, 'limit'>>(
		config?: KnownKeysOnly<TSelection, Omit<DBQueryConfig<'many', true, TSchema, TFields>, 'limit'>>,
	): CubridRelationalQuery<BuildQueryResult<TSchema, TFields, TSelection> | undefined> {
		return new CubridRelationalQuery(this.session, this.dialect, this.schema, this.tableConfig, config ?? {}, 'first');
	}
}
