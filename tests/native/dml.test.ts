// Native INSERT, UPDATE and DELETE (#159) with a fake client: golden SQL for
// every builder method and refusal, DEFAULT filling, $defaultFn/$onUpdateFn,
// collection literals, result passthrough, $returningId, binding modes and
// error passthrough.
import { asc, desc, eq, gt, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
	bigint,
	boolean,
	CubridDelete,
	CubridInsert,
	CubridUpdate,
	cubridTable,
	datetime,
	drizzle,
	integer,
	multiset,
	sequence,
	set,
	varchar,
} from '../../src/native/index';

const users = cubridTable('users', {
	id: integer().primaryKey().autoIncrement(),
	name: varchar({ length: 50 }).notNull(),
	active: boolean().default(true),
	visits: bigint({ mode: 'bigint' }),
});
const bigUsers = cubridTable('big_users', {
	id: bigint({ mode: 'bigint' }).primaryKey().autoIncrement(),
	name: varchar({ length: 50 }),
});
let next = 0;
const docs = cubridTable('docs', {
	id: varchar({ length: 36 })
		.primaryKey()
		.$defaultFn(() => `id-${++next}`),
	title: varchar({ length: 50 }),
	at: datetime().$onUpdateFn(() => new Date(Date.UTC(2024, 0, 2, 3, 4, 5))),
});
const bags = cubridTable('bags', {
	id: integer().primaryKey(),
	tags: set({ element: varchar({ length: 10 }) }),
	counts: multiset({ element: bigint({ mode: 'bigint' }) }),
	flags: sequence({ element: boolean() }),
});
const plain = cubridTable('plain', { a: integer(), b: varchar({ length: 5 }) });

type Call = { method: string; sql: string; params: readonly unknown[] | undefined };

/** A cubrid-client stand-in for writes: records calls and returns the queued results. */
function fakeClient(results: unknown[] = []) {
	const calls: Call[] = [];
	const queue = [...results];
	// Typed `never` so one stand-in fits both the row and the write methods.
	const respond =
		(method: string) =>
		async (sql: string, params?: readonly unknown[]): Promise<never> => {
			calls.push({ method, sql, params });
			const result = queue.shift() ?? { affectedRows: 1 };
			if (result instanceof Error) throw result;
			return result as never;
		};
	return {
		calls,
		query: respond('query'),
		queryPrepared: respond('queryPrepared'),
		execute: respond('execute'),
		executePrepared: respond('executePrepared'),
		timezone: 'utc',
	};
}

const db = drizzle(fakeClient());

