import { entityKind } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MySqlPreparedQueryConfig,
	MySqlSession as MySqlSessionBase,
	MySqlTransactionConfig,
} from 'drizzle-orm/mysql-core/session';
import type { SelectedFieldsOrdered } from 'drizzle-orm/mysql-core/query-builders/select.types';
import { sql } from 'drizzle-orm/sql/sql';
import { TransactionRollbackError } from 'drizzle-orm';

const hoistedMocks = vi.hoisted(() => {
	const mapResultRowMock = vi.fn(
		(
			_fields: SelectedFieldsOrdered,
			row: unknown[],
			_joinsNotNullableMap: Record<string, boolean> | undefined,
		) => ({ mapped: row }),
	);

	const fillPlaceholdersMock = vi.fn(
		(params: unknown[], values: Record<string, unknown>): unknown[] => {
			return params.map((param) => {
				if (
					typeof param === 'object' &&
					param !== null &&
					'name' in param &&
					typeof (param as { name: unknown }).name === 'string'
				) {
					return values[(param as { name: string }).name];
				}
				return param;
			});
		},
	);

	return { mapResultRowMock, fillPlaceholdersMock };
});

vi.mock('drizzle-orm/utils', async () => {
	const actual = await vi.importActual<typeof import('drizzle-orm/utils')>('drizzle-orm/utils');
	return {
		...actual,
		mapResultRow: hoistedMocks.mapResultRowMock,
	};
});

vi.mock('drizzle-orm/sql/sql', async () => {
	const actual = await vi.importActual<typeof import('drizzle-orm/sql/sql')>('drizzle-orm/sql/sql');
	return {
		...actual,
		fillPlaceholders: hoistedMocks.fillPlaceholdersMock,
	};
});

const { mapResultRowMock, fillPlaceholdersMock } = hoistedMocks;

import { bigint, int, varchar } from '../src/columns';
import {
	CubridPreparedQuery,
	CubridSession,
	CubridTransaction,
	type CubridQueryable,
	type CubridRawQueryResult,
} from '../src/session';
import { cubridTable } from '../src/table';

class MockClient implements CubridQueryable {
	queries: { sql: string; params?: readonly unknown[]; options?: unknown }[] = [];
	results: unknown[][] = [];

	async query<T>(sqlText: string, params?: readonly unknown[], options?: unknown): Promise<T[]> {
		this.queries.push(options === undefined ? { sql: sqlText, params } : { sql: sqlText, params, options });
		return (this.results.shift() ?? []) as T[];
	}

	// Sessions use typed binding by default; record it through the same list.
	async queryPrepared<T>(sqlText: string, params?: readonly unknown[], options?: unknown): Promise<T[]> {
		return this.query<T>(sqlText, params, options);
	}
}

// Behaves like cubrid-client's query(): object rows keyed by column label (a
// repeated label keeps only its last value), or arrays in select-list order
// with { rowMode: 'array' }.
class LabelledRowsClient implements CubridQueryable {
	options: unknown[] = [];

	constructor(
		private labels: string[],
		private rows: unknown[][],
	) {}

	async query<T>(_sql: string, _params?: readonly unknown[], options?: unknown): Promise<T[]> {
		this.options.push(options);
		if ((options as { rowMode?: string } | undefined)?.rowMode === 'array') {
			return this.rows.map((row) => [...row]) as T[];
		}
		return this.rows.map((row) =>
			Object.fromEntries(this.labels.map((label, i) => [label, row[i]])),
		) as T[];
	}
}

class ExecutingClient extends MockClient {
	executed: { sql: string; params?: readonly unknown[] }[] = [];

	constructor(private executeResult: { affectedRows: number; lastInsertId?: number | bigint }) {
		super();
	}

	async execute(sqlText: string, params?: readonly unknown[]) {
		this.executed.push({ sql: sqlText, params });
		return this.executeResult;
	}

	async executePrepared(sqlText: string, params?: readonly unknown[]) {
		return this.execute(sqlText, params);
	}
}

class NoopLoggerForTests implements Logger {
	logQuery(): void {}
}

