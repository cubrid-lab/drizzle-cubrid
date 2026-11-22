// Fault-injection tests against a real CUBRID server (#164): lost
// connections, server and broker restarts, failed commits, lock waits,
// deadlocks and network stalls. Each test checks what the caller sees, then
// what the database holds, read through a connection opened for that check.
//
// They restart, pause and kill parts of the server, so they never run in the
// shared live suite: `npm run integration:faults` runs them alone.
//
// Configure with CUBRID_TEST_HOST (required), CUBRID_TEST_PORT (33000),
// CUBRID_TEST_DATABASE (testdb), CUBRID_TEST_USER (dba), CUBRID_TEST_PASSWORD
// (empty) and CUBRID_TEST_CONTAINER (required: the name or id of the Docker
// container running that server, for the tests that restart, pause or kill
// it). A missing setting or Docker CLI fails the run instead of skipping it.
//
// Most faults go through FaultProxy (tests/support/fault-proxy.ts), a TCP
// proxy that cuts or stalls connections at an exact request without touching
// the server; Docker is used only where the server itself has to fail.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
	type CubridPool,
	createClient,
	createPool,
	DeadlockError,
	LockTimeoutError,
	type PoolOptions,
	ReadTimeoutError,
} from 'cubrid-client';
import { eq, relations } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { int as legacyInt } from '../src/columns';
import { drizzle as legacyDrizzle } from '../src/driver';
import { createTableSql } from '../src/native/ddl';
import * as native from '../src/native/index';
import { cubridTable as legacyTable } from '../src/table';
import { CAS_FUNCTION, FaultProxy, isCommit, type RequestMatcher } from './support/fault-proxy';

const host = process.env.CUBRID_TEST_HOST;
if (!host) {
	throw new Error('CUBRID_TEST_HOST is not set; the CUBRID fault tests need a server and never skip');
}
const containerName = process.env.CUBRID_TEST_CONTAINER;
if (!containerName) {
	throw new Error(
		'CUBRID_TEST_CONTAINER is not set; the CUBRID fault tests restart, pause and kill the server in that Docker container and never skip',
	);
}
const container: string = containerName;
try {
	const state = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', container], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
	if (state !== 'true') throw new Error(`Docker container ${container} is not running`);
} catch (error) {
	throw new Error(`The CUBRID fault tests need the Docker CLI and a running container ${container}`, { cause: error });
}

const execFileAsync = promisify(execFile);

/** Runs the Docker CLI without blocking the event loop, so client timers stay accurate. */
async function docker(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('docker', args, { encoding: 'utf8' });
	return stdout.trim();
}

/** Runs a shell command in the CUBRID container as the cubrid user, with its environment. */
function asCubrid(command: string): Promise<string> {
	return docker('exec', '-u', 'cubrid', container, 'bash', '-lc', command);
}

const config = {
	host,
	port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
	database: process.env.CUBRID_TEST_DATABASE ?? 'testdb',
	user: process.env.CUBRID_TEST_USER ?? 'dba',
	password: process.env.CUBRID_TEST_PASSWORD ?? '',
	connectionTimeout: 5000,
	timezone: 'utc' as const,
};

if (!/^[A-Za-z0-9_]+$/.test(config.database)) {
	throw new Error(`CUBRID_TEST_DATABASE must be a plain database name, not ${JSON.stringify(config.database)}`);
}

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const items = native.cubridTable(`ft_items_${run}`, {
	id: native.integer().primaryKey(),
	label: native.varchar({ length: 20 }),
});
// The same table through the 0.x API.
const legacyItems = legacyTable(`ft_items_${run}`, { id: legacyInt('id').primaryKey() });
const users = native.cubridTable(`ft_users_${run}`, { id: native.integer().primaryKey() });
const posts = native.cubridTable(`ft_posts_${run}`, {
	id: native.integer().primaryKey(),
	authorId: native.integer('author_id').notNull(),
});
const schema = {
	users,
	posts,
	usersRelations: relations(users, ({ many }) => ({ posts: many(posts) })),
	postsRelations: relations(posts, ({ one }) => ({
		author: one(users, { fields: [posts.authorId], references: [users.id] }),
	})),
};
const tables = [items, users, posts];
const quoted = (table: (typeof tables)[number]) => `"${native.getTableConfig(table).name}"`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `sql` on a connection opened for it and closed afterwards, straight to
 * the server: it shares nothing with the connections under test.
 */
