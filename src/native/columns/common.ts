// Base classes of the native CUBRID column builders and columns, on Drizzle's
// database-neutral `ColumnBuilder` and `Column` (ADR 0007).

import { Column, type ColumnBaseConfig } from 'drizzle-orm/column';
import {
	ColumnBuilder,
	type ColumnBuilderBaseConfig,
	type ColumnBuilderRuntimeConfig,
	type ColumnDataType,
	type HasDefault,
	type HasGenerated,
	type IsAutoincrement,
	type MakeColumnConfig,
} from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import type { Table } from 'drizzle-orm/table';

/**
 * A builder's runtime config handed to its column. The builder's `data` type
 * is a type parameter the column cannot name, so the data slot is `any`.
 */
export type CubridBuilderRuntimeConfig<TRuntimeConfig extends object = object> = ColumnBuilderRuntimeConfig<
	// biome-ignore lint/suspicious/noExplicitAny: see above; only the data slot is loosened.
	any,
	TRuntimeConfig
>;

export abstract class CubridColumn<
	T extends ColumnBaseConfig<ColumnDataType, string> = ColumnBaseConfig<ColumnDataType, string>,
	TRuntimeConfig extends object = object,
> extends Column<T, TRuntimeConfig, { dialect: 'cubrid' }> {
	static override readonly [entityKind]: string = 'CubridColumn';

	/** Whether the column was declared with `.autoIncrement()` (CUBRID `AUTO_INCREMENT`). */
	readonly autoIncrement: boolean;

	constructor(table: Table, config: CubridBuilderRuntimeConfig<TRuntimeConfig>) {
		super(table, config);
		this.autoIncrement = 'autoIncrement' in config && config.autoIncrement === true;
	}
}

export abstract class CubridColumnBuilder<
	T extends ColumnBuilderBaseConfig<ColumnDataType, string> = ColumnBuilderBaseConfig<ColumnDataType, string>,
	TRuntimeConfig extends object = object,
> extends ColumnBuilder<T, TRuntimeConfig, { dialect: 'cubrid' }> {
	static override readonly [entityKind]: string = 'CubridColumnBuilder';

	/** Adds a column `UNIQUE` constraint, optionally named. */
	unique(name?: string): this {
		this.config.isUnique = true;
		this.config.uniqueName = name;
		return this;
	}

	/**
	 * Abstract in the neutral base. CUBRID generated-column semantics are not
	 * verified yet, so this fails instead of borrowing another dialect's.
	 */
	generatedAlwaysAs(): HasGenerated<this, { type: 'always' }> {
		throw new Error('drizzle-cubrid/native: generated columns are not supported yet');
	}

	/** Builds the column for `table`. Called by `cubridTable()`; dialect-owned, not part of Drizzle's neutral API. */
	abstract build(table: Table): CubridColumn<MakeColumnConfig<T, string>>;
}

/** Integer builders that accept CUBRID `AUTO_INCREMENT`. */
export abstract class CubridAutoIncrementBuilder<
	T extends ColumnBuilderBaseConfig<ColumnDataType, string>,
	TRuntimeConfig extends object = object,
> extends CubridColumnBuilder<T, TRuntimeConfig & { autoIncrement: boolean }> {
	static override readonly [entityKind]: string = 'CubridAutoIncrementBuilder';

	/** CUBRID `AUTO_INCREMENT`: the server generates the value, so it is optional on insert. */
	autoIncrement(): IsAutoincrement<HasDefault<this>> {
		this.config.autoIncrement = true;
		this.config.hasDefault = true;
		return this as IsAutoincrement<HasDefault<this>>;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: any builder config, as Drizzle's own `AnyColumnBuilder` helpers do.
export type AnyCubridColumnBuilder = CubridColumnBuilder<any, any>;

/** A short description of a value for error messages. */
export function describeValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	if (value instanceof Date) return 'a Date';
	if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
	if (typeof value === 'bigint') return `bigint ${value}n`;
	if (typeof value === 'string')
		return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
	return typeof value;
}

/** `name` and `config` of a builder called as `f()`, `f(config)`, `f(name)` or `f(name, config)`. */
export function nameAndConfig<TConfig extends object>(
	a: string | TConfig | undefined,
	b: TConfig | undefined,
): { name: string; config: TConfig | undefined } {
	return typeof a === 'string' ? { name: a, config: b } : { name: '', config: a };
}

/**
 * A finite number as a plain decimal string with no exponent: the shortest
 * round-trip digits of `String(value)`, with the decimal point moved by
 * string arithmetic (`1e-7` → `'0.0000001'`, `1e21` → `'1000000000000000000000'`).
 * CUBRID rejects exponent text for NUMERIC.
 */
export function plainDecimal(value: number, sqlType: string): string {
	if (!Number.isFinite(value)) {
		throw new RangeError(`${sqlType} value must be a finite number, got ${describeValue(value)}`);
	}
	const text = String(value);
	const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
	if (!match) return text;
	const [, sign, whole, fraction = '', exponent] = match;
	const digits = `${whole}${fraction}`;
	const point = whole.length + Number(exponent);
	if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
