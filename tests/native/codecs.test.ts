// Codecs of the drizzle-cubrid/native column builders (#157, #162): every
// builder's SQL type and its conversions to and from cubrid-client values.
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
	bigint,
	boolean,
	CubridChar,
	CubridCollection,
	CubridColumn,
	CubridNumeric,
	CubridNumericNumber,
	CubridVarchar,
	char,
	collectionLiteralSql,
	cubridTable,
	date,
	datetime,
	decimal,
	double,
	float,
	int,
	integer,
	monetary,
	multiset,
	numeric,
	sequence,
	set,
	smallint,
	string,
	time,
	timestamp,
	varchar,
} from '../../src/native/index';

const t = cubridTable('codecs', {
	small: smallint(),
	whole: integer('whole_col'),
	alias: int(),
	big: bigint({ mode: 'bigint' }),
	bigNum: bigint({ mode: 'number' }),
	exact: numeric({ precision: 38, scale: 10 }),
	exactP: numeric({ precision: 10 }),
	exactDefault: numeric(),
	exactNum: decimal('exact_num', { precision: 10, scale: 2, mode: 'number' }),
	single: float(),
	dbl: double(),
	code: char({ length: 5 }),
	name: varchar('name', { length: 50 }),
	note: string(),
	active: boolean(),
	at: datetime(),
	atText: datetime({ mode: 'string' }),
	stamp: timestamp(),
	stampText: timestamp({ mode: 'string' }),
	day: date(),
	dayText: date({ mode: 'string' }),
	clock: time(),
	price: monetary(),
	tags: set({ element: varchar({ length: 20 }) }),
	counts: multiset({ element: bigint({ mode: 'bigint' }) }),
	flags: sequence({ element: boolean() }),
	times: sequence({ element: datetime() }),
	codes: set({ element: char({ length: 3 }) }),
});

const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;

describe('SQL types', () => {
	it.each([
		['small', 'SMALLINT'],
		['whole', 'INTEGER'],
		['alias', 'INTEGER'],
		['big', 'BIGINT'],
		['bigNum', 'BIGINT'],
		['exact', 'NUMERIC(38,10)'],
		['exactP', 'NUMERIC(10)'],
		['exactDefault', 'NUMERIC'],
		['exactNum', 'NUMERIC(10,2)'],
		['single', 'FLOAT'],
		['dbl', 'DOUBLE'],
		['code', 'CHAR(5)'],
		['name', 'VARCHAR(50)'],
		['note', 'STRING'],
		['active', 'SMALLINT'],
		['at', 'DATETIME'],
		['atText', 'DATETIME'],
		['stamp', 'TIMESTAMP'],
		['stampText', 'TIMESTAMP'],
		['day', 'DATE'],
		['dayText', 'DATE'],
		['clock', 'TIME'],
		['price', 'MONETARY'],
		['tags', 'SET(VARCHAR(20))'],
		['counts', 'MULTISET(BIGINT)'],
		['flags', 'SEQUENCE(SMALLINT)'],
		['times', 'SEQUENCE(DATETIME)'],
		['codes', 'SET(CHAR(3))'],
	] as const)('%s is %s', (key, sqlType) => {
		expect(t[key].getSQLType()).toBe(sqlType);
		expect(t[key]).toBeInstanceOf(CubridColumn);
	});

	it('names columns by key unless a name is given', () => {
		expect(getTableName(t)).toBe('codecs');
		expect(t.small.name).toBe('small');
		expect(t.whole.name).toBe('whole_col');
		expect(t.exactNum.name).toBe('exact_num');
		expect(t.whole.keyAsName).toBe(false);
		expect(t.small.keyAsName).toBe(true);
		expect(Object.keys(getTableColumns(t))).toHaveLength(28);
		expect(getTableColumns(t).small).toBe(t.small);
	});

	it('exposes the declared lengths and precision', () => {
		const code: unknown = t.code;
		const name: unknown = t.name;
		const exact: unknown = t.exact;
		const exactNum: unknown = t.exactNum;
		expect(code instanceof CubridChar && code.length).toBe(5);
		expect(name instanceof CubridVarchar && name.length).toBe(50);
		expect(exact instanceof CubridNumeric && [exact.precision, exact.scale]).toEqual([38, 10]);
		expect(exactNum instanceof CubridNumericNumber && [exactNum.precision, exactNum.scale]).toEqual([10, 2]);
	});
});

