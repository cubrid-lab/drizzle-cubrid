// Native streaming (#165) with a fake client: iterator() is refused under
// binding 'prepared' without { literal: true }, sends the SQL rendered for
// literals through stream() with array rows, decodes each row as
// execute() does, checks placeholders, options and the transaction before
// anything is sent, and closes cubrid-client's stream whenever the loop ends.
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
	bigint,
	CubridDialect,
	char,
	cubridTable,
	datetime,
	drizzle,
	integer,
	set,
	union,
	varchar,
} from '../../src/native/index';
import { NOT_UTC_MESSAGE } from '../../src/native/timezone';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey(),
	name: varchar({ length: 50 }).notNull(),
	code: char({ length: 4 }),
});
const posts = cubridTable('posts', {
	id: integer().primaryKey(),
	authorId: bigint('author_id', { mode: 'bigint' }),
	at: datetime(),
	tags: set({ element: varchar({ length: 10 }) }),
});

type Call = { method: string; sql: string; params: readonly unknown[] | undefined; options: unknown };

/**
 * A cubrid-client stand-in whose stream() yields the queued rows (an Error
 * in them is thrown at that read) and records how the stream ended.
 */
function fakeClient(rows: unknown[] = [], extra: Record<string, unknown> = { timezone: 'utc' }) {
	const calls: Call[] = [];
	const state = { reads: 0, ended: undefined as 'done' | 'closed' | 'failed' | undefined };
	const respond = (method: string) => async (text: string, params?: readonly unknown[], options?: unknown) => {
		calls.push({ method, sql: text, params, options });
		return [];
	};
	return {
		calls,
		state,
		query: respond('query'),
		queryPrepared: respond('queryPrepared'),
		stream(text: string, params: readonly unknown[], options: unknown) {
			calls.push({ method: 'stream', sql: text, params, options });
			return (async function* () {
				let finished = false;
				try {
					for (const row of rows) {
						state.reads++;
						if (row instanceof Error) {
							state.ended = 'failed';
							throw row;
						}
						yield row as unknown[];
					}
					finished = true;
					state.ended = 'done';
				} finally {
					if (!finished && state.ended === undefined) state.ended = 'closed';
				}
			})();
		},
		...extra,
	};
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

const at = new Date(Date.UTC(2024, 1, 29, 23, 59, 58, 123));

describe('iterator()', () => {
	it('streams array rows through stream() and decodes them as execute() does', async () => {
		const client = fakeClient([
			[9007199254740993n, 'Ann', 'ab  ', 10, '2024-02-29 23:59:58.123', ['x', null]],
			[2n, 'Bob', null, null, null, null],
		]);
		const db = drizzle(client, { binding: 'literal' });
		const rows = db
			.select({
				id: users.id,
				name: users.name,
				code: users.code,
				post: { id: posts.id, at: posts.at, tags: posts.tags },
			})
			.from(users)
			.leftJoin(posts, eq(users.id, posts.authorId))
			.where(eq(users.name, sql.placeholder('name')))
			.iterator({ name: 'Ann' }, { fetchSize: 500 });
		expect(client.calls).toEqual([]);
		expect(await collect(rows)).toEqual([
			{ id: 9007199254740993n, name: 'Ann', code: 'ab  ', post: { id: 10, at, tags: ['x', null] } },
			{ id: 2n, name: 'Bob', code: null, post: null },
		]);
		expect(client.calls).toEqual([
			{
				method: 'stream',
				sql: 'select "users"."id", "users"."name", "users"."code", "posts"."id", "posts"."at", "posts"."tags" from "users" left join "posts" on "users"."id" = "posts"."author_id" where "users"."name" = ?',
				params: ['Ann'],
				options: { fetchSize: 500, rowMode: 'array' },
			},
		]);
		expect(client.state.ended).toBe('done');
	});

	it('with { literal: true } under binding prepared, renders the stream for literals: CHAR placeholder lists are not expanded (#239)', async () => {
		const client = fakeClient();
		const db = drizzle(client);
		const query = db
			.select({ id: users.id })
			.from(users)
			.where(inArray(users.code, [sql.placeholder('a'), sql.placeholder('b')]))
			.prepare();
		await query.execute({ a: 'ab', b: 'cd' });
		await collect(query.iterator({ a: 'ab', b: 'cd' }, { literal: true }));
		await collect(
			db
				.select({ id: users.id })
				.from(users)
				.where(inArray(users.code, [sql.placeholder('a'), sql.placeholder('b')]))
				.iterator({ a: 'ab', b: 'cd' }, { literal: true }),
		);
		expect(client.calls.map(({ method, sql, params }) => [method, sql, params])).toEqual([
			[
				'queryPrepared',
				'select "users"."id" from "users" where ("users"."code" = ? or "users"."code" = ?)',
				['ab', 'cd'],
			],
			['stream', 'select "users"."id" from "users" where "users"."code" in (?, ?)', ['ab', 'cd']],
			['stream', 'select "users"."id" from "users" where "users"."code" in (?, ?)', ['ab', 'cd']],
		]);
	});

	it('reuses a prepared select for many streams with different values', async () => {
		const client = fakeClient([[1n]]);
		const db = drizzle(client, { binding: 'literal' });
		const prepared = db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, sql.placeholder('id')))
			.limit(sql.placeholder('n'))
			.prepare();
		for (const id of [1n, 2n, 3n]) await collect(prepared.iterator({ id, n: 1 }));
		expect(client.calls.map(({ params }) => params)).toEqual([
			[1n, 1],
			[2n, 1],
			[3n, 1],
		]);
	});

	it('streams a set operation', async () => {
		const client = fakeClient([[1n, 'a']]);
		const db = drizzle(client, { binding: 'literal' });
		const names = () => db.select({ id: users.id, name: users.name }).from(users);
		const rows = await collect(
			union(names(), names()).orderBy(users.name).limit(sql.placeholder('n')).iterator({ n: 5 }),
		);
		expect(rows).toEqual([{ id: 1n, name: 'a' }]);
		expect(client.calls[0]).toMatchObject({
			method: 'stream',
			sql: '(select "users"."id", "users"."name" from "users") union (select "users"."id", "users"."name" from "users") order by 2 limit ?',
			params: [5],
		});
	});

	it('closes the stream when the loop breaks, throws or the iterator is returned', async () => {
		const rows = [[1n], [2n], [3n]];
		const broken = fakeClient(rows);
		for await (const _ of drizzle(broken, { binding: 'literal' }).select({ id: users.id }).from(users).iterator())
			break;
		expect(broken.state).toEqual({ reads: 1, ended: 'closed' });

		const thrown = fakeClient(rows);
		const boom = new Error('consumer failed');
		await expect(
			(async () => {
				for await (const _ of drizzle(thrown, { binding: 'literal' }).select({ id: users.id }).from(users).iterator())
					throw boom;
			})(),
		).rejects.toBe(boom);
		expect(thrown.state).toEqual({ reads: 1, ended: 'closed' });

		const returned = fakeClient(rows);
		const iterator = drizzle(returned, { binding: 'literal' }).select({ id: users.id }).from(users).iterator();
		expect(await iterator.next()).toEqual({ value: { id: 1n }, done: false });
		expect(await iterator.return()).toEqual({ value: undefined, done: true });
		expect(returned.state).toEqual({ reads: 1, ended: 'closed' });
	});

	it('closes the stream when a row fails to decode, and passes a driver error through', async () => {
		const bad = fakeClient([
			[1, 'not a date'],
			[2, null],
		]);
		const decode = collect(
			drizzle(bad, { binding: 'literal' }).select({ id: posts.id, at: posts.at }).from(posts).iterator(),
		);
		await expect(decode).rejects.toThrow();
		expect(bad.state).toEqual({ reads: 1, ended: 'closed' });

		const driverError = Object.assign(new Error('Query failed.'), { kind: 'stream-busy' });
		const failing = fakeClient([[1n], driverError]);
		const seen: unknown[] = [];
		const error = await (async () => {
			for await (const row of drizzle(failing, { binding: 'literal' }).select({ id: users.id }).from(users).iterator())
				seen.push(row);
		})().catch((e: unknown) => e);
		expect(error).toBe(driverError);
		expect(seen).toEqual([{ id: 1n }]);
	});

	it('logs the statement', async () => {
		const logged: unknown[] = [];
		const db = drizzle(fakeClient(), {
			binding: 'literal',
			logger: { logQuery: (query, params) => logged.push([query, params]) },
		});
		await collect(db.select({ id: users.id }).from(users).where(eq(users.id, 5n)).iterator());
		expect(logged).toEqual([['select "users"."id" from "users" where "users"."id" = ?', [5n]]]);
	});
});

