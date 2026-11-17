// `drizzle()` for drizzle-cubrid/native (#160).

import { DefaultLogger, type Logger, TransactionRollbackError } from 'drizzle-orm';
import { entityKind } from 'drizzle-orm/entity';
import type { SQLWrapper } from 'drizzle-orm/sql/sql';
import { CubridDialect } from './dialect.js';
import { CubridDelete, CubridInsertBuilder, CubridUpdateBuilder } from './dml.js';
import { CubridSelectBuilder, type CubridSelectedFields } from './select.js';

export type { CubridSelectedFields };

import { type CubridBinding, type CubridNativeClient, CubridSession, type CubridTransactionConfig } from './session.js';
import { CubridTable } from './table.js';

function assertTable(table: unknown, method: string): asserts table is CubridTable {
	if (!(table instanceof CubridTable)) throw new TypeError(`${method} needs a drizzle-cubrid/native table`);
}

export interface CubridDrizzleConfig {
	/** `true` logs every statement with Drizzle's `DefaultLogger`. */
	logger?: boolean | Logger;
	/** How values reach the server: `'prepared'` (typed binds, default) or `'literal'`. */
	binding?: CubridBinding;
}

export class CubridDatabase {
	static readonly [entityKind]: string = 'CubridNativeDatabase';

	private readonly dialect = new CubridDialect();

	constructor(protected readonly session: CubridSession) {}

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

	/**
	 * Runs `transaction` on a connection cubrid-client's `transaction()` owns,
	 * so every statement of `tx` belongs to it while statements of `db` stay
	 * outside. Commits when the callback resolves and resolves to its value;
	 * rolls back when it rejects and rejects with its error. A failed commit
	 * is cubrid-client's error, unchanged. `config.isolationLevel` is applied
	 * before the transaction starts.
	 */
	transaction<T>(transaction: (tx: CubridTransaction) => Promise<T>, config?: CubridTransactionConfig): Promise<T> {
		return this.session.transaction((session) => transaction(new CubridTransaction(session)), config);
	}
}

/**
 * `tx.rollback()` throws it to roll back the transaction (or, in a nested
 * transaction, to its savepoint); `transaction()` then rejects with it. It is
 * Drizzle's `TransactionRollbackError`, so `instanceof` checks for either work.
 */
export class CubridTransactionRollbackError extends TransactionRollbackError {
	static override readonly [entityKind]: string = 'CubridNativeTransactionRollbackError';
}

/**
 * The `tx` of a native transaction: a database bound to the transaction's
 * connection. It refuses every statement once its callback has settled.
 */
export class CubridTransaction extends CubridDatabase {
	static override readonly [entityKind]: string = 'CubridNativeTransaction';

	/**
	 * A nested transaction: `SAVEPOINT "spN"`, and `ROLLBACK TO SAVEPOINT` when
	 * the callback rejects, which leaves the enclosing transaction's earlier
	 * work in place. The error is rethrown, so catch it to go on. It takes no
	 * config: the isolation level belongs to the outermost transaction.
	 */
	override transaction<T>(transaction: (tx: CubridTransaction) => Promise<T>, config?: never): Promise<T> {
		if (config !== undefined) {
			return Promise.reject(
				new Error('A nested transaction takes no config; set isolationLevel on the outermost transaction'),
			);
		}
		return this.session.savepoint((session) => transaction(new CubridTransaction(session)));
	}

	/** Rolls back this transaction (or nested transaction) by throwing `CubridTransactionRollbackError`. */
	rollback(): never {
		this.session.assertActive();
		throw new CubridTransactionRollbackError();
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
