// Re-export MySQL-compatible column types for CUBRID.
// Using explicit named re-exports to ensure bundlers (tsup/esbuild) include them
// in the ESM output's static export list.

export { bigint } from 'drizzle-orm/mysql-core/columns/bigint';
export { boolean } from 'drizzle-orm/mysql-core/columns/boolean';
export { char } from 'drizzle-orm/mysql-core/columns/char';
export { customType } from 'drizzle-orm/mysql-core/columns/custom';
export { decimal } from 'drizzle-orm/mysql-core/columns/decimal';
export { double } from 'drizzle-orm/mysql-core/columns/double';
export { mysqlEnum } from 'drizzle-orm/mysql-core/columns/enum';
export { float } from 'drizzle-orm/mysql-core/columns/float';
export { int } from 'drizzle-orm/mysql-core/columns/int';
export { mediumint } from 'drizzle-orm/mysql-core/columns/mediumint';
export { real } from 'drizzle-orm/mysql-core/columns/real';
export { serial } from 'drizzle-orm/mysql-core/columns/serial';
export { smallint } from 'drizzle-orm/mysql-core/columns/smallint';
export { longtext, mediumtext, text, tinytext } from 'drizzle-orm/mysql-core/columns/text';
export { tinyint } from 'drizzle-orm/mysql-core/columns/tinyint';
export { varchar } from 'drizzle-orm/mysql-core/columns/varchar';
export { year } from 'drizzle-orm/mysql-core/columns/year';
export { cubridMultiset, cubridSequence, cubridSet } from './columns/collections.js';

// Drizzle's date and time builders, decoding cubrid-client's Date values.
export { date, datetime, time, timestamp } from './columns/temporal.js';

// Drizzle's MySQL binary() and varbinary() send and read strings, which
// CUBRID's BIT / BIT VARYING columns do not round-trip (#216). Fixing them
// here would need new MySQL column classes in the 0.x code, so they are
// refused instead; drizzle-cubrid/native has Buffer-based builders.
function refusedBinary(builder: string): never {
	throw new Error(
		`${builder}() is not supported by drizzle-cubrid (0.x): Drizzle's MySQL ${builder}() writes strings that CUBRID BIT columns store as hex digits or refuse, and reads them back garbled (#216). Use ${builder}() from drizzle-cubrid/native, which reads and writes Buffer values`,
	);
}

/**
 * @deprecated Always throws (#216): use `binary()` from `drizzle-cubrid/native`,
 * which maps to `BIT(n*8)` and reads and writes `Buffer` values.
 */
export function binary(..._args: unknown[]): never {
	return refusedBinary('binary');
}

/**
 * @deprecated Always throws (#216): use `varbinary()` from `drizzle-cubrid/native`,
 * which maps to `BIT VARYING(n*8)` and reads and writes `Buffer` values.
 */
export function varbinary(..._args: unknown[]): never {
	return refusedBinary('varbinary');
}
