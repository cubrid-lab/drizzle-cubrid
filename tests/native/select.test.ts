// Native SELECT (#158) and session (#160) with a fake client: golden SQL for
// every builder method and refusal, row mapping by position, binding,
// placeholders, error passthrough and the UTC-decoding guard.
import { and, asc, count, desc, eq, gt, inArray, sql, sum } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { orderSelectedFields } from '../../src/native/dialect';
import {
	bigint,
	boolean,
	type CubridSelectedFields,
	cubridTable,
	date,
	datetime,
	drizzle,
	integer,
	multiset,
	numeric,
	set,
	time,
	varchar,
} from '../../src/native/index';
import { declaredClientZone, isProcessZoneUtc, NOT_UTC_MESSAGE, ZONE_PROBE_SQL } from '../../src/native/timezone';

const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey(),
	name: varchar({ length: 50 }).notNull(),
	active: boolean(),
});
const posts = cubridTable('posts', {
	id: integer().primaryKey(),
	authorId: bigint('author_id', { mode: 'bigint' }),
	title: varchar({ length: 50 }).notNull(),
	price: numeric({ precision: 10, scale: 2 }),
	at: datetime(),
	tags: set({ element: varchar({ length: 10 }) }),
	days: multiset({ element: date() }),
});
const plain = cubridTable('plain', { id: integer(), clock: time() });

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

type Call = { method: string; sql: string; params: readonly unknown[] | undefined; options: unknown };

/** A cubrid-client stand-in: records calls and returns the queued results in order. */
function fakeClient(results: unknown[][] = [], extra: Record<string, unknown> = { timezone: 'utc' }) {
	const calls: Call[] = [];
	const queue = [...results];
	const respond = (method: string) => async (sql: string, params?: readonly unknown[], options?: unknown) => {
		calls.push({ method, sql, params, options });
		const next = queue.shift() ?? [];
		if (next instanceof Error) throw next;
		return next;
	};
	return { calls, query: respond('query'), queryPrepared: respond('queryPrepared'), ...extra };
}

const db = drizzle(fakeClient());