describe('golden SQL', () => {
	it.each([
		[
			'insert one row, missing columns as DEFAULT',
			db.insert(users).values({ name: 'a' }),
			'insert into "users" ("id", "name", "active", "visits") values (default, ?, default, default)',
			['a'],
		],
		[
			'insert rows with NULL, values encoded by their codec',
			db.insert(users).values([
				{ name: 'a', active: false, visits: null },
				{ id: 7, name: 'b', visits: 5n },
			]),
			'insert into "users" ("id", "name", "active", "visits") values (default, ?, ?, ?), (?, ?, default, ?)',
			['a', 0, null, 7, 'b', 5n],
		],
		[
			'insert sql values',
			db.insert(plain).values({ a: sql`1 + ${2}`, b: sql`upper(${'x'})` }),
			'insert into "plain" ("a", "b") values (1 + ?, upper(?))',
			[2, 'x'],
		],
		[
			'onDuplicateKeyUpdate',
			db
				.insert(users)
				.values({ id: 1, name: 'a' })
				.onDuplicateKeyUpdate({ set: { name: 'b', active: true, visits: sql`${users.visits} + 1` } }),
			'insert into "users" ("id", "name", "active", "visits") values (?, ?, default, default) on duplicate key update "name" = ?, "active" = ?, "visits" = "users"."visits" + 1',
			[1, 'a', 'b', 1],
		],
		[
			'insert … select with a builder',
			db.insert(plain).select(db.select({ a: users.id, b: users.name }).from(users).where(gt(users.id, 5))),
			'insert into "plain" ("a", "b") select "users"."id", "users"."name" from "users" where "users"."id" > ?',
			[5],
		],
		[
			'insert … select with a callback, a column subset and sql fields',
			db.insert(plain).select((qb) => qb.selectDistinct({ b: sql<string>`'x'` }).from(users)),
			`insert into "plain" ("b") select distinct 'x' from "users"`,
			[],
		],
		[
			'insert … select of a whole table with a callback',
			db.insert(plain).select((qb) => qb.select().from(plain)),
			'insert into "plain" ("a", "b") select "plain"."a", "plain"."b" from "plain"',
			[],
		],
		[
			'update with where, orderBy and limit',
			db
				.update(users)
				.set({ name: 'z', active: false, visits: undefined })
				.where(eq(users.id, 3))
				.orderBy(desc(users.id), asc(users.name))
				.limit(2),
			'update "users" set "name" = ?, "active" = ? where "users"."id" = ? order by "users"."id" desc, "users"."name" asc limit ?',
			['z', 0, 3, 2],
		],
		[
			'update with sql',
			db.update(plain).set({ a: sql`${plain.a} + ${1}` }),
			'update "plain" set "a" = "plain"."a" + ?',
			[1],
		],
		['delete everything', db.delete(plain), 'delete from "plain"', []],
		[
			'delete with where and limit',
			db.delete(users).where(eq(users.name, 'a')).limit(1),
			'delete from "users" where "users"."name" = ? limit ?',
			['a', 1],
		],
		[
			'collections as typed literals, empty and with NULL elements',
			db.insert(bags).values([
				{ id: 1, tags: ['a', null], counts: [9007199254740993n], flags: [true, false] },
				{ id: 2, tags: [], counts: null },
			]),
			'insert into "bags" ("id", "tags", "counts", "flags") values (?, CAST(SET{?, ?} AS SET(STRING)), CAST(MULTISET{?} AS MULTISET(BIGINT)), CAST(SEQUENCE{?, ?} AS SEQUENCE(SMALLINT))), (?, CAST(SET{} AS SET(STRING)), ?, default)',
			[1, 'a', null, 9007199254740993n, 1, 0, 2, null],
		],
		[
			'collections in update set and onDuplicateKeyUpdate',
			db
				.insert(bags)
				.values({ id: 1 })
				.onDuplicateKeyUpdate({ set: { tags: ['b'], flags: [] } }),
			'insert into "bags" ("id", "tags", "counts", "flags") values (?, default, default, default) on duplicate key update "tags" = CAST(SET{?} AS SET(STRING)), "flags" = CAST(SEQUENCE{} AS SEQUENCE(SMALLINT))',
			[1, 'b'],
		],
		[
			'collection update',
			db
				.update(bags)
				.set({ counts: [1n, 2n], tags: null })
				.where(eq(bags.id, 1)),
			'update "bags" set "counts" = CAST(MULTISET{?, ?} AS MULTISET(BIGINT)), "tags" = ? where "bags"."id" = ?',
			[1n, 2n, null, 1],
		],
	])('%s', (_, query, expectedSql, expectedParams) => {
		expect(query.toSQL()).toEqual({ sql: expectedSql, params: expectedParams });
	});

	it('quotes identifiers with embedded double quotes', () => {
		const weird = cubridTable('we"ird', { 'co"l': integer('co"l') });
		expect(db.insert(weird).values({ 'co"l': 1 }).toSQL().sql).toBe('insert into "we""ird" ("co""l") values (?)');
		expect(db.update(weird).set({ 'co"l': 2 }).toSQL().sql).toBe('update "we""ird" set "co""l" = ?');
	});

	it('returns builders that are Drizzle entities and support $dynamic()', () => {
		expect(db.delete(plain).$dynamic()).toBeInstanceOf(CubridDelete);
		expect(db.update(plain).set({ a: 1 }).$dynamic()).toBeInstanceOf(CubridUpdate);
		expect(db.insert(plain).values({})).toBeInstanceOf(CubridInsert);
	});
});

