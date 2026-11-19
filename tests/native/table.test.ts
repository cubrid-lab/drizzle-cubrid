// cubridTable(), table constraints and the test-only CREATE TABLE renderer (#157).
import { getTableColumns, getTableName, is, sql, Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createIndexSql, createTableSql } from '../../src/native/ddl';
import { quoteIdentifier } from '../../src/native/dialect';
import {
	bigint,
	boolean,
	type CubridColumn,
	CubridForeignKey,
	CubridIndex,
	CubridPrimaryKey,
	CubridTable,
	CubridUniqueConstraint,
	cubridTable,
	datetime,
	foreignKey,
	generateInitialMigration,
	getTableConfig,
	index,
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
	uniqueIndex,
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
		expect(getTableConfig(t)).toEqual({
			name: 'plain',
			columns: [t.a],
			primaryKeys: [],
			uniqueConstraints: [],
			foreignKeys: [],
			indexes: [],
		});
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

	it('double-quotes identifiers, doubling embedded quotes', () => {
		expect(quoteIdentifier('order')).toBe('"order"');
		expect(quoteIdentifier('한글')).toBe('"한글"');
		expect(quoteIdentifier('a"b')).toBe('"a""b"');
		expect(createTableSql(cubridTable('we"ird', { 'co"l': integer() }))).toBe(
			'CREATE TABLE "we""ird" (\n\t"co""l" INTEGER\n)',
		);
		expect(() => quoteIdentifier('')).toThrow(/cannot be empty/);
	});
});

