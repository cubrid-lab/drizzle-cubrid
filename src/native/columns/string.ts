// CHAR(n), VARCHAR(n) and STRING.

import type { ColumnBaseConfig } from 'drizzle-orm/column';
import type { ColumnBuilderBaseConfig, MakeColumnConfig } from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import type { Table } from 'drizzle-orm/table';
import {
	type AnyCubridColumnBuilder,
	type CubridBuilderRuntimeConfig,
	CubridColumn,
	CubridColumnBuilder,
	describeValue,
	nameAndConfig,
} from './common.js';

function toText(value: unknown, sqlType: string): string {
	if (typeof value === 'string') return value;
	throw new TypeError(`${sqlType} value from the driver must be a string, got ${describeValue(value)}`);
}

function checkLength(length: unknown, builder: string): number {
	if (typeof length !== 'number' || !Number.isInteger(length) || length < 1) {
		throw new TypeError(`${builder}(): length must be a positive integer, got ${describeValue(length)}`);
	}
	return length;
}

interface LengthConfig {
	length: number;
}

/** `{ length }` but not a string, which also has a numeric `length`. */
type LengthOnlyConfig = LengthConfig & object;

type StringBuilderConfig<TName extends string, TColumnType extends string> = {
	name: TName;
	dataType: 'string';
	columnType: TColumnType;
	data: string;
	driverParam: string;
	enumValues: undefined;
};

// ---------- CHAR(n) ----------

export class CubridCharBuilder<T extends ColumnBuilderBaseConfig<'string', 'CubridChar'>> extends CubridColumnBuilder<
	T,
	LengthConfig
> {
	static override readonly [entityKind]: string = 'CubridCharBuilder';

	constructor(name: T['name'], length: number) {
		super(name, 'string', 'CubridChar');
		this.config.length = length;
	}

	build(table: Table) {
		return new CubridChar<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig<LengthConfig>);
	}
}

/**
 * `CHAR(n)`: fixed length. CUBRID pads stored values with spaces to `n`
 * characters and returns them padded (`'ab'` in `CHAR(5)` reads `'ab   '`);
 * the value is returned as the server sends it.
 */
export class CubridChar<T extends ColumnBaseConfig<'string', 'CubridChar'>> extends CubridColumn<T, LengthConfig> {
	static override readonly [entityKind]: string = 'CubridChar';

	readonly length = this.config.length;

	getSQLType(): string {
		return `CHAR(${this.config.length})`;
	}

	override mapFromDriverValue(value: unknown): string {
		return toText(value, 'CHAR');
	}
}

/** A `CHAR(n)` column; `length` is required. Values read back space-padded to `n`. */
export function char(config: LengthOnlyConfig): CubridCharBuilder<StringBuilderConfig<'', 'CubridChar'>>;
export function char<TName extends string>(
	name: TName,
	config: LengthConfig,
): CubridCharBuilder<StringBuilderConfig<TName, 'CubridChar'>>;
export function char(a: string | LengthConfig, b?: LengthConfig): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(a, b);
	return new CubridCharBuilder(name, checkLength(config?.length, 'char'));
}

// ---------- VARCHAR(n) ----------

export class CubridVarcharBuilder<
	T extends ColumnBuilderBaseConfig<'string', 'CubridVarchar'>,
> extends CubridColumnBuilder<T, LengthConfig> {
	static override readonly [entityKind]: string = 'CubridVarcharBuilder';

	constructor(name: T['name'], length: number) {
		super(name, 'string', 'CubridVarchar');
		this.config.length = length;
	}

	build(table: Table) {
		return new CubridVarchar<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<LengthConfig>,
		);
	}
}

/** `VARCHAR(n)`: variable length, up to `n` characters. */
export class CubridVarchar<T extends ColumnBaseConfig<'string', 'CubridVarchar'>> extends CubridColumn<
	T,
	LengthConfig
> {
	static override readonly [entityKind]: string = 'CubridVarchar';

	readonly length = this.config.length;

	getSQLType(): string {
		return `VARCHAR(${this.config.length})`;
	}

	override mapFromDriverValue(value: unknown): string {
		return toText(value, 'VARCHAR');
	}
}

/** A `VARCHAR(n)` column; `length` is required. Use {@link string} for CUBRID's maximum length. */
export function varchar(config: LengthOnlyConfig): CubridVarcharBuilder<StringBuilderConfig<'', 'CubridVarchar'>>;
export function varchar<TName extends string>(
	name: TName,
	config: LengthConfig,
): CubridVarcharBuilder<StringBuilderConfig<TName, 'CubridVarchar'>>;
export function varchar(a: string | LengthConfig, b?: LengthConfig): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(a, b);
	return new CubridVarcharBuilder(name, checkLength(config?.length, 'varchar'));
}

// ---------- STRING ----------

export class CubridStringBuilder<
	T extends ColumnBuilderBaseConfig<'string', 'CubridString'>,
> extends CubridColumnBuilder<T> {
	static override readonly [entityKind]: string = 'CubridStringBuilder';

	constructor(name: T['name']) {
		super(name, 'string', 'CubridString');
	}

	build(table: Table) {
		return new CubridString<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig);
	}
}

/** `STRING`: CUBRID's `VARCHAR(1073741823)`. */
export class CubridString<T extends ColumnBaseConfig<'string', 'CubridString'>> extends CubridColumn<T> {
	static override readonly [entityKind]: string = 'CubridString';

	getSQLType(): string {
		return 'STRING';
	}

	override mapFromDriverValue(value: unknown): string {
		return toText(value, 'STRING');
	}
}

/** A `STRING` column (`VARCHAR(1073741823)`), CUBRID's replacement for `TEXT`. */
export function string(): CubridStringBuilder<StringBuilderConfig<'', 'CubridString'>>;
export function string<TName extends string>(
	name: TName,
): CubridStringBuilder<StringBuilderConfig<TName, 'CubridString'>>;
export function string(name?: string): AnyCubridColumnBuilder {
	return new CubridStringBuilder(name ?? '');
}
