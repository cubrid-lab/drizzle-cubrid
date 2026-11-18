// Result types of the native select builder (#158), against Drizzle's neutral select types.
import type { CubridClient, CubridPool } from 'cubrid-client';
import { count, eq, exists, inArray, max, sql, sum } from 'drizzle-orm';
import type { DrizzleTypeError } from 'drizzle-orm/utils';
import { describe, expectTypeOf, it } from 'vitest';

import {
	bigint,
	cubridTable,
	datetime,
	drizzle,
	exceptAll,
	integer,
	intersect,
	numeric,
	set,
	union,
	unionAll,
	varchar,
} from '../../src/native/index';

const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey(),
	name: varchar({ length: 50 }).notNull(),
	email: varchar({ length: 50 }),
});
const posts = cubridTable('posts', {
	id: integer().primaryKey(),
	authorId: bigint('author_id', { mode: 'bigint' }),
	title: varchar({ length: 50 }).notNull(),
	price: numeric({ precision: 10, scale: 2 }),
	at: datetime(),
	tags: set({ element: varchar({ length: 10 }) }),
});

declare const client: CubridClient;
declare const pool: CubridPool;
const db = drizzle(client);

type User = { id: bigint; name: string; email: string | null };
type Post = {
	id: number;
	authorId: bigint | null;
	title: string;
	price: string | null;
	at: Date | null;
	tags: (string | null)[] | null;
};

describe('drizzle()', () => {
	it('accepts cubrid-client clients and pools', () => {
		expectTypeOf(drizzle(pool).$client).toEqualTypeOf<CubridPool>();
		expectTypeOf(db.$client).toEqualTypeOf<CubridClient>();
		drizzle(client, { binding: 'literal', logger: true });
		// @ts-expect-error unknown binding
		drizzle(client, { binding: 'inline' });
	});

	it('types raw execute rows', async () => {
		expectTypeOf(await db.execute(sql`select 1`)).toEqualTypeOf<Record<string, unknown>[]>();
		expectTypeOf(await db.execute<{ n: number }>('select 1 as n from db_root')).toEqualTypeOf<{ n: number }[]>();
	});
});

describe('select shapes', () => {
	it('select() from a table', async () => {
		expectTypeOf(await db.select().from(users)).toEqualTypeOf<User[]>();
		expectTypeOf(await db.selectDistinct().from(posts)).toEqualTypeOf<Post[]>();
	});

	it('partial select, nested objects and sql fields', async () => {
		const rows = await db
			.select({ id: users.id, info: { name: users.name, n: sql<number>`1` }, total: count() })
			.from(users);
		expectTypeOf(rows).toEqualTypeOf<{ id: bigint; info: { name: string; n: number }; total: number }[]>();
		const mapped = await db.select({ v: sql`1`.mapWith(Number) }).from(users);
		expectTypeOf(mapped).toEqualTypeOf<{ v: number }[]>();
	});

	it('inner, left, right and cross join nullability', async () => {
		expectTypeOf(await db.select().from(users).innerJoin(posts, eq(users.id, posts.authorId))).toEqualTypeOf<
			{ users: User; posts: Post }[]
		>();
		expectTypeOf(await db.select().from(users).leftJoin(posts, eq(users.id, posts.authorId))).toEqualTypeOf<
			{ users: User; posts: Post | null }[]
		>();
		expectTypeOf(await db.select().from(users).rightJoin(posts, eq(users.id, posts.authorId))).toEqualTypeOf<
			{ users: User | null; posts: Post }[]
		>();
		expectTypeOf(await db.select().from(users).crossJoin(posts)).toEqualTypeOf<{ users: User; posts: Post }[]>();
		const partial = await db
			.select({ name: users.name, title: posts.title })
			.from(users)
			.leftJoin(posts, eq(users.id, posts.authorId));
		expectTypeOf(partial).toEqualTypeOf<{ name: string; title: string | null }[]>();
	});

	it('aggregates with group by and having', async () => {
		const rows = await db
			.select({ authorId: posts.authorId, n: count(), total: sum(posts.price) })
			.from(posts)
			.groupBy(posts.authorId)
			.having(({ n }) => sql`${n} > 1`)
			.orderBy(posts.authorId)
			.limit(10)
			.offset(5);
		expectTypeOf(rows).toEqualTypeOf<{ authorId: bigint | null; n: number; total: string | null }[]>();
	});

	it('subqueries keep their field types under the alias', async () => {
		const sq = db
			.select({ authorId: posts.authorId, n: sql<number>`count(*)`.as('n') })
			.from(posts)
			.groupBy(posts.authorId)
			.as('sq');
		expectTypeOf(sq.authorId._.tableName).toEqualTypeOf<'sq'>();
		expectTypeOf(await db.select().from(sq)).toEqualTypeOf<{ authorId: bigint | null; n: number }[]>();
		const joined = await db.select({ name: users.name, n: sq.n }).from(users).leftJoin(sq, eq(users.id, sq.authorId));
		expectTypeOf(joined).toEqualTypeOf<{ name: string; n: number }[]>();
	});

	it('prepare, toSQL and $dynamic', async () => {
		const prepared = db
			.select()
			.from(users)
			.where(eq(users.id, sql.placeholder('id')))
			.prepare();
		expectTypeOf(await prepared.execute({ id: 1n })).toEqualTypeOf<User[]>();
		expectTypeOf(db.select().from(users).toSQL()).toEqualTypeOf<{ sql: string; params: unknown[] }>();
		const dynamic = db.select().from(users).$dynamic();
		expectTypeOf(await dynamic.where(eq(users.name, 'a'))).toEqualTypeOf<User[]>();
	});
});

