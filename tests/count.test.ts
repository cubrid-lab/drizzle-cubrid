import { gt } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { int } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// db.$count() (#199): CUBRID refuses the `as count` alias Drizzle's MySQL
// builder writes, and cubrid-client returns COUNT(*) as a bigint in plain rows.
class CountClient implements CubridQueryable {
	calls: { sql: string; params: readonly unknown[] | undefined; options: unknown }[] = [];

	constructor(private rows: unknown[]) {}

	async query<T>(sql: string, params?: readonly unknown[], options?: unknown): Promise<T[]> {
		this.calls.push({ sql, params, options });
		return this.rows as T[];
	}

	async queryPrepared<T>(sql: string, params?: readonly unknown[], options?: unknown): Promise<T[]> {
		return this.query<T>(sql, params, options);
	}
}

const users = cubridTable('users', { id: int('id').primaryKey() });

describe('db.$count()', () => {
	it('counts without the reserved alias and reads the bigint by position', async () => {
		const client = new CountClient([[3n]]);

		const count = await drizzle(client).$count(users);

		expect(count).toBe(3);
		expect(client.calls).toEqual([
			{ sql: 'select count(*) from `users`', params: [], options: { rowMode: 'array' } },
		]);
	});

	it('passes the filter values as parameters', async () => {
		const client = new CountClient([[1n]]);

		const count = await drizzle(client).$count(users, gt(users.id, 5));

		expect(count).toBe(1);
		expect(client.calls[0]).toMatchObject({
			sql: 'select count(*) from `users` where `users`.`id` > ?',
			params: [5],
		});
	});

	it('counts inside a transaction on the transaction client', async () => {
		const txClient = new CountClient([[2n]]);
		const client: CubridQueryable = {
			query: async () => [],
			queryPrepared: async () => [],
			transaction: async (callback) => callback(txClient),
		};

		const count = await drizzle(client).transaction((tx) => tx.$count(users));

		expect(count).toBe(2);
		expect(txClient.calls).toHaveLength(1);
	});

	it('refuses object rows and an empty result', async () => {
		await expect(drizzle(new CountClient([{ count: 1n }])).$count(users)).rejects.toThrow(/non-array row/);
		await expect(drizzle(new CountClient([])).$count(users)).rejects.toThrow('$count() returned no row');
	});

	it('refuses count SQL it does not recognise', async () => {
		const db = drizzle(new CountClient([[1n]]));
		const session = (db as unknown as { session: { count(sql: unknown): Promise<number> } }).session;
		const { sql } = await import('drizzle-orm');

		await expect(session.count(sql`select 1`)).rejects.toThrow(/Unexpected \$count\(\) SQL/);
	});
});