describe('golden SQL', () => {
	it.each([
		['select()', db.select().from(users), 'select "users"."id", "users"."name", "users"."active" from "users"', []],
		[
			'selectDistinct(fields)',
			db.selectDistinct({ name: users.name }).from(users),
			'select distinct "users"."name" from "users"',
			[],
		],
		[
			'where with operators',
			db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.name, 'a'), gt(users.id, 5n))),
			'select "users"."id" from "users" where ("users"."name" = ? and "users"."id" > ?)',
			['a', 5n],
		],
		[
			'inner join',
			db.select({ n: users.name, t: posts.title }).from(users).innerJoin(posts, eq(users.id, posts.authorId)),
			'select "users"."name", "posts"."title" from "users" inner join "posts" on "users"."id" = "posts"."author_id"',
			[],
		],
		[
			'left join',
			db.select({ id: users.id }).from(users).leftJoin(posts, eq(users.id, posts.authorId)),
			'select "users"."id" from "users" left join "posts" on "users"."id" = "posts"."author_id"',
			[],
		],
		[
			'right join',
			db.select({ id: users.id }).from(users).rightJoin(posts, eq(users.id, posts.authorId)),
			'select "users"."id" from "users" right join "posts" on "users"."id" = "posts"."author_id"',
			[],
		],
		[
			'cross join',
			db.select({ id: users.id }).from(users).crossJoin(posts),
			'select "users"."id" from "users" cross join "posts"',
			[],
		],
		[
			'group by, having, order by, limit and offset',
			db
				.select({ a: posts.authorId, n: count(), total: sum(posts.price) })
				.from(posts)
				.groupBy(posts.authorId)
				.having(({ n }) => gt(n, 1))
				.orderBy(desc(posts.authorId), asc(sql`2`))
				.limit(10)
				.offset(20),
			'select "posts"."author_id", count(*), sum("posts"."price") from "posts" group by "posts"."author_id" having count(*) > ? order by "posts"."author_id" desc, 2 asc limit ? offset ?',
			[1, 10, 20],
		],
		[
			'order by and group by callbacks',
			db
				.select({ a: posts.authorId, n: count().as('n') })
				.from(posts)
				.groupBy(({ a }) => a)
				.orderBy(({ n }) => [desc(n)]),
			'select "posts"."author_id", count(*) as "n" from "posts" group by "posts"."author_id" order by "n" desc',
			[],
		],
		[
			'for update',
			db.select({ id: users.id }).from(users).where(eq(users.id, 1n)).for('update'),
			'select "users"."id" from "users" where "users"."id" = ? for update',
			[1n],
		],
		[
			'inArray and a scalar subquery',
			db
				.select({ id: users.id })
				.from(users)
				.where(inArray(users.id, db.select({ a: posts.authorId }).from(posts))),
			'select "users"."id" from "users" where "users"."id" in (select "posts"."author_id" from "posts")',
			[],
		],
		[
			'quoted identifiers',
			db.select().from(cubridTable('we"ird', { 'co"l': integer() })),
			'select "we""ird"."co""l" from "we""ird"',
			[],
		],
		[
			'codecs in parameters',
			db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.active, true), eq(posts.at, new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6))))),
			'select "users"."id" from "users" where ("users"."active" = ? and "posts"."at" = ?)',
			[1, '2024-01-02 03:04:05.006'],
		],
	])('%s', (_label, query, text, params) => {
		expect(query.toSQL()).toEqual({ sql: text, params });
	});

	it('renders subqueries in from() and joins, with every field named by key path and qualified', () => {
		const sq = db
			.select({ authorId: posts.authorId, n: sql<number>`count(*)`.mapWith(Number).as('n') })
			.from(posts)
			.groupBy(posts.authorId)
			.as('sq');
		const inner =
			'(select "posts"."author_id" as "authorId", count(*) as "n" from "posts" group by "posts"."author_id") "sq"';
		expect(db.select().from(sq).where(gt(sq.n, 1)).orderBy(desc(sq.n)).toSQL()).toEqual({
			sql: `select "sq"."authorId", "sq"."n" from ${inner} where "sq"."n" > ? order by "sq"."n" desc`,
			params: [1],
		});
		expect(
			db
				.select({ name: users.name, n: sq.n })
				.from(users)
				.leftJoin(sq, eq(users.id, sq.authorId))
				.having(gt(sq.n, 0))
				.toSQL(),
		).toEqual({
			sql: `select "users"."name", "sq"."n" from "users" left join ${inner} on "users"."id" = "sq"."authorId" having "sq"."n" > ?`,
			params: [0],
		});
	});

	it('names subquery fields by key path, so joined tables sharing column names stay apart (review item 4)', () => {
		const pets = cubridTable('pets', { id: integer().primaryKey(), ownerId: bigint('owner_id', { mode: 'bigint' }) });
		const all = db.select().from(users).innerJoin(pets, eq(users.id, pets.ownerId)).as('s3');
		expect(db.select().from(all).where(eq(all.pets.id, 1)).toSQL().sql).toBe(
			'select "s3"."users.id", "s3"."users.name", "s3"."users.active", "s3"."pets.id", "s3"."pets.ownerId" from (select "users"."id" as "users.id", "users"."name" as "users.name", "users"."active" as "users.active", "pets"."id" as "pets.id", "pets"."owner_id" as "pets.ownerId" from "users" inner join "pets" on "users"."id" = "pets"."owner_id") "s3" where "s3"."pets.id" = ?',
		);
		const pair = db
			.select({ a: users.id, b: pets.id })
			.from(users)
			.innerJoin(pets, eq(users.id, pets.ownerId))
			.as('s2');
		expect(db.select().from(pair).toSQL().sql).toMatch(
			/^select "s2"."a", "s2"."b" from \(select "users"."id" as "a", "pets"."id" as "b" /,
		);
		expect(() => db.select({ a: users.id, A: users.name }).from(users).as('s')).toThrow(
			/Subquery fields a and A have the same name ignoring case/,
		);
	});

	it('qualifies subquery sql fields in conditions (review item 3)', () => {
		const sq2 = db
			.select({ uid: users.id, label: sql<string>`upper(${users.name})`.as('name') })
			.from(users)
			.as('sq2');
		expect(
			db
				.select({ id: posts.id, l: sq2.label })
				.from(posts)
				.innerJoin(sq2, eq(posts.authorId, sq2.uid))
				.where(eq(sq2.label, 'ALICE'))
				.toSQL(),
		).toEqual({
			sql: 'select "posts"."id", "sq2"."label" from "posts" inner join (select "users"."id" as "uid", upper("users"."name") as "label" from "users") "sq2" on "posts"."author_id" = "sq2"."uid" where "sq2"."label" = ?',
			params: ['ALICE'],
		});
	});

	it('renders placeholders as ? and keeps them for prepare()', () => {
		const q = db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, sql.placeholder('id')))
			.limit(sql.placeholder('n'));
		const { sql: text, params } = q.toSQL();
		expect(text).toBe('select "users"."id" from "users" where "users"."id" = ? limit ?');
		expect(params).toHaveLength(2);
	});

	it('keeps where() and friends on the same query, as Drizzle does', () => {
		const q = db.select({ id: users.id }).from(users).$dynamic();
		q.where(eq(users.id, 1n));
		expect(q.toSQL().sql).toBe('select "users"."id" from "users" where "users"."id" = ?');
		expect(db.select({ id: users.id }).from(users).where(undefined).toSQL().sql).toBe(
			'select "users"."id" from "users"',
		);
	});
});

