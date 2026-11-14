// The native CUBRID SQL compiler for SELECT (#158) and its row mapping (#160).
//
// SQL text comes from Drizzle's neutral `SQL#toQuery()` with CUBRID quoting;
// the clause order, the refusals and the row mapping are drizzle-cubrid's own
// (ADR 0007). Every clause below was run on CUBRID 11.4; see docs/NATIVE_API.md.

import { Subquery } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { Column } from 'drizzle-orm/column';
import { is } from 'drizzle-orm/entity';
import {
	type DriverValueDecoder,
	noopDecoder,
	Param,
	type Placeholder,
	type Query,
	SQL,
	type SQLWrapper,
	sql,
} from 'drizzle-orm/sql/sql';
import { getTableName, Table } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';
import { CubridCollection } from './columns/collections.js';
import { describeValue } from './columns/common.js';
import { CubridTemporalDate, CubridTemporalString } from './columns/temporal.js';
import { getSqlDecoder } from './internal.js';

/**
 * A double-quoted identifier, with an embedded `"` doubled (`a"b` → `"a""b"`).
 * CUBRID 11.4 also accepts brackets and backticks; double quotes are the SQL
 * standard form and the escaping was verified on the server.
 */
export function quoteIdentifier(name: string): string {
	if (name === '') throw new Error('An identifier cannot be empty');
	return `"${name.replaceAll('"', '""')}"`;
}

/** A string literal for `sql.inlineParams()`, with `'` doubled. */
export function quoteString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** A selected value, by its path in the result object. */
export interface OrderedField {
	path: string[];
	field: Column | SQL | SQL.Aliased;
}

export type CubridJoinType = 'inner' | 'left' | 'right' | 'cross';

/** A table or a subquery made with `.as()`: what `from()` and the joins accept. */
export type CubridSelectSource = Table | Subquery;

export interface CubridJoin {
	type: CubridJoinType;
	source: CubridSelectSource;
	on: SQL | undefined;
}

export type CubridOrderByItem = Column | SQL | SQL.Aliased;

export interface CubridSelectConfig {
	fields: Record<string, unknown>;
	distinct: boolean;
	source: CubridSelectSource;
	joins: CubridJoin[];
	where?: SQL;
	groupBy: CubridOrderByItem[];
	having?: SQL;
	orderBy: CubridOrderByItem[];
	limit?: number | Placeholder;
	offset?: number | Placeholder;
	forUpdate: boolean;
}

/**
 * `sql` expressions that stand for a field of a subquery (`"alias"."field"`),
 * by the subquery alias they belong to. They count as that source's fields
 * when a join makes it nullable.
 */
const subqueryFieldSources = new WeakMap<SQL, string>();

export function markSubqueryField(field: SQL, alias: string): SQL {
	subqueryFieldSources.set(field, alias);
	return field;
}

export function subqueryFieldSource(field: unknown): string | undefined {
	return is(field, SQL) ? subqueryFieldSources.get(field) : undefined;
}

/**
 * The output name of a selected field inside a subquery: a `sql\`...\`.as(name)`
 * field keeps its own name, so the subquery's own HAVING and ORDER BY can
 * refer to it; any other field is named by its key path, so joined tables
 * that share column names stay distinct (`users.id`, `pets.id`).
 */
export function outputName(path: readonly string[], field: unknown): string {
	return is(field, SQL.Aliased) ? field.fieldAlias : path.join('.');
}

/** The name a source is referred to by: a table's (alias) name or a subquery's alias. */
export function sourceName(source: CubridSelectSource): string {
	return is(source, Subquery) ? source._.alias : getTableName(source);
}

