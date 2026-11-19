import { mysqlTable } from 'drizzle-orm/mysql-core';

/** @deprecated Use `cubridTable()` from `drizzle-cubrid`. The 0.x API (drizzle-cubrid/legacy) is removed in 1.0; see docs/MIGRATING_FROM_0X.md. */
export const cubridTable = mysqlTable;
