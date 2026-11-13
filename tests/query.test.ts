import { asc, desc, eq } from 'drizzle-orm';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

class MockClient implements CubridQueryable {
	queries: { sql: string; params?: readonly unknown[] }[] = [];

	async query<T extends Record<string, unknown>>(
		sqlText: string,
		params?: readonly unknown[],
	): Promise<T[]> {
		this.queries.push({ sql: sqlText, params });
		return [];
	}

	async queryPrepared<T extends Record<string, unknown>>(
		sqlText: string,
		params?: readonly unknown[],
	): Promise<T[]> {
		return this.query<T>(sqlText, params);
	}
}

const users = cubridTable('users', {
	id: int('id').primaryKey().autoincrement(),
	name: varchar('name', { length: 255 }),
});

const posts = cubridTable('posts', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id'),
	title: varchar('title', { length: 255 }),
});

describe('query building', () => {
	it('builds SELECT query', () => {
		const db = drizzle(new MockClient());
		const query = db.select().from(users).toSQL();

		expect(query.sql.toLowerCase()).toContain('select');
		expect(query.sql).toContain('from `users`');
		expect(query.params).toEqual([]);
	});

	it('builds INSERT query', () => {
		const db = drizzle(new MockClient());
		const query = db.insert(users).values({ name: 'Alice' }).toSQL();

		expect(query.sql.toLowerCase()).toContain('insert into `users`');
		expect(query.sql.toLowerCase()).toContain('values');
		expect(query.params).toEqual(['Alice']);
	});

	it('builds UPDATE query', () => {
		const db = drizzle(new MockClient());
		const query = db.update(users).set({ name: 'Bob' }).where(eq(users.id, 1)).toSQL();

		expect(query.sql.toLowerCase()).toContain('update `users`');
		expect(query.sql.toLowerCase()).toContain('set `name` = ?');
		expect(query.sql.toLowerCase()).toContain('where `users`.`id` = ?');
		expect(query.params).toEqual(['Bob', 1]);
	});

	it('builds DELETE query', () => {
		const db = drizzle(new MockClient());
		const query = db.delete(users).where(eq(users.id, 2)).toSQL();

		expect(query.sql.toLowerCase()).toContain('delete from `users`');
		expect(query.sql.toLowerCase()).toContain('where `users`.`id` = ?');
		expect(query.params).toEqual([2]);
	});

	it('builds SELECT with WHERE, ORDER BY, LIMIT', () => {
		const db = drizzle(new MockClient());
		const query = db
			.select({ id: users.id, name: users.name })
			.from(users)
			.where(eq(users.id, 3))
			.orderBy(desc(users.id), asc(users.name))
			.limit(5)
			.toSQL();

		expect(query.sql.toLowerCase()).toContain('where `users`.`id` = ?');
		expect(query.sql.toLowerCase()).toContain('order by `users`.`id` desc, `users`.`name` asc');
		expect(query.sql.toLowerCase()).toContain('limit ?');
		expect(query.params).toEqual([3, 5]);
	});

	it('builds SELECT with JOIN using mysql-compatible syntax', () => {
		const db = drizzle(new MockClient());
		const query = db
			.select({ userId: users.id, postId: posts.id })
			.from(users)
			.innerJoin(posts, eq(users.id, posts.userId))
			.toSQL();

		expect(query.sql.toLowerCase()).toContain('inner join `posts`');
		expect(query.sql.toLowerCase()).toContain('on `users`.`id` = `posts`.`user_id`');
		expect(query.sql).toContain('`users`');
		expect(query.sql).toContain('`posts`');
		expect(query.params).toEqual([]);
	});
});
