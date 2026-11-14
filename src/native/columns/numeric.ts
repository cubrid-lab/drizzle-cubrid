// NUMERIC/DECIMAL, FLOAT, DOUBLE and MONETARY.

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

// ---------- NUMERIC(p, s) ----------

interface NumericRuntimeConfig {
	precision: number | undefined;
	scale: number | undefined;
}

function numericSqlType({ precision, scale }: NumericRuntimeConfig): string {
	if (precision === undefined) return 'NUMERIC';
	return scale === undefined ? `NUMERIC(${precision})` : `NUMERIC(${precision},${scale})`;
}

/** A number written as its shortest decimal string, so the server parses exactly the digits the caller sees. */
function numericToDriver(value: unknown): unknown {
	return typeof value === 'number' ? String(value) : value;
}

/** A decimal string read from the driver; cubrid-client 1.x returns NUMERIC as a string. */
function numericString(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	throw new TypeError(`NUMERIC value from the driver must be a string, got ${describeValue(value)}`);
}

export class CubridNumericBuilder<
	T extends ColumnBuilderBaseConfig<'string', 'CubridNumeric'>,
> extends CubridColumnBuilder<T, NumericRuntimeConfig> {
	static override readonly [entityKind]: string = 'CubridNumericBuilder';

	constructor(name: T['name'], precision: number | undefined, scale: number | undefined) {
		super(name, 'string', 'CubridNumeric');
		this.config.precision = precision;
		this.config.scale = scale;
	}

	build(table: Table) {
		return new CubridNumeric<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<NumericRuntimeConfig>,
		);
	}
}

/** `NUMERIC(p, s)` with `mode: 'string'` (the default): the exact decimal string. */
export class CubridNumeric<T extends ColumnBaseConfig<'string', 'CubridNumeric'>> extends CubridColumn<
	T,
	NumericRuntimeConfig
> {
	static override readonly [entityKind]: string = 'CubridNumeric';

	readonly precision = this.config.precision;
	readonly scale = this.config.scale;

	getSQLType(): string {
		return numericSqlType(this.config);
	}

	override mapFromDriverValue(value: unknown): string {
		return numericString(value);
	}

	override mapToDriverValue(value: unknown): unknown {
		return numericToDriver(value);
	}
}

export class CubridNumericNumberBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridNumericNumber'>,
> extends CubridColumnBuilder<T, NumericRuntimeConfig> {
	static override readonly [entityKind]: string = 'CubridNumericNumberBuilder';

	constructor(name: T['name'], precision: number | undefined, scale: number | undefined) {
		super(name, 'number', 'CubridNumericNumber');
		this.config.precision = precision;
		this.config.scale = scale;
	}

	build(table: Table) {
		return new CubridNumericNumber<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<NumericRuntimeConfig>,
		);
	}
}

/**
 * `NUMERIC(p, s)` with `mode: 'number'`: the decimal string converted with
 * `Number()`. Digits beyond a double's ~15–17 significant digits are rounded;
 * use the default `mode: 'string'` when every digit matters.
 */
export class CubridNumericNumber<T extends ColumnBaseConfig<'number', 'CubridNumericNumber'>> extends CubridColumn<
	T,
	NumericRuntimeConfig
> {
	static override readonly [entityKind]: string = 'CubridNumericNumber';

	readonly precision = this.config.precision;
	readonly scale = this.config.scale;

	getSQLType(): string {
		return numericSqlType(this.config);
	}

	override mapFromDriverValue(value: unknown): number {
		if (typeof value === 'number') return value;
		return Number(numericString(value));
	}

	override mapToDriverValue(value: unknown): unknown {
		return numericToDriver(value);
	}
}

export interface CubridNumericConfig<TMode extends 'string' | 'number' = 'string' | 'number'> {
	/** Total digits, 1–38. Without it the server's default `NUMERIC(15,0)` applies. */
	precision?: number;
	/** Digits after the decimal point; needs `precision`. */
	scale?: number;
	/** `'string'` (default): exact decimal strings. `'number'`: `Number()` of them, which may round. */
	mode?: TMode;
}

type NumericBuilderFor<TName extends string, TMode> = TMode extends 'number'
	? CubridNumericNumberBuilder<{
			name: TName;
			dataType: 'number';
			columnType: 'CubridNumericNumber';
			data: number;
			driverParam: string;
			enumValues: undefined;
		}>
	: CubridNumericBuilder<{
			name: TName;
			dataType: 'string';
			columnType: 'CubridNumeric';
			data: string;
			driverParam: string;
			enumValues: undefined;
		}>;

/** A `NUMERIC(p, s)` column (an exact decimal). Read as a string unless `mode: 'number'`. */
export function numeric(): NumericBuilderFor<'', 'string'>;
export function numeric<TMode extends 'string' | 'number' = 'string'>(
	config: CubridNumericConfig<TMode>,
): NumericBuilderFor<'', TMode>;
export function numeric<TName extends string, TMode extends 'string' | 'number' = 'string'>(
	name: TName,
	config?: CubridNumericConfig<TMode>,
): NumericBuilderFor<TName, TMode>;
export function numeric(a?: string | CubridNumericConfig, b?: CubridNumericConfig): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(a, b);
	const precision = config?.precision;
	const scale = config?.scale;
	if (scale !== undefined && precision === undefined) {
		throw new TypeError('numeric(): scale needs precision, as in { precision: 10, scale: 2 }');
	}
	if (config?.mode === 'number') return new CubridNumericNumberBuilder(name, precision, scale);
	if (config?.mode === undefined || config.mode === 'string') return new CubridNumericBuilder(name, precision, scale);
	throw new TypeError(`numeric(): mode must be 'string' or 'number', got ${describeValue(config.mode)}`);
}