/** Flattens a selection into fields in select-list order, with the path each value is written to. */
export function orderSelectedFields(fields: Record<string, unknown>, prefix: string[] = []): OrderedField[] {
	const ordered: OrderedField[] = [];
	for (const [key, value] of Object.entries(fields)) {
		const path = [...prefix, key];
		if (is(value, Column) || is(value, SQL) || is(value, SQL.Aliased)) {
			ordered.push({ path, field: value });
		} else if (is(value, Table)) {
			ordered.push(...orderSelectedFields(getTableColumns(value), path));
		} else if (is(value, Subquery)) {
			throw new TypeError(
				`Selected field ${path.join('.')} is a subquery; select its fields, or use it in from() or a join`,
			);
		} else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			ordered.push(...orderSelectedFields(value as Record<string, unknown>, path));
		} else {
			throw new TypeError(`Selected field ${path.join('.')} is ${describeValue(value)}, not a column or sql`);
		}
	}
	return ordered;
}

/** The decoder of a selected field: the column itself, or what `sql.mapWith()` set. */
function decoderOf(field: Column | SQL | SQL.Aliased): DriverValueDecoder<unknown, unknown> {
	if (is(field, Column)) return field;
	return getSqlDecoder(is(field, SQL) ? field : field.sql) ?? noopDecoder;
}

/** Whether a field reads a date or time column, or a collection of them. */
export function readsTemporal(field: Column | SQL | SQL.Aliased): boolean {
	const decoder = decoderOf(field);
	const temporal = (value: unknown) => value instanceof CubridTemporalDate || value instanceof CubridTemporalString;
	return temporal(decoder) || (decoder instanceof CubridCollection && temporal(decoder.element));
}

/** The table or subquery a field's value comes from, or undefined for a plain `sql` expression. */
function sourceOf(field: Column | SQL | SQL.Aliased): string | undefined {
	return is(field, Column) ? getTableName(field.table) : subqueryFieldSource(field);
}

/**
 * One result row from a positional driver row. Values are decoded by their
 * field's decoder; NULL stays `null`. As in Drizzle's other dialects, a
 * top-level object (`{ pet: { name: pets.name, ... } }`, or a table in a join)
 * becomes `null` when a join made its source nullable: its column fields
 * (and subquery fields) all come from that one source and are all NULL.
 * Plain `sql` fields in the object do not count.
 */
export function mapRow(
	fields: readonly OrderedField[],
	row: unknown,
	nullability: Readonly<Record<string, boolean>> | undefined,
): Record<string, unknown> {
	if (!Array.isArray(row)) {
		throw new TypeError(
			`The CUBRID client returned ${describeValue(row)} for a row with { rowMode: 'array' }; drizzle-cubrid/native needs cubrid-client 1.4.0 or later`,
		);
	}
	if (row.length !== fields.length) {
		throw new Error(`The CUBRID client returned a row of ${row.length} values for ${fields.length} selected fields`);
	}
	const result: Record<string, unknown> = {};
	// Per top-level object: the one source all its column values came from while NULL, or false.
	const nullable = new Map<string, string | false>();
	fields.forEach(({ path, field }, index) => {
		const raw = row[index];
		const value = raw === null || raw === undefined ? null : decoderOf(field).mapFromDriverValue(raw);
		let node = result;
		for (const key of path.slice(0, -1)) {
			node[key] ??= {};
			node = node[key] as Record<string, unknown>;
		}
		node[path[path.length - 1] as string] = value;
		const source = path.length === 2 ? sourceOf(field) : undefined;
		if (source !== undefined) {
			const objectName = path[0] as string;
			const previous = nullable.get(objectName);
			if (value !== null || (previous !== undefined && previous !== source)) nullable.set(objectName, false);
			else if (previous === undefined) nullable.set(objectName, source);
		}
	});
	if (nullability) {
		for (const [objectName, tableName] of nullable) {
			if (tableName !== false && nullability[tableName] === false) result[objectName] = null;
		}
	}
	return result;
}

