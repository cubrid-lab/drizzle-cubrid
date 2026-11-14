// Live CUBRID regression tests. They run against a real server through
// `npm run integration` and are excluded from `npm test`.
//
// Configure with CUBRID_TEST_HOST (required), CUBRID_TEST_PORT (33000),
// CUBRID_TEST_DATABASE (testdb), CUBRID_TEST_USER (dba) and
// CUBRID_TEST_PASSWORD (empty). Without CUBRID_TEST_HOST the run fails instead
// of skipping, so a missing database can never look like a pass.
// CUBRID_TEST_EXPECT_VERSION, when set, must prefix the server version.
import { type CubridClient, type CubridPool, createClient, createPool } from 'cubrid-client';
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	like,
	lt,
	relations,
	sql,
	sum,
	TransactionRollbackError,
} from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	bigint,
	boolean,
	char,
	cubridMultiset,
	cubridSequence,
	cubridSet,
	date,
	datetime,
	decimal,
	double,
	int,
	mysqlEnum,
	time,
	timestamp,
	varchar,
} from '../src/columns';
import { drizzle } from '../src/driver';
import { createTableSql } from '../src/native/ddl';
import * as native from '../src/native/index';
import { cubridTable } from '../src/table';
import { monetary } from '../src/types';

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
	// drizzle-cubrid reads date and time columns only from a client that decodes
	// them in UTC (#207); the CI job runs with a non-UTC TZ.
	client = createClient({ ...config, timezone: 'utc' });
	pool = createPool({ ...config, timezone: 'utc', max: 4 });
	const [row] = await client.query<{ v: string }>('SELECT version() AS v');
	const version = row?.v ?? '';
	console.log(`CUBRID server version: ${version}`);
	const expected = process.env.CUBRID_TEST_EXPECT_VERSION;
	if (expected && !version.startsWith(expected)) {
		throw new Error(`CUBRID server version ${version} does not start with CUBRID_TEST_EXPECT_VERSION=${expected}`);
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

		await expect(
			db
				.insert(auto)
				.values([{ v: 'm1' }, { v: 'm2' }])
				.$returningId(),
		).rejects.toThrow(/one row/);
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

		const updated = await db
			.update(auto)
			.set({ v: sql`${auto.v}` })
			.where(gt(auto.id, 0));
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
		await db
			.update(docs)
			.set({ q: ['z', 'y'], m: [7] })
			.where(eq(docs.id, 2));

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

		const rows = await db
			.select({ id: docs.id })
			.from(docs)
			.where(eq(docs.q, ['f', 'g']));

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

			await db
				.insert(t)
				.values({ id, dt: [instant], dbl: [0.1, -2.5], flag: [true], big: [9007199254740993n], wide: [long] });
			await db
				.update(t)
				.set({ dbl: [1.5] })
				.where(eq(t.id, id));
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
			await db
				.update(t)
				.set({ dn: [2.5], db: ['1'], en: [Shade.Light] })
				.where(eq(t.id, id));
			const matched = await db.select({ id: t.id }).from(t).where(eq(t.ch, chars));
			const [row] = await db.select().from(t).where(eq(t.id, id));

			expect(matched).toEqual([{ id }]);
			expect(row?.dn).toEqual(['2.5']);
			expect(row?.db).toEqual(['1']);
			expect(row?.en).toEqual([Shade.Light]);
		});
	}
});

