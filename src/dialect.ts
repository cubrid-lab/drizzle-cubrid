import { entityKind } from 'drizzle-orm/entity';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { BuildRelationalQueryResult } from 'drizzle-orm/relations';
import { type Query, type SQL, sql as sqlTag } from 'drizzle-orm/sql/sql';

type RelationalQueryArgs = Parameters<MySqlDialect['buildRelationalQuery']>[0];
type SelectConfig = Parameters<MySqlDialect['buildSelectQuery']>[0];
type SetOperationArgs = Parameters<MySqlDialect['buildSetOperationQuery']>[0];
type InsertConfig = Parameters<MySqlDialect['buildInsertQuery']>[0];
type DeleteConfig = Parameters<MySqlDialect['buildDeleteQuery']>[0];

const UNSUPPORTED_SQL_ISSUE = 'https://github.com/cubrid-lab/drizzle-cubrid/issues/189';

/**
 * Drizzle's MySQL builders emit some SQL that CUBRID 11.4 always rejects, and
 * cubrid-client reports only a generic syntax error (-493) for it. These are
 * refused before anything is sent, with what to do instead.
 */
function unsupported(feature: string, instead: string): Error {
	return new Error(`${feature} is not supported on CUBRID; ${instead}. See ${UNSUPPORTED_SQL_ISSUE}`);
}

function assertOffsetHasLimit(limit: unknown, offset: unknown): void {
	// Mirrors when Drizzle writes LIMIT and OFFSET: LIMIT for a placeholder or
	// a number >= 0, OFFSET for any truthy value.
	const writesLimit = (typeof limit === 'object' && limit !== null) || (typeof limit === 'number' && limit >= 0);
	if (offset && !writesLimit) {
		throw unsupported('offset() without limit()', 'add a limit(), since CUBRID accepts OFFSET only after LIMIT');
	}
}

function assertSelectSupported(config: SelectConfig): void {
	assertOffsetHasLimit(config.limit, config.offset);
	const lateral = config.joins?.find((join) => join.lateral);
	if (lateral) {
		throw unsupported(`${lateral.joinType} join lateral`, 'join a subquery without LATERAL, or run a separate query');
	}
	const locking = config.lockingClause;
	if (locking) {
		if (locking.strength !== 'update') {
			throw unsupported(`for('${locking.strength}')`, "use for('update')");
		}
		if (locking.config.noWait || locking.config.skipLocked) {
			throw unsupported(
				`for('update', { ${locking.config.noWait ? 'noWait' : 'skipLocked'} })`,
				"use for('update') without options",
			);
		}
	}
}

/** Text of the SQL outside quoted identifiers and string literals. */
function sqlKeywordsText(text: string): string {
	return text.replace(/`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, ' ');
}

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

	override buildSelectQuery(config: SelectConfig): ReturnType<MySqlDialect['buildSelectQuery']> {
		assertSelectSupported(config);
		return super.buildSelectQuery(config);
	}

	override buildSetOperationQuery(args: SetOperationArgs): ReturnType<MySqlDialect['buildSetOperationQuery']> {
		assertOffsetHasLimit(args.setOperator.limit, args.setOperator.offset);
		return super.buildSetOperationQuery(args);
	}

	override buildInsertQuery(config: InsertConfig): ReturnType<MySqlDialect['buildInsertQuery']> {
		if (config.ignore) {
			throw unsupported(
				'insert().ignore()',
				'CUBRID has no INSERT IGNORE; use onDuplicateKeyUpdate() or check for the row first',
			);
		}
		return super.buildInsertQuery(config);
	}

	override buildDeleteQuery(config: DeleteConfig): ReturnType<MySqlDialect['buildDeleteQuery']> {
		if (config.orderBy && config.orderBy.length > 0) {
			throw unsupported(
				'delete().orderBy()',
				'CUBRID accepts DELETE ... LIMIT but not ORDER BY; select the keys in order and delete by key',
			);
		}
		return super.buildDeleteQuery(config);
	}

	override sqlToQuery(sql: SQL, invokeSource?: 'indexes'): ReturnType<MySqlDialect['sqlToQuery']> {
		const query = super.sqlToQuery(sql, invokeSource);
		// ilike()/notIlike() build raw `<column> ilike <value>`; values are
		// parameters here, so only the statement's own text is searched.
		if (/\bilike\b/i.test(sqlKeywordsText(query.sql))) {
			throw unsupported(
				'ILIKE (ilike() and notIlike())',
				'use like(), whose case sensitivity follows the column collation, or compare lower() of both sides',
			);
		}
		const fields = relationalSqlFields.get(sql);
		if (fields) {
			relationalQueryFields.set(query, fields);
		}
		return query;
	}
}
