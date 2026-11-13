import { entityKind } from 'drizzle-orm/entity';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { BuildRelationalQueryResult } from 'drizzle-orm/relations';
import type { Query, SQL } from 'drizzle-orm/sql/sql';

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

type RelationalFields = BuildRelationalQueryResult['selection'][number]['field'][];

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

function recordFields<T extends BuildRelationalQueryResult>(result: T): T {
	relationalSqlFields.set(result.sql, result.selection.map((selected) => selected.field));
	return result;
}

/** Drizzle's MySQL dialect with the relational-query limits of CUBRID enforced. */
export class CubridDialect extends MySqlDialect {
	static override readonly [entityKind]: string = 'CubridDialect';

	override buildRelationalQuery(args: RelationalQueryArgs): ReturnType<MySqlDialect['buildRelationalQuery']> {
		assertNoRelations(args.queryConfig);
		return recordFields(super.buildRelationalQuery(args));
	}

	override buildRelationalQueryWithoutLateralSubqueries(
		args: Parameters<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']>[0],
	): ReturnType<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']> {
		assertNoRelations(args.queryConfig);
		return recordFields(super.buildRelationalQueryWithoutLateralSubqueries(args));
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
