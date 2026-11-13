import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	bigint,
	char,
	cubridMultiset,
	cubridSequence,
	cubridSet,
	decimal,
	int,
	mediumint,
	smallint,
	tinyint,
	varchar,
} from '../src/columns';
import { drizzle } from '../src/driver';
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

// cubrid-client 1.x returns SET, MULTISET and SEQUENCE columns as arrays and
// cannot bind an array parameter, so a value is written as a typed collection
// literal whose elements are ordinary parameters: SET{?, ?} (#184).
describe('collection values', () => {
	const dialect = new MySqlDialect();
	const docs = cubridTable('docs', {
		id: int('id'),
		tags: cubridSet('tags'),
		counts: cubridMultiset<number>('counts', { element: int('n') }),
		steps: cubridSequence('steps'),
	});
	const db = drizzle({ async query() { return []; } });

	it('returns the array cubrid-client decoded, element types included', () => {
		expect(docs.tags.mapFromDriverValue(['a', 'b'])).toEqual(['a', 'b']);
		expect(docs.counts.mapFromDriverValue([1, 1, 2])).toEqual([1, 1, 2]);
		expect(docs.steps.mapFromDriverValue(['b', null, 'a'])).toEqual(['b', null, 'a']);
		expect(docs.tags.mapFromDriverValue([])).toEqual([]);
	});

	it('refuses a driver value that is not an array instead of parsing text', () => {
		expect(() => docs.tags.mapFromDriverValue("{'a','b'}" as never)).toThrow(/array/);
	});

	it('writes each element as its own parameter inside a typed literal', () => {
		const query = db
			.insert(docs)
			.values({ id: 1, tags: ["it's", 'a\\b', '한글'], counts: [3, 3], steps: ['x', null] })
			.toSQL();

		expect(query.sql).toContain('SET{?, ?, ?}');
		expect(query.sql).toContain('MULTISET{?, ?}');
		expect(query.sql).toContain('SEQUENCE{?, ?}');
		expect(query.params).toEqual([1, "it's", 'a\\b', '한글', 3, 3, 'x', null]);
	});

	it('writes an empty collection as an empty typed literal', () => {
		const query = db.update(docs).set({ tags: [] }).toSQL();

		expect(query.sql).toContain('SET{}');
		expect(query.params).toEqual([]);
	});

	it('refuses a value that is not an array before building SQL', () => {
		expect(() =>
			dialect.sqlToQuery(db.update(docs).set({ tags: 'a,b' as never }).getSQL()),
		).toThrow(/array/);
	});

	it.each([
		['an object', { a: 1 }],
		['a nested array', ['x']],
		['a function', () => 1],
		['NaN', Number.NaN],
	])('refuses %s as an element', (_name, element) => {
		expect(() =>
			dialect.sqlToQuery(db.update(docs).set({ tags: [element] as never }).getSQL()),
		).toThrow(/element/);
	});

	it('types elements from the generic parameter', () => {
		expectTypeOf(docs.counts.$inferInsert).toEqualTypeOf<(number | null)[]>();
		expectTypeOf(docs.tags.$inferInsert).toEqualTypeOf<(string | null)[]>();
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