/** Throws for a collection column compared with an array: the collection literal comes with #159. */
function refuseCollectionParams(chunks: readonly unknown[]): void {
	for (const chunk of chunks) {
		if (is(chunk, Param)) {
			if (chunk.encoder instanceof CubridCollection && chunk.value !== null) {
				throw new Error(
					`Comparing ${chunk.encoder.kind} column ${chunk.encoder.name} with a value is not supported yet: collection values in conditions need the typed collection literal (#159)`,
				);
			}
		} else if (is(chunk, SQL)) {
			refuseCollectionParams(chunk.queryChunks);
		} else if (is(chunk, SQL.Aliased)) {
			refuseCollectionParams(chunk.sql.queryChunks);
		} else if (is(chunk, Subquery)) {
			refuseCollectionParams(chunk._.sql.queryChunks);
		} else if (Array.isArray(chunk)) {
			refuseCollectionParams(chunk);
		}
	}
}

/**
 * The select list. In a subquery (`outputNames`) every field gets an output
 * name (see outputName), so outer queries can refer to each one; names must differ
 * ignoring case, as CUBRID compares identifiers that way.
 */
function selectionSql(fields: readonly OrderedField[], outputNames: boolean): SQL {
	const seen = new Map<string, string>();
	return sql.join(
		fields.map(({ path, field }) => {
			const expression = is(field, SQL.Aliased) ? field.sql : field;
			if (!outputNames) {
				return is(field, SQL.Aliased) ? sql`${expression} as ${sql.identifier(field.fieldAlias)}` : sql`${field}`;
			}
			const name = outputName(path, field);
			const clash = seen.get(name.toLowerCase());
			if (clash !== undefined) {
				throw new Error(`Subquery fields ${clash} and ${name} have the same name ignoring case; rename one`);
			}
			seen.set(name.toLowerCase(), name);
			return sql`${expression} as ${sql.identifier(name)}`;
		}),
		sql`, `,
	);
}

export class CubridDialect {
	private readonly casing = new CasingCache();

	/** SQL text with `?` for each parameter, and the parameters. */
	sqlToQuery(query: SQLWrapper): Query {
		const statement = query.getSQL();
		refuseCollectionParams(statement.queryChunks);
		const { sql: text, params } = statement.toQuery({
			casing: this.casing,
			escapeName: quoteIdentifier,
			escapeParam: () => '?',
			escapeString: quoteString,
		});
		return { sql: text, params };
	}

	/** The SELECT; with `outputNames`, as a subquery whose every field has an output name. */
	buildSelectQuery(config: CubridSelectConfig, outputNames = false): SQL {
		if (config.offset !== undefined && config.limit === undefined) {
			throw new Error('CUBRID needs limit() with offset(); add .limit() or remove .offset()');
		}
		if (config.forUpdate && (config.distinct || config.groupBy.length > 0 || config.having)) {
			throw new Error(
				'CUBRID rejects FOR UPDATE with DISTINCT, GROUP BY or HAVING (-494); lock the rows in a separate select',
			);
		}
		const fields = orderSelectedFields(config.fields);
		if (fields.length === 0) throw new Error('A select needs at least one field');
		const parts: SQL[] = [
			sql`select ${config.distinct ? sql`distinct ` : undefined}${selectionSql(fields, outputNames)} from ${config.source}`,
		];
		for (const join of config.joins) {
			parts.push(
				join.type === 'cross'
					? sql` cross join ${join.source}`
					: sql` ${sql.raw(join.type)} join ${join.source}${join.on ? sql` on ${join.on}` : undefined}`,
			);
		}
		if (config.where) parts.push(sql` where ${config.where}`);
		if (config.groupBy.length > 0) parts.push(sql` group by ${sql.join(config.groupBy, sql`, `)}`);
		if (config.having) parts.push(sql` having ${config.having}`);
		if (config.orderBy.length > 0) parts.push(sql` order by ${sql.join(config.orderBy, sql`, `)}`);
		if (config.limit !== undefined) parts.push(sql` limit ${config.limit}`);
		if (config.offset !== undefined) parts.push(sql` offset ${config.offset}`);
		if (config.forUpdate) parts.push(sql` for update`);
		return sql.join(parts);
	}
}
