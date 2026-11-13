import { entityKind } from 'drizzle-orm/entity';
import { DefaultLogger, type Logger } from 'drizzle-orm/logger';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import { sql } from 'drizzle-orm/sql/sql';

import { int, varchar } from '../src/columns';
import { CubridDatabase, CubridDriver, drizzle } from '../src/driver';
import { type CubridQueryable, CubridSession } from '../src/session';
import { cubridTable } from '../src/table';

class MockClient implements CubridQueryable {
	queries: { sql: string; params?: readonly unknown[] }[] = [];

	async query<T extends Record<string, unknown>>(
		sqlText: string,
		params?: readonly unknown[],
	): Promise<T[]> {
		this.queries.push({ sql: sqlText, params });
		return [];
	}

	async queryPrepared<T extends Record<string, unknown>>(
		sqlText: string,
		params?: readonly unknown[],
	): Promise<T[]> {
		return this.query<T>(sqlText, params);
	}
}

const users = cubridTable('users', {
	id: int('id').primaryKey().autoincrement(),
	name: varchar('name', { length: 100 }),
});

function getSessionFromDb(db: CubridDatabase): CubridSession<Record<string, unknown>, never> {
	return (db as unknown as { session: CubridSession<Record<string, unknown>, never> }).session;
}

describe('drizzle()', () => {
	it('returns CubridDatabase instance and keeps $client reference', () => {
		const client = new MockClient();
		const db = drizzle(client);

		expect(db).toBeInstanceOf(CubridDatabase);
		expect(db.$client).toBe(client);
	});

	it('supports drizzle(client, config)', () => {
		const client = new MockClient();
		const db = drizzle(client, { mode: 'default', schema: { users } });

		expect(db).toBeInstanceOf(CubridDatabase);
		expect(db._.schema).toBeDefined();
		expect('users' in (db.query as object)).toBe(true);
	});

	it('uses DefaultLogger when logger=true', () => {
		const client = new MockClient();
		const db = drizzle(client, { logger: true });
		const session = getSessionFromDb(db);
		const sessionLogger = (session as unknown as { logger: Logger }).logger;

		expect(sessionLogger).toBeInstanceOf(DefaultLogger);
	});

	it('uses provided custom logger', async () => {
		const client = new MockClient();
		const customLogger: Logger = { logQuery: vi.fn() };
		const db = drizzle(client, { logger: customLogger });

		await db.execute(sql`select ${1}`);

		expect(customLogger.logQuery).toHaveBeenCalledTimes(1);
	});

	it('supports object config form drizzle({ client })', () => {
		const client = new MockClient();
		const db = drizzle({ client });

		expect(db).toBeInstanceOf(CubridDatabase);
		expect(db.$client).toBe(client);
	});

	it('supports object config with schema and mode', () => {
		const client = new MockClient();
		const db = drizzle({ client, schema: { users }, mode: 'default' });

		expect(db._.schema).toBeDefined();
		expect(db._.fullSchema).toEqual({ users });
	});

	it('throws for invalid config call without client', () => {
		const drizzleUnsafe = drizzle as unknown as (...args: unknown[]) => unknown;

		expect(() => drizzleUnsafe({ logger: true })).toThrow(
			'Invalid drizzle() call: provide `client` in config or pass a client as first argument',
		);
	});
});

describe('CubridDriver and CubridDatabase', () => {
	it('createSession() returns CubridSession', () => {
		const client = new MockClient();
		const dialect = new MySqlDialect({});
		const driver = new CubridDriver(client, dialect);

		const session = driver.createSession<Record<string, unknown>, never>(undefined, 'default');

		expect(session).toBeInstanceOf(CubridSession);
	});

	it('has entity kinds', () => {
		expect(CubridDatabase[entityKind]).toBe('CubridDatabase');
		expect(CubridDriver[entityKind]).toBe('CubridDriver');
	});
});