async function fresh<T = Record<string, unknown>>(sql: string): Promise<T[]> {
	const client = createClient(config);
	try {
		return await client.query<T & Record<string, unknown>>(sql);
	} finally {
		await client.close().catch(() => undefined);
	}
}

/** The rows of the items table, as a fresh connection sees them. */
async function persisted(): Promise<Array<{ id: number; label: string | null }>> {
	return fresh<{ id: number; label: string | null }>(`SELECT id, label FROM ${quoted(items)} ORDER BY id`);
}

async function resetItems(...rows: Array<[number, string]>): Promise<void> {
	await fresh(`DELETE FROM ${quoted(items)}`);
	for (const [id, label] of rows) await fresh(`INSERT INTO ${quoted(items)} VALUES (${id}, '${label}')`);
}

/** Waits until a fresh connection can query the server again, after a restart. */
async function serverUp(started: number): Promise<number> {
	for (;;) {
		try {
			await fresh('SELECT 1 FROM db_root');
			return Date.now() - started;
		} catch (error) {
			if (Date.now() - started > 90_000) throw error;
			await sleep(500);
		}
	}
}

/** Restarts the database server process (the broker keeps running) and waits until it serves again. */
async function restartServer(): Promise<number> {
	const started = Date.now();
	await asCubrid(`cubrid server restart ${config.database}`);
	return serverUp(started);
}

/** Restarts the brokers, which closes every client connection, and waits until they serve again. */
async function restartBroker(): Promise<number> {
	const started = Date.now();
	await asCubrid('cubrid broker restart');
	return serverUp(started);
}

/** The settled outcome of `promise` and how long it took, so a test can assert on a rejection and go on. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
	const started = Date.now();
	try {
		return { value: await promise, ms: Date.now() - started };
	} catch (error) {
		return { error, ms: Date.now() - started };
	}
}

/** Class, kind, code and outcome of an error and of its cause, for the run log. */
function shape(error: unknown): Record<string, unknown> {
	const describe = (e: unknown) => {
		const { name, kind, code, outcomeUnknown, message } = (e ?? {}) as Record<string, unknown>;
		return { name, kind, code, outcomeUnknown, message };
	};
	const cause = (error as { cause?: unknown } | undefined)?.cause;
	return { ...describe(error), cause: cause === undefined ? undefined : describe(cause) };
}

/** Records an observation in the run log, as evidence of what each fault did. */
function log(label: string, value: unknown): void {
	console.log(`[fault] ${label}: ${JSON.stringify(value)}`);
}

