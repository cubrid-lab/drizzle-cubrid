import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridExecuteResult, CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// Goes through Drizzle's own query builders, which mark update and delete as
// writes (drizzle-orm 0.45 passes type 'insert' for update), to check that
// they reach execute() and return its counts (#182).
class RecordingClient implements CubridQueryable {
	executed: string[] = [];
	queried: string[] = [];

	constructor(private result: CubridExecuteResult) {}

	async query<T>(sql: string): Promise<T[]> {
		this.queried.push(sql);
		return [];
	}

	async execute(sql: string): Promise<CubridExecuteResult> {
		this.executed.push(sql);
		return this.result;
	}
}

const users = cubridTable('users', {
	id: int('id').primaryKey().autoincrement(),
	name: varchar('name', { length: 40 }),
});

describe('Drizzle write builders', () => {
	it('report affectedRows for update and delete', async () => {
		const client = new RecordingClient({ affectedRows: 3 });
		const db = drizzle(client);

		const updated = await db.update(users).set({ name: 'x' }).where(eq(users.id, 1));
		const deleted = await db.delete(users).where(eq(users.id, 1));

		expect(updated.affectedRows).toBe(3);
		expect(deleted.affectedRows).toBe(3);
		expect(client.executed).toHaveLength(2);
		expect(client.queried).toEqual([]);
	});

	it('reports lastInsertId for insert and the key for $returningId()', async () => {
		const client = new RecordingClient({ affectedRows: 1, lastInsertId: 42 });
		const db = drizzle(client);

		const inserted = await db.insert(users).values({ name: 'a' });
		const keys = await db.insert(users).values({ name: 'b' }).$returningId();

		expect(inserted.lastInsertId).toBe(42);
		expect(keys).toEqual([{ id: 42 }]);
	});

	it('keeps raw db.execute() on query()', async () => {
		const client = new RecordingClient({ affectedRows: 1 });
		const db = drizzle(client);

		await db.execute('update users set name = 1');

		expect(client.queried).toHaveLength(1);
		expect(client.executed).toEqual([]);
	});
});
