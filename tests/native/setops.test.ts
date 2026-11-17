// Native set operations and scalar subqueries (#158) with a fake client:
// golden SQL, refusals before sending and row mapping of the compound result.
import { aliasedTable, asc, count, desc, eq, exists, gt, inArray, max, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	bigint,
	type CubridSelectedFields,
	char,
	cubridTable,
	date,
	datetime,
	drizzle,
	except,
	exceptAll,
	integer,
	intersect,
	intersectAll,
	numeric,
	timestamp,
	union,
	unionAll,
	varchar,
} from '../../src/native/index';
import { NOT_UTC_MESSAGE } from '../../src/native/timezone';

const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey(),
	name: varchar({ length: 50 }).notNull(),
});
const posts = cubridTable('posts', {
	id: integer().primaryKey(),
	authorId: bigint('author_id', { mode: 'bigint' }).notNull(),
	title: varchar({ length: 50 }).notNull(),
	price: numeric({ precision: 10, scale: 2 }),
	at: datetime(),
});

type Call = { method: string; sql: string; params: readonly unknown[] | undefined };

function fakeClient(results: unknown[][] = [], extra: Record<string, unknown> = { timezone: 'utc' }) {
	const calls: Call[] = [];
	const queue = [...results];
	const respond = (method: string) => async (sql: string, params?: readonly unknown[]) => {
		calls.push({ method, sql, params });
		return queue.shift() ?? [];
	};
	return { calls, query: respond('query'), queryPrepared: respond('queryPrepared'), ...extra };
}

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const db = drizzle(fakeClient());
const u = () => db.select({ id: users.id, name: users.name }).from(users);
const p = () => db.select({ id: posts.authorId, name: posts.title }).from(posts);
const U = 'select "users"."id", "users"."name" from "users"';
const P = 'select "posts"."author_id", "posts"."title" from "posts"';

