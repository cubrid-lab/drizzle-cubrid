import { eq, ilike, like, notIlike, relations, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { describe, expect, it } from 'vitest';

import { int, varchar } from '../src/columns';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';

// SQL that Drizzle's MySQL builders emit and CUBRID 11.4 always rejects with a
// generic -493 syntax error is refused before anything is sent (#189).
class RecordingClient implements CubridQueryable {
	sent: string[] = [];

	async query<T>(sql: string): Promise<T[]> {
		this.sent.push(sql);
		return [] as T[];
	}

	async queryPrepared<T>(sql: string): Promise<T[]> {
		return this.query<T>(sql);
	}

	async execute(sql: string) {
		this.sent.push(sql);
		return { affectedRows: 0, lastInsertId: undefined };
	}

	async executePrepared(sql: string) {
		return this.execute(sql);
	}
}

const users = cubridTable('users', { id: int('id').primaryKey(), name: varchar('name', { length: 40 }) });
const usersRelations = relations(users, () => ({}));
const ISSUE = 'issues/189';

function setup() {
	const client = new RecordingClient();
	const db = drizzle(client, { schema: { users, usersRelations } });
	return { client, db };
}

describe('SQL CUBRID rejects is refused before sending (#189)', () => {
	it('ilike and notIlike', async () => {
		const { client, db } = setup();
		await expect(db.select().from(users).where(ilike(users.name, 'a%'))).rejects.toThrow(
			/ILIKE \(ilike\(\) and notIlike\(\)\) is not supported on CUBRID; use like\(\)/,
		);
		await expect(db.select().from(users).where(notIlike(users.name, 'a%'))).rejects.toThrow(ISSUE);
		await expect(db.update(users).set({ name: 'x' }).where(ilike(users.name, 'a'))).rejects.toThrow(ISSUE);
		// db.execute() and prepare() build the SQL synchronously.
		expect(() => db.execute(sql`select 1 from users where name ILIKE 'a'`)).toThrow(ISSUE);
		expect(client.sent).toEqual([]);
	});

	it('does not mistake values, quoted identifiers or string literals for ILIKE', async () => {
		const { client, db } = setup();
		const odd = cubridTable('ilike', { ilike: varchar('ilike', { length: 10 }) });
		await db.select().from(users).where(like(users.name, '% ilike %'));
		await db.select().from(odd).where(eq(odd.ilike, 'x'));
		await db.execute(sql`select 'a ilike b', "x ilike y" from users`);
		await db
			.select()
			.from(users)
			.where(sql`${users.name} like ${sql.raw("'ilike'")}`);
		await db.execute(sql.raw('select 1 from users -- no ilike here'));
		await db.execute(sql.raw('select /* ilike */ 1 from users // ilike'));
		await db.execute(sql.raw("select 'C:\\', 'ilike', 'it''s ilike' from users"));
		expect(client.sent).toHaveLength(7);
		await expect(async () => db.$count(users, ilike(users.name, 'a'))).rejects.toThrow(ISSUE);
		expect(client.sent).toHaveLength(7);
	});

	it('offset without limit, in selects, set operations and db.query', async () => {
		const { client, db } = setup();
		const message = /offset\(\) without a non-negative limit\(\) is not supported on CUBRID; add a limit\(\)/;
		await expect(db.select().from(users).orderBy(users.id).offset(5)).rejects.toThrow(message);
		await expect(db.select().from(users).union(db.select().from(users)).orderBy(users.id).offset(5)).rejects.toThrow(
			message,
		);
		await expect(db.query.users.findMany({ offset: 5 })).rejects.toThrow(message);
		expect(() => db.select().from(users).offset(sql.placeholder('o')).prepare()).toThrow(message);
		expect(client.sent).toEqual([]);

		await db.select().from(users).limit(10).offset(5);
		await db.select().from(users).limit(sql.placeholder('l')).offset(5).prepare().execute({ l: 1 });
		await db.select().from(users).limit(0).offset(5);
		await db.select().from(users).offset(0);
		await expect(db.select().from(users).limit(-1).offset(5)).rejects.toThrow(message);
		await db.query.users.findMany({ limit: 10, offset: 5 });
		await db.select().from(users).union(db.select().from(users)).limit(2).offset(1);
		expect(client.sent).toHaveLength(6);
		expect(client.sent[0]).toMatch(/limit \? offset \?$/);
	});

	it('lateral joins', async () => {
		const { client, db } = setup();
		const sub = db.select({ id: users.id }).from(users).as('sub');
		await expect(db.select().from(users).leftJoinLateral(sub, sql`true`)).rejects.toThrow(
			/left join lateral is not supported on CUBRID/,
		);
		await expect(db.select().from(users).crossJoinLateral(sub)).rejects.toThrow(/cross join lateral/);
		const other = alias(users, 'other');
		await db.select().from(users).leftJoin(other, eq(users.id, other.id));
		expect(client.sent).toHaveLength(1);
	});

	it("locking other than plain for('update')", async () => {
		const { client, db } = setup();
		await expect(db.select().from(users).for('share')).rejects.toThrow(
			/for\('share'\) is not supported on CUBRID; use for\('update'\)/,
		);
		await expect(db.select().from(users).for('update', { noWait: true })).rejects.toThrow(/noWait/);
		await expect(db.select().from(users).for('update', { skipLocked: true })).rejects.toThrow(/skipLocked/);
		await db.select().from(users).for('update');
		expect(client.sent).toEqual(['select `id`, `name` from `users` for update']);
	});

	it('insert ignore', async () => {
		const { client, db } = setup();
		await expect(db.insert(users).ignore().values({ id: 1, name: 'a' })).rejects.toThrow(
			/insert\(\)\.ignore\(\) is not supported on CUBRID; CUBRID has no INSERT IGNORE/,
		);
		await db
			.insert(users)
			.values({ id: 1, name: 'a' })
			.onDuplicateKeyUpdate({ set: { name: 'b' } });
		expect(client.sent).toHaveLength(1);
	});

	it('delete with orderBy', async () => {
		const { client, db } = setup();
		await expect(db.delete(users).orderBy(users.id).limit(1)).rejects.toThrow(
			/delete\(\)\.orderBy\(\) is not supported on CUBRID/,
		);
		await db.delete(users).where(eq(users.id, 1)).limit(1);
		expect(client.sent).toEqual(['delete from `users` where `users`.`id` = ? limit ?']);
	});

	it('refuses in toSQL() too', () => {
		const { db } = setup();
		expect(() => db.select().from(users).for('share').toSQL()).toThrow(ISSUE);
		expect(() => db.select().from(users).where(ilike(users.name, 'a')).toSQL()).toThrow(ISSUE);
	});
});
