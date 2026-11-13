import type { ColumnBuilderBase } from 'drizzle-orm/column-builder';
import { customType } from 'drizzle-orm/mysql-core';
import { type SQL, sql } from 'drizzle-orm/sql/sql';

export interface CubridCollectionConfig {
	element?: ColumnBuilderBase;
}

// SQL types of Drizzle mysql-core columns used as collection elements, by
// `config.columnType`. String types are handled separately because the DDL keeps
// their declared length while the write cast does not.
const ELEMENT_SQL_TYPES: Record<string, string> = {
	MySqlInt: 'INTEGER',
	MySqlMediumInt: 'INTEGER',
	MySqlSmallInt: 'SMALLINT',
	MySqlTinyInt: 'SMALLINT',
	MySqlBoolean: 'SMALLINT',
	MySqlYear: 'SMALLINT',
	MySqlBigInt: 'BIGINT',
	MySqlBigInt53: 'BIGINT',
	MySqlBigInt64: 'BIGINT',
	MySqlSerial: 'BIGINT',
	MySqlDouble: 'DOUBLE',
	MySqlReal: 'DOUBLE',
	MySqlFloat: 'FLOAT',
	MySqlDateTime: 'DATETIME',
	MySqlDateTimeString: 'DATETIME',
	MySqlTimestamp: 'TIMESTAMP',
	MySqlTimestampString: 'TIMESTAMP',
	MySqlDate: 'DATE',
	MySqlDateString: 'DATE',
	MySqlTime: 'TIME',
};

// Cast to STRING on write. CHAR is not here: a CHAR set compares equal only to
// a CHAR set, so its writes and filters cast to the declared CHAR(n).
const STRING_ELEMENT_TYPES = new Set(['MySqlVarChar', 'MySqlText', 'MySqlEnumColumn', 'MySqlEnumObjectColumn']);

const DECIMAL_ELEMENT_TYPES = new Set(['MySqlDecimal', 'MySqlDecimalNumber', 'MySqlDecimalBigInt']);

type ElementConfig = Record<string, unknown>;

function elementConfig(element?: ColumnBuilderBase): ElementConfig | undefined {
	return (element as { config?: ElementConfig } | undefined)?.config;
}

function customElementType(config: ElementConfig): string | undefined {
	if (
		config.columnType === 'MySqlCustomColumn' &&
		typeof config.customTypeParams === 'object' &&
		config.customTypeParams !== null &&
		'dataType' in config.customTypeParams &&
		typeof (config.customTypeParams as { dataType: unknown }).dataType === 'function'
	) {
		const dataType = (config.customTypeParams as { dataType: (arg: unknown) => string }).dataType;
		return dataType(config.fieldConfig).toUpperCase();
	}
	return undefined;
}

function decimalElementType(config: ElementConfig): string | undefined {
	if (typeof config.columnType !== 'string' || !DECIMAL_ELEMENT_TYPES.has(config.columnType)) {
		return undefined;
	}
	const precision = typeof config.precision === 'number' ? config.precision : undefined;
	const scale = typeof config.scale === 'number' ? config.scale : undefined;
	if (precision !== undefined && scale !== undefined) {
		return `DECIMAL(${precision},${scale})`;
	}
	return precision !== undefined ? `DECIMAL(${precision})` : 'DECIMAL';
}

/** The element type in the collection's DDL, e.g. `VARCHAR(50)` in `SET(VARCHAR(50))`. */
function resolveElementSqlType(element?: ColumnBuilderBase): string {
	const config = elementConfig(element);
	if (!config) {
		return 'VARCHAR(100)';
	}
	const known =
		customElementType(config) ??
		decimalElementType(config) ??
		(typeof config.columnType === 'string' ? ELEMENT_SQL_TYPES[config.columnType] : undefined);
	if (known) {
		return known;
	}
	const length = typeof config.length === 'number' ? config.length : undefined;
	if (config.columnType === 'MySqlVarChar') {
		return length ? `VARCHAR(${length})` : 'VARCHAR';
	}
	if (config.columnType === 'MySqlChar') {
		return length ? `CHAR(${length})` : 'CHAR';
	}
	if (
		config.columnType === 'MySqlText' ||
		config.columnType === 'MySqlEnumColumn' ||
		config.columnType === 'MySqlEnumObjectColumn'
	) {
		return 'STRING';
	}
	if (typeof config.dataType === 'string') {
		return config.dataType.toUpperCase();
	}
	return 'VARCHAR(100)';
}

/**
 * The element type a written value is cast to. Strings cast to `STRING`, so a
 * schema without `element`, or with a shorter length than the table, never
 * truncates or rejects a value the column accepts; the server still refuses a
 * value too long for the column. An element type with no known SQL type gets
 * no cast rather than a guessed one.
 */
function resolveElementCastType(element?: ColumnBuilderBase): string | undefined {
	const config = elementConfig(element);
	if (!config || (typeof config.columnType === 'string' && STRING_ELEMENT_TYPES.has(config.columnType))) {
		return 'STRING';
	}
	if (config.columnType === 'MySqlChar') {
		return resolveElementSqlType(element);
	}
	return (
		customElementType(config) ??
		decimalElementType(config) ??
		(typeof config.columnType === 'string' ? ELEMENT_SQL_TYPES[config.columnType] : undefined)
	);
}

