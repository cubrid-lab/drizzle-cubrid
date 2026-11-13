import { createClient, createPool, CubridTransaction, NativeCubridAdapter } from 'cubrid-client';
import { eq, sql } from 'drizzle-orm';
import { is } from 'drizzle-orm/entity';
import { relations } from 'drizzle-orm/relations';
import { MySqlDate, MySqlDateString } from 'drizzle-orm/mysql-core/columns/date';
import { MySqlDateTime, MySqlDateTimeString } from 'drizzle-orm/mysql-core/columns/datetime';
import { MySqlTime } from 'drizzle-orm/mysql-core/columns/time';
import { MySqlTimestamp, MySqlTimestampString } from 'drizzle-orm/mysql-core/columns/timestamp';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { cubridSequence, date, datetime, int, time, timestamp } from '../src/columns';
import { datetime as drizzleDatetime } from 'drizzle-orm/mysql-core/columns/datetime';
import { drizzle } from '../src/driver';
import type { CubridQueryable } from '../src/session';
import { cubridTable } from '../src/table';
import { assertUtcDecoding, declaredClientZone, isProcessZoneUtc, NOT_UTC_MESSAGE, ZONE_PROBE_SQL } from '../src/timezone';

const events = cubridTable('events', {
	id: int('id').primaryKey(),
	at: datetime('at'),
	atText: datetime('at_text', { mode: 'string' }),
	stamp: timestamp('stamp'),
	stampText: timestamp('stamp_text', { mode: 'string' }),
	day: date('day'),
	dayText: date('day_text', { mode: 'string' }),
	clock: time('clock'),
});

const instant = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
const ancient = new Date('0001-01-01T00:00:00.000Z');

/** A client that returns the given array rows and records what it was asked. */
class ArrayClient implements CubridQueryable {
	readonly statements: string[] = [];
	constructor(
		private rows: unknown[][],
		extra: Record<string, unknown> = {},
		private probeRow?: unknown[],
	) {
		Object.assign(this, extra);
	}

	async query<T>(statement: string): Promise<T[]> {
		this.statements.push(statement);
		if (statement === ZONE_PROBE_SQL) {
			return (this.probeRow ? [this.probeRow] : []) as T[];
		}
		return this.rows.map((row) => [...row]) as T[];
	}
}

const utcProbe = [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2000, 6, 1))];
const localProbe = [new Date(2000, 0, 1), new Date(2000, 6, 1)];