describe('refusals', () => {
	it('refuses offset() without limit()', () => {
		expect(() => db.select().from(users).offset(5).toSQL()).toThrow(/CUBRID needs limit\(\) with offset\(\)/);
	});

	it('refuses lock strengths and options CUBRID lacks', () => {
		// @ts-expect-error not supported
		expect(() => db.select().from(users).for('share')).toThrow(/CUBRID supports only FOR UPDATE, not for\('share'\)/);
		// @ts-expect-error not supported
		expect(() => db.select().from(users).for('update', { skipLocked: true })).toThrow(
			/takes no options \(skipLocked\)/,
		);
		expect(() => db.selectDistinct().from(users).for('update').toSQL()).toThrow(
			/FOR UPDATE with DISTINCT, GROUP BY or HAVING/,
		);
		expect(() => db.select({ n: count() }).from(users).groupBy(users.name).for('update').toSQL()).toThrow(/-494/);
	});

	it('refuses collection values in conditions until #159', async () => {
		expect(() =>
			db
				.select()
				.from(posts)
				.where(eq(posts.tags, ['a']))
				.toSQL(),
		).toThrow(/Comparing SET column tags with a value is not supported yet: .*#159/);
		const client = fakeClient();
		const placeholderDb = drizzle(client);
		const prepared = placeholderDb
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.tags, sql.placeholder('t')))
			.prepare();
		await expect(prepared.execute({ t: ['a'] })).rejects.toThrow(
			/Parameter 1 is an array, which cannot be bound; .*#159/,
		);
		await expect(placeholderDb.execute(sql`select ${sql.param(['a'])}`)).rejects.toThrow(/Parameter 1 is an array/);
		expect(client.calls).toEqual([]);
		const inner = db
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.days, [new Date()]))
			.as('sq');
		expect(() => db.select().from(inner).toSQL()).toThrow(/MULTISET column days/);
		expect(db.select({ id: posts.id }).from(posts).where(sql`${posts.tags} is null`).toSQL().sql).toContain('is null');
	});

	it('refuses sources and fields it does not know', () => {
		// @ts-expect-error not a native table
		expect(() => db.select().from(sql`users`)).toThrow(/from\(\) needs a drizzle-cubrid\/native table or a subquery/);
		// @ts-expect-error not a native table
		expect(() => db.select().from(users).innerJoin({}, undefined)).toThrow(/inner join needs/);
		expect(() => db.select().from(users).innerJoin(users, undefined)).toThrow(/users is already used in this query/);
		// @ts-expect-error not a field
		expect(() => db.select({ x: 1 }).from(users).toSQL()).toThrow(/Selected field x is number 1, not a column or sql/);
		const sq = db.select({ id: users.id }).from(users).as('sq');
		// drizzle-orm 0.45 types allow a one-field subquery here (0.44 does not); scalar subqueries are a later slice.
		expect(() =>
			db
				.select({ sq } as unknown as CubridSelectedFields)
				.from(users)
				.toSQL(),
		).toThrow(/Selected field sq is a subquery/);
		expect(() => db.select({}).from(users).toSQL()).toThrow(/at least one field/);
		expect(() => db.select({ v: sql`1` }).from(users).as('s')).toThrow(/Subquery field v is raw sql without a name/);
		expect(() => db.select({ _: users.id }).from(users).as('s')).toThrow(/cannot be named _/);
	});
});