describe('DATETIME, TIMESTAMP, DATE and TIME columns round-trip (#207)', () => {
	const table = name('temporal');
	const t = cubridTable(table, {
		id: int('id').primaryKey(),
		at: datetime('c_dt'),
		atText: datetime('c_dt_text', { mode: 'string' }),
		stamp: timestamp('c_ts'),
		stampText: timestamp('c_ts_text', { mode: 'string' }),
		day: date('c_d'),
		dayText: date('c_d_text', { mode: 'string' }),
		clock: time('c_tm'),
		ats: cubridSequence<Date>('c_dts', { element: datetime('e') }),
	});
	const columns =
		'id INT PRIMARY KEY, c_dt DATETIME, c_dt_text DATETIME, c_ts TIMESTAMP, c_ts_text TIMESTAMP, c_d DATE, c_d_text DATE, c_tm TIME, c_dts SEQUENCE(DATETIME)';

	// Milliseconds; a date just before UTC midnight, which a local-zone read
	// would move to another day east or west of UTC; and the ends of the
	// DATETIME and DATE range. TIMESTAMP holds 1970-2038 in whole seconds.
	const cases = [
		{
			at: new Date('2024-01-02T03:04:05.678Z'),
			atText: '2024-01-02 03:04:05.678',
			stamp: new Date('2024-01-02T03:04:05.000Z'),
			stampText: '2024-01-02 03:04:05',
			day: new Date('2024-02-03T00:00:00.000Z'),
			dayText: '2024-02-03',
			clock: '23:59:58',
		},
		{
			at: new Date('2024-12-31T23:59:59.999Z'),
			atText: '2024-12-31 23:59:59.999',
			stamp: new Date('2038-01-19T03:14:07.000Z'),
			stampText: '1970-01-02 00:00:00',
			day: new Date('0001-01-01T00:00:00.000Z'),
			dayText: '9999-12-31',
			clock: '00:00:00',
		},
		{
			at: new Date('0001-01-01T00:00:00.000Z'),
			atText: '9999-12-31 23:59:59.999',
			stamp: new Date('1970-01-01T00:00:01.000Z'),
			stampText: '2024-06-30 23:59:59',
			day: new Date('9999-12-31T00:00:00.000Z'),
			dayText: '0001-01-01',
			clock: '12:34:56',
		},
	];
	const nulls = {
		at: null,
		atText: null,
		stamp: null,
		stampText: null,
		day: null,
		dayText: null,
		clock: null,
		ats: null,
	};

	beforeAll(() => createTable(table, columns));

	for (const [base, binding] of [
		[10, 'prepared'],
		[20, 'literal'],
	] as const) {
		for (const [source, label] of [
			[() => client, 'client'],
			[() => pool, 'pool transaction'],
		] as const) {
			it(`writes, updates, filters and reads every mode exactly (${binding}, ${label})`, async () => {
				const offset = label === 'client' ? 0 : 5;
				const run = async (db: ReturnType<typeof drizzle>) => {
					for (const [i, values] of cases.entries()) {
						const id = base + offset + i;
						await db.insert(t).values({ id, ...values, ats: [values.at] });
						const [row] = await db.select().from(t).where(eq(t.id, id));
						expect(row).toEqual({ id, ...values, ats: [values.at] });
						const matched = await db
							.select({ id: t.id })
							.from(t)
							.where(
								and(
									// Only this test's rows; the other tests store the same values.
									gte(t.id, base + offset),
									lt(t.id, base + offset + 5),
									eq(t.at, values.at),
									eq(t.day, values.day),
									eq(t.stamp, values.stamp),
									eq(t.clock, values.clock),
								),
							);
						expect(matched).toEqual([{ id }]);
					}
					const id = base + offset;
					const next = cases[1]!;
					await db
						.update(t)
						.set({ ...next, ats: [next.at, next.at] })
						.where(eq(t.id, id));
					const [updated] = await db.select().from(t).where(eq(t.id, id));
					expect(updated).toEqual({ id, ...next, ats: [next.at, next.at] });
					await db.update(t).set(nulls).where(eq(t.id, id));
					const [cleared] = await db.select().from(t).where(eq(t.id, id));
					expect(cleared).toEqual({ id, ...nulls });
				};
				if (label === 'client') {
					await run(drizzle(source(), { binding }));
				} else {
					await drizzle(source(), { binding }).transaction(async (tx) => run(tx as never));
				}
			});
		}
	}

	it('compares a TIMESTAMP with a Date that has milliseconds; CUBRID stores whole seconds', async () => {
		const db = drizzle(client);
		await db.insert(t).values({ id: 90, stamp: new Date('2024-01-02T03:04:05.678Z') });

		const [row] = await db.select({ stamp: t.stamp }).from(t).where(eq(t.id, 90));
		expect(row?.stamp).toEqual(new Date('2024-01-02T03:04:05.000Z'));
		const later = await db
			.select({ id: t.id })
			.from(t)
			.where(and(eq(t.id, 90), gt(t.stamp, new Date('2024-01-02T03:04:04.999Z'))));
		expect(later).toEqual([{ id: 90 }]);
	});

	it('refuses a local-zone client unless the process zone is UTC', async () => {
		const local = createClient(config);
		try {
			const db = drizzle(local);
			const read = db.select().from(t);
			const offsets = [new Date(2024, 0, 1), new Date(2024, 6, 1)].map((d) => d.getTimezoneOffset());
			if (offsets.every((offset) => offset === 0)) {
				await expect(read).resolves.toBeDefined();
			} else {
				await expect(read).rejects.toThrow(/timezone: 'utc'/);
				await expect(db.transaction(async (tx) => tx.select({ at: t.at }).from(t))).rejects.toThrow(/TZ=UTC/);
			}
			// Statements that read no date column are unaffected.
			await expect(db.select({ id: t.id }).from(t)).resolves.toBeDefined();
		} finally {
			await local.close();
		}
	});
});