describe('integers', () => {
	it('reads SMALLINT and INTEGER numbers', () => {
		expect(t.small.mapFromDriverValue(-32768)).toBe(-32768);
		expect(t.whole.mapFromDriverValue(2147483647)).toBe(2147483647);
		expect(t.whole.mapFromDriverValue('42')).toBe(42);
		expect(t.whole.mapFromDriverValue(7n)).toBe(7);
		expect(t.whole.mapToDriverValue(5)).toBe(5);
	});

	it('refuses non-integers', () => {
		expect(() => t.whole.mapFromDriverValue(1.5)).toThrow(
			/INTEGER value from the driver must be an integer, got number 1.5/,
		);
		expect(() => t.small.mapFromDriverValue('x')).toThrow(/SMALLINT value .* got string "x"/);
		expect(() => t.small.mapFromDriverValue(null)).toThrow(/got null/);
	});

	it('reads BIGINT in bigint mode exactly, including both ends of the range', () => {
		expect(t.big.mapFromDriverValue(MAX)).toBe(MAX);
		expect(t.big.mapFromDriverValue(MIN)).toBe(MIN);
		expect(t.big.mapFromDriverValue(2n ** 53n + 1n)).toBe(2n ** 53n + 1n);
		expect(t.big.mapFromDriverValue(-5)).toBe(-5n);
		expect(t.big.mapFromDriverValue('9223372036854775807')).toBe(MAX);
		expect(t.big.mapToDriverValue(MAX)).toBe(MAX);
		expect(() => t.big.mapFromDriverValue(1.5)).toThrow(/BIGINT value from the driver must be an integer/);
		expect(() => t.big.mapFromDriverValue(2 ** 60)).toThrow(/BIGINT/);
		expect(() => t.big.mapFromDriverValue('1e3')).toThrow(/BIGINT/);
	});

	it('reads BIGINT in number mode only within the safe-integer range', () => {
		expect(t.bigNum.mapFromDriverValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
		expect(t.bigNum.mapFromDriverValue(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
		expect(t.bigNum.mapFromDriverValue(-12n)).toBe(-12);
		expect(t.bigNum.mapFromDriverValue(12)).toBe(12);
		expect(() => t.bigNum.mapFromDriverValue(2n ** 53n)).toThrow(RangeError);
		expect(() => t.bigNum.mapFromDriverValue(MAX)).toThrow(
			/BIGINT value 9223372036854775807 is outside .* use bigint\(name, \{ mode: 'bigint' \}\)/,
		);
		expect(() => t.bigNum.mapFromDriverValue(MIN)).toThrow(RangeError);
		expect(() => t.bigNum.mapFromDriverValue('9007199254740993')).toThrow(RangeError);
	});

	it('requires a bigint mode', () => {
		// @ts-expect-error mode is required
		expect(() => bigint('x')).toThrow(
			/bigint\(\) needs \{ mode: 'number' \} or \{ mode: 'bigint' \}, got mode undefined/,
		);
		// @ts-expect-error unknown mode
		expect(() => bigint({ mode: 'string' })).toThrow(/got mode string "string"/);
	});
});

describe('NUMERIC', () => {
	it('keeps the exact string in string mode', () => {
		const digits = '1234567890123456789012345678.0123456789';
		expect(t.exact.mapFromDriverValue(digits)).toBe(digits);
		expect(t.exact.mapFromDriverValue('-0.0000000001')).toBe('-0.0000000001');
		expect(t.exact.mapFromDriverValue(12)).toBe('12');
		expect(t.exact.mapFromDriverValue(12n)).toBe('12');
		expect(t.exact.mapToDriverValue(digits)).toBe(digits);
		expect(t.exact.mapToDriverValue(0.1)).toBe('0.1');
		expect(() => t.exact.mapFromDriverValue(true)).toThrow(
			/NUMERIC value from the driver must be a string, got boolean true/,
		);
	});

	it('converts with Number() in number mode', () => {
		expect(t.exactNum.mapFromDriverValue('12.50')).toBe(12.5);
		expect(t.exactNum.mapFromDriverValue(3)).toBe(3);
		// More digits than a double holds are rounded, as documented.
		expect(t.exactNum.mapFromDriverValue('12345678901234567890.1')).toBe(12345678901234567000);
		expect(t.exactNum.mapToDriverValue(12.5)).toBe('12.5');
		expect(t.exactNum.mapToDriverValue('7.25')).toBe('7.25');
		expect(() => t.exactNum.mapFromDriverValue(null)).toThrow(/NUMERIC/);
	});

	it('validates the config', () => {
		expect(() => numeric({ scale: 2 })).toThrow(/scale needs precision/);
		// @ts-expect-error unknown mode
		expect(() => numeric('x', { mode: 'bigint' })).toThrow(/mode must be 'string' or 'number'/);
		expect(decimal).toBe(numeric);
	});
});

describe('FLOAT, DOUBLE and MONETARY', () => {
	it('reads numbers', () => {
		expect(t.single.mapFromDriverValue(Math.fround(1.1))).toBe(Math.fround(1.1));
		expect(t.single.mapFromDriverValue('2.5')).toBe(2.5);
		expect(t.dbl.mapFromDriverValue(1.1)).toBe(1.1);
		expect(t.dbl.mapFromDriverValue(-0)).toBe(-0);
		expect(t.dbl.mapToDriverValue(1.1)).toBe(1.1);
		expect(() => t.single.mapFromDriverValue('')).toThrow(/FLOAT value from the driver must be a number/);
		expect(() => t.dbl.mapFromDriverValue('abc')).toThrow(/DOUBLE/);
		expect(() => t.dbl.mapFromDriverValue(undefined)).toThrow(/got undefined/);
	});

	it('reads MONETARY as the shortest decimal string', () => {
		expect(t.price.mapFromDriverValue(12.34)).toBe('12.34');
		expect(t.price.mapFromDriverValue(-0.5)).toBe('-0.5');
		expect(t.price.mapFromDriverValue('12.34')).toBe('12.34');
		expect(t.price.mapToDriverValue('12.34')).toBe('12.34');
		expect(() => t.price.mapFromDriverValue(1n)).toThrow(
			/MONETARY value from the driver must be a number, got bigint 1n/,
		);
	});
});

describe('strings', () => {
	it('passes CHAR padding through as the server sends it', () => {
		expect(t.code.mapFromDriverValue('ab   ')).toBe('ab   ');
		expect(t.code.mapToDriverValue('ab')).toBe('ab');
	});

	it('reads VARCHAR and STRING, including non-ASCII text', () => {
		expect(t.name.mapFromDriverValue('한국어 텍스트')).toBe('한국어 텍스트');
		expect(t.note.mapFromDriverValue('')).toBe('');
		expect(() => t.name.mapFromDriverValue(1)).toThrow(/VARCHAR value from the driver must be a string, got number 1/);
		expect(() => t.note.mapFromDriverValue('x'.repeat(50) as unknown)).not.toThrow();
		expect(() => t.code.mapFromDriverValue(null)).toThrow(/CHAR/);
		expect(() => t.note.mapFromDriverValue({})).toThrow(/STRING value from the driver must be a string, got object/);
	});

	it('requires a positive integer length', () => {
		// @ts-expect-error length is required
		expect(() => varchar('x')).toThrow(/varchar\(\): length must be a positive integer, got undefined/);
		expect(() => char({ length: 0 })).toThrow(/char\(\): length must be a positive integer, got number 0/);
		expect(() => varchar({ length: 1.5 })).toThrow(/positive integer/);
	});

	it('shortens long values in error messages', () => {
		expect(() => t.whole.mapFromDriverValue('y'.repeat(100))).toThrow(/"y{40}…"/);
	});
});

describe('boolean (SMALLINT)', () => {
	it('writes 1 and 0', () => {
		expect(t.active.mapToDriverValue(true)).toBe(1);
		expect(t.active.mapToDriverValue(false)).toBe(0);
	});

	it('reads 1 and 0', () => {
		expect(t.active.mapFromDriverValue(1)).toBe(true);
		expect(t.active.mapFromDriverValue(0)).toBe(false);
		expect(t.active.mapFromDriverValue(1n)).toBe(true);
		expect(t.active.mapFromDriverValue('0')).toBe(false);
	});

	it('refuses any other value', () => {
		expect(() => t.active.mapFromDriverValue(2)).toThrow(/must be 0 or 1, got number 2/);
		expect(() => t.active.mapFromDriverValue(-1)).toThrow(/0 or 1/);
		expect(() => t.active.mapFromDriverValue(true)).toThrow(/0 or 1/);
		expect(() => t.active.mapToDriverValue(1)).toThrow(/must be true or false, got number 1/);
		expect(() => t.active.mapToDriverValue('true')).toThrow(/true or false/);
	});
});

describe('date and time (UTC wall clock)', () => {
	const instant = new Date(Date.UTC(2024, 1, 29, 23, 59, 58, 123));

	it('writes the UTC wall clock as text', () => {
		expect(t.at.mapToDriverValue(instant)).toBe('2024-02-29 23:59:58.123');
		expect(t.stamp.mapToDriverValue(instant)).toBe('2024-02-29 23:59:58');
		expect(t.day.mapToDriverValue(instant)).toBe('2024-02-29');
		expect(t.atText.mapToDriverValue('2024-02-29 23:59:58.123')).toBe('2024-02-29 23:59:58.123');
		expect(t.clock.mapToDriverValue('13:14:15')).toBe('13:14:15');
	});

	it('reads the driver Date as is, and DATE as midnight UTC', () => {
		expect(t.at.mapFromDriverValue(instant)).toBe(instant);
		expect(t.stamp.mapFromDriverValue(instant)).toBe(instant);
		expect(t.day.mapFromDriverValue(instant)).toEqual(new Date(Date.UTC(2024, 1, 29)));
	});

	it('reads text from the driver as a UTC wall clock', () => {
		expect(t.at.mapFromDriverValue('2024-02-29 23:59:58.123')).toEqual(instant);
		expect(t.day.mapFromDriverValue('2024-02-29')).toEqual(new Date(Date.UTC(2024, 1, 29)));
		expect(() => t.at.mapFromDriverValue('not a date')).toThrow(/DATETIME value from the driver must be a Date/);
		expect(() => t.day.mapFromDriverValue(5)).toThrow(/DATE value from the driver must be a Date, got number 5/);
	});

	it('formats string modes from the driver Date', () => {
		expect(t.atText.mapFromDriverValue(instant)).toBe('2024-02-29 23:59:58.123');
		expect(t.stampText.mapFromDriverValue(instant)).toBe('2024-02-29 23:59:58');
		expect(t.dayText.mapFromDriverValue(new Date(Date.UTC(2024, 1, 29)))).toBe('2024-02-29');
		expect(t.clock.mapFromDriverValue(new Date(Date.UTC(1970, 0, 1, 13, 14, 15)))).toBe('13:14:15');
		expect(t.dayText.mapFromDriverValue('2024-02-29')).toBe('2024-02-29');
		const year1 = new Date(Date.UTC(2000, 0, 1));
		year1.setUTCFullYear(1);
		expect(t.dayText.mapFromDriverValue(year1)).toBe('0001-01-01');
	});

	it('does not depend on the process time zone', () => {
		// Date.UTC fields are what is written, whatever TZ the test runs in.
		const local = new Date(2024, 0, 1, 0, 0, 0);
		expect(t.at.mapToDriverValue(local)).toBe(local.toISOString().slice(0, 23).replace('T', ' '));
	});

	it('refuses wrong values', () => {
		expect(() => t.at.mapToDriverValue('2024-01-01')).toThrow(/DATETIME column value must be a Date, got string/);
		expect(() => t.stamp.mapToDriverValue(new Date(Number.NaN))).toThrow(/TIMESTAMP column value is an invalid Date/);
		expect(() => t.atText.mapToDriverValue(instant)).toThrow(/DATETIME column value must be a string, got a Date/);
		expect(() => t.clock.mapFromDriverValue(1)).toThrow(/TIME column value must be a string/);
		expect(() => t.clock.mapFromDriverValue(new Date(Number.NaN))).toThrow(/invalid Date/);
	});

	it('validates the mode', () => {
		// @ts-expect-error unknown mode
		expect(() => datetime('x', { mode: 'number' })).toThrow(/datetime\(\): mode must be 'date' or 'string'/);
		// @ts-expect-error unknown mode
		expect(() => timestamp({ mode: 'number' })).toThrow(/timestamp\(\)/);
		expect(date('d', { mode: 'date' }).build(t)).toBeInstanceOf(CubridColumn);
	});
});

describe('collections', () => {
	it('encodes each element with the element codec and keeps nulls', () => {
		expect(t.tags.mapToDriverValue(['a', null, '한'])).toEqual(['a', null, '한']);
		expect(t.counts.mapToDriverValue([MAX, null, MIN])).toEqual([MAX, null, MIN]);
		expect(t.flags.mapToDriverValue([true, false, null])).toEqual([1, 0, null]);
		expect(t.times.mapToDriverValue([new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6))])).toEqual(['2024-01-02 03:04:05.006']);
		expect(t.tags.mapToDriverValue([])).toEqual([]);
	});

	it('decodes each element with the element codec and keeps nulls', () => {
		expect(t.tags.mapFromDriverValue(['a', null])).toEqual(['a', null]);
		expect(t.counts.mapFromDriverValue([MAX, 5n, null])).toEqual([MAX, 5n, null]);
		expect(t.flags.mapFromDriverValue([1, 0, null])).toEqual([true, false, null]);
		const at = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6));
		expect(t.times.mapFromDriverValue([at])).toEqual([at]);
		expect(t.codes.mapFromDriverValue(['a  '])).toEqual(['a  ']);
	});

	it('refuses non-arrays, nested arrays, undefined and invalid elements', () => {
		expect(() => t.tags.mapToDriverValue('a')).toThrow(/SET column value must be an array, got string "a"/);
		expect(() => t.tags.mapToDriverValue([['a']])).toThrow(
			/SET element 0 is an array; CUBRID collections cannot be nested/,
		);
		expect(() => t.tags.mapToDriverValue([undefined])).toThrow(/SET element 0 is undefined; use null/);
		expect(() => t.flags.mapToDriverValue([2])).toThrow(/must be true or false/);
		expect(() => t.counts.mapFromDriverValue('1,2')).toThrow(
			/MULTISET value from the driver must be an array \(cubrid-client 1.x\)/,
		);
		expect(() => t.flags.mapFromDriverValue([[1]])).toThrow(/SEQUENCE element 0 from the driver is a nested array/);
		expect(() => t.flags.mapFromDriverValue([2])).toThrow(/0 or 1/);
	});

	it('renders the typed collection literal', () => {
		const counts: unknown = t.counts;
		expect(counts instanceof CubridCollection && counts.kind).toBe('MULTISET');
		expect(collectionLiteralSql(t.counts, 2)).toBe('CAST(MULTISET{?, ?} AS MULTISET(BIGINT))');
		expect(collectionLiteralSql(t.tags, 1)).toBe('CAST(SET{?} AS SET(STRING))');
		expect(collectionLiteralSql(t.codes, 1)).toBe('CAST(SET{?} AS SET(CHAR(3)))');
		expect(collectionLiteralSql(t.flags, 0)).toBe('CAST(SEQUENCE{} AS SEQUENCE(SMALLINT))');
		expect(() => collectionLiteralSql(t.flags, -1)).toThrow(/non-negative element count, got number -1/);
		expect(() => collectionLiteralSql(t.flags, 1.5)).toThrow(RangeError);
		expect(() => collectionLiteralSql(t.whole, 1)).toThrow(
			/Column whole_col is not a SET, MULTISET or SEQUENCE column/,
		);
	});

	it('validates the element', () => {
		// @ts-expect-error element is required
		expect(() => set('x')).toThrow(/set\(\): \{ element \} is required/);
		// @ts-expect-error element is required
		expect(() => multiset({})).toThrow(/multiset\(\)/);
		// @ts-expect-error collections cannot be nested
		expect(() => sequence({ element: set({ element: integer() }) })).toThrow(/cannot contain collections/);
		// @ts-expect-error not a native builder
		expect(() => set({ element: { _: {} } })).toThrow(/must be a drizzle-cubrid\/native column builder/);
	});
});

describe('builders', () => {
	it('refuses generated columns', () => {
		expect(() => integer().generatedAlwaysAs()).toThrow(/generated columns are not supported yet/);
	});
});