describe('execution and row mapping', () => {
	it('sends typed binds with rowMode array and maps rows by position', async () => {
		const client = fakeClient([[[1n, 'a', 1]]]);
		const rows = await drizzle(client).select().from(users).where(eq(users.id, 1n));
		expect(rows).toEqual([{ id: 1n, name: 'a', active: true }]);
		expect(client.calls).toEqual([
			{
				method: 'queryPrepared',
				sql: 'select "users"."id", "users"."name", "users"."active" from "users" where "users"."id" = ?',
				params: [1n],
				options: { rowMode: 'array' },
			},
		]);
	});

	it("uses query() with binding: 'literal'", async () => {
		const client = fakeClient([[[2n]]]);
		expect(await drizzle(client, { binding: 'literal' }).select({ id: users.id }).from(users)).toEqual([{ id: 2n }]);
		expect(client.calls[0]?.method).toBe('query');
	});

	it('keeps duplicate labels apart and nulls an unmatched left join', async () => {
		const client = fakeClient([
			[
				[1n, 'a', null, 10, 1n, 'p', '1.50', null, null, null],
				[2n, 'b', 0, null, null, null, null, null, null, null],
			],
		]);
		const rows = await drizzle(client).select().from(users).leftJoin(posts, eq(users.id, posts.authorId));
		expect(rows).toEqual([
			{
				users: { id: 1n, name: 'a', active: null },
				posts: { id: 10, authorId: 1n, title: 'p', price: '1.50', at: null, tags: null, days: null },
			},
			{ users: { id: 2n, name: 'b', active: false }, posts: null },
		]);
	});

	it('nulls the earlier tables of a right join and keeps partial nested objects', async () => {
		const client = fakeClient([[[null, null, 'r', 12]]]);
		const rows = await drizzle(client)
			.select({ u: { id: users.id, name: users.name }, p: { title: posts.title, id: posts.id } })
			.from(users)
			.rightJoin(posts, eq(users.id, posts.authorId));
		expect(rows).toEqual([{ u: null, p: { title: 'r', id: 12 } }]);
	});

	it('decides nullability from column fields only, as Drizzle does (review items 1, 2)', async () => {
		// A left-joined table's columns are all NULL: the object is null even though a sql field has a value.
		const mixed = fakeClient([[['a', null, 1]]]);
		const rows = await drizzle(mixed)
			.select({ u: users.name, post: { title: posts.title, one: sql<number>`1`.mapWith(Number) } })
			.from(users)
			.leftJoin(posts, eq(users.id, posts.authorId));
		expect(rows).toEqual([{ u: 'a', post: null }]);
		// A non-NULL column of the same table keeps the object.
		const matched = fakeClient([[['a', 't', null]]]);
		expect(
			await drizzle(matched)
				.select({ u: users.name, post: { title: posts.title, price: posts.price } })
				.from(users)
				.leftJoin(posts, eq(users.id, posts.authorId)),
		).toEqual([{ u: 'a', post: { title: 't', price: null } }]);
		// Columns of two tables in one object: never nulled.
		const client = fakeClient([[[null, null, null]]]);
		expect(
			await drizzle(client)
				.select({ o: { a: users.id, b: posts.id, c: sql`1` } })
				.from(users)
				.leftJoin(posts, eq(users.id, posts.authorId)),
		).toEqual([{ o: { a: null, b: null, c: null } }]);
		// An object of plain sql fields only is never nulled.
		const onlySql = fakeClient([[[1n, null]]]);
		expect(
			await drizzle(onlySql)
				.select({ id: users.id, o: { c: sql`null` } })
				.from(users)
				.leftJoin(posts, eq(users.id, posts.authorId)),
		).toEqual([{ id: 1n, o: { c: null } }]);
	});

	it('nulls an unmatched left-joined subquery, sql fields included (review item 1)', async () => {
		const sq2 = db
			.select({ uid: users.id, label: sql<string>`upper(${users.name})`.as('name') })
			.from(users)
			.as('sq2');
		const client = fakeClient([
			[
				[1n, 'a', null, null, null],
				[2n, 'b', 0, 2n, 'B'],
			],
		]);
		const rows = await drizzle(client)
			.select()
			.from(users)
			.leftJoin(sq2, eq(users.id, sql`${sq2.uid} + 100`));
		expect(rows).toEqual([
			{ users: { id: 1n, name: 'a', active: null }, sq2: null },
			{ users: { id: 2n, name: 'b', active: false }, sq2: { uid: 2n, label: 'B' } },
		]);
	});

	it('keeps an inner-joined object whose values are NULL', async () => {
		const inner = fakeClient([[[null, null]]]);
		expect(
			await drizzle(inner)
				.select({ o: { a: users.id, b: users.name } })
				.from(users),
		).toEqual([{ o: { a: null, b: null } }]);
	});

	it('decodes sql fields with mapWith and leaves others as sent', async () => {
		const client = fakeClient([[[3n, 3n, '2.50', 'x']]]);
		const rows = await drizzle(client)
			.select({ n: count(), raw: sql`count(*)`, total: sum(posts.price), title: sql`x`.mapWith(posts.title).as('t') })
			.from(posts);
		expect(rows).toEqual([{ n: 3, raw: 3n, total: '2.50', title: 'x' }]);
	});

	it('maps subquery fields with their decoders', async () => {
		const client = fakeClient([[[5n, 2n]]]);
		const sq = db
			.select({ a: posts.authorId, n: sql<number>`count(*)`.mapWith(Number).as('n') })
			.from(posts)
			.groupBy(posts.authorId)
			.as('sq');
		expect(await drizzle(client).select().from(sq)).toEqual([{ a: 5n, n: 2 }]);
		const nested = db.select({ id: users.id, u: users }).from(users).as('nested');
		expect(orderSelectedFields(nested._.selectedFields).map((f) => f.path.join('.'))).toEqual([
			'id',
			'u.id',
			'u.name',
			'u.active',
		]);
	});

	it('re-points nested subquery fields at the alias', async () => {
		const sq = db
			.select({ id: users.id, info: { name: users.name, n: sql<number>`1`.mapWith(Number).as('n') } })
			.from(users)
			.as('nested_sq');
		const q = drizzle(fakeClient([[[1n, 'a', 1]]]))
			.select()
			.from(sq);
		expect(q.toSQL().sql).toBe(
			'select "nested_sq"."id", "nested_sq"."info.name", "nested_sq"."info.n" from (select "users"."id" as "id", "users"."name" as "info.name", 1 as "info.n" from "users") "nested_sq"',
		);
		expect(await q).toEqual([{ id: 1n, info: { name: 'a', n: 1 } }]);
	});

	it('returns an empty array for no rows', async () => {
		expect(
			await drizzle(fakeClient([[]]))
				.select()
				.from(users),
		).toEqual([]);
	});

	it('runs prepared queries with placeholder values, encoded by the column', async () => {
		const client = fakeClient([[[1n, 'a', null]], [[2n, 'b', null]]]);
		const prepared = drizzle(client)
			.select()
			.from(users)
			.where(and(eq(users.id, sql.placeholder('id')), eq(users.active, sql.placeholder('on'))))
			.prepare();
		expect(await prepared.execute({ id: 1n, on: true })).toEqual([{ id: 1n, name: 'a', active: null }]);
		await prepared.execute({ id: 2n, on: false });
		// As in Drizzle's other dialects, a placeholder's value is sent as given:
		// the column codec is not applied to it.
		expect(client.calls.map((c) => c.params)).toEqual([
			[1n, true],
			[2n, false],
		]);
		await expect(prepared.execute({ id: 3n })).rejects.toThrow(/No value for placeholder "on"/);
	});

	it('passes driver errors through unchanged', async () => {
		const error = Object.assign(new Error('Query failed.'), { code: -493, kind: 'syntax' });
		const client = fakeClient([error as never]);
		await expect(drizzle(client).select().from(users)).rejects.toBe(error);
	});

	it('refuses non-array rows and rows of the wrong width', async () => {
		await expect(
			drizzle(fakeClient([[{ id: 1 }]]))
				.select()
				.from(users),
		).rejects.toThrow(/returned object for a row with \{ rowMode: 'array' \}.*cubrid-client 1.4.0/);
		await expect(
			drizzle(fakeClient([[[1]]]))
				.select()
				.from(users),
		).rejects.toThrow(/a row of 1 values for 3 selected fields/);
	});

	it('supports then/catch/finally', async () => {
		const done = vi.fn();
		await drizzle(fakeClient([[[1n]]]))
			.select({ id: users.id })
			.from(users)
			.then((rows) => expect(rows).toEqual([{ id: 1n }]))
			.finally(done);
		expect(done).toHaveBeenCalled();
	});

	it('logs statements', async () => {
		const logQuery = vi.fn();
		await drizzle(fakeClient([[]]), { logger: { logQuery } })
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, 1n));
		expect(logQuery).toHaveBeenCalledWith('select "users"."id" from "users" where "users"."id" = ?', [1n]);
		expect(() => drizzle(fakeClient(), { logger: true })).not.toThrow();
	});
});

