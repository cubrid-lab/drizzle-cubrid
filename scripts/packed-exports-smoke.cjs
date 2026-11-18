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
	console.log(`Node ${process.version} packed CJS and ESM consumer assertions passed`);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