describe('prepare() rendering', () => {
	it('renders both forms at prepare(), from the SQL built then: a later builder change does not reach either', async () => {
		const render = vi.spyOn(CubridDialect.prototype, 'sqlToQuery');
		try {
			const client = fakeClient();
			const select = drizzle(client).select({ id: users.id }).from(users).where(eq(users.id, 1n));
			const prepared = select.prepare();
			expect(render).toHaveBeenCalledTimes(2);
			select.where(eq(users.id, 2n));
			await prepared.execute();
			await collect(prepared.iterator({}, { literal: true }));
			await collect(prepared.iterator({}, { literal: true }));
			expect(render).toHaveBeenCalledTimes(2);
			expect(client.calls.map(({ method, params }) => [method, params])).toEqual([
				['queryPrepared', [1n]],
				['stream', [1n]],
				['stream', [1n]],
			]);
		} finally {
			render.mockRestore();
		}
	});

	it('sends the values held at prepare() from execute() and iterator() alike when a Date or an array is changed afterwards', async () => {
		const client = fakeClient();
		const db = drizzle(client);
		const since = new Date(Date.UTC(2024, 1, 29, 15, 0, 0, 10));
		const codes = ['ab', 'cd'];
		const prepared = db
			.select({ id: posts.id })
			.from(posts)
			.where(and(lt(posts.at, since), sql`${posts.id} in ${codes}`))
			.prepare();
		since.setUTCFullYear(1990);
		codes[0] = 'zz';
		codes.push('yy');
		await prepared.execute();
		await collect(prepared.iterator({}, { literal: true }));
		const [executed, streamed] = client.calls.map(({ params }) => params);
		expect(streamed).toEqual(executed);
		expect(executed).toHaveLength(3);
		expect(executed?.slice(1)).toEqual(['ab', 'cd']);
		expect(executed?.[0]).not.toEqual(since);
	});

	it('logs nothing for a stream whose signal was aborted before its first read', async () => {
		const logged: unknown[] = [];
		const client = fakeClient([[1n]]);
		const db = drizzle(client, { binding: 'literal', logger: { logQuery: (query) => logged.push(query) } });
		const reason = new Error('stop');
		const rows = db
			.select({ id: users.id })
			.from(users)
			.iterator({}, { signal: AbortSignal.abort(reason) });
		await expect(collect(rows)).rejects.toBe(reason);
		expect(logged).toEqual([]);
		expect(client.calls).toEqual([]);
	});
});

