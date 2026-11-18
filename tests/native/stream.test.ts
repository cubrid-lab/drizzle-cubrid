// Native streaming (#165) with a fake client: iterator() sends the SQL
// rendered for literals through stream() with array rows, decodes each row as
// execute() does, checks placeholders, options and the transaction before
// anything is sent, and closes cubrid-client's stream whenever the loop ends.
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { bigint, char, cubridTable, datetime, drizzle, integer, set, union, varchar } from '../../src/native/index';
import { NOT_UTC_MESSAGE } from '../../src/native/timezone';

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
		const db = drizzle(client);
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

	it('renders the stream for literals: CHAR placeholder lists are not expanded (#239)', async () => {
		const client = fakeClient();
		const db = drizzle(client);
		const query = db
			.select({ id: users.id })
			.from(users)
			.where(inArray(users.code, [sql.placeholder('a'), sql.placeholder('b')]))
			.prepare();
		await query.execute({ a: 'ab', b: 'cd' });
		await collect(query.iterator({ a: 'ab', b: 'cd' }));
		await collect(
			db
				.select({ id: users.id })
				.from(users)
				.where(inArray(users.code, [sql.placeholder('a'), sql.placeholder('b')]))
				.iterator({ a: 'ab', b: 'cd' }),
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
		const db = drizzle(client);
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
		for await (const _ of drizzle(broken).select({ id: users.id }).from(users).iterator()) break;
		expect(broken.state).toEqual({ reads: 1, ended: 'closed' });

		const thrown = fakeClient(rows);
		const boom = new Error('consumer failed');
		await expect(
			(async () => {
				for await (const _ of drizzle(thrown).select({ id: users.id }).from(users).iterator()) throw boom;
			})(),
		).rejects.toBe(boom);
		expect(thrown.state).toEqual({ reads: 1, ended: 'closed' });

		const returned = fakeClient(rows);
		const iterator = drizzle(returned).select({ id: users.id }).from(users).iterator();
		expect(await iterator.next()).toEqual({ value: { id: 1n }, done: false });
		expect(await iterator.return()).toEqual({ value: undefined, done: true });
		expect(returned.state).toEqual({ reads: 1, ended: 'closed' });
	});

	it('closes the stream when a row fails to decode, and passes a driver error through', async () => {
		const bad = fakeClient([
			[1, 'not a date'],
			[2, null],
		]);
		const decode = collect(drizzle(bad).select({ id: posts.id, at: posts.at }).from(posts).iterator());
		await expect(decode).rejects.toThrow();
		expect(bad.state).toEqual({ reads: 1, ended: 'closed' });

		const driverError = Object.assign(new Error('Query failed.'), { kind: 'stream-busy' });
		const failing = fakeClient([[1n], driverError]);
		const seen: unknown[] = [];
		const error = await (async () => {
			for await (const row of drizzle(failing).select({ id: users.id }).from(users).iterator()) seen.push(row);
		})().catch((e: unknown) => e);
		expect(error).toBe(driverError);
		expect(seen).toEqual([{ id: 1n }]);
	});

	it('logs the statement', async () => {
		const logged: unknown[] = [];
		const db = drizzle(fakeClient(), { logger: { logQuery: (query, params) => logged.push([query, params]) } });
		await collect(db.select({ id: users.id }).from(users).where(eq(users.id, 5n)).iterator());
		expect(logged).toEqual([['select "users"."id" from "users" where "users"."id" = ?', [5n]]]);
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
		expect(() => run(drizzle(client))).toThrow(message);
		expect(client.calls).toEqual([]);
	});

	it('refuses a client without stream()', () => {
		const { stream: _, ...client } = fakeClient();
		expect(() => drizzle(client).select().from(users).iterator()).toThrow(/has no stream\(\) for iterator\(\)/);
	});

	it('refuses iterator() inside db.transaction(), even on a transaction client with stream()', async () => {
		const inner = fakeClient([[1n]]);
		const client = {
			...fakeClient(),
			transaction: async <T>(callback: (tx: typeof inner) => Promise<T>) => callback(inner),
		};
		const db = drizzle(client);
		await expect(
			db.transaction(async (tx) => {
				tx.select({ id: users.id }).from(users).iterator();
			}),
		).rejects.toThrow(/iterator\(\) is not supported inside db\.transaction\(\)/);
		expect(inner.calls).toEqual([]);
	});

	it('refuses a date or time read from a client that does not decode in UTC, on the first read', async () => {
		const client = fakeClient([[1, at]], { timezone: 'local' });
		const rows = drizzle(client).select({ id: posts.id, at: posts.at }).from(posts).iterator();
		await expect(collect(rows)).rejects.toThrow(NOT_UTC_MESSAGE);
		expect(client.calls).toEqual([]);
	});

	it('refuses an array parameter on the first read', async () => {
		const client = fakeClient();
		const rows = drizzle(client)
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, sql.placeholder('id')))
			.iterator({ id: [1, 2] });
		await expect(collect(rows)).rejects.toThrow(/Parameter 1 is an array/);
		expect(client.calls).toEqual([]);
	});
});
