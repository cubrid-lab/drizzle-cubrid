// The native session: how statements reach cubrid-client (#160).

import {
	ConstraintError,
	DeadlockError,
	LockTimeoutError,
	QueryError,
	SqlSyntaxError,
	TransactionError,
} from 'cubrid-client';
import type { Logger } from 'drizzle-orm';
import { describeValue } from './columns/common.js';
import { quoteIdentifier } from './dialect.js';
import { assertUtcDecoding } from './timezone.js';

/**
 * How statement values reach the server.
 *
 * - `'prepared'` (default): typed binds through cubrid-client's
 *   `queryPrepared()`, so no value ever becomes SQL text.
 * - `'literal'`: cubrid-client writes each value into the SQL text as an
 *   escaped literal (`query()`), one round trip fewer per statement.
 */
export type CubridBinding = 'prepared' | 'literal';

/**
 * How a relational query that loads relations (`with`) runs its statements
 * outside `db.transaction()`:
 *
 * - `'snapshot'` (default): in cubrid-client's `transaction(callback,
 *   { isolationLevel: 'repeatable read' })`, so they read one snapshot on one
 *   connection. A pool whose own `isolationLevel` is not `'repeatable read'`
 *   closes that connection afterwards instead of reusing it.
 * - `'client'`: in `transaction(callback)` at the client's own isolation
 *   level: one connection, and one snapshot when that level is
 *   `'repeatable read'` or `'serializable'`.
 * - `'separate'`: as separate statements, each reading what was committed
 *   when it ran.
 */
export type CubridRelationalReads = 'snapshot' | 'client' | 'separate';

const RELATIONAL_READS: ReadonlySet<unknown> = new Set(['snapshot', 'client', 'separate']);

/**
 * cubrid-client reports a failed statement of a transaction client as a
 * `TransactionError`, and the same statement outside one as a `QueryError`
 * (or its subclass for the error kind, as its `createQueryError()` picks).
 * A relational query runs in a transaction only for consistency, so its
 * statement errors are given the class they have outside one; cubrid-client's
 * error stays reachable as `transactionError`.
 */
function asQueryError(error: unknown): unknown {
	if (!(error instanceof TransactionError)) return error;
	const details: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(error)) {
		if (key !== 'transactionError' && key !== 'rollbackError' && key !== 'name') details[key] = value;
	}
	const options = { ...details, cause: error.cause };
	const kind = details.kind;
	const converted =
		kind === 'unique-violation' || kind === 'not-null-violation' || kind === 'foreign-key-violation'
			? new ConstraintError('Query failed.', options)
			: kind === 'syntax'
				? new SqlSyntaxError('Query failed.', options)
				: kind === 'deadlock'
					? new DeadlockError('Query failed.', options)
					: kind === 'lock-timeout'
						? new LockTimeoutError('Query failed.', options)
						: new QueryError('Query failed.', options);
	Object.assign(converted, details);
	Object.defineProperty(converted, 'transactionError', {
		value: error,
		configurable: true,
		enumerable: true,
		writable: true,
	});
	return converted;
}

/** Statement options this session passes: positional rows for SELECTs. */
export interface CubridArrayRowOptions {
	rowMode: 'array';
}

/**
 * What `iterator()` reads of an `AbortSignal`. Declared here so the published
 * declarations never name `AbortSignal`, which needs the DOM lib or
 * `@types/node`: a Node or DOM `AbortSignal` is assignable to it. It is not a
 * duck-typing contract: `iterator()` still requires a real `AbortSignal` at run
 * time and refuses any other object (a plain `{ aborted: false }`, or a signal
 * from another realm such as jsdom) with a `TypeError`.
 */
export interface CubridAbortSignal {
	readonly aborted: boolean;
	readonly reason?: unknown;
}

/**
 * Options of `iterator()` on a native select, set operation or prepared
 * select. `signal`, `fetchSize` and `consumerTimeout` are passed to
 * cubrid-client's `stream()` (see its `StreamOptions`); `literal` is the
 * dialect's own. Any other key is refused. All are checked when `iterator()`
 * is called, before anything is sent.
 */
