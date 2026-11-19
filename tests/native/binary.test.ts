// binary() and varbinary() of drizzle-cubrid/native (#216): BIT(n*8) and
// BIT VARYING(n*8) columns read and written as Buffer values.
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
	binary,
	CubridBinary,
	CubridVarbinary,
	cubridTable,
	drizzle,
	generateInitialMigration,
	integer,
	sequence,
	set,
	varbinary,
} from '../../src/native/index';

// Node's Buffer; tests/native type-checks without Node types, as the library does.
declare const Buffer: {
	from(bytes: number[]): Uint8Array;
	isBuffer(value: unknown): boolean;
};

const t = cubridTable('blobs', {
	id: integer().primaryKey(),
	hash: binary('hash', { length: 4 }),
	data: varbinary({ length: 8 }),
	parts: set({ element: varbinary({ length: 2 }) }),
	blocks: sequence({ element: binary({ length: 2 }) }),
});

const bytes = (value: unknown) => [...(value as Uint8Array)];

/** A cubrid-client stand-in that records each call. */
function fakeClient() {
	const calls: { method: string; sql: string; params: readonly unknown[] | undefined }[] = [];
	const respond =
		(method: string) =>
		async (text: string, params?: readonly unknown[]): Promise<never> => {
			calls.push({ method, sql: text, params });
			return (method.startsWith('execute') ? { affectedRows: 1 } : []) as never;
		};
	return {
		calls,
		query: respond('query'),
		queryPrepared: respond('queryPrepared'),
		execute: respond('execute'),
		executePrepared: respond('executePrepared'),
	};
}

