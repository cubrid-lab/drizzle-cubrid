// SET, MULTISET and SEQUENCE (LIST) of one element type.

import type { ColumnBaseConfig } from 'drizzle-orm/column';
import type {
	ColumnBuilderBase,
	ColumnBuilderBaseConfig,
	ColumnDataType,
	MakeColumnConfig,
} from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import type { Table } from 'drizzle-orm/table';
import {
	type AnyCubridColumnBuilder,
	type CubridBuilderRuntimeConfig,
	CubridColumn,
	CubridColumnBuilder,
	describeValue,
} from './common.js';
import { CubridString, CubridVarchar } from './string.js';

export type CubridCollectionKind = 'SET' | 'MULTISET' | 'SEQUENCE';

/** An element builder: any native builder except another collection (CUBRID has no nested collections). */
export type CubridCollectionElementBuilder = AnyCubridColumnBuilder &
	ColumnBuilderBase<ColumnBuilderBaseConfig<Exclude<ColumnDataType, 'array'>, string>>;

interface CollectionRuntimeConfig {
	kind: CubridCollectionKind;
	element: AnyCubridColumnBuilder;
}

export class CubridCollectionBuilder<
	T extends ColumnBuilderBaseConfig<'array', 'CubridCollection'>,
> extends CubridColumnBuilder<T, CollectionRuntimeConfig> {
	static override readonly [entityKind]: string = 'CubridCollectionBuilder';

	constructor(name: T['name'], kind: CubridCollectionKind, element: AnyCubridColumnBuilder) {
		super(name, 'array', 'CubridCollection');
		if (!(element instanceof CubridColumnBuilder)) {
			throw new TypeError(`${kind.toLowerCase()}(): element must be a drizzle-cubrid/native column builder`);
		}
		if (element instanceof CubridCollectionBuilder) {
			throw new TypeError(`${kind.toLowerCase()}(): CUBRID collections cannot contain collections`);
		}
		this.config.kind = kind;
		this.config.element = element;
	}

	build(table: Table) {
		return new CubridCollection<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<CollectionRuntimeConfig>,
		);
	}
}

/**
 * `SET(T)`, `MULTISET(T)` or `SEQUENCE(T)`: a JavaScript array of the element
 * column's type, with `null` elements allowed. Each element goes through the
 * element column's own codec in both directions.
 *
 * cubrid-client cannot bind an array as one parameter, so a statement writes
 * the value as a typed collection literal with one parameter per element,
 * `CAST(SET{?, ?} AS SET(INTEGER))` (see {@link CubridCollection.literalSql}).
 * `mapToDriverValue` returns the encoded elements for those parameters; the
 * native query builder (#158/#159) will emit the literal itself.
 */
export class CubridCollection<T extends ColumnBaseConfig<'array', 'CubridCollection'>> extends CubridColumn<
	T,
	CollectionRuntimeConfig
> {
	static override readonly [entityKind]: string = 'CubridCollection';

	readonly kind: CubridCollectionKind = this.config.kind;
	/** The element column, used for the element SQL type and codec. */
	readonly element: CubridColumn = this.config.element.build(this.table);

	getSQLType(): string {
		return `${this.kind}(${this.element.getSQLType()})`;
	}

	/**
	 * The element type written values are cast to. VARCHAR and STRING elements
	 * cast to `STRING`, so a cast never truncates a value the server would
	 * refuse for the column; every other element casts to its declared type.
	 */
	castType(): string {
		const element = this.element;
		const asString = element instanceof CubridVarchar || element instanceof CubridString;
		return `${this.kind}(${asString ? 'STRING' : element.getSQLType()})`;
	}

	/** The typed literal for `count` element parameters: `CAST(SET{?, ?} AS SET(INTEGER))`. */
	literalSql(count: number): string {
		if (!Number.isInteger(count) || count < 0) {
			throw new RangeError(`${this.kind} literal needs a non-negative element count, got ${describeValue(count)}`);
		}
		return `CAST(${this.kind}{${Array(count).fill('?').join(', ')}} AS ${this.castType()})`;
	}

	override mapFromDriverValue(value: unknown): unknown[] {
		if (!Array.isArray(value)) {
			throw new TypeError(
				`${this.kind} value from the driver must be an array (cubrid-client 1.x), got ${describeValue(value)}`,
			);
		}
		return value.map((element, index) => {
			if (element === null) return null;
			if (Array.isArray(element)) {
				throw new TypeError(`${this.kind} element ${index} from the driver is a nested array`);
			}
			return this.element.mapFromDriverValue(element);
		});
	}

	override mapToDriverValue(value: unknown): unknown[] {
		if (!Array.isArray(value)) {
			throw new TypeError(`${this.kind} column value must be an array, got ${describeValue(value)}`);
		}
		return value.map((element, index) => {
			if (element === null) return null;
			if (Array.isArray(element)) {
				throw new TypeError(`${this.kind} element ${index} is an array; CUBRID collections cannot be nested`);
			}
			if (element === undefined) {
				throw new TypeError(`${this.kind} element ${index} is undefined; use null for a missing element`);
			}
			return this.element.mapToDriverValue(element);
		});
	}
}