describe('the forms suggested in place of refused SQL run on CUBRID (#189)', () => {
	const table = name('alt');
	const t = cubridTable(table, { id: int('id').primaryKey(), v: varchar('v', { length: 20 }) });

	beforeAll(async () => {
		await createTable(table, 'id INT PRIMARY KEY, v VARCHAR(20)');
		await client.query(`INSERT INTO ${table} VALUES (1, 'a'), (2, 'B'), (3, 'c'), (4, 'D')`);
	});

	for (const binding of ['prepared', 'literal'] as const) {
		it(`limit() with offset(), for('update'), delete limit() and like() on lower() (${binding})`, async () => {
			const db = drizzle(client, { binding });

			await expect(db.select({ id: t.id }).from(t).orderBy(t.id).limit(2).offset(1)).resolves.toEqual([
				{ id: 2 },
				{ id: 3 },
			]);
			await expect(
				db
					.select({ id: t.id })
					.from(t)
					.where(like(sql`lower(${t.v})`, 'b')),
			).resolves.toEqual([{ id: 2 }]);
			await expect(
				drizzle(pool, { binding }).transaction((tx) =>
					tx.select({ id: t.id }).from(t).where(eq(t.id, 1)).for('update'),
				),
			).resolves.toEqual([{ id: 1 }]);
		});
	}

	it('deletes with limit() and no orderBy()', async () => {
		const db = drizzle(client);
		const result = await db.delete(t).where(gte(t.id, 3)).limit(1);
		expect(result.affectedRows).toBe(1);
		expect((await ids(table)).length).toBe(3);
	});
});

describe('MONETARY columns read back as the declared string (#217)', () => {
	const table = name('money');
	const t = cubridTable(table, { id: int('id').primaryKey(), price: monetary('price') });

	beforeAll(() => createTable(table, 'id INT PRIMARY KEY, price MONETARY'));

	for (const [id, binding] of [
		[1, 'prepared'],
		[2, 'literal'],
	] as const) {
		it(`writes '12.34' and reads '12.34' (${binding})`, async () => {
			const db = drizzle(client, { binding });
			await db.insert(t).values({ id, price: '12.34' });
			await expect(db.select({ price: t.price }).from(t).where(eq(t.id, id))).resolves.toEqual([{ price: '12.34' }]);
			const [raw] = await client.query<{ price: number }>(`SELECT price FROM ${table} WHERE id = ${id}`);
			expect(raw?.price).toBe(12.34);
		});
	}
});