describe('generated values', () => {
	it('generates $defaultFn values per row and keeps given ones', () => {
		next = 0;
		const query = db
			.insert(docs)
			.values([{ title: 'a' }, { id: 'mine', title: 'b' }, { title: 'c' }])
			.toSQL();
		expect(query.params.filter((p) => typeof p === 'string' && p.startsWith('id-'))).toEqual(['id-1', 'id-2']);
		expect(query.params).toContain('mine');
	});

	it('writes $onUpdateFn values on insert (no .default()) and on update when not set', () => {
		next = 0;
		expect(db.insert(docs).values({ title: 'a' }).toSQL()).toEqual({
			sql: 'insert into "docs" ("id", "title", "at") values (?, ?, ?)',
			params: ['id-1', 'a', '2024-01-02 03:04:05.000'],
		});
		expect(db.update(docs).set({ title: 'b' }).toSQL()).toEqual({
			sql: 'update "docs" set "title" = ?, "at" = ?',
			params: ['b', '2024-01-02 03:04:05.000'],
		});
		const at = new Date(Date.UTC(2020, 0, 1));
		expect(db.update(docs).set({ at }).toSQL().params).toEqual(['2020-01-01 00:00:00.000']);
	});

	it('keeps DEFAULT for a column with .default() and $onUpdateFn', () => {
		const t = cubridTable('t', {
			id: integer(),
			n: integer()
				.default(0)
				.$onUpdateFn(() => 5),
		});
		expect(db.insert(t).values({ id: 1 }).toSQL().sql).toBe('insert into "t" ("id", "n") values (?, default)');
		expect(db.update(t).set({ id: 2 }).toSQL()).toEqual({ sql: 'update "t" set "id" = ?, "n" = ?', params: [2, 5] });
	});

	it('uses sql returned by $defaultFn as is', () => {
		const t = cubridTable('t', { id: integer().$defaultFn(() => sql`1 + 1`) });
		expect(db.insert(t).values({}).toSQL()).toEqual({ sql: 'insert into "t" ("id") values (1 + 1)', params: [] });
	});
});

describe('refusals', () => {
	it('refuses empty values and non-object rows', () => {
		expect(() => db.insert(users).values([])).toThrow(/at least one row/);
		expect(() => db.insert(users).values([null as never])).toThrow(/objects of column values/);
		expect(() => db.insert(users).values(sql`x` as never)).toThrow(/objects of column values/);
	});

	it('refuses an empty set', () => {
		expect(() => db.update(users).set({})).toThrow(/at least one value/);
		expect(() => db.update(users).set({ name: undefined })).toThrow(/at least one value/);
		expect(() => db.insert(users).values({ name: 'a' }).onDuplicateKeyUpdate({ set: {} }).toSQL()).toThrow(
			/onDuplicateKeyUpdate\(\) needs at least one value/,
		);
	});

	it('refuses a key that is not a column', () => {
		expect(() =>
			db
				.update(users)
				.set({ nope: 1 } as never)
				.toSQL(),
		).toThrow(/users has no column with the key nope/);
	});

	it('refuses tables of other dialects and non-native selects', () => {
		expect(() => db.insert({} as never)).toThrow(/needs a drizzle-cubrid\/native table/);
		expect(() => db.update({} as never)).toThrow(/update\(\) needs/);
		expect(() => db.delete({} as never)).toThrow(/delete\(\) needs/);
		expect(() => db.insert(plain).select({ getSQL: () => sql`x`, getSelectedFields: () => ({}) })).toThrow(
			/drizzle-cubrid\/native select/,
		);
	});

	it('refuses insert … select fields that are not table columns', () => {
		expect(() => db.insert(plain).select(db.select({ c: users.id }).from(users))).toThrow(
			/selected field c is not a column of plain/,
		);
		expect(() => db.insert(plain).select(db.select({ a: { x: users.id } }).from(users))).toThrow(
			/selected field a must be a column or sql/,
		);
	});

	it('refuses wrong values through the column codec before sending', async () => {
		const client = fakeClient();
		const local = drizzle(client);
		await expect(local.insert(users).values({ id: 1.5, name: 'a' })).rejects.toThrow(/integer number/);
		await expect(local.insert(bags).values({ id: 1, tags: 'a' as never })).rejects.toThrow(/must be an array/);
		await expect(local.update(bags).set({ tags: [['a']] as never })).rejects.toThrow(/cannot be nested/);
		expect(client.calls).toEqual([]);
	});

	it('refuses a placeholder for a collection value, and collection values in conditions', () => {
		expect(() =>
			db
				.insert(bags)
				.values({ id: 1, tags: sql.placeholder('t') })
				.toSQL(),
		).toThrow(/sql.placeholder\(\) cannot stand for the value of SET column tags/);
		expect(() =>
			db
				.delete(bags)
				.where(eq(bags.tags, ['a']))
				.toSQL(),
		).toThrow(/Comparing SET column tags with a value is not supported/);
	});

	it('has no orderBy() on delete (CUBRID rejects DELETE … ORDER BY)', () => {
		expect('orderBy' in db.delete(users)).toBe(false);
	});
});