const users = cubridTable('users', {
	id: int('id').primaryKey().autoincrement(),
	token: varchar('token', { length: 255 }).$defaultFn(() => crypto.randomUUID()),
});

describe('CubridPreparedQuery', () => {
	beforeEach(() => {
		mapResultRowMock.mockClear();
		fillPlaceholdersMock.mockClear();
	});

	it('execute() returns raw result when fields are not provided', async () => {
		const client = new MockClient();
		client.results.push([{ affectedRows: 1 }]);
		const logger: Logger = { logQuery: vi.fn() };

		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'update users set token = ?',
			['x'],
			logger,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		const result = await query.execute();

		expect(result).toEqual([{ affectedRows: 1 }]);
		expect(client.queries).toHaveLength(1);
		expect(logger.logQuery).toHaveBeenCalledWith('update users set token = ?', ['x']);
	});

	it('execute() maps row results when fields are provided', async () => {
		const client = new MockClient();
		client.results.push([
			[1, 'a'],
			[2, 'b'],
		]);
		const logger: Logger = { logQuery: vi.fn() };
		const fields = [{ path: ['id'], field: users.id }] as unknown as SelectedFieldsOrdered;

		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select id, token from users',
			[],
			logger,
			undefined,
			undefined,
			undefined,
			fields,
		);

		const result = await query.execute();

		expect(mapResultRowMock).toHaveBeenCalledTimes(2);
		expect(result).toEqual([
			{ mapped: [1, 'a'] },
			{ mapped: [2, 'b'] },
		]);
	});

	it('execute() uses customResultMapper with row arrays', async () => {
		const client = new MockClient();
		client.results.push([
			[3, 'x'],
			[4, 'y'],
		]);
		const logger: Logger = { logQuery: vi.fn() };
		const customMapper = vi.fn((rows: unknown[][]) => rows.map((row) => row.join(':')));

		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select id, token from users',
			[],
			logger,
			undefined,
			undefined,
			undefined,
			undefined,
			customMapper,
		);

		const result = await query.execute();

		expect(customMapper).toHaveBeenCalledWith([
			[3, 'x'],
			[4, 'y'],
		]);
		expect(result).toEqual(['3:x', '4:y']);
	});

	it('execute() requests array rows when mapping selected fields', async () => {
		const client = new MockClient();
		client.results.push([[1, 'a']]);
		const fields = [{ path: ['id'], field: users.id }] as unknown as SelectedFieldsOrdered;

		await new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select id, token from users',
			[],
			new NoopLoggerForTests(),
			undefined,
			undefined,
			undefined,
			fields,
		).execute();

		expect(client.queries[0]?.options).toEqual({ rowMode: 'array' });
	});

	it('execute() keeps both values of a repeated column label (#183)', async () => {
		// SELECT users.id, users.name, posts.id, posts.name: labels repeat.
		const client = new LabelledRowsClient(
			['id', 'name', 'id', 'name'],
			[
				[1, 'alice', 10, 'first post'],
				[2, 'bob', null, null],
			],
		);
		const customMapper = vi.fn((rows: unknown[][]) => rows);

		const result = await new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select users.id, users.name, posts.id, posts.name from users left join posts on ...',
			[],
			new NoopLoggerForTests(),
			undefined,
			undefined,
			undefined,
			undefined,
			customMapper,
		).execute();

		expect(result).toEqual([
			[1, 'alice', 10, 'first post'],
			[2, 'bob', null, null],
		]);
	});

	it('execute() refuses object rows instead of guessing their column order', async () => {
		const client = new MockClient();
		client.results.push([{ id: 1, token: 'a' }]);
		const fields = [{ path: ['id'], field: users.id }] as unknown as SelectedFieldsOrdered;

		await expect(
			new CubridPreparedQuery<MySqlPreparedQueryConfig>(
				client,
				'select id, token from users',
				[],
				new NoopLoggerForTests(),
				undefined,
				undefined,
				undefined,
				fields,
			).execute(),
		).rejects.toThrow(/rowMode/);
	});

	// insert/update/delete report what they changed through cubrid-client's
	// execute(), which returns { affectedRows, lastInsertId? }; query() returns
	// [] for them (#182).
	function returningQuery(
		client: CubridQueryable,
		returningIds: SelectedFieldsOrdered,
		generatedIds: Record<string, unknown>[] | undefined,
		sqlText = 'insert into users (token) values (?)',
	) {
		return new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			sqlText,
			['a'],
			new NoopLoggerForTests(),
			undefined,
			{ type: 'insert', tables: ['users'] },
			undefined,
			undefined,
			undefined,
			generatedIds,
			returningIds,
		);
	}

	const idField = [{ path: ['id'], field: users.id }] as unknown as SelectedFieldsOrdered;
	const tokenField = [{ path: ['token'], field: users.token }] as unknown as SelectedFieldsOrdered;

	it.each(['insert', 'update', 'delete'] as const)(
		'execute() reports affectedRows for %s through client.execute()',
		async (type) => {
			const client = new ExecutingClient({ affectedRows: 3 });
			const result = (await new CubridPreparedQuery<MySqlPreparedQueryConfig>(
				client,
				`${type} statement`,
				[1],
				new NoopLoggerForTests(),
				undefined,
				{ type, tables: ['users'] },
				undefined,
				undefined,
			).execute()) as CubridRawQueryResult;

			expect(client.executed).toEqual([{ sql: `${type} statement`, params: [1] }]);
			expect(client.queries).toEqual([]);
			expect([...result]).toEqual([]);
			expect(result.affectedRows).toBe(3);
			expect(result.lastInsertId).toBeUndefined();
		},
	);

	it('execute() keeps a bigint lastInsertId', async () => {
		const client = new ExecutingClient({ affectedRows: 1, lastInsertId: 9007199254740993n });
		const result = (await new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'insert into users (token) values (?)',
			['a'],
			new NoopLoggerForTests(),
			undefined,
			{ type: 'insert', tables: ['users'] },
			undefined,
			undefined,
		).execute()) as CubridRawQueryResult;

		expect(result.lastInsertId).toBe(9007199254740993n);
	});

	it('execute() falls back to query() for writes when the client has no execute()', async () => {
		const client = new MockClient();
		client.results.push([]);
		const result = await new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'update users set token = ?',
			['x'],
			new NoopLoggerForTests(),
			undefined,
			{ type: 'update', tables: ['users'] },
			undefined,
			undefined,
		).execute();

		expect(client.queries).toHaveLength(1);
		expect(result).toEqual([]);
	});

	it('$returningId() reports the AUTO_INCREMENT key of a one-row insert', async () => {
		const client = new ExecutingClient({ affectedRows: 1, lastInsertId: 10 });

		const result = await returningQuery(client, idField, [{}]).execute();

		expect(result).toEqual([{ id: 10 }]);
	});

	it('$returningId() keeps a bigint AUTO_INCREMENT key', async () => {
		const client = new ExecutingClient({ affectedRows: 1, lastInsertId: 9007199254740993n });

		const result = await returningQuery(client, idField, [{}]).execute();

		expect(result).toEqual([{ id: 9007199254740993n }]);
	});

	it('$returningId() omits the key when the server generated none', async () => {
		// An INSERT that supplies the id itself generates no key.
		const client = new ExecutingClient({ affectedRows: 1 });

		const result = await returningQuery(client, idField, [{}]).execute();

		expect(result).toEqual([]);
	});

	it('$returningId() refuses AUTO_INCREMENT keys of a multi-row insert before sending it', async () => {
		// CUBRID reports only the first generated key and does not promise the
		// rest are consecutive, so they cannot be derived.
		const client = new ExecutingClient({ affectedRows: 2, lastInsertId: 20 });

		await expect(
			returningQuery(client, idField, [{}, {}], 'insert into users (token) values (?), (?)').execute(),
		).rejects.toThrow(/one row/);
		expect(client.executed).toEqual([]);
	});

	it('$returningId() returns $defaultFn keys of every inserted row', async () => {
		const client = new ExecutingClient({ affectedRows: 2 });

		const result = await returningQuery(
			client,
			tokenField,
			[{ token: 'gen-1' }, { token: 'gen-2' }],
			'insert into users (token) values (?), (?)',
		).execute();

		expect(result).toEqual([{ token: 'gen-1' }, { token: 'gen-2' }]);
	});

	it('$returningId() refuses a client without execute() before sending', async () => {
		const client = new MockClient();

		await expect(returningQuery(client, idField, [{}]).execute()).rejects.toThrow(/execute\(\)/);
		expect(client.queries).toEqual([]);
	});

	it('$returningId() reports no key when onDuplicateKeyUpdate() updated a row', async () => {
		// CUBRID reports affectedRows 2 and a consumed AUTO_INCREMENT value that
		// belongs to no row.
		const client = new ExecutingClient({ affectedRows: 2, lastInsertId: 7 });

		const result = await returningQuery(client, idField, [{}]).execute();

		expect(result).toEqual([]);
	});

	it("$returningId() converts the key to the column's mode", async () => {
		const wide = cubridTable('wide', {
			id: bigint('id', { mode: 'bigint' }).primaryKey().autoincrement(),
			small: bigint('small', { mode: 'number' }).primaryKey().autoincrement(),
		});
		const asBigint = [{ path: ['id'], field: wide.id }] as unknown as SelectedFieldsOrdered;
		const asNumber = [{ path: ['small'], field: wide.small }] as unknown as SelectedFieldsOrdered;

		expect(
			await returningQuery(new ExecutingClient({ affectedRows: 1, lastInsertId: 5 }), asBigint, [{}]).execute(),
		).toEqual([{ id: 5n }]);
		await expect(
			returningQuery(
				new ExecutingClient({ affectedRows: 1, lastInsertId: 9007199254740993n }),
				asNumber,
				[{}],
			).execute(),
		).rejects.toThrow(/mode: 'bigint'/);
	});

	it('$returningId() refuses INSERT ... SELECT before sending it', async () => {
		const client = new ExecutingClient({ affectedRows: 1, lastInsertId: 3 });

		await expect(returningQuery(client, idField, []).execute()).rejects.toThrow(/INSERT \.\.\. SELECT/);
		expect(client.executed).toEqual([]);
	});

	it('$returningId() skips returning fields that are not columns', async () => {
		const client = new ExecutingClient({ affectedRows: 1, lastInsertId: 5 });
		const fields = [{ path: ['id'], field: { name: 'id' } }] as unknown as SelectedFieldsOrdered;

		const result = await returningQuery(client, fields, [{}]).execute();

		expect(result).toEqual([]);
	});

	it('execute() fills placeholders before execution', async () => {
		const client = new MockClient();
		client.results.push([]);
		const logger: Logger = { logQuery: vi.fn() };

		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select * from users where id = ?',
			[sql.placeholder('id')],
			logger,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		await query.execute({ id: 42 });

		expect(fillPlaceholdersMock).toHaveBeenCalledTimes(1);
		expect(client.queries[0]?.params).toEqual([42]);
	});

	it('execute() returns empty array for empty select result', async () => {
		const client = new MockClient();
		client.results.push([]);
		const logger: Logger = { logQuery: vi.fn() };
		const fields = [{ path: ['id'], field: users.id }] as unknown as SelectedFieldsOrdered;

		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select id from users',
			[],
			logger,
			undefined,
			undefined,
			undefined,
			fields,
		);

		const result = await query.execute();

		expect(result).toEqual([]);
		expect(mapResultRowMock).not.toHaveBeenCalled();
	});

	it('iterator() throws unsupported streaming error', async () => {
		const client = new MockClient();
		const logger: Logger = { logQuery: vi.fn() };
		const query = new CubridPreparedQuery<MySqlPreparedQueryConfig>(
			client,
			'select 1',
			[],
			logger,
			undefined,
			undefined,
			undefined,
			undefined,
		);

		await expect(async () => {
			for await (const _row of query.iterator()) {
			}
		}).rejects.toThrow('Streaming is not supported by the CUBRID driver');
	});

	it('has CubridPreparedQuery entity kind', () => {
		expect(CubridPreparedQuery[entityKind]).toBe('CubridPreparedQuery');
	});
});

