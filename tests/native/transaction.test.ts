// Native transactions (#161) with a fake client: the driver's transaction()
// is used, statements go to its transaction client, savepoint SQL order,
// nested rollback, tx.rollback(), config refusals, use-after-finish and which
// error wins.
import { TransactionRollbackError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
	type CubridNativeClient,
	CubridSession,
	CubridTransaction,
	type CubridTransactionConfig,
	CubridTransactionRollbackError,
	cubridTable,
	datetime,
	drizzle,
	integer,
} from '../../src/native/index';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const t = cubridTable('t', { id: integer().primaryKey(), at: datetime() });

type Call = { on: string; method: string; sql: string; params?: readonly unknown[]; options?: unknown };

class DriverTransactionError extends Error {
	rollbackError?: Error;
	outcomeUnknown?: boolean;
}

interface FakeOptions {
	/** Makes the driver's commit fail with this error. */
	commitError?: Error;
	/** Makes the driver's rollback fail with this error. */
	rollbackError?: Error;
	/** SQL texts that fail. */
	failing?: Record<string, Error>;
	timezone?: string;
}

/** A cubrid-client stand-in whose transaction() runs the callback on a separate recorded client. */
function fakeClient(options: FakeOptions = {}) {
	const calls: Call[] = [];
	const transactions: unknown[] = [];
	let txCount = 0;
	const methods = (on: string) => {
		const respond =
			(method: string) =>
			async (sql: string, params?: readonly unknown[], opts?: unknown): Promise<never> => {
				calls.push(opts === undefined ? { on, method, sql, params } : { on, method, sql, params, options: opts });
				const failure = options.failing?.[sql];
				if (failure) throw failure;
				return (method.startsWith('execute') ? { affectedRows: 1 } : []) as never;
			};
		return {
			query: respond('query'),
			queryPrepared: respond('queryPrepared'),
			execute: respond('execute'),
			executePrepared: respond('executePrepared'),
		};
	};
	const client = {
		...methods('client'),
		timezone: options.timezone ?? 'utc',
		calls,
		transactions,
		async transaction<T>(callback: (tx: ReturnType<typeof methods>) => Promise<T>, txOptions?: unknown): Promise<T> {
			transactions.push(txOptions);
			const on = `tx${++txCount}`;
			calls.push({ on, method: 'begin', sql: 'BEGIN', options: txOptions });
			let result: T;
			try {
				result = await callback(methods(on));
			} catch (error) {
				calls.push({ on, method: 'rollback', sql: 'ROLLBACK' });
				const wrapped = new DriverTransactionError('Transaction failed.', { cause: error });
				if (options.rollbackError) wrapped.rollbackError = options.rollbackError;
				throw wrapped;
			}
			calls.push({ on, method: 'commit', sql: 'COMMIT' });
			if (options.commitError) throw options.commitError;
			return result;
		},
	};
	return client;
}

const sqlOf = (calls: Call[]) => calls.map((c) => `${c.on}: ${c.sql}`);

