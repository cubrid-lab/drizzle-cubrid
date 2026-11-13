import { eq, relations } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// Relational queries (#200): loading relations with `with` is refused before
// anything is sent; the rest of db.query works in both modes.
class RecordingClient implements CubridQueryable {
	sent: string[] = [];

	constructor(private rows: unknown[][] = []) {}

	async query<T>(sql: string): Promise<T[]> {
		this.sent.push(sql);
		return this.rows.map((row) => [...row]) as T[];
	}

	async queryPrepared<T>(sql: string): Promise<T[]> {
		return this.query<T>(sql);
	}
}

const users = cubridTable('users', { id: int('id').primaryKey(), name: varchar('name', { length: 40 }) });
const posts = cubridTable('posts', { id: int('id').primaryKey(), userId: int('user_id') });
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one }) => ({
	author: one(users, { fields: [posts.userId], references: [users.id] }),
}));
const schema = { users, posts, usersRelations, postsRelations };

describe('relational queries', () => {
	for (const mode of ['default', 'planetscale'] as const) {
		it(`refuses with in ${mode} mode before sending anything`, async () => {
			const client = new RecordingClient();
			const db = drizzle(client, { schema, mode });

			await expect(db.query.users.findMany({ with: { posts: true } })).rejects.toThrow(
				"Relational queries with 'with' (posts) are not supported on CUBRID",
			);
			await expect(
				db.query.posts.findFirst({ with: { author: { columns: { name: true } } } }),
			).rejects.toThrow("'with' (author)");
			expect(client.sent).toEqual([]);
		});

		it(`runs findMany and findFirst without relations in ${mode} mode`, async () => {
			const client = new RecordingClient([[1, '앨리스']]);
			const db = drizzle(client, { schema, mode });

			expect(await db.query.users.findMany({ with: { posts: false } })).toEqual([{ id: 1, name: '앨리스' }]);
			expect(await db.query.users.findFirst({ where: eq(users.id, 1) })).toEqual({ id: 1, name: '앨리스' });
			expect(client.sent).toHaveLength(2);
			expect(client.sent.join('\n')).not.toMatch(/lateral|json_arrayagg/i);
		});
	}
});
