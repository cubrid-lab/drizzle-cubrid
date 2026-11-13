// Live CUBRID regression tests. They run against a real server through
// `npm run integration` and are excluded from `npm test`.
//
// Configure with CUBRID_TEST_HOST (required), CUBRID_TEST_PORT (33000),
// CUBRID_TEST_DATABASE (testdb), CUBRID_TEST_USER (dba) and
// CUBRID_TEST_PASSWORD (empty). Without CUBRID_TEST_HOST the run fails instead
// of skipping, so a missing database can never look like a pass.
// CUBRID_TEST_EXPECT_VERSION, when set, must prefix the server version.
import { type CubridClient, type CubridPool, createClient, createPool } from 'cubrid-client';
import { eq, gt, relations, sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	bigint,
	boolean,
	char,
	cubridMultiset,
	cubridSequence,
	cubridSet,
	datetime,
	decimal,
	double,
	int,
	mysqlEnum,
	varchar,
} from '../src/columns';
import { drizzle } from '../src/driver';
import { cubridTable } from '../src/table';

const host = process.env.CUBRID_TEST_HOST;
if (!host) {
	throw new Error('CUBRID_TEST_HOST is not set; the live CUBRID tests need a server and never skip');
}
const config = {
	host,
	port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
	database: process.env.CUBRID_TEST_DATABASE ?? 'testdb',
	user: process.env.CUBRID_TEST_USER ?? 'dba',
	password: process.env.CUBRID_TEST_PASSWORD ?? '',
};

// Table names are unique per run so parallel or leftover runs cannot collide.
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const name = (base: string) => `it_${base}_${run}`;
const created: string[] = [];

let client: CubridClient;
let pool: CubridPool;

async function createTable(table: string, columns: string): Promise<void> {
	await client.query(`CREATE TABLE ${table} (${columns})`);
	created.push(table);
}

async function ids(table: string): Promise<number[]> {
	const rows = await client.query<{ id: number }>(`SELECT id FROM ${table} ORDER BY id`);
	return rows.map((row) => row.id);
}

beforeAll(async () => {
	client = createClient(config);
	pool = createPool({ ...config, max: 4 });
	const [row] = await client.query<{ v: string }>('SELECT version() AS v');
	const version = row?.v ?? '';
	console.log(`CUBRID server version: ${version}`);
	const expected = process.env.CUBRID_TEST_EXPECT_VERSION;
	if (expected) {
		expect(version.startsWith(expected)).toBe(true);
	}
});

afterAll(async () => {
	for (const table of created.reverse()) {
		await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
	}
	await pool?.close();
	await client?.close();
});

describe('transactions run on a driver-owned connection (#185)', () => {
	const table = name('tx');
	const t = cubridTable(table, { id: int('id').primaryKey() });

	beforeAll(() => createTable(table, 'id INT PRIMARY KEY'));

	for (const [label, source] of [
		['client', () => client],
		['pool', () => pool],
	] as const) {
		it(`keeps an unrelated insert out of a rolled-back transaction (${label})`, async () => {
			await client.query(`DELETE FROM ${table}`);
			const db = drizzle(source());
			let entered!: () => void;
			let release!: () => void;
			const inside = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});

			const rolledBack = db
				.transaction(async (tx) => {
					await tx.insert(t).values({ id: 1 });
					entered();
					await gate;
					throw new Error('roll back');
				})
				.catch((error: Error) => error.message);
			await inside;
			await db.insert(t).values({ id: 2 });
			release();

			expect(await rolledBack).toBe('roll back');
			expect(await ids(table)).toEqual([2]);
		});
	}

	it('commits and rolls back concurrent transactions independently', async () => {
		await client.query(`DELETE FROM ${table}`);
		const db = drizzle(client);
		let yInserted!: () => void;
		let xCommitted!: () => void;
		const yReady = new Promise<void>((resolve) => {
			yInserted = resolve;
		});
		const xDone = new Promise<void>((resolve) => {
			xCommitted = resolve;
		});

		const y = db
			.transaction(async (tx) => {
				await tx.insert(t).values({ id: 20 });
				yInserted();
				await xDone;
				throw new Error('roll back Y');
			})
			.catch(() => undefined);
		await yReady;
		await db.transaction(async (tx) => {
			await tx.insert(t).values({ id: 10 });
		});
		xCommitted();
		await y;

		expect(await ids(table)).toEqual([10]);
	});

});