describe('drizzle-cubrid/native column types round-trip through their codecs (#157, #162)', () => {
	// No native query builder exists yet (#158), so the statements are written
	// here: each value is encoded with its column's mapToDriverValue, bound with
	// `?`, read back with rowMode 'array' and decoded with mapFromDriverValue.
	const table = name('native');
	const t = native.cubridTable(table, {
		id: native.integer().primaryKey().autoIncrement(),
		small: native.smallint(),
		whole: native.int('whole_col'),
		big: native.bigint({ mode: 'bigint' }),
		bigNum: native.bigint({ mode: 'number' }),
		exact: native.numeric({ precision: 38, scale: 10 }),
		exactNum: native.decimal({ precision: 10, scale: 2, mode: 'number' }),
		single: native.float(),
		dbl: native.double(),
		code: native.char({ length: 5 }),
		name: native.varchar({ length: 50 }),
		note: native.string(),
		active: native.boolean(),
		at: native.datetime(),
		atText: native.datetime({ mode: 'string' }),
		stamp: native.timestamp(),
		stampText: native.timestamp({ mode: 'string' }),
		day: native.date(),
		dayText: native.date({ mode: 'string' }),
		clock: native.time(),
		price: native.monetary(),
		tags: native.set({ element: native.varchar({ length: 20 }) }),
		counts: native.multiset({ element: native.bigint({ mode: 'bigint' }) }),
		flags: native.sequence({ element: native.boolean() }),
		times: native.sequence({ element: native.datetime() }),
		amounts: native.set({ element: native.numeric({ precision: 10, scale: 2 }) }),
	});
	type Row = Omit<typeof t.$inferSelect, 'id'>;
	const columns = native.getTableConfig(t).columns.filter((c) => c !== t.id);
	const keyOf = new Map(
		Object.entries(t)
			.filter(([, v]) => v instanceof native.CubridColumn)
			.map(([k, v]) => [v, k]),
	);

	const full: Row = {
		small: -32768,
		whole: 2147483647,
		big: 9223372036854775807n,
		bigNum: Number.MAX_SAFE_INTEGER,
		exact: '1234567890123456789012345678.0123456789',
		exactNum: 12.5,
		single: Math.fround(1.1),
		dbl: 1.1,
		code: 'ab   ',
		name: '한국어 텍스트',
		note: "it's a \\ backslash",
		active: true,
		at: new Date(Date.UTC(2024, 1, 29, 23, 59, 58, 123)),
		atText: '2024-02-29 23:59:58.123',
		stamp: new Date(Date.UTC(2038, 0, 19, 3, 14, 7)),
		stampText: '1970-01-01 00:00:01',
		day: new Date(Date.UTC(2000, 0, 1)),
		dayText: '9999-12-31',
		clock: '23:59:59',
		price: '12.34',
		tags: ['b', '가', null],
		counts: [-9223372036854775808n, 5n, 5n, null],
		flags: [true, false, null, true],
		times: [new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6)), null],
		amounts: ['12.50', '-0.01'],
	};
	// DATE 0001-01-01, CUBRID's first date (Date.UTC maps years 0-99 to 1900-1999).
	full.day?.setUTCFullYear(1);
	const empty = Object.fromEntries(columns.map((c) => [keyOf.get(c), null])) as Row;

	function insertStatement(row: Row): { sql: string; params: unknown[] } {
		const params: unknown[] = [];
		const values = columns.map((column) => {
			const value = row[keyOf.get(column) as keyof Row];
			if (value === null) {
				params.push(null);
				return '?';
			}
			const encoded = column.mapToDriverValue(value);
			if (column instanceof native.CubridCollection) {
				const elements = encoded as unknown[];
				params.push(...elements);
				return native.collectionLiteralSql(column, elements.length);
			}
			params.push(encoded);
			return '?';
		});
		const names = columns.map((c) => `"${c.name}"`).join(', ');
		return { sql: `INSERT INTO "${table}" (${names}) VALUES (${values.join(', ')})`, params };
	}

	async function readRows(): Promise<Row[]> {
		const names = columns.map((c) => `"${c.name}"`).join(', ');
		const rows = await client.query<unknown[]>(`SELECT ${names} FROM "${table}" ORDER BY "id"`, [], {
			rowMode: 'array',
		});
		return rows.map(
			(raw) =>
				Object.fromEntries(
					columns.map((column, i) => [keyOf.get(column), raw[i] === null ? null : column.mapFromDriverValue(raw[i])]),
				) as Row,
		);
	}

	const sorted = (values: unknown[] | null) => values && [...values].sort((a, b) => String(a).localeCompare(String(b)));

	beforeAll(async () => {
		await client.query(createTableSql(t));
		created.push(`"${table}"`);
	});

	it('creates the table from the declared CUBRID types', async () => {
		const described = await client.getColumns(table);
		// CUBRID stores identifiers in lower case, quoted or not.
		expect(described.map((c) => c.name)).toEqual(['id', ...columns.map((c) => c.name.toLowerCase())]);
	});

	it('writes and reads every builder exactly, including NULLs, in a non-UTC process', async () => {
		expect(new Date(2024, 0, 1).getTimezoneOffset()).not.toBe(0);
		for (const row of [full, empty]) {
			const { sql: text, params } = insertStatement(row);
			await client.executePrepared(text, params as never[]);
		}
		const [first, second] = await readRows();
		expect(second).toEqual(empty);
		// SET and MULTISET have no defined order; SEQUENCE keeps it.
		expect({
			...first,
			tags: sorted(first?.tags ?? null),
			counts: sorted(first?.counts ?? null),
			amounts: sorted(first?.amounts ?? null),
		}).toEqual({
			...full,
			tags: sorted(full.tags),
			counts: sorted(full.counts),
			amounts: sorted(full.amounts),
		});
		expect(first?.big).toBe(9223372036854775807n);
		expect(first?.code).toBe('ab   ');
	});

	it('generates the AUTO_INCREMENT key', async () => {
		const rows = await client.query<{ id: number }>(`SELECT "id" FROM "${table}" ORDER BY "id"`);
		expect(rows.map((r) => r.id)).toEqual([1, 2]);
	});

	it('refuses values the codecs cannot represent exactly', async () => {
		const [raw] = await client.query<unknown[]>(
			'SELECT CAST(9007199254740993 AS BIGINT), CAST(2 AS SMALLINT) FROM db_root',
			[],
			{ rowMode: 'array' },
		);
		expect(raw?.[0]).toBe(9007199254740993n);
		expect(t.big.mapFromDriverValue(raw?.[0])).toBe(9007199254740993n);
		expect(() => t.bigNum.mapFromDriverValue(raw?.[0])).toThrow(RangeError);
		expect(() => t.active.mapFromDriverValue(raw?.[1])).toThrow(/0 or 1/);
	});

	it('writes NUMERIC numbers below 1e-6 and from 1e21 as plain decimals that round-trip', async () => {
		const numbers = name('native_num');
		const n = native.cubridTable(numbers, {
			id: native.integer().primaryKey(),
			exact: native.numeric({ precision: 38, scale: 10 }),
			approx: native.numeric({ precision: 38, scale: 10, mode: 'number' }),
		});
		await client.query(createTableSql(n));
		created.push(`"${numbers}"`);
		const insert = `INSERT INTO "${numbers}" ("id", "exact", "approx") VALUES (?, ?, ?)`;
		await client.executePrepared(insert, [
			1,
			n.exact.mapToDriverValue(1e-7),
			n.approx.mapToDriverValue(1e21),
		] as never[]);
		await client.executePrepared(insert, [
			2,
			n.exact.mapToDriverValue(1e21),
			n.approx.mapToDriverValue(1e-7),
		] as never[]);
		const rows = await client.query<unknown[]>(`SELECT "exact", "approx" FROM "${numbers}" ORDER BY "id"`, [], {
			rowMode: 'array',
		});
		expect(
			rows.map(([exact, approx]) => [n.exact.mapFromDriverValue(exact), n.approx.mapFromDriverValue(approx)]),
		).toEqual([
			['0.0000001000', 1e21],
			['1000000000000000000000.0000000000', 1e-7],
		]);
	});

	it('refuses a fractional INTEGER and out-of-range dates before anything is sent', async () => {
		const before = await client.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
		const year10000 = new Date(Date.UTC(2000, 0, 1));
		year10000.setUTCFullYear(10000);
		for (const bad of [
			{ ...full, whole: 1.5 },
			{ ...full, flags: null, small: 40000 },
			{ ...full, at: year10000 },
			{ ...full, stamp: new Date(Date.UTC(2038, 0, 19, 3, 14, 8)) },
		]) {
			expect(() => insertStatement(bad as Row)).toThrow(/INTEGER|SMALLINT|DATETIME|TIMESTAMP/);
		}
		expect(await client.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)).toEqual(before);
		// The server itself would have rounded the fraction.
		const [rounded] = await client.queryPrepared<unknown[]>('SELECT CAST(? AS INTEGER) FROM db_root', [1.5], {
			rowMode: 'array',
		});
		expect(rounded).toEqual([2]);
	});

	it('accepts the TIMESTAMP range limits the codec allows', async () => {
		const [row] = await client.queryPrepared<unknown[]>(
			'SELECT CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP) FROM db_root',
			[
				t.stamp.mapToDriverValue(new Date(Date.UTC(1970, 0, 1, 0, 0, 1))),
				t.stamp.mapToDriverValue(new Date(Date.UTC(2038, 0, 19, 3, 14, 7))),
			],
			{ rowMode: 'array' },
		);
		expect(row?.map((v) => t.stamp.mapFromDriverValue(v))).toEqual([
			new Date(Date.UTC(1970, 0, 1, 0, 0, 1)),
			new Date(Date.UTC(2038, 0, 19, 3, 14, 7)),
		]);
		await expect(
			client.queryPrepared('SELECT CAST(? AS TIMESTAMP) FROM db_root', ['2038-01-19 03:14:08']),
		).rejects.toThrow();
	});

	it('accepts composite primary keys and unique constraints', async () => {
		const pairs = name('native_pk');
		const p = native.cubridTable(
			pairs,
			{ a: native.integer().notNull(), b: native.varchar({ length: 5 }).notNull(), c: native.integer().unique() },
			(self) => [native.primaryKey({ columns: [self.a, self.b] }), native.unique().on(self.b, self.c)],
		);
		await client.query(createTableSql(p));
		created.push(`"${pairs}"`);
		await client.executePrepared(`INSERT INTO "${pairs}" ("a", "b", "c") VALUES (?, ?, ?)`, [1, 'x', 1]);
		await expect(
			client.executePrepared(`INSERT INTO "${pairs}" ("a", "b", "c") VALUES (?, ?, ?)`, [1, 'x', 2]),
		).rejects.toThrow();
		expect(await client.getPrimaryKey(pairs)).toMatchObject({ columns: ['a', 'b'] });
	});
});