describe('set operations: golden SQL', () => {
	it.each([
		['union', u().union(p()), `(${U}) union (${P})`],
		['unionAll', u().unionAll(p()), `(${U}) union all (${P})`],
		['intersect', u().intersect(p()), `(${U}) intersect (${P})`],
		['intersectAll', u().intersectAll(p()), `(${U}) intersect all (${P})`],
		['except', u().except(p()), `(${U}) except (${P})`],
		['exceptAll', u().exceptAll(p()), `(${U}) except all (${P})`],
		['standalone union', union(u(), p()), `(${U}) union (${P})`],
		['standalone unionAll with rest', unionAll(u(), p(), u()), `((${U}) union all (${P})) union all (${U})`],
		['standalone intersect', intersect(u(), p()), `(${U}) intersect (${P})`],
		['standalone intersectAll', intersectAll(u(), p()), `(${U}) intersect all (${P})`],
		['standalone except', except(u(), p()), `(${U}) except (${P})`],
		['standalone exceptAll', exceptAll(u(), p()), `(${U}) except all (${P})`],
		['chained operators nest left to right', u().union(p()).intersect(u()), `((${U}) union (${P})) intersect (${U})`],
		['a set operation as the right operand', u().union(p().intersect(u())), `(${U}) union ((${P}) intersect (${U}))`],
		['the callback form', u().union(({ intersect }) => intersect(p(), u())), `(${U}) union ((${P}) intersect (${U}))`],
	])('%s', (_label, query, text) => {
		expect(query.toSQL()).toEqual({ sql: text, params: [] });
	});

	it('orders the result by the position of the first select fields, with limit and offset', () => {
		const query = u().union(p()).orderBy(desc(users.name), users.id, asc(users.id)).limit(10).offset(5);
		expect(query.toSQL()).toEqual({
			sql: `(${U}) union (${P}) order by 2 desc, 1, 1 asc limit ? offset ?`,
			params: [10, 5],
		});
		expect(
			u()
				.union(p())
				.orderBy(({ name }) => desc(name))
				.toSQL().sql,
		).toBe(`(${U}) union (${P}) order by 2 desc`);
	});

	it('orders by an aliased sql field and a sql field by position', () => {
		const n = sql<number>`count(*)`;
		const q = db
			.select({ a: posts.authorId, n })
			.from(posts)
			.groupBy(posts.authorId)
			.union(db.select({ a: users.id, n: sql<number>`0` }).from(users))
			.orderBy(desc(n));
		expect(q.toSQL().sql).toBe(
			'(select "posts"."author_id", count(*) from "posts" group by "posts"."author_id") union (select "users"."id", 0 from "users") order by 2 desc',
		);
	});

	it('keeps each operand its own order by and limit, and binds parameters in order', () => {
		const query = u()
			.where(gt(users.id, 1n))
			.orderBy(desc(users.id))
			.limit(sql.placeholder('n'))
			.unionAll(p().where(eq(posts.title, 'x')))
			.limit(sql.placeholder('total'));
		expect(query.toSQL()).toEqual({
			sql: `(${U} where "users"."id" > ? order by "users"."id" desc limit ?) union all (${P} where "posts"."title" = ?) limit ?`,
			params: [1n, sql.placeholder('n'), 'x', sql.placeholder('total')],
		});
	});

	it('makes an ordered set operation an operand of a later set operator', () => {
		const ordered = u().union(p()).orderBy(users.id).limit(2);
		expect(ordered.unionAll(u()).toSQL().sql).toBe(`((${U}) union (${P}) order by 1 limit ?) union all (${U})`);
		// The ordered operation itself is unchanged.
		expect(ordered.toSQL().sql).toBe(`(${U}) union (${P}) order by 1 limit ?`);
	});

	it('does not change the set operation a later set operator is called on', () => {
		const first = u().union(p());
		first.intersect(u());
		expect(first.toSQL().sql).toBe(`(${U}) union (${P})`);
	});

	it('is a subquery with .as(), named by the first select', async () => {
		const sq = u().union(p()).as('sq');
		const query = db.select().from(sq).where(eq(sq.id, 1n));
		expect(query.toSQL()).toEqual({
			sql: `select "sq"."id", "sq"."name" from ((select "users"."id" as "id", "users"."name" as "name" from "users") union (${P})) "sq" where "sq"."id" = ?`,
			params: [1n],
		});
		const client = fakeClient([[[3n, 'c']]]);
		expect(await drizzle(client).select().from(sq)).toEqual([{ id: 3n, name: 'c' }]);
	});

	it('is a value list for inArray()', () => {
		const ids = db
			.select({ id: users.id })
			.from(users)
			.union(db.select({ id: posts.authorId }).from(posts));
		expect(db.select({ id: users.id }).from(users).where(inArray(users.id, ids)).toSQL().sql).toBe(
			'select "users"."id" from "users" where "users"."id" in ((select "users"."id" from "users") union (select "posts"."author_id" from "posts"))',
		);
	});
});

