// DATETIME, TIMESTAMP, DATE and TIME columns for cubrid-client.
//
// Drizzle's MySQL builders decode the strings mysql2 returns. cubrid-client
// returns a `Date` instead, so these subclasses keep Drizzle's builders, SQL
// types, `columnType`s, TypeScript types and writes, and only decode the
// driver's `Date`. The semantics are Drizzle's MySQL convention: the stored
// wall clock is UTC. The `Date`s are read with UTC getters, which is exact only
// when the client decodes in UTC; the session refuses other clients (see
// `../timezone.ts`).

import type { ColumnBaseConfig } from 'drizzle-orm/column';
import type { ColumnBuilderBaseConfig } from 'drizzle-orm/column-builder';
import { entityKind } from 'drizzle-orm/entity';
import {
	type date as drizzleDate,
	MySqlDate,
	MySqlDateBuilder,
	MySqlDateString,
	MySqlDateStringBuilder,
} from 'drizzle-orm/mysql-core/columns/date';
import {
	type datetime as drizzleDatetime,
	MySqlDateTime,
	MySqlDateTimeBuilder,
	MySqlDateTimeString,
	MySqlDateTimeStringBuilder,
} from 'drizzle-orm/mysql-core/columns/datetime';
import { type time as drizzleTime, MySqlTime, MySqlTimeBuilder } from 'drizzle-orm/mysql-core/columns/time';
import {
	type timestamp as drizzleTimestamp,
	MySqlTimestamp,
	MySqlTimestampBuilder,
	MySqlTimestampString,
	MySqlTimestampStringBuilder,
} from 'drizzle-orm/mysql-core/columns/timestamp';

// The builders' `build(table)` is internal to Drizzle and not in its typings.
// biome-ignore lint/suspicious/noExplicitAny: Drizzle's table and config types are internal here.
type AnyTable = any;
// biome-ignore lint/suspicious/noExplicitAny: see above.
type AnyConfig = any;

/** `YYYY-MM-DDTHH:MM:SS.mmmZ` of the UTC fields; CUBRID's years 0001-9999 always have four digits. */
function isoOf(value: Date): string {
	return value.toISOString();
}

function nameAndConfig<TConfig>(a: unknown, b: TConfig | undefined): { name: string; config: TConfig | undefined } {
	return {
		name: typeof a === 'string' ? a : '',
		config: typeof a === 'object' ? (a as TConfig) : b,
	};
}

export class CubridDateTimeBuilder extends MySqlDateTimeBuilder<ColumnBuilderBaseConfig<'date', 'MySqlDateTime'>> {
	static override readonly [entityKind]: string = 'CubridDateTimeBuilder';

	/** @internal */
	build(table: AnyTable): CubridDateTime {
		return new CubridDateTime(table, this.config as AnyConfig);
	}
}

/** `datetime({ mode: 'date' })`: the driver's `Date` as is. */
export class CubridDateTime extends MySqlDateTime<ColumnBaseConfig<'date', 'MySqlDateTime'>> {
	static override readonly [entityKind]: string = 'CubridDateTime';

	override mapFromDriverValue(value: unknown): Date {
		return value instanceof Date ? value : super.mapFromDriverValue(value as string);
	}
}

export class CubridDateTimeStringBuilder extends MySqlDateTimeStringBuilder<
	ColumnBuilderBaseConfig<'string', 'MySqlDateTimeString'>
> {
	static override readonly [entityKind]: string = 'CubridDateTimeStringBuilder';

	/** @internal */
	build(table: AnyTable): CubridDateTimeString {
		return new CubridDateTimeString(table, this.config as AnyConfig);
	}
}

/**
 * `datetime({ mode: 'string' })`: `YYYY-MM-DD HH:MM:SS.mmm`. A CUBRID DATETIME
 * always has milliseconds, so they are always included, as mysql2 does for a
 * MySQL `datetime(3)`.
 */
export class CubridDateTimeString extends MySqlDateTimeString<ColumnBaseConfig<'string', 'MySqlDateTimeString'>> {
	static override readonly [entityKind]: string = 'CubridDateTimeString';

	override mapFromDriverValue(value: unknown): string {
		return value instanceof Date ? isoOf(value).slice(0, 23).replace('T', ' ') : (value as string);
	}
}

export class CubridTimestampBuilder extends MySqlTimestampBuilder<ColumnBuilderBaseConfig<'date', 'MySqlTimestamp'>> {
	static override readonly [entityKind]: string = 'CubridTimestampBuilder';

	/** @internal */
	build(table: AnyTable): CubridTimestamp {
		return new CubridTimestamp(table, this.config as AnyConfig);
	}
}

/**
 * `timestamp({ mode: 'date' })`: the driver's `Date` as is. A CUBRID TIMESTAMP
 * holds whole seconds and the server drops fractional seconds without an
 * error. Writes are not refused for that: this encoder also encodes comparison
 * parameters such as `gt(t.ts, new Date())`, which store nothing.
 */
export class CubridTimestamp extends MySqlTimestamp<ColumnBaseConfig<'date', 'MySqlTimestamp'>> {
	static override readonly [entityKind]: string = 'CubridTimestamp';

	override mapFromDriverValue(value: unknown): Date {
		return value instanceof Date ? value : super.mapFromDriverValue(value as string);
	}
}

export class CubridTimestampStringBuilder extends MySqlTimestampStringBuilder<
	ColumnBuilderBaseConfig<'string', 'MySqlTimestampString'>
