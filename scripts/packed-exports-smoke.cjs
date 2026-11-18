// Offline smoke test of an installed drizzle-cubrid tarball's CommonJS and ESM
// exports, run on Node 18 by CI and the release gate. Copy it into the
// consumer project first, so require() and import() resolve from there.
const assert = require('node:assert/strict');

(async () => {
	const cjs = require('drizzle-cubrid');
	const esm = await import('drizzle-cubrid');
	for (const api of [cjs, esm]) {
		assert.equal(typeof api.drizzle, 'function');
		assert.equal(typeof api.cubridTable, 'function');
		assert.equal(typeof api.cubridSet, 'function');
		const table = api.cubridTable('node18_consumer_smoke', { tags: api.cubridSet('tags') });
		assert.ok(table.tags, 'runtime table/column construction must work');
	}
	// Experimental native entry (#157): its own table and column builders.
	const nativeCjs = require('drizzle-cubrid/native');
	const nativeEsm = await import('drizzle-cubrid/native');
	for (const api of [nativeCjs, nativeEsm]) {
		assert.equal(typeof api.cubridTable, 'function');
		const table = api.cubridTable('node18_native_smoke', {
			id: api.integer().primaryKey().autoIncrement(),
			big: api.bigint({ mode: 'bigint' }),
			tags: api.set({ element: api.varchar({ length: 10 }) }),
		});
		assert.equal(table.id.name, 'id');
		assert.equal(table.big.mapFromDriverValue(9223372036854775807n), 9223372036854775807n);
		assert.equal(table.tags.getSQLType(), 'SET(VARCHAR(10))');
	}
	// Native migrator entry (#163): reads and checks a migrations folder without a database.
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'node18-migrations-'));
	try {
		fs.writeFileSync(path.join(folder, '0001_init.sql'), 'CREATE TABLE "node18_smoke" ("id" INT);\n');
		const migratorCjs = require('drizzle-cubrid/native/migrator');
		const migratorEsm = await import('drizzle-cubrid/native/migrator');
		for (const api of [migratorCjs, migratorEsm]) {
			assert.equal(typeof api.migrate, 'function');
			const [file] = await api.readMigrationFiles(folder);
			assert.deepEqual([file.id, file.name, file.statements.length, file.checksum.length], [1, 'init', 1, 64]);
		}
		const nativeApi = require('drizzle-cubrid/native');
		const table = nativeApi.cubridTable('node18_migration_smoke', { id: nativeApi.integer().primaryKey() });
		assert.match(nativeApi.generateInitialMigration([table]), /CREATE TABLE "node18_migration_smoke"/);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
	console.log(`Node ${process.version} packed CJS and ESM consumer assertions passed`);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