describe('set operations: refusals before sending', () => {
	it('refuses selects of different fields', () => {
		expect(() =>
			db
				.select({ id: users.id })
				.from(users)
				// @ts-expect-error different fields
				.union(u()),
		).toThrow(/union\(\): the selects have different fields \(id and id, name\)/);
		expect(() =>
			db
				.select({ a: users.id })
				.from(users)
				// @ts-expect-error different keys
				.unionAll(db.select({ b: users.id }).from(users)),
		).toThrow(/unionAll\(\): the selects have different fields \(a and b\)/);
	});

	it('refuses an operand that is not a native select', () => {
		// @ts-expect-error not a select
		expect(() => u().except(sql`select 1`)).toThrow(
			/except\(\) needs a drizzle-cubrid\/native select or set operation/,
		);
	});

	it('refuses FOR UPDATE on an operand', () => {
		const client = fakeClient();
		const locked = drizzle(client).select({ id: users.id, name: users.name }).from(users).for('update');
		expect(() => locked.union(p()).toSQL()).toThrow(/CUBRID rejects FOR UPDATE in a set operation \(-494/);
		expect(() => u().union(locked).toSQL()).toThrow(/FOR UPDATE/);
		expect(client.calls).toEqual([]);
	});

	it('refuses offset() without limit() and ordering by a field not selected first', () => {
		expect(() => u().union(p()).offset(1).toSQL()).toThrow(/CUBRID needs limit\(\) with offset\(\)/);
		const refused =
			/orderBy\(\) of a set operation takes only fields of its first select, bare or in asc\(\)\/desc\(\)/;
		expect(() => u().union(p()).orderBy(posts.title).toSQL()).toThrow(refused);
		expect(() => u().union(p()).orderBy(desc(posts.id)).toSQL()).toThrow(refused);
		// A selected column inside an expression cannot become a position: `length(2)` would be sent.
		expect(() => u().union(p()).orderBy(sql`length(${users.name})`).toSQL()).toThrow(refused);
		expect(() => u().union(p()).orderBy(sql`${users.id} + 1`).toSQL()).toThrow(refused);
		expect(() => u().union(p()).orderBy(sql`1`).toSQL()).toThrow(refused);
	});

	it('refuses an operand whose field the first select codec would not read as sent (date and datetime)', () => {
		const events = cubridTable('events', {
			id: integer().primaryKey(),
			day: date(),
			at: datetime(),
			stamp: timestamp(),
			n: numeric({ precision: 38, scale: 10 }),
			count: integer(),
			label: char({ length: 5 }),
		});
		const field = (value: CubridSelectedFields[string]) => db.select({ x: value }).from(events);
		const refused = /field x is DATE in the first select but DATETIME in another/;
		expect(() => field(events.day).unionAll(field(events.at))).toThrow(refused);
		expect(() => field(events.day).unionAll(field(events.stamp))).toThrow(/DATE in the first select but TIMESTAMP/);
		expect(() => field(events.at).union(field(events.day))).toThrow(/DATETIME in the first select but DATE/);
		expect(() => field(events.count).union(field(events.n))).toThrow(/INTEGER in the first select but NUMERIC/);
		expect(() => field(events.day).union(field(sql`now()`))).toThrow(
			/DATE in the first select but a sql value without a column codec/,
		);
		expect(() => union(field(events.day), field(events.day), field(events.at))).toThrow(refused);
		// The same SQL type with another length, precision or mode, CHAR with VARCHAR, a sql value mapped with
		// the first select's column, and a value without a codec under a codec that is not a date or time one.
		expect(() => field(events.n).union(field(posts.price))).not.toThrow();
		expect(() => field(events.label).union(field(posts.title))).not.toThrow();
		expect(() => field(events.day).union(field(sql`cast(${events.at} as date)`.mapWith(events.day)))).not.toThrow();
		expect(() => field(events.count).union(field(sql`1`))).not.toThrow();
		expect(() => field(sql`now()`).union(field(events.day))).not.toThrow();
	});
});

describe('set operations: execution', () => {
	it('maps rows of every operand by position with the first select codecs', async () => {
		const client = fakeClient([
			[
				['1', 'a'],
				[2n, 'b'],
			],
		]);
		const rows = await drizzle(client)
			.select({ id: users.id, name: users.name })
			.from(users)
			.union(p())
			.orderBy(users.id);
		expect(rows).toEqual([
			{ id: 1n, name: 'a' },
			{ id: 2n, name: 'b' },
		]);
		expect(client.calls).toEqual([{ method: 'queryPrepared', sql: `(${U}) union (${P}) order by 1`, params: [] }]);
	});

	it('prepares once and fills placeholders in every operand', async () => {
		const client = fakeClient([[], []]);
		const prepared = drizzle(client)
			.select({ id: users.id, name: users.name })
			.from(users)
			.where(eq(users.id, sql.placeholder('a')))
			.except(p().where(eq(posts.authorId, sql.placeholder('b'))))
			.limit(sql.placeholder('n'))
			.prepare();
		await prepared.execute({ a: 1n, b: 2n, n: 3 });
		expect(client.calls[0]?.params).toEqual([1n, 2n, 3]);
	});

	it('keeps the first select join nullability', async () => {
		const client = fakeClient([[[1n, 'a', null, null, null, null, null]]]);
		const left = drizzle(client).select().from(users).leftJoin(posts, eq(users.id, posts.authorId));
		const rows = await left.union(db.select().from(users).leftJoin(posts, eq(users.id, posts.authorId)));
		expect(rows).toEqual([{ users: { id: 1n, name: 'a' }, posts: null }]);
	});

	it('refuses a date or time read in any operand from a local-zone client', async () => {
		const client = fakeClient([], { timezone: 'local' });
		const local = drizzle(client);
		const query = local
			.select({ v: sql<Date | null>`null` })
			.from(users)
			.union(local.select({ v: posts.at }).from(posts));
		const zone = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			await expect(query).rejects.toThrow(NOT_UTC_MESSAGE);
			expect(client.calls).toEqual([]);
		} finally {
			env.TZ = zone;
		}
	});
});