/** Waits for a proxy fault to fire, failing clearly instead of hanging until the test timeout. */
async function firedWithin(fired: Promise<void> | undefined, what: string, ms = 5000): Promise<void> {
	if (fired === undefined) throw new Error(`The ${what} fault was never armed`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			fired,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`The ${what} fault did not fire within ${ms} ms: the proxy never saw that request`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const gate = () => {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, opened };
};

/** A CAS request that runs a statement. */
const isStatement: RequestMatcher = (payload) =>
	payload[0] === CAS_FUNCTION.EXECUTE || payload[0] === CAS_FUNCTION.PREPARE_AND_EXECUTE;

let proxy: FaultProxy;
const pools: CubridPool[] = [];

/** A pool whose connections go through the fault proxy; closed after the test. */
function proxiedPool(options: Partial<PoolOptions> = {}): CubridPool {
	const pool = createPool({ ...config, host: '127.0.0.1', port: proxy.port, max: 2, ...options });
	pools.push(pool);
	return pool;
}

/** A pool straight to the server; closed after the test. */
function directPool(options: Partial<PoolOptions> = {}): CubridPool {
	const pool = createPool({ ...config, max: 2, ...options });
	pools.push(pool);
	return pool;
}

/**
 * Checks that a pool recovered: it answers, holds no connection after the
 * statement settled, has nobody waiting, and (through the proxy) keeps no
 * socket it does not count.
 */
async function expectRecovered(pool: CubridPool, proxied: boolean): Promise<void> {
	expect(await pool.query('SELECT 1 AS ok FROM db_root')).toEqual([{ ok: 1 }]);
	await vi.waitFor(() => {
		const stats = pool.stats();
		expect(stats).toMatchObject({ active: 0, pending: 0, waiting: 0 });
		if (proxied) expect(proxy.active).toBe(stats.total);
	});
}

beforeAll(async () => {
	const [row] = await fresh<{ v: string }>('SELECT version() AS v');
	console.log(`CUBRID server version: ${row?.v}`);
	const expected = process.env.CUBRID_TEST_EXPECT_VERSION;
	if (expected && !row?.v.startsWith(expected)) {
		throw new Error(`CUBRID server version ${row?.v} does not start with CUBRID_TEST_EXPECT_VERSION=${expected}`);
	}
	for (const table of tables) await fresh(createTableSql(table));
	proxy = await FaultProxy.start({ host: config.host, port: config.port });
}, 120_000);

afterEach(async () => {
	// A failed test must not leave a fault armed for the next one.
	proxy.clearFaults();
	proxy.resume();
	proxy.refuse(false);
	for (const pool of pools.splice(0)) await pool.close().catch(() => undefined);
	// A closed pool leaves no connection open through the proxy.
	await vi.waitFor(() => expect(proxy.active).toBe(0));
});

afterAll(async () => {
	await proxy?.close();
	for (const table of tables) await fresh(`DROP TABLE IF EXISTS ${quoted(table)}`).catch(() => undefined);
}, 120_000);

describe('a connection lost in the middle of a transaction', () => {
	it('rejects the transaction, commits nothing, and the pool serves the next query', async () => {
		await resetItems();
		const pool = proxiedPool();
		const db = native.drizzle(pool);
		let cut = 0;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'before cut' });
				cut = proxy.cutAll();
				await tx.insert(items).values({ id: 2, label: 'after cut' });
			}),
		);
		log('cut between statements', { ...shape(outcome.error), ms: outcome.ms });
		expect(cut).toBe(1);
		// The next statement was written to the reset socket, so its outcome is unknown.
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: true });
		expect(outcome.ms).toBeLessThan(2000);
		expect(await persisted()).toEqual([]);
		// The dead connection is never handed out again.
		await db.insert(items).values({ id: 3, label: 'after' });
		expect(await persisted()).toEqual([{ id: 3, label: 'after' }]);
		await expectRecovered(pool, true);
	});

	it('rejects a statement whose reply was lost with its outcome unknown, and commits none of it', async () => {
		await resetItems([1, 'original']);
		const pool = proxiedPool();
		const db = native.drizzle(pool);
		let fired: Promise<void> | undefined;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 2, label: 'tx' });
				// The server runs the UPDATE; its reply never arrives.
				fired = proxy.failNextRequest(isStatement, 'after-server');
				await tx.update(items).set({ label: 'in flight' }).where(eq(items.id, 1));
			}),
		);
		await firedWithin(fired, 'statement reply');
		log('statement reply lost', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: true });
		expect(outcome.ms).toBeLessThan(2000);
		// The server rolled the transaction back when its connection closed.
		expect(await persisted()).toEqual([{ id: 1, label: 'original' }]);
		await expectRecovered(pool, true);
	});

	it('rejects, commits nothing and reconnects through a single client', async () => {
		await resetItems();
		const client = createClient({ ...config, host: '127.0.0.1', port: proxy.port });
		try {
			const db = native.drizzle(client);
			await db.select({ id: items.id }).from(items);
			const outcome = await settle(
				db.transaction(async (tx) => {
					await tx.insert(items).values({ id: 1, label: 'x' });
					// Cuts the transaction's connection and the client's shared one.
					expect(proxy.cutAll()).toBe(2);
					await tx.insert(items).values({ id: 2, label: 'y' });
				}),
			);
			log('single client cut', { ...shape(outcome.error), ms: outcome.ms });
			expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost' });
			expect(await persisted()).toEqual([]);
			// The client's shared connection was cut too; the next statement opens a new one.
			await db.insert(items).values({ id: 3, label: 'z' });
			expect(await persisted()).toEqual([{ id: 3, label: 'z' }]);
		} finally {
			await client.close();
		}
	});

	it('rejects, commits nothing and recovers through the 0.x API (drizzle-cubrid)', async () => {
		await resetItems();
		const pool = proxiedPool();
		const db = legacyDrizzle(pool);
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(legacyItems).values({ id: 1 });
				proxy.cutAll();
				await tx.insert(legacyItems).values({ id: 2 });
			}),
		);
		log('0.x cut', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost' });
		expect(await persisted()).toEqual([]);
		await db.insert(legacyItems).values({ id: 3 });
		expect(await persisted()).toEqual([{ id: 3, label: null }]);
		await expectRecovered(pool, true);
	});

	it('rejects and commits nothing when the server kills the CAS process serving the transaction', async () => {
		await resetItems();
		const pool = directPool();
		const db = native.drizzle(pool);
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'cas killed' });
				// kill -9 every CAS process of the broker, so the one holding this session dies.
				await docker(
					'exec',
					container,
					'sh',
					'-c',
					'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)" in broker1_cub_cas_*) kill -9 "$(basename "$p")";; esac; done',
				);
				await tx.insert(items).values({ id: 2, label: 'after kill' });
			}),
		);
		log('CAS killed', { ...shape(outcome.error), ms: outcome.ms });
		// The driver saw the socket close before sending the next statement, so the outcome is known.
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: false });
		expect(await persisted()).toEqual([]);
		await db.insert(items).values({ id: 3, label: 'after' });
		expect(await persisted()).toEqual([{ id: 3, label: 'after' }]);
		await expectRecovered(pool, false);
	});

	it('rejects and commits nothing when the database server restarts during the transaction', async () => {
		await resetItems();
		const pool = directPool();
		const db = native.drizzle(pool);
		let restartMs = 0;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'restarted' });
				restartMs = await restartServer();
				await tx.insert(items).values({ id: 2, label: 'after restart' });
			}),
		);
		log('server restart mid-transaction', { ...shape(outcome.error), ms: outcome.ms - restartMs, restartMs });
		// The CAS reconnects to the new server, but not inside a transaction: the
		// next statement fails with -224 "A database has not been restarted",
		// which cubrid-client 1.4.0 leaves without a kind and 1.5.0 and later classify
		// as 'connection-lost' (see docs/NATIVE_API.md).
		expect(outcome.error).toMatchObject({ name: 'TransactionError', code: -224, outcomeUnknown: false });
		expect([undefined, 'connection-lost']).toContain((outcome.error as { kind?: string }).kind);
		expect(await persisted()).toEqual([]);
		await db.insert(items).values({ id: 3, label: 'after' });
		expect(await persisted()).toEqual([{ id: 3, label: 'after' }]);
		await expectRecovered(pool, false);
	}, 120_000);
});

