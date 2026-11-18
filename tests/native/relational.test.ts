// Native relational queries (#158) with a fake client: the statements each
// findMany() sends (one per relation level and key chunk, never one per
// parent), how rows are stitched and decoded, the consistency wrapper and the
// refusals made before anything is sent.

import { QueryError, SqlSyntaxError, TransactionError } from 'cubrid-client';
import { desc, relations, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	bigint,
	type CubridNativeClient,
	char,
	cubridTable,
	drizzle,
	integer,
	numeric,
	set,
	varchar,
} from '../../src/native/index';
import { RELATIONAL_KEY_CHUNK } from '../../src/native/relational';
import * as schema from './relational-schema';

const { posts } = schema;

type Call = { on: string; method: string; sql: string; params?: readonly unknown[]; options?: unknown };

/**
 * A cubrid-client stand-in. SELECTs return the queued row sets in order;
 * `transaction(callback, options)` runs the callback on a recorded transaction client.
 */
function fakeClient(results: unknown[][] = []) {
	const calls: Call[] = [];
	const queue = [...results];
	const methods = (on: string) => ({
		query: async (text: string, params?: readonly unknown[], options?: unknown) => {
			calls.push({ on, method: 'query', sql: text, params, options });
			return queue.shift() ?? [];
		},
		queryPrepared: async (text: string, params?: readonly unknown[], options?: unknown) => {
			calls.push({ on, method: 'queryPrepared', sql: text, params, options });
			const next = queue.shift() ?? [];
			if (next instanceof Error) throw next;
			return next;
		},
	});
	const client = {
		...methods('client'),
		timezone: 'utc',
		calls,
		/** The SQL of every SELECT, in order. */
		get selects() {
			return calls.filter((call) => call.method === 'queryPrepared').map((call) => call.sql);
		},
		async transaction<T>(callback: (tx: ReturnType<typeof methods>) => Promise<T>, options?: unknown): Promise<T> {
			calls.push({ on: 'tx', method: 'begin', sql: 'BEGIN', options });
			try {
				const result = await callback(methods('tx'));
				calls.push({ on: 'tx', method: 'commit', sql: 'COMMIT' });
				return result;
			} catch (error) {
				calls.push({ on: 'tx', method: 'rollback', sql: 'ROLLBACK' });
				throw new Error('Transaction failed.', { cause: error });
			}
		},
	};
	return client;
}

/** fakeClient() without transaction(). */
function clientWithoutTransactions(results: unknown[][]) {
	const { transaction: _, ...client } = fakeClient(results);
	return client;
}

const big = 9007199254740993n;