describe('iterator() refusals before anything is sent', () => {
	it.each([
		[
			'a placeholder without a value',
			(db: ReturnType<typeof drizzle>) =>
				db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.id, sql.placeholder('id')))
					.iterator(),
			/No value for placeholder "id" was provided/,
		],
		[
			'placeholder values that are not an object',
			(db: ReturnType<typeof drizzle>) =>
				db
					.select({ id: users.id })
					.from(users)
					.iterator(null as never),
			/Placeholder values must be an object/,
		],
		[
			'an unknown option',
			(db: ReturnType<typeof drizzle>) =>
				db
					.select({ id: users.id })
					.from(users)
					.iterator({}, { rowMode: 'object' } as never),
			/Unknown iterator\(\) option 'rowMode'/,
		],
		[
			'options that are not an object',
			(db: ReturnType<typeof drizzle>) =>
				db
					.select({ id: users.id })
					.from(users)
					.iterator({}, 5 as never),
			/iterator\(\) options must be an object/,
		],
	])('%s', (_, run, message) => {
		const client = fakeClient([[1n]]);
		expect(() => run(drizzle(client, { binding: 'literal' }))).toThrow(message);
		expect(client.calls).toEqual([]);
	});

	it('refuses a client without stream()', () => {
		const { stream: _, ...client } = fakeClient();
		expect(() => drizzle(client, { binding: 'literal' }).select().from(users).iterator()).toThrow(
			/has no stream\(\) for iterator\(\)/,
		);
	});

	it("refuses iterator() under binding 'prepared' without { literal: true }, naming both ways out", () => {
		const client = fakeClient([[1n]]);
		const db = drizzle(client);
		for (const options of [undefined, {}, { literal: false }]) {
			expect(() => db.select({ id: users.id }).from(users).iterator({}, options)).toThrow(
				/iterator\(\) is refused under binding 'prepared'.*binding: 'literal'.*\{ literal: true \}.*#307/,
			);
			expect(() => db.select({ id: users.id }).from(users).prepare().iterator({}, options)).toThrow(
				/refused under binding 'prepared'/,
			);
		}
		expect(client.calls).toEqual([]);
		// The opt-in is not passed to cubrid-client.
		const rows = db.select({ id: users.id }).from(users).iterator({}, { literal: true, consumerTimeout: 0 });
		return collect(rows).then(() =>
			expect(client.calls).toEqual([
				{
					method: 'stream',
					sql: 'select "users"."id" from "users"',
					params: [],
					options: { consumerTimeout: 0, rowMode: 'array' },
				},
			]),
		);
	});

	it.each([
		[{ fetchSize: 0 }, /fetchSize must be an integer from 1/],
		[{ fetchSize: 1.5 }, /fetchSize must be an integer from 1/],
		[{ fetchSize: 2 ** 31 }, /fetchSize must be an integer from 1/],
		[{ consumerTimeout: -1 }, /consumerTimeout must be an integer from 0/],
		[{ consumerTimeout: 'soon' }, /consumerTimeout must be an integer from 0/],
		[{ signal: {} }, /signal must be an AbortSignal/],
		[{ signal: { aborted: false } }, /signal must be an AbortSignal/],
		[{ signal: { aborted: true, reason: new Error('stop') } }, /signal must be an AbortSignal/],
		[{ literal: 'yes' }, /literal must be a boolean/],
	])('refuses option %o when iterator() is called', (options, message) => {
		const client = fakeClient();
		expect(() =>
			drizzle(client, { binding: 'literal' })
				.select()
				.from(users)
				.iterator({}, options as never),
		).toThrow(message);
		expect(client.calls).toEqual([]);
	});

	it('says that the transaction ended for a prepared select of a tx iterated afterwards', async () => {
		const inner = fakeClient();
		const client = {
			...fakeClient(),
			transaction: async <T>(callback: (tx: typeof inner) => Promise<T>) => callback(inner),
		};
		let prepared!: { iterator(): unknown };
		await drizzle(client, { binding: 'literal' }).transaction(async (tx) => {
			prepared = tx.select({ id: users.id }).from(users).prepare();
		});
		expect(() => prepared.iterator()).toThrow(/This transaction has ended/);
		expect(inner.calls).toEqual([]);
	});

	it('refuses iterator() inside db.transaction(), even on a transaction client with stream()', async () => {
		const inner = fakeClient([[1n]]);
		const client = {
			...fakeClient(),
			transaction: async <T>(callback: (tx: typeof inner) => Promise<T>) => callback(inner),
		};
		const db = drizzle(client, { binding: 'literal' });
		await expect(
			db.transaction(async (tx) => {
				tx.select({ id: users.id }).from(users).iterator();
			}),
		).rejects.toThrow(/iterator\(\) is not supported inside db\.transaction\(\)/);
		expect(inner.calls).toEqual([]);
	});

	it('refuses a date or time read from a client that does not decode in UTC, on the first read', async () => {
		const client = fakeClient([[1, at]], { timezone: 'local' });
		const rows = drizzle(client, { binding: 'literal' }).select({ id: posts.id, at: posts.at }).from(posts).iterator();
		const zone = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			await expect(collect(rows)).rejects.toThrow(NOT_UTC_MESSAGE);
			expect(client.calls).toEqual([]);
		} finally {
			env.TZ = zone;
		}
	});

	it('refuses an array parameter when iterator() is called', () => {
		const client = fakeClient();
		const select = drizzle(client, { binding: 'literal' })
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, sql.placeholder('id')));
		expect(() => select.iterator({ id: [1, 2] })).toThrow(/Parameter 1 is an array/);
		expect(client.calls).toEqual([]);
	});
});

