// DATETIME, TIMESTAMP, DATE and TIME.
//
// The stored wall clock is UTC, as in drizzle-cubrid 0.x: a `Date` is written
// as the text of its UTC fields, and cubrid-client's `Date`s are read with
// UTC getters. Reads are exact only from a client that decodes in UTC
// (cubrid-client `createClient({ ..., timezone: 'utc' })`, or `TZ=UTC`). These
// columns only convert values; refusing a client that decodes in another zone
// is the native session's job (#160).

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

type TemporalSqlType = 'DATETIME' | 'TIMESTAMP' | 'DATE' | 'TIME';

/** `YYYY-MM-DDTHH:MM:SS.mmmZ` of the UTC fields; CUBRID's years 0001-9999 always have four digits. */
function isoOf(sqlType: TemporalSqlType, value: unknown): string {
	if (!(value instanceof Date)) {
		throw new TypeError(`${sqlType} column value must be a Date, got ${describeValue(value)}`);
	}
	if (Number.isNaN(value.getTime())) throw new RangeError(`${sqlType} column value is an invalid Date`);
	return value.toISOString();
}

function textOf(sqlType: TemporalSqlType, value: unknown): string {
	if (typeof value === 'string') return value;
	throw new TypeError(`${sqlType} column value must be a string, got ${describeValue(value)}`);
}

