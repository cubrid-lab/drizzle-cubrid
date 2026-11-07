import { describe, expect, it } from 'vitest';

import {
	bigint,
	char,
	cubridSequence,
	cubridSet,
	decimal,
	int,
	mediumint,
	smallint,
	tinyint,
	varchar,
} from '../src/columns';
import { cubridTable } from '../src/table';

type CustomTypeParams = {
	dataType: (config?: unknown) => string;
	fromDriver: (value: string) => string[];
	toDriver: (value: string[]) => string;
};

function paramsOf(builder: unknown): CustomTypeParams {
	const config = (builder as { config: { customTypeParams: CustomTypeParams } }).config;
	return config.customTypeParams;
}

function sqlTypeOf(element?: unknown): string {
	return paramsOf(cubridSet('col', element ? { element: element as never } : undefined))
		.dataType({ element });
}

describe('collection element SQL types', () => {
	it('defaults to VARCHAR(100) without an element or config', () => {
		expect(sqlTypeOf()).toBe('SET(VARCHAR(100))');
		expect(sqlTypeOf({})).toBe('SET(VARCHAR(100))');
	});

	it('maps sized string columns', () => {
		expect(sqlTypeOf(varchar('v', { length: 50 }))).toBe('SET(VARCHAR(50))');
		expect(sqlTypeOf(char('c', { length: 8 }))).toBe('SET(CHAR(8))');
	});

	it('omits the length when a string column has none', () => {
		expect(sqlTypeOf({ config: { columnType: 'MySqlVarChar' } })).toBe('SET(VARCHAR)');
		expect(sqlTypeOf({ config: { columnType: 'MySqlChar' } })).toBe('SET(CHAR)');
	});

	it('maps integer family columns', () => {
		expect(sqlTypeOf(int('i'))).toBe('SET(INTEGER)');
		expect(sqlTypeOf(smallint('s'))).toBe('SET(SMALLINT)');
		expect(sqlTypeOf(tinyint('t'))).toBe('SET(SMALLINT)');
		expect(sqlTypeOf(mediumint('m'))).toBe('SET(INTEGER)');
		expect(sqlTypeOf(bigint('b', { mode: 'number' }))).toBe('SET(NUMBER)');
	});

	it('maps decimal with and without precision', () => {
		expect(sqlTypeOf(decimal('d', { precision: 10, scale: 2 }))).toBe('SET(DECIMAL(10,2))');
		expect(sqlTypeOf(decimal('d', { precision: 8 }))).toBe('SET(DECIMAL(8))');
		expect(sqlTypeOf(decimal('d'))).toBe('SET(DECIMAL)');
	});

	it('delegates to a nested custom type', () => {
		const element = {
			config: {
				columnType: 'MySqlCustomColumn',
				customTypeParams: { dataType: () => 'blob' },
				fieldConfig: undefined,
			},
		};
		expect(sqlTypeOf(element)).toBe('SET(BLOB)');
	});

	it('maps drizzle bigint and serial column types to BIGINT', () => {
		for (const columnType of ['MySqlBigInt', 'MySqlSerial']) {
			expect(sqlTypeOf({ config: { columnType } })).toBe('SET(BIGINT)');
		}
	});

	it('falls back to the declared dataType, then to VARCHAR(100)', () => {
		expect(sqlTypeOf({ config: { columnType: 'Unknown', dataType: 'clob' } })).toBe('SET(CLOB)');
		expect(sqlTypeOf({ config: { columnType: 'Unknown' } })).toBe('SET(VARCHAR(100))');
	});
});

describe('collection literal round trip', () => {
	const params = paramsOf(cubridSet('tags'));

	it('serializes values into a brace literal', () => {
		expect(params.toDriver(['a', 'b'])).toBe("{'a','b'}");
		expect(params.toDriver([])).toBe('{}');
	});

	it('escapes quotes and backslashes', () => {
		expect(params.toDriver(["it's"])).toBe("{'it''s'}");
		expect(params.toDriver(['a\\b'])).toBe("{'a\\\\b'}");
	});

	it('parses brace literals back into arrays', () => {
		expect(params.fromDriver("{'a','b'}")).toEqual(['a', 'b']);
		expect(params.fromDriver("{'it''s'}")).toEqual(["it's"]);
	});

	it('parses unquoted and unwrapped content', () => {
		expect(params.fromDriver('1,2')).toEqual(['1', '2']);
		expect(params.fromDriver("{'a',b}")).toEqual(['a', 'b']);
	});

	it('returns an empty array for empty input', () => {
		expect(params.fromDriver('')).toEqual([]);
		expect(params.fromDriver('   ')).toEqual([]);
		expect(params.fromDriver('{}')).toEqual([]);
	});

	it('round trips through both directions', () => {
		const original = ['x', "y'z"];
		expect(params.fromDriver(params.toDriver(original))).toEqual(original);
	});
});

describe('collection builders', () => {
	it('produces the matching collection keyword', () => {
		expect(paramsOf(cubridSequence('seq')).dataType({})).toBe('SEQUENCE(VARCHAR(100))');
	});

	it('can be used as table columns', () => {
		const table = cubridTable('docs', { tags: cubridSet('tags') });
		expect(table.tags).toBeDefined();
	});
});