describe('indexes (#157)', () => {
	const posts = cubridTable(
		'posts',
		{ id: integer().primaryKey(), author: integer().notNull(), slug: varchar({ length: 40 }).notNull() },
		(t) => [index('ix_posts_author').on(t.author), uniqueIndex('ux_posts_author_slug').on(t.author, t.slug)],
	);

	it('reads indexes back with getTableConfig in declaration order', () => {
		expect(getTableConfig(posts).indexes).toEqual([
			new CubridIndex('ix_posts_author', [posts.author], false),
			new CubridIndex('ux_posts_author_slug', [posts.author, posts.slug], true),
		]);
	});

	it('renders one CREATE [UNIQUE] INDEX per index, outside CREATE TABLE', () => {
		expect(createIndexSql(posts)).toEqual([
			'CREATE INDEX "ix_posts_author" ON "posts" ("author")',
			'CREATE UNIQUE INDEX "ux_posts_author_slug" ON "posts" ("author", "slug")',
		]);
		expect(createTableSql(posts)).not.toContain('INDEX');
		expect(createIndexSql(cubridTable('none', { a: integer() }))).toEqual([]);
		expect(createIndexSql(cubridTable('we"ird', { 'co"l': integer() }, (t) => [index('i"x').on(t['co"l'])]))).toEqual([
			'CREATE INDEX "i""x" ON "we""ird" ("co""l")',
		]);
	});

	it('refuses an index without a name or columns, on expressions and on another table', () => {
		const t = cubridTable('t', { a: integer() });
		// @ts-expect-error an index needs a name
		expect(() => index()).toThrow(/An index needs a name/);
		expect(() => uniqueIndex('')).toThrow(/An index needs a name/);
		// @ts-expect-error at least one column
		expect(() => index('ix').on()).toThrow(/Index ix needs at least one column/);
		// @ts-expect-error descending, function-based and filtered indexes are not built
		expect(() => index('ix').on(sql`${t.a} desc`)).toThrow(/takes table columns only; write descending/);
		const other = cubridTable('other', { a: integer() }, () => [index('ix').on(t.a)]);
		expect(() => getTableConfig(other)).toThrow(/Constraint on table other names column a of another table/);
	});

	it('refuses index and constraint names a table repeats, ignoring case', () => {
		const t = cubridTable('dups', { a: integer(), b: integer() }, (self) => [
			unique('Name_A').on(self.a),
			index('name_a').on(self.b),
		]);
		expect(() => getTableConfig(t)).toThrow(
			/Table dups uses the index or constraint name name_a twice \(unique constraint Name_A \(a\) and index name_a \(b\)\)/,
		);
		const column = cubridTable('dups2', { a: integer().unique('u_a'), b: integer() }, (self) => [
			index('U_A').on(self.b),
		]);
		expect(() => getTableConfig(column)).toThrow(/Table dups2 uses the index or constraint name U_A twice/);
	});

	it('counts the names CUBRID gives unnamed keys: pk_/u_/fk_<table>_<columns>, in lower case', () => {
		const parent = cubridTable('par', { id: integer().primaryKey() });
		const q = (extra: (t: { id: CubridColumn; e: CubridColumn; u: CubridColumn; x: CubridColumn }) => CubridIndex) =>
			cubridTable(
				'Q',
				{
					id: integer().primaryKey(),
					e: integer().unique(),
					u: integer().references(() => parent.id),
					x: integer(),
				},
				(t) => [extra(t)],
			);
		for (const name of ['pk_q_id', 'U_Q_E', 'fk_q_u']) {
			expect(() => getTableConfig(q((t) => index(name).on(t.x)))).toThrow(
				new RegExp(`Table Q uses the index or constraint name ${name} twice`),
			);
		}
		const composite = cubridTable('c', { a: integer().notNull(), b: integer().notNull(), x: integer() }, (t) => [
			primaryKey({ columns: [t.a, t.b] }),
			unique().on(t.b, t.a),
			index('u_c_b_a').on(t.x),
		]);
		expect(() => getTableConfig(composite)).toThrow(/name u_c_b_a twice \(unique constraint \(b, a\) and index/);
		// A named key frees its generated name.
		const named = cubridTable('n', { id: integer(), x: integer() }, (t) => [
			primaryKey({ name: 'pk_n', columns: [t.id] }),
			index('pk_n_id').on(t.x),
		]);
		expect(getTableConfig(named).indexes).toHaveLength(1);
	});

	it('refuses an index on the same ordered columns as a key CUBRID would clash with (-272)', () => {
		const parent = cubridTable('par', { id: integer().primaryKey() });
		const make = (
			extra: (t: Record<'id' | 'e' | 'a' | 'b' | 'f' | 'p', CubridColumn>) => (CubridIndex | CubridUniqueConstraint)[],
		) =>
			cubridTable(
				'k',
				{
					id: integer().primaryKey(),
					e: integer().unique(),
					a: integer(),
					b: integer(),
					f: integer(),
					p: integer().references(() => parent.id),
				},
				(t) => [unique().on(t.a, t.b), ...extra(t)],
			);
		const refused: [
			string,
			(t: Record<'id' | 'e' | 'a' | 'b' | 'f' | 'p', CubridColumn>) => (CubridIndex | CubridUniqueConstraint)[],
			RegExp,
		][] = [
			[
				'index on the primary key',
				(t) => [index('i').on(t.id)],
				/index i \(id\) on the same columns, in the same order, as primary key \(id\); CUBRID refuses that \(-272\)/,
			],
			['index on a column .unique()', (t) => [index('i').on(t.e)], /index i \(e\) .* as unique constraint \(e\)/],
			['index on a unique()', (t) => [index('i').on(t.a, t.b)], /index i \(a, b\) .* as unique constraint \(a, b\)/],
			['two indexes', (t) => [index('i').on(t.f), index('j').on(t.f)], /index j \(f\) .* as index i \(f\)/],
			[
				'index after a unique index',
				(t) => [uniqueIndex('u').on(t.f), index('i').on(t.f)],
				/index i \(f\) .* as unique index u \(f\)/,
			],
			[
				'unique index after an index',
				(t) => [index('i').on(t.f), uniqueIndex('u').on(t.f)],
				/unique index u \(f\) .* as index i \(f\)/,
			],
			[
				'unique index on a foreign key',
				(t) => [uniqueIndex('u').on(t.p)],
				/unique index u \(p\) .* as foreign key \(p\)/,
			],
			['two unique constraints', (t) => [unique().on(t.e)], /unique constraint \(e\) .* as unique constraint \(e\)/],
		];
		for (const [label, extra, message] of refused) {
			expect(() => getTableConfig(make(extra)), label).toThrow(message);
		}
		const accepted: [
			string,
			(t: Record<'id' | 'e' | 'a' | 'b' | 'f' | 'p', CubridColumn>) => (CubridIndex | CubridUniqueConstraint)[],
		][] = [
			['an index on the same columns in another order', (t) => [index('i').on(t.b, t.a)]],
			['a unique index on the same columns in another order', (t) => [uniqueIndex('u').on(t.b, t.a)]],
			['a unique index on the primary key', (t) => [uniqueIndex('u').on(t.id)]],
			[
				'a unique index on a unique column and constraint',
				(t) => [uniqueIndex('u').on(t.e), uniqueIndex('v').on(t.a, t.b)],
			],
			['two unique indexes', (t) => [uniqueIndex('u').on(t.f), uniqueIndex('v').on(t.f)]],
			['an index on a foreign key', (t) => [index('i').on(t.p)]],
			['an index on part of a key', (t) => [index('i').on(t.a)]],
		];
		for (const [label, extra] of accepted) {
			expect(() => getTableConfig(make(extra)), label).not.toThrow();
		}
		const twoForeignKeys = cubridTable('two', {
			p: integer()
				.references(() => parent.id)
				.references(() => parent.id, { onDelete: 'cascade' }),
		});
		expect(() => getTableConfig(twoForeignKeys)).toThrow(/foreign key \(p\) .* as foreign key \(p\)/);
		const uniqueOnPrimaryAndForeign = cubridTable('ok', {
			id: integer()
				.primaryKey()
				.unique()
				.references(() => parent.id),
		});
		expect(() => getTableConfig(uniqueOnPrimaryAndForeign)).not.toThrow();
	});
});

describe('foreign keys (#157)', () => {
	const users = cubridTable('users', { id: integer().primaryKey(), name: varchar({ length: 20 }) });
	const pairs = cubridTable('pairs', { a: integer().notNull(), b: integer().notNull() }, (t) => [
		primaryKey({ columns: [t.a, t.b] }),
	]);

	it('renders column .references() and table foreignKey() as table constraints with their actions', () => {
		const posts = cubridTable(
			'posts',
			{
				id: integer().primaryKey(),
				author: integer().references(() => users.id, { onDelete: 'cascade' }),
				editor: integer().references(() => users.id, { onDelete: 'set null', onUpdate: 'no action' }),
				pa: integer().notNull(),
				pb: integer().notNull(),
			},
			(t) => [
				foreignKey({ name: 'fk_posts_pair', columns: [t.pa, t.pb], foreignColumns: [pairs.b, pairs.a] })
					.onDelete('restrict')
					.onUpdate('restrict'),
			],
		);
		expect(createTableSql(posts)).toBe(
			[
				'CREATE TABLE "posts" (',
				'\t"id" INTEGER NOT NULL PRIMARY KEY,',
				'\t"author" INTEGER,',
				'\t"editor" INTEGER,',
				'\t"pa" INTEGER NOT NULL,',
				'\t"pb" INTEGER NOT NULL,',
				'\tFOREIGN KEY ("author") REFERENCES "users" ("id") ON DELETE CASCADE,',
				'\tFOREIGN KEY ("editor") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION,',
				'\tCONSTRAINT "fk_posts_pair" FOREIGN KEY ("pa", "pb") REFERENCES "pairs" ("b", "a") ON DELETE RESTRICT ON UPDATE RESTRICT',
				')',
			].join('\n'),
		);
		const [author, , pair] = getTableConfig(posts).foreignKeys;
		expect(author).toBeInstanceOf(CubridForeignKey);
		expect(author!.getReference()).toEqual({ columns: [posts.author], foreignColumns: [users.id] });
		expect([author!.name, author!.onDeleteAction, author!.onUpdateAction]).toEqual([undefined, 'cascade', undefined]);
		expect([pair!.name, pair!.onDeleteAction, pair!.onUpdateAction]).toEqual(['fk_posts_pair', 'restrict', 'restrict']);
	});

	it('resolves .references() lazily, so a table may reference itself or a later table', () => {
		const nodes = cubridTable('nodes', {
			id: integer().primaryKey(),
			parent: integer().references((): CubridColumn => nodes.id, { onDelete: 'cascade' }),
			owner: integer().references(() => owners.id),
		});
		const owners = cubridTable('owners', { id: integer().primaryKey() });
		expect(createTableSql(nodes)).toContain('FOREIGN KEY ("parent") REFERENCES "nodes" ("id") ON DELETE CASCADE');
		expect(createTableSql(nodes)).toContain('FOREIGN KEY ("owner") REFERENCES "owners" ("id")');
	});

	it('refuses actions CUBRID does not have, at type level and at runtime', () => {
		const t = cubridTable('t', { a: integer() });
		// @ts-expect-error CUBRID has no SET DEFAULT
		expect(() => foreignKey({ columns: [t.a], foreignColumns: [users.id] }).onDelete('set default')).toThrow(
			/ON DELETE "set default" is not supported by CUBRID; use one of 'cascade', 'restrict', 'no action', 'set null'/,
		);
		// @ts-expect-error CUBRID has no ON UPDATE CASCADE
		expect(() => foreignKey({ columns: [t.a], foreignColumns: [users.id] }).onUpdate('cascade')).toThrow(
			/ON UPDATE "cascade" is not supported by CUBRID; use one of 'restrict', 'no action', 'set null'/,
		);
		expect(() =>
			cubridTable('bad', {
				// @ts-expect-error CUBRID has no ON UPDATE CASCADE
				a: integer().references(() => users.id, { onUpdate: 'cascade' }),
			}),
		).toThrow(/ON UPDATE "cascade" is not supported by CUBRID/);
	});

	it('refuses keys CUBRID would reject', () => {
		const fk = (name: string, build: (t: { a: CubridColumn; b: CubridColumn }) => CubridForeignKey) =>
			cubridTable(name, { a: integer(), b: integer().notNull() }, (t) => [build(t)]);
		const mismatched = fk('m', (t) => foreignKey({ columns: [t.a, t.b], foreignColumns: [users.id] }));
		expect(() => getTableConfig(mismatched)).toThrow(/needs as many columns as foreign columns/);
		const repeatedForeign = fk('rf', (t) => foreignKey({ columns: [t.a, t.b], foreignColumns: [pairs.a, pairs.a] }));
		expect(() => getTableConfig(repeatedForeign)).toThrow(/Foreign key on table rf names a column twice/);
		const repeated = fk('rc', (t) => foreignKey({ columns: [t.a, t.a], foreignColumns: [pairs.a, pairs.b] }));
		expect(() => getTableConfig(repeated)).toThrow(/Foreign key on table rc names a column twice/);
		const twoTables = fk('tt', (t) => foreignKey({ columns: [t.a, t.b], foreignColumns: [users.id, pairs.a] }));
		expect(() => getTableConfig(twoTables)).toThrow(/references columns of more than one table/);
		const notKey = fk('nk', (t) => foreignKey({ name: 'fk_nk', columns: [t.a], foreignColumns: [users.name] }));
		expect(() => createTableSql(notKey)).toThrow(
			/Foreign key fk_nk on table nk must reference the primary key of table users \(id\): CUBRID refuses/,
		);
		const partial = fk('pk', (t) => foreignKey({ columns: [t.a], foreignColumns: [pairs.a] }));
		expect(() => createTableSql(partial)).toThrow(/must reference the primary key of table pairs \(a, b\)/);
		const setNull = fk('sn', (t) => foreignKey({ columns: [t.b], foreignColumns: [users.id] }).onDelete('set null'));
		expect(() => createTableSql(setNull)).toThrow(
			/Foreign key on table sn sets column b to NULL, but the column is NOT NULL/,
		);
		const other = cubridTable('o', { a: integer() });
		const foreignColumn = fk('fc', () => foreignKey({ columns: [other.a], foreignColumns: [users.id] }));
		expect(() => getTableConfig(foreignColumn)).toThrow(/Constraint on table fc names column a of another table/);
	});
});

describe('generateInitialMigration with indexes and foreign keys (#157)', () => {
	const users = cubridTable('users', { id: integer().primaryKey(), email: varchar({ length: 50 }) }, (t) => [
		uniqueIndex('ux_users_email').on(t.email),
	]);
	const posts = cubridTable(
		'posts',
		{ id: integer().primaryKey(), author: integer().references(() => users.id), tag: integer() },
		(t) => [index('ix_posts_tag').on(t.tag), foreignKey({ columns: [t.tag], foreignColumns: [tags.id] })],
	);
	const tags = cubridTable('tags', { id: integer().primaryKey() });

	it('puts referenced tables first and each table’s indexes after it, deterministically', () => {
		const expected = [
			'-- Initial schema, generated by generateInitialMigration() from drizzle-cubrid/native.',
			'',
			'CREATE TABLE "users" (\n\t"id" INTEGER NOT NULL PRIMARY KEY,\n\t"email" VARCHAR(50)\n);',
			'CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");',
			'',
			'CREATE TABLE "tags" (\n\t"id" INTEGER NOT NULL PRIMARY KEY\n);',
			'',
			'CREATE TABLE "posts" (',
			'\t"id" INTEGER NOT NULL PRIMARY KEY,',
			'\t"author" INTEGER,',
			'\t"tag" INTEGER,',
			'\tFOREIGN KEY ("author") REFERENCES "users" ("id"),',
			'\tFOREIGN KEY ("tag") REFERENCES "tags" ("id")',
			');',
			'CREATE INDEX "ix_posts_tag" ON "posts" ("tag");',
			'',
		].join('\n');
		expect(generateInitialMigration({ posts, users, tags })).toBe(expected);
		const order = (sql: string) => [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
		expect(order(generateInitialMigration([tags, posts, users]))).toEqual(['tags', 'users', 'posts']);
		// Without foreign keys between them, the given order is kept.
		const a = cubridTable('a', { id: integer() });
		const b = cubridTable('b', { id: integer() });
		expect(order(generateInitialMigration([b, a]))).toEqual(['b', 'a']);
	});

	it('keeps a self-reference inside its table', () => {
		const nodes = cubridTable('nodes', {
			id: integer().primaryKey(),
			parent: integer().references((): CubridColumn => nodes.id),
		});
		expect(generateInitialMigration([nodes])).toContain('FOREIGN KEY ("parent") REFERENCES "nodes" ("id")');
	});

	it('refuses a referenced table outside the schema and cycles between tables', () => {
		expect(() => generateInitialMigration({ posts, users })).toThrow(
			/Table posts has a foreign key to table tags, which is not in the schema/,
		);
		const x = cubridTable('x', { id: integer().primaryKey(), y: integer().references((): CubridColumn => y.id) });
		const y = cubridTable('y', { id: integer().primaryKey(), z: integer().references((): CubridColumn => z.id) });
		const z = cubridTable('z', { id: integer().primaryKey(), x: integer().references((): CubridColumn => x.id) });
		expect(() => generateInitialMigration([x, y, z])).toThrow(
			/Foreign keys form a cycle between tables x -> y -> z -> x; declare one of them in a later migration with ALTER TABLE/,
		);
	});
});
