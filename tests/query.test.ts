import { asc, desc, eq, inArray, like, ne, notInArray, sql } from 'drizzle-orm';

import { char, int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

class MockClient implements CubridQueryable {
	queries: { sql: string; params?: readonly unknown[] }[] = [];

	async query<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]> {
		this.queries.push({ sql: sqlText, params });
		return [];
	}

	async queryPrepared<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]> {
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

describe('CHAR values are sent typed CHAR (#237)', () => {
	const codes = cubridTable('codes', {
		id: int('id').primaryKey(),
		code: char('code', { length: 10 }),
		flag: char('flag'),
		name: varchar('name', { length: 10 }),
	});
	const db = drizzle(new MockClient());
	const where = (condition: ReturnType<typeof eq>) => db.select({ id: codes.id }).from(codes).where(condition).toSQL();
	const prefix = 'select `id` from `codes` where ';

	it.each([
		[
			'inArray',
			inArray(codes.code, ['ab', 'cd']),
			'`codes`.`code` in (cast(? as CHAR(10)), cast(? as CHAR(10)))',
			['ab', 'cd'],
		],
		[
			'notInArray',
			notInArray(codes.code, ['ab', 'cd']),
			'`codes`.`code` not in (cast(? as CHAR(10)), cast(? as CHAR(10)))',
			['ab', 'cd'],
		],
		['eq', eq(codes.code, 'ab'), '`codes`.`code` = cast(? as CHAR(10))', ['ab']],
		['ne', ne(codes.code, 'ab'), '`codes`.`code` <> cast(? as CHAR(10))', ['ab']],
		[
			'a longer value',
			inArray(codes.code, ['abcdefghijk', 'ab']),
			'`codes`.`code` in (cast(? as CHAR(11)), cast(? as CHAR(10)))',
			['abcdefghijk', 'ab'],
		],
		['a multi-byte value', eq(codes.code, '가나다라'), '`codes`.`code` = cast(? as CHAR(12))', ['가나다라']],
		[
			'char() without a length',
			inArray(codes.flag, ['a', 'b']),
			'`codes`.`flag` in (cast(? as CHAR(1)), cast(? as CHAR(1)))',
			['a', 'b'],
		],
		[
			'null',
			inArray(codes.code, ['ab', null as unknown as string]),
			'`codes`.`code` in (cast(? as CHAR(10)), ?)',
			['ab', null],
		],
		['a VARCHAR column', inArray(codes.name, ['ab', 'cd']), '`codes`.`name` in (?, ?)', ['ab', 'cd']],
		['like()', like(codes.code, 'a%'), '`codes`.`code` like ?', ['a%']],
	])('%s', (_label, condition, text, params) => {
		expect(where(condition)).toEqual({ sql: prefix + text, params });
	});

	it('casts in inserts and updates; leaves placeholders as ?', () => {
		expect(db.insert(codes).values({ id: 1, code: 'ab' }).toSQL().sql).toBe(
			'insert into `codes` (`id`, `code`, `flag`, `name`) values (?, cast(? as CHAR(10)), default, default)',
		);
		expect(db.update(codes).set({ code: 'ab' }).toSQL().sql).toBe('update `codes` set `code` = cast(? as CHAR(10))');
		expect(where(eq(codes.code, sql.placeholder('c'))).sql).toBe(`${prefix}\`codes\`.\`code\` = ?`);
	});
});