describe('CubridSession', () => {
	it('prepareQuery() returns CubridPreparedQuery instance', () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const prepared = session.prepareQuery<MySqlPreparedQueryConfig>(
			{ sql: 'select 1', params: [] },
			undefined,
		);

		expect(prepared).toBeInstanceOf(CubridPreparedQuery);
	});

	it('all() executes sql and logs query', async () => {
		const client = new MockClient();
		client.results.push([{ value: 7 }]);
		const dialect = new MySqlDialect({});
		const logger: Logger = { logQuery: vi.fn() };
		const session = new CubridSession(client, dialect, undefined, { mode: 'default', logger });

		const result = await session.all<{ value: number }>(sql`select ${7} as value`);

		expect(result).toEqual([{ value: 7 }]);
		expect(client.queries).toHaveLength(1);
		expect(client.queries[0]?.sql).toContain('select ? as value');
		expect(client.queries[0]?.params).toEqual([7]);
		expect(logger.logQuery).toHaveBeenCalledTimes(1);
	});

	it('transaction() without config executes begin and commit', async () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const result = await session.transaction(async (tx) => {
			await tx.execute(sql`select ${1}`);
			return 'ok';
		});

		expect(result).toBe('ok');
		expect(client.queries[0]?.sql.toLowerCase()).toContain('begin');
		expect(client.queries[1]?.sql.toLowerCase()).toContain('select ?');
		expect(client.queries[2]?.sql.toLowerCase()).toContain('commit');
	});

	it('transaction() with config executes set transaction and start transaction', async () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const config: MySqlTransactionConfig = {
			isolationLevel: 'read committed',
			accessMode: 'read write',
			withConsistentSnapshot: true,
		};

		await session.transaction(async () => 'ok', config);

		expect(client.queries[0]?.sql.toLowerCase()).toContain('set transaction');
		expect(client.queries[1]?.sql.toLowerCase()).toContain('start transaction');
		expect(client.queries[2]?.sql.toLowerCase()).toContain('commit');
	});

	it('transaction() rolls back and rethrows on error', async () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const expectedError = new Error('boom');

		await expect(
			session.transaction(async () => {
				throw expectedError;
			}),
		).rejects.toBe(expectedError);

		expect(client.queries[0]?.sql.toLowerCase()).toContain('begin');
		expect(client.queries[1]?.sql.toLowerCase()).toContain('rollback');
	});

	it('has CubridSession entity kind', () => {
		expect(CubridSession[entityKind]).toBe('CubridSession');
	});
});

