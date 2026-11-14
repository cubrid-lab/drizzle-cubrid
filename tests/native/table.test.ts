// cubridTable(), table constraints and the test-only CREATE TABLE renderer (#157).
import { getTableColumns, getTableName, is, sql, Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createTableSql, quoteIdentifier } from '../../src/native/ddl';
import {
	bigint,
	boolean,
	CubridPrimaryKey,
	CubridTable,
	CubridUniqueConstraint,
	cubridTable,
	datetime,
	getTableConfig,
	integer,
	monetary,
	numeric,
	primaryKey,
	sequence,
	set,
	smallint,
	string,
	time,
	unique,
	varchar,
} from '../../src/native/index';

describe('cubridTable', () => {
	it('builds a Drizzle table with columns registered for neutral helpers', () => {
		const users = cubridTable('users', { id: integer().primaryKey(), name: varchar('user_name', { length: 20 }) });
		expect(users).toBeInstanceOf(CubridTable);
		expect(is(users, Table)).toBe(true);
		expect(getTableName(users)).toBe('users');
		expect(getTableColumns(users)).toEqual({ id: users.id, name: users.name });
		expect(users.id.table).toBe(users);
		expect(users.name.name).toBe('user_name');
		expect(users.id.primary).toBe(true);
		expect(users.id.notNull).toBe(true);
	});

	it('records autoIncrement, defaults and unique on the column', () => {
		const t = cubridTable('mods', {
			id: bigint({ mode: 'bigint' }).autoIncrement(),
			n: integer().default(3),
			fn: integer().$defaultFn(() => 4),
			u: varchar({ length: 3 }).unique('u_name'),
			v: varchar({ length: 3 }).unique(),
		});
		expect(t.id.autoIncrement).toBe(true);
		expect(t.id.hasDefault).toBe(true);
		expect(t.n.autoIncrement).toBe(false);
		expect(t.n.default).toBe(3);
		expect(t.fn.defaultFn?.()).toBe(4);
		expect([t.u.isUnique, t.u.uniqueName]).toEqual([true, 'u_name']);
		expect([t.v.isUnique, t.v.uniqueName]).toEqual([true, undefined]);
	});

	it('returns no constraints without extraConfig', () => {
		const t = cubridTable('plain', { a: integer() });
		expect(getTableConfig(t)).toEqual({ name: 'plain', columns: [t.a], primaryKeys: [], uniqueConstraints: [] });
	});

	it('calls extraConfig lazily with the built columns', () => {
		let calls = 0;
		const t = cubridTable('pairs', { a: integer().notNull(), b: varchar({ length: 5 }).notNull() }, (self) => {
			calls++;
			return [
				primaryKey({ name: 'pk_pairs', columns: [self.a, self.b] }),
				unique('u_ba').on(self.b, self.a),
				unique().on(self.b),
			];
		});
		expect(calls).toBe(0);
		const config = getTableConfig(t);
		expect(calls).toBe(1);
		expect(config.primaryKeys).toEqual([new CubridPrimaryKey([t.a, t.b], 'pk_pairs')]);
		expect(config.uniqueConstraints).toEqual([
			new CubridUniqueConstraint([t.b, t.a], 'u_ba'),
			new CubridUniqueConstraint([t.b], undefined),
		]);
	});

	it('refuses constraints on another table and unknown values', () => {
		const other = cubridTable('other', { x: integer() });
		const t = cubridTable('mine', { a: integer() }, () => [primaryKey({ columns: [other.x] })]);
		expect(() => getTableConfig(t)).toThrow(/Constraint on table mine names column x of another table/);
		// @ts-expect-error not a constraint
		const u = cubridTable('mine2', { a: integer() }, () => [{ columns: [] }]);
		expect(() => getTableConfig(u)).toThrow(/Unsupported table extra config value on table mine2/);
	});
});