// Characterizes behavior pending #272; change these assertions deliberately when #272 is decided.
//
// A cubrid-client transaction client (the tx of client.transaction() or
// pool.transaction(), a beginTransactionScope() handle) passed to drizzle()
// directly. From cubrid-client 1.5.0 it has stream(); with 1.4 it has none.
// pool.connection()'s connection has stream() from 1.4 on. The live suite
// (tests/integration.test.ts) pins the same behavior on real objects.
describe('iterator() on a cubrid-client transaction client passed to drizzle() (pending #272)', () => {
	const NO_STREAM =
		'The CUBRID client has no stream() for iterator() (a cubrid-client 1.4 or later client or pool has one; transaction clients have one from 1.5.0)';
	const PREPARED_REFUSED =
		"iterator() is refused under binding 'prepared': cubrid-client 1.4's stream() sends values only as SQL literals, and CUBRID compares some values differently as literals than as typed binds (a NULL inside OR under NOT, trailing spaces in LIKE), so the stream could return other rows than execute(). Create the database with drizzle(client, { binding: 'literal' }) so that execute() and iterator() both send literals, or pass { literal: true } to iterator() to accept literal semantics for this stream (cubrid-lab/cubrid-client#307)";
	const IN_DB_TRANSACTION =
		'iterator() is not supported inside db.transaction(): await the select in the transaction, or stream with db outside it';

	/** A transaction client as cubrid-client 1.5.0 and later hand it out: with stream(). */
	const txWithStream = () => fakeClient([[1n], [2n], [3n]]);
	/** A transaction client as cubrid-client 1.4 hands it out: without stream(). */
	const txWithoutStream = () => {
		const { stream: _, ...tx } = fakeClient([[1n]]);
		return tx;
	};
	/** The error iterator() throws synchronously, or undefined. */
	const thrownBy = (run: () => unknown): unknown => {
		try {
			run();
		} catch (error) {
			return error;
		}
		return undefined;
	};

	it("refuses iterator() under the default binding 'prepared' on a transaction client with stream() (1.5.0+)", () => {
		const tx = txWithStream();
		const error = thrownBy(() => drizzle(tx).select({ id: users.id }).from(users).iterator());
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).constructor).toBe(Error);
		expect((error as Error).message).toBe(PREPARED_REFUSED);
		expect(tx.calls).toEqual([]);
	});

	it('streams with { literal: true } on a transaction client with stream() (1.5.0+), through the tx itself', async () => {
		const tx = txWithStream();
		const rows = await collect(drizzle(tx).select({ id: users.id }).from(users).iterator({}, { literal: true }));
		expect(rows).toEqual([{ id: 1n }, { id: 2n }, { id: 3n }]);
		expect(tx.calls).toEqual([
			{ method: 'stream', sql: 'select "users"."id" from "users"', params: [], options: { rowMode: 'array' } },
		]);
		expect(tx.state).toEqual({ reads: 3, ended: 'done' });
	});

	it("streams under binding 'literal' on a transaction client with stream() (1.5.0+)", async () => {
		const tx = txWithStream();
		const rows = await collect(drizzle(tx, { binding: 'literal' }).select({ id: users.id }).from(users).iterator());
		expect(rows).toEqual([{ id: 1n }, { id: 2n }, { id: 3n }]);
		expect(tx.calls.map(({ method }) => method)).toEqual(['stream']);
	});

	it("closes the transaction client's stream when the loop breaks (1.5.0+)", async () => {
		const tx = txWithStream();
		const seen: unknown[] = [];
		for await (const row of drizzle(tx).select({ id: users.id }).from(users).iterator({}, { literal: true })) {
			seen.push(row);
			break;
		}
		expect(seen).toEqual([{ id: 1n }]);
		expect(tx.state).toEqual({ reads: 1, ended: 'closed' });
	});

	it.each([
		['the default binding', {}, undefined],
		['the default binding with { literal: true }', {}, { literal: true }],
		["binding 'literal'", { binding: 'literal' as const }, undefined],
	])(
		'refuses iterator() on a transaction client without stream() (1.4) under %s, before anything is sent',
		(_, config, options) => {
			const tx = txWithoutStream();
			const error = thrownBy(() => drizzle(tx, config).select({ id: users.id }).from(users).iterator({}, options));
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).constructor).toBe(Error);
			expect((error as Error).message).toBe(NO_STREAM);
			expect(tx.calls).toEqual([]);
		},
	);

	it.each([
		['the default binding', {}, undefined, txWithStream],
		['the default binding with { literal: true }', {}, { literal: true }, txWithStream],
		["binding 'literal'", { binding: 'literal' as const }, undefined, txWithStream],
		[
			"binding 'literal' on a transaction client without stream() (1.4)",
			{ binding: 'literal' as const },
			undefined,
			txWithoutStream,
		],
	])(
		'refuses iterator() inside db.transaction() under %s, whatever the transaction client has',
		async (_, config, options, makeTx) => {
			const inner = makeTx();
			const client = {
				...fakeClient(),
				transaction: async <T>(callback: (tx: typeof inner) => Promise<T>) => callback(inner),
			};
			const error = await drizzle(client, config)
				.transaction(async (tx) => {
					tx.select({ id: users.id }).from(users).iterator({}, options);
				})
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).constructor).toBe(Error);
			expect((error as Error).message).toBe(IN_DB_TRANSACTION);
			expect(inner.calls).toEqual([]);
		},
	);
});