describe('db.execute()', () => {
	it('runs raw sql with bound values and returns driver rows', async () => {
		const client = fakeClient([[{ n: 1 }], [{ v: 2 }]]);
		const rawDb = drizzle(client);
		expect(await rawDb.execute(sql`select ${1} as n from ${users} where ${users.name} = ${'a'}`)).toEqual([{ n: 1 }]);
		expect(client.calls[0]).toEqual({
			method: 'queryPrepared',
			sql: 'select ? as n from "users" where "users"."name" = ?',
			params: [1, 'a'],
			options: undefined,
		});
		expect(await rawDb.execute('select 2 as v from db_root')).toEqual([{ v: 2 }]);
		expect(sql`select ${"it's"}`.inlineParams().toQuery).toBeDefined();
		expect(
			rawDb
				.select({ v: sql`${"it's"}`.inlineParams() })
				.from(users)
				.toSQL().sql,
		).toBe("select 'it''s' from \"users\"");
	});
});

describe('drizzle() construction', () => {
	it('needs queryPrepared() for the default binding', () => {
		const { queryPrepared: _, ...literalOnly } = fakeClient();
		expect(() => drizzle(literalOnly)).toThrow(/no queryPrepared\(\) for typed binding .*binding: 'literal'/);
		expect(() => drizzle(literalOnly, { binding: 'literal' })).not.toThrow();
		// @ts-expect-error unknown binding
		expect(() => drizzle(fakeClient(), { binding: 'inline' })).toThrow(/Unknown binding string "inline"/);
		// @ts-expect-error not a client
		expect(() => drizzle({})).toThrow(/needs a cubrid-client client or pool/);
		const client = fakeClient();
		expect(drizzle(client).$client).toBe(client);
	});
});

