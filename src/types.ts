import { customType } from 'drizzle-orm/mysql-core';
import { cubridMultiset, cubridSequence, cubridSet } from './columns/collections.js';

/** @deprecated Use `set({ element })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0; see docs/MIGRATING_FROM_0X.md. */
export const set = cubridSet;

/** @deprecated Use `multiset({ element })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0; see docs/MIGRATING_FROM_0X.md. */
export const multiset = cubridMultiset;

/** @deprecated Use `sequence({ element })` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0; see docs/MIGRATING_FROM_0X.md. */
export const sequence = cubridSequence;

/**
 * A `MONETARY` column, read and written as a string. CUBRID stores MONETARY as
 * a double and cubrid-client returns it as a number, which is converted to its
 * shortest decimal string (`12.34` reads as `'12.34'`) to match the declared
 * type (#217).
 * @deprecated Use `monetary()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0; see docs/MIGRATING_FROM_0X.md.
 */
export const monetary = customType<{ data: string; driverData: string | number }>({
	dataType() {
		return 'MONETARY';
	},
	fromDriver(value) {
		return typeof value === 'number' ? String(value) : value;
	},
});
