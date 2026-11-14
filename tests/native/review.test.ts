// Write and read validation added after review of #157/#162: exponent-free
// decimals, integer write ranges, temporal ranges and stricter driver text.
import { describe, expect, it } from 'vitest';

import { plainDecimal } from '../../src/native/columns/common';
import {
	bigint,
	cubridTable,
	date,
	datetime,
	double,
	float,
	integer,
	monetary,
	numeric,
	sequence,
	smallint,
	timestamp,
} from '../../src/native/index';

const t = cubridTable('review', {
	small: smallint(),
	whole: integer(),
	big: bigint({ mode: 'bigint' }),
	bigNum: bigint({ mode: 'number' }),
	exact: numeric({ precision: 38, scale: 10 }),
	exactNum: numeric({ precision: 38, scale: 10, mode: 'number' }),
	single: float(),
	dbl: double(),
	price: monetary(),
	at: datetime(),
	atText: datetime({ mode: 'string' }),
	stamp: timestamp(),
	day: date(),
	smalls: sequence({ element: smallint() }),
});

describe('plain decimal text (item 2, 4)', () => {
	it.each([
		[1e-7, '0.0000001'],
		[-1.5e-10, '-0.00000000015'],
		[1.2345e-7, '0.00000012345'],
		[1e21, '1000000000000000000000'],
		[-1.5e22, '-15000000000000000000000'],
		[1.7976931348623157e308, `17976931348623157${'0'.repeat(292)}`],
		[5e-324, `0.${'0'.repeat(323)}5`],
		[0.1, '0.1'],
		[123456.789, '123456.789'],
		[-0, '0'],
	])('writes %s as %s', (value, text) => {
		expect(plainDecimal(value, 'NUMERIC')).toBe(text);
		expect(Number(text)).toBe(value === 0 ? 0 : value);
	});

	it('refuses NaN and infinities', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => t.exact.mapToDriverValue(value)).toThrow(/NUMERIC value must be a finite number/);
			expect(() => t.exactNum.mapToDriverValue(value)).toThrow(RangeError);
		}
	});

	it('writes NUMERIC numbers in both modes without an exponent', () => {
		expect(t.exact.mapToDriverValue(1e-7)).toBe('0.0000001');
		expect(t.exactNum.mapToDriverValue(1e21)).toBe('1000000000000000000000');
		expect(t.exact.mapFromDriverValue(1e21)).toBe('1000000000000000000000');
	});

	it('reads MONETARY numbers without an exponent', () => {
		expect(t.price.mapFromDriverValue(1e21)).toBe('1000000000000000000000');
		expect(t.price.mapFromDriverValue(1e-7)).toBe('0.0000001');
	});
});