describe('createTableSql (test-only DDL)', () => {
	it('renders every column type with modifiers', () => {
		const t = cubridTable('all_types', {
			id: integer().primaryKey().autoIncrement(),
			s: smallint().notNull().default(-1),
			b: bigint({ mode: 'bigint' }).default(9223372036854775807n),
			n: numeric({ precision: 38, scale: 10 }).default('0.5'),
			name: varchar({ length: 20 }).notNull().default("it's").unique(),
			code: varchar({ length: 2 }).unique('u_code'),
			note: string(),
			flag: boolean().notNull().default(false),
			at: datetime().default(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6))),
			clock: time().default('01:02:03'),
			price: monetary(),
			tags: set({ element: varchar({ length: 10 }) }),
			seq: sequence({ element: integer() }),
		});
		expect(createTableSql(t)).toBe(
			[
				'CREATE TABLE "all_types" (',
				'\t"id" INTEGER AUTO_INCREMENT NOT NULL PRIMARY KEY,',
				'\t"s" SMALLINT DEFAULT -1 NOT NULL,',
				'\t"b" BIGINT DEFAULT 9223372036854775807,',
				'\t"n" NUMERIC(38,10) DEFAULT \'0.5\',',
				"\t\"name\" VARCHAR(20) DEFAULT 'it''s' NOT NULL UNIQUE,",
				'\t"code" VARCHAR(2) CONSTRAINT "u_code" UNIQUE,',
				'\t"note" STRING,',
				'\t"flag" SMALLINT DEFAULT 0 NOT NULL,',
				'\t"at" DATETIME DEFAULT \'2024-01-02 03:04:05.006\',',
				'\t"clock" TIME DEFAULT \'01:02:03\',',
				'\t"price" MONETARY,',
				'\t"tags" SET(VARCHAR(10)),',
				'\t"seq" SEQUENCE(INTEGER)',
				')',
			].join('\n'),
		);
	});

	it('renders table constraints', () => {
		const t = cubridTable('pairs', { a: integer().notNull(), b: integer().notNull() }, (self) => [
			primaryKey({ name: 'pk_pairs', columns: [self.a, self.b] }),
			unique().on(self.b),
			unique('u_ab').on(self.a, self.b),
		]);
		expect(createTableSql(t)).toBe(
			[
				'CREATE TABLE "pairs" (',
				'\t"a" INTEGER NOT NULL,',
				'\t"b" INTEGER NOT NULL,',
				'\tCONSTRAINT "pk_pairs" PRIMARY KEY ("a", "b"),',
				'\tUNIQUE ("b"),',
				'\tCONSTRAINT "u_ab" UNIQUE ("a", "b")',
				')',
			].join('\n'),
		);
		const unnamed = cubridTable('p2', { a: integer() }, (self) => [primaryKey({ columns: [self.a] })]);
		expect(createTableSql(unnamed)).toContain('\tPRIMARY KEY ("a")');
	});

	it('refuses two primary keys', () => {
		const twoColumns = cubridTable('two', { a: integer().primaryKey(), b: integer().primaryKey() });
		expect(() => createTableSql(twoColumns)).toThrow(/declares more than one primary key/);
		const both = cubridTable('both', { a: integer().primaryKey() }, (self) => [primaryKey({ columns: [self.a] })]);
		expect(() => createTableSql(both)).toThrow(/more than one primary key/);
	});

	it('refuses defaults it cannot render', () => {
		const sqlDefault = cubridTable('d1', { a: integer().default(sql`1 + 1`) });
		expect(() => createTableSql(sqlDefault)).toThrow(
			/DEFAULT sql`…` on column a needs the native SQL compiler \(#158\)/,
		);
		const arrayDefault = cubridTable('d2', { tags: set({ element: integer() }).default([1]) });
		expect(() => createTableSql(arrayDefault)).toThrow(/DEFAULT for column tags cannot be rendered: object/);
	});

	it('double-quotes identifiers and refuses ones it cannot quote', () => {
		expect(quoteIdentifier('order')).toBe('"order"');
		expect(quoteIdentifier('한글')).toBe('"한글"');
		expect(() => quoteIdentifier('a"b')).toThrow(/cannot be double-quoted/);
		expect(() => quoteIdentifier('')).toThrow(/cannot be double-quoted/);
	});
});
