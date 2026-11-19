// The 0.x column builders: Drizzle's MySQL builders, re-exported. Deprecated
// with the rest of drizzle-cubrid/legacy (ADR 0010).
// Each builder is a local const so that its @deprecated note reaches the
// bundled .d.ts (tsup drops JSDoc on re-export specifiers).

import { bigint as bigintBuilder } from 'drizzle-orm/mysql-core/columns/bigint';
import { boolean as booleanBuilder } from 'drizzle-orm/mysql-core/columns/boolean';
import { char as charBuilder } from 'drizzle-orm/mysql-core/columns/char';
import { customType as customTypeBuilder } from 'drizzle-orm/mysql-core/columns/custom';
import { decimal as decimalBuilder } from 'drizzle-orm/mysql-core/columns/decimal';
import { double as doubleBuilder } from 'drizzle-orm/mysql-core/columns/double';
import { float as floatBuilder } from 'drizzle-orm/mysql-core/columns/float';
import { int as intBuilder } from 'drizzle-orm/mysql-core/columns/int';
import { mediumint as mediumintBuilder } from 'drizzle-orm/mysql-core/columns/mediumint';
import { real as realBuilder } from 'drizzle-orm/mysql-core/columns/real';
import { serial as serialBuilder } from 'drizzle-orm/mysql-core/columns/serial';
import { smallint as smallintBuilder } from 'drizzle-orm/mysql-core/columns/smallint';
import {
	longtext as longtextBuilder,
	mediumtext as mediumtextBuilder,
	text as textBuilder,
	tinytext as tinytextBuilder,
} from 'drizzle-orm/mysql-core/columns/text';
import { tinyint as tinyintBuilder } from 'drizzle-orm/mysql-core/columns/tinyint';
import { varchar as varcharBuilder } from 'drizzle-orm/mysql-core/columns/varchar';
import { year as yearBuilder } from 'drizzle-orm/mysql-core/columns/year';

/** @deprecated Use `bigint({ mode })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const bigint = bigintBuilder;
/** @deprecated Use `boolean()` from `drizzle-cubrid` (SMALLINT 1/0). The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const boolean = booleanBuilder;
/** @deprecated Use `char({ length })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const char = charBuilder;
/** @deprecated `drizzle-cubrid` has no custom-type facility; see docs/MIGRATING_FROM_0X.md. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const customType = customTypeBuilder;
/** @deprecated Use `decimal()` / `numeric()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const decimal = decimalBuilder;
/** @deprecated Use `double()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const double = doubleBuilder;
/** @deprecated Use `float()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const float = floatBuilder;
/** @deprecated Use `integer()` / `int()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const int = intBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `integer()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const mediumint = mediumintBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `double()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const real = realBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `bigint({ mode: 'bigint' }).primaryKey().autoIncrement()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const serial = serialBuilder;
/** @deprecated Use `smallint()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const smallint = smallintBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `string()` or `varchar({ length })`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const longtext = longtextBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `string()` or `varchar({ length })`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const mediumtext = mediumtextBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `string()` or `varchar({ length })`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const text = textBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `string()` or `varchar({ length })`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const tinytext = tinytextBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `smallint()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const tinyint = tinyintBuilder;
/** @deprecated Use `varchar({ length })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const varchar = varcharBuilder;
/** @deprecated Not in `drizzle-cubrid`: use `smallint()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
export const year = yearBuilder;
// A re-export, not a local const: a local declaration would name this MySQL
// builder more often in the bundles than the dialect-boundary baseline allows
// (ADR 0010). Its note is therefore not in the bundled .d.ts.
export {
	/** @deprecated CUBRID ENUM has no builder in `drizzle-cubrid`: use `varchar({ length }).$type<'a' | 'b'>()`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0. */
	mysqlEnum,
} from 'drizzle-orm/mysql-core/columns/enum';
// Declared there, each with its @deprecated note.
export { cubridMultiset, cubridSequence, cubridSet } from './columns/collections.js';
export { date, datetime, time, timestamp } from './columns/temporal.js';

// Drizzle's MySQL binary() and varbinary() send and read strings, which
// CUBRID's BIT / BIT VARYING columns do not round-trip (#216). Fixing them
// here would need new MySQL column classes in the 0.x code, so they are
// refused instead; the native root entry has Buffer-based builders.
function refusedBinary(builder: string): never {
	throw new Error(
		`${builder}() is not supported by drizzle-cubrid (0.x): Drizzle's MySQL ${builder}() writes strings that CUBRID BIT columns store as hex digits or refuse, and reads them back garbled (#216). Use ${builder}() from drizzle-cubrid (the native API), which reads and writes Buffer values`,
	);
}

/**
 * @deprecated Always throws (#216): use `binary()` from `drizzle-cubrid`,
 * which maps to `BIT(n*8)` and reads and writes `Buffer` values.
 */
export function binary(..._args: unknown[]): never {
	return refusedBinary('binary');
}

/**
 * @deprecated Always throws (#216): use `varbinary()` from `drizzle-cubrid`,
 * which maps to `BIT VARYING(n*8)` and reads and writes `Buffer` values.
 */
export function varbinary(..._args: unknown[]): never {
	return refusedBinary('varbinary');
}
