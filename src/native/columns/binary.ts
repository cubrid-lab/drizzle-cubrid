// BIT(n) and BIT VARYING(n) as bytes (#216).

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

/**
 * The value type of `binary()` and `varbinary()`: Node's `Buffer` when the
 * program has Node's types (`@types/node`), otherwise `Uint8Array`, which
 * `Buffer` extends. Written this way so the published declarations never name
 * `Buffer` and compile with or without Node's types.
 */
export type CubridBytes = typeof globalThis extends { Buffer: { isBuffer(value: unknown): value is infer B } }
	? B
	: Uint8Array;

// Node's Buffer, declared here because the library builds without Node types.
declare const Buffer: {
	isBuffer(value: unknown): boolean;
	from(buffer: ArrayBufferLike, byteOffset: number, length: number): Uint8Array;
	alloc(size: number): Uint8Array;
};

/** CUBRID's longest BIT / BIT VARYING is 1073741823 bits, so this many whole bytes. */
const MAX_BYTES = Math.floor(1_073_741_823 / 8);

function checkLength(length: unknown, builder: string): number {
	if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > MAX_BYTES) {
		throw new TypeError(
			`${builder}(): length must be an integer number of bytes from 1 to ${MAX_BYTES}, got ${describeValue(length)}`,
		);
	}
	return length;
}

/** `value` as the Buffer cubrid-client binds (it accepts bytes only as a Buffer). */
function toBuffer(value: Uint8Array): Uint8Array {
	return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** The bytes to bind for `value`, refused before anything is sent unless they fit `length` bytes. */
function encode(value: unknown, sqlType: string, length: number): Uint8Array {
	if (!(value instanceof Uint8Array)) {
		const hint = typeof value === 'string' ? "; for hex text pass Buffer.from(text, 'hex')" : '';
		throw new TypeError(`${sqlType} column value must be a Buffer or Uint8Array, got ${describeValue(value)}${hint}`);
	}
	if (value.byteLength > length) {
		throw new RangeError(
			`${sqlType} column value has ${value.byteLength} bytes, more than the column's ${length} (${length * 8} bits)`,
		);
	}
	return toBuffer(value);
}

function decode(value: unknown, sqlType: string): Uint8Array {
	if (value instanceof Uint8Array) return toBuffer(value);
	throw new TypeError(`${sqlType} value from the driver must be a Buffer, got ${describeValue(value)}`);
}

interface LengthConfig {
	/** The length in bytes; the column holds `length * 8` bits. */
	length: number;
}

/** `{ length }` but not a string, which also has a numeric `length`. */
type LengthOnlyConfig = LengthConfig & object;

type BinaryBuilderConfig<TName extends string, TColumnType extends string> = {
	name: TName;
	dataType: 'buffer';
	columnType: TColumnType;
	data: CubridBytes;
	driverParam: Uint8Array;
	enumValues: undefined;
};

// ---------- BIT(n) ----------

export class CubridBinaryBuilder<
	T extends ColumnBuilderBaseConfig<'buffer', 'CubridBinary'>,
> extends CubridColumnBuilder<T, LengthConfig> {
	static override readonly [entityKind]: string = 'CubridBinaryBuilder';

	constructor(name: T['name'], length: number) {
		super(name, 'buffer', 'CubridBinary');
		this.config.length = length;
	}

	build(table: Table) {
		return new CubridBinary<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<LengthConfig>,
		);
	}
}

/**
 * `BIT(n * 8)`: exactly `length` bytes. A shorter value is padded with zero
 * bytes before it is sent, as the server would store it, so it also compares
 * equal to what was stored; values read back are always `length` bytes.
 */
export class CubridBinary<T extends ColumnBaseConfig<'buffer', 'CubridBinary'>> extends CubridColumn<T, LengthConfig> {
	static override readonly [entityKind]: string = 'CubridBinary';

	/** The length in bytes. */
	readonly length = this.config.length;

	getSQLType(): string {
		return `BIT(${this.config.length * 8})`;
	}

	override mapFromDriverValue(value: unknown): CubridBytes {
		return decode(value, this.getSQLType()) as CubridBytes;
	}

	override mapToDriverValue(value: unknown): Uint8Array {
		const bytes = encode(value, this.getSQLType(), this.length);
		if (bytes.byteLength === this.length) return bytes;
		const padded = Buffer.alloc(this.length);
		padded.set(bytes);
		return padded;
	}
}

/** A `BIT(length * 8)` column of `length` bytes, read and written as a `Buffer`. */
export function binary(config: LengthOnlyConfig): CubridBinaryBuilder<BinaryBuilderConfig<'', 'CubridBinary'>>;
export function binary<TName extends string>(
	name: TName,
	config: LengthConfig,
): CubridBinaryBuilder<BinaryBuilderConfig<TName, 'CubridBinary'>>;
export function binary(a: string | LengthConfig, b?: LengthConfig): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(a, b);
	return new CubridBinaryBuilder(name, checkLength(config?.length, 'binary'));
}

// ---------- BIT VARYING(n) ----------

export class CubridVarbinaryBuilder<
	T extends ColumnBuilderBaseConfig<'buffer', 'CubridVarbinary'>,
> extends CubridColumnBuilder<T, LengthConfig> {
	static override readonly [entityKind]: string = 'CubridVarbinaryBuilder';

	constructor(name: T['name'], length: number) {
		super(name, 'buffer', 'CubridVarbinary');
		this.config.length = length;
	}

	build(table: Table) {
		return new CubridVarbinary<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<LengthConfig>,
		);
	}
}

/**
 * `BIT VARYING(n * 8)`: up to `length` bytes, read back with the length
 * written. An empty value is refused: cubrid-client cannot bind an empty
 * `Buffer` as a typed parameter (it would be NULL), and refusing it under both
 * bindings keeps them alike. Write `` sql`X''` `` for an empty value.
 */
export class CubridVarbinary<T extends ColumnBaseConfig<'buffer', 'CubridVarbinary'>> extends CubridColumn<
	T,
	LengthConfig
> {
	static override readonly [entityKind]: string = 'CubridVarbinary';

	/** The maximum length in bytes. */
	readonly length = this.config.length;

	getSQLType(): string {
		return `BIT VARYING(${this.config.length * 8})`;
	}

	override mapFromDriverValue(value: unknown): CubridBytes {
		return decode(value, this.getSQLType()) as CubridBytes;
	}

	override mapToDriverValue(value: unknown): Uint8Array {
		const bytes = encode(value, this.getSQLType(), this.length);
		if (bytes.byteLength === 0) {
			throw new RangeError(
				`${this.getSQLType()} column value is empty: cubrid-client cannot bind an empty Buffer (it would be NULL); write sql\`X''\` for an empty value`,
			);
		}
		return bytes;
	}
}

/** A `BIT VARYING(length * 8)` column of up to `length` bytes, read and written as a `Buffer`. */
export function varbinary(config: LengthOnlyConfig): CubridVarbinaryBuilder<BinaryBuilderConfig<'', 'CubridVarbinary'>>;
export function varbinary<TName extends string>(
	name: TName,
	config: LengthConfig,
): CubridVarbinaryBuilder<BinaryBuilderConfig<TName, 'CubridVarbinary'>>;
export function varbinary(a: string | LengthConfig, b?: LengthConfig): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(a, b);
	return new CubridVarbinaryBuilder(name, checkLength(config?.length, 'varbinary'));
}