export interface CubridStreamOptions {
	/**
	 * Under `binding: 'prepared'` (the default), `true` accepts that this
	 * stream sends its values as SQL literals, which cubrid-client 1.4's
	 * `stream()` always does: CUBRID compares some values differently as
	 * literals than as typed binds (a NULL in `OR` under `NOT`, trailing spaces
	 * in `LIKE`), so the stream can return other rows than `execute()`.
	 * Without it, `iterator()` is refused under that binding. Under
	 * `binding: 'literal'` it changes nothing.
	 */
	literal?: boolean;
	/**
	 * Stops the stream: the next read rejects with `signal.reason` and the
	 * cursor (and a pool's connection) is released. Aborted before the stream
	 * took a connection, nothing is sent.
	 */
	signal?: CubridAbortSignal;
	/** Rows asked for in each FETCH (1 to 2^31 − 1); CUBRID 10.2 to 11.4 answer about 16 KiB of rows per FETCH whatever it says. */
	fetchSize?: number;
	/**
	 * Milliseconds (0 to 2^31 − 1) another statement on the stream's
	 * connection waits while the consumer reads no row, before cubrid-client
	 * rejects it with `kind: 'stream-busy'` (default 5000). Only a
	 * `CubridClient`'s shared connection is affected: a pool streams on a
	 * connection of its own.
	 */
	consumerTimeout?: number;
}

const STREAM_OPTIONS: ReadonlySet<string> = new Set(['literal', 'signal', 'fetchSize', 'consumerTimeout']);
const MAX_INT32 = 2 ** 31 - 1;

/** What this session passes to `stream()`: cubrid-client's options and positional rows. */
export interface CubridStreamCallOptions {
	signal?: CubridAbortSignal;
	fetchSize?: number;
	consumerTimeout?: number;
	rowMode: 'array';
}

/**
 * Checks `iterator()` options as cubrid-client 1.4 checks them (and `signal`
 * as an `AbortSignal`), so a bad value is refused when `iterator()` is
 * called rather than at the first read.
 */
function streamOptions(options: CubridStreamOptions | undefined): {
	literal: boolean;
	call: CubridStreamCallOptions;
} {
	if (options === undefined) return { literal: false, call: { rowMode: 'array' } };
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new TypeError(`iterator() options must be an object, not ${describeValue(options)}`);
	}
	for (const key of Object.keys(options)) {
		if (!STREAM_OPTIONS.has(key)) {
			throw new Error(
				`Unknown iterator() option '${key}'; drizzle-cubrid/native accepts literal, signal, fetchSize and consumerTimeout`,
			);
		}
	}
	const { literal, signal, fetchSize, consumerTimeout } = options;
	if (literal !== undefined && typeof literal !== 'boolean') {
		throw new TypeError(`iterator() option literal must be a boolean, not ${describeValue(literal)}`);
	}
	if (signal !== undefined && !(signal instanceof AbortSignal)) {
		throw new TypeError(`iterator() option signal must be an AbortSignal, not ${describeValue(signal)}`);
	}
	if (fetchSize !== undefined && !(Number.isInteger(fetchSize) && fetchSize > 0 && fetchSize <= MAX_INT32)) {
		throw new RangeError(
			`iterator() option fetchSize must be an integer from 1 to ${MAX_INT32}, not ${describeValue(fetchSize)}`,
		);
	}
	if (
		consumerTimeout !== undefined &&
		!(Number.isInteger(consumerTimeout) && consumerTimeout >= 0 && consumerTimeout <= MAX_INT32)
	) {
		throw new RangeError(
			`iterator() option consumerTimeout must be an integer from 0 to ${MAX_INT32} milliseconds, not ${describeValue(consumerTimeout)}`,
		);
	}
	const call: CubridStreamCallOptions = { rowMode: 'array' };
	if (signal !== undefined) call.signal = signal;
	if (fetchSize !== undefined) call.fetchSize = fetchSize;
	if (consumerTimeout !== undefined) call.consumerTimeout = consumerTimeout;
	return { literal: literal === true, call };
}