describe('findMany', () => {
	it('loads the root rows with one statement and no transaction when nothing is loaded with it', async () => {
		const client = fakeClient([
			[
				[1n, 'Ann', null],
				[big, 'Bob', 1n],
			],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany();
		expect(rows).toEqual([
			{ id: 1n, name: 'Ann', managerId: null },
			{ id: big, name: 'Bob', managerId: 1n },
		]);
		expect(client.calls).toEqual([
			{
				on: 'client',
				method: 'queryPrepared',
				sql: 'select "users"."id", "users"."name", "users"."manager_id" from "users"',
				params: [],
				options: { rowMode: 'array' },
			},
		]);
	});

	it('loads a one-to-many relation with one IN statement, in a repeatable read transaction', async () => {
		const at = new Date(Date.UTC(2024, 1, 29, 23, 59, 58, 123));
		const client = fakeClient([
			[
				[1n, 'Ann'],
				[big, 'Bob'],
				[3n, 'Cy'],
			],
			[
				[10, 'A1', '2024-02-29 23:59:58.123', ['x', 'y'], 1n],
				[11, 'B1', null, null, big],
				[12, 'A2', null, [], 1n],
			],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true, name: true },
			with: { posts: { columns: { id: true, title: true, at: true, tags: true } } },
		});
		expect(rows).toEqual([
			{
				id: 1n,
				name: 'Ann',
				posts: [
					{ id: 10, title: 'A1', at, tags: ['x', 'y'] },
					{ id: 12, title: 'A2', at: null, tags: [] },
				],
			},
			{ id: big, name: 'Bob', posts: [{ id: 11, title: 'B1', at: null, tags: null }] },
			{ id: 3n, name: 'Cy', posts: [] },
		]);
		expect(client.calls.map(({ on, sql, params, options }) => ({ on, sql, params, options }))).toEqual([
			{ on: 'tx', sql: 'BEGIN', params: undefined, options: { isolationLevel: 'repeatable read' } },
			{
				on: 'tx',
				sql: 'select "users"."id", "users"."name" from "users"',
				params: [],
				options: { rowMode: 'array' },
			},
			{
				on: 'tx',
				sql: 'select "posts"."id", "posts"."title", "posts"."at", "posts"."tags", "posts"."author_id" from "posts" where "posts"."author_id" in (?, ?, ?)',
				params: [1n, big, 3n],
				options: { rowMode: 'array' },
			},
			{ on: 'tx', sql: 'COMMIT', params: undefined, options: undefined },
		]);
	});

	it('loads a nullable many-to-one relation as an object or null, skipping NULL keys and repeated keys', async () => {
		const client = fakeClient([
			[
				[1n, 'Ann', null],
				[2n, 'Bob', 1n],
				[3n, 'Cy', 1n],
			],
			[[1n, 'Ann']],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true, name: true },
			with: { manager: { columns: { id: true, name: true } } },
		});
		expect(rows).toEqual([
			{ id: 1n, name: 'Ann', manager: null },
			{ id: 2n, name: 'Bob', manager: { id: 1n, name: 'Ann' } },
			{ id: 3n, name: 'Cy', manager: { id: 1n, name: 'Ann' } },
		]);
		expect(rows[1]?.manager).not.toBe(rows[2]?.manager);
		expect(client.selects).toEqual([
			'select "users"."id", "users"."name", "users"."manager_id" from "users"',
			'select "users"."id", "users"."name" from "users" where "users"."id" in (?)',
		]);
		expect(client.calls[2]?.params).toEqual([1n]);
	});

	it('loads one-to-one in either direction, nested levels and a self relation', async () => {
		const client = fakeClient([
			[[1n, 'Ann']],
			[[1n, 'bio']],
			[[1n, 'Ann', null]],
			[[2n, 1n]],
			[[10, 'A1', 1n]],
			[[100, 'c1', 10]],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true, name: true },
			with: {
				profile: { with: { user: true } },
				reports: { columns: { id: true } },
				posts: { columns: { id: true, title: true }, with: { comments: { columns: { id: true, body: true } } } },
			},
		});
		expect(rows).toEqual([
			{
				id: 1n,
				name: 'Ann',
				profile: { userId: 1n, bio: 'bio', user: { id: 1n, name: 'Ann', managerId: null } },
				reports: [{ id: 2n }],
				posts: [{ id: 10, title: 'A1', comments: [{ id: 100, body: 'c1' }] }],
			},
		]);
		expect(client.selects).toEqual([
			'select "users"."id", "users"."name" from "users"',
			'select "profiles"."user_id", "profiles"."bio" from "profiles" where "profiles"."user_id" in (?)',
			'select "users"."id", "users"."name", "users"."manager_id" from "users" where "users"."id" in (?)',
			'select "users"."id", "users"."manager_id" from "users" where "users"."manager_id" in (?)',
			'select "posts"."id", "posts"."title", "posts"."author_id" from "posts" where "posts"."author_id" in (?)',
			'select "comments"."id", "comments"."body", "comments"."post_id" from "comments" where "comments"."post_id" in (?)',
		]);
	});

	it('loads many-to-many through the junction table with one statement per hop', async () => {
		const client = fakeClient([
			[[1n], [2n]],
			[
				[1n, 7],
				[2n, 7],
				[2n, 8],
			],
			[
				[7, 'admins'],
				[8, 'users'],
			],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { memberships: { columns: {}, with: { group: true } } },
		});
		expect(rows).toEqual([
			{ id: 1n, memberships: [{ group: { id: 7, name: 'admins' } }] },
			{ id: 2n, memberships: [{ group: { id: 7, name: 'admins' } }, { group: { id: 8, name: 'users' } }] },
		]);
		expect(client.selects).toEqual([
			'select "users"."id" from "users"',
			'select "memberships"."user_id", "memberships"."group_id" from "memberships" where "memberships"."user_id" in (?, ?)',
			'select "groups"."id", "groups"."name" from "groups" where "groups"."id" in (?, ?)',
		]);
	});

	it('matches composite keys with a row-value IN', async () => {
		const client = fakeClient([
			[
				['kr', 1, 'a'],
				['kr', 2, null],
				['us', 1, 'c'],
			],
			[
				[100, 5, 'kr', 1],
				[101, 6, 'us', 1],
				[102, 7, 'kr', 1],
			],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.orders.findMany({ with: { lines: { columns: { id: true, qty: true } } } });
		expect(rows).toEqual([
			{
				region: 'kr',
				num: 1,
				note: 'a',
				lines: [
					{ id: 100, qty: 5 },
					{ id: 102, qty: 7 },
				],
			},
			{ region: 'kr', num: 2, note: null, lines: [] },
			{ region: 'us', num: 1, note: 'c', lines: [{ id: 101, qty: 6 }] },
		]);
		expect(client.selects[1]).toBe(
			'select "lines"."id", "lines"."qty", "lines"."region", "lines"."num" from "lines" where ("lines"."region", "lines"."num") in ((?, ?), (?, ?), (?, ?))',
		);
		expect(client.calls[2]?.params).toEqual(['kr', 1, 'kr', 2, 'us', 1]);
	});

	it('applies root where, orderBy, limit and offset, and nested where and orderBy, in object and callback forms', async () => {
		const client = fakeClient([[[1n]], []]);
		const db = drizzle(client, { schema });
		await db.query.users.findMany({
			columns: { id: true },
			where: (u, { gt }) => gt(u.id, 0n),
			orderBy: (u, { desc }) => [desc(u.name), u.id],
			limit: 10,
			offset: 5,
			with: {
				posts: {
					columns: { id: true },
					where: sql`${posts.title} like ${'A%'}`,
					orderBy: posts.id,
				},
			},
		});
		expect(
			client.calls.filter((call) => call.method === 'queryPrepared').map(({ sql, params }) => [sql, params]),
		).toEqual([
			[
				'select "users"."id" from "users" where "users"."id" > ? order by "users"."name" desc, "users"."id" limit ? offset ?',
				[0n, 10, 5],
			],
			[
				'select "posts"."id", "posts"."author_id" from "posts" where ("posts"."author_id" in (?) and "posts"."title" like ?) order by "posts"."id"',
				[1n, 'A%'],
			],
		]);
	});

	it('ranks rows per parent with row_number() for a nested limit', async () => {
		const client = fakeClient([
			[[1n], [2n]],
			[
				[11, 1n],
				[21, 2n],
				[12, 1n],
			],
		]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, orderBy: desc(posts.id), limit: 2 } },
		});
		expect(rows).toEqual([
			{ id: 1n, posts: [{ id: 11 }, { id: 12 }] },
			{ id: 2n, posts: [{ id: 21 }] },
		]);
		expect(client.calls[2]).toMatchObject({
			sql: 'select "__rq"."f0", "__rq"."f1" from (select "posts"."id" as "f0", "posts"."author_id" as "f1", row_number() over (partition by "posts"."author_id" order by "posts"."id" desc) as "__rn" from "posts" where "posts"."author_id" in (?, ?)) "__rq" where "__rq"."__rn" <= ? order by "__rq"."__rn"',
			params: [1n, 2n, 2],
		});
	});

	it('ranks without an order when the nested limit has no orderBy', async () => {
		const client = fakeClient([[[1n]], []]);
		const db = drizzle(client, { schema });
		await db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: { id: true }, limit: 1 } } });
		expect(client.calls[2]?.sql).toBe(
			'select "__rq"."f0", "__rq"."f1" from (select "posts"."id" as "f0", "posts"."author_id" as "f1", row_number() over (partition by "posts"."author_id") as "__rn" from "posts" where "posts"."author_id" in (?)) "__rq" where "__rq"."__rn" <= ? order by "__rq"."__rn"',
		);
	});

	it('leaves out an offset of 0, which alone would need a limit', async () => {
		const client = fakeClient([[[1n]], []]);
		const db = drizzle(client, { schema });
		await db.query.users.findMany({
			columns: { id: true },
			offset: 0,
			with: { posts: { columns: { id: true } } },
		});
		expect(client.selects).toEqual([
			'select "users"."id" from "users"',
			'select "posts"."id", "posts"."author_id" from "posts" where "posts"."author_id" in (?)',
		]);
	});

	it('selects extras at the root and in nested levels, decoded with mapWith()', async () => {
		const client = fakeClient([[[1n, '3']], [[10, 2, 1n]]]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: true },
			extras: (u, { sql }) => ({ nameLength: sql<number>`char_length(${u.name})`.mapWith(Number).as('name_length') }),
			with: {
				posts: {
					columns: { id: true },
					extras: { titleLength: sql<number>`char_length(${posts.title})`.as('title_length') },
				},
			},
		});
		expect(rows).toEqual([{ id: 1n, nameLength: 3, posts: [{ id: 10, titleLength: 2 }] }]);
		expect(client.selects).toEqual([
			'select "users"."id", char_length("users"."name") from "users"',
			'select "posts"."id", char_length("posts"."title"), "posts"."author_id" from "posts" where "posts"."author_id" in (?)',
		]);
	});

	it('keeps an excluded key column out of the result while matching on it', async () => {
		const client = fakeClient([[['Ann', 1n]], [['A1', 1n]]]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({
			columns: { id: false, managerId: false },
			with: { posts: { columns: { title: true } } },
		});
		expect(rows).toEqual([{ name: 'Ann', posts: [{ title: 'A1' }] }]);
		expect(client.selects[0]).toBe('select "users"."name", "users"."id" from "users"');
	});

	it('sends no statement for a relation whose parents have no keys', async () => {
		const client = fakeClient([[]]);
		const db = drizzle(client, { schema });
		expect(await db.query.users.findMany({ with: { posts: { with: { comments: true } } } })).toEqual([]);
		expect(client.selects).toHaveLength(1);
	});

	it(`splits more than ${RELATIONAL_KEY_CHUNK} parent keys into one statement per chunk`, async () => {
		const parents = Array.from({ length: RELATIONAL_KEY_CHUNK + 5 }, (_, i) => [BigInt(i + 1)]);
		const client = fakeClient([parents, [[1, 1n]], [[2, BigInt(RELATIONAL_KEY_CHUNK + 5)]]]);
		const db = drizzle(client, { schema });
		const rows = await db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: { id: true } } } });
		expect(rows).toHaveLength(RELATIONAL_KEY_CHUNK + 5);
		expect(rows[0]).toEqual({ id: 1n, posts: [{ id: 1 }] });
		expect(rows.at(-1)).toEqual({ id: BigInt(RELATIONAL_KEY_CHUNK + 5), posts: [{ id: 2 }] });
		const params = client.calls.filter((call) => call.method === 'queryPrepared').map((call) => call.params?.length);
		expect(params).toEqual([0, RELATIONAL_KEY_CHUNK, 5]);
	});

	it('runs a relational query of a transaction on its connection, without another transaction', async () => {
		const client = fakeClient([[[1n]], [[10, 1n]]]);
		const db = drizzle(client, { schema });
		const rows = await db.transaction((tx) =>
			tx.query.users.findMany({ columns: { id: true }, with: { posts: { columns: { id: true } } } }),
		);
		expect(rows).toEqual([{ id: 1n, posts: [{ id: 10 }] }]);
		expect(client.calls.map(({ on, method }) => `${on}:${method}`)).toEqual([
			'tx:begin',
			'tx:queryPrepared',
			'tx:queryPrepared',
			'tx:commit',
		]);
	});

	it("refuses a client without transaction() unless relationalReads is 'separate'", async () => {
		const client = clientWithoutTransactions([]);
		await expect(drizzle(client, { schema }).query.users.findMany({ with: { posts: true } })).rejects.toThrow(
			/relationalReads: 'separate'/,
		);
		await expect(
			drizzle(client, { schema, relationalReads: 'client' }).query.users.findMany({ with: { posts: true } }),
		).rejects.toThrow(/relationalReads: 'client' needs a client with transaction\(\)/);
		const noOptions = {
			...fakeClient(),
			transaction: async <T>(callback: (tx: CubridNativeClient) => Promise<T>) => callback(fakeClient()),
		};
		await expect(drizzle(noOptions, { schema }).query.users.findMany({ with: { posts: true } })).rejects.toThrow(
			/transaction\(callback, options\)/,
		);
		expect(client.calls).toEqual([]);
		expect(noOptions.calls).toEqual([]);
		expect(() => drizzle(client, { relationalReads: 'always' as never })).toThrow(
			'Unknown relationalReads string "always"',
		);
	});

	it("runs the statements in a transaction at the client's own level with relationalReads: 'client'", async () => {
		const client = fakeClient([[[1n]], [[10, 1n]]]);
		await drizzle(client, { schema, relationalReads: 'client' }).query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true } } },
		});
		expect(client.calls.map(({ on, method, options }) => [`${on}:${method}`, options])).toEqual([
			['tx:begin', undefined],
			['tx:queryPrepared', { rowMode: 'array' }],
			['tx:queryPrepared', { rowMode: 'array' }],
			['tx:commit', undefined],
		]);
	});

	it("runs the statements one by one with relationalReads: 'separate'", async () => {
		const client = clientWithoutTransactions([[[1n]], [[10, 1n]]]);
		const db = drizzle(client, { schema, relationalReads: 'separate' });
		const rows = await db.query.users.findMany({ columns: { id: true }, with: { posts: { columns: { id: true } } } });
		expect(rows).toEqual([{ id: 1n, posts: [{ id: 10 }] }]);
		expect(client.calls.map(({ on, method }) => `${on}:${method}`)).toEqual([
			'client:queryPrepared',
			'client:queryPrepared',
		]);
	});

	it('rejects with the driver error of a failed statement, after rolling back', async () => {
		const failure = new Error('boom');
		const client = fakeClient([[[1n, 'Ann', null]], failure as never]);
		const db = drizzle(client, { schema });
		const error = await db.query.users
			.findMany({ with: { posts: true } })
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(error).toBe(failure);
		expect(client.calls.at(-1)?.sql).toBe('ROLLBACK');
	});

	it('uses literal binding when asked', async () => {
		const client = fakeClient([[[1n]], []]);
		const db = drizzle(client, { schema, binding: 'literal' });
		await db.query.users.findMany({ columns: { id: true }, with: { posts: true } });
		expect(client.calls.filter((call) => call.method === 'query')).toHaveLength(2);
	});
});

