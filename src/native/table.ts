// `cubridTable()` on Drizzle's database-neutral `Table` (ADR 0007).

import type { ColumnBuilderBaseConfig, ColumnDataType, MakeColumnConfig } from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import { getTableName, Table, type TableConfig } from 'drizzle-orm/table';
import { type Assume, getTableColumns } from 'drizzle-orm/utils';
import type { AnyCubridColumnBuilder, CubridColumn } from './columns/common.js';
import { setColumnBuilderName, setTableColumns } from './internal.js';

// biome-ignore lint/suspicious/noExplicitAny: any column config, as Drizzle's own `TableConfig` default does.
export type CubridTableConfig = TableConfig<CubridColumn<any>>;

export class CubridTable<T extends CubridTableConfig = CubridTableConfig> extends Table<T> {
	static override readonly [entityKind]: string = 'CubridTable';
}

type ExtraConfigFn = (self: Record<string, CubridColumn>) => readonly CubridTableExtraConfigValue[];

/** The `extraConfig` callback given to `cubridTable()`, called lazily by {@link getTableConfig}. */
const extraConfigs = new WeakMap<CubridTable, ExtraConfigFn>();

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

export type CubridTableExtraConfigValue = CubridPrimaryKey | CubridUniqueConstraint;

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

/**
 * A CUBRID table. Each key of `columns` is the property name; a builder created
 * without a name (`integer()`) takes its key as the column name.
 *
 * `extraConfig` returns table constraints: {@link primaryKey} and {@link unique}.
 * Indexes and foreign keys are not supported yet.
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
	for (const [key, builder] of Object.entries(columns)) {
		setColumnBuilderName(builder, key);
		built[key] = builder.build(table);
	}
	setTableColumns(table, built);
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
}

/** The columns and table constraints of a native table. */
export function getTableConfig(table: CubridTable): CubridTableConfigInfo {
	const columns = Object.values(getColumns(table));
	const primaryKeys: CubridPrimaryKey[] = [];
	const uniqueConstraints: CubridUniqueConstraint[] = [];
	const extra = extraConfigs.get(table)?.(getColumns(table)) ?? [];
	for (const value of extra) {
		for (const column of value.columns) {
			if (column.table !== table) {
				throw new Error(`Constraint on table ${getTableName(table)} names column ${column.name} of another table`);
			}
		}
		if (value instanceof CubridPrimaryKey) primaryKeys.push(value);
		else if (value instanceof CubridUniqueConstraint) uniqueConstraints.push(value);
		else throw new TypeError(`Unsupported table extra config value on table ${getTableName(table)}`);
	}
	return { name: getTableName(table), columns, primaryKeys, uniqueConstraints };
}

function getColumns(table: CubridTable): Record<string, CubridColumn> {
	return getTableColumns(table);
}
