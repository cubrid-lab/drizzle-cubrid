// SMALLINT, INTEGER and BIGINT.

import type { ColumnBaseConfig } from 'drizzle-orm/column';
import type { ColumnBuilderBaseConfig, MakeColumnConfig } from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import type { Table } from 'drizzle-orm/table';
import {
	type AnyCubridColumnBuilder,
	CubridAutoIncrementBuilder,
	type CubridBuilderRuntimeConfig,
	CubridColumn,
	describeValue,
} from './common.js';

/** A driver value read as a JavaScript integer `number`, refusing anything that is not one exactly. */
function toSafeInteger(value: unknown, sqlType: string): number {
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	if (typeof value === 'bigint') {
		if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
		throw new RangeError(
			`${sqlType} value ${value} is outside Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER and cannot be read as a number without rounding; use bigint(name, { mode: 'bigint' })`,
		);
	}
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return toSafeInteger(BigInt(value), sqlType);
	throw new TypeError(`${sqlType} value from the driver must be an integer, got ${describeValue(value)}`);
}

/** Value ranges of the integer types, as written from a JavaScript `number`. */
const NUMBER_RANGE = {
	SMALLINT: [-32768, 32767],
	INTEGER: [-2147483648, 2147483647],
	BIGINT: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
} as const;

/**
 * A `number` written to an integer column. The server would round 1.5 to 2
 * and reject or wrap out-of-range values, so both are refused before sending.
 */
function integerToDriver(value: unknown, sqlType: keyof typeof NUMBER_RANGE): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new TypeError(`${sqlType} column value must be an integer number, got ${describeValue(value)}`);
	}
	const [min, max] = NUMBER_RANGE[sqlType];
	if (value < min || value > max) {
		throw new RangeError(`${sqlType} column value ${value} is outside ${min}..${max}`);
	}
	return value;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// ---------- SMALLINT ----------

export class CubridSmallIntBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridSmallInt'>,
> extends CubridAutoIncrementBuilder<T> {
	static override readonly [entityKind]: string = 'CubridSmallIntBuilder';

	constructor(name: T['name']) {
		super(name, 'number', 'CubridSmallInt');
	}

	build(table: Table) {
		return new CubridSmallInt<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<{ autoIncrement: boolean }>,
		);
	}
}

/** `SMALLINT`: a 16-bit integer read as `number`. */
export class CubridSmallInt<T extends ColumnBaseConfig<'number', 'CubridSmallInt'>> extends CubridColumn<
	T,
	{ autoIncrement: boolean }
> {
	static override readonly [entityKind]: string = 'CubridSmallInt';

	getSQLType(): string {
		return 'SMALLINT';
	}

	override mapFromDriverValue(value: unknown): number {
		return toSafeInteger(value, 'SMALLINT');
	}

	override mapToDriverValue(value: unknown): number {
		return integerToDriver(value, 'SMALLINT');
	}
}

export type CubridSmallIntBuilderInitial<TName extends string> = CubridSmallIntBuilder<{
	name: TName;
	dataType: 'number';
	columnType: 'CubridSmallInt';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;

/** A `SMALLINT` column (−32768..32767). */
export function smallint(): CubridSmallIntBuilderInitial<''>;
export function smallint<TName extends string>(name: TName): CubridSmallIntBuilderInitial<TName>;
export function smallint(name?: string): AnyCubridColumnBuilder {
	return new CubridSmallIntBuilder(name ?? '');
}

// ---------- INTEGER ----------

export class CubridIntegerBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridInteger'>,
> extends CubridAutoIncrementBuilder<T> {
	static override readonly [entityKind]: string = 'CubridIntegerBuilder';

	constructor(name: T['name']) {
		super(name, 'number', 'CubridInteger');
	}

	build(table: Table) {
		return new CubridInteger<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<{ autoIncrement: boolean }>,
		);
	}
}

/** `INTEGER`: a 32-bit integer read as `number`. */
export class CubridInteger<T extends ColumnBaseConfig<'number', 'CubridInteger'>> extends CubridColumn<
	T,
	{ autoIncrement: boolean }
> {
	static override readonly [entityKind]: string = 'CubridInteger';

	getSQLType(): string {
		return 'INTEGER';
	}

	override mapFromDriverValue(value: unknown): number {
		return toSafeInteger(value, 'INTEGER');
	}

	override mapToDriverValue(value: unknown): number {
		return integerToDriver(value, 'INTEGER');
	}
}

export type CubridIntegerBuilderInitial<TName extends string> = CubridIntegerBuilder<{
	name: TName;
	dataType: 'number';
	columnType: 'CubridInteger';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;

/** An `INTEGER` column (32-bit). */
export function integer(): CubridIntegerBuilderInitial<''>;
export function integer<TName extends string>(name: TName): CubridIntegerBuilderInitial<TName>;
export function integer(name?: string): AnyCubridColumnBuilder {
	return new CubridIntegerBuilder(name ?? '');
}

/** Alias of {@link integer}. */
export const int = integer;

// ---------- BIGINT ----------

export class CubridBigIntBuilder<
	T extends ColumnBuilderBaseConfig<'bigint', 'CubridBigInt'>,
> extends CubridAutoIncrementBuilder<T> {
	static override readonly [entityKind]: string = 'CubridBigIntBuilder';

	constructor(name: T['name']) {
		super(name, 'bigint', 'CubridBigInt');
	}

	build(table: Table) {
		return new CubridBigInt<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<{ autoIncrement: boolean }>,
		);
	}
}

