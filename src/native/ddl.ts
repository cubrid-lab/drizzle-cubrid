// `CREATE TABLE` text for a native table, used by tests to prove that every
// declared column type is valid CUBRID DDL. It is internal and not exported
// from `drizzle-cubrid/native`: schema migrations are #163.
//
// Identifiers are double-quoted with embedded quotes doubled, as in queries
// (see quoteIdentifier in dialect.ts).

import { is } from 'drizzle-orm/entity';
import { SQL } from 'drizzle-orm/sql/sql';
import { getTableName } from 'drizzle-orm/table';
import type { CubridColumn } from './columns/common.js';
import { quoteIdentifier } from './dialect.js';
import { type CubridTable, getTableConfig } from './table.js';

/** A SQL literal of a default value after the column's codec. */
function literal(value: unknown, column: CubridColumn): string {
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
	throw new Error(`DEFAULT for column ${column.name} cannot be rendered: ${typeof value}`);
}

function columnSql(column: CubridColumn): string {
	const parts = [quoteIdentifier(column.name), column.getSQLType()];
	if (column.autoIncrement) parts.push('AUTO_INCREMENT');
	if (column.default !== undefined) {
		if (is(column.default, SQL)) {
			throw new Error(`DEFAULT sql\`…\` on column ${column.name} needs the native SQL compiler (#158)`);
		}
		parts.push(`DEFAULT ${literal(column.mapToDriverValue(column.default), column)}`);
	}
	if (column.notNull) parts.push('NOT NULL');
	if (column.primary) parts.push('PRIMARY KEY');
	if (column.isUnique) {
		parts.push(column.uniqueName ? `CONSTRAINT ${quoteIdentifier(column.uniqueName)} UNIQUE` : 'UNIQUE');
	}
	return parts.join(' ');
}

function columnList(columns: readonly CubridColumn[]): string {
	return columns.map((column) => quoteIdentifier(column.name)).join(', ');
}

/** `CREATE TABLE "name" (…)` for a native table. */
export function createTableSql(table: CubridTable): string {
	const config = getTableConfig(table);
	const primaryKeyCount = config.primaryKeys.length + config.columns.filter((column) => column.primary).length;
	if (primaryKeyCount > 1) {
		throw new Error(`Table ${getTableName(table)} declares more than one primary key; use primaryKey({ columns })`);
	}
	const lines = config.columns.map(columnSql);
	for (const pk of config.primaryKeys) {
		const name = pk.name ? `CONSTRAINT ${quoteIdentifier(pk.name)} ` : '';
		lines.push(`${name}PRIMARY KEY (${columnList(pk.columns)})`);
	}
	for (const constraint of config.uniqueConstraints) {
		const name = constraint.name ? `CONSTRAINT ${quoteIdentifier(constraint.name)} ` : '';
		lines.push(`${name}UNIQUE (${columnList(constraint.columns)})`);
	}
	return `CREATE TABLE ${quoteIdentifier(getTableName(table))} (\n\t${lines.join(',\n\t')}\n)`;
}