describe('scalar subqueries', () => {
	it('selects a correlated subquery as a field, decoded by its one field', async () => {
		const n = db
			.select({ n: count().as('n') })
			.from(posts)
			.where(eq(posts.authorId, users.id))
			.as('n');
		const query = db.select({ id: users.id, n }).from(users);
		expect(query.toSQL()).toEqual({
			sql: 'select "users"."id", (select count(*) as "n" from "posts" where "posts"."author_id" = "users"."id") from "users"',
			params: [],
		});
		const client = fakeClient([[[1n, '2']]]);
		expect(await drizzle(client).select({ id: users.id, n }).from(users)).toEqual([{ id: 1n, n: 2 }]);
	});

	it('decodes a column subquery with the column codec, and NULL as null', async () => {
		const last = db
			.select({ at: posts.at })
			.from(posts)
			.where(eq(posts.authorId, users.id))
			.orderBy(desc(posts.at))
			.limit(1)
			.as('last');
		const client = fakeClient([
			[
				[1n, new Date(Date.UTC(2024, 0, 2, 3, 4, 5))],
				[2n, null],
			],
		]);
		const rows = await drizzle(client).select({ id: users.id, last }).from(users);
		expect(rows).toEqual([
			{ id: 1n, last: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) },
			{ id: 2n, last: null },
		]);
		expect(client.calls[0]?.sql).toBe(
			'select "users"."id", (select "posts"."at" as "at" from "posts" where "posts"."author_id" = "users"."id" order by "posts"."at" desc limit ?) from "users"',
		);
		expect(client.calls[0]?.params).toEqual([1]);
	});

	it('refuses a date or time subquery field from a local-zone client', async () => {
		const last = db.select({ at: posts.at }).from(posts).limit(1).as('last');
		const client = fakeClient([], { timezone: 'local' });
		const zone = env.TZ;
		env.TZ = 'Asia/Seoul';
		try {
			await expect(drizzle(client).select({ id: users.id, last }).from(users)).rejects.toThrow(NOT_UTC_MESSAGE);
			expect(client.calls).toEqual([]);
		} finally {
			env.TZ = zone;
		}
	});

	it('refuses a subquery of several fields or a nested object, and one inside .as()', () => {
		const two = db.select({ a: users.id, b: users.name }).from(users).as('two');
		expect(() => db.select({ id: users.id, two }).from(users).toSQL()).toThrow(
			/Selected field two is a subquery of 2 fields/,
		);
		const nested = db
			.select({ o: { a: users.id } })
			.from(users)
			.as('nested');
		expect(() => db.select({ nested }).from(users).toSQL()).toThrow(/is a subquery of a nested object/);
		const one = db
			.select({ m: max(posts.id).as('m') })
			.from(posts)
			.as('one');
		expect(() => db.select({ o: { one } }).from(users).toSQL()).toThrow(
			/Selected field o.one is a subquery inside an object/,
		);
		expect(() => db.select({ one }).from(users).as('outer')).toThrow(/Subquery field one is a scalar subquery/);
	});

	it('refuses a subquery field reading a table of the outer query, and correlates through aliasedTable()', () => {
		const employees = cubridTable('employees', { id: integer().primaryKey(), boss: integer() });
		const shadowed = db
			.select({ c: count().as('c') })
			.from(employees)
			.where(eq(employees.boss, employees.id))
			.as('reports');
		expect(() => db.select({ id: employees.id, reports: shadowed }).from(employees).toSQL()).toThrow(
			/Selected field reports is a subquery that reads employees, which the outer query reads too.*aliasedTable/,
		);
		const staff = aliasedTable(employees, 'staff');
		const reports = db
			.select({ c: count().as('c') })
			.from(staff)
			.where(eq(staff.boss, employees.id))
			.as('reports');
		expect(db.select({ id: employees.id, reports }).from(employees).toSQL().sql).toBe(
			'select "employees"."id", (select count(*) as "c" from "employees" "staff" where "staff"."boss" = "employees"."id") from "employees"',
		);
		// Names that differ only in case are the same table to CUBRID.
		const upper = cubridTable('EMPLOYEES', { id: integer().primaryKey(), boss: integer() });
		const other = db
			.select({ c: count().as('c') })
			.from(upper)
			.as('other');
		expect(() => db.select({ id: employees.id, other }).from(employees).toSQL()).toThrow(/reads EMPLOYEES/);
		// A join source counts too.
		expect(() =>
			db
				.select({
					id: users.id,
					n: db
						.select({ c: count().as('c') })
						.from(posts)
						.as('n'),
				})
				.from(users)
				.innerJoin(posts, eq(users.id, posts.authorId))
				.toSQL(),
		).toThrow(/reads posts, which the outer query reads too/);
	});

	it('writes aliasedTable() sources as "table" "alias" in from() and joins', () => {
		const author = aliasedTable(users, 'author');
		expect(
			db
				.select({ id: author.id, title: posts.title })
				.from(posts)
				.innerJoin(author, eq(author.id, posts.authorId))
				.toSQL().sql,
		).toBe(
			'select "author"."id", "posts"."title" from "posts" inner join "users" "author" on "author"."id" = "posts"."author_id"',
		);
		expect(db.select({ id: author.id }).from(author).toSQL().sql).toBe('select "author"."id" from "users" "author"');
	});

	it('writes a subquery field used in orderBy, where and having as its (select ...)', () => {
		const n = db
			.select({ n: count().as('n') })
			.from(posts)
			.where(eq(posts.authorId, users.id))
			.as('n');
		const inner = 'select count(*) as "n" from "posts" where "posts"."author_id" = "users"."id"';
		expect(
			db
				.select({ id: users.id, n })
				.from(users)
				.where(({ n }) => gt(n, 1))
				.orderBy(({ n }) => desc(n))
				.toSQL(),
		).toEqual({
			sql: `select "users"."id", (${inner}) from "users" where (${inner}) > ? order by (${inner}) desc`,
			params: [1],
		});
		expect(db.select({ id: users.id, n }).from(users).groupBy(users.id, sql`${n}`).having(gt(n, 0)).toSQL().sql).toBe(
			`select "users"."id", (${inner}) from "users" group by "users"."id", (${inner}) having (${inner}) > ?`,
		);
		// In a set operation it orders by position.
		const ordered = db
			.select({ id: users.id, n })
			.from(users)
			.union(db.select({ id: users.id, n }).from(users))
			.orderBy(({ n }) => desc(n));
		expect(ordered.toSQL().sql).toMatch(/ order by 2 desc$/);
	});

	it('uses unaliased selects in sql, exists() and comparisons', () => {
		const inner = db
			.select({ m: max(posts.id) })
			.from(posts)
			.where(eq(posts.authorId, users.id));
		expect(
			db
				.select({ id: users.id, m: sql<number>`${inner}`.mapWith(Number) })
				.from(users)
				.where(exists(db.select({ one: sql`1` }).from(posts).where(eq(posts.authorId, users.id))))
				.orderBy(sql`${inner}`)
				.toSQL().sql,
		).toBe(
			'select "users"."id", (select max("posts"."id") from "posts" where "posts"."author_id" = "users"."id") from "users" where exists (select 1 from "posts" where "posts"."author_id" = "users"."id") order by (select max("posts"."id") from "posts" where "posts"."author_id" = "users"."id")',
		);
		expect(
			db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, sql`${db.select({ m: max(posts.authorId) }).from(posts)}`))
				.toSQL().sql,
		).toBe('select "users"."id" from "users" where "users"."id" = (select max("posts"."author_id") from "posts")');
	});
});
