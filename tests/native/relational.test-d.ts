// Result types of native relational queries (#158), from Drizzle's neutral BuildQueryResult.
import type { CubridClient, CubridPool } from 'cubrid-client';
import { sql } from 'drizzle-orm';
import type { DrizzleTypeError } from 'drizzle-orm/utils';
import { describe, expectTypeOf, it } from 'vitest';

import { type CubridRelationalQuery, type CubridTransaction, drizzle } from '../../src/native/index';
import * as schema from './relational-schema';

declare const client: CubridClient;
declare const pool: CubridPool;
const db = drizzle(client, { schema });

type User = { id: bigint; name: string; managerId: bigint | null };
type Post = { id: number; authorId: bigint; title: string; at: Date | null; tags: (string | null)[] | null };

describe('db.query', () => {
	it('is a type error without a schema', () => {
		expectTypeOf(drizzle(client).query).toEqualTypeOf<
			DrizzleTypeError<'Seems like the schema generic is missing - did you forget to add it to your DB type?'>
		>();
	});

	it('types findMany() and findFirst() rows with every column', async () => {
		expectTypeOf(db.query.users.findMany()).toEqualTypeOf<CubridRelationalQuery<User[]>>();
		expectTypeOf(await db.query.users.findMany()).toEqualTypeOf<User[]>();
		expectTypeOf(await db.query.users.findFirst()).toEqualTypeOf<User | undefined>();
		expectTypeOf(await drizzle(pool, { schema }).query.posts.findMany()).toEqualTypeOf<Post[]>();
	});

	it('types columns include and exclude, extras and nested with', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true, name: true },
			extras: { n: sql<number>`1`.as('n') },
			with: {
				posts: {
					columns: { authorId: false, tags: false },
					with: { comments: { columns: { body: true } } },
				},
				manager: { columns: { name: true } },
				profile: true,
				memberships: { columns: {}, with: { group: true } },
			},
		});
		expectTypeOf(rows).toEqualTypeOf<
			{
				id: bigint;
				name: string;
				n: number;
				posts: { id: number; title: string; at: Date | null; comments: { body: string }[] }[];
				manager: { name: string } | null;
				profile: { userId: bigint; bio: string | null } | null;
				memberships: { group: { id: number; name: string } }[];
			}[]
		>();
	});

	it('types a not-null many-to-one relation as an object', async () => {
		const [post] = await db.query.posts.findMany({
			columns: { id: true },
			with: { author: { columns: { id: true } } },
		});
		expectTypeOf(post).toEqualTypeOf<{ id: number; author: { id: bigint } }>();
	});

	it('accepts where and orderBy as objects and callbacks, and a nested limit', () => {
		db.query.users.findMany({
			where: (u, { eq }) => eq(u.name, 'a'),
			orderBy: (u, { desc }) => [desc(u.id)],
			limit: 10,
			offset: 5,
			with: { posts: { where: (p, { gt }) => gt(p.id, 1), orderBy: schema.posts.id, limit: 3 } },
		});
		// @ts-expect-error findFirst takes no limit
		db.query.users.findFirst({ limit: 2 });
		// @ts-expect-error an unknown relation
		db.query.users.findMany({ with: { nope: true } });
		// @ts-expect-error an unknown option
		db.query.users.findMany({ having: 1 });
	});

	it('types prepare() with the query result, and iterator() as refused (#165)', async () => {
		const many = db.query.users.findMany({ columns: { id: true }, limit: sql.placeholder('n') }).prepare();
		expectTypeOf(await many.execute({ n: 1 })).toEqualTypeOf<{ id: bigint }[]>();
		expectTypeOf(many.execute).parameters.toEqualTypeOf<[placeholderValues?: Record<string, unknown>]>();
		const first = db.query.users.findFirst({ columns: { name: true } }).prepare();
		expectTypeOf(await first.execute()).toEqualTypeOf<{ name: string } | undefined>();
		expectTypeOf(db.query.users.findMany().iterator).returns.toBeNever();
	});

	it('has the schema in a transaction', () => {
		db.transaction(async (tx) => {
			expectTypeOf(tx).toEqualTypeOf<CubridTransaction<typeof schema>>();
			expectTypeOf(await tx.query.users.findFirst({ columns: { id: true } })).toEqualTypeOf<
				{ id: bigint } | undefined
			>();
			await tx.transaction(async (nested) => {
				expectTypeOf(await nested.query.groups.findMany()).toEqualTypeOf<{ id: number; name: string }[]>();
			});
		});
	});
});
