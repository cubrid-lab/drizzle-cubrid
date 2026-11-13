import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// Runs Drizzle's real row mapping (no mocks) over rows shaped like
// cubrid-client's: with { rowMode: 'array' } each row is its values in
// select-list order; without it, an object keyed by column label in which a
// repeated label keeps only its last value (#183).
class CubridLikeClient implements CubridQueryable {
	constructor(private rows: unknown[][]) {}

	async query<T>(sql: string, _params?: readonly unknown[], options?: unknown): Promise<T[]> {
		if ((options as { rowMode?: string } | undefined)?.rowMode === 'array') {
			return this.rows.map((row) => [...row]) as T[];
		}
		const labels = [...sql.matchAll(/`(\w+)`\.`(\w+)`/g)].map((m) => m[2]);
		return this.rows.map((row) => Object.fromEntries(labels.map((label, i) => [label, row[i]]))) as T[];
	}

	async queryPrepared<T>(sql: string, params?: readonly unknown[], options?: unknown): Promise<T[]> {
		return this.query<T>(sql, params, options);
	}
}

const users = cubridTable('users', {
	id: int('id').primaryKey(),
	name: varchar('name', { length: 40 }),
});

const posts = cubridTable('posts', {
	id: int('id').primaryKey(),
	userId: int('user_id'),
	name: varchar('name', { length: 40 }),
});

describe('row mapping with repeated column labels', () => {
	// SELECT users.id, users.name, posts.id, posts.user_id, posts.name
	const joinedRows = [
		[1, '앨리스', 10, 1, '첫 글'],
		[2, 'bob', null, null, null],
	];

	it('maps a left join whose tables share id and name', async () => {
		const db = drizzle(new CubridLikeClient(joinedRows));

		const result = await db.select().from(users).leftJoin(posts, eq(posts.userId, users.id));

		expect(result).toEqual([
			{ users: { id: 1, name: '앨리스' }, posts: { id: 10, userId: 1, name: '첫 글' } },
			{ users: { id: 2, name: 'bob' }, posts: null },
		]);
	});

	it('maps a partial select of two same-named columns', async () => {
		const db = drizzle(new CubridLikeClient([['앨리스', '첫 글']]));

		const result = await db
			.select({ userName: users.name, postName: posts.name })
			.from(users)
			.innerJoin(posts, eq(posts.userId, users.id));

		expect(result).toEqual([{ userName: '앨리스', postName: '첫 글' }]);
	});

	it('refuses a client that ignores rowMode and returns object rows', async () => {
		const objectRows: CubridQueryable = {
			async query<T>(): Promise<T[]> {
				return [{ id: 1, name: 'x' }] as T[];
			},
			async queryPrepared<T>(): Promise<T[]> {
				return [{ id: 1, name: 'x' }] as T[];
			},
		};
		const db = drizzle(objectRows);

		await expect(db.select().from(users)).rejects.toThrow(/rowMode/);
	});
});