export interface CubridCollectionConfig<TElement extends CubridCollectionElementBuilder> {
	/** The element column builder, e.g. `integer()` or `varchar({ length: 20 })`; its name is ignored. */
	element: TElement;
}

/** The JavaScript type of one element: the element builder's `$type` or data type. */
export type CubridCollectionElementData<TElement extends ColumnBuilderBase> = TElement['_'] extends { $type: infer U }
	? U
	: TElement['_']['data'];

export type CubridCollectionBuilderInitial<
	TName extends string,
	TElement extends CubridCollectionElementBuilder,
> = CubridCollectionBuilder<{
	name: TName;
	dataType: 'array';
	columnType: 'CubridCollection';
	data: (CubridCollectionElementData<TElement> | null)[];
	driverParam: unknown[];
	enumValues: undefined;
}>;

function collection(a: unknown, b: unknown, kind: CubridCollectionKind): AnyCubridColumnBuilder {
	const name = typeof a === 'string' ? a : '';
	const config = (typeof a === 'string' ? b : a) as { element?: AnyCubridColumnBuilder } | undefined;
	if (config?.element === undefined) {
		throw new TypeError(`${kind.toLowerCase()}(): { element } is required, e.g. { element: integer() }`);
	}
	return new CubridCollectionBuilder(name, kind, config.element);
}

/** A `SET(T)` column: the server removes duplicates and returns elements in its own order. */
export function set<TElement extends CubridCollectionElementBuilder>(
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<'', TElement>;
export function set<TName extends string, TElement extends CubridCollectionElementBuilder>(
	name: TName,
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<TName, TElement>;
export function set(a: unknown, b?: unknown): AnyCubridColumnBuilder {
	return collection(a, b, 'SET');
}

/** A `MULTISET(T)` column: duplicates are kept, order is not defined. */
export function multiset<TElement extends CubridCollectionElementBuilder>(
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<'', TElement>;
export function multiset<TName extends string, TElement extends CubridCollectionElementBuilder>(
	name: TName,
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<TName, TElement>;
export function multiset(a: unknown, b?: unknown): AnyCubridColumnBuilder {
	return collection(a, b, 'MULTISET');
}

/** A `SEQUENCE(T)` (LIST) column: duplicates and order are kept. */
export function sequence<TElement extends CubridCollectionElementBuilder>(
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<'', TElement>;
export function sequence<TName extends string, TElement extends CubridCollectionElementBuilder>(
	name: TName,
	config: CubridCollectionConfig<TElement>,
): CubridCollectionBuilderInitial<TName, TElement>;
export function sequence(a: unknown, b?: unknown): AnyCubridColumnBuilder {
	return collection(a, b, 'SEQUENCE');
}

/**
 * The typed literal a statement uses to write `count` elements to a
 * collection column, e.g. `CAST(SET{?, ?} AS SET(INTEGER))`; the parameters
 * are the values `column.mapToDriverValue()` returns. Throws for any other
 * column.
 */
export function collectionLiteralSql(column: CubridColumn, count: number): string {
	if (!(column instanceof CubridCollection)) {
		throw new TypeError(`Column ${column.name} is not a SET, MULTISET or SEQUENCE column`);
	}
	return column.literalSql(count);
}
