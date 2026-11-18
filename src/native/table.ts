// `cubridTable()` on Drizzle's database-neutral `Table` (ADR 0007).

import { Column } from 'drizzle-orm/column';
import type { ColumnBuilderBaseConfig, ColumnDataType, MakeColumnConfig } from 'drizzle-orm/column-builder';
import { entityKind, is } from 'drizzle-orm/entity';
import { getTableName, Table, type TableConfig } from 'drizzle-orm/table';
import { type Assume, getTableColumns } from 'drizzle-orm/utils';
import type { AnyCubridColumnBuilder, CubridColumn } from './columns/common.js';
import { CubridForeignKey } from './foreign-keys.js';
import { setColumnBuilderName, setTableColumns } from './internal.js';

// biome-ignore lint/suspicious/noExplicitAny: any column config, as Drizzle's own `TableConfig` default does.
export type CubridTableConfig = TableConfig<CubridColumn<any>>;

export class CubridTable<T extends CubridTableConfig = CubridTableConfig> extends Table<T> {
	static override readonly [entityKind]: string = 'CubridTable';
}

type ExtraConfigFn = (self: Record<string, CubridColumn>) => readonly CubridTableExtraConfigValue[];

/** The `extraConfig` callback given to `cubridTable()`, called lazily by {@link getTableConfig}. */
const extraConfigs = new WeakMap<CubridTable, ExtraConfigFn>();

/** The foreign keys declared with a column's `.references()`, in column order. */
const columnForeignKeys = new WeakMap<CubridTable, readonly CubridForeignKey[]>();

/** The column `T` of key `K`: the builder's name, or the key when the builder has none. */
type BuildCubridColumn<TTableName extends string, K, TBuilder extends AnyCubridColumnBuilder> = CubridColumn<
	MakeColumnConfig<
		Assume<
			Omit<TBuilder['_'], 'name'> & {
				name: TBuilder['_']['name'] extends '' ? Assume<K, string> : TBuilder['_']['name'];
			},
			ColumnBuilderBaseConfig<ColumnDataType, string>
		>,
		TTableName
	>
>;

export type BuildCubridColumns<TTableName extends string, TBuilders extends Record<string, AnyCubridColumnBuilder>> = {
	[K in keyof TBuilders]: BuildCubridColumn<TTableName, K, TBuilders[K]>;
} & {};

export type CubridTableWithColumns<T extends CubridTableConfig> = CubridTable<T> & {
	[K in keyof T['columns']]: T['columns'][K];
};

/** A composite primary key, declared in `cubridTable()`'s third argument. */
export class CubridPrimaryKey {
	static readonly [entityKind]: string = 'CubridPrimaryKey';

	constructor(
		readonly columns: readonly CubridColumn[],
		readonly name: string | undefined,
	) {}
}

/** A table `UNIQUE` constraint, declared in `cubridTable()`'s third argument. */
export class CubridUniqueConstraint {
	static readonly [entityKind]: string = 'CubridUniqueConstraint';

	constructor(
		readonly columns: readonly CubridColumn[],
		readonly name: string | undefined,
	) {}
}

/**
 * A `CREATE [UNIQUE] INDEX` on plain columns, declared in `cubridTable()`'s
 * third argument. Descending, function-based and filtered indexes are not
 * built by drizzle-cubrid/native: write them in a migration by hand.
 */
export class CubridIndex {
	static readonly [entityKind]: string = 'CubridIndex';

	constructor(
		readonly name: string,
		readonly columns: readonly CubridColumn[],
		readonly unique: boolean,
	) {}
}

export type CubridTableExtraConfigValue = CubridPrimaryKey | CubridUniqueConstraint | CubridIndex | CubridForeignKey;

/** `PRIMARY KEY (a, b)`; use the column's `.primaryKey()` for a one-column key. */
export function primaryKey(config: {
	name?: string;
	columns: readonly [CubridColumn, ...CubridColumn[]];
}): CubridPrimaryKey {
	return new CubridPrimaryKey([...config.columns], config.name);
}

/** `UNIQUE (a, b)`: `unique('name').on(t.a, t.b)` or `unique().on(t.a)`. */
export function unique(name?: string): { on(...columns: [CubridColumn, ...CubridColumn[]]): CubridUniqueConstraint } {
	return { on: (...columns) => new CubridUniqueConstraint(columns, name) };
}

/** What `index(name)` and `uniqueIndex(name)` return: `.on()` takes plain columns only. */
export interface CubridIndexBuilderOn {
	on(...columns: [CubridColumn, ...CubridColumn[]]): CubridIndex;
}

function indexBuilder(name: string, isUnique: boolean): CubridIndexBuilderOn {
	if (typeof name !== 'string' || name === '') throw new TypeError('An index needs a name: index(name).on(...)');
	return {
		on: (...columns) => {
			if (columns.length === 0) throw new TypeError(`Index ${name} needs at least one column`);
			for (const column of columns) {
				if (!is(column, Column)) {
					throw new TypeError(
						`Index ${name} takes table columns only; write descending, function-based or filtered indexes in a migration by hand`,
					);
				}
			}
			return new CubridIndex(name, columns, isUnique);
		},
	};
}

/** `CREATE INDEX "name" ON "table" ("a", "b")`: `index('name').on(t.a, t.b)`. */
export function index(name: string): CubridIndexBuilderOn {
	return indexBuilder(name, false);
}