/** Refuses an array parameter, which cubrid-client cannot bind. */
function refuseArrayParams(params: unknown[]): void {
	const index = params.findIndex(Array.isArray);
	if (index >= 0) {
		// cubrid-client cannot bind an array; a collection value is written as
		// the typed collection literal by insert and update, and a list needs
		// one placeholder per value.
		throw new TypeError(
			`Parameter ${index + 1} is an array, which cannot be bound; collection values can be written only as an insert or update value of a collection column, and inArray() takes a list of values, not one placeholder`,
		);
	}
}

/**
 * The outcome of an INSERT, UPDATE or DELETE, as cubrid-client's `execute()`
 * and `executePrepared()` report it: `affectedRows`, and `lastInsertId` only
 * when an INSERT made the session hold a new AUTO_INCREMENT value (a `number`
 * while it is a safe integer, a `bigint` beyond that).
 */
export interface CubridDmlResult {
	affectedRows: number;
	lastInsertId?: number | bigint;
}

/**
 * Write options this session passes: `generatedKeys` asks cubrid-client for
 * the keys the server says the INSERT generated (CAS GET_GENERATED_KEYS)
 * instead of the session's last insert id.
 */
export interface CubridWriteOptions {
	generatedKeys: true;
}

/** The isolation levels CUBRID 10.2 to 11.4 accept (cubrid-client's `IsolationLevel`). */
export type CubridIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Options of `db.transaction(callback, config)`. */
export interface CubridTransactionConfig {
	/** Applied by cubrid-client on the transaction's connection before it starts. */
	isolationLevel?: CubridIsolationLevel;
}

/**
 * What the native session needs from a client: `CubridClient`, `CubridPool`
 * and their transaction clients from cubrid-client 1.4 provide it. Writes
 * need `executePrepared()` (default binding) or `execute()` (`'literal'`),
 * and `db.transaction()` needs `transaction()`.
 */
export interface CubridNativeClient {
	query(sql: string, params?: readonly unknown[], options?: CubridArrayRowOptions): Promise<unknown[]>;
	queryPrepared?(sql: string, params?: readonly unknown[], options?: CubridArrayRowOptions): Promise<unknown[]>;
	execute?(sql: string, params?: readonly unknown[], options?: CubridWriteOptions): Promise<CubridDmlResult>;
	executePrepared?(sql: string, params?: readonly unknown[], options?: CubridWriteOptions): Promise<CubridDmlResult>;
	/**
	 * Reads a SELECT's rows one server reply at a time, writing the values
	 * into the SQL text as escaped literals (cubrid-client 1.4's `stream()`);
	 * `iterator()` needs it.
	 */
	stream?(
		sql: string,
		params: readonly unknown[] | undefined,
		options: CubridStreamCallOptions,
	): AsyncIterable<unknown[]>;
	/**
	 * Runs `callback` on a connection the driver owns for the whole
	 * transaction, commits when it resolves and rolls back when it rejects
	 * (cubrid-client 1.3.0 or later for `options`).
	 */
	transaction?<T>(
		callback: (tx: CubridNativeClient) => Promise<T>,
		options?: { isolationLevel?: CubridIsolationLevel },
	): Promise<T>;
}

const ISOLATION_LEVELS: ReadonlySet<unknown> = new Set(['read committed', 'repeatable read', 'serializable']);

/**
 * Checks `db.transaction()`'s config before a connection is taken. CUBRID has
 * no READ UNCOMMITTED level, no read-only transaction mode and no
 * consistent-snapshot start, so those (and any other key) are refused rather
 * than ignored.
 */
