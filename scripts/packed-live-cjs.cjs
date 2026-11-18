// CommonJS live smoke test of an installed drizzle-cubrid tarball (#164).
// scripts/packed-live.mjs copies it into the consumer project and runs it
// there, after the ESM live suite. It loads both entry points with require(),
// writes and reads through each against the server in CUBRID_TEST_*, and prints
// `CUBRID server version: …` for the evidence report.
const assert = require('node:assert/strict');
const { createClient } = require('cubrid-client');
const { TransactionRollbackError } = require('drizzle-orm');
const root = require('drizzle-cubrid');
const native = require('drizzle-cubrid/native');

const config = {
	host: process.env.CUBRID_TEST_HOST ?? '127.0.0.1',
	port: Number(process.env.CUBRID_TEST_PORT ?? 33000),
	database: process.env.CUBRID_TEST_DATABASE ?? 'testdb',
	user: process.env.CUBRID_TEST_USER ?? 'dba',
	password: process.env.CUBRID_TEST_PASSWORD ?? '',
	timezone: 'utc',
};
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const big = 9007199254740993n;

async function main() {
	const client = createClient(config);
	const created = [];
	try {
		const [{ v }] = await client.query('SELECT version() AS v');
		console.log(`CUBRID server version: ${v}`);

		// drizzle-cubrid: generated key, BIGINT beyond 2^53, rollback.
		const rootName = `cjs_root_${run}`;
		await client.query(
			`CREATE TABLE ${rootName} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20) NOT NULL, big BIGINT)`,
		);
		created.push(rootName);
		const people = root.cubridTable(rootName, {
			id: root.int('id').primaryKey().autoincrement(),
			name: root.varchar('name', { length: 20 }).notNull(),
			big: root.bigint('big', { mode: 'bigint' }),
		});
		const db = root.drizzle(client);
		const [inserted] = await db.insert(people).values({ name: 'Ann', big }).$returningId();
		assert.equal(typeof inserted.id, 'number');
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.insert(people).values({ name: 'Rolled', big: 1n });
				tx.rollback();
			}),
			TransactionRollbackError,
		);
		assert.deepEqual(await db.select().from(people).orderBy(people.id), [{ id: inserted.id, name: 'Ann', big }]);

		// drizzle-cubrid/native: generated key, BIGINT and SET codecs, error propagation.
		const nativeName = `cjs_native_${run}`;
		await client.query(
			`CREATE TABLE "${nativeName}" ("id" INTEGER AUTO_INCREMENT PRIMARY KEY, "big" BIGINT, "tags" SET(VARCHAR(10)))`,
		);
		created.push(`"${nativeName}"`);
		const items = native.cubridTable(nativeName, {
			id: native.integer().primaryKey().autoIncrement(),
			big: native.bigint({ mode: 'bigint' }),
			tags: native.set({ element: native.varchar({ length: 10 }) }),
		});
		const ndb = native.drizzle(client);
		const [key] = await ndb
			.insert(items)
			.values({ big, tags: ['b', 'a'] })
			.$returningId();
		const boom = new Error('boom');
		await assert.rejects(
			ndb.transaction(async (tx) => {
				await tx.insert(items).values({ big: 2n, tags: [] });
				throw boom;
			}),
			(error) => error === boom,
		);
		const rows = await ndb.select().from(items);
		assert.equal(rows.length, 1);
		assert.deepEqual({ ...rows[0], tags: [...rows[0].tags].sort() }, { id: key.id, big, tags: ['a', 'b'] });
		console.log('CommonJS drizzle-cubrid and drizzle-cubrid/native live assertions passed');
	} finally {
		for (const table of created.reverse()) {
			await client.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
		}
		await client.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
