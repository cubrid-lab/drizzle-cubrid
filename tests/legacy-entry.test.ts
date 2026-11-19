// drizzle-cubrid/legacy, the deprecated 0.x entry (ADR 0010): its one-time
// DeprecationWarning, and that the native root entry never emits it.
import * as orm from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitLegacyDeprecationWarning, LEGACY_DEPRECATION_CODE, LEGACY_DEPRECATION_MESSAGE } from '../src/deprecation';

const WARNED = Symbol.for('drizzle-cubrid.legacy-deprecation-warned');
const flags = globalThis as { [WARNED]?: boolean };

describe('drizzle-cubrid/legacy deprecation warning', () => {
	let emitWarning: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		delete flags[WARNED];
		vi.resetModules();
		emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
	});
	afterEach(() => {
		emitWarning.mockRestore();
	});

	it('is a DeprecationWarning with the documented code, emitted once per process', () => {
		emitLegacyDeprecationWarning();
		emitLegacyDeprecationWarning();
		expect(emitWarning).toHaveBeenCalledTimes(1);
		expect(emitWarning).toHaveBeenCalledWith(LEGACY_DEPRECATION_MESSAGE, {
			type: 'DeprecationWarning',
			code: 'DRIZZLE_CUBRID_LEGACY',
		});
		expect(LEGACY_DEPRECATION_CODE).toBe('DRIZZLE_CUBRID_LEGACY');
		expect(LEGACY_DEPRECATION_MESSAGE).toMatch(/removed in drizzle-cubrid 1\.0/);
		expect(LEGACY_DEPRECATION_MESSAGE).toMatch(/MIGRATING_FROM_0X\.md/);
	});

	it('is emitted when the legacy entry is loaded, and not again when it is loaded again', async () => {
		await import('../src/legacy');
		expect(emitWarning).toHaveBeenCalledTimes(1);
		vi.resetModules();
		await import('../src/legacy');
		expect(emitWarning).toHaveBeenCalledTimes(1);
	});

	it('is never emitted by the root entry or drizzle-cubrid/native (src/native/index.ts)', async () => {
		const root = await import('../src/native/index');
		const migrator = await import('../src/native/migrator');
		expect(typeof root.drizzle).toBe('function');
		expect(typeof migrator.migrate).toBe('function');
		expect(emitWarning).not.toHaveBeenCalled();
		expect(flags[WARNED]).toBeUndefined();
	});

	it('does nothing where process.emitWarning does not exist', () => {
		const original = process.emitWarning;
		Object.defineProperty(process, 'emitWarning', { value: undefined, configurable: true, writable: true });
		try {
			expect(() => emitLegacyDeprecationWarning()).not.toThrow();
		} finally {
			Object.defineProperty(process, 'emitWarning', { value: original, configurable: true, writable: true });
		}
	});
});

describe('drizzle-cubrid/legacy exports', () => {
	it('exports the 0.x API unchanged: the same objects as before 0.3', async () => {
		// Loaded together, from one module registry (the tests above reset it).
		const [legacy, columns, driver, table] = await Promise.all([
			import('../src/legacy'),
			import('../src/columns'),
			import('../src/driver'),
			import('../src/table'),
		]);
		expect([legacy.and, legacy.eq, legacy.sql, legacy.placeholder, legacy.count, legacy.sum]).toEqual([
			orm.and,
			orm.eq,
			orm.sql,
			orm.placeholder,
			orm.count,
			orm.sum,
		]);
		expect(legacy.sql).toBe(orm.sql);
		expect(legacy.int).toBe(columns.int);
		expect(legacy.varchar).toBe(columns.varchar);
		expect(legacy.mysqlEnum).toBe(columns.mysqlEnum);
		expect(legacy.drizzle).toBe(driver.drizzle);
		expect(legacy.cubridTable).toBe(table.cubridTable);
		expect(Object.keys(legacy).sort()).toEqual(
			[
				...['and', 'asc', 'avg', 'count', 'desc', 'eq', 'gt', 'gte', 'lt', 'lte', 'max', 'min', 'ne', 'not', 'or'],
				...['placeholder', 'sql', 'sum', 'CubridDatabase', 'CubridPreparedQuery', 'CubridSession'],
				...['CubridTransaction', 'cubridMultiset', 'cubridSequence', 'cubridSet', 'cubridTable', 'drizzle'],
				...['monetary', 'multiset', 'sequence', 'set', 'bigint', 'binary', 'boolean', 'char', 'customType'],
				...['date', 'datetime', 'decimal', 'double', 'float', 'int', 'longtext', 'mediumint', 'mediumtext'],
				...['mysqlEnum', 'real', 'serial', 'smallint', 'text', 'time', 'timestamp', 'tinyint', 'tinytext'],
				...['varbinary', 'varchar', 'year'],
			].sort(),
		);
	});
});
