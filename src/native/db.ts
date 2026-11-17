// `drizzle()` for drizzle-cubrid/native (#160).

import { DefaultLogger, type Logger } from 'drizzle-orm';
import { entityKind } from 'drizzle-orm/entity';
import type { SelectedFields } from 'drizzle-orm/operations';
import type { SQLWrapper } from 'drizzle-orm/sql/sql';
import type { CubridColumn } from './columns/common.js';
import { CubridDialect } from './dialect.js';
import { CubridDelete, CubridInsertBuilder, CubridUpdateBuilder } from './dml.js';
import { CubridSelectBuilder } from './select.js';
import { type CubridBinding, type CubridNativeClient, CubridSession } from './session.js';
import { CubridTable } from './table.js';

function assertTable(table: unknown, method: string): asserts table is CubridTable {
	if (!(table instanceof CubridTable)) throw new TypeError(`${method} needs a drizzle-cubrid/native table`);
}

export type CubridSelectedFields = SelectedFields<CubridColumn, CubridTable>;

export interface CubridDrizzleConfig {
	/** `true` logs every statement with Drizzle's `DefaultLogger`. */
	logger?: boolean | Logger;
	/** How values reach the server: `'prepared'` (typed binds, default) or `'literal'`. */
	binding?: CubridBinding;
}

export class CubridDatabase {
	static readonly [entityKind]: string = 'CubridNativeDatabase';

	private readonly dialect = new CubridDialect();

	constructor(private readonly session: CubridSession) {}

	/** `select()` reads every column of the source; `select({ ... })` the given fields. */
	select(): CubridSelectBuilder<undefined>;
	select<TSelection extends CubridSelectedFields>(fields: TSelection): CubridSelectBuilder<TSelection>;
	select(fields?: CubridSelectedFields): CubridSelectBuilder<CubridSelectedFields | undefined> {
		return new CubridSelectBuilder(this.session, this.dialect, fields, false);
	}

	/** `SELECT DISTINCT`. */
	selectDistinct(): CubridSelectBuilder<undefined>;
	selectDistinct<TSelection extends CubridSelectedFields>(fields: TSelection): CubridSelectBuilder<TSelection>;
	selectDistinct(fields?: CubridSelectedFields): CubridSelectBuilder<CubridSelectedFields | undefined> {
		return new CubridSelectBuilder(this.session, this.dialect, fields, true);
	}

	/** `INSERT INTO table`: continue with `values()` or `select()`. */
	insert<TTable extends CubridTable>(table: TTable): CubridInsertBuilder<TTable> {
		assertTable(table, 'insert()');
		return new CubridInsertBuilder(table, this.session, this.dialect);
	}

	/** `UPDATE table`: continue with `set()`. */
	update<TTable extends CubridTable>(table: TTable): CubridUpdateBuilder<TTable> {
		assertTable(table, 'update()');
		return new CubridUpdateBuilder(table, this.session, this.dialect);
	}

	/** `DELETE FROM table`; without `where()` it deletes every row. */
	delete<TTable extends CubridTable>(table: TTable): CubridDelete<TTable> {
		assertTable(table, 'delete()');
		return new CubridDelete(this.session, this.dialect, table);
	}

	/**
	 * Runs a raw statement and returns its rows as cubrid-client returns them
	 * (objects keyed by column label), without decoding. Values in `sql`
	 * templates are bound like any other statement's.
	 */
	execute<TRow = Record<string, unknown>>(query: SQLWrapper | string): Promise<TRow[]> {
		const statement = typeof query === 'string' ? { sql: query, params: [] } : this.dialect.sqlToQuery(query);
		return this.session.rawRows(statement.sql, statement.params) as Promise<TRow[]>;
	}
}

/**
 * A native database over a cubrid-client client or pool (experimental).
 * With the default `binding: 'prepared'` the client needs `queryPrepared()`.
 */
export function drizzle<TClient extends CubridNativeClient>(
	client: TClient,
	config: CubridDrizzleConfig = {},
): CubridDatabase & { $client: TClient } {
	const logger = config.logger === true ? new DefaultLogger() : config.logger || undefined;
	const db = new CubridDatabase(new CubridSession(client, { logger, binding: config.binding }));
	return Object.assign(db, { $client: client });
}