function offsetMinutes(minutes: number) {
	return vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(minutes);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('temporal column builders', () => {
	it('keep the SQL types and columnTypes of Drizzle', () => {
		expect(events.at.getSQLType()).toBe('datetime');
		expect(events.stamp.getSQLType()).toBe('timestamp');
		expect(events.day.getSQLType()).toBe('date');
		expect(events.clock.getSQLType()).toBe('time');
		expect(events.at.columnType).toBe('MySqlDateTime');
		expect(events.atText.columnType).toBe('MySqlDateTimeString');
		expect(events.stamp.columnType).toBe('MySqlTimestamp');
		expect(events.stampText.columnType).toBe('MySqlTimestampString');
		expect(events.day.columnType).toBe('MySqlDate');
		expect(events.dayText.columnType).toBe('MySqlDateString');
		expect(events.clock.columnType).toBe('MySqlTime');
	});

	it('are still Drizzle columns for is()', () => {
		expect(is(events.at, MySqlDateTime)).toBe(true);
		expect(is(events.atText, MySqlDateTimeString)).toBe(true);
		expect(is(events.stamp, MySqlTimestamp)).toBe(true);
		expect(is(events.stampText, MySqlTimestampString)).toBe(true);
		expect(is(events.day, MySqlDate)).toBe(true);
		expect(is(events.dayText, MySqlDateString)).toBe(true);
		expect(is(events.clock, MySqlTime)).toBe(true);
	});

	it('keep the builder signature and config', () => {
		const t = cubridTable('cfg', {
			unnamed: datetime({ mode: 'string', fsp: 3 }),
			stampUnnamed: timestamp({ fsp: 2 }),
			dayUnnamed: date({ mode: 'string' }),
			clockUnnamed: time({ fsp: 1 }),
			plain: datetime(),
			stampPlain: timestamp(),
			dayPlain: date(),
			clockPlain: time(),
		});
		expect(t.unnamed.name).toBe('unnamed');
		expect(t.unnamed.getSQLType()).toBe('datetime(3)');
		expect(t.stampUnnamed.getSQLType()).toBe('timestamp(2)');
		expect(t.dayUnnamed.columnType).toBe('MySqlDateString');
		expect(t.clockUnnamed.getSQLType()).toBe('time(1)');
		expect(t.plain.columnType).toBe('MySqlDateTime');
		expect(t.stampPlain.columnType).toBe('MySqlTimestamp');
		expect(t.dayPlain.columnType).toBe('MySqlDate');
		expect(t.clockPlain.columnType).toBe('MySqlTime');
	});

	it('keep the TypeScript types of Drizzle', () => {
		expectTypeOf(datetime).toEqualTypeOf<typeof drizzleDatetime>();
		type Row = typeof events.$inferSelect;
		expectTypeOf<Row['at']>().toEqualTypeOf<Date | null>();
		expectTypeOf<Row['atText']>().toEqualTypeOf<string | null>();
		expectTypeOf<Row['day']>().toEqualTypeOf<Date | null>();
		expectTypeOf<Row['dayText']>().toEqualTypeOf<string | null>();
		expectTypeOf<Row['clock']>().toEqualTypeOf<string | null>();
	});

	it('timestamp() keeps defaultNow() and onUpdateNow()', () => {
		const t = cubridTable('tsn', { at: timestamp('at').defaultNow().onUpdateNow() });
		expect(t.at.hasDefault).toBe(true);
		expect((t.at as unknown as { hasOnUpdateNow: boolean }).hasOnUpdateNow).toBe(true);
	});
});

describe('decoding the driver Date as a UTC wall clock', () => {
	it('datetime: the Date as is, or a string parsed as UTC', () => {
		expect(events.at.mapFromDriverValue(instant as never)).toBe(instant);
		expect((events.at.mapFromDriverValue('2024-01-02 03:04:05.678') as Date).getTime()).toBe(instant.getTime());
		expect(events.atText.mapFromDriverValue(instant as never)).toBe('2024-01-02 03:04:05.678');
		expect(events.atText.mapFromDriverValue(ancient as never)).toBe('0001-01-01 00:00:00.000');
		expect(events.atText.mapFromDriverValue('2024-01-02 03:04:05')).toBe('2024-01-02 03:04:05');
	});

	it('timestamp: the Date as is, or a string parsed as UTC; strings without milliseconds', () => {
		const whole = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
		expect(events.stamp.mapFromDriverValue(whole as never)).toBe(whole);
		expect((events.stamp.mapFromDriverValue('2024-01-02 03:04:05') as Date).getTime()).toBe(whole.getTime());
		expect(events.stampText.mapFromDriverValue(whole as never)).toBe('2024-01-02 03:04:05');
		expect(events.stampText.mapFromDriverValue('x')).toBe('x');
	});

	it('date: midnight UTC, or YYYY-MM-DD', () => {
		const late = new Date(Date.UTC(2024, 1, 3, 23, 59, 59, 999));
		expect((events.day.mapFromDriverValue(late as never) as Date).toISOString()).toBe('2024-02-03T00:00:00.000Z');
		expect((events.day.mapFromDriverValue(ancient as never) as Date).toISOString()).toBe('0001-01-01T00:00:00.000Z');
		expect((events.day.mapFromDriverValue('2024-02-03') as Date).toISOString()).toBe('2024-02-03T00:00:00.000Z');
		expect(events.dayText.mapFromDriverValue(late as never)).toBe('2024-02-03');
		expect(events.dayText.mapFromDriverValue('2024-02-03')).toBe('2024-02-03');
	});

	it('time: HH:MM:SS', () => {
		expect(events.clock.mapFromDriverValue(new Date(Date.UTC(1970, 0, 1, 23, 4, 5)) as never)).toBe('23:04:05');
		expect(events.clock.mapFromDriverValue('01:02:03')).toBe('01:02:03');
	});

	it('writes as Drizzle does', () => {
		expect(events.at.mapToDriverValue(instant)).toBe('2024-01-02 03:04:05.678');
		expect(events.stamp.mapToDriverValue(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)))).toBe('2024-01-02 03:04:05.000');
		expect(events.day.mapToDriverValue(instant)).toBe(instant);
	});

	it('encodes a TIMESTAMP Date with milliseconds, e.g. a gt(col, new Date()) parameter', () => {
		expect(events.stamp.mapToDriverValue(instant)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
	});
});

