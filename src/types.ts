import { customType } from 'drizzle-orm/mysql-core';
import { cubridMultiset, cubridSequence, cubridSet } from './columns/collections.js';

export const set = cubridSet;

export const multiset = cubridMultiset;

export const sequence = cubridSequence;

/**
 * A `MONETARY` column, read and written as a string. CUBRID stores MONETARY as
 * a double and cubrid-client returns it as a number, which is converted to its
 * shortest decimal string (`12.34` reads as `'12.34'`) to match the declared
 * type (#217).
 */
export const monetary = customType<{ data: string; driverData: string | number }>({
	dataType() {
		return 'MONETARY';
	},
	fromDriver(value) {
		return typeof value === 'number' ? String(value) : value;
	},
});