/** A driver value as a `Date`: cubrid-client 1.x returns `Date`s; text is read as a UTC wall clock. */
function dateOf(sqlType: TemporalSqlType, value: unknown): Date {
	if (value instanceof Date) return value;
	if (typeof value === 'string') {
		const parsed = new Date(sqlType === 'DATE' ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	throw new TypeError(`${sqlType} value from the driver must be a Date, got ${describeValue(value)}`);
}

/** Formats of the UTC wall clock, by SQL type: `[start, end)` of `toISOString()`. */
const TEXT_SLICE: Record<TemporalSqlType, [number, number]> = {
	DATETIME: [0, 23],
	TIMESTAMP: [0, 19],
	DATE: [0, 10],
	TIME: [11, 19],
};

/** The UTC wall clock of a `Date` in the type's text format, e.g. `YYYY-MM-DD HH:MM:SS.mmm` for DATETIME. */
function wallClockText(sqlType: TemporalSqlType, iso: string): string {
	const [start, end] = TEXT_SLICE[sqlType];
	return iso.slice(start, end).replace('T', ' ');
}

/** Driver text read as is; a driver `Date` as its UTC wall clock in the type's format. */
function textFromDriver(sqlType: TemporalSqlType, value: unknown): string {
	if (value instanceof Date) return wallClockText(sqlType, isoOf(sqlType, value));
	return textOf(sqlType, value);
}

interface TemporalRuntimeConfig {
	sqlType: TemporalSqlType;
}

export class CubridTemporalDateBuilder<
	T extends ColumnBuilderBaseConfig<'date', 'CubridTemporalDate'>,
> extends CubridColumnBuilder<T, TemporalRuntimeConfig> {
	static override readonly [entityKind]: string = 'CubridTemporalDateBuilder';

	constructor(name: T['name'], sqlType: Exclude<TemporalSqlType, 'TIME'>) {
		super(name, 'date', 'CubridTemporalDate');
		this.config.sqlType = sqlType;
	}

	build(table: Table) {
		return new CubridTemporalDate<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<TemporalRuntimeConfig>,
		);
	}
}

/**
 * `DATETIME`, `TIMESTAMP` or `DATE` with `mode: 'date'`: a `Date` whose UTC
 * fields are the stored wall clock. Writes send the UTC wall clock as text
 * (`YYYY-MM-DD HH:MM:SS.mmm`, `YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DD`), so they
 * do not depend on the client's time zone. A DATE reads as midnight UTC; a
 * TIMESTAMP holds whole seconds, so milliseconds are dropped on write.
 */
export class CubridTemporalDate<T extends ColumnBaseConfig<'date', 'CubridTemporalDate'>> extends CubridColumn<
	T,
	TemporalRuntimeConfig
> {
	static override readonly [entityKind]: string = 'CubridTemporalDate';

	getSQLType(): string {
		return this.config.sqlType;
	}

	override mapFromDriverValue(value: unknown): Date {
		const date = dateOf(this.config.sqlType, value);
		if (this.config.sqlType !== 'DATE') return date;
		const midnight = new Date(date.getTime());
		midnight.setUTCHours(0, 0, 0, 0);
		return midnight;
	}

	override mapToDriverValue(value: unknown): string {
		return wallClockText(this.config.sqlType, isoOf(this.config.sqlType, value));
	}
}

export class CubridTemporalStringBuilder<
	T extends ColumnBuilderBaseConfig<'string', 'CubridTemporalString'>,
> extends CubridColumnBuilder<T, TemporalRuntimeConfig> {
	static override readonly [entityKind]: string = 'CubridTemporalStringBuilder';

	constructor(name: T['name'], sqlType: TemporalSqlType) {
		super(name, 'string', 'CubridTemporalString');
		this.config.sqlType = sqlType;
	}

	build(table: Table) {
		return new CubridTemporalString<MakeColumnConfig<T, string>>(
			table,
			this.config as CubridBuilderRuntimeConfig<TemporalRuntimeConfig>,
		);
	}
}

/**
 * `DATETIME`, `TIMESTAMP`, `DATE` or `TIME` with `mode: 'string'` (`TIME`
 * always): the stored wall clock as text, `YYYY-MM-DD HH:MM:SS.mmm`,
 * `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` or `HH:MM:SS`. Writes send the string
 * as given; the server parses it.
 */
export class CubridTemporalString<T extends ColumnBaseConfig<'string', 'CubridTemporalString'>> extends CubridColumn<
	T,
	TemporalRuntimeConfig
> {
	static override readonly [entityKind]: string = 'CubridTemporalString';

	getSQLType(): string {
		return this.config.sqlType;
	}

	override mapFromDriverValue(value: unknown): string {
		return textFromDriver(this.config.sqlType, value);
	}

	override mapToDriverValue(value: unknown): string {
		return textOf(this.config.sqlType, value);
	}
}

export interface CubridTemporalConfig<TMode extends 'date' | 'string' = 'date' | 'string'> {
	/** `'date'` (default): a `Date` in UTC. `'string'`: the wall clock as text. */
	mode?: TMode;
}

type TemporalBuilderFor<TName extends string, TMode> = TMode extends 'string'
	? CubridTemporalStringBuilder<{
			name: TName;
			dataType: 'string';
			columnType: 'CubridTemporalString';
			data: string;
			driverParam: string;
			enumValues: undefined;
		}>
	: CubridTemporalDateBuilder<{
			name: TName;
			dataType: 'date';
			columnType: 'CubridTemporalDate';
			data: Date;
			driverParam: string;
			enumValues: undefined;
		}>;

function temporal(a: unknown, b: unknown, sqlType: Exclude<TemporalSqlType, 'TIME'>): AnyCubridColumnBuilder {
	const { name, config } = nameAndConfig(
		a as string | CubridTemporalConfig | undefined,
		b as CubridTemporalConfig | undefined,
	);
	const mode = config?.mode;
	if (mode === undefined || mode === 'date') return new CubridTemporalDateBuilder(name, sqlType);
	if (mode === 'string') return new CubridTemporalStringBuilder(name, sqlType);
	throw new TypeError(`${sqlType.toLowerCase()}(): mode must be 'date' or 'string', got ${describeValue(mode)}`);
}

/** A `DATETIME` column (millisecond precision). */
export function datetime(): TemporalBuilderFor<'', 'date'>;
export function datetime<TMode extends 'date' | 'string' = 'date'>(
	config: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<'', TMode>;
export function datetime<TName extends string, TMode extends 'date' | 'string' = 'date'>(
	name: TName,
	config?: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<TName, TMode>;
export function datetime(a?: unknown, b?: unknown): AnyCubridColumnBuilder {
	return temporal(a, b, 'DATETIME');
}

/** A `TIMESTAMP` column (whole seconds, 1970-01-01 00:00:01 to 2038-01-19 03:14:07 UTC). */
export function timestamp(): TemporalBuilderFor<'', 'date'>;
export function timestamp<TMode extends 'date' | 'string' = 'date'>(
	config: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<'', TMode>;
export function timestamp<TName extends string, TMode extends 'date' | 'string' = 'date'>(
	name: TName,
	config?: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<TName, TMode>;
export function timestamp(a?: unknown, b?: unknown): AnyCubridColumnBuilder {
	return temporal(a, b, 'TIMESTAMP');
}

/** A `DATE` column. */
export function date(): TemporalBuilderFor<'', 'date'>;
export function date<TMode extends 'date' | 'string' = 'date'>(
	config: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<'', TMode>;
export function date<TName extends string, TMode extends 'date' | 'string' = 'date'>(
	name: TName,
	config?: CubridTemporalConfig<TMode>,
): TemporalBuilderFor<TName, TMode>;
export function date(a?: unknown, b?: unknown): AnyCubridColumnBuilder {
	return temporal(a, b, 'DATE');
}

/** A `TIME` column (whole seconds), read and written as `HH:MM:SS` text. */
export function time(): TemporalBuilderFor<'', 'string'>;
export function time<TName extends string>(name: TName): TemporalBuilderFor<TName, 'string'>;
export function time(name?: string): AnyCubridColumnBuilder {
	return new CubridTemporalStringBuilder(name ?? '', 'TIME');
}