describe('db.transaction()', () => {
	it("runs every statement on the driver's transaction client and returns the callback's value", async () => {
		const client = fakeClient();
		const db = drizzle(client);
		const result = await db.transaction(async (tx) => {
			expect(tx).toBeInstanceOf(CubridTransaction);
			await tx.insert(t).values({ id: 1 });
			await tx.select({ id: t.id }).from(t);
			await tx.update(t).set({ id: 2 }).where(undefined);
			await tx.delete(t);
			await tx.execute('SELECT 1');
			return 'value';
		});
		expect(result).toBe('value');
		expect(client.transactions).toEqual([undefined]);
		expect(sqlOf(client.calls)).toEqual([
			'tx1: BEGIN',
			'tx1: insert into "t" ("id", "at") values (?, default)',
			'tx1: select "t"."id" from "t"',
			'tx1: update "t" set "id" = ?',
			'tx1: delete from "t"',
			'tx1: SELECT 1',
			'tx1: COMMIT',
		]);
	});

	it('keeps the binding mode of the database', async () => {
		const client = fakeClient();
		await drizzle(client, { binding: 'literal' }).transaction(async (tx) => {
			await tx.insert(t).values({ id: 1 });
			await tx.select({ id: t.id }).from(t);
		});
		expect(client.calls.filter((c) => c.on === 'tx1').map((c) => c.method)).toEqual([
			'begin',
			'execute',
			'query',
			'commit',
		]);
	});

	it('logs statements of the transaction', async () => {
		const logged: string[] = [];
		const client = fakeClient();
		await drizzle(client, { logger: { logQuery: (q) => logged.push(q) } }).transaction(async (tx) => {
			await tx.execute('SELECT 1');
			await tx.transaction(async () => undefined);
		});
		expect(logged).toEqual(['SELECT 1', 'savepoint "sp1"']);
	});

	it('checks date and time reads against the zone of the client that started the transaction', async () => {
		// The transaction client declares no zone; the outer client says UTC.
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			await tx.select({ at: t.at }).from(t);
		});
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: select "t"."at" from "t"', 'tx1: COMMIT']);

		const local = fakeClient({ timezone: 'local' });
		const previous = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			await expect(
				drizzle(local).transaction(async (tx) => {
					await tx.select({ at: t.at }).from(t);
				}),
			).rejects.toThrow(/UTC wall clock/);
		} finally {
			env.TZ = previous;
		}
		expect(sqlOf(local.calls)).toEqual(['tx1: BEGIN', 'tx1: ROLLBACK']);
	});

	it('passes a supported isolation level to the driver', async () => {
		for (const isolationLevel of ['read committed', 'repeatable read', 'serializable'] as const) {
			const client = fakeClient();
			await drizzle(client).transaction(async () => undefined, { isolationLevel });
			expect(client.transactions).toEqual([{ isolationLevel }]);
		}
		const client = fakeClient();
		await drizzle(client).transaction(async () => undefined, {});
		expect(client.transactions).toEqual([undefined]);
	});

	it.each([
		[{ isolationLevel: 'read uncommitted' }, "CUBRID does not support isolation level 'read uncommitted'"],
		[{ isolationLevel: 'snapshot' }, "CUBRID does not support isolation level 'snapshot'"],
		[{ accessMode: 'read only' }, 'CUBRID transactions do not support accessMode'],
		[{ withConsistentSnapshot: true }, 'CUBRID transactions do not support withConsistentSnapshot'],
		[{ lockTimeout: 5 }, "Unknown transaction option 'lockTimeout'"],
		[null, 'The transaction config must be an object'],
		[{ isolationLevel: 4 }, 'CUBRID does not support isolation level number'],
	])('refuses %j before anything is sent', async (config, message) => {
		const client = fakeClient();
		let ran = false;
		const db = drizzle(client);
		// Refused configs are outside the declared type.
		const pending = db.transaction(async () => {
			ran = true;
		}, config as CubridTransactionConfig);
		await expect(pending).rejects.toThrow(message);
		expect(ran).toBe(false);
		expect(client.calls).toEqual([]);
	});

	it('refuses a client without transaction() instead of BEGIN/COMMIT on a shared connection', async () => {
		const { transaction: _, ...rest } = fakeClient();
		await expect(drizzle(rest).transaction(async () => undefined)).rejects.toThrow(
			/needs a client or pool with transaction\(\)/,
		);
		expect(rest.calls).toEqual([]);
	});

	it('refuses an isolation level when transaction() declares no options parameter', async () => {
		const client = fakeClient();
		const legacy = {
			...client,
			transaction: <T>(callback: (tx: CubridNativeClient) => Promise<T>) => client.transaction(callback),
		};
		await expect(
			drizzle(legacy).transaction(async () => undefined, { isolationLevel: 'serializable' }),
		).rejects.toThrow(/declares an options parameter/);
		await expect(drizzle(legacy).transaction(async () => 'ok')).resolves.toBe('ok');
	});
});

