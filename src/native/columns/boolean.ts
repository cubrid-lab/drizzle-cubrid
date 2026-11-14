// BOOLEAN stored as SMALLINT: CUBRID has no boolean column type.

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
} from './common.js';

export class CubridBooleanBuilder<
	T extends ColumnBuilderBaseConfig<'boolean', 'CubridBoolean'>,
> extends CubridColumnBuilder<T> {
	static override readonly [entityKind]: string = 'CubridBooleanBuilder';

	constructor(name: T['name']) {
		super(name, 'boolean', 'CubridBoolean');
	}

	build(table: Table) {
		return new CubridBoolean<MakeColumnConfig<T, string>>(table, this.config as CubridBuilderRuntimeConfig);
	}
}

/**
 * A boolean in a `SMALLINT`: `true` is written as 1 and `false` as 0. Reading
 * any value other than 0 or 1 throws, so a column also written by other code
 * is never guessed.
 */
export class CubridBoolean<T extends ColumnBaseConfig<'boolean', 'CubridBoolean'>> extends CubridColumn<T> {
	static override readonly [entityKind]: string = 'CubridBoolean';

	getSQLType(): string {
		return 'SMALLINT';
	}

	override mapFromDriverValue(value: unknown): boolean {
		if (value === 1 || value === 1n || value === '1') return true;
		if (value === 0 || value === 0n || value === '0') return false;
		throw new TypeError(`boolean (SMALLINT) value from the driver must be 0 or 1, got ${describeValue(value)}`);
	}

	override mapToDriverValue(value: unknown): number {
		if (value === true) return 1;
		if (value === false) return 0;
		throw new TypeError(`boolean column value must be true or false, got ${describeValue(value)}`);
	}
}

/** A boolean column, stored as `SMALLINT` 0/1. */
export function boolean(): CubridBooleanBuilder<{
	name: '';
	dataType: 'boolean';
	columnType: 'CubridBoolean';
	data: boolean;
	driverParam: number;
	enumValues: undefined;
}>;
export function boolean<TName extends string>(
	name: TName,
): CubridBooleanBuilder<{
	name: TName;
	dataType: 'boolean';
	columnType: 'CubridBoolean';
	data: boolean;
	driverParam: number;
	enumValues: undefined;
}>;
export function boolean(name?: string): AnyCubridColumnBuilder {
	return new CubridBooleanBuilder(name ?? '');
}
