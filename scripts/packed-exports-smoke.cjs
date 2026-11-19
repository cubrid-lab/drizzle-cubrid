// Offline smoke test of an installed drizzle-cubrid tarball's CommonJS and ESM
// exports, run on Node 18 by CI and the release gate. Copy it into the
// consumer project first, so require() and import() resolve from there.
//
// Export layout (ADR 0010): drizzle-cubrid is the CUBRID-native API and
// drizzle-cubrid/native is the same module; drizzle-cubrid/migrator and
// drizzle-cubrid/native/migrator are the same module; drizzle-cubrid/legacy is
// the deprecated 0.x API and warns once (DRIZZLE_CUBRID_LEGACY) when loaded.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const legacyWarnings = [];
process.on('warning', (warning) => {
	if (warning.code === 'DRIZZLE_CUBRID_LEGACY') legacyWarnings.push(warning);
});
// process.emitWarning() dispatches on the next tick.
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
	// The root entry is the native API, and drizzle-cubrid/native is the very same module.
	const rootCjs = require('drizzle-cubrid');
	const rootEsm = await import('drizzle-cubrid');
	const nativeCjs = require('drizzle-cubrid/native');
	const nativeEsm = await import('drizzle-cubrid/native');
	assert.equal(rootCjs, nativeCjs, 'require: drizzle-cubrid/native must be the root module');
	assert.equal(rootEsm, nativeEsm, 'import: drizzle-cubrid/native must be the root module');
	for (const name of ['cubridTable', 'drizzle', 'CubridDatabase', 'CubridTable', 'CubridSession', 'integer', 'set']) {
		assert.equal(rootCjs[name], nativeCjs[name], `require: ${name} differs between the root and /native`);
		assert.equal(rootEsm[name], nativeEsm[name], `import: ${name} differs between the root and /native`);
	}
	for (const api of [rootCjs, rootEsm]) {
		assert.equal(typeof api.drizzle, 'function');
		assert.equal(typeof api.cubridTable, 'function');
		const table = api.cubridTable('node18_native_smoke', {
			id: api.integer().primaryKey().autoIncrement(),
			big: api.bigint({ mode: 'bigint' }),
			tags: api.set({ element: api.varchar({ length: 10 }) }),
		});
		assert.equal(table.id.name, 'id');
		assert.equal(table.big.mapFromDriverValue(9223372036854775807n), 9223372036854775807n);
		assert.equal(table.tags.getSQLType(), 'SET(VARCHAR(10))');
		// A table built through the root is a table of drizzle-cubrid/native's class.
		assert.ok(table instanceof (api === rootCjs ? nativeCjs : nativeEsm).CubridTable);
		// Drizzle's operators, as the 0.x root exported them.
		const orm = api === rootCjs ? require('drizzle-orm') : await import('drizzle-orm');
		assert.equal(api.eq, orm.eq);
		assert.equal(api.sql, orm.sql);
		// A 0.x name without a native counterpart throws with guidance instead of being undefined.
		assert.throws(
			() => api.cubridSet('tags'),
			(error) =>
				error.name === 'CubridRemovedExportError' &&
				/drizzle-cubrid\/legacy/.test(error.message) &&
				/set\(\{ element \}\)/.test(error.message),
		);
	}
	// Native migrator entry (#163), under both of its paths: one module.
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	assert.equal(require('drizzle-cubrid/migrator'), require('drizzle-cubrid/native/migrator'));
	assert.equal(await import('drizzle-cubrid/migrator'), await import('drizzle-cubrid/native/migrator'));
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'node18-migrations-'));
	try {
		fs.writeFileSync(path.join(folder, '0001_init.sql'), 'CREATE TABLE "node18_smoke" ("id" INT);\n');
		for (const api of [require('drizzle-cubrid/migrator'), await import('drizzle-cubrid/migrator')]) {
			assert.equal(typeof api.migrate, 'function');
			const [file] = await api.readMigrationFiles(folder);
			assert.deepEqual([file.id, file.name, file.statements.length, file.checksum.length], [1, 'init', 1, 64]);
		}
		const table = rootCjs.cubridTable('node18_migration_smoke', { id: rootCjs.integer().primaryKey() });
		assert.match(rootCjs.generateInitialMigration([table]), /CREATE TABLE "node18_migration_smoke"/);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
	await settle();
	assert.equal(legacyWarnings.length, 0, 'the root, /native and the migrator must not emit the legacy warning');

	// The deprecated 0.x entry: unchanged API, one DeprecationWarning for the process.
	const legacyCjs = require('drizzle-cubrid/legacy');
	const legacyEsm = await import('drizzle-cubrid/legacy');
	for (const api of [legacyCjs, legacyEsm]) {
		assert.equal(typeof api.drizzle, 'function');
		assert.equal(typeof api.cubridSet, 'function');
		const table = api.cubridTable('node18_consumer_smoke', { tags: api.cubridSet('tags') });
		assert.ok(table.tags, 'runtime table/column construction must work');
		assert.notEqual(api.drizzle, rootCjs.drizzle);
	}
	await settle();
	assert.equal(legacyWarnings.length, 1, 'drizzle-cubrid/legacy must warn exactly once per process');
	assert.equal(legacyWarnings[0].name, 'DeprecationWarning');
	assert.match(legacyWarnings[0].message, /removed in drizzle-cubrid 1\.0/);

	// Node's own flags control the warning, in a fresh process each.
	const node = (flags, code) =>
		spawnSync(process.execPath, [...flags, '-e', code], { cwd: process.cwd(), encoding: 'utf8' });
	const both = "require('drizzle-cubrid/legacy'); import('drizzle-cubrid/legacy').then(() => {});";
	const plain = node([], both);
	assert.equal(plain.status, 0, plain.stderr);
	assert.equal(plain.stderr.match(/\[DRIZZLE_CUBRID_LEGACY\] DeprecationWarning/g)?.length, 1, plain.stderr);
	const silenced = node(['--no-deprecation'], both);
	assert.equal(silenced.status, 0, silenced.stderr);
	assert.doesNotMatch(silenced.stderr, /DRIZZLE_CUBRID_LEGACY/);
	// Node throws the warning on the next tick: the process fails with an
	// uncaught DeprecationWarning, and a try/catch around the require catches nothing.
	const thrown = node(['--throw-deprecation'], "try { require('drizzle-cubrid/legacy'); } catch { process.exit(3); }");
	assert.notEqual(thrown.status, 0);
	assert.notEqual(thrown.status, 3, 'the import itself must not throw');
	assert.match(thrown.stderr, /DRIZZLE_CUBRID_LEGACY/);
	const quiet = node(['--throw-deprecation'], "require('drizzle-cubrid'); require('drizzle-cubrid/native');");
	assert.equal(quiet.status, 0, quiet.stderr);
	assert.equal(quiet.stderr, '');

	console.log(`Node ${process.version} packed CJS and ESM consumer assertions passed`);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