describe('CubridSession with transactional client', () => {
	class TransactionalMockClient implements CubridQueryable {
		queries: { sql: string; params?: readonly unknown[] }[] = [];
		results: unknown[][] = [];
		beginCalls = 0;
		commitCalls = 0;
		rollbackCalls = 0;

		async query<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]> {
			this.queries.push({ sql: sqlText, params });
			return (this.results.shift() ?? []) as T[];
		}

		async queryPrepared<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]> {
			return this.query<T>(sqlText, params);
		}

		async beginTransaction(): Promise<void> {
			this.beginCalls++;
		}

		async commit(): Promise<void> {
			this.commitCalls++;
		}

		async rollback(): Promise<void> {
			this.rollbackCalls++;
		}
	}

	it('transaction() without config uses client.beginTransaction and client.commit', async () => {
		const client = new TransactionalMockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const result = await session.transaction(async (tx) => {
			await tx.execute(sql`select ${1}`);
			return 'done';
		});

		expect(result).toBe('done');
		expect(client.beginCalls).toBe(1);
		expect(client.commitCalls).toBe(1);
		expect(client.rollbackCalls).toBe(0);
		// Should NOT have sql begin/commit — uses native methods instead
		const lowerQueries = client.queries.map((q) => q.sql.toLowerCase());
		expect(lowerQueries).not.toContain('begin');
		expect(lowerQueries).not.toContain('commit');
	});

	it('transaction() with config uses client.beginTransaction after set transaction', async () => {
		const client = new TransactionalMockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const config: MySqlTransactionConfig = {
			isolationLevel: 'serializable',
		};

		await session.transaction(async () => 'ok', config);

		expect(client.beginCalls).toBe(1);
		expect(client.commitCalls).toBe(1);
		// set transaction should be executed via SQL before native beginTransaction
		expect(client.queries[0]?.sql.toLowerCase()).toContain('set transaction');
	});

	it('transaction() rolls back via client.rollback on error', async () => {
		const client = new TransactionalMockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const expectedError = new Error('tx-fail');

		await expect(
			session.transaction(async () => {
				throw expectedError;
			}),
		).rejects.toBe(expectedError);

		expect(client.beginCalls).toBe(1);
		expect(client.rollbackCalls).toBe(1);
		expect(client.commitCalls).toBe(0);
	});
});