describe('integer writes (item 3)', () => {
	it('accepts integers within each type range', () => {
		expect(t.small.mapToDriverValue(-32768)).toBe(-32768);
		expect(t.small.mapToDriverValue(32767)).toBe(32767);
		expect(t.whole.mapToDriverValue(-2147483648)).toBe(-2147483648);
		expect(t.whole.mapToDriverValue(2147483647)).toBe(2147483647);
		expect(t.bigNum.mapToDriverValue(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		expect(t.bigNum.mapToDriverValue(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
	});

	it('refuses fractions and non-numbers instead of letting the server round', () => {
		expect(() => t.whole.mapToDriverValue(1.5)).toThrow(
			/INTEGER column value must be an integer number, got number 1.5/,
		);
		expect(() => t.small.mapToDriverValue('1')).toThrow(TypeError);
		expect(() => t.bigNum.mapToDriverValue(Number.NaN)).toThrow(/BIGINT column value must be an integer number/);
		expect(() => t.smalls.mapToDriverValue([1, 2.5])).toThrow(/SMALLINT column value must be an integer number/);
	});

	it('refuses values outside the type range', () => {
		expect(() => t.small.mapToDriverValue(32768)).toThrow(/SMALLINT column value 32768 is outside -32768..32767/);
		expect(() => t.whole.mapToDriverValue(-2147483649)).toThrow(RangeError);
		expect(() => t.bigNum.mapToDriverValue(2 ** 53)).toThrow(/BIGINT column value 9007199254740992 is outside/);
	});

	it('writes bigint mode as a bigint in the signed 64-bit range', () => {
		expect(t.big.mapToDriverValue(2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
		expect(t.big.mapToDriverValue(-(2n ** 63n))).toBe(-(2n ** 63n));
		expect(t.big.mapToDriverValue(5)).toBe(5n);
		expect(() => t.big.mapToDriverValue(2n ** 63n)).toThrow(/BIGINT column value 9223372036854775808 is outside/);
		expect(() => t.big.mapToDriverValue(1.5)).toThrow(/BIGINT column value must be a bigint, got number 1.5/);
		expect(() => t.big.mapToDriverValue(2 ** 53)).toThrow(TypeError);
		expect(() => t.big.mapToDriverValue('5')).toThrow(TypeError);
	});
});

describe('temporal ranges and driver text (items 5, 6)', () => {
	const year = (y: number) => {
		const d = new Date(Date.UTC(2000, 0, 1));
		d.setUTCFullYear(y);
		return d;
	};

	it('accepts years 0001 to 9999', () => {
		expect(t.at.mapToDriverValue(year(1))).toBe('0001-01-01 00:00:00.000');
		expect(t.day.mapToDriverValue(year(9999))).toBe('9999-01-01');
	});

	it('refuses years CUBRID cannot store instead of sending +010000-…', () => {
		expect(() => t.at.mapToDriverValue(year(10000))).toThrow(
			/DATETIME column value \+010000-01-01T00:00:00.000Z is outside CUBRID's years 0001 to 9999/,
		);
		expect(() => t.day.mapToDriverValue(year(0))).toThrow(RangeError);
	});

	it('refuses TIMESTAMPs outside 1970-01-01 00:00:01 to 2038-01-19 03:14:07 UTC', () => {
		expect(t.stamp.mapToDriverValue(new Date(Date.UTC(1970, 0, 1, 0, 0, 1)))).toBe('1970-01-01 00:00:01');
		expect(t.stamp.mapToDriverValue(new Date(Date.UTC(2038, 0, 19, 3, 14, 7, 999)))).toBe('2038-01-19 03:14:07');
		expect(() => t.stamp.mapToDriverValue(new Date(Date.UTC(1970, 0, 1)))).toThrow(
			/TIMESTAMP column value 1970-01-01T00:00:00.000Z is outside CUBRID's range .*; use datetime\(\)/,
		);
		expect(() => t.stamp.mapToDriverValue(new Date(Date.UTC(2038, 0, 19, 3, 14, 8)))).toThrow(RangeError);
	});

	it('reads driver text only in the documented formats', () => {
		expect(t.at.mapFromDriverValue('2024-01-02 03:04:05')).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)));
		for (const text of ['2024-01-02T03:04:05Z', 'Jan 2 2024', '2024-01-02', '2024-13-40 00:00:00']) {
			expect(() => t.at.mapFromDriverValue(text)).toThrow(/DATETIME value from the driver must be a Date/);
		}
		expect(() => t.day.mapFromDriverValue('2024-01-02 00:00:00')).toThrow(/DATE value from the driver/);
	});

	it('reads FLOAT/DOUBLE driver text only in decimal notation', () => {
		expect(t.dbl.mapFromDriverValue('-1.5e3')).toBe(-1500);
		expect(t.single.mapFromDriverValue('.5')).toBe(0.5);
		for (const text of ['0x10', '0b1', 'Infinity', ' 1', '1.2.3']) {
			expect(() => t.dbl.mapFromDriverValue(text)).toThrow(/DOUBLE value from the driver must be a number/);
		}
	});
});

describe('numeric() declaration (item 6)', () => {
	it('validates precision and scale', () => {
		expect(numeric({ precision: 38, scale: 38 }).build(t).getSQLType()).toBe('NUMERIC(38,38)');
		expect(numeric({ precision: 1, scale: 0 }).build(t).getSQLType()).toBe('NUMERIC(1,0)');
		expect(() => numeric({ precision: 0 })).toThrow(/precision must be an integer from 1 to 38, got number 0/);
		expect(() => numeric({ precision: 39 })).toThrow(RangeError);
		expect(() => numeric({ precision: 10.5 })).toThrow(RangeError);
		expect(() => numeric({ precision: 10, scale: 11 })).toThrow(
			/scale must be an integer from 0 to precision \(10\), got number 11/,
		);
		expect(() => numeric({ precision: 10, scale: -1 })).toThrow(RangeError);
	});
});
