// The native session: how statements reach cubrid-client (#160).

import type { Logger } from 'drizzle-orm';
import { describeValue } from './columns/common.js';
import { assertUtcDecoding } from './timezone.js';

/**
 * How statement values reach the server.
 *
 * - `'prepared'` (default): typed binds through cubrid-client's
 *   `queryPrepared()`, so no value ever becomes SQL text.
 * - `'literal'`: cubrid-client writes each value into the SQL text as an
 *   escaped literal (`query()`), one round trip fewer per statement.
 */
export type CubridBinding = 'prepared' | 'literal';

/** Statement options this session passes: positional rows for SELECTs. */
export interface CubridArrayRowOptions {
	rowMode: 'array';
}

/**
 * What the native session needs from a client: `CubridClient`, `CubridPool`
 * and their transaction clients from cubrid-client 1.4 provide it.
 */
export interface CubridNativeClient {
	query(sql: string, params?: readonly unknown[], options?: CubridArrayRowOptions): Promise<unknown[]>;
	queryPrepared?(sql: string, params?: readonly unknown[], options?: CubridArrayRowOptions): Promise<unknown[]>;
}

const ARRAY_ROWS: CubridArrayRowOptions = { rowMode: 'array' };

export interface CubridSessionOptions {
	logger?: Logger;
	binding?: CubridBinding;
}

export class CubridSession {
	readonly binding: CubridBinding;

	constructor(
		readonly client: CubridNativeClient,
		private readonly options: CubridSessionOptions = {},
	) {
		const binding = options.binding ?? 'prepared';
		if (binding !== 'prepared' && binding !== 'literal') {
			throw new Error(`Unknown binding ${describeValue(binding)}; use 'prepared' or 'literal'`);
		}
		if (typeof client?.query !== 'function') {
			throw new TypeError('drizzle-cubrid/native needs a cubrid-client client or pool, with query()');
		}
		if (binding === 'prepared' && typeof client.queryPrepared !== 'function') {
			throw new Error(
				"The CUBRID client has no queryPrepared() for typed binding (cubrid-client 1.3.0 or later); pass { binding: 'literal' } to drizzle() to send values as SQL literals",
			);
		}
		this.binding = binding;
	}

	private run(sql: string, params: unknown[], options?: CubridArrayRowOptions): Promise<unknown[]> {
		const index = params.findIndex(Array.isArray);
		if (index >= 0) {
			// cubrid-client cannot bind an array; a collection value needs the typed
			// collection literal (#159), and a list needs one placeholder per value.
			return Promise.reject(
				new TypeError(
					`Parameter ${index + 1} is an array, which cannot be bound; collection values need #159, and inArray() takes a list of values, not one placeholder`,
				),
			);
		}
		this.options.logger?.logQuery(sql, params);
		// Driver errors are passed through unchanged, with their code, kind and cause.
		if (this.binding === 'literal') return this.client.query(sql, params, options);
		const prepared = this.client.queryPrepared;
		return prepared ? prepared.call(this.client, sql, params, options) : this.client.query(sql, params, options);
	}

	/**
	 * Rows of a SELECT as arrays in select-list order. With `readsTemporal`,
	 * a client that does not decode date and time values in UTC is refused
	 * before the statement is sent.
	 */
	async selectRows(sql: string, params: unknown[], readsTemporal: boolean): Promise<unknown[]> {
		if (readsTemporal) await assertUtcDecoding(this.client);
		return this.run(sql, params, ARRAY_ROWS);
	}

	/** Rows of a raw statement as cubrid-client returns them. */
	rawRows(sql: string, params: unknown[]): Promise<unknown[]> {
		return this.run(sql, params);
	}
}