describe('iterator() and prepared queries (#165)', () => {
	it('streams rows typed as the select result', async () => {
		const rows = db.select().from(users).iterator();
		expectTypeOf(rows).toEqualTypeOf<AsyncGenerator<User, void, undefined>>();
		for await (const row of db
			.select({ id: users.id, at: posts.at })
			.from(users)
			.leftJoin(posts, eq(users.id, posts.authorId))
			.iterator()) {
			expectTypeOf(row).toEqualTypeOf<{ id: bigint; at: Date | null }>();
		}
		const prepared = db
			.select({ title: posts.title, tags: posts.tags })
			.from(posts)
			.where(eq(posts.id, sql.placeholder('id')))
			.prepare();
		expectTypeOf(
			prepared.iterator(
				{ id: 1 },
				{ literal: true, fetchSize: 500, consumerTimeout: 0, signal: AbortSignal.timeout(1) },
			),
		).toEqualTypeOf<AsyncGenerator<{ title: string; tags: (string | null)[] | null }, void, undefined>>();
		expectTypeOf(prepared.execute).parameters.toEqualTypeOf<[placeholderValues?: Record<string, unknown>]>();
		const union = db
			.select({ id: users.id })
			.from(users)
			.union(db.select({ id: users.id }).from(users));
		expectTypeOf(union.iterator()).toEqualTypeOf<AsyncGenerator<{ id: bigint }, void, undefined>>();
		expectTypeOf(drizzle(pool).select().from(users).iterator()).toEqualTypeOf<AsyncGenerator<User, void, undefined>>();
		// @ts-expect-error rowMode is the dialect's own
		db.select().from(users).iterator({}, { rowMode: 'array' });
		// @ts-expect-error a write has no iterator()
		db.delete(users).iterator;
	});
});