describe('execution', () => {
	it('runs writes with executePrepared() and returns the driver result fields unchanged', async () => {
		const client = fakeClient([{ affectedRows: 2, lastInsertId: 9007199254740993n, extra: 1 }, { affectedRows: 0 }]);
		const local = drizzle(client);
		const inserted = await local.insert(users).values([{ name: 'a' }, { name: 'b' }]);
		expect(inserted).toEqual({ affectedRows: 2, lastInsertId: 9007199254740993n });
		expect(await local.delete(users).where(eq(users.id, 1))).toEqual({ affectedRows: 0 });
		expect(client.calls.map((c) => c.method)).toEqual(['executePrepared', 'executePrepared']);
		expect(client.calls[1]).toEqual({
			method: 'executePrepared',
			sql: 'delete from "users" where "users"."id" = ?',
			params: [1],
		});
	});

	it("runs writes with execute() under 'literal' binding", async () => {
		const client = fakeClient([{ affectedRows: 1, lastInsertId: 4 }]);
		const local = drizzle(client, { binding: 'literal' });
		expect(await local.update(users).set({ name: "it's" })).toEqual({ affectedRows: 1, lastInsertId: 4 });
		expect(client.calls).toEqual([{ method: 'execute', sql: 'update "users" set "name" = ?', params: ["it's"] }]);
	});

	it('refuses a client without the write method of its binding', async () => {
		const prepared = drizzle({ query: async () => [], queryPrepared: async () => [] });
		await expect(prepared.delete(plain)).rejects.toThrow(/no executePrepared\(\) for INSERT, UPDATE and DELETE/);
		const literal = drizzle({ query: async () => [] }, { binding: 'literal' });
		await expect(literal.delete(plain)).rejects.toThrow(/no execute\(\) for INSERT/);
	});

	it('passes driver errors through unchanged', async () => {
		const duplicate = Object.assign(new Error('Statement failed.'), { code: -670 });
		const client = fakeClient([duplicate]);
		const error = await drizzle(client)
			.insert(users)
			.values({ name: 'a' })
			.catch((e: unknown) => e);
		expect(error).toBe(duplicate);
	});

	it('logs writes and runs prepared writes with placeholders', async () => {
		const logQuery = vi.fn();
		const client = fakeClient([{ affectedRows: 1 }, { affectedRows: 3 }, { affectedRows: 1 }]);
		const local = drizzle(client, { logger: { logQuery } });
		const update = local
			.update(users)
			.set({ name: sql.placeholder('name'), active: sql.placeholder('active') })
			.where(eq(users.id, sql.placeholder('id')))
			.limit(sql.placeholder('n'))
			.prepare();
		expect(await update.execute({ name: 'x', active: true, id: 3, n: 1 })).toEqual({ affectedRows: 1 });
		expect(client.calls[0]?.params).toEqual(['x', 1, 3, 1]);
		const remove = local
			.delete(users)
			.where(gt(users.id, sql.placeholder('id')))
			.prepare();
		expect(await remove.execute({ id: 0 })).toEqual({ affectedRows: 3 });
		const insert = local
			.insert(users)
			.values({ name: sql.placeholder('name') })
			.prepare();
		await insert.execute({ name: 'p' });
		expect(client.calls[2]?.params).toEqual(['p']);
		expect(logQuery).toHaveBeenCalledWith('delete from "users" where "users"."id" > ?', [0]);
	});

	it('refuses an array parameter before sending', async () => {
		const client = fakeClient();
		await expect(
			drizzle(client)
				.update(plain)
				.set({ a: sql`${sql.param([1])}` }),
		).rejects.toThrow(/Parameter 1 is an array/);
		expect(client.calls).toEqual([]);
	});

	it('does not check the client time zone for writes of date and time values', async () => {
		const client = { ...fakeClient(), timezone: 'local' };
		await expect(drizzle(client).update(docs).set({ title: 'a' })).resolves.toEqual({ affectedRows: 1 });
		await expect(
			drizzle(client)
				.insert(docs)
				.select(drizzle(client).select({ title: docs.title, at: docs.at }).from(docs)),
		).resolves.toEqual({ affectedRows: 1 });
		expect(client.calls.map((c) => c.method)).toEqual(['executePrepared', 'executePrepared']);
	});
});