> {
	static override readonly [entityKind]: string = 'CubridTimestampStringBuilder';

	/** @internal */
	build(table: AnyTable): CubridTimestampString {
		return new CubridTimestampString(table, this.config as AnyConfig);
	}
}

/** `timestamp({ mode: 'string' })`: `YYYY-MM-DD HH:MM:SS`, as mysql2 returns it. */
export class CubridTimestampString extends MySqlTimestampString<ColumnBaseConfig<'string', 'MySqlTimestampString'>> {
	static override readonly [entityKind]: string = 'CubridTimestampString';

	override mapFromDriverValue(value: unknown): string {
		return value instanceof Date ? isoOf(value).slice(0, 19).replace('T', ' ') : (value as string);
	}
}

export class CubridDateBuilder extends MySqlDateBuilder<ColumnBuilderBaseConfig<'date', 'MySqlDate'>> {
	static override readonly [entityKind]: string = 'CubridDateBuilder';

	/** @internal */
	build(table: AnyTable): CubridDate {
		return new CubridDate(table, this.config as AnyConfig);
	}
}

/** `date({ mode: 'date' })`: midnight UTC of the stored date, as Drizzle reads mysql2's string. */
export class CubridDate extends MySqlDate<ColumnBaseConfig<'date', 'MySqlDate'>> {
	static override readonly [entityKind]: string = 'CubridDate';

	override mapFromDriverValue(value: unknown): Date {
		if (value instanceof Date) {
			const midnight = new Date(value.getTime());
			midnight.setUTCHours(0, 0, 0, 0);
			return midnight;
		}
		return super.mapFromDriverValue(value as string);
	}
}

export class CubridDateStringBuilder extends MySqlDateStringBuilder<
	ColumnBuilderBaseConfig<'string', 'MySqlDateString'>
> {
	static override readonly [entityKind]: string = 'CubridDateStringBuilder';

	/** @internal */
	build(table: AnyTable): CubridDateString {
		return new CubridDateString(table, this.config as AnyConfig);
	}
}

/** `date({ mode: 'string' })`: `YYYY-MM-DD`. */
export class CubridDateString extends MySqlDateString<ColumnBaseConfig<'string', 'MySqlDateString'>> {
	static override readonly [entityKind]: string = 'CubridDateString';

	override mapFromDriverValue(value: unknown): string {
		return value instanceof Date ? isoOf(value).slice(0, 10) : (value as string);
	}
}

export class CubridTimeBuilder extends MySqlTimeBuilder<ColumnBuilderBaseConfig<'string', 'MySqlTime'>> {
	static override readonly [entityKind]: string = 'CubridTimeBuilder';

	/** @internal */
	build(table: AnyTable): CubridTime {
		return new CubridTime(table, this.config as AnyConfig);
	}
}

/** `time()`: `HH:MM:SS`. */
export class CubridTime extends MySqlTime<ColumnBaseConfig<'string', 'MySqlTime'>> {
	static override readonly [entityKind]: string = 'CubridTime';

	override mapFromDriverValue(value: unknown): string {
		return value instanceof Date ? isoOf(value).slice(11, 19) : (value as string);
	}
}

/** Drizzle's `datetime()` with cubrid-client's `Date` decoded; same signature and types. */
export const datetime = ((a?: unknown, b?: { mode?: 'date' | 'string'; fsp?: number }) => {
	const { name, config } = nameAndConfig(a, b);
	return config?.mode === 'string'
		? new CubridDateTimeStringBuilder(name, config as AnyConfig)
		: new CubridDateTimeBuilder(name, config as AnyConfig);
}) as typeof drizzleDatetime;

/** Drizzle's `timestamp()` with cubrid-client's `Date` decoded; same signature and types. */
export const timestamp = ((a?: unknown, b: { mode?: 'date' | 'string'; fsp?: number } = {}) => {
	const { name, config } = nameAndConfig(a, b);
	return config?.mode === 'string'
		? new CubridTimestampStringBuilder(name, config as AnyConfig)
		: new CubridTimestampBuilder(name, config as AnyConfig);
}) as typeof drizzleTimestamp;

/** Drizzle's `date()` with cubrid-client's `Date` decoded; same signature and types. */
export const date = ((a?: unknown, b?: { mode?: 'date' | 'string' }) => {
	const { name, config } = nameAndConfig(a, b);
	return config?.mode === 'string' ? new CubridDateStringBuilder(name) : new CubridDateBuilder(name);
}) as typeof drizzleDate;

/** Drizzle's `time()` with cubrid-client's `Date` decoded; same signature and types. */
export const time = ((a?: unknown, b?: { fsp?: number }) => {
	const { name, config } = nameAndConfig(a, b);
	return new CubridTimeBuilder(name, config as AnyConfig);
}) as typeof drizzleTime;

const TEMPORAL_COLUMNS = [
	CubridDateTime,
	CubridDateTimeString,
	CubridTimestamp,
	CubridTimestampString,
	CubridDate,
	CubridDateString,
	CubridTime,
];

/** A column of this module, whose read is exact only when the client decodes in UTC. */
export function isCubridTemporalColumn(value: unknown): boolean {
	return TEMPORAL_COLUMNS.some((cls) => value instanceof cls);
}

/** `columnType`s of Drizzle's MySQL date and time columns, used as collection elements. */
export const TEMPORAL_COLUMN_TYPES: ReadonlySet<string> = new Set([
	'MySqlDateTime',
	'MySqlDateTimeString',
	'MySqlTimestamp',
	'MySqlTimestampString',
	'MySqlDate',
	'MySqlDateString',
	'MySqlTime',
]);