describe('keys and config edge cases', () => {
	const accounts = cubridTable('accounts', { id: bigint({ mode: 'bigint' }).primaryKey() });
	const scores = cubridTable('scores', {
		id: integer().primaryKey(),
		accountId: integer('account_id').notNull(),
		tags: set({ element: integer() }),
	});
	const local = {
		accounts,
		scores,
		accountsRelations: relations(accounts, ({ many }) => ({ scores: many(scores, { relationName: 'scores' }) })),
		scoresRelations: relations(scores, ({ one }) => ({
			account: one(accounts, { fields: [scores.accountId], references: [accounts.id], relationName: 'scores' }),
			byTags: one(accounts, { fields: [scores.tags], references: [accounts.id], relationName: 'tags' }),
		})),
	};

	it('encodes parent keys with the parent column, so a BIGINT key matches an INTEGER reference', async () => {
		const client = fakeClient([[[1n], [2n]], [[10, 1, null, 1n]]]);
		const rows = await drizzle(client, { schema: local }).query.accounts.findMany({ with: { scores: true } });
		expect(rows).toEqual([
			{ id: 1n, scores: [{ id: 10, accountId: 1, tags: null }] },
			{ id: 2n, scores: [] },
		]);
		expect(client.calls[2]).toMatchObject({
			sql: 'select "scores"."id", "scores"."account_id", "scores"."tags", cast("scores"."account_id" as BIGINT) from "scores" where "scores"."account_id" in (?, ?)',
			params: [1n, 2n],
		});
	});

	it('matches CHAR keys of other lengths and NUMERIC keys of other scales on the cast parent type', async () => {
		const codes = cubridTable('codes', {
			code: char({ length: 5 }).primaryKey(),
			amount: numeric({ precision: 10, scale: 2 }),
		});
		const items = cubridTable('items', {
			id: integer().primaryKey(),
			code: char({ length: 10 }),
			amount: numeric({ precision: 10, scale: 3 }),
		});
		const keyed = {
			codes,
			items,
			codesRelations: relations(codes, ({ many }) => ({
				byCode: many(items, { relationName: 'code' }),
				byAmount: many(items, { relationName: 'amount' }),
			})),
			itemsRelations: relations(items, ({ one }) => ({
				code: one(codes, { fields: [items.code], references: [codes.code], relationName: 'code' }),
				amount: one(codes, { fields: [items.amount], references: [codes.amount], relationName: 'amount' }),
			})),
		};
		const client = fakeClient([
			[['ab   ', '1.50']],
			[[10, 'ab        ', '1.500', 'ab   ']],
			[[10, 'ab        ', '1.500', '1.50']],
		]);
		const rows = await drizzle(client, { schema: keyed }).query.codes.findMany({
			with: { byCode: true, byAmount: true },
		});
		const item = { id: 10, code: 'ab        ', amount: '1.500' };
		expect(rows).toEqual([{ code: 'ab   ', amount: '1.50', byCode: [item], byAmount: [item] }]);
		expect(client.selects.slice(1)).toEqual([
			'select "items"."id", "items"."code", "items"."amount", cast("items"."code" as CHAR(5)) from "items" where "items"."code" in (cast(? as CHAR(5)))',
			'select "items"."id", "items"."code", "items"."amount", cast("items"."amount" as NUMERIC(10,2)) from "items" where "items"."amount" in (?)',
		]);
	});

	it('refuses key columns of types that cannot be matched reliably', async () => {
		const parents = cubridTable('kp', { code: char({ length: 5 }).primaryKey() });
		const children = cubridTable('kc', { id: integer().primaryKey(), code: varchar({ length: 5 }) });
		const mixed = {
			parents,
			children,
			parentsRelations: relations(parents, ({ many }) => ({ children: many(children) })),
			childrenRelations: relations(children, ({ one }) => ({
				parent: one(parents, { fields: [children.code], references: [parents.code] }),
			})),
		};
		const client = fakeClient();
		await expect(
			drizzle(client, { schema: mixed }).query.parents.findMany({ with: { children: true } }),
		).rejects.toThrow(
			'parents.children: key code (CHAR(5)) and code (VARCHAR(5)) have types that cannot be matched reliably',
		);
		expect(client.calls).toEqual([]);
	});

	it('rejects a failed statement of its own transaction with the QueryError class it has outside one', async () => {
		const cause = new Error('Failed to execute CUBRID query.');
		const failure = Object.assign(new TransactionError('Transaction query failed.', { cause }), {
			code: -494,
			kind: 'syntax',
			origin: 'server',
		});
		const client = fakeClient([[[1n, 'Ann', null]], failure as never]);
		const error = await drizzle(client, { schema })
			.query.users.findMany({ with: { posts: true } })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SqlSyntaxError);
		expect(error).toBeInstanceOf(QueryError);
		expect(error).toMatchObject({ message: 'Query failed.', code: -494, kind: 'syntax', origin: 'server', cause });
		expect((error as Error).name).toBe(new SqlSyntaxError('x').name);
		expect((error as Error).name).not.toBe(failure.name);
		expect((error as { transactionError?: unknown }).transactionError).toBe(failure);
		const plain = Object.assign(new TransactionError('Transaction query failed.', { cause }), { kind: 'other' });
		const second = fakeClient([[[1n, 'Ann', null]], plain as never]);
		const other = await drizzle(second, { schema })
			.query.users.findMany({ with: { posts: true } })
			.catch((e: unknown) => e);
		expect(other).toBeInstanceOf(QueryError);
		expect(other).not.toBeInstanceOf(SqlSyntaxError);
	});

	it('refuses a collection column as a relation key before sending anything', async () => {
		const client = fakeClient();
		await expect(drizzle(client, { schema: local }).query.scores.findMany({ with: { byTags: true } })).rejects.toThrow(
			'scores.byTags: tags is a collection column, which cannot be a relation key',
		);
		expect(client.calls).toEqual([]);
	});

	it('treats columns: undefined as every column and skips falsy with entries, as Drizzle does', async () => {
		const client = fakeClient([[[1n, 'Ann', null]]]);
		const rows = await drizzle(client, { schema }).query.users.findMany({
			columns: undefined,
			with: { posts: null, profile: false } as never,
		});
		expect(rows).toEqual([{ id: 1n, name: 'Ann', managerId: null }]);
		expect(client.selects).toEqual(['select "users"."id", "users"."name", "users"."manager_id" from "users"']);
	});

	it('ignores inherited names in columns and with', async () => {
		const client = fakeClient();
		await expect(
			drizzle(client, { schema }).query.users.findMany({ with: { toString: true } as never }),
		).rejects.toThrow('users: users has no relation toString');
	});
});