describe('$returningId()', () => {
	it('reports the AUTO_INCREMENT key of a one-row insert from lastInsertId', async () => {
		const client = fakeClient([{ affectedRows: 1, lastInsertId: 5 }]);
		expect(await drizzle(client).insert(users).values({ name: 'a' }).$returningId()).toEqual([{ id: 5 }]);
	});

	it('keeps a bigint key exact and refuses one a number column cannot hold', async () => {
		const client = fakeClient([
			{ affectedRows: 1, lastInsertId: 9007199254740993n },
			{ affectedRows: 1, lastInsertId: 7 },
			{ affectedRows: 1, lastInsertId: 9007199254740993n },
		]);
		const local = drizzle(client);
		expect(await local.insert(bigUsers).values({}).$returningId()).toEqual([{ id: 9007199254740993n }]);
		expect(await local.insert(bigUsers).values({}).$returningId()).toEqual([{ id: 7n }]);
		await expect(local.insert(users).values({ name: 'a' }).$returningId()).rejects.toThrow(/MAX_SAFE_INTEGER/);
	});

	it('reports no key when the driver reports none or ON DUPLICATE KEY UPDATE changed a row', async () => {
		const client = fakeClient([{ affectedRows: 1 }, { affectedRows: 2, lastInsertId: 9 }]);
		const local = drizzle(client);
		expect(await local.insert(users).values({ name: 'a' }).$returningId()).toEqual([]);
		expect(
			await local
				.insert(users)
				.values({ name: 'a' })
				.onDuplicateKeyUpdate({ set: { name: 'b' } })
				.$returningId(),
		).toEqual([]);
	});

	it('reports lastInsertId for an AUTO_INCREMENT key written as NULL', async () => {
		const client = fakeClient([{ affectedRows: 1, lastInsertId: 6 }]);
		const query = drizzle(client)
			.insert(users)
			.values({ id: null as never, name: 'a' })
			.$returningId();
		expect(await query).toEqual([{ id: 6 }]);
	});

	it('reports a key the row gave instead of lastInsertId', async () => {
		const client = fakeClient([{ affectedRows: 1 }, { affectedRows: 1 }]);
		const local = drizzle(client);
		expect(await local.insert(users).values({ id: 42, name: 'a' }).$returningId()).toEqual([{ id: 42 }]);
		const prepared = local
			.insert(users)
			.values({ id: sql.placeholder('id'), name: 'a' })
			.$returningId()
			.prepare();
		expect(await prepared.execute({ id: 43 })).toEqual([{ id: 43 }]);
	});

	it('refuses a multi-row insert with an AUTO_INCREMENT key before sending', async () => {
		const client = fakeClient();
		await expect(
			drizzle(client)
				.insert(users)
				.values([{ name: 'a' }, { name: 'b' }])
				.$returningId(),
		).rejects.toThrow(/only for an INSERT of one row/);
		expect(client.calls).toEqual([]);
	});

	it('refuses insert … select before sending', async () => {
		const client = fakeClient();
		const local = drizzle(client);
		await expect(
			local
				.insert(docs)
				.select(local.select({ title: docs.title }).from(docs))
				.$returningId(),
		).rejects.toThrow(/INSERT \.\.\. SELECT/);
		expect(client.calls).toEqual([]);
	});

	it('reports $defaultFn keys of every row, generated or given, and leaves out sql ones', async () => {
		next = 0;
		const client = fakeClient([{ affectedRows: 3 }]);
		const query = drizzle(client)
			.insert(docs)
			.values([{ title: 'a' }, { id: 'mine' }, { id: sql`'s'` }])
			.$returningId();
		expect(query.toSQL().sql).toBe(
			'insert into "docs" ("id", "title", "at") values (?, ?, ?), (?, default, ?), (\'s\', default, ?)',
		);
		expect(await query).toEqual([{ id: 'id-2' }, { id: 'mine' }]);
	});

	it('returns no rows for a table without a reportable key', async () => {
		expect(
			await drizzle(fakeClient())
				.insert(plain)
				.values([{ a: 1 }, { a: 2 }])
				.$returningId(),
		).toEqual([]);
	});
});