/** `CREATE UNIQUE INDEX "name" ON "table" ("a", "b")`: `uniqueIndex('name').on(t.a, t.b)`. */
export function uniqueIndex(name: string): CubridIndexBuilderOn {
	return indexBuilder(name, true);
}

/**
 * A CUBRID table. Each key of `columns` is the property name; a builder created
 * without a name (`integer()`) takes its key as the column name.
 *
 * `extraConfig` returns table constraints and indexes: {@link primaryKey},
 * {@link unique}, {@link foreignKey}, {@link index} and {@link uniqueIndex}.
 */
export function cubridTable<TName extends string, TColumns extends Record<string, AnyCubridColumnBuilder>>(
	name: TName,
	columns: TColumns,
	extraConfig?: (self: BuildCubridColumns<TName, TColumns>) => readonly CubridTableExtraConfigValue[],
): CubridTableWithColumns<{
	name: TName;
	schema: undefined;
	columns: BuildCubridColumns<TName, TColumns>;
	dialect: 'cubrid';
}> {
	const table = new CubridTable(name, undefined, name);
	const built: Record<string, CubridColumn> = {};
	const foreignKeys: CubridForeignKey[] = [];
	for (const [key, builder] of Object.entries(columns)) {
		setColumnBuilderName(builder, key);
		const column = builder.build(table);
		built[key] = column;
		foreignKeys.push(...builder.buildForeignKeys(column));
	}
	setTableColumns(table, built);
	if (foreignKeys.length > 0) columnForeignKeys.set(table, foreignKeys);
	if (extraConfig) extraConfigs.set(table, extraConfig as ExtraConfigFn);
	return Object.assign(table, built) as CubridTableWithColumns<{
		name: TName;
		schema: undefined;
		columns: BuildCubridColumns<TName, TColumns>;
		dialect: 'cubrid';
	}>;
}

export interface CubridTableConfigInfo {
	name: string;
	columns: CubridColumn[];
	primaryKeys: CubridPrimaryKey[];
	uniqueConstraints: CubridUniqueConstraint[];
	/** Column `.references()` first, in column order, then `foreignKey()`s in declaration order. */
	foreignKeys: CubridForeignKey[];
	indexes: CubridIndex[];
}

/** The columns, table constraints and indexes of a native table. */
export function getTableConfig(table: CubridTable): CubridTableConfigInfo {
	const tableName = getTableName(table);
	const columns = Object.values(getColumns(table));
	const primaryKeys: CubridPrimaryKey[] = [];
	const uniqueConstraints: CubridUniqueConstraint[] = [];
	const foreignKeys: CubridForeignKey[] = [...(columnForeignKeys.get(table) ?? [])];
	const indexes: CubridIndex[] = [];
	const extra = extraConfigs.get(table)?.(getColumns(table)) ?? [];
	for (const value of extra) {
		if (value instanceof CubridPrimaryKey) primaryKeys.push(value);
		else if (value instanceof CubridUniqueConstraint) uniqueConstraints.push(value);
		else if (value instanceof CubridIndex) indexes.push(value);
		else if (value instanceof CubridForeignKey) foreignKeys.push(value);
		else throw new TypeError(`Unsupported table extra config value on table ${tableName}`);
	}
	const owned = [...primaryKeys, ...uniqueConstraints, ...indexes].map((value) => value.columns);
	for (const foreignKey of foreignKeys) {
		const { columns: keyColumns, foreignColumns } = foreignKey.getReference();
		owned.push(keyColumns);
		checkForeignKey(tableName, foreignKey.name, keyColumns, foreignColumns);
	}
	for (const list of owned) {
		for (const column of list) {
			if (column.table !== table) {
				throw new Error(`Constraint on table ${tableName} names column ${column.name} of another table`);
			}
		}
	}
	// CUBRID keeps index and constraint names in one namespace per table and
	// compares them without case (-272).
	const names = new Set<string>();
	const declared = [...primaryKeys, ...uniqueConstraints, ...foreignKeys, ...indexes].map((value) => value.name);
	for (const name of [...columns.map((column) => column.uniqueName), ...declared]) {
		if (name === undefined) continue;
		const key = name.toLowerCase();
		if (names.has(key)) throw new Error(`Table ${tableName} declares the index or constraint name ${name} twice`);
		names.add(key);
	}
	return { name: tableName, columns, primaryKeys, uniqueConstraints, foreignKeys, indexes };
}

function checkForeignKey(
	tableName: string,
	name: string | undefined,
	columns: readonly CubridColumn[],
	foreignColumns: readonly CubridColumn[],
): void {
	const label = `Foreign key${name ? ` ${name}` : ''} on table ${tableName}`;
	for (const column of [...columns, ...foreignColumns]) {
		if (!is(column, Column)) throw new TypeError(`${label} takes table columns only`);
	}
	if (columns.length === 0 || columns.length !== foreignColumns.length) {
		throw new Error(`${label} needs as many columns as foreign columns, and at least one`);
	}
	const foreignTable = foreignColumns[0]!.table;
	if (!(foreignTable instanceof CubridTable)) {
		throw new TypeError(`${label} references a table that is not a drizzle-cubrid/native table`);
	}
	if (foreignColumns.some((column) => column.table !== foreignTable)) {
		throw new Error(`${label} references columns of more than one table`);
	}
}

function getColumns(table: CubridTable): Record<string, CubridColumn> {
	return getTableColumns(table);
}
