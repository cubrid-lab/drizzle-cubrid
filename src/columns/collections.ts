import type { ColumnBuilderBase } from 'drizzle-orm/column-builder';
import { customType } from 'drizzle-orm/mysql-core';
import { type SQL, sql } from 'drizzle-orm/sql/sql';

export interface CubridCollectionConfig {
	element?: ColumnBuilderBase;
}

function resolveElementSqlType(element?: ColumnBuilderBase): string {
	if (!element) {
		return 'VARCHAR(100)';
	}

	const config = (element as { config?: Record<string, unknown> }).config;
	if (!config) {
		return 'VARCHAR(100)';
	}

	if (
		config.columnType === 'MySqlCustomColumn'
		&& typeof config.customTypeParams === 'object'
		&& config.customTypeParams !== null
		&& 'dataType' in config.customTypeParams
		&& typeof (config.customTypeParams as { dataType: unknown }).dataType === 'function'
	) {
		const dataType = (config.customTypeParams as { dataType: (arg: unknown) => string }).dataType;
		return dataType(config.fieldConfig).toUpperCase();
	}

	if (config.columnType === 'MySqlVarChar') {
		const length = typeof config.length === 'number' ? config.length : undefined;
		return length ? `VARCHAR(${length})` : 'VARCHAR';
	}

	if (config.columnType === 'MySqlChar') {
		const length = typeof config.length === 'number' ? config.length : undefined;
		return length ? `CHAR(${length})` : 'CHAR';
	}

	if (config.columnType === 'MySqlInt') {
		return 'INTEGER';
	}

	if (config.columnType === 'MySqlSmallInt') {
		return 'SMALLINT';
	}

	if (config.columnType === 'MySqlTinyInt') {
		return 'SMALLINT';
	}

	if (config.columnType === 'MySqlMediumInt') {
		return 'INTEGER';
	}

	if (config.columnType === 'MySqlBigInt' || config.columnType === 'MySqlSerial') {
		return 'BIGINT';
	}

	if (config.columnType === 'MySqlDecimal') {
		const precision = typeof config.precision === 'number' ? config.precision : undefined;
		const scale = typeof config.scale === 'number' ? config.scale : undefined;
		if (precision !== undefined && scale !== undefined) {
			return `DECIMAL(${precision},${scale})`;
		}
		if (precision !== undefined) {
			return `DECIMAL(${precision})`;
		}
		return 'DECIMAL';
	}

	if (typeof config.dataType === 'string') {
		return config.dataType.toUpperCase();
	}

	return 'VARCHAR(100)';
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
function toCollectionSql(kind: CollectionKind, value: unknown): SQL {
	if (!Array.isArray(value)) {
		throw new TypeError(`${kind} column value must be an array, got ${describeValue(value)}`);
	}
	value.forEach((element, index) => assertElement(kind, element, index));
	const elements = sql.join(
		value.map((element) => sql`${toDriverElement(element)}`),
		sql`, `,
	);
	return sql`${sql.raw(kind)}{${elements}}`;
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

function createCollectionType<TElement>(kind: CollectionKind) {
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
			return toCollectionSql(kind, value);
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
	return createCollectionType<TElement>('SET')(name, config);
}
export type CubridSetColumnBuilder<TElement extends CubridCollectionElement = string> = ReturnType<
	typeof cubridSet<TElement>
>;

/** A `MULTISET` column: duplicates are kept, order is not defined. */
export function cubridMultiset<TElement extends CubridCollectionElement = string>(
	name: string,
	config?: CubridCollectionConfig,
) {
	return createCollectionType<TElement>('MULTISET')(name, config);
}
export type CubridMultisetColumnBuilder<TElement extends CubridCollectionElement = string> =
	ReturnType<typeof cubridMultiset<TElement>>;

/** A `SEQUENCE` (LIST) column: duplicates and stored order are kept. */
export function cubridSequence<TElement extends CubridCollectionElement = string>(
	name: string,
	config?: CubridCollectionConfig,
) {
	return createCollectionType<TElement>('SEQUENCE')(name, config);
}
export type CubridSequenceColumnBuilder<TElement extends CubridCollectionElement = string> =
	ReturnType<typeof cubridSequence<TElement>>;
