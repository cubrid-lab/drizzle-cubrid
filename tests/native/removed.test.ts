// The 0.x names the native root entry keeps only as placeholders (ADR 0010):
// using one throws a message naming the replacement.
import { describe, expect, it } from 'vitest';
import * as root from '../../src/native/index';
import { CubridRemovedExportError } from '../../src/native/index';

const REMOVED = {
	cubridSet: /set\(\{ element \}\)/,
	cubridMultiset: /multiset\(\{ element \}\)/,
	cubridSequence: /sequence\(\{ element \}\)/,
	customType: /no custom-type facility/,
	tinyint: /smallint\(\)/,
	mediumint: /integer\(\)/,
	serial: /bigint\(\{ mode: 'bigint' \}\)\.primaryKey\(\)\.autoIncrement\(\)/,
	year: /smallint\(\)/,
	real: /double\(\)/,
	text: /string\(\) or varchar/,
	tinytext: /string\(\) or varchar/,
	mediumtext: /string\(\) or varchar/,
	longtext: /string\(\) or varchar/,
	CubridPreparedQuery: /CubridPreparedSelect/,
} as const;

describe('removed 0.x exports of the root entry', () => {
	it.each(Object.entries(REMOVED))('%s throws a message naming its replacement', (name, replacement) => {
		const value = (root as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
		expect(typeof value).toBe('function');
		expect(value.name).toBe(name);
		let error: unknown;
		try {
			value('x');
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(CubridRemovedExportError);
		const removed = error as CubridRemovedExportError;
		expect(removed.name).toBe('CubridRemovedExportError');
		expect(removed.exportName).toBe(name);
		expect(removed.message).toMatch(replacement);
		expect(removed.message).toContain(`${name}`);
		expect(removed.message).toContain("'drizzle-cubrid/legacy'");
		expect(removed.message).toContain('removed in 1.0');
		expect(removed.message).toContain('docs/MIGRATING_FROM_0X.md');
	});

	it('throws when constructed or used with instanceof', () => {
		const Prepared = root.CubridPreparedQuery as unknown as new () => unknown;
		expect(() => new Prepared()).toThrow(CubridRemovedExportError);
		expect(() => ({}) instanceof Prepared).toThrow(/CubridPreparedQuery is a 0\.x class/);
	});

	it('leaves out the names of MySQL builders, which native code may not contain', () => {
		expect('mysqlEnum' in root).toBe(false);
	});
});