describe('CubridTransaction', () => {
	it('nested transaction creates savepoints', async () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const rootTx = new CubridTransaction(
			dialect,
			session as unknown as MySqlSessionBase,
			undefined,
			0,
			'default',
		);

		const result = await rootTx.transaction(async (tx1) => {
			return tx1.transaction(async (tx2) => {
				return tx2.transaction(async () => 'ok');
			});
		});

		expect(result).toBe('ok');
		expect(client.queries[0]?.sql.toLowerCase()).toBe('savepoint sp1');
		expect(client.queries[1]?.sql.toLowerCase()).toBe('savepoint sp2');
		expect(client.queries[2]?.sql.toLowerCase()).toBe('savepoint sp3');
	});

	it('nested transaction rolls back to savepoint on error', async () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const rootTx = new CubridTransaction(
			dialect,
			session as unknown as MySqlSessionBase,
			undefined,
			0,
			'default',
		);
		const expectedError = new Error('nested-fail');

		await expect(
			rootTx.transaction(async () => {
				throw expectedError;
			}),
		).rejects.toBe(expectedError);

		expect(client.queries[0]?.sql.toLowerCase()).toBe('savepoint sp1');
		expect(client.queries[1]?.sql.toLowerCase()).toBe('rollback to savepoint sp1');
	});

	it('has CubridTransaction entity kind', () => {
		expect(CubridTransaction[entityKind]).toBe('CubridTransaction');
	});
});

