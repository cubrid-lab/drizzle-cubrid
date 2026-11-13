import { entityKind } from 'drizzle-orm/entity';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';

type RelationalQueryArgs = Parameters<MySqlDialect['buildRelationalQuery']>[0];

/**
 * Relational queries that load relations (`with`) are refused on CUBRID.
 * Drizzle's MySQL dialect builds them from `LEFT JOIN LATERAL`, which CUBRID
 * does not support, or (`mode: 'planetscale'`) from `JSON_ARRAYAGG`, which
 * CUBRID rejects for DATE and DATETIME values, rounds BIGINT values beyond
 * 2^53 and re-encodes non-ASCII text in an ISO-8859-1 database.
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

/** Drizzle's MySQL dialect with the relational-query limits of CUBRID enforced. */
export class CubridDialect extends MySqlDialect {
	static override readonly [entityKind]: string = 'CubridDialect';

	override buildRelationalQuery(args: RelationalQueryArgs): ReturnType<MySqlDialect['buildRelationalQuery']> {
		assertNoRelations(args.queryConfig);
		return super.buildRelationalQuery(args);
	}

	override buildRelationalQueryWithoutLateralSubqueries(
		args: Parameters<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']>[0],
	): ReturnType<MySqlDialect['buildRelationalQueryWithoutLateralSubqueries']> {
		assertNoRelations(args.queryConfig);
		return super.buildRelationalQueryWithoutLateralSubqueries(args);
	}
}