describe('findFirst', () => {
	it('selects with limit 1 and resolves to the first row or undefined', async () => {
		const client = fakeClient([[[1n, 'Ann', null]], []]);
		const db = drizzle(client, { schema });
		expect(await db.query.users.findFirst({ where: (u, { eq }) => eq(u.name, 'Ann') })).toEqual({
			id: 1n,
			name: 'Ann',
			managerId: null,
		});
		expect(await db.query.users.findFirst()).toBeUndefined();
		expect(client.calls.map(({ sql, params }) => [sql, params])).toEqual([
			[
				'select "users"."id", "users"."name", "users"."manager_id" from "users" where "users"."name" = ? limit ?',
				['Ann', 1],
			],
			['select "users"."id", "users"."name", "users"."manager_id" from "users" limit ?', [1]],
		]);
	});
});

describe('prepare() (#165)', () => {
	it('plans once and runs every execution with its own placeholder values, limits included', async () => {
		const client = fakeClient([[[1n], [2n]], [[11, 1n]], [[3n]], [[31, 3n]]]);
		const db = drizzle(client, { schema });
		let planned = 0;
		const prepared = db.query.users
			.findMany({
				columns: { id: true },
				where: (u, { gt }) => {
					planned++;
					return gt(u.id, sql.placeholder('min'));
				},
				limit: sql.placeholder('n'),
				offset: sql.placeholder('skip'),
				with: {
					posts: {
						columns: { id: true },
						where: (p, { ne }) => ne(p.title, sql.placeholder('title')),
						limit: sql.placeholder('per'),
					},
				},
			})
			.prepare();
		expect(await prepared.execute({ min: 0n, n: 2, skip: 0, title: 'x', per: 1, unused: true })).toEqual([
			{ id: 1n, posts: [{ id: 11 }] },
			{ id: 2n, posts: [] },
		]);
		expect(await prepared.execute({ min: 2n, n: 5, skip: 1, title: 'y', per: 3 })).toEqual([
			{ id: 3n, posts: [{ id: 31 }] },
		]);
		expect(planned).toBe(1);
		const selects = client.calls.filter((call) => call.method === 'queryPrepared');
		expect(selects.map(({ sql, params }) => [sql, params])).toEqual([
			['select "users"."id" from "users" where "users"."id" > ? limit ?', [0n, 2]],
			[
				'select "__rq"."f0", "__rq"."f1" from (select "posts"."id" as "f0", "posts"."author_id" as "f1", row_number() over (partition by "posts"."author_id") as "__rn" from "posts" where ("posts"."author_id" in (?, ?) and "posts"."title" <> ?)) "__rq" where "__rq"."__rn" <= ? order by "__rq"."__rn"',
				[1n, 2n, 'x', 1],
			],
			['select "users"."id" from "users" where "users"."id" > ? limit ? offset ?', [2n, 5, 1]],
			[
				'select "__rq"."f0", "__rq"."f1" from (select "posts"."id" as "f0", "posts"."author_id" as "f1", row_number() over (partition by "posts"."author_id") as "__rn" from "posts" where ("posts"."author_id" in (?) and "posts"."title" <> ?)) "__rq" where "__rq"."__rn" <= ? order by "__rq"."__rn"',
				[3n, 'y', 3],
			],
		]);
		// One repeatable read transaction per execution.
		expect(client.calls.filter((call) => call.method === 'begin')).toHaveLength(2);
	});

	it('prepares findFirst with limit 1', async () => {
		const client = fakeClient([[[1n, 'Ann', null]], []]);
		const db = drizzle(client, { schema });
		const prepared = db.query.users.findFirst({ where: (u, { eq }) => eq(u.name, sql.placeholder('name')) }).prepare();
		expect(await prepared.execute({ name: 'Ann' })).toEqual({ id: 1n, name: 'Ann', managerId: null });
		expect(await prepared.execute({ name: 'Nobody' })).toBeUndefined();
		expect(client.calls.map(({ params }) => params)).toEqual([
			['Ann', 1],
			['Nobody', 1],
		]);
	});
});

