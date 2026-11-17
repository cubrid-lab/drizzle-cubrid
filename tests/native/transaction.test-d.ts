// Types of native transactions (#161).
import type { CubridClient, CubridPool } from 'cubrid-client';
import { describe, expectTypeOf, it } from 'vitest';

import {
	type CubridTransaction,
	type CubridTransactionConfig,
	cubridTable,
	drizzle,
	integer,
	varchar,
} from '../../src/native/index';

const users = cubridTable('users', {
	id: integer().primaryKey().autoIncrement(),
	name: varchar({ length: 50 }).notNull(),
});

declare const client: CubridClient;
declare const pool: CubridPool;

describe('transaction', () => {
	it('passes a CubridTransaction and resolves to the callback value', () => {
		const db = drizzle(client);
		const result = db.transaction(async (tx) => {
			expectTypeOf(tx).toEqualTypeOf<CubridTransaction>();
			const rows = await tx.select({ id: users.id }).from(users);
			expectTypeOf(rows).toEqualTypeOf<{ id: number }[]>();
			const ids = await tx.insert(users).values({ name: 'a' }).$returningId();
			expectTypeOf(ids).toEqualTypeOf<{ id: number }[]>();
			const nested = await tx.transaction(async (inner) => {
				expectTypeOf(inner).toEqualTypeOf<CubridTransaction>();
				return 1n;
			});
			expectTypeOf(nested).toEqualTypeOf<bigint>();
			return rows.length;
		});
		expectTypeOf(result).toEqualTypeOf<Promise<number>>();
		expectTypeOf(drizzle(pool).transaction(async () => 'x')).toEqualTypeOf<Promise<string>>();
	});

	it('types rollback() as never', () => {
		expectTypeOf<CubridTransaction['rollback']>().returns.toBeNever();
	});

	it('accepts only CUBRID isolation levels', () => {
		const db = drizzle(client);
		db.transaction(async () => undefined, { isolationLevel: 'repeatable read' });
		// @ts-expect-error: CUBRID has no READ UNCOMMITTED.
		db.transaction(async () => undefined, { isolationLevel: 'read uncommitted' });
		// @ts-expect-error: no access mode.
		db.transaction(async () => undefined, { accessMode: 'read only' });
		expectTypeOf<CubridTransactionConfig['isolationLevel']>().toEqualTypeOf<
			'read committed' | 'repeatable read' | 'serializable' | undefined
		>();
	});

	it('requires a callback that returns a promise', () => {
		const db = drizzle(client);
		// @ts-expect-error: the callback must be async.
		db.transaction(() => 1);
	});
});
