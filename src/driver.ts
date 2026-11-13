import type { CubridClient } from 'cubrid-client';
import { entityKind } from 'drizzle-orm/entity';
import type { Logger } from 'drizzle-orm/logger';
import { DefaultLogger } from 'drizzle-orm/logger';
import { MySqlDatabase } from 'drizzle-orm/mysql-core/db';
import type { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { Mode } from 'drizzle-orm/mysql-core/session';
import {
	createTableRelationsHelpers,
	type ExtractTablesWithRelations,
	extractTablesRelationalConfig,
	type RelationalSchemaConfig,
	type TablesRelationalConfig,
} from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import { isConfig } from 'drizzle-orm/utils';

import { CubridDialect } from './dialect.js';
import {
	type CubridBinding,
	type CubridPreparedQueryHKT,
	type CubridQueryable,
	type CubridQueryResultHKT,
	CubridSession,
} from './session.js';

export interface CubridDriverOptions {
	logger?: Logger;
	binding?: CubridBinding;
}

export class CubridDriver {
	static readonly [entityKind] = 'CubridDriver';

	constructor(
		private client: CubridQueryable,
		private dialect: MySqlDialect,
		private options: CubridDriverOptions = {},
	) {}

	createSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>(
		schema: RelationalSchemaConfig<TSchema> | undefined,
		mode: Mode,
	): CubridSession<TFullSchema, TSchema> {
		return new CubridSession(this.client, this.dialect, schema, {
			logger: this.options.logger,
			mode,
			binding: this.options.binding,
		}) as CubridSession<TFullSchema, TSchema>;
	}
}

export class CubridDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends MySqlDatabase<
	CubridQueryResultHKT,
	CubridPreparedQueryHKT,
	TSchema
> {
	static override readonly [entityKind] = 'CubridDatabase';
}

export type CubridDrizzleConfig<TSchema extends Record<string, unknown> = Record<string, never>> = Omit<
	DrizzleConfig<TSchema>,
	'schema'
> & {
	/** How values reach the server; `'prepared'` (typed binds) by default. See {@link CubridBinding}. */
	binding?: CubridBinding;
} & (
		| {
				schema: TSchema;
				mode: Mode;
		  }
		| {
				schema?: undefined;
				mode?: Mode;
		  }
	);

type CubridConstructConfig<TSchema extends Record<string, unknown>> = CubridDrizzleConfig<TSchema>;

type DrizzleWithClient<
	TSchema extends Record<string, unknown>,
	TClient extends CubridQueryable,
> = CubridDatabase<TSchema> & { $client: TClient };

type DrizzleClientConfig<
	TSchema extends Record<string, unknown>,
	TClient extends CubridQueryable,
> = CubridConstructConfig<TSchema> & {
	client: TClient;
};

function construct<TSchema extends Record<string, unknown>, TClient extends CubridQueryable>(
	client: TClient,
	config: CubridConstructConfig<TSchema> = {},
): DrizzleWithClient<TSchema, TClient> {
	const dialect = new CubridDialect({ casing: config.casing });

	let logger: Logger | undefined;
	if (config.logger === true) {
		logger = new DefaultLogger();
	} else if (config.logger) {
		logger = config.logger;
	}

	let schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined;
	if (config.schema) {
		const tablesConfig = extractTablesRelationalConfig<ExtractTablesWithRelations<TSchema>>(
			config.schema,
			createTableRelationsHelpers,
		);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap,
		};
	}

	const mode = config.mode ?? 'default';
	const driver = new CubridDriver(client, dialect, { logger, binding: config.binding });
	const session = driver.createSession<TSchema, ExtractTablesWithRelations<TSchema>>(schema, mode);
	const db = new CubridDatabase(dialect, session, schema, mode);
	return Object.assign(db, { $client: client }) as DrizzleWithClient<TSchema, TClient>;
}

function isClientConfig<TSchema extends Record<string, unknown>, TClient extends CubridQueryable>(
	value: unknown,
): value is DrizzleClientConfig<TSchema, TClient> {
	return typeof value === 'object' && value !== null && 'client' in value;
}

export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends CubridQueryable = CubridClient,
>(client: TClient): DrizzleWithClient<TSchema, TClient>;
export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends CubridQueryable = CubridClient,
>(client: TClient, config: CubridDrizzleConfig<TSchema>): DrizzleWithClient<TSchema, TClient>;
export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends CubridQueryable = CubridClient,
>(config: DrizzleClientConfig<TSchema, TClient>): DrizzleWithClient<TSchema, TClient>;
export function drizzle<
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends CubridQueryable = CubridClient,
>(
	...params: [TClient] | [TClient, CubridDrizzleConfig<TSchema>] | [DrizzleClientConfig<TSchema, TClient>]
): DrizzleWithClient<TSchema, TClient> {
	if (isClientConfig<TSchema, TClient>(params[0])) {
		const { client, ...config } = params[0];
		return construct<TSchema, TClient>(client, config as CubridDrizzleConfig<TSchema>);
	}

	if (isConfig(params[0])) {
		throw new Error('Invalid drizzle() call: provide `client` in config or pass a client as first argument');
	}

	return construct<TSchema, TClient>(params[0] as TClient, params[1] as CubridDrizzleConfig<TSchema> | undefined);
}