describe('client zone resolution', () => {
	it('(a) reads a public timezone setting', () => {
		expect(declaredClientZone({ timezone: 'utc' })).toBe('utc');
		expect(declaredClientZone({ timezone: 'local' })).toBe('local');
		expect(declaredClientZone({ timezone: 'Asia/Seoul' })).toBe('other');
	});

	it('(b) reads a utcDates field', () => {
		expect(declaredClientZone({ utcDates: true })).toBe('utc');
		expect(declaredClientZone({ utcDates: false })).toBe('local');
	});

	it('reads the config and connection fields of cubrid-client 1.4', () => {
		expect(declaredClientZone({ config: { timezone: 'utc' } })).toBe('utc');
		expect(declaredClientZone({ config: { timezone: undefined } })).toBe('local');
		expect(declaredClientZone({ config: { host: 'x' } })).toBeUndefined();
		expect(declaredClientZone(Object.assign(new (class CubridPool {})(), { config: {} }))).toBe('local');
		expect(declaredClientZone({ config: { timezone: 3 } })).toBeUndefined();
		expect(declaredClientZone({ connection: { utcDates: true } })).toBe('utc');
		expect(declaredClientZone({ connection: { utcDates: false } })).toBe('local');
		expect(declaredClientZone({ connection: {} })).toBeUndefined();
		expect(declaredClientZone({})).toBeUndefined();
	});

	it('pins the fields of the installed cubrid-client', async () => {
		const options = { host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: '' };
		const utcClient = createClient({ ...options, timezone: 'utc' });
		const localClient = createClient(options);
		const utcPool = createPool({ ...options, timezone: 'utc' });
		const adapter = new NativeCubridAdapter({ ...options, timezone: 'utc' });
		try {
			expect(declaredClientZone(utcClient)).toBe('utc');
			expect(declaredClientZone(localClient)).toBe('local');
			expect(declaredClientZone(createClient({ ...options, timezone: 'local' }))).toBe('local');
			expect(declaredClientZone(utcPool)).toBe('utc');
			expect(declaredClientZone(adapter)).toBe('utc');
			expect(declaredClientZone(new NativeCubridAdapter(options))).toBe('local');
			// What transaction() hands its callback.
			const tx = new CubridTransaction(adapter as never);
			expect(declaredClientZone(tx)).toBe('utc');
		} finally {
			await Promise.all([utcClient.close(), localClient.close(), utcPool.close()]);
		}
	});

	it('(c) probes a client that declares nothing, once per client', async () => {
		const client = new ArrayClient([], {}, utcProbe);
		await assertUtcDecoding(client);
		await assertUtcDecoding(client);
		expect(client.statements).toEqual([ZONE_PROBE_SQL]);
	});

	it('(c) a probe matching the local zone passes only in a UTC process', async () => {
		const client = new ArrayClient([], {}, localProbe);
		offsetMinutes(0);
		await assertUtcDecoding(client);
		offsetMinutes(-540);
		await expect(assertUtcDecoding(client)).rejects.toThrow(NOT_UTC_MESSAGE);
		expect(client.statements).toEqual([ZONE_PROBE_SQL]);
	});

	it('(c) refuses a client whose probe matches neither zone', async () => {
		const strings = new ArrayClient([], {}, ['2000-01-01 00:00:00', '2000-07-01 00:00:00']);
		await expect(assertUtcDecoding(strings)).rejects.toThrow(/timezone: 'utc'/);
		await expect(assertUtcDecoding(new ArrayClient([], {}))).rejects.toThrow(/TZ=UTC/);
	});

	it('(c) probes again after a failed probe', async () => {
		let calls = 0;
		const client = {
			async query(): Promise<unknown[]> {
				calls++;
				if (calls === 1) {
					throw new Error('connection lost');
				}
				return [utcProbe];
			},
		};
		await expect(assertUtcDecoding(client)).rejects.toThrow('connection lost');
		await assertUtcDecoding(client);
		expect(calls).toBe(2);
	});

	it('a declared zone needs no probe; a local one depends on the process zone', async () => {
		const local = new ArrayClient([], { utcDates: false });
		offsetMinutes(0);
		await assertUtcDecoding(local);
		offsetMinutes(300);
		await expect(assertUtcDecoding(local)).rejects.toThrow(NOT_UTC_MESSAGE);
		await assertUtcDecoding(new ArrayClient([], { timezone: 'utc' }));
		await expect(assertUtcDecoding(new ArrayClient([], { timezone: 'Asia/Seoul' }))).rejects.toThrow();
		expect(local.statements).toEqual([]);
	});

	it('checks the process zone in winter, summer and year 1', () => {
		const spy = offsetMinutes(0);
		expect(isProcessZoneUtc()).toBe(true);
		spy.mockReturnValueOnce(0).mockReturnValueOnce(-60);
		expect(isProcessZoneUtc()).toBe(false);
	});
});