// cubrid-client's `transaction(callback, options)` runs the callback on a
// connection it owns, so statements from unrelated requests cannot join the
// transaction (#185). This mock records which client each statement ran on.
class OwnedTransactionClient extends MockClient {
	readonly txClients: MockClient[] = [];
	readonly transactionOptions: unknown[] = [];
	commitError: Error | undefined;
	rollbackError: Error | undefined;

	async transaction<T>(
		callback: (tx: CubridQueryable) => Promise<T>,
		options?: unknown,
	): Promise<T> {
		const txClient = new MockClient();
		this.txClients.push(txClient);
		this.transactionOptions.push(options);
		let result: T;
		try {
			result = await callback(txClient);
		} catch (cause) {
			// Imitates only how cubrid-client reports a failed callback: a
			// TransactionError whose `cause` is the callback's error, with
			// `rollbackError` set when rolling back also failed.
			const wrapped = new Error('Transaction failed.', { cause }) as Error & {
				rollbackError?: Error;
			};
			if (this.rollbackError) {
				wrapped.rollbackError = this.rollbackError;
			}
			throw wrapped;
		}
		if (this.commitError) {
			throw this.commitError;
		}
		return result;
	}

	beginTransaction = vi.fn(async () => {});
	commit = vi.fn(async () => {});
	rollback = vi.fn(async () => {});
}