describe('refusals before anything is sent', () => {
	type Db = ReturnType<typeof drizzle<ReturnType<typeof fakeClient>, typeof schema>>;
	const refused = async (run: (db: Db) => Promise<unknown>) => {
		const client = fakeClient();
		const error = await run(drizzle(client, { schema })).catch((e: unknown) => e);
		expect(client.calls).toEqual([]);
		return error;
	};

	it.each([
		[
			'offset without limit at the root',
			(db) => db.query.users.findMany({ offset: 2 }),
			/CUBRID needs a limit with offset/,
		],
		[
			'a placeholder limit without a value',
			(db) => db.query.users.findMany({ limit: sql.placeholder('n') }),
			/No value for placeholder "n" was provided/,
		],
		[
			'a placeholder limit that is not a non-negative integer',
			(db) =>
				db.query.users
					.findMany({ limit: sql.placeholder('n') })
					.prepare()
					.execute({ n: -1 }),
			/users: limit \(placeholder "n"\) must be a non-negative integer, not number -1/,
		],
		[
			'a nested placeholder limit without a value, before the root is sent',
			(db) =>
				db.query.users
					.findMany({ with: { posts: { limit: sql.placeholder('n') } } })
					.prepare()
					.execute(),
			/No value for placeholder "n" was provided/,
		],
		[
			'a nested where placeholder without a value, before the root is sent',
			(db) =>
				db.query.users
					.findMany({ with: { posts: { where: (p, { eq }) => eq(p.title, sql.placeholder('t')) } } })
					.prepare()
					.execute({}),
			/No value for placeholder "t" was provided/,
		],
		[
			'placeholder values that are not an object',
			(db) =>
				db.query.users
					.findMany()
					.prepare()
					.execute(1 as never),
			/Placeholder values must be an object keyed by placeholder name, not number 1/,
		],
		[
			'a placeholder in where',
			(db) => db.query.users.findMany({ where: (u, { eq }) => eq(u.name, sql.placeholder('name')) }),
			/No value for placeholder "name"/,
		],
		['a negative limit', (db) => db.query.users.findMany({ limit: -1 }), /limit must be a non-negative integer/],
		[
			'a nested limit on a one relation',
			(db) => db.query.posts.findMany({ with: { author: { limit: 1 } as never } }),
			/posts\.author: a one relation takes no limit, as in Drizzle's types/,
		],
		[
			'where or orderBy on a one relation',
			(db) => db.query.posts.findMany({ with: { author: { where: sql`1 = 1`, orderBy: posts.id } as never } }),
			/posts\.author: a one relation takes no where or orderBy/,
		],
		[
			'a nested offset',
			(db) => db.query.users.findMany({ with: { posts: { limit: 1, offset: 1 } as never } }),
			/users\.posts: a nested many relation takes no offset/,
		],
		[
			'an unknown relation',
			(db) => db.query.users.findMany({ with: { nope: true } as never }),
			/users: users has no relation nope/,
		],
		[
			'an unknown option',
			(db) => db.query.users.findMany({ having: sql`1` } as never),
			/unknown relational query option 'having'/,
		],
		[
			'an extra without .as()',
			(db) => db.query.users.findMany({ extras: { n: sql`1` } as never }),
			/extra n must be a sql expression with \.as/,
		],
		['no fields', (db) => db.query.users.findMany({ columns: {} }), /users: no fields selected for users/],
		[
			'a where that is not sql',
			(db) => db.query.users.findMany({ where: 'id = 1' as never }),
			/where must be a sql condition/,
		],
		[
			'an orderBy that is not a column or sql',
			(db) => db.query.users.findMany({ orderBy: 'id' as never }),
			/orderBy takes columns and sql/,
		],
		[
			'a with that is not an object',
			(db) => db.query.users.findMany({ with: { posts: 1 } as never }),
			/users\.posts: with must be an object/,
		],
	] satisfies [string, (db: Db) => Promise<unknown>, RegExp][])('%s', async (_, run, message) => {
		expect(await refused(run)).toMatchObject({ message: expect.stringMatching(message) });
	});

	it('refuses iterator() on a relational query (#165)', () => {
		const client = fakeClient();
		const db = drizzle(client, { schema });
		expect(() => db.query.users.findMany().iterator()).toThrow(/iterator\(\) is not supported on relational queries/);
		expect(client.calls).toEqual([]);
	});

	it('refuses at prepare() what an awaited query refuses', () => {
		const db = drizzle(fakeClient(), { schema });
		expect(() => db.query.users.findMany({ offset: 2 }).prepare()).toThrow(/CUBRID needs a limit with offset/);
		expect(() => db.query.users.findMany({ limit: 'x' as never }).prepare()).toThrow(
			/limit must be a non-negative integer/,
		);
	});

	it('refuses a schema with a table that is not native', async () => {
		const { Table } = await import('drizzle-orm/table');
		expect(() => drizzle(fakeClient(), { schema: { other: new Table('o', undefined, 'o') } })).toThrow(
			'schema.other is not a drizzle-cubrid/native table',
		);
	});

	it('has no query builders without a schema', () => {
		expect(drizzle(fakeClient()).query).toEqual({});
	});

	it('refuses a relation to a table outside the schema', async () => {
		const { relations } = await import('drizzle-orm');
		const outside = cubridTable('outside', { id: integer().primaryKey() });
		const inside = cubridTable('inside', { id: integer().primaryKey(), outsideId: integer() });
		const insideRelations = relations(inside, ({ one }) => ({
			outside: one(outside, { fields: [inside.outsideId], references: [outside.id] }),
		}));
		const client = fakeClient();
		const db = drizzle(client, { schema: { inside, insideRelations } });
		await expect(db.query.inside.findMany({ with: { outside: true } })).rejects.toThrow(
			'inside.outside: table outside is not in the schema',
		);
		expect(client.calls).toEqual([]);
	});
});