describe('reading temporal columns through drizzle', () => {
	const row = [
		1,
		instant,
		instant,
		new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
		new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
		new Date(Date.UTC(2024, 1, 3)),
		new Date(Date.UTC(2024, 1, 3)),
		new Date(Date.UTC(1970, 0, 1, 3, 4, 5)),
	];

	for (const binding of ['prepared', 'literal'] as const) {
		it(`maps every mode from a UTC client (${binding})`, async () => {
			const client = new ArrayClient([row], { utcDates: true });
			Object.assign(client, { queryPrepared: client.query.bind(client) });
			const db = drizzle(client, { binding });

			const [result] = await db.select().from(events);

			expect(result).toEqual({
				id: 1,
				at: instant,
				atText: '2024-01-02 03:04:05.678',
				stamp: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
				stampText: '2024-01-02 03:04:05',
				day: new Date(Date.UTC(2024, 1, 3)),
				dayText: '2024-02-03',
				clock: '03:04:05',
			});
		});
	}

	it('refuses a local client outside UTC before sending the select', async () => {
		offsetMinutes(-540);
		const client = new ArrayClient([row], { utcDates: false });
		const db = drizzle(client, { binding: 'literal' });

		await expect(db.select().from(events)).rejects.toThrow(NOT_UTC_MESSAGE);
		await expect(db.select({ n: sql`${events.at}`.mapWith(events.at) }).from(events)).rejects.toThrow(NOT_UTC_MESSAGE);
		await expect(
			db.select({ n: sql`${events.day}`.mapWith(events.day).as('n') }).from(events),
		).rejects.toThrow(NOT_UTC_MESSAGE);
		expect(client.statements).toEqual([]);
	});

	it('resolves the zone on the client before binding wraps it', async () => {
		offsetMinutes(-540);
		const client = new ArrayClient([[instant]], { utcDates: true });
		Object.assign(client, { queryPrepared: client.query.bind(client) });
		const db = drizzle(client);
		await expect(db.select({ at: events.at }).from(events)).resolves.toEqual([{ at: instant }]);
	});

	it('leaves non-temporal fields, raw sql and mapWith(Number) alone', async () => {
		offsetMinutes(-540);
		const client = new ArrayClient([[1, instant, 2]], { utcDates: false });
		const db = drizzle(client, { binding: 'literal' });

		const result = await db
			.select({ id: events.id, raw: sql<Date>`${events.at}`, n: sql`1`.mapWith(Number) })
			.from(events);

		expect(result).toEqual([{ id: 1, raw: instant, n: 2 }]);
		await expect(db.execute(sql`select 1`)).resolves.toBeDefined();
	});

	it('refuses a collection of a temporal element type with a local client', async () => {
		offsetMinutes(-540);
		const coll = cubridTable('coll', {
			id: int('id'),
			dts: cubridSequence<Date>('dts', { element: datetime('e') }),
			ints: cubridSequence<number>('ints', { element: int('e') }),
		});
		const client = new ArrayClient([[1, [instant]]], { utcDates: false });
		const db = drizzle(client, { binding: 'literal' });

		await expect(db.select().from(coll)).rejects.toThrow(NOT_UTC_MESSAGE);
		await expect(db.select({ id: coll.id, ints: coll.ints }).from(coll)).resolves.toEqual([{ id: 1, ints: [instant] }]);
	});

	it('writes a where() value with the column codec', () => {
		const db = drizzle(new ArrayClient([]), { binding: 'literal' });
		const query = db.select({ id: events.id }).from(events).where(eq(events.at, instant)).toSQL();
		expect(query.params).toEqual(['2024-01-02 03:04:05.678']);
	});

	describe('relational queries', () => {
		const schema = { events, eventsRelations: relations(events, () => ({})) };

		it('decode Dates from a UTC client', async () => {
			const client = new ArrayClient([row], { utcDates: true });
			const db = drizzle(client, { schema, mode: 'default', binding: 'literal' });
			const [result] = await db.query.events.findMany();
			expect(result?.atText).toBe('2024-01-02 03:04:05.678');
			expect(result?.day).toEqual(new Date(Date.UTC(2024, 1, 3)));
		});

		it('refuse Date cells from a local client outside UTC', async () => {
			offsetMinutes(-540);
			const client = new ArrayClient([row], { utcDates: false });
			const db = drizzle(client, { schema, mode: 'default', binding: 'literal' });
			await expect(db.query.events.findMany()).rejects.toThrow(NOT_UTC_MESSAGE);
		});

		it('pass rows without Dates', async () => {
			offsetMinutes(-540);
			const client = new ArrayClient([[1, null, null, null, null, null, null, null]], { utcDates: false });
			const db = drizzle(client, { schema, mode: 'default', binding: 'literal' });
			await expect(db.query.events.findFirst()).resolves.toMatchObject({ id: 1, at: null });
		});
	});
});