describe('errors', () => {
	it("rejects with the callback's own error and keeps the driver's as transactionError", async () => {
		const client = fakeClient();
		const failure = new Error('boom');
		const error = await drizzle(client)
			.transaction(async (tx) => {
				await tx.execute('SELECT 1');
				throw failure;
			})
			.catch((e: unknown) => e);
		expect(error).toBe(failure);
		expect((error as { transactionError: Error }).transactionError).toBeInstanceOf(DriverTransactionError);
		expect('rollbackError' in failure).toBe(false);
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: SELECT 1', 'tx1: ROLLBACK']);
	});

	it('attaches a failed rollback as rollbackError without replacing the error', async () => {
		const rollbackError = new Error('rollback failed');
		const failure = new Error('boom');
		const error = await drizzle(fakeClient({ rollbackError }))
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e);
		expect(error).toBe(failure);
		expect((error as { rollbackError: Error }).rollbackError).toBe(rollbackError);
	});

	it('keeps a property the error already has and leaves non-errors alone', async () => {
		const failure = Object.assign(new Error('boom'), { rollbackError: 'mine' });
		const error = await drizzle(fakeClient({ rollbackError: new Error('x') }))
			.transaction(async () => {
				throw failure;
			})
			.catch((e: unknown) => e);
		expect((error as { rollbackError: unknown }).rollbackError).toBe('mine');
		await expect(
			drizzle(fakeClient()).transaction(async () => {
				throw 'text';
			}),
		).rejects.toBe('text');
		const frozen = Object.freeze(new Error('frozen'));
		await expect(
			drizzle(fakeClient()).transaction(async () => {
				throw frozen;
			}),
		).rejects.toBe(frozen);
	});

	it('passes a commit failure (outcome unknown) through unchanged', async () => {
		const commitError = Object.assign(new DriverTransactionError('Failed to commit.'), { outcomeUnknown: true });
		await expect(drizzle(fakeClient({ commitError })).transaction(async () => 'value')).rejects.toBe(commitError);
	});

	it('passes through a driver error that is the callback error itself', async () => {
		const failure = new Error('same');
		const client = {
			...fakeClient(),
			async transaction<T>(callback: (tx: never) => Promise<T>): Promise<T> {
				return callback(fakeClient() as never);
			},
		};
		await expect(
			drizzle(client).transaction(async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});
});

describe('tx.rollback()', () => {
	it('rejects transaction() with CubridTransactionRollbackError, a TransactionRollbackError', async () => {
		const client = fakeClient();
		const error = await drizzle(client)
			.transaction(async (tx) => {
				await tx.execute('SELECT 1');
				tx.rollback();
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CubridTransactionRollbackError);
		expect(error).toBeInstanceOf(TransactionRollbackError);
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: SELECT 1', 'tx1: ROLLBACK']);
	});

	it('in a nested transaction rolls back to its savepoint only', async () => {
		const client = fakeClient();
		const result = await drizzle(client).transaction(async (tx) => {
			const inner = await tx
				.transaction(async (nested) => {
					await nested.execute('INSERT 2');
					nested.rollback();
				})
				.catch((e: unknown) => e);
			expect(inner).toBeInstanceOf(CubridTransactionRollbackError);
			return 'outer';
		});
		expect(result).toBe('outer');
		expect(sqlOf(client.calls)).toEqual([
			'tx1: BEGIN',
			'tx1: savepoint "sp1"',
			'tx1: INSERT 2',
			'tx1: rollback to savepoint "sp1"',
			'tx1: COMMIT',
		]);
	});
});

describe('nested transactions', () => {
	it('use SAVEPOINT "spN" by depth and roll back to it on failure, without RELEASE', async () => {
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			await tx.execute('INSERT 1');
			const value = await tx.transaction(async (one) => {
				await one.execute('INSERT 2');
				await one
					.transaction(async (two) => {
						await two.execute('INSERT 3');
						throw new Error('inner');
					})
					.catch(() => undefined);
				return 'one';
			});
			expect(value).toBe('one');
			await tx.transaction(async (again) => {
				await again.execute('INSERT 4');
			});
		});
		expect(sqlOf(client.calls)).toEqual([
			'tx1: BEGIN',
			'tx1: INSERT 1',
			'tx1: savepoint "sp1"',
			'tx1: INSERT 2',
			'tx1: savepoint "sp2"',
			'tx1: INSERT 3',
			'tx1: rollback to savepoint "sp2"',
			'tx1: savepoint "sp1"',
			'tx1: INSERT 4',
			'tx1: COMMIT',
		]);
	});

	it('rethrow the failure, which rolls back the whole transaction when not caught', async () => {
		const client = fakeClient();
		const failure = new Error('inner');
		const error = await drizzle(client)
			.transaction(async (tx) => {
				await tx.transaction(async () => {
					throw failure;
				});
			})
			.catch((e: unknown) => e);
		expect(error).toBe(failure);
		expect(sqlOf(client.calls)).toEqual([
			'tx1: BEGIN',
			'tx1: savepoint "sp1"',
			'tx1: rollback to savepoint "sp1"',
			'tx1: ROLLBACK',
		]);
	});

	it('attach a failed ROLLBACK TO SAVEPOINT as rollbackError and keep the error', async () => {
		const rollbackError = new Error('-550');
		const client = fakeClient({ failing: { 'rollback to savepoint "sp1"': rollbackError } });
		const failure = new Error('inner');
		await drizzle(client).transaction(async (tx) => {
			const error = await tx
				.transaction(async () => {
					throw failure;
				})
				.catch((e: unknown) => e);
			expect(error).toBe(failure);
			expect((error as { rollbackError: Error }).rollbackError).toBe(rollbackError);
		});
	});

	it('reject when SAVEPOINT fails, without running the callback', async () => {
		const savepointError = new Error('savepoint failed');
		const client = fakeClient({ failing: { 'savepoint "sp1"': savepointError } });
		let ran = false;
		await drizzle(client).transaction(async (tx) => {
			await expect(
				tx.transaction(async () => {
					ran = true;
				}),
			).rejects.toBe(savepointError);
			// The level is free again.
			await expect(tx.transaction(async () => 'next')).rejects.toBe(savepointError);
		});
		expect(ran).toBe(false);
	});

	it('need a transaction session', async () => {
		await expect(new CubridSession(fakeClient()).savepoint(async () => undefined)).rejects.toThrow(
			/savepoint needs a transaction/,
		);
	});

	it('refuse a config', async () => {
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			await expect(tx.transaction(async () => undefined, { isolationLevel: 'serializable' })).rejects.toThrow(
				/nested transaction takes no config/,
			);
		});
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: COMMIT']);
	});

	it('refuse a second nested transaction of the same level while one runs', async () => {
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const first = tx.transaction(() => gate);
			await expect(tx.transaction(async () => undefined)).rejects.toThrow(/cannot run at the same time/);
			release();
			await first;
			await tx.transaction(async () => undefined);
		});
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: savepoint "sp1"', 'tx1: savepoint "sp1"', 'tx1: COMMIT']);
	});
});