describe('SQL types and lengths', () => {
	it('declares the length in bytes and the column in bits', () => {
		expect(t.hash.getSQLType()).toBe('BIT(32)');
		expect(t.data.getSQLType()).toBe('BIT VARYING(64)');
		expect(t.parts.getSQLType()).toBe('SET(BIT VARYING(16))');
		expect(t.blocks.getSQLType()).toBe('SEQUENCE(BIT(16))');
		const hash: unknown = t.hash;
		const data: unknown = t.data;
		expect(hash instanceof CubridBinary && hash.length).toBe(4);
		expect(data instanceof CubridVarbinary && data.length).toBe(8);
		expect(t.hash.dataType).toBe('buffer');
	});

	it('requires a whole number of bytes within CUBRID’s BIT limit', () => {
		// @ts-expect-error length is required
		expect(() => binary('x')).toThrow(/binary\(\): length must be an integer number of bytes from 1 to 134217727/);
		expect(() => varbinary({ length: 0 })).toThrow(/varbinary\(\): length must be .* got number 0/);
		expect(() => varbinary({ length: 1.5 })).toThrow(TypeError);
		expect(() => binary({ length: 134217728 })).toThrow(/from 1 to 134217727/);
		expect(binary({ length: 134217727 }).build(t).getSQLType()).toBe('BIT(1073741816)');
	});

	it('renders the column types in generateInitialMigration()', () => {
		const text = generateInitialMigration({ t });
		expect(text).toContain('"hash" BIT(32)');
		expect(text).toContain('"data" BIT VARYING(64)');
		expect(text).toContain('"parts" SET(BIT VARYING(16))');
	});

	it('renders a bytes .default() as an X literal, padded and checked by the codec', () => {
		const withDefaults = cubridTable('defaults', {
			hash: binary({ length: 4 }).default(Buffer.from([0xab, 0x01])),
			data: varbinary({ length: 4 }).default(new Uint8Array([0, 0x0f])),
		});
		const text = generateInitialMigration({ withDefaults });
		expect(text).toContain(`"hash" BIT(32) DEFAULT X'ab010000'`);
		expect(text).toContain(`"data" BIT VARYING(32) DEFAULT X'000f'`);
		const tooLong = cubridTable('too_long', { hash: binary({ length: 1 }).default(Buffer.from([1, 2])) });
		expect(() => generateInitialMigration({ tooLong })).toThrow(/2 bytes, more than the column's 1/);
		const empty = cubridTable('empty', { data: varbinary({ length: 1 }).default(new Uint8Array(0)) });
		expect(() => generateInitialMigration({ empty })).toThrow(/is empty/);
		const text2 = cubridTable('text_default', { hash: binary({ length: 1 }).default('ab' as never) });
		expect(() => generateInitialMigration({ text2 })).toThrow(/must be a Buffer or Uint8Array/);
	});
});

describe('writes', () => {
	it('sends a Buffer as is, and a Uint8Array as a Buffer over the same bytes', () => {
		const buffer = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		expect(t.hash.mapToDriverValue(buffer)).toBe(buffer);
		const view = new Uint8Array([9, 1, 2, 3]).subarray(1, 3);
		const sent = t.data.mapToDriverValue(view);
		expect(Buffer.isBuffer(sent)).toBe(true);
		expect(bytes(sent)).toEqual([1, 2]);
	});

	it('pads a shorter BIT value with zero bytes, as the server stores it', () => {
		expect(bytes(t.hash.mapToDriverValue(Buffer.from([1, 2])))).toEqual([1, 2, 0, 0]);
		expect(bytes(t.hash.mapToDriverValue(new Uint8Array(0)))).toEqual([0, 0, 0, 0]);
		expect(Buffer.isBuffer(t.hash.mapToDriverValue(Buffer.from([1])))).toBe(true);
	});

	it('keeps a BIT VARYING value at its length', () => {
		expect(bytes(t.data.mapToDriverValue(Buffer.from([1, 2])))).toEqual([1, 2]);
	});

	it('refuses strings and other non-bytes, pointing to Buffer.from(hex)', () => {
		expect(() => t.hash.mapToDriverValue('cafe')).toThrow(
			`BIT(32) column value must be a Buffer or Uint8Array, got string "cafe"; for hex text pass Buffer.from(text, 'hex')`,
		);
		expect(() => t.data.mapToDriverValue([1, 2])).toThrow(/BIT VARYING\(64\) column value .* got an array$/);
		expect(() => t.data.mapToDriverValue(new ArrayBuffer(2))).toThrow(TypeError);
	});

	it('refuses a value longer than the column before sending it', () => {
		expect(() => t.hash.mapToDriverValue(Buffer.from([1, 2, 3, 4, 5]))).toThrow(
			"BIT(32) column value has 5 bytes, more than the column's 4 (32 bits)",
		);
		expect(() => t.data.mapToDriverValue(new Uint8Array(9))).toThrow(RangeError);
	});

	it('refuses an empty BIT VARYING value, which cubrid-client cannot bind', () => {
		expect(() => t.data.mapToDriverValue(new Uint8Array(0))).toThrow(
			"BIT VARYING(64) column value is empty: cubrid-client cannot bind an empty Buffer (it would be NULL); write sql`X''` for an empty value",
		);
	});

	it('encodes collection elements with the element codec', () => {
		const sent = t.parts.mapToDriverValue([Buffer.from([1]), null, new Uint8Array([2, 3])]) as unknown[];
		expect(sent.map((e) => (e === null ? null : bytes(e)))).toEqual([[1], null, [2, 3]]);
		expect(Buffer.isBuffer(sent[2])).toBe(true);
		expect(bytes((t.blocks.mapToDriverValue([Buffer.from([7])]) as unknown[])[0])).toEqual([7, 0]);
		expect(() => t.parts.mapToDriverValue([Buffer.from([1, 2, 3])])).toThrow(/3 bytes, more than the column's 2/);
		expect(() => t.parts.mapToDriverValue(['ab'])).toThrow(/must be a Buffer or Uint8Array/);
	});
});

describe('reads', () => {
	it('returns the driver Buffer unchanged', () => {
		const buffer = Buffer.from([1, 2, 0, 0]);
		expect(t.hash.mapFromDriverValue(buffer)).toBe(buffer);
		const empty = Buffer.from([]);
		expect(t.data.mapFromDriverValue(empty)).toBe(empty);
	});

	it('returns a Uint8Array from another client as a Buffer', () => {
		const read = t.data.mapFromDriverValue(new Uint8Array([5, 6]));
		expect(Buffer.isBuffer(read)).toBe(true);
		expect(bytes(read)).toEqual([5, 6]);
	});

	it('refuses anything else, strings included', () => {
		expect(() => t.hash.mapFromDriverValue('cafe')).toThrow(
			'BIT(32) value from the driver must be a Buffer, got string "cafe"',
		);
		expect(() => t.data.mapFromDriverValue(1)).toThrow(/BIT VARYING\(64\) value from the driver/);
	});

	it('decodes collection elements', () => {
		const read = t.parts.mapFromDriverValue([Buffer.from([1]), null]) as unknown[];
		expect(read.map((e) => (e === null ? null : bytes(e)))).toEqual([[1], null]);
	});
});

describe('statements', () => {
	it.each(['prepared', 'literal'] as const)('binds Buffer values under %s binding', async (binding) => {
		const client = fakeClient();
		const db = drizzle(client, { binding });
		await db.insert(t).values({ id: 1, hash: Buffer.from([1]), data: Buffer.from([2, 3]), parts: [Buffer.from([4])] });
		await db
			.select()
			.from(t)
			.where(eq(t.hash, Buffer.from([1])));
		const [insert, select] = client.calls;
		expect(insert?.sql).toBe(
			'insert into "blobs" ("id", "hash", "data", "parts", "blocks") values (?, ?, ?, CAST(SET{?} AS SET(BIT VARYING(16))), default)',
		);
		expect(insert?.params?.map((p) => (typeof p === 'number' ? p : bytes(p)))).toEqual([1, [1, 0, 0, 0], [2, 3], [4]]);
		expect(select?.sql).toMatch(/where "blobs"\."hash" = \?$/);
		expect(bytes(select?.params?.[0])).toEqual([1, 0, 0, 0]);
	});

	it("writes an empty BIT VARYING value with sql`X''`", async () => {
		const client = fakeClient();
		await drizzle(client).update(t).set({ data: sql`X''` });
		expect(client.calls[0]?.sql).toBe(`update "blobs" set "data" = X''`);
	});

	it('refuses a string before anything is sent', async () => {
		const client = fakeClient();
		const db = drizzle(client);
		expect(() =>
			db
				.insert(t)
				.values({ id: 1, hash: 'cafe' as never })
				.toSQL(),
		).toThrow(/must be a Buffer or Uint8Array/);
		expect(client.calls).toEqual([]);
	});
});
