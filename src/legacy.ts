// drizzle-cubrid/legacy: the 0.x API, built on Drizzle's MySQL classes.
//
// Deprecated in 0.3 and removed in 1.0 (ADR 0010). Until 0.3 this was the
// root entry, drizzle-cubrid; the root is now the CUBRID-native dialect
// (src/native/index.ts). Loading this entry emits one DeprecationWarning per
// process, code DRIZZLE_CUBRID_LEGACY (src/deprecation.ts). Its MySQL-derived
// findings are pinned in scripts/dialect-boundary-baseline.json and may only
// shrink. See docs/MIGRATING_FROM_0X.md for the import-by-import migration.

import * as orm from 'drizzle-orm';
import { emitLegacyDeprecationWarning } from './deprecation.js';

emitLegacyDeprecationWarning();

// Drizzle's operators, as drizzle-orm exports them. Local consts so that the
// @deprecated note reaches the bundled .d.ts; they are the same objects.
/** @deprecated Import `and` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const and = orm.and;
/** @deprecated Import `asc` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const asc = orm.asc;
/** @deprecated Import `avg` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const avg = orm.avg;
/** @deprecated Import `count` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const count = orm.count;
/** @deprecated Import `desc` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const desc = orm.desc;
/** @deprecated Import `eq` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const eq = orm.eq;
/** @deprecated Import `gt` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const gt = orm.gt;
/** @deprecated Import `gte` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const gte = orm.gte;
/** @deprecated Import `lt` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const lt = orm.lt;
/** @deprecated Import `lte` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const lte = orm.lte;
/** @deprecated Import `max` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const max = orm.max;
/** @deprecated Import `min` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const min = orm.min;
/** @deprecated Import `ne` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const ne = orm.ne;
/** @deprecated Import `not` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const not = orm.not;
/** @deprecated Import `or` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const or = orm.or;
/** @deprecated Import `placeholder` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const placeholder = orm.placeholder;
/** @deprecated Import `sql` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const sql = orm.sql;
/** @deprecated Import `sum` from `drizzle-cubrid` or `drizzle-orm`. drizzle-cubrid/legacy is removed in 1.0. */
export const sum = orm.sum;

// Everything below carries its @deprecated note at its declaration.
export {
	type CubridCollectionElement,
	type CubridMultisetColumnBuilder,
	type CubridSequenceColumnBuilder,
	type CubridSetColumnBuilder,
	cubridMultiset,
	cubridSequence,
	cubridSet,
} from './columns/collections.js';
export * from './columns.js';
export { CubridDatabase, drizzle } from './driver.js';
export type { CubridBinding, CubridExecuteResult, CubridQueryable, CubridRawQueryResult } from './session.js';
export { CubridPreparedQuery, CubridSession, CubridTransaction } from './session.js';
export { cubridTable } from './table.js';
export { monetary, multiset, sequence, set } from './types.js';