describe('use after the callback settled', () => {
	it('refuses every statement of tx, its prepared queries and transaction() before anything is sent', async () => {
		const client = fakeClient();
		let kept!: CubridTransaction;
		let prepared!: { execute(): Promise<unknown> };
		await drizzle(client).transaction(async (tx) => {
			kept = tx;
			prepared = tx.select({ id: t.id }).from(t).prepare();
		});
		const sent = client.calls.length;
		const message = /This transaction has ended/;
		await expect(kept.select({ id: t.id }).from(t)).rejects.toThrow(message);
		await expect(kept.insert(t).values({ id: 1 })).rejects.toThrow(message);
		await expect(kept.update(t).set({ id: 1 })).rejects.toThrow(message);
		await expect(kept.delete(t)).rejects.toThrow(message);
		await expect(kept.execute('SELECT 1')).rejects.toThrow(message);
		await expect(prepared.execute()).rejects.toThrow(message);
		await expect(kept.transaction(async () => undefined)).rejects.toThrow(message);
		expect(() => kept.rollback()).toThrow(message);
		expect(client.calls.length).toBe(sent);
	});

	it('refuses a nested tx after its own callback, while the outer one goes on', async () => {
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			let nestedTx!: CubridTransaction;
			await tx.transaction(async (nested) => {
				nestedTx = nested;
			});
			await expect(nestedTx.execute('SELECT 1')).rejects.toThrow(/nested transaction \(savepoint sp1\) has ended/);
			await tx.execute('SELECT 2');
		});
		expect(sqlOf(client.calls)).toEqual(['tx1: BEGIN', 'tx1: savepoint "sp1"', 'tx1: SELECT 2', 'tx1: COMMIT']);
	});

	it('refuses a nested tx whose outer transaction ended', async () => {
		const client = fakeClient();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pending!: Promise<unknown>;
		await drizzle(client).transaction(async (tx) => {
			pending = tx
				.transaction(async (nested) => {
					await gate;
					await nested.execute('SELECT late');
				})
				.catch((e: unknown) => e);
		});
		release();
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/nested transaction \(savepoint sp1\) has ended/);
		// Its ROLLBACK TO SAVEPOINT was refused too, and attached.
		expect((error as { rollbackError: Error }).rollbackError.message).toMatch(/This transaction has ended/);
		expect(client.calls.some((c) => c.sql === 'SELECT late')).toBe(false);
	});
});

describe('concurrent statements in one transaction', () => {
	it('all go to the transaction client', async () => {
		const client = fakeClient();
		await drizzle(client).transaction(async (tx) => {
			await Promise.all([1, 2, 3].map((id) => tx.insert(t).values({ id })));
		});
		expect(client.calls.filter((c) => c.method === 'executePrepared').map((c) => c.on)).toEqual(['tx1', 'tx1', 'tx1']);
	});
});