describe('a restart or outage between queries on a pool', () => {
	it('serves the next query after a database server restart', async () => {
		await resetItems([1, 'kept']);
		const pool = directPool({ max: 1 });
		const db = native.drizzle(pool);
		expect(await db.select({ id: items.id }).from(items)).toEqual([{ id: 1 }]);
		expect(pool.stats()).toMatchObject({ total: 1, idle: 1 });
		log('server restart took ms', await restartServer());
		const first = await settle(db.select({ id: items.id }).from(items));
		log('first query after server restart', first.error ? shape(first.error) : first.value);
		expect(first.value).toEqual([{ id: 1 }]);
		await db.insert(items).values({ id: 2, label: 'after restart' });
		expect(await persisted()).toEqual([
			{ id: 1, label: 'kept' },
			{ id: 2, label: 'after restart' },
		]);
		await expectRecovered(pool, false);
	}, 120_000);

	it('serves the next query after a broker restart closed every pooled connection', async () => {
		await resetItems([1, 'kept']);
		const pool = directPool({ max: 2 });
		const db = native.drizzle(pool);
		await Promise.all([db.select().from(items), db.select().from(items)]);
		log('broker restart took ms', await restartBroker());
		// cubrid-client checks an idle connection's CAS before a statement (CHECK_CAS)
		// and opens a new one when it is gone, sending the statement only once.
		const first = await settle(db.insert(items).values({ id: 2, label: 'after restart' }));
		log('first write after broker restart', first.error ? shape(first.error) : first.value);
		expect(first.value).toEqual({ affectedRows: 1 });
		expect(await persisted()).toEqual([
			{ id: 1, label: 'kept' },
			{ id: 2, label: 'after restart' },
		]);
		await expectRecovered(pool, false);
	}, 120_000);

	it('fails fast with a connection error while the server is unreachable, then recovers', async () => {
		await resetItems([1, 'kept']);
		const pool = proxiedPool({ max: 1 });
		const db = native.drizzle(pool);
		expect(await db.select({ id: items.id }).from(items)).toEqual([{ id: 1 }]);
		// The server goes away: open connections drop and new ones are refused.
		proxy.refuse(true);
		proxy.cutAll();
		const during = await settle(db.select({ id: items.id }).from(items));
		const write = await settle(db.insert(items).values({ id: 2, label: 'during outage' }));
		log('query during outage', { ...shape(during.error), ms: during.ms });
		log('write during outage', { ...shape(write.error), ms: write.ms });
		// Nothing was sent, so the outcome is known. cubrid-client reports a failed
		// reconnect of the idle connection as a QueryError and a failed new pool
		// connection as a ConnectionError, both of kind connection-lost.
		for (const failed of [during, write]) {
			expect(failed.error).toMatchObject({ kind: 'connection-lost', outcomeUnknown: false });
			expect(['QueryError', 'ConnectionError']).toContain((failed.error as Error).name);
			expect(failed.ms).toBeLessThan(config.connectionTimeout);
		}
		proxy.refuse(false);
		expect(await db.select({ id: items.id }).from(items)).toEqual([{ id: 1 }]);
		expect(await persisted()).toEqual([{ id: 1, label: 'kept' }]);
		await expectRecovered(pool, true);
	});
});

