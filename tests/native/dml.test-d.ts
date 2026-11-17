// Types of the native INSERT, UPDATE and DELETE builders (#159).
import type { CubridClient } from 'cubrid-client';
import { eq, type Placeholder, type SQL, sql } from 'drizzle-orm';
import { describe, expectTypeOf, it } from 'vitest';

import {
	bigint,
	type CubridDmlResult,
	type CubridInsertValue,
	type CubridReturningId,
	type CubridUpdateSet,
	cubridTable,
	datetime,
	drizzle,
	integer,
	set,
	varchar,
} from '../../src/native/index';

const users = cubridTable('users', {
	id: bigint({ mode: 'bigint' }).primaryKey().autoIncrement(),
	name: varchar({ length: 50 }).notNull(),
	email: varchar({ length: 50 }),
	visits: integer().notNull().default(0),
	at: datetime().$defaultFn(() => new Date()),
	tags: set({ element: varchar({ length: 10 }) }),
});
const docs = cubridTable('docs', {
	id: varchar({ length: 36 })
		.primaryKey()
		.$defaultFn(() => 'x'),
	given: integer().primaryKey(),
	title: varchar({ length: 50 }),
});

declare const client: CubridClient;
const db = drizzle(client);

describe('insert', () => {
	it('requires notNull columns without a default and makes the others optional', () => {
		expectTypeOf<CubridInsertValue<typeof users>>().toEqualTypeOf<{
			id?: bigint | null | SQL | Placeholder;
			name: string | SQL | Placeholder;
			email?: string | null | SQL | Placeholder;
			visits?: number | SQL | Placeholder;
			at?: Date | null | SQL | Placeholder;
			tags?: (string | null)[] | null | SQL | Placeholder;
		}>();
		db.insert(users).values({ name: 'a' });
		db.insert(users).values([
			{ name: 'a', tags: ['x', null] },
			{ name: sql`'b'`, email: null },
		]);
		// @ts-expect-error name is required
		db.insert(users).values({ email: 'a' });
		// @ts-expect-error name is not nullable
		db.insert(users).values({ name: null });
		db.insert(users).values({ id: null, name: 'a' });
		// @ts-expect-error only an autoIncrement column may be null
		db.insert(docs).values({ id: null, given: 1 });
		// @ts-expect-error wrong value type
		db.insert(users).values({ name: 'a', visits: 'many' });
	});

	it('resolves to the driver result', () => {
		expectTypeOf(db.insert(users).values({ name: 'a' }).execute()).toEqualTypeOf<Promise<CubridDmlResult>>();
		expectTypeOf<CubridDmlResult>().toEqualTypeOf<{ affectedRows: number; lastInsertId?: number | bigint }>();
		expectTypeOf(db.delete(users).execute()).toEqualTypeOf<Promise<CubridDmlResult>>();
		expectTypeOf(db.update(users).set({ name: 'b' }).execute()).toEqualTypeOf<Promise<CubridDmlResult>>();
	});

	it('types $returningId() with the AUTO_INCREMENT and $defaultFn primary keys', async () => {
		expectTypeOf(await db.insert(users).values({ name: 'a' }).$returningId()).toEqualTypeOf<{ id: bigint }[]>();
		expectTypeOf<CubridReturningId<typeof docs>>().toEqualTypeOf<{ id: string }>();
	});

	it('types onDuplicateKeyUpdate and insert … select', () => {
		db.insert(users)
			.values({ name: 'a' })
			.onDuplicateKeyUpdate({ set: { visits: sql`${users.visits} + 1` } });
		const upsert = db.insert(users).values({ name: 'a' });
		// @ts-expect-error wrong value type
		upsert.onDuplicateKeyUpdate({ set: { visits: 'x' } });
		db.insert(docs).select((qb) => qb.select({ title: users.name }).from(users));
		db.insert(docs).select(db.select({ title: users.name }).from(users));
	});
});

describe('update and delete', () => {
	it('takes any column as a value or sql', () => {
		expectTypeOf<CubridUpdateSet<typeof docs>>().toEqualTypeOf<{
			id?: string | SQL | Placeholder;
			given?: number | SQL | Placeholder;
			title?: string | null | SQL | Placeholder;
		}>();
		db.update(users).set({ name: 'b', tags: [] }).where(eq(users.id, 1n)).orderBy(users.id).limit(1);
		// @ts-expect-error name is not nullable
		db.update(users).set({ name: null });
		db.delete(users).where(eq(users.id, 1n)).limit(1);
		// @ts-expect-error CUBRID rejects DELETE with ORDER BY
		db.delete(users).orderBy(users.id);
	});
});
