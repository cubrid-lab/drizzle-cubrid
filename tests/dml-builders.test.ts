import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridExecuteResult, CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// Goes through Drizzle's own query builders and records which driver method
// ran each statement: writes reach execute()/executePrepared() (#182), and
// values travel as typed binds unless { binding: 'literal' } is set (#191).
class RecordingClient implements CubridQueryable {
	calls: string[] = [];

	constructor(private result: CubridExecuteResult = { affectedRows: 0 }) {}

	async query<T>(): Promise<T[]> {
		this.calls.push('query');
		return [];
	}

	async queryPrepared<T>(): Promise<T[]> {
		this.calls.push('queryPrepared');
		return [];
	}

	async execute(): Promise<CubridExecuteResult> {
		this.calls.push('execute');
		return this.result;
	}

	async executePrepared(): Promise<CubridExecuteResult> {
		this.calls.push('executePrepared');
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
		expect(client.calls).toEqual(['executePrepared', 'executePrepared']);
	});

	it('reports lastInsertId for insert and the key for $returningId()', async () => {
		const client = new RecordingClient({ affectedRows: 1, lastInsertId: 42 });
		const db = drizzle(client);

		const inserted = await db.insert(users).values({ name: 'a' });
		const keys = await db.insert(users).values({ name: 'b' }).$returningId();

		expect(inserted.lastInsertId).toBe(42);
		expect(keys).toEqual([{ id: 42 }]);
	});

	it('keeps raw db.execute() on a row query', async () => {
		const client = new RecordingClient();
		const db = drizzle(client);

		await db.execute('update users set name = 1');

		expect(client.calls).toEqual(['queryPrepared']);
	});
});

describe('parameter binding (#191)', () => {
	it('sends values as typed binds by default', async () => {
		const client = new RecordingClient();
		const db = drizzle(client);

		await db.select().from(users).where(eq(users.id, -1));
		await db.insert(users).values({ name: 'a' });
		await db.execute('select 1');

		expect(client.calls).toEqual(['queryPrepared', 'executePrepared', 'queryPrepared']);
	});

	it("renders values as SQL literals with { binding: 'literal' }", async () => {
		const client = new RecordingClient();
		const db = drizzle(client, { binding: 'literal' });

		await db.select().from(users).where(eq(users.id, -1));
		await db.insert(users).values({ name: 'a' });
		await db.execute('select 1');

		expect(client.calls).toEqual(['query', 'execute', 'query']);
	});

	it('uses typed binds inside a transaction on its own connection', async () => {
		const tx = new RecordingClient();
		const client = Object.assign(new RecordingClient(), {
			async transaction<T>(callback: (txClient: CubridQueryable) => Promise<T>): Promise<T> {
				return callback(tx);
			},
		});
		const db = drizzle(client);

		await db.transaction(async (t) => {
			await t.select().from(users);
			await t.update(users).set({ name: 'b' });
		});

		expect(client.calls).toEqual([]);
		expect(tx.calls).toEqual(['queryPrepared', 'executePrepared']);
	});

	it('refuses a client without typed binding instead of falling back to literals', () => {
		const literalOnly: CubridQueryable = {
			async query<T>(): Promise<T[]> {
				return [];
			},
		};

		expect(() => drizzle(literalOnly)).toThrow(/binding: 'literal'/);
		expect(() => drizzle(literalOnly, { binding: 'literal' })).not.toThrow();
	});

	it('refuses an unknown binding value', () => {
		expect(() => drizzle(new RecordingClient(), { binding: 'text' as never })).toThrow(/binding/);
	});
});