describe('drizzle-cubrid/native select and session (#158, #160)', () => {
	const big = 9007199254740993n; // 2^53 + 1
	const authors = native.cubridTable(name('nauthors'), {
		id: native.bigint({ mode: 'bigint' }).primaryKey(),
		name: native.varchar({ length: 30 }).notNull(),
		joined: native.datetime(),
	});
	const books = native.cubridTable(name('nbooks'), {
		id: native.integer().primaryKey(),
		authorId: native.bigint('author_id', { mode: 'bigint' }),
		name: native.varchar({ length: 30 }).notNull(),
		price: native.numeric({ precision: 38, scale: 10 }),
		day: native.date({ mode: 'string' }),
	});
	const weird = native.cubridTable(name('we"ird'), { 'co"l': native.integer().primaryKey() });
	const joined = new Date(Date.UTC(2024, 1, 29, 23, 59, 58, 123));

	let db: ReturnType<typeof native.drizzle<CubridClient>>;

	beforeAll(async () => {
		for (const table of [authors, books, weird]) {
			await client.query(createTableSql(table));
			created.push(`"${native.getTableConfig(table).name.replaceAll('"', '""')}"`);
		}
		const a = native.getTableConfig(authors).name;
		const b = native.getTableConfig(books).name;
		await client.executePrepared(`INSERT INTO "${a}" ("id", "name", "joined") VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`, [
			1n,
			'Ann',
			'2024-02-29 23:59:58.123',
			big,
			'Bob',
			null,
			3n,
			'Cy',
			null,
		]);
		await client.executePrepared(
			`INSERT INTO "${b}" ("id", "author_id", "name", "price", "day") VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
			[
				10,
				1n,
				'A1',
				'1234567890123456789012345678.0123456789',
				'2024-01-02',
				11,
				1n,
				'A2',
				'0.5',
				null,
				12,
				big,
				'B1',
				'2.25',
				'9999-12-31',
				13,
				null,
				'Orphan',
				null,
				null,
			],
		);
		await client.executePrepared(
			`INSERT INTO "${native.getTableConfig(weird).name.replaceAll('"', '""')}" ("co""l") VALUES (?)`,
			[7],
		);
		db = native.drizzle(client);
	});

	it('maps joins whose tables share column names by position, with NULLs for unmatched left joins', async () => {
		const rows = await db
			.select()
			.from(authors)
			.leftJoin(books, eq(authors.id, books.authorId))
			.orderBy(asc(authors.id), asc(books.id));
		expect(rows).toEqual([
			{
				[native.getTableConfig(authors).name]: { id: 1n, name: 'Ann', joined },
				[native.getTableConfig(books).name]: {
					id: 10,
					authorId: 1n,
					name: 'A1',
					price: '1234567890123456789012345678.0123456789',
					day: '2024-01-02',
				},
			},
			{
				[native.getTableConfig(authors).name]: { id: 1n, name: 'Ann', joined },
				[native.getTableConfig(books).name]: { id: 11, authorId: 1n, name: 'A2', price: '0.5000000000', day: null },
			},
			{
				[native.getTableConfig(authors).name]: { id: 3n, name: 'Cy', joined: null },
				[native.getTableConfig(books).name]: null,
			},
			{
				[native.getTableConfig(authors).name]: { id: big, name: 'Bob', joined: null },
				[native.getTableConfig(books).name]: {
					id: 12,
					authorId: big,
					name: 'B1',
					price: '2.2500000000',
					day: '9999-12-31',
				},
			},
		]);
	});

	it('runs inner, right and cross joins, partial and nested selections', async () => {
		const inner = await db
			.select({ a: authors.name, b: books.name })
			.from(authors)
			.innerJoin(books, eq(authors.id, books.authorId))
			.where(eq(authors.id, big));
		expect(inner).toEqual([{ a: 'Bob', b: 'B1' }]);
		const right = await db
			.select({ author: { id: authors.id, name: authors.name }, book: books.name })
			.from(authors)
			.rightJoin(books, eq(authors.id, books.authorId))
			.orderBy(books.id);
		expect(right.map((r) => [r.author?.name ?? null, r.book])).toEqual([
			['Ann', 'A1'],
			['Ann', 'A2'],
			['Bob', 'B1'],
			[null, 'Orphan'],
		]);
		expect(right[3]?.author).toBeNull();
		const cross = await db.select({ n: count() }).from(authors).crossJoin(books);
		expect(cross).toEqual([{ n: 12 }]);
	});

	it('groups, filters groups, counts, orders, limits and offsets', async () => {
		const rows = await db
			.select({ authorId: books.authorId, n: count(), total: sum(books.price) })
			.from(books)
			.where(gt(books.id, 0))
			.groupBy(books.authorId)
			.having(({ n }) => gt(n, 1))
			.orderBy(desc(books.authorId));
		expect(rows).toEqual([{ authorId: 1n, n: 2, total: '1234567890123456789012345678.5123456789' }]);
		const page = await db.select({ id: books.id }).from(books).orderBy(books.id).limit(2).offset(1);
		expect(page).toEqual([{ id: 11 }, { id: 12 }]);
		const distinct = await db
			.selectDistinct({ a: books.authorId })
			.from(books)
			.where(gt(books.id, 10))
			.orderBy(books.authorId);
		expect(distinct.map((r) => r.a)).toEqual([null, 1n, big]);
	});

	it('selects from and joins a subquery', async () => {
		const counts = db
			.select({ authorId: books.authorId, n: sql<number>`count(*)`.mapWith(Number).as('n') })
			.from(books)
			.groupBy(books.authorId)
			.as('counts');
		expect(await db.select().from(counts).where(gt(counts.n, 1))).toEqual([{ authorId: 1n, n: 2 }]);
		const rows = await db
			.select({ name: authors.name, n: counts.n })
			.from(authors)
			.leftJoin(counts, eq(authors.id, counts.authorId))
			.orderBy(authors.id);
		expect(rows).toEqual([
			{ name: 'Ann', n: 2 },
			{ name: 'Cy', n: null },
			{ name: 'Bob', n: 1 },
		]);
	});

	it('runs prepared queries with placeholders, and literal binding', async () => {
		const byId = db
			.select({ name: authors.name })
			.from(authors)
			.where(eq(authors.id, sql.placeholder('id')))
			.limit(sql.placeholder('n'))
			.prepare();
		expect(await byId.execute({ id: big, n: 1 })).toEqual([{ name: 'Bob' }]);
		expect(await byId.execute({ id: 1n, n: 1 })).toEqual([{ name: 'Ann' }]);
		const literal = native.drizzle(client, { binding: 'literal' });
		expect(await literal.select({ id: authors.id }).from(authors).where(eq(authors.name, 'Bob'))).toEqual([
			{ id: big },
		]);
		expect(await literal.execute(sql`select ${"it's"} as v from db_root`)).toEqual([{ v: "it's" }]);
		expect(await literal.select({ n: books.name }).from(books).where(eq(books.price, '0.5'))).toEqual([{ n: 'A2' }]);
	});

	it('reads date and time columns from a UTC client and refuses a local-zone one', async () => {
		expect(await db.select({ joined: authors.joined }).from(authors).where(eq(authors.id, 1n))).toEqual([{ joined }]);
		expect(await db.select({ joined: authors.joined }).from(authors).where(eq(authors.joined, joined))).toEqual([
			{ joined },
		]);
		const local = createClient(config);
		try {
			const localDb = native.drizzle(local);
			await expect(localDb.select({ joined: authors.joined }).from(authors)).rejects.toThrow(/UTC wall clock/);
			await expect(localDb.select({ day: books.day }).from(books)).rejects.toThrow(/UTC wall clock/);
			expect(await localDb.select({ id: authors.id }).from(authors).where(eq(authors.id, 3n))).toEqual([{ id: 3n }]);
		} finally {
			await local.close();
		}
	});

	it('locks rows with for update inside a cubrid-client transaction', async () => {
		const name = await client.transaction(async (tx) => {
			const txDb = native.drizzle(tx);
			const rows = await txDb
				.select({ id: authors.id, name: authors.name })
				.from(authors)
				.where(eq(authors.id, big))
				.for('update');
			return rows[0]?.name;
		});
		expect(name).toBe('Bob');
		expect(() => db.select({ n: count() }).from(books).groupBy(books.authorId).for('update').toSQL()).toThrow(/-494/);
		await expect(
			client.queryPrepared(
				`SELECT COUNT(*) FROM "${native.getTableConfig(books).name}" GROUP BY "author_id" FOR UPDATE`,
			),
		).rejects.toThrow();
	});

	it('nulls unmatched left-joined subqueries and objects mixing columns with sql (review items 1, 2)', async () => {
		const sq2 = db
			.select({ uid: authors.id, label: sql<string>`upper(${authors.name})`.as('name') })
			.from(authors)
			.as('sq2');
		const rows = await db
			.select()
			.from(authors)
			.leftJoin(sq2, eq(authors.id, sql`${sq2.uid} + 100`))
			.where(eq(authors.id, 1n));
		expect(rows).toEqual([{ [native.getTableConfig(authors).name]: { id: 1n, name: 'Ann', joined }, sq2: null }]);
		const mixed = await db
			.select({ a: authors.name, book: { name: books.name, one: sql<number>`1`.mapWith(Number) } })
			.from(authors)
			.leftJoin(books, eq(authors.id, books.authorId))
			.where(eq(authors.id, 3n));
		expect(mixed).toEqual([{ a: 'Cy', book: null }]);
	});

	it('qualifies subquery sql fields in conditions next to a same-named column (review item 3)', async () => {
		const sq2 = db
			.select({ uid: authors.id, label: sql<string>`upper(${authors.name})`.as('name') })
			.from(authors)
			.as('sq2');
		const rows = await db
			.select({ b: books.name, l: sq2.label })
			.from(books)
			.innerJoin(sq2, eq(books.authorId, sq2.uid))
			.where(eq(sq2.label, 'ANN'))
			.orderBy(books.id, sq2.label);
		expect(rows).toEqual([
			{ b: 'A1', l: 'ANN' },
			{ b: 'A2', l: 'ANN' },
		]);
	});

	it('selects from a subquery over a join whose tables share column names (review item 4)', async () => {
		const s3 = db.select().from(authors).innerJoin(books, eq(authors.id, books.authorId)).as('s3');
		const rows = await db
			.select()
			.from(s3)
			.where(eq(s3[native.getTableConfig(books).name as 'x'].id, 12));
		expect(rows).toEqual([
			{
				[native.getTableConfig(authors).name]: { id: big, name: 'Bob', joined: null },
				[native.getTableConfig(books).name]: {
					id: 12,
					authorId: big,
					name: 'B1',
					price: '2.2500000000',
					day: '9999-12-31',
				},
			},
		]);
		const s2 = db
			.select({ a: authors.id, b: books.id, an: authors.name, bn: books.name })
			.from(authors)
			.innerJoin(books, eq(authors.id, books.authorId))
			.as('s2');
		expect(await db.select().from(s2).orderBy(s2.b)).toEqual([
			{ a: 1n, b: 10, an: 'Ann', bn: 'A1' },
			{ a: 1n, b: 11, an: 'Ann', bn: 'A2' },
			{ a: big, b: 12, an: 'Bob', bn: 'B1' },
		]);
	});

	it('quotes identifiers with embedded double quotes', async () => {
		expect(await db.select().from(weird)).toEqual([{ 'co"l': 7 }]);
	});

	it('runs raw statements with db.execute()', async () => {
		const rows = await db.execute<{ n: number }>(sql`select count(*) as n from ${authors} where ${authors.id} > ${1n}`);
		expect(rows).toEqual([{ n: 2n }]);
	});

	it('passes driver errors through with their code', async () => {
		const error = await db.execute(sql`select * from ${sql.identifier(name('missing'))}`).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(typeof (error as { code?: unknown }).code).toBe('number');
	});
});
