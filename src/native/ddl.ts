// `CREATE TABLE` and `CREATE INDEX` text for native tables. `createTableSql`
// and `createIndexSql` are internal (tests use them to prove that every
// declared column type, constraint and index is valid CUBRID DDL);
// `generateInitialMigration` is exported from `drizzle-cubrid/native` and
// writes the first migration of a schema for drizzle-cubrid/native/migrator
// (#163, ADR 0009). There is no schema diff: ALTER migrations are written by
// hand.
//
// Foreign keys are table constraints inside `CREATE TABLE`, so the migration
// creates referenced tables first; a cycle of foreign keys between tables is
// refused rather than split into `ALTER TABLE … ADD CONSTRAINT`, which keeps
// each table one statement and the order fully determined by the schema.
//
// Identifiers are double-quoted with embedded quotes doubled, as in queries
// (see quoteIdentifier in dialect.ts).

import { is } from 'drizzle-orm/entity';
import { SQL } from 'drizzle-orm/sql/sql';
import { getTableName, Table } from 'drizzle-orm/table';
import type { CubridColumn } from './columns/common.js';
import { quoteIdentifier } from './dialect.js';
import type { CubridForeignKey } from './foreign-keys.js';
import { CubridTable, type CubridTableConfigInfo, getTableConfig } from './table.js';

/** A SQL literal of a default value after the column's codec. */
function literal(value: unknown, column: CubridColumn): string {
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
	// binary()/varbinary(): bytes already padded and length-checked by the codec.
	if (value instanceof Uint8Array) {
		return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
	}
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
	for (const foreignKey of config.foreignKeys) lines.push(foreignKeySql(config, foreignKey));
	return `CREATE TABLE ${quoteIdentifier(getTableName(table))} (\n\t${lines.join(',\n\t')}\n)`;
}

/** The primary key columns of a table config, from `.primaryKey()` or `primaryKey()`. */
function primaryKeyColumns(config: CubridTableConfigInfo): readonly CubridColumn[] {
	return config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
}

function foreignKeySql(config: CubridTableConfigInfo, foreignKey: CubridForeignKey): string {
	const { columns, foreignColumns } = foreignKey.getReference();
	const label = `Foreign key${foreignKey.name ? ` ${foreignKey.name}` : ''} on table ${config.name}`;
	const foreignTable = foreignColumns[0]!.table as CubridTable;
	const foreignConfig = foreignTable === columns[0]!.table ? config : getTableConfig(foreignTable);
	// CUBRID 11.4 accepts a foreign key only onto the whole primary key of the
	// referenced table (-920 for a UNIQUE or partial key), in any column order.
	const key = primaryKeyColumns(foreignConfig);
	if (key.length !== foreignColumns.length || !foreignColumns.every((column) => key.includes(column))) {
		throw new Error(
			`${label} must reference the primary key of table ${foreignConfig.name} (${key.map((c) => c.name).join(', ') || 'none'}): CUBRID refuses a foreign key onto other columns`,
		);
	}
	// ON DELETE/UPDATE SET NULL on a NOT NULL column is refused by CUBRID (-998).
	const setNull = foreignKey.onDeleteAction === 'set null' || foreignKey.onUpdateAction === 'set null';
	const notNull = columns.find((column) => column.notNull);
	if (setNull && notNull) {
		throw new Error(`${label} sets column ${notNull.name} to NULL, but the column is NOT NULL`);
	}
	const parts = [
		foreignKey.name ? `CONSTRAINT ${quoteIdentifier(foreignKey.name)} ` : '',
		`FOREIGN KEY (${columnList(columns)}) REFERENCES ${quoteIdentifier(foreignConfig.name)} (${columnList(foreignColumns)})`,
	];
	if (foreignKey.onDeleteAction) parts.push(` ON DELETE ${foreignKey.onDeleteAction.toUpperCase()}`);
	if (foreignKey.onUpdateAction) parts.push(` ON UPDATE ${foreignKey.onUpdateAction.toUpperCase()}`);
	return parts.join('');
}

/** `CREATE [UNIQUE] INDEX "name" ON "table" (…)` for each index of a native table, in declaration order. */
export function createIndexSql(table: CubridTable): string[] {
	const config = getTableConfig(table);
	return config.indexes.map(
		(index) =>
			`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(config.name)} (${columnList(index.columns)})`,
	);
}

/**
 * `tables` in the given order, except that a referenced table is moved before
 * the first table that references it (a depth-first walk in schema order,
 * following foreign keys in declaration order). A referenced table missing from
 * `tables` and a cycle of foreign keys are refused.
 */
function referencedFirst(tables: readonly CubridTable[]): CubridTable[] {
	const ordered: CubridTable[] = [];
	const state = new Map<CubridTable, 'visiting' | 'done'>();
	const visit = (table: CubridTable, path: CubridTable[]): void => {
		const current = state.get(table);
		if (current === 'done') return;
		if (current === 'visiting') {
			const cycle = [...path.slice(path.indexOf(table)), table].map((t) => getTableName(t));
			throw new Error(
				`Foreign keys form a cycle between tables ${cycle.join(' -> ')}; declare one of them in a later migration with ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`,
			);
		}
		state.set(table, 'visiting');
		for (const foreignKey of getTableConfig(table).foreignKeys) {
			const referenced = foreignKey.getReference().foreignColumns[0]!.table as CubridTable;
			if (referenced === table) continue;
			if (!tables.includes(referenced)) {
				throw new Error(
					`Table ${getTableName(table)} has a foreign key to table ${getTableName(referenced)}, which is not in the schema`,
				);
			}
			visit(referenced, [...path, table]);
		}
		state.set(table, 'done');
		ordered.push(table);
	};
	for (const table of tables) visit(table, []);
	return ordered;
}

/**
 * The first migration of a schema: `CREATE TABLE` for every native table in
 * `schema` (an object of tables and relations, as given to `drizzle()`, or an
 * array of tables), each followed by its `CREATE INDEX` statements, as CUBRID
 * SQL for a `0001_<name>.sql` file of drizzle-cubrid/native/migrator. Tables
 * come in the given order, except that a referenced table is moved before
 * the first table that references it. Relations and other values are
 * skipped; a table that is not a drizzle-cubrid/native table, a foreign key
 * to a table outside the schema and a cycle of foreign keys between tables
 * are refused. It does not compare the schema with a database or an earlier
 * schema: later changes are written by hand as ALTER migrations.
 */
export function generateInitialMigration(schema: Record<string, unknown> | readonly unknown[]): string {
	const values = Array.isArray(schema) ? schema : Object.values(schema as Record<string, unknown>);
	const tables: CubridTable[] = [];
	const names = new Set<string>();
	for (const value of values) {
		if (!is(value, Table)) continue;
		if (!(value instanceof CubridTable)) {
			throw new TypeError(`Table ${getTableName(value)} is not a drizzle-cubrid/native table`);
		}
		// CUBRID compares table names without case, quoted or not.
		const key = getTableName(value).toLowerCase();
		if (names.has(key)) throw new Error(`Table ${getTableName(value)} appears more than once in the schema`);
		names.add(key);
		tables.push(value);
	}
	if (tables.length === 0)
		throw new Error('generateInitialMigration() found no drizzle-cubrid/native table in the schema');
	const header = '-- Initial schema, generated by generateInitialMigration() from drizzle-cubrid/native.\n';
	const statements = referencedFirst(tables).map((table) =>
		[createTableSql(table), ...createIndexSql(table)].map((statement) => `${statement};\n`).join(''),
	);
	return `${header}\n${statements.join('\n')}`;
}