/**
 * A value cubrid-client can send as one parameter, and so as one element of a
 * collection literal. Nested collections, objects and functions are not.
 */
export type CubridCollectionElement = string | number | bigint | boolean | Date | Uint8Array | null;

type CollectionKind = 'SET' | 'MULTISET' | 'SEQUENCE';

function describeValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	if (typeof value === 'number') {
		return String(value);
	}
	return typeof value;
}

function assertElement(kind: CollectionKind, element: unknown, index: number): void {
	const ok =
		element === null ||
		typeof element === 'string' ||
		typeof element === 'bigint' ||
		typeof element === 'boolean' ||
		(typeof element === 'number' && Number.isFinite(element)) ||
		(element instanceof Date && !Number.isNaN(element.getTime())) ||
		element instanceof Uint8Array;
	if (!ok) {
		throw new TypeError(
			`${kind} element ${index} is ${describeValue(element)}; elements must be strings, finite numbers, bigints, booleans, valid Dates, bytes or null`,
		);
	}
}

// Node's Buffer, declared here because the library builds without Node types.
declare const Buffer: {
	isBuffer(value: unknown): boolean;
	from(buffer: ArrayBufferLike, byteOffset: number, length: number): Uint8Array;
};

/** cubrid-client accepts bytes only as a Buffer. */
function toDriverElement(element: unknown): unknown {
	if (element instanceof Uint8Array && !Buffer.isBuffer(element)) {
		return Buffer.from(element.buffer, element.byteOffset, element.byteLength);
	}
	return element;
}

/**
 * cubrid-client cannot bind an array, so the value becomes a typed collection
 * literal with one parameter per element, such as `SET{?, ?}`. The driver
 * writes each element like any other parameter, so quotes and backslashes need
 * no escaping here.
 */
function toCollectionSql(kind: CollectionKind, castType: string | undefined, value: unknown): SQL {
	if (!Array.isArray(value)) {
		throw new TypeError(`${kind} column value must be an array, got ${describeValue(value)}`);
	}
	value.forEach((element, index) => {
		assertElement(kind, element, index);
	});
	const elements = sql.join(
		value.map((element) => sql`${toDriverElement(element)}`),
		sql`, `,
	);
	// The cast to the column's own type lets the server type the parameters:
	// with typed binds, `SET q = SEQUENCE{?, ?}` in an UPDATE fails with -494
	// "Cannot coerce host var to type sequence", and the cast form works on
	// both binding paths. The cast type comes from the schema, never from values.
	const literal = sql`${sql.raw(kind)}{${elements}}`;
	return castType === undefined ? literal : sql`CAST(${literal} AS ${sql.raw(`${kind}(${castType})`)})`;
}

/** cubrid-client 1.x decodes collection columns into arrays. */
function fromCollectionDriverValue(kind: CollectionKind, value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(
			`${kind} column value from the driver must be an array (cubrid-client 1.x), got ${describeValue(value)}`,
		);
	}
	return value;
}

function createCollectionType<TElement>(kind: CollectionKind, config: CubridCollectionConfig | undefined) {
	const castType = resolveElementCastType(config?.element);
	return customType<{
		data: (TElement | null)[];
		driverData: unknown[];
		config: CubridCollectionConfig;
	}>({
		dataType(config) {
			return `${kind}(${resolveElementSqlType(config?.element)})`;
		},
		fromDriver(value) {
			return fromCollectionDriverValue(kind, value) as (TElement | null)[];
		},
		toDriver(value) {
			return toCollectionSql(kind, castType, value);
		},
	});
}

/**
 * A `SET` column. The server removes duplicates and defines no order.
 * `TElement` is the JavaScript type of one element, `string` by default; pass
 * an `element` column to set the SQL element type.
 */
export function cubridSet<TElement extends CubridCollectionElement = string>(
	name: string,
	config?: CubridCollectionConfig,
) {
	return createCollectionType<TElement>('SET', config)(name, config);
}
export type CubridSetColumnBuilder<TElement extends CubridCollectionElement = string> = ReturnType<
	typeof cubridSet<TElement>
>;

/** A `MULTISET` column: duplicates are kept, order is not defined. */
export function cubridMultiset<TElement extends CubridCollectionElement = string>(
	name: string,
	config?: CubridCollectionConfig,
) {
	return createCollectionType<TElement>('MULTISET', config)(name, config);
}
export type CubridMultisetColumnBuilder<TElement extends CubridCollectionElement = string> = ReturnType<
	typeof cubridMultiset<TElement>
>;

/** A `SEQUENCE` (LIST) column: duplicates and stored order are kept. */
export function cubridSequence<TElement extends CubridCollectionElement = string>(
	name: string,
	config?: CubridCollectionConfig,
) {
	return createCollectionType<TElement>('SEQUENCE', config)(name, config);
}
export type CubridSequenceColumnBuilder<TElement extends CubridCollectionElement = string> = ReturnType<
	typeof cubridSequence<TElement>
>;