function transactionOptions(
	config: CubridTransactionConfig | undefined,
): { isolationLevel: CubridIsolationLevel } | undefined {
	if (config === undefined) return undefined;
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new TypeError(`The transaction config must be an object, not ${describeValue(config)}`);
	}
	for (const key of Object.keys(config)) {
		if (key === 'isolationLevel') continue;
		if (key === 'accessMode' || key === 'withConsistentSnapshot') {
			throw new Error(`CUBRID transactions do not support ${key}`);
		}
		throw new Error(`Unknown transaction option '${key}'; drizzle-cubrid/native accepts only isolationLevel`);
	}
	// Only an own property: an inherited one would be a surprise.
	const isolationLevel = Object.hasOwn(config, 'isolationLevel') ? config.isolationLevel : undefined;
	if (isolationLevel === undefined) return undefined;
	if (!ISOLATION_LEVELS.has(isolationLevel)) {
		const shown = typeof isolationLevel === 'string' ? `'${isolationLevel}'` : describeValue(isolationLevel);
		throw new Error(
			`CUBRID does not support isolation level ${shown}; use 'read committed', 'repeatable read' or 'serializable'`,
		);
	}
	return { isolationLevel };
}

/**
 * Records `value` on the error being rethrown, for diagnosis, without
 * replacing that error. Skips values that are not extensible errors and keeps
 * a property that is already set.
 */
function attachDiagnostic(primary: unknown, key: 'rollbackError' | 'transactionError', value: unknown): void {
	if (primary instanceof Error && Object.isExtensible(primary) && !(key in primary)) {
		Object.defineProperty(primary, key, { value, configurable: true, enumerable: true, writable: true });
	}
}

/**
 * One transaction level: the outermost transaction or a savepoint in it. It
 * ends when its callback settles, and a level inside one that ended has
 * ended too. While a nested transaction runs inside it, or after rolling one
 * back to its savepoint failed, it refuses statements of its own.
 */
export class CubridTransactionScope {
	private ended = false;
	/** The nested transaction running directly inside this level, if any. */
	child: CubridTransactionScope | undefined;
	/** The error of a nested transaction whose rollback to its savepoint failed. */
	private failure: { error: unknown } | undefined;

	constructor(
		/** 0 for the outermost transaction, N for savepoint `spN`. */
		readonly depth: number,
		readonly parent?: CubridTransactionScope,
	) {}

	get active(): boolean {
		return !this.ended && (this.parent?.active ?? true);
	}

	end(): void {
		this.ended = true;
		if (this.parent?.child === this) this.parent.child = undefined;
	}

	private get level(): string {
		return this.depth === 0 ? 'transaction' : `nested transaction (savepoint sp${this.depth})`;
	}

	/**
	 * Marks this level as one that can only roll back: rolling back a nested
	 * transaction to its savepoint failed, so the nested work may still be in it.
	 */
	fail(error: unknown): void {
		this.failure ??= { error };
	}

	/**
	 * Refuses a statement of this level, before it is sent, when its callback
	 * has settled, when a nested transaction runs inside it (unless
	 * `forNested`, for the nested transaction's own savepoint statements), or
	 * when it can only roll back.
	 */
	assertActive(forNested = false): void {
		if (!this.active) {
			throw new Error(
				`This ${this.level} has ended: its callback has settled, so its tx can no longer run statements or transactions`,
			);
		}
		if (this.failure) {
			throw new Error(
				`This ${this.level} can only roll back: rolling back a nested transaction to its savepoint failed, so its work may still be part of it`,
				{ cause: this.failure.error },
			);
		}
		if (!forNested && this.child !== undefined) {
			// Rolling the nested transaction back to its savepoint would also undo
			// this statement.
			throw new Error(
				`A nested transaction (savepoint sp${this.child.depth}) is running in this ${this.level}; await the nested transaction first`,
			);
		}
	}

	/**
	 * Checks a level whose callback resolved before it commits or keeps its
	 * savepoint: a nested transaction still running could fail after that, and
	 * a failed rollback to a savepoint leaves work that must not be committed.
	 */
	assertSettled(): void {
		if (this.child !== undefined) {
			throw new Error(
				`A nested transaction (savepoint sp${this.child.depth}) was still running when the callback of this ${this.level} returned; await every nested transaction before returning`,
			);
		}
		if (this.failure) throw this.failure.error;
	}
}

const ARRAY_ROWS: CubridArrayRowOptions = { rowMode: 'array' };