describe('a connection lost during COMMIT', () => {
	/** Wraps a pool so the test sees the error its transaction() rejected with. */
	function recording(pool: CubridPool) {
		const errors: unknown[] = [];
		const client: native.CubridNativeClient = {
			query: (sql, params, options) => pool.query(sql, params as never, options as never) as Promise<unknown[]>,
			queryPrepared: (sql, params, options) =>
				pool.queryPrepared(sql, params as never, options as never) as Promise<unknown[]>,
			execute: (sql, params, options) => pool.execute(sql, params as never, options as never),
			executePrepared: (sql, params, options) => pool.executePrepared(sql, params as never, options as never),
			transaction: (callback, options) =>
				pool.transaction(callback as never, options).catch((error: unknown) => {
					errors.push(error);
					throw error;
				}) as never,
		};
		return { client, errors };
	}

	it('rejects with the driver error unchanged when COMMIT never reached the server; nothing is committed', async () => {
		await resetItems();
		const pool = proxiedPool();
		const { client, errors } = recording(pool);
		const db = native.drizzle(client);
		let fired: Promise<void> | undefined;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'commit lost' });
				fired = proxy.failNextRequest(isCommit, 'before-server');
			}),
		);
		await firedWithin(fired, 'COMMIT before the server');
		log('COMMIT cut before the server', { ...shape(outcome.error), ms: outcome.ms });
		expect(errors).toHaveLength(1);
		expect(outcome.error).toBe(errors[0]);
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: true });
		expect(await persisted()).toEqual([]);
		await expectRecovered(pool, true);
	});

	it('rejects with the same error when the COMMIT reply was lost, although the commit happened', async () => {
		await resetItems();
		const pool = proxiedPool();
		const { client, errors } = recording(pool);
		const db = native.drizzle(client);
		let fired: Promise<void> | undefined;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'reply lost' });
				fired = proxy.failNextRequest(isCommit, 'after-server');
			}),
		);
		await firedWithin(fired, 'COMMIT reply');
		log('COMMIT reply lost', { ...shape(outcome.error), ms: outcome.ms });
		expect(errors).toHaveLength(1);
		expect(outcome.error).toBe(errors[0]);
		// The caller cannot tell this from the test above: the outcome is unknown,
		// and only reading the database tells which it was.
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: true });
		expect(await persisted()).toEqual([{ id: 1, label: 'reply lost' }]);
		await expectRecovered(pool, true);
	});

	it('rejects through the 0.x API when the COMMIT reply was lost, although the commit happened', async () => {
		await resetItems();
		const pool = proxiedPool();
		const db = legacyDrizzle(pool);
		let fired: Promise<void> | undefined;
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(legacyItems).values({ id: 1 });
				fired = proxy.failNextRequest(isCommit, 'after-server');
			}),
		);
		await firedWithin(fired, '0.x COMMIT reply');
		log('0.x COMMIT reply lost', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toMatchObject({ name: 'TransactionError', kind: 'connection-lost', outcomeUnknown: true });
		expect(await persisted()).toEqual([{ id: 1, label: null }]);
		await expectRecovered(pool, true);
	});

	it('rejects an autocommit write whose COMMIT reply was lost, and never sends it again', async () => {
		await resetItems();
		const pool = proxiedPool();
		const db = native.drizzle(pool);
		const fired = proxy.failNextRequest(isCommit, 'after-server');
		const outcome = await settle(db.insert(items).values({ id: 1, label: 'autocommit' }));
		await firedWithin(fired, 'autocommit COMMIT reply');
		log('autocommit COMMIT reply lost', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toMatchObject({ name: 'QueryError', kind: 'connection-lost', outcomeUnknown: true });
		// Committed once: a resent INSERT would have failed on the primary key or added a row.
		expect(await persisted()).toEqual([{ id: 1, label: 'autocommit' }]);
		await expectRecovered(pool, true);
	});
});