/** `BIGINT` with `mode: 'bigint'`: every 64-bit value is exact. */
export class CubridBigInt<T extends ColumnBaseConfig<'bigint', 'CubridBigInt'>> extends CubridColumn<
	T,
	{ autoIncrement: boolean }
> {
	static override readonly [entityKind]: string = 'CubridBigInt';

	getSQLType(): string {
		return 'BIGINT';
	}

	override mapFromDriverValue(value: unknown): bigint {
		if (typeof value === 'bigint') return value;
		if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
		if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
		throw new TypeError(`BIGINT value from the driver must be an integer, got ${describeValue(value)}`);
	}

	/**
	 * A `bigint` within the signed 64-bit range. A safe-integer `number` is
	 * accepted too and sent as a `bigint`, so a literal such as `5` in a filter
	 * works; any other number is refused rather than rounded.
	 */
	override mapToDriverValue(value: unknown): bigint {
		const big = typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value;
		if (typeof big !== 'bigint') {
			throw new TypeError(`BIGINT column value must be a bigint, got ${describeValue(value)}`);
		}
		if (big < INT64_MIN || big > INT64_MAX) {
			throw new RangeError(`BIGINT column value ${big} is outside the signed 64-bit range`);
		}
		return big;
	}
}

export class CubridBigIntNumberBuilder<
	T extends ColumnBuilderBaseConfig<'number', 'CubridBigIntNumber'>,
> extends CubridAutoIncrementBuilder<T> {
	static override readonly [entityKind]: string = 'CubridBigIntNumberBuilder';

	constructor(name: T['name']) {
		super(name, 'number', 'CubridBigIntNumber');
	}

	build(table: Table) {
		return new CubridBigIntNumber<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<{ autoIncrement: boolean }>,
		);
	}
}

/**
 * `BIGINT` with `mode: 'number'`. A stored value outside
 * `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER` is refused with a
 * `RangeError` instead of being rounded.
 */
export class CubridBigIntNumber<T extends ColumnBaseConfig<'number', 'CubridBigIntNumber'>> extends CubridColumn<
	T,
	{ autoIncrement: boolean }
> {
	static override readonly [entityKind]: string = 'CubridBigIntNumber';

	getSQLType(): string {
		return 'BIGINT';
	}

	override mapFromDriverValue(value: unknown): number {
		return toSafeInteger(value, 'BIGINT');
	}

	override mapToDriverValue(value: unknown): number {
		return integerToDriver(value, 'BIGINT');
	}
}

export type CubridBigIntBuilderInitial<TName extends string> = CubridBigIntBuilder<{
	name: TName;
	dataType: 'bigint';
	columnType: 'CubridBigInt';
	data: bigint;
	driverParam: bigint;
	enumValues: undefined;
}>;

export type CubridBigIntNumberBuilderInitial<TName extends string> = CubridBigIntNumberBuilder<{
	name: TName;
	dataType: 'number';
	columnType: 'CubridBigIntNumber';
	data: number;
	driverParam: number;
	enumValues: undefined;
}>;

export interface CubridBigIntConfig<TMode extends 'number' | 'bigint' = 'number' | 'bigint'> {
	/** `'bigint'`: exact `bigint` values. `'number'`: `number` values; reading one beyond 2^53 − 1 throws. */
	mode: TMode;
}

type BigIntBuilderFor<TName extends string, TMode> = TMode extends 'number'
	? CubridBigIntNumberBuilderInitial<TName>
	: CubridBigIntBuilderInitial<TName>;

/** A `BIGINT` column (64-bit). `mode` is required, so the JavaScript type is always a deliberate choice. */
export function bigint<TMode extends 'number' | 'bigint'>(
	config: CubridBigIntConfig<TMode>,
): BigIntBuilderFor<'', TMode>;
export function bigint<TName extends string, TMode extends 'number' | 'bigint'>(
	name: TName,
	config: CubridBigIntConfig<TMode>,
): BigIntBuilderFor<TName, TMode>;
export function bigint(a: string | CubridBigIntConfig, b?: CubridBigIntConfig): AnyCubridColumnBuilder {
	const name = typeof a === 'string' ? a : '';
	const config = typeof a === 'string' ? b : a;
	const mode = config?.mode;
	if (mode === 'number') return new CubridBigIntNumberBuilder(name);
	if (mode === 'bigint') return new CubridBigIntBuilder(name);
	throw new TypeError(`bigint() needs { mode: 'number' } or { mode: 'bigint' }, got mode ${describeValue(mode)}`);
}