export interface CubridSessionOptions {
	logger?: Logger;
	binding?: CubridBinding;
	/**
	 * The client whose time zone setting decides whether date and time
	 * columns can be read; defaults to `client`. A transaction's session uses
	 * the client that started it.
	 */
	zoneClient?: CubridNativeClient;
	/** The transaction level this session belongs to; its statements are refused once it ended. */
	scope?: CubridTransactionScope;
	/** See {@link CubridRelationalReads}. */
	relationalReads?: CubridRelationalReads;
}

export class CubridSession {
	readonly binding: CubridBinding;

	constructor(
		readonly client: CubridNativeClient,
		private readonly options: CubridSessionOptions = {},
	) {
		const binding = options.binding ?? 'prepared';
		if (binding !== 'prepared' && binding !== 'literal') {
			throw new Error(`Unknown binding ${describeValue(binding)}; use 'prepared' or 'literal'`);
		}
		if (typeof client?.query !== 'function') {
			throw new TypeError('drizzle-cubrid/native needs a cubrid-client client or pool, with query()');
		}
		if (options.relationalReads !== undefined && !RELATIONAL_READS.has(options.relationalReads)) {
			throw new Error(
				`Unknown relationalReads ${describeValue(options.relationalReads)}; use 'snapshot', 'client' or 'separate'`,
			);
		}
		if (binding === 'prepared' && typeof client.queryPrepared !== 'function') {
			throw new Error(
				"The CUBRID client has no queryPrepared() for typed binding (cubrid-client 1.3.0 or later); pass { binding: 'literal' } to drizzle() to send values as SQL literals",
			);
		}
		this.binding = binding;
	}

	/** Throws when this session belongs to a transaction level that has ended. */
	assertActive(): void {
		this.options.scope?.assertActive();
	}

	/** Refuses a statement of an ended transaction or an array parameter, then logs the statement. */
	private send(sql: string, params: unknown[], forNested = false): void {
		this.options.scope?.assertActive(forNested);
		refuseArrayParams(params);
		this.options.logger?.logQuery(sql, params);
	}

	private run(sql: string, params: unknown[], options?: CubridArrayRowOptions, forNested = false): Promise<unknown[]> {
		try {
			this.send(sql, params, forNested);
		} catch (error) {
			return Promise.reject(error);
		}
		// Driver errors are passed through unchanged, with their code, kind and cause.
		if (this.binding === 'literal') return this.client.query(sql, params, options);
		const prepared = this.client.queryPrepared;
		return prepared ? prepared.call(this.client, sql, params, options) : this.client.query(sql, params, options);
	}

	/**
	 * Rows of a SELECT as arrays in select-list order. With `readsTemporal`,
	 * a client that does not decode date and time values in UTC is refused
	 * before the statement is sent.
	 */
	async selectRows(sql: string, params: unknown[], readsTemporal: boolean): Promise<unknown[]> {
		this.assertActive();
		if (readsTemporal) await assertUtcDecoding(this.options.zoneClient ?? this.client);
		return this.run(sql, params, ARRAY_ROWS);
	}

