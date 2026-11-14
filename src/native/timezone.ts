// Whether a client decodes DATETIME, TIMESTAMP, DATE and TIME in UTC.
//
// Native date and time columns read the stored wall clock with UTC getters
// (see columns/temporal.ts). cubrid-client decodes those values with
// local-zone getters by default (`timezone: 'local'`), which matches only when
// the process zone is UTC, so a SELECT that reads one is refused for any other
// client before it is sent. This is the native counterpart of the 0.x guard
// (#207, #210) in src/timezone.ts. The duplication is deliberate (native code
// may not import 0.x modules): fix a bug in one in the other too.

/** How a client turns a stored wall clock into a `Date`. */
type ClientZone = 'utc' | 'local' | 'other';

export interface ZoneProbeClient {
	query(sql: string, params: readonly unknown[], options: { rowMode: 'array' }): Promise<unknown[]>;
}

/** Selects the same wall clock in winter and summer, so a zone with DST cannot pass for UTC. */
export const ZONE_PROBE_SQL = "SELECT DATETIME'2000-01-01 00:00:00', DATETIME'2000-07-01 00:00:00'";

/** cubrid-client's classes whose private `config` holds the `timezone` option. */
const CUBRID_CLIENT_CLASSES = new Set(['CubridClient', 'CubridPool']);

const zoneCache = new WeakMap<object, Promise<ClientZone>>();

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function zoneOfSetting(timezone: unknown): ClientZone {
	if (timezone === 'utc') return 'utc';
	// cubrid-client's default when `timezone` is not given.
	return timezone === undefined || timezone === 'local' ? 'local' : 'other';
}

/**
 * The zone a client declares, without a round trip: a public `timezone`
 * string, a boolean `utcDates`, or the fields cubrid-client 1.4 keeps
 * (`config.timezone` on `CubridClient`/`CubridPool`, `connection.utcDates` on
 * their transaction clients).
 */
export function declaredClientZone(client: object): ClientZone | undefined {
	const fields = client as Record<string, unknown>;
	if (typeof fields.timezone === 'string') return zoneOfSetting(fields.timezone);
	if (typeof fields.utcDates === 'boolean') return fields.utcDates ? 'utc' : 'local';
	const config = fields.config;
	if (
		isObject(config) &&
		(config.timezone === undefined || typeof config.timezone === 'string') &&
		// cubrid-client leaves `timezone` out of the config when it was not given.
		('timezone' in config || CUBRID_CLIENT_CLASSES.has(client.constructor?.name))
	) {
		return zoneOfSetting(config.timezone);
	}
	const connection = fields.connection;
	if (isObject(connection) && typeof connection.utcDates === 'boolean') {
		return connection.utcDates ? 'utc' : 'local';
	}
	return undefined;
}

function sameInstant(value: unknown, time: number): boolean {
	return value instanceof Date && value.getTime() === time;
}

/** Reads two known wall clocks and compares them with their local and UTC instants. */
async function probeClientZone(client: ZoneProbeClient): Promise<ClientZone> {
	const rows = await client.query(ZONE_PROBE_SQL, [], { rowMode: 'array' });
	const row = rows[0];
	const [winter, summer] = Array.isArray(row) ? row : [];
	// Local first: in a UTC process both match, and 'local' keeps the answer
	// tied to the process zone, which is checked on every read.
	if (sameInstant(winter, new Date(2000, 0, 1).getTime()) && sameInstant(summer, new Date(2000, 6, 1).getTime())) {
		return 'local';
	}
	if (sameInstant(winter, Date.UTC(2000, 0, 1)) && sameInstant(summer, Date.UTC(2000, 6, 1))) return 'utc';
	return 'other';
}

function resolveClientZone(client: ZoneProbeClient): Promise<ClientZone> {
	const declared = declaredClientZone(client);
	if (declared !== undefined) return Promise.resolve(declared);
	let zone = zoneCache.get(client);
	if (zone === undefined) {
		zone = probeClientZone(client);
		zoneCache.set(client, zone);
		// A failed probe is tried again on the next read.
		zone.catch(() => zoneCache.delete(client));
	}
	return zone;
}

/** Whether the process zone is UTC now; not cached, as `process.env.TZ` can change. */
export function isProcessZoneUtc(): boolean {
	const year = new Date().getFullYear();
	const earliest = new Date(0);
	earliest.setFullYear(1, 0, 1);
	return [new Date(year, 0, 1), new Date(year, 6, 1), earliest].every((d) => d.getTimezoneOffset() === 0);
}

export const NOT_UTC_MESSAGE =
	"drizzle-cubrid/native reads DATETIME, TIMESTAMP, DATE and TIME columns as a UTC wall clock, but this client decodes them in the process's local time zone, which is not UTC. Create the client with timezone: 'utc' (cubrid-client: createClient({ ..., timezone: 'utc' })) or run the process with TZ=UTC";

/** Refuses a client whose `Date`s are not the stored wall clock read as UTC. */
export async function assertUtcDecoding(client: ZoneProbeClient): Promise<void> {
	const zone = await resolveClientZone(client);
	if (zone === 'utc' || (zone === 'local' && isProcessZoneUtc())) return;
	throw new Error(NOT_UTC_MESSAGE);
}