describe('transaction semantics', () => {
	const table = name('txsem');
	const t = cubridTable(table, { id: int('id').primaryKey() });

	beforeAll(() => createTable(table, 'id INT PRIMARY KEY'));

	it('rolls back to a savepoint and keeps the outer work', async () => {
		await client.query(`DELETE FROM ${table}`);
		const db = drizzle(client);

		await db.transaction(async (tx) => {
			await tx.insert(t).values({ id: 100 });
			await tx
				.transaction(async (nested) => {
					await nested.insert(t).values({ id: 101 });
					throw new Error('inner');
				})
				.catch(() => undefined);
		});

		expect(await ids(table)).toEqual([100]);
	});

	it('rethrows tx.rollback() as TransactionRollbackError with nothing committed', async () => {
		await client.query(`DELETE FROM ${table}`);
		const db = drizzle(client);

		const error = await db
			.transaction(async (tx) => {
				await tx.insert(t).values({ id: 7 });
				tx.rollback();
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(TransactionRollbackError);
		expect(await ids(table)).toEqual([]);
	});

	it('accepts a CUBRID isolation level and refuses one CUBRID lacks', async () => {
		const db = drizzle(client);

		await expect(db.transaction(async () => 'ran', { isolationLevel: 'serializable' })).resolves.toBe('ran');
		await expect(db.transaction(async () => 'ran', { isolationLevel: 'read uncommitted' })).rejects.toThrow(
			/isolation level/,
		);
	});
});

describe('joined selects keep columns whose labels repeat (#183)', () => {
	const usersName = name('users');
	const postsName = name('posts');
	const users = cubridTable(usersName, { id: int('id').primaryKey(), name: varchar('name', { length: 40 }) });
	const posts = cubridTable(postsName, {
		id: int('id').primaryKey(),
		userId: int('user_id'),
		name: varchar('name', { length: 40 }),
	});

	beforeAll(async () => {
		await createTable(usersName, 'id INT PRIMARY KEY, name VARCHAR(40)');
		await createTable(postsName, 'id INT PRIMARY KEY, user_id INT, name VARCHAR(40)');
		await client.query(`INSERT INTO ${usersName} VALUES (1, '앨리스'), (2, 'bob')`);
		await client.query(`INSERT INTO ${postsName} VALUES (10, 1, '첫 글')`);
	});

	it('maps a left join field by field', async () => {
		const db = drizzle(client);

		const rows = await db.select().from(users).leftJoin(posts, eq(posts.userId, users.id)).orderBy(users.id);

		expect(rows).toEqual([
			{ [usersName]: { id: 1, name: '앨리스' }, [postsName]: { id: 10, userId: 1, name: '첫 글' } },
			{ [usersName]: { id: 2, name: 'bob' }, [postsName]: null },
		]);
	});

	it('maps a partial select of two same-named columns', async () => {
		const db = drizzle(client);

		const rows = await db
			.select({ userName: users.name, postName: posts.name })
			.from(users)
			.innerJoin(posts, eq(posts.userId, users.id));

		expect(rows).toEqual([{ userName: '앨리스', postName: '첫 글' }]);
	});

	for (const binding of ['prepared', 'literal'] as const) {
		it(`counts rows with $count() under binding '${binding}' (#199)`, async () => {
			const db = drizzle(client, { binding });

			expect(await db.$count(users)).toBe(2);
			expect(await db.$count(users, eq(users.name, 'bob'))).toBe(1);
			expect(await db.$count(posts, gt(posts.id, 10))).toBe(0);
			expect(
				await db
					.select({ id: users.id, posts: db.$count(posts, eq(posts.userId, users.id)) })
					.from(users)
					.orderBy(users.id),
			).toEqual([
				{ id: 1, posts: 1 },
				{ id: 2, posts: 0 },
			]);
			expect(await db.transaction((tx) => tx.$count(users))).toBe(2);
		});
	}
});

describe('relational queries without relations work; with is refused (#200)', () => {
	const usersName = name('rusers');
	const postsName = name('rposts');
	const users = cubridTable(usersName, { id: int('id').primaryKey(), name: varchar('name', { length: 40 }) });
	const posts = cubridTable(postsName, { id: int('id').primaryKey(), userId: int('user_id') });
	const schema = {
		users,
		posts,
		usersRelations: relations(users, ({ many }) => ({ posts: many(posts) })),
		postsRelations: relations(posts, ({ one }) => ({
			author: one(users, { fields: [posts.userId], references: [users.id] }),
		})),
	};

	beforeAll(async () => {
		await createTable(usersName, 'id INT PRIMARY KEY, name VARCHAR(40)');
		await createTable(postsName, 'id INT PRIMARY KEY, user_id INT');
		await client.query(`INSERT INTO ${usersName} VALUES (1, '앨리스'), (2, 'bob')`);
		await client.query(`INSERT INTO ${postsName} VALUES (10, 1)`);
	});

	for (const mode of ['default', 'planetscale'] as const) {
		it(`runs findMany and findFirst and refuses with in ${mode} mode`, async () => {
			const db = drizzle(client, { schema, mode });

			expect(await db.query.users.findMany({ orderBy: users.id })).toEqual([
				{ id: 1, name: '앨리스' },
				{ id: 2, name: 'bob' },
			]);
			expect(await db.query.posts.findFirst({ where: eq(posts.id, 10) })).toEqual({ id: 10, userId: 1 });
			await expect(db.query.users.findMany({ with: { posts: true } })).rejects.toThrow(
				"Relational queries with 'with' (posts) are not supported on CUBRID",
			);
		});
	}
});

describe('writes report affected rows and generated keys (#182)', () => {
	const autoName = name('auto');
	const wideName = name('wide');
	const auto = cubridTable(autoName, {
		id: int('id').primaryKey().autoincrement(),
		v: varchar('v', { length: 10 }).unique(),
	});
	const wide = cubridTable(wideName, {
		id: bigint('id', { mode: 'bigint' }).primaryKey().autoincrement(),
		v: varchar('v', { length: 10 }),
	});

	beforeAll(async () => {
		await createTable(autoName, 'id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(10) UNIQUE');
		await createTable(wideName, 'id BIGINT AUTO_INCREMENT(9007199254740993, 1) PRIMARY KEY, v VARCHAR(10)');
	});

	it('returns the key of a one-row insert and the stored row has it', async () => {
		const db = drizzle(client);

		const [inserted] = await db.insert(auto).values({ v: 'a' }).$returningId();
		const [stored] = await db.select().from(auto).where(eq(auto.v, 'a'));

		expect(typeof inserted?.id).toBe('number');
		expect(inserted?.id).toBe(stored?.id);
	});

	it('refuses a multi-row $returningId() before inserting anything', async () => {
		const db = drizzle(client);
		const before = await ids(autoName);

		await expect(db.insert(auto).values([{ v: 'm1' }, { v: 'm2' }]).$returningId()).rejects.toThrow(/one row/);
		expect(await ids(autoName)).toEqual(before);
	});

	it('reports the real key from onDuplicateKeyUpdate(), and none when it updated a row', async () => {
		const db = drizzle(client);
		const upsert = (v: string) => db.insert(auto).values({ v }).onDuplicateKeyUpdate({ set: { v } }).$returningId();

		const [fresh] = await upsert('dup');
		const updated = await upsert('dup');
		const stored = await db.select().from(auto).where(eq(auto.v, 'dup'));

		// The conflict consumes an AUTO_INCREMENT value that belongs to no row.
		expect(stored).toHaveLength(1);
		expect(fresh?.id).toBe(stored[0]?.id);
		expect(updated).toEqual([]);
	});

	it('reports affectedRows for update and delete', async () => {
		const db = drizzle(client);
		await db.insert(auto).values([{ v: 'u1' }, { v: 'u2' }]);
		const matching = (await ids(autoName)).length;

		const updated = await db.update(auto).set({ v: sql`${auto.v}` }).where(gt(auto.id, 0));
		const deleted = await db.delete(auto).where(eq(auto.v, 'u1'));

		expect(updated.affectedRows).toBe(matching);
		expect(deleted.affectedRows).toBe(1);
	});

	it('keeps a BIGINT key beyond 2^53 exact', async () => {
		const db = drizzle(client);

		const inserted = await db.insert(wide).values({ v: 'x' });
		const keys = await db.insert(wide).values({ v: 'y' }).$returningId();

		expect(inserted.lastInsertId).toBe(9007199254740993n);
		expect(keys).toEqual([{ id: 9007199254740994n }]);
	});
});

describe('collection columns round-trip (#184)', () => {
	const table = name('coll');
	const docs = cubridTable(table, {
		id: int('id').primaryKey(),
		s: cubridSet('s', { element: varchar('e', { length: 20 }) }),
		m: cubridMultiset<number>('m', { element: int('e') }),
		q: cubridSequence('q', { element: varchar('e', { length: 20 }) }),
	});

	beforeAll(() =>
		createTable(table, 'id INT PRIMARY KEY, s SET(VARCHAR(20)), m MULTISET(INTEGER), q SEQUENCE(VARCHAR(20))'),
	);

	// SET and MULTISET define no order, so their elements are compared sorted.
	const sorted = <T>(values: T[] | null) =>
		values === null ? null : [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	it('writes, updates and reads SET, MULTISET and SEQUENCE values, empty and NULL included', async () => {
		const db = drizzle(client);

		await db.insert(docs).values({ id: 1, s: ['b', 'a', 'b'], m: [3, 1, 3], q: ["it's", 'back\\slash', '한글', null] });
		await db.insert(docs).values({ id: 2, s: [], m: [], q: [] });
		await db.insert(docs).values({ id: 3, s: null, m: null, q: null });
		await db.update(docs).set({ q: ['z', 'y'], m: [7] }).where(eq(docs.id, 2));

		const rows = await db.select().from(docs).orderBy(docs.id);
		expect(rows.map((row) => ({ ...row, s: sorted(row.s), m: sorted(row.m) }))).toEqual([
			// SET removes the duplicate 'b'; MULTISET keeps both 3s; SEQUENCE keeps order.
			{ id: 1, s: ['a', 'b'], m: [1, 3, 3], q: ["it's", 'back\\slash', '한글', null] },
			{ id: 2, s: [], m: [7], q: ['z', 'y'] },
			{ id: 3, s: null, m: null, q: null },
		]);
	});

	it('filters on a collection value', async () => {
		const db = drizzle(client);
		await db.insert(docs).values({ id: 10, q: ['f', 'g'] });

		const rows = await db.select({ id: docs.id }).from(docs).where(eq(docs.q, ['f', 'g']));

		expect(rows).toEqual([{ id: 10 }]);
	});
});

describe('typed binding and literal binding store the same values (#191)', () => {
	const table = name('bind');
	const t = cubridTable(table, {
		id: int('id').primaryKey(),
		bal: int('bal'),
		big: bigint('big', { mode: 'bigint' }),
		note: varchar('note', { length: 60 }),
	});

	beforeAll(() => createTable(table, 'id INT PRIMARY KEY, bal INT, big BIGINT, note VARCHAR(60)'));

	for (const binding of ['prepared', 'literal'] as const) {
		it(`keeps WHERE predicates and values intact with binding '${binding}'`, async () => {
			const db = drizzle(client, { binding });
			await client.query(`DELETE FROM ${table}`);
			await db.insert(t).values([
				{ id: 1, bal: 10, big: 1n, note: 'n1' },
				{ id: 2, bal: 10, big: 2n, note: 'n2' },
				{ id: 3, bal: 10, big: 3n, note: 'n3' },
			]);

			// bal - ? with a negative number, a quote/comment payload and a big integer.
			const updated = await db
				.update(t)
				.set({ bal: sql`${t.bal} - ${-1}`, note: "it's \\ -- x 한글", big: 9007199254740993n })
				.where(eq(t.id, 2));
			const unmatched = await db.update(t).set({ bal: 0 }).where(eq(t.note, "x' OR 1=1 --"));

			expect(updated.affectedRows).toBe(1);
			expect(unmatched.affectedRows).toBe(0);
			expect(await db.select().from(t).orderBy(t.id)).toEqual([
				{ id: 1, bal: 10, big: 1n, note: 'n1' },
				{ id: 2, bal: 11, big: 9007199254740993n, note: "it's \\ -- x 한글" },
				{ id: 3, bal: 10, big: 3n, note: 'n3' },
			]);
		});
	}
});

describe('collection element types round-trip under both bindings (#191, #184)', () => {
	const table = name('celem');
	const t = cubridTable(table, {
		id: int('id').primaryKey(),
		dt: cubridSequence<Date>('dt', { element: datetime('e') }),
		dbl: cubridSequence<number>('dbl', { element: double('e') }),
		flag: cubridSequence<boolean | number>('flag', { element: boolean('e') }),
		big: cubridSequence<bigint>('big', { element: bigint('e', { mode: 'bigint' }) }),
		// No element in the schema, while the table's elements are wider than the
		// VARCHAR(100) default the DDL would use.
		wide: cubridSet('wide'),
	});
	const instant = new Date(Date.UTC(2024, 1, 3, 4, 5, 6, 789));
	const long = 'x'.repeat(150);

	beforeAll(() =>
		createTable(
			table,
			'id INT PRIMARY KEY, dt SEQUENCE(DATETIME), dbl SEQUENCE(DOUBLE), flag SEQUENCE(SMALLINT), big SEQUENCE(BIGINT), wide SET(VARCHAR(500))',
		),
	);

	for (const [id, binding] of [
		[1, 'prepared'],
		[2, 'literal'],
	] as const) {
		it(`stores datetime, double, boolean, bigint and long string elements exactly (${binding})`, async () => {
			const db = drizzle(client, { binding });
			// Read back a plain DATETIME column written the same way, to compare
			// against the driver's own date handling rather than a fixed zone.
			const [plain] = await client.query<{ v: Date }>(`SELECT CAST(? AS DATETIME) AS v FROM db_root`, [instant]);

			await db.insert(t).values({ id, dt: [instant], dbl: [0.1, -2.5], flag: [true], big: [9007199254740993n], wide: [long] });
			await db.update(t).set({ dbl: [1.5] }).where(eq(t.id, id));
			const [row] = await db.select().from(t).where(eq(t.id, id));

			expect(row?.dt?.[0]?.getTime()).toBe(plain?.v.getTime());
			expect(row?.dbl).toEqual([1.5]);
			expect(row?.flag).toEqual([1]);
			expect(row?.big).toEqual([9007199254740993n]);
			expect(row?.wide).toEqual([long]);
		});
	}
});

enum Shade {
	Light = 'light',
	Dark = 'dark',
}

describe('CHAR, decimal and enum elements under both bindings (#191)', () => {
	const table = name('cchar');
	const t = cubridTable(table, {
		id: int('id').primaryKey(),
		ch: cubridSet('ch', { element: char('e', { length: 3 }) }),
		dn: cubridSequence<number>('dn', { element: decimal('e', { precision: 8, scale: 1, mode: 'number' }) }),
		db: cubridSequence<string>('db', { element: decimal('e', { precision: 20, mode: 'bigint' }) }),
		en: cubridSet('en', { element: mysqlEnum('e', Shade) }),
	});

	beforeAll(() =>
		createTable(
			table,
			'id INT PRIMARY KEY, ch SET(CHAR(3)), dn SEQUENCE(DECIMAL(8,1)), db SEQUENCE(DECIMAL(20)), en SET(VARCHAR(10))',
		),
	);

	for (const [id, binding] of [
		[1, 'prepared'],
		[2, 'literal'],
	] as const) {
		it(`writes, updates and filters these elements (${binding})`, async () => {
			const db = drizzle(client, { binding });
			const chars = binding === 'prepared' ? ['ab'] : ['cd'];

			await db.insert(t).values({ id, ch: chars, dn: [1.5], db: ['12345678901234567890'], en: [Shade.Dark] });
			await db.update(t).set({ dn: [2.5], db: ['1'], en: [Shade.Light] }).where(eq(t.id, id));
			const matched = await db.select({ id: t.id }).from(t).where(eq(t.ch, chars));
			const [row] = await db.select().from(t).where(eq(t.id, id));

			expect(matched).toEqual([{ id }]);
			expect(row?.dn).toEqual(['2.5']);
			expect(row?.db).toEqual(['1']);
			expect(row?.en).toEqual([Shade.Light]);
		});
	}
});