	/**
	 * The rows of a SELECT one at a time, as arrays in select-list order, from
	 * cubrid-client's `stream()`, which sends the values as SQL literals. When
	 * called it refuses, before anything is sent: a transaction level that
	 * ended; anything inside `db.transaction()` (cubrid-client 1.4's
	 * transaction client has no `stream()`); a client without `stream()`; bad
	 * options or an array parameter; and, under `binding: 'prepared'`, a
	 * stream without `{ literal: true }`, since literals can match other rows
	 * than typed binds (cubrid-lab/cubrid-client#307). The statement is sent,
	 * and the UTC-decoding check made, on the first read; ending the iteration
	 * early (`break`, `return()`, a throw) closes cubrid-client's stream, which
	 * releases the cursor and a pool's connection.
	 */
	streamRows(
		sql: string,
		params: unknown[],
		readsTemporal: boolean,
		options?: CubridStreamOptions,
	): AsyncGenerator<unknown[], void, undefined> {
		this.assertActive();
		const { literal, call } = streamOptions(options);
		if (this.options.scope !== undefined) {
			throw new Error(
				"iterator() is not supported inside db.transaction(): cubrid-client 1.4's transaction client has no stream(); await the select in the transaction, or stream with db outside it",
			);
		}
		const stream = this.client.stream;
		if (typeof stream !== 'function') {
			throw new Error(
				'The CUBRID client has no stream() for iterator() (a cubrid-client 1.4 client or pool has one; its transaction clients do not)',
			);
		}
		if (this.binding === 'prepared' && !literal) {
			throw new Error(
				"iterator() is refused under binding 'prepared': cubrid-client 1.4's stream() sends values only as SQL literals, and CUBRID compares some values differently as literals than as typed binds (a NULL inside OR under NOT, trailing spaces in LIKE), so the stream could return other rows than execute(). Create the database with drizzle(client, { binding: 'literal' }) so that execute() and iterator() both send literals, or pass { literal: true } to iterator() to accept literal semantics for this stream (cubrid-lab/cubrid-client#307)",
			);
		}
		refuseArrayParams(params);
		const client = this.client;
		const zoneClient = this.options.zoneClient ?? client;
		const send = (sql: string, params: unknown[]) => this.send(sql, params);
		return (async function* () {
			if (readsTemporal) await assertUtcDecoding(zoneClient);
			// Aborted before the first read: nothing is sent, so nothing is logged.
			if (call.signal?.aborted) throw call.signal.reason;
			send(sql, params);
			// Driver errors are passed through unchanged; leaving this loop early
			// calls return() on cubrid-client's stream.
			yield* stream.call(client, sql, params, call);
		})();
	}

	/**
	 * Runs an INSERT, UPDATE or DELETE with `executePrepared()` (or `execute()`
	 * under `'literal'` binding) and reports the driver's `affectedRows` and
	 * `lastInsertId` unchanged. Driver errors are passed through unchanged.
	 */
	async write(sql: string, params: unknown[], options?: CubridWriteOptions): Promise<CubridDmlResult> {
		const literal = this.binding === 'literal';
		const method = literal ? this.client.execute : this.client.executePrepared;
		if (typeof method !== 'function') {
			throw new Error(
				`The CUBRID client has no ${literal ? 'execute' : 'executePrepared'}() for INSERT, UPDATE and DELETE (cubrid-client 1.3.0 or later)`,
			);
		}
		this.send(sql, params);
		const result = await (options
			? method.call(this.client, sql, params, options)
			: method.call(this.client, sql, params));
		const { affectedRows, lastInsertId } = result;
		return lastInsertId === undefined ? { affectedRows } : { affectedRows, lastInsertId };
	}

	/** Rows of a raw statement as cubrid-client returns them. */
	rawRows(sql: string, params: unknown[]): Promise<unknown[]> {
		return this.run(sql, params);
	}

	/**
	 * Runs `run` with a session on a connection cubrid-client's `transaction()`
	 * owns: it commits when `run` resolves and rolls back when it rejects. A
	 * failure of the callback is rethrown as itself, with the driver's error as
	 * `transactionError` and a failed rollback as `rollbackError`; any other
	 * driver error (a failed commit, whose outcome can be unknown) is passed
	 * through unchanged.
	 */
	async transaction<T>(run: (session: CubridSession) => Promise<T>, config?: CubridTransactionConfig): Promise<T> {
		const options = transactionOptions(config);
		this.assertActive();
		const client = this.client;
		if (typeof client.transaction !== 'function') {
			// BEGIN/COMMIT on a connection other callers may share could let their
			// statements join, commit or roll back this transaction (#185).
			throw new Error(
				'db.transaction() needs a client or pool with transaction() (cubrid-client 1.3.0 or later), which runs the callback on a connection of its own; this client has none',
			);
		}
		if (options !== undefined && client.transaction.length < 2) {
			// transaction(callback) alone would silently run at the default level.
			throw new Error(
				'isolationLevel needs a client whose transaction() declares an options parameter (cubrid-client 1.3.0 or later)',
			);
		}
		const zoneClient = this.options.zoneClient ?? this.client;
		let failure: { error: unknown } | undefined;
		const callback = async (txClient: CubridNativeClient): Promise<T> => {
			const scope = new CubridTransactionScope(0);
			try {
				const result = await run(new CubridSession(txClient, { ...this.options, zoneClient, scope }));
				scope.assertSettled();
				return result;
			} catch (error) {
				failure = { error };
				throw error;
			} finally {
				scope.end();
			}
		};
		try {
			return await (options === undefined ? client.transaction(callback) : client.transaction(callback, options));
		} catch (driverError) {
			// cubrid-client wraps a callback failure in its own TransactionError.
			if (failure && driverError !== failure.error) {
				const rollbackError =
					typeof driverError === 'object' && driverError !== null && 'rollbackError' in driverError
						? driverError.rollbackError
						: undefined;
				if (rollbackError !== undefined) attachDiagnostic(failure.error, 'rollbackError', rollbackError);
				attachDiagnostic(failure.error, 'transactionError', driverError);
				throw failure.error;
			}
			throw driverError;
		}
	}