describe('lock timeouts and deadlocks inside db.transaction()', () => {
	/** Holds an update lock on row `id` in a transaction of its own until `release()`. */
	async function holdLock(id: number) {
		const holder = createClient(config);
		const locked = gate();
		const release = gate();
		const done = holder.transaction(async (tx) => {
			await tx.query(`UPDATE ${quoted(items)} SET label = 'holder' WHERE id = ${id}`);
			locked.open();
			await release.opened;
			throw new Error('release the lock');
		});
		await locked.opened;
		return {
			release: async () => {
				release.open();
				await done.catch(() => undefined);
				await holder.close();
			},
		};
	}

	it('rejects with the lock-timeout error and rolls the whole transaction back', async () => {
		await resetItems([10, 'locked']);
		const lock = await holdLock(10);
		const pool = directPool({ lockTimeout: 500 });
		const db = native.drizzle(pool);
		let outcome: Awaited<ReturnType<typeof settle>>;
		try {
			outcome = await settle(
				db.transaction(async (tx) => {
					await tx.insert(items).values({ id: 11, label: 'tx' });
					await tx.update(items).set({ label: 'tx' }).where(eq(items.id, 10));
				}),
			);
		} finally {
			await lock.release();
		}
		log('lock timeout', { ...shape(outcome.error), ms: outcome.ms });
		// Inside a transaction cubrid-client reports a statement as its
		// TransactionError, with the kind and code of the server error.
		expect(outcome.error).toMatchObject({
			name: 'TransactionError',
			kind: 'lock-timeout',
			code: -75,
			outcomeUnknown: false,
		});
		expect((outcome.error as Error).cause).toBeInstanceOf(LockTimeoutError);
		expect(outcome.ms).toBeGreaterThanOrEqual(450);
		expect(await persisted()).toEqual([{ id: 10, label: 'locked' }]);
		await expectRecovered(pool, false);
	});

	it('rolls a nested transaction back to its savepoint after a lock timeout and commits the outer work', async () => {
		await resetItems([10, 'locked']);
		const lock = await holdLock(10);
		const pool = directPool({ lockTimeout: 500 });
		const db = native.drizzle(pool);
		let nestedError: unknown;
		try {
			await db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 21, label: 'outer' });
				const nested = await settle(
					tx.transaction(async (inner) => {
						await inner.insert(items).values({ id: 22, label: 'nested' });
						await inner.update(items).set({ label: 'nested' }).where(eq(items.id, 10));
					}),
				);
				nestedError = nested.error;
				await tx.insert(items).values({ id: 23, label: 'outer again' });
			});
		} finally {
			await lock.release();
		}
		log('nested lock timeout', shape(nestedError));
		expect(nestedError).toMatchObject({ name: 'TransactionError', kind: 'lock-timeout', code: -75 });
		expect((nestedError as Error).cause).toBeInstanceOf(LockTimeoutError);
		expect(await persisted()).toEqual([
			{ id: 10, label: 'locked' },
			{ id: 21, label: 'outer' },
			{ id: 23, label: 'outer again' },
		]);
		await expectRecovered(pool, false);
	});

	/**
	 * Runs `victim` and `survivor` into a deadlock: each locks its first row,
	 * then waits for the other's. The server picked the transaction that had
	 * written less as the victim in every run on CUBRID 11.4, so `survivor`
	 * writes extra rows first; a test still checks which one it picked.
	 */
	function deadlock(
		db: ReturnType<typeof native.drizzle<CubridPool>>,
		victim: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], lockSecond: () => Promise<void>) => Promise<void>,
	) {
		const locked = { victim: gate(), survivor: gate() };
		const survivor = settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values([
					{ id: 40, label: 'survivor' },
					{ id: 41, label: 'survivor' },
					{ id: 42, label: 'survivor' },
				]);
				await tx.update(items).set({ label: 'survivor' }).where(eq(items.id, 2));
				locked.survivor.open();
				await locked.victim.opened;
				await tx.update(items).set({ label: 'survivor' }).where(eq(items.id, 1));
			}),
		);
		const lockSecond = async () => {
			locked.victim.open();
			await locked.survivor.opened;
			await sleep(200);
		};
		return { survivor, victim: settle(db.transaction((tx) => victim(tx, lockSecond))) };
	}

	it('rejects the deadlock victim with the deadlock error, rolls it back and commits the other', async () => {
		await resetItems([1, 'a'], [2, 'b']);
		const pool = directPool({ max: 2 });
		const db = native.drizzle(pool);
		const { survivor, victim } = deadlock(db, async (tx, lockSecond) => {
			await tx.update(items).set({ label: 'victim' }).where(eq(items.id, 1));
			await lockSecond();
			await tx.update(items).set({ label: 'victim' }).where(eq(items.id, 2));
		});
		const [lost, won] = await Promise.all([victim, survivor]);
		log('deadlock', { victim: shape(lost.error), survivor: won.error ? shape(won.error) : 'committed' });
		expect(lost.error).toMatchObject({ name: 'TransactionError', kind: 'deadlock', code: -72 });
		expect((lost.error as Error).cause).toBeInstanceOf(DeadlockError);
		expect(won.error).toBeUndefined();
		expect(await persisted()).toEqual([
			{ id: 1, label: 'survivor' },
			{ id: 2, label: 'survivor' },
			{ id: 40, label: 'survivor' },
			{ id: 41, label: 'survivor' },
			{ id: 42, label: 'survivor' },
		]);
		await expectRecovered(pool, false);
	}, 60_000);

	it('rejects the outer transaction too when a nested one was the deadlock victim, committing none of it', async () => {
		await resetItems([1, 'a'], [2, 'b']);
		const pool = directPool({ max: 2 });
		const db = native.drizzle(pool);
		let nestedError: unknown;
		let afterNested: unknown;
		const { survivor, victim } = deadlock(db, async (tx, lockSecond) => {
			await tx.insert(items).values({ id: 31, label: 'outer' });
			nestedError = (
				await settle(
					tx.transaction(async (inner) => {
						await inner.update(items).set({ label: 'victim' }).where(eq(items.id, 1));
						await lockSecond();
						await inner.update(items).set({ label: 'victim' }).where(eq(items.id, 2));
					}),
				)
			).error;
			// The application handles the nested failure and goes on, as it may
			// after a lock timeout; the server has already rolled back everything.
			afterNested = (await settle(tx.insert(items).values({ id: 33, label: 'outer again' }))).error;
			if (afterNested) throw afterNested;
		});
		const [lost, won] = await Promise.all([victim, survivor]);
		log('nested deadlock', {
			nested: shape(nestedError),
			afterNested: afterNested ? shape(afterNested) : 'ran',
			outer: lost.error ? shape(lost.error) : 'committed',
			survivor: won.error ? shape(won.error) : 'committed',
		});
		expect(nestedError).toMatchObject({ name: 'TransactionError', kind: 'deadlock', code: -72 });
		expect((nestedError as Error).cause).toBeInstanceOf(DeadlockError);
		expect(won.error).toBeUndefined();
		// The adapter's guard: rolling back to the savepoint failed, so the outer
		// level refuses further statements before sending them and rejects with
		// that refusal, whose cause is the nested deadlock error.
		const refused = {
			message: expect.stringMatching(/can only roll back/),
			cause: expect.objectContaining({ kind: 'deadlock', code: -72 }),
		};
		expect(afterNested).toMatchObject(refused);
		expect((afterNested as Error).cause).toBe(nestedError);
		expect(nestedError).toHaveProperty('rollbackError');
		expect(lost.error).toBe(afterNested);
		const rows = await persisted();
		expect(rows.filter((row) => row.id === 31 || row.id === 33)).toEqual([]);
		expect(rows.filter((row) => row.id <= 2)).toEqual([
			{ id: 1, label: 'survivor' },
			{ id: 2, label: 'survivor' },
		]);
		await expectRecovered(pool, false);
	}, 60_000);

	it('rejects with ReadTimeoutError when a lock wait outlasts readTimeout, and never commits the statement', async () => {
		await resetItems([10, 'locked']);
		const lock = await holdLock(10);
		const pool = directPool({ readTimeout: 1000, lockTimeout: -1 });
		const db = native.drizzle(pool);
		let outcome: Awaited<ReturnType<typeof settle>>;
		try {
			outcome = await settle(
				db.transaction(async (tx) => {
					await tx.insert(items).values({ id: 11, label: 'tx' });
					await tx.update(items).set({ label: 'tx' }).where(eq(items.id, 10));
				}),
			);
		} finally {
			await lock.release();
		}
		log('readTimeout during a lock wait', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toBeInstanceOf(ReadTimeoutError);
		expect(outcome.error).toMatchObject({ kind: 'read-timeout', outcomeUnknown: true });
		expect(outcome.ms).toBeGreaterThanOrEqual(950);
		expect(outcome.ms).toBeLessThan(3000);
		// Once the lock is released the server runs the UPDATE, finds its client
		// gone and rolls the transaction back; nothing may appear later either.
		await sleep(1000);
		expect(await persisted()).toEqual([{ id: 10, label: 'locked' }]);
		await expectRecovered(pool, false);
	});
});