/** Alias of {@link numeric}; CUBRID treats `DECIMAL` as `NUMERIC`. */
export const decimal = numeric;

// ---------- FLOAT and DOUBLE ----------

function toNumber(value: unknown, sqlType: string): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
	throw new TypeError(`${sqlType} value from the driver must be a number, got ${describeValue(value)}`);
}

export class CubridFloatBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridFloat'>,
> extends CubridColumnBuilder<T> {
	static override readonly [entityKind]: string = 'CubridFloatBuilder';

	constructor(name: T['name']) {
		super(name, 'number', 'CubridFloat');
	}

	build(table: Table) {
		return new CubridFloat<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig);
	}
}

/** `FLOAT`: a 32-bit float. `1.1` reads back as `1.100000023841858` (`Math.fround(1.1)`). */
export class CubridFloat<T extends ColumnBaseConfig<'number', 'CubridFloat'>> extends CubridColumn<T> {
	static override readonly [entityKind]: string = 'CubridFloat';

	getSQLType(): string {
		return 'FLOAT';
	}

	override mapFromDriverValue(value: unknown): number {
		return toNumber(value, 'FLOAT');
	}
}

/** A `FLOAT` column: 32-bit (single precision) in CUBRID. Use {@link double} for a JavaScript-exact double. */
export function float(): CubridFloatBuilder<{
	name: '';
	dataType: 'number';
	columnType: 'CubridFloat';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;
export function float<TName extends string>(
	name: TName,
): CubridFloatBuilder<{
	name: TName;
	dataType: 'number';
	columnType: 'CubridFloat';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;
export function float(name?: string): AnyCubridColumnBuilder {
	return new CubridFloatBuilder(name ?? '');
}

export class CubridDoubleBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridDouble'>,
> extends CubridColumnBuilder<T> {
	static override readonly [entityKind]: string = 'CubridDoubleBuilder';

	constructor(name: T['name']) {
		super(name, 'number', 'CubridDouble');
	}

	build(table: Table) {
		return new CubridDouble<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig);
	}
}

/** `DOUBLE`: a 64-bit float, the same as a JavaScript `number`. */
export class CubridDouble<T extends ColumnBaseConfig<'number', 'CubridDouble'>> extends CubridColumn<T> {
	static override readonly [entityKind]: string = 'CubridDouble';

	getSQLType(): string {
		return 'DOUBLE';
	}

	override mapFromDriverValue(value: unknown): number {
		return toNumber(value, 'DOUBLE');
	}
}

/** A `DOUBLE` column. */
export function double(): CubridDoubleBuilder<{
	name: '';
	dataType: 'number';
	columnType: 'CubridDouble';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;
export function double<TName extends string>(
	name: TName,
): CubridDoubleBuilder<{
	name: TName;
	dataType: 'number';
	columnType: 'CubridDouble';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;
export function double(name?: string): AnyCubridColumnBuilder {
	return new CubridDoubleBuilder(name ?? '');
}

// ---------- MONETARY ----------

export class CubridMonetaryBuilder<
	T extends ColumnBuilderBaseConfig<'string', 'CubridMonetary'>,
> extends CubridColumnBuilder<T> {
	static override readonly [entityKind]: string = 'CubridMonetaryBuilder';

	constructor(name: T['name']) {
		super(name, 'string', 'CubridMonetary');
	}

	build(table: Table) {
		return new CubridMonetary<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig);
	}
}

/**
 * `MONETARY`: stored by CUBRID as a double. cubrid-client returns a number,
 * read as its shortest decimal string (`12.34` → `'12.34'`), so amounts have
 * double precision, not exact decimal precision.
 */
export class CubridMonetary<T extends ColumnBaseConfig<'string', 'CubridMonetary'>> extends CubridColumn<T> {
	static override readonly [entityKind]: string = 'CubridMonetary';

	getSQLType(): string {
		return 'MONETARY';
	}

	override mapFromDriverValue(value: unknown): string {
		if (typeof value === 'string') return value;
		if (typeof value === 'number') return String(value);
		throw new TypeError(`MONETARY value from the driver must be a number, got ${describeValue(value)}`);
	}
}

/** A `MONETARY` column, read and written as a decimal string. */
export function monetary(): CubridMonetaryBuilder<{
	name: '';
	dataType: 'string';
	columnType: 'CubridMonetary';
	data: string;
	driverParam: string;
	enumValues: undefined;
}>;
export function monetary<TName extends string>(
	name: TName,
): CubridMonetaryBuilder<{
	name: TName;
	dataType: 'string';
	columnType: 'CubridMonetary';
	data: string;
	driverParam: string;
	enumValues: undefined;
}>;
export function monetary(name?: string): AnyCubridColumnBuilder {
	return new CubridMonetaryBuilder(name ?? '');
}