	/**
	 * Runs the statements of one relational query (`run`): inside a
	 * transaction, on its connection at its isolation level; otherwise as
	 * `relationalReads` says (see {@link CubridRelationalReads}). The
	 * transactional modes need a client with `transaction()` (`'snapshot'`: one
	 * that declares an options parameter) and are refused otherwise, before
	 * anything is sent. A failed statement rejects with the error class it has
	 * outside a transaction (see asQueryError).
	 */
	async consistentRead<T>(run: (session: CubridSession) => Promise<T>): Promise<T> {
		const mode = this.options.relationalReads ?? 'snapshot';
		if (this.options.scope !== undefined || mode === 'separate') return run(this);
		const transaction = this.client.transaction;
		if (typeof transaction !== 'function' || (mode === 'snapshot' && transaction.length < 2)) {
			throw new Error(
				mode === 'snapshot'
					? "A relational query with 'with' reads one snapshot through the client's transaction(callback, options) (cubrid-client 1.3.0 or later), which this client lacks; pass relationalReads: 'separate' to drizzle() to run its statements separately"
					: "relationalReads: 'client' needs a client with transaction(); pass relationalReads: 'separate' to run the statements separately",
			);
		}
		// Only a statement's own error is converted: a failed commit keeps its class.
		let failed: { error: unknown } | undefined;
		const statements = (session: CubridSession) =>
			run(session).catch((error: unknown) => {
				failed = { error };
				throw error;
			});
		try {
			return await (mode === 'snapshot'
				? this.transaction(statements, { isolationLevel: 'repeatable read' })
				: this.transaction(statements));
		} catch (error) {
			throw failed && error === failed.error ? asQueryError(error) : error;
		}
	}

	/**
	 * Runs `run` inside `SAVEPOINT "spN"` on this transaction's connection.
	 * When it rejects, the work since the savepoint is undone with
	 * `ROLLBACK TO SAVEPOINT` and the error rethrown (a failed rollback is
	 * attached as `rollbackError`). CUBRID has no RELEASE SAVEPOINT, so a
	 * resolved one stays until the transaction ends.
	 */
	async savepoint<T>(run: (session: CubridSession) => Promise<T>): Promise<T> {
		const parent = this.options.scope;
		if (parent === undefined) throw new Error('A savepoint needs a transaction');
		// Also refuses a second nested transaction while one runs: both would
		// roll back to the same point of one connection's work.
		parent.assertActive();
		const scope = new CubridTransactionScope(parent.depth + 1, parent);
		const name = quoteIdentifier(`sp${scope.depth}`);
		parent.child = scope;
		try {
			await this.run(`savepoint ${name}`, [], undefined, true);
		} catch (error) {
			scope.end();
			throw error;
		}
		try {
			const result = await run(new CubridSession(this.client, { ...this.options, scope }));
			scope.assertSettled();
			scope.end();
			return result;
		} catch (error) {
			scope.end();
			try {
				await this.run(`rollback to savepoint ${name}`, []);
			} catch (rollbackError) {
				attachDiagnostic(error, 'rollbackError', rollbackError);
				// The nested work may still be in the transaction: never commit it.
				parent.fail(error);
			}
			throw error;
		}
	}
}