describe('a stalled network', () => {
	it('rejects with ReadTimeoutError within readTimeout, commits nothing, and the pool recovers', async () => {
		await resetItems();
		const pool = proxiedPool({ readTimeout: 1000 });
		const db = native.drizzle(pool);
		const outcome = await settle(
			db.transaction(async (tx) => {
				await tx.insert(items).values({ id: 1, label: 'stalled' });
				proxy.stall();
				await tx.insert(items).values({ id: 2, label: 'stalled' });
			}),
		);
		log('stall with readTimeout', { ...shape(outcome.error), ms: outcome.ms });
		expect(outcome.error).toBeInstanceOf(ReadTimeoutError);
		expect(outcome.error).toMatchObject({ kind: 'read-timeout', outcomeUnknown: true });
		expect(outcome.ms).toBeGreaterThanOrEqual(950);
		expect(outcome.ms).toBeLessThan(3000);
		proxy.resume();
		expect(await persisted()).toEqual([]);
		await expectRecovered(pool, true);
	});

	it('completes the query once the stall ends when no readTimeout is set', async () => {
		await resetItems([1, 'kept']);
		const pool = proxiedPool();
		const db = native.drizzle(pool);
		await db.select({ id: items.id }).from(items);
		proxy.stall();
		const pending = settle(db.select({ id: items.id }).from(items));
		await sleep(1500);
		proxy.resume();
		const outcome = await pending;
		log('stall without readTimeout', { value: outcome.value, ms: outcome.ms });
		expect(outcome.value).toEqual([{ id: 1 }]);
		expect(outcome.ms).toBeGreaterThanOrEqual(1400);
		await expectRecovered(pool, true);
	});

	it('rejects with ReadTimeoutError while the server container is paused, and recovers after', async () => {
		await resetItems();
		const pool = directPool({ readTimeout: 1000 });
		const db = native.drizzle(pool);
		let statement: Awaited<ReturnType<typeof settle>> | undefined;
		let outcome: Awaited<ReturnType<typeof settle>>;
		try {
			outcome = await settle(
				db.transaction(async (tx) => {
					await tx.insert(items).values({ id: 1, label: 'paused' });
					await docker('pause', container);
					statement = await settle(tx.insert(items).values({ id: 2, label: 'paused' }));
					throw statement.error;
				}),
			);
		} finally {
			await docker('unpause', container);
		}
		log('docker pause', { ...shape(outcome.error), statementMs: statement?.ms, ms: outcome.ms });
		expect(statement?.error).toBeInstanceOf(ReadTimeoutError);
		expect(outcome.error).toBe(statement?.error);
		expect(outcome.error).toMatchObject({ kind: 'read-timeout', outcomeUnknown: true });
		expect(statement?.ms).toBeGreaterThanOrEqual(950);
		expect(statement?.ms).toBeLessThan(3000);
		expect(await persisted()).toEqual([]);
		await expectRecovered(pool, false);
	});
});