describe('set operations', () => {
	const names = () => db.select({ id: users.id, name: users.name }).from(users);
	const titles = () => db.select({ id: sql<bigint>`${posts.authorId}`, name: posts.title }).from(posts);

	it('keep the first select result type', async () => {
		expectTypeOf(await names().union(titles())).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(await names().unionAll(titles()).intersect(names()).except(titles())).toEqualTypeOf<
			{ id: bigint; name: string }[]
		>();
		expectTypeOf(await names().intersectAll(titles()).exceptAll(names())).toEqualTypeOf<
			{ id: bigint; name: string }[]
		>();
		expectTypeOf(await union(names(), titles(), names())).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(await unionAll(names(), titles())).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(await intersect(names(), titles())).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(await exceptAll(names(), titles())).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(await names().union(({ intersect }) => intersect(titles(), names()))).toEqualTypeOf<
			{ id: bigint; name: string }[]
		>();
		expectTypeOf(await db.select().from(users).union(db.select().from(users))).toEqualTypeOf<User[]>();
	});

	it('order, limit, offset, prepare and subqueries of a set operation', async () => {
		const q = names()
			.union(titles())
			.orderBy(({ name }) => name)
			.limit(sql.placeholder('n'))
			.offset(1);
		expectTypeOf(await q.prepare().execute({ n: 1 })).toEqualTypeOf<{ id: bigint; name: string }[]>();
		expectTypeOf(q.toSQL()).toEqualTypeOf<{ sql: string; params: unknown[] }>();
		const sq = names().union(titles()).as('sq');
		expectTypeOf(await db.select().from(sq)).toEqualTypeOf<{ id: bigint; name: string }[]>();
		db.select()
			.from(users)
			.where(inArray(users.id, names().union(titles()).as('ids').id));
	});

	it('refuse operands of other fields or types', () => {
		// @ts-expect-error a missing field
		names().union(db.select({ id: users.id }).from(users));
		// @ts-expect-error an extra field
		names().union(db.select({ id: users.id, name: users.name, email: users.email }).from(users));
		// @ts-expect-error a nullable field where the first select's is not
		names().union(db.select({ id: users.id, name: users.email }).from(users));
		// @ts-expect-error another type
		union(names(), db.select({ id: users.id, name: posts.id }).from(posts));
		// @ts-expect-error not a select
		names().union(sql`select 1`);
		// @ts-expect-error no for() on a set operation
		names().union(titles()).for('update');
	});
});

describe('scalar subqueries', () => {
	it('select one field of a subquery as a value', async () => {
		const n = db
			.select({ n: count().as('n') })
			.from(posts)
			.where(eq(posts.authorId, users.id))
			.as('n');
		const last = db.select({ at: posts.at }).from(posts).limit(1).as('last');
		const rows = await db.select({ id: users.id, n, last }).from(users);
		expectTypeOf(rows).toEqualTypeOf<{ id: bigint; n: number; last: Date | null }[]>();
		// Drizzle's select types allow a subquery field only at the top level.
		expectTypeOf(await db.select({ info: { last } }).from(users)).toEqualTypeOf<{ info: never }[]>();
	});

	it('type a subquery of several fields as an error', async () => {
		const two = db.select({ a: users.id, b: users.name }).from(users).as('two');
		const [row] = await db.select({ two }).from(users);
		expectTypeOf(row!.two).toEqualTypeOf<DrizzleTypeError<'You can only select one column in the subquery'>>();
	});

	it('use unaliased selects in sql and exists()', async () => {
		const inner = db.select({ m: max(posts.id) }).from(posts);
		const rows = await db
			.select({ id: users.id, m: sql<number | null>`${inner}` })
			.from(users)
			.where(exists(inner));
		expectTypeOf(rows).toEqualTypeOf<{ id: bigint; m: number | null }[]>();
	});
});

describe('refusals at the type level', () => {
	it('has no full join or lateral join, and only for update', () => {
		const q = db.select().from(users);
		// @ts-expect-error CUBRID has no FULL JOIN
		q.fullJoin(posts, eq(users.id, posts.authorId));
		// @ts-expect-error no lateral joins
		q.leftJoinLateral(posts, sql`true`);
		// @ts-expect-error CUBRID has no shared locks
		q.for('share');
		// @ts-expect-error no NOWAIT/SKIP LOCKED
		q.for('update', { noWait: true });
		// @ts-expect-error only native tables and subqueries
		db.select().from(sql`users`);
		// @ts-expect-error wrong type in a condition
		q.where(eq(users.id, 'one'));
	});
});

describe('iterator() options (#165)', () => {
	it('types literal as a boolean', () => {
		db.select().from(users).iterator({}, { literal: true });
		// @ts-expect-error literal is a boolean
		db.select().from(users).iterator({}, { literal: 'yes' });
	});
});
