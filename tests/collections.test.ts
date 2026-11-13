import { sql } from 'drizzle-orm';
import { json, MySqlDialect } from 'drizzle-orm/mysql-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

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
	float,
	int,
	mediumint,
	mysqlEnum,
	smallint,
	text,
	time,
	timestamp,
	tinyint,
	varchar,
} from '../src/columns';
import { drizzle } from '../src/driver';
import { cubridTable } from '../src/table';
import { monetary } from '../src/types';

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
	return paramsOf(cubridSet('col', element ? { element: element as never } : undefined)).dataType({ element });
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
		expect(sqlTypeOf(bigint('b', { mode: 'number' }))).toBe('SET(BIGINT)');
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
	const db = drizzle(
		{
			async query() {
				return [];
			},
		},
		{ binding: 'literal' },
	);

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

		expect(query.sql).toContain('CAST(SET{?, ?, ?} AS SET(STRING))');
		expect(query.sql).toContain('CAST(MULTISET{?, ?} AS MULTISET(INTEGER))');
		expect(query.sql).toContain('CAST(SEQUENCE{?, ?} AS SEQUENCE(STRING))');
		expect(query.params).toEqual([1, "it's", 'a\\b', '한글', 3, 3, 'x', null]);
	});

	it('writes an empty collection as an empty typed literal', () => {
		const query = db.update(docs).set({ tags: [] }).toSQL();

		expect(query.sql).toContain('CAST(SET{} AS SET(STRING))');
		expect(query.params).toEqual([]);
	});

	it('refuses a value that is not an array before building SQL', () => {
		expect(() =>
			dialect.sqlToQuery(
				db
					.update(docs)
					.set({ tags: 'a,b' as never })
					.getSQL(),
			),
		).toThrow(/array/);
	});

	it.each([
		['an object', { a: 1 }],
		['a nested array', ['x']],
		['a function', () => 1],
		['NaN', Number.NaN],
	])('refuses %s as an element', (_name, element) => {
		expect(() =>
			dialect.sqlToQuery(
				db
					.update(docs)
					.set({ tags: [element] as never })
					.getSQL(),
			),
		).toThrow(/element/);
	});

	it('sends Uint8Array elements as a Buffer, as cubrid-client requires', () => {
		const query = db
			.update(docs)
			.set({ tags: [new Uint8Array([1, 2]) as never] })
			.toSQL();

		expect(Buffer.isBuffer(query.params[0])).toBe(true);
		expect([...(query.params[0] as Buffer)]).toEqual([1, 2]);
	});

	it('refuses a placeholder for the whole collection value when the query runs', async () => {
		const client = {
			queries: 0,
			async query() {
				this.queries++;
				return [];
			},
		};
		const prepared = drizzle(client, { binding: 'literal' })
			.update(docs)
			.set({ tags: sql.placeholder('tags') as never })
			.prepare();

		await expect(prepared.execute({ tags: ['a'] })).rejects.toThrow(/placeholder/);
		expect(client.queries).toBe(0);
	});

	it('types elements from the generic parameter', () => {
		expectTypeOf(docs.counts.$inferInsert).toEqualTypeOf<(number | null)[]>();
		expectTypeOf(docs.tags.$inferInsert).toEqualTypeOf<(string | null)[]>();
	});
});

enum Color {
	Red = 'red',
	Blue = 'blue',
}

describe('collection element types', () => {
	const dialect = new MySqlDialect();
	const db = drizzle(
		{
			async query() {
				return [];
			},
		},
		{ binding: 'literal' },
	);
	const castOf = (element?: unknown) => {
		const t = cubridTable('t', { c: cubridSequence('c', element ? { element: element as never } : undefined) });
		return dialect.sqlToQuery(
			db
				.update(t)
				.set({ c: ['x'] as never })
				.getSQL(),
		).sql;
	};

	it.each([
		[datetime('e'), 'DATETIME'],
		[datetime('e', { mode: 'string' }), 'DATETIME'],
		[timestamp('e'), 'TIMESTAMP'],
		[date('e'), 'DATE'],
		[time('e'), 'TIME'],
		[double('e'), 'DOUBLE'],
		[float('e'), 'FLOAT'],
		[boolean('e'), 'SMALLINT'],
		[bigint('e', { mode: 'bigint' }), 'BIGINT'],
		[decimal('e', { precision: 10, scale: 2 }), 'DECIMAL(10,2)'],
		[decimal('e', { precision: 8, scale: 1, mode: 'number' }), 'DECIMAL(8,1)'],
		[decimal('e', { precision: 20, mode: 'bigint' }), 'DECIMAL(20)'],
		[char('e', { length: 3 }), 'CHAR(3)'],
		[monetary('e'), 'MONETARY'],
	])('uses the CUBRID type of %# in DDL and in the write cast', (element, expected) => {
		expect(sqlTypeOf(element)).toBe(`SET(${expected})`);
		expect(castOf(element)).toContain(`AS SEQUENCE(${expected}))`);
	});

	it.each([
		[undefined, 'VARCHAR(100)'],
		[varchar('e', { length: 20 }), 'VARCHAR(20)'],
		[text('e'), 'STRING'],
		[mysqlEnum('e', ['a', 'b']), 'STRING'],
		[mysqlEnum('e', Color), 'STRING'],
	])('keeps the declared string type %# in DDL but casts writes to STRING', (element, ddl) => {
		expect(sqlTypeOf(element)).toBe(`SET(${ddl})`);
		expect(castOf(element)).toContain('AS SEQUENCE(STRING))');
	});

	it('writes an element type it cannot map without a cast', () => {
		const sqlText = castOf(json('e'));

		expect(sqlText).toContain('SEQUENCE{?}');
		expect(sqlText).not.toContain('CAST(');
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