describe('a relational query whose connection is lost between its statements', () => {
	it('rejects with no partial result, and the same query succeeds afterwards', async () => {
		await fresh(`DELETE FROM ${quoted(posts)}`);
		await fresh(`DELETE FROM ${quoted(users)}`);
		await fresh(`INSERT INTO ${quoted(users)} VALUES (1)`);
		await fresh(`INSERT INTO ${quoted(posts)} VALUES (10, 1)`);
		const pool = proxiedPool();
		const statements: string[] = [];
		let cut: number | undefined;
		const db = native.drizzle(pool, {
			schema,
			logger: {
				logQuery: (query) => {
					statements.push(query);
					// The root rows were read; cut before the child statement is sent.
					if (cut === undefined && statements.length === 2) cut = proxy.cutAll();
				},
			},
		});
		const query = () => db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: { id: true } } } });
		const outcome = await settle(query());
		log('relational query cut between statements', { ...shape(outcome.error), ms: outcome.ms });
		expect(cut).toBe(1);
		expect(outcome.value).toBeUndefined();
		// Given the class it has outside a transaction, as every relational statement error.
		expect(outcome.error).toMatchObject({ name: 'QueryError', kind: 'connection-lost' });
		expect(outcome.error).toHaveProperty('transactionError.name', 'TransactionError');
		expect(await query()).toEqual([{ id: 1, posts: [{ id: 10 }] }]);
		expect(await fresh(`SELECT author_id FROM ${quoted(posts)}`)).toEqual([{ author_id: 1 }]);
		await expectRecovered(pool, true);
	});
});
