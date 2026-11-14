// Result types of the native select builder (#158), against Drizzle's neutral select types.
import type { CubridClient, CubridPool } from 'cubrid-client';
import { count, eq, sql, sum } from 'drizzle-orm';
import { describe, expectTypeOf, it } from 'vitest';

import { bigint, cubridTable, datetime, drizzle, integer, numeric, set, varchar } from '../../src/native/index';

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

describe('refusals at the type level', () => {
	it('has no full join, lateral join or set operations, and only for update', () => {
		const q = db.select().from(users);
		// @ts-expect-error CUBRID has no FULL JOIN
		q.fullJoin(posts, eq(users.id, posts.authorId));
		// @ts-expect-error no lateral joins
		q.leftJoinLateral(posts, sql`true`);
		// @ts-expect-error no set operations in this slice
		q.union(db.select().from(users));
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