describe('CubridSession with a driver that owns transaction connections', () => {
	const dialect = new MySqlDialect({});

	it('runs every callback statement on the owned transaction client', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const result = await session.transaction(async (tx) => {
			await tx.execute(sql`insert into users (id) values (1)`);
			await tx.transaction(async (nested) => {
				await nested.execute(sql`insert into users (id) values (2)`);
			});
			return 'done';
		});

		expect(result).toBe('done');
		expect(client.queries).toEqual([]);
		expect(client.beginTransaction).not.toHaveBeenCalled();
		expect(client.commit).not.toHaveBeenCalled();
		expect(client.txClients).toHaveLength(1);
		expect(client.txClients[0]?.queries.map((q) => q.sql.toLowerCase())).toEqual([
			'insert into users (id) values (1)',
			'savepoint sp1',
			'insert into users (id) values (2)',
		]);
	});

	it('keeps statements outside the callback off the transaction connection', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		let release!: () => void;
		const inside = new Promise<void>((resolve) => {
			release = resolve;
		});

		const pending = session.transaction(async (tx) => {
			await tx.execute(sql`insert into users (id) values (1)`);
			await inside;
		});
		await session.all(sql`insert into users (id) values (99)`);
		release();
		await pending;

		expect(client.queries.map((q) => q.sql.toLowerCase())).toEqual([
			'insert into users (id) values (99)',
		]);
		expect(client.txClients[0]?.queries.map((q) => q.sql.toLowerCase())).toEqual([
			'insert into users (id) values (1)',
		]);
	});

	it('gives concurrent transactions separate connections', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await Promise.all([
			session.transaction(async (tx) => tx.execute(sql`select 1`)),
			session.transaction(async (tx) => tx.execute(sql`select 2`)),
		]);

		expect(client.txClients).toHaveLength(2);
		expect(client.txClients[0]).not.toBe(client.txClients[1]);
	});

	it('passes a supported isolation level to the driver', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await session.transaction(async () => 'ok', { isolationLevel: 'serializable' });
		await session.transaction(async () => 'ok');

		expect(client.transactionOptions).toEqual([{ isolationLevel: 'serializable' }, undefined]);
		expect(client.txClients[0]?.queries).toEqual([]);
	});

	it.each<[string, MySqlTransactionConfig]>([
		['read uncommitted isolation', { isolationLevel: 'read uncommitted' }],
		['an access mode', { accessMode: 'read only' }],
		['a consistent snapshot', { withConsistentSnapshot: true }],
	])('refuses %s before opening a transaction', async (_name, config) => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(session.transaction(async () => 'ok', config)).rejects.toThrow(/CUBRID/);
		expect(client.txClients).toHaveLength(0);
	});

	it('propagates the callback error and runs no manual rollback', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const failure = new Error('callback failed');

		await expect(
			session.transaction(async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(client.rollback).not.toHaveBeenCalled();
	});

	it('rethrows Drizzle rollback signals unchanged', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(
			session.transaction(async (tx) => {
				tx.rollback();
			}),
		).rejects.toBeInstanceOf(TransactionRollbackError);
	});

	it('attaches a failed driver rollback to the callback error', async () => {
		const client = new OwnedTransactionClient();
		client.rollbackError = new Error('rollback failed');
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const failure = new Error('callback failed');

		const error = await session
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e);

		expect(error).toBe(failure);
		expect((error as Error & { rollbackError?: unknown }).rollbackError).toBe(client.rollbackError);
	});

	it('opens a default transaction when the config sets no isolation level', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		// Drizzle's type requires isolationLevel, but JavaScript callers can omit it.
		await session.transaction(async () => 'ok', {} as MySqlTransactionConfig);

		expect(client.transactionOptions).toEqual([undefined]);
	});

	it('rethrows the callback error as is when the driver does not wrap it', async () => {
		const client = new OwnedTransactionClient();
		client.transaction = async <T>(callback: (tx: CubridQueryable) => Promise<T>): Promise<T> =>
			callback(new MockClient());
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const failure = new Error('callback failed');

		const error = await session
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e);

		expect(error).toBe(failure);
		expect(error).not.toHaveProperty('rollbackError');
	});

	it('rethrows a non-Error callback value without touching it', async () => {
		const client = new OwnedTransactionClient();
		client.rollbackError = new Error('rollback failed');
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(
			session.transaction(async () => {
				throw 'plain string';
			}),
		).rejects.toBe('plain string');
	});

	it('keeps an existing rollbackError on the callback error', async () => {
		const client = new OwnedTransactionClient();
		client.rollbackError = new Error('outer rollback failed');
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const inner = new Error('inner rollback failed');
		const failure = Object.assign(new Error('callback failed'), { rollbackError: inner });

		const error = await session
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e);

		expect((error as Error & { rollbackError?: unknown }).rollbackError).toBe(inner);
	});

	it('refuses isolationLevel when the driver transaction() takes no options', async () => {
		const client = new OwnedTransactionClient();
		// cubrid-client before 1.3.0: transaction(callback) only.
		client.transaction = async function <T>(callback: (tx: CubridQueryable) => Promise<T>) {
			return callback(new MockClient());
		};
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(
			session.transaction(async () => 'ok', { isolationLevel: 'serializable' }),
		).rejects.toThrow(/1\.3\.0/);
		await expect(session.transaction(async () => 'ok')).resolves.toBe('ok');
	});

	it('keeps the driver error on the callback error as transactionError', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const failure = new Error('callback failed');

		const error = (await session
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e)) as Error & { transactionError?: Error };

		expect(error).toBe(failure);
		expect(error.transactionError?.message).toBe('Transaction failed.');
		expect(error.transactionError?.cause).toBe(failure);
		expect(Object.keys(error)).toContain('transactionError');
	});

	it('leaves a frozen callback error as is', async () => {
		const client = new OwnedTransactionClient();
		client.rollbackError = new Error('rollback failed');
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const failure = Object.freeze(new Error('frozen'));

		await expect(
			session.transaction(async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});

	it('rethrows a driver failure that happens before the callback runs', async () => {
		const client = new OwnedTransactionClient();
		const closed = new Error('Client is closed.');
		client.transaction = async () => {
			throw closed;
		};
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(session.transaction(async () => 'ok')).rejects.toBe(closed);
	});

	it('commits when the callback handles its own statement error', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		const result = await session.transaction(async (tx) => {
			await tx.execute(sql`select 1`).then(() => {
				throw new Error('handled');
			}).catch(() => undefined);
			return 'committed';
		});

		expect(result).toBe('committed');
	});

	it('sends ROLLBACK TO SAVEPOINT on the owned connection', async () => {
		const client = new OwnedTransactionClient();
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await session.transaction(async (tx) => {
			await tx
				.transaction(async () => {
					throw new Error('inner');
				})
				.catch(() => undefined);
		});

		expect(client.queries).toEqual([]);
		expect(client.txClients[0]?.queries.map((q) => q.sql.toLowerCase())).toEqual([
			'savepoint sp1',
			'rollback to savepoint sp1',
		]);
	});

	it('propagates a commit failure from the driver', async () => {
		const client = new OwnedTransactionClient();
		client.commitError = new Error('commit failed');
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });

		await expect(session.transaction(async () => 'ok')).rejects.toBe(client.commitError);
	});
});

describe('CubridTransaction savepoint rollback failure', () => {
	it('keeps the callback error and attaches the rollback error', async () => {
		const client = new MockClient();
		const rollbackFailure = new Error('rollback to savepoint failed');
		const query = client.query.bind(client);
		client.query = (async (sqlText: string, params?: readonly unknown[]) => {
			if (sqlText.toLowerCase().startsWith('rollback to savepoint')) {
				throw rollbackFailure;
			}
			return query(sqlText, params);
		}) as typeof client.query;
		const dialect = new MySqlDialect({});
		const session = new CubridSession(client, dialect, undefined, { mode: 'default' });
		const rootTx = new CubridTransaction(
			dialect,
			session as unknown as MySqlSessionBase,
			undefined,
			0,
			'default',
		);
		const callbackFailure = new Error('nested-fail');

		const error = await rootTx
			.transaction(async () => {
				throw callbackFailure;
			})
			.catch((e: unknown) => e);

		expect(error).toBe(callbackFailure);
		expect((error as Error & { rollbackError?: unknown }).rollbackError).toBe(rollbackFailure);
	});
});
