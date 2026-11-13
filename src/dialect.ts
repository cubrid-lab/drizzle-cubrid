import { entityKind } from 'drizzle-orm/entity';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { BuildRelationalQueryResult } from 'drizzle-orm/relations';
import { type Query, type SQL, sql as sqlTag } from 'drizzle-orm/sql/sql';

type RelationalQueryArgs = Parameters<MySqlDialect['buildRelationalQuery']>[0];

/**
 * Relational queries that load relations (`with`) are refused on CUBRID.
 * Drizzle's MySQL dialect builds them from `LEFT JOIN LATERAL`, which CUBRID
 * does not support, or (`mode: 'planetscale'`) from `JSON_ARRAYAGG`, which
 * CUBRID rejects for DATE and DATETIME values and which garbles non-ASCII text
 * in an ISO-8859-1 database; Drizzle reads that JSON with JSON.parse, which
 * rounds BIGINT values beyond 2^53.
 */
function assertNoRelations(config: RelationalQueryArgs['queryConfig']): void {
	if (config === true || config.with === undefined) {
		return;
	}
	const relations = Object.entries(config.with)
		// Drizzle loads a relation for any truthy value.
		.filter(([, value]) => Boolean(value))
		.map(([relation]) => relation);
	if (relations.length > 0) {
		throw new Error(
			`Relational queries with 'with' (${relations.join(', ')}) are not supported on CUBRID; query the related table separately or use a join. See https://github.com/cubrid-lab/drizzle-cubrid/issues/200`,
		);
	}
}

export type RelationalFields = BuildRelationalQueryResult['selection'][number]['field'][];

/** The selected fields of each relational query, from its SQL to the built Query. */
const relationalSqlFields = new WeakMap<object, RelationalFields>();
const relationalQueryFields = new WeakMap<Query, RelationalFields>();

/**
 * The fields a relational query (`db.query.x.findMany()`) selects, or
 * undefined for any other query. Drizzle hands the session only the built
 * query and a row mapper, so the dialect records them while building it.
 */
export function fieldsOfRelationalQuery(query: Query): RelationalFields | undefined {
	return relationalQueryFields.get(query);
}

/**
 * The `extras` as the application wrote them. Drizzle rebuilds each extra
 * before selecting it and drops its decoder, so `sql`...`.mapWith(column)`
 * would no longer show that it reads a date or time column.
 */
function userExtras(args: RelationalQueryArgs): RelationalFields {
	const { queryConfig, tableConfig } = args;
	if (queryConfig === true || !queryConfig.extras) {
		return [];
	}
	const extras =
		typeof queryConfig.extras === 'function'
			? queryConfig.extras(tableConfig.columns as never, { sql: sqlTag })
			: queryConfig.extras;
	return Object.values(extras);
}

function recordFields<T extends BuildRelationalQueryResult>(args: RelationalQueryArgs, result: T): T {
	relationalSqlFields.set(result.sql, [...result.selection.map((selected) => selected.field), ...userExtras(args)]);
	return result;
}

/** Drizzle's MySQL dialect with the relational-query limits of CUBRID enforced. */
export class CubridDialect extends MySqlDialect {
	static override readonly [entityKind]: string = 'CubridDialect';

	override buildRelationalQuery(args: RelationalQueryArgs): ReturnType<MySqlDialect['buildRelationalQuery']> {
		assertNoRelations(args.queryConfig);
		return recordFields(args, super.buildRelationalQuery(args));
	}

	override buildRelationalQueryWithoutLateralSubqueries(
		args: Parameters<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']>[0],
	): ReturnType<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']> {
		assertNoRelations(args.queryConfig);
		return recordFields(args, super.buildRelationalQueryWithoutLateralSubqueries(args));
	}

	override sqlToQuery(sql: SQL, invokeSource?: 'indexes'): ReturnType<MySqlDialect['sqlToQuery']> {
		const query = super.sqlToQuery(sql, invokeSource);
		const fields = relationalSqlFields.get(sql);
		if (fields) {
			relationalQueryFields.set(query, fields);
		}
		return query;
	}
}
