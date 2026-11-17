import { CasingCache } from 'drizzle-orm/casing';
import { Column } from 'drizzle-orm/column';
import { entityKind, is } from 'drizzle-orm/entity';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { BuildRelationalQueryResult } from 'drizzle-orm/relations';
import {
	type BuildQueryConfig,
	Param,
	Placeholder,
	type Query,
	SQL,
	type SQLChunk,
	StringChunk,
	sql as sqlTag,
} from 'drizzle-orm/sql/sql';

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
	// Mirrors when Drizzle writes LIMIT and OFFSET (buildLimit): LIMIT for any
	// object (a placeholder) or a number >= 0, OFFSET for any truthy value.
	const writesLimit = typeof limit === 'object' || (typeof limit === 'number' && limit >= 0);
	if (offset && !writesLimit) {
		throw unsupported(
			'offset() without a non-negative limit()',
			'add a limit(), since CUBRID accepts OFFSET only after LIMIT',
		);
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

/**
 * Text of the SQL outside quoted identifiers, string literals and comments.
 * CUBRID does not treat a backslash as an escape by default
 * (no_backslash_escapes=yes); a quote inside a literal is doubled.
 */
function sqlKeywordsText(text: string): string {
	return text.replace(/`[^`]*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
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

// charParamSql(), the encoder tracking in sqlToQuery() and
// PlaceholderListsExpanded mirror src/native (columns/string.ts and
// internal.ts) rather than import them: the drizzle-cubrid and
// drizzle-cubrid/native entries share no module (tsup.config.ts), native code
// may not import this MySQL-based one (scripts/check-dialect-boundary.mjs),
// and this file goes when the 0.x API does (ADR 0003). Only the CHAR column
// test differs (MySqlChar's SQL type here, CubridChar there); fix both.

const utf8 = new TextEncoder();

/** `n` for a `char(n)` column (1 for `char()`), undefined for anything else. */
function charLength(encoder: unknown): number | undefined {
	if (!is(encoder, Column)) return undefined;
	const type = /^char(?:\((\d+)\))?$/i.exec(encoder.getSQLType().trim());
	// CUBRID reads CHAR without a length as CHAR(1).
	return type ? Number(type[1] ?? 1) : undefined;
}

/**
 * The placeholder for a value bound to a column: `cast(? as CHAR(m))` for a
 * string compared with or written to a `char()` column, `?` otherwise.
 *
 * CUBRID 11.4 types the host variables of `IN (?, ?)` (two or more) as
 * VARCHAR and compares a CHAR column with VARCHAR values without space
 * padding, so `inArray()` matched no row and `notInArray()` every row (#237).
 * Typed CHAR, the values compare padded, as a single `= ?` already does.
 * `m` is the column length, or the value's UTF-8 byte length when that is
 * larger, so a longer value is never truncated into a match; that byte length
 * is at least its length in characters in any database charset.
 */
function charParamSql(encoder: unknown, value: unknown): string {
	const length = charLength(encoder);
	if (length === undefined || typeof value !== 'string') return '?';
	return `cast(? as CHAR(${Math.max(length, utf8.encode(value).length)}))`;
}

/**
 * A statement whose `inArray()`/`notInArray()` lists of two or more elements,
 * one of them a `sql.placeholder()`, on a `char()` column render as
 * `(c = a or c = b …)` and `(c <> a and c <> b …)`: the SQL definition of
 * `IN` and `NOT IN`, nulls included. A placeholder has no column, so
 * charParamSql() cannot type it, and CUBRID 11.4 compares a CHAR column
 * unpadded with an `IN` list none of whose elements is typed, matching no
 * row; each `= ?` compares padded (#239).
 *
 * drizzle-orm/sql/sql.js renders through `this.buildQueryFromSourceParams()`,
 * recursively on the same `this`, and inArray() builds the chunks
 * `column, ' in ' | ' not in ', [elements]`, a placeholder element being the
 * `Placeholder` itself. Checked against drizzle-orm 0.44.1 and 0.45.4.
 */
class PlaceholderListsExpanded extends SQL {
	override buildQueryFromSourceParams(chunks: SQLChunk[], config: BuildQueryConfig): Query {
		let expanded: SQLChunk[] | undefined;
		for (let i = 0; i < chunks.length; i++) {
			const [column, keyword, list] = [chunks[i], chunks[i + 1], chunks[i + 2]];
			const text = is(keyword, StringChunk) ? keyword.value.join('') : undefined;
			const negate = text === ' not in ' ? true : text === ' in ' ? false : undefined;
			if (
				negate !== undefined &&
				charLength(column) !== undefined &&
				Array.isArray(list) &&
				list.length > 1 &&
				list.some((e) => is(e, Placeholder) || (is(e, Param) && is(e.value, Placeholder)))
			) {
				expanded ??= chunks.slice(0, i);
				const terms = list.map((e) => (negate ? sqlTag`${column} <> ${e}` : sqlTag`${column} = ${e}`));
				expanded.push(sqlTag`(${sqlTag.join(terms, sqlTag.raw(negate ? ' and ' : ' or '))})`);
				i += 2;
			} else {
				expanded?.push(chunks[i] as SQLChunk);
			}
		}
		return super.buildQueryFromSourceParams(expanded ?? chunks, config);
	}
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
		// MySqlDialect#sqlToQuery() with the CHAR casts of charParamSql() and the
		// lists of PlaceholderListsExpanded: it passes no prepareTyping, through
		// which Drizzle hands over each parameter's column. Drizzle calls
		// prepareTyping(encoder) and then escapeParam() for each bound value, and
		// only escapeParam() for a placeholder; `casing` is internal to
		// MySqlDialect. Checked against drizzle-orm 0.44.1 and 0.45.4.
		const casing = (this as unknown as { casing?: unknown }).casing;
		if (!is(casing, CasingCache)) {
			throw new Error(
				'drizzle-cubrid: unsupported drizzle-orm version: MySqlDialect has no `casing` CasingCache; use a drizzle-orm version within the peer range (>=0.44.1 <0.46.0)',
			);
		}
		let encoder: unknown;
		const query = new PlaceholderListsExpanded([sql]).toQuery({
			casing,
			escapeName: this.escapeName,
			escapeParam: (_num, value) => {
				const current = encoder;
				encoder = undefined;
				return charParamSql(current, value);
			},
			escapeString: this.escapeString,
			invokeSource,
			prepareTyping: (next) => {
				encoder = next;
				return 'none';
			},
		});
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