describe('UTC-decoding guard', () => {
	const zoned = (extra: Record<string, unknown>, results: unknown[][] = [[]]) => fakeClient(results, extra);

	it('refuses a date or time read from a local-zone client in a non-UTC process', async () => {
		const tz = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			const fields: CubridSelectedFields[] = [
				{ at: posts.at },
				{ days: posts.days },
				{ clock: plain.clock },
				{ v: sql`max(${posts.at})`.mapWith(posts.at) },
				{ v: sql`max(${posts.at})`.mapWith(posts.at).as('v') },
			];
			for (const field of fields) {
				const client = zoned({ timezone: 'local' });
				await expect(drizzle(client).select(field).from(posts)).rejects.toThrow(NOT_UTC_MESSAGE);
				expect(client.calls).toEqual([]);
			}
			const sq = db.select({ at: posts.at }).from(posts).as('sq');
			await expect(
				drizzle(zoned({ timezone: 'local' }))
					.select()
					.from(sq),
			).rejects.toThrow(NOT_UTC_MESSAGE);
			// Columns that are not date or time do not need the check.
			expect(
				await drizzle(zoned({ timezone: 'local' }))
					.select({ id: posts.id })
					.from(posts),
			).toEqual([]);
		} finally {
			env.TZ = tz;
		}
	});

	it('accepts UTC clients and probes clients that declare nothing', async () => {
		expect(
			await drizzle(zoned({ timezone: 'utc' }))
				.select({ at: posts.at })
				.from(posts),
		).toEqual([]);
		expect(
			await drizzle(zoned({ utcDates: true }))
				.select({ at: posts.at })
				.from(posts),
		).toEqual([]);
		const probed = zoned({}, [[[new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, 6, 1))]], []]);
		const probeDb = drizzle(probed);
		const tz = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			await probeDb.select({ at: posts.at }).from(posts);
			await probeDb.select({ at: posts.at }).from(posts);
		} finally {
			env.TZ = tz;
		}
		expect(probed.calls.map((c) => c.sql)).toEqual([
			ZONE_PROBE_SQL,
			'select "posts"."at" from "posts"',
			'select "posts"."at" from "posts"',
		]);
	});

	it('reads the zone each cubrid-client shape declares', () => {
		expect(declaredClientZone({ timezone: 'utc' })).toBe('utc');
		expect(declaredClientZone({ timezone: '+09:00' })).toBe('other');
		expect(declaredClientZone({ utcDates: false })).toBe('local');
		expect(declaredClientZone({ config: { timezone: 'utc' } })).toBe('utc');
		expect(declaredClientZone({ config: {} })).toBeUndefined();
		class CubridClient {
			config = {};
		}
		expect(declaredClientZone(new CubridClient())).toBe('local');
		expect(declaredClientZone({ connection: { utcDates: true } })).toBe('utc');
		expect(declaredClientZone({})).toBeUndefined();
		expect(typeof isProcessZoneUtc()).toBe('boolean');
	});

	it('retries a failed probe and refuses an unknown zone', async () => {
		const tz = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			const failing = zoned({}, [new Error('down') as never, [[1, 2]], []]);
			const failingDb = drizzle(failing);
			await expect(failingDb.select({ at: posts.at }).from(posts)).rejects.toThrow('down');
			await expect(failingDb.select({ at: posts.at }).from(posts)).rejects.toThrow(NOT_UTC_MESSAGE);
			const local = zoned({}, [[[new Date(2000, 0, 1), new Date(2000, 6, 1)]]]);
			await expect(drizzle(local).select({ at: posts.at }).from(posts)).rejects.toThrow(NOT_UTC_MESSAGE);
		} finally {
			env.TZ = tz;
		}
	});
});
