// Type inference of drizzle-cubrid/native (#157). Type-checked by vitest's
// typecheck mode with tests/native/tsconfig.json (see vitest.config.ts).
import { describe, expectTypeOf, it } from 'vitest';

import {
	bigint,
	binary,
	boolean,
	type CubridBytes,
	type CubridColumn,
	type CubridForeignKeyAction,
	type CubridForeignKeyUpdateAction,
	char,
	cubridTable,
	date,
	datetime,
	decimal,
	double,
	float,
	foreignKey,
	index,
	int,
	integer,
	monetary,
	multiset,
	numeric,
	primaryKey,
	sequence,
	set,
	smallint,
	string,
	time,
	timestamp,
	unique,
	uniqueIndex,
	varbinary,
	varchar,
} from '../../src/native/index';

const everything = cubridTable('everything', {
	id: integer().primaryKey().autoIncrement(),
	small: smallint('small_col'),
	whole: int().notNull(),
	big: bigint({ mode: 'bigint' }).notNull(),
	bigNum: bigint('big_num', { mode: 'number' }),
	exact: numeric({ precision: 38, scale: 10 }),
	exactNum: decimal('exact_num', { precision: 10, scale: 2, mode: 'number' }).notNull(),
	single: float(),
	dbl: double().default(1.5),
	code: char({ length: 3 }).notNull(),
	name: varchar('name', { length: 50 }).notNull().unique(),
	note: string(),
	active: boolean().notNull().default(true),
	at: datetime(),
	atText: datetime({ mode: 'string' }),
	stamp: timestamp()
		.notNull()
		.$defaultFn(() => new Date()),
	stampText: timestamp('stamp_text', { mode: 'string' }),
	day: date(),
	dayText: date({ mode: 'string' }),
	clock: time(),
	price: monetary(),
	tags: set({ element: varchar({ length: 20 }) }),
	counts: multiset('counts', { element: bigint({ mode: 'bigint' }) }).notNull(),
	flags: sequence({ element: boolean() }),
	times: sequence({ element: datetime({ mode: 'string' }) }),
});

describe('select model', () => {
	it('infers every builder, with nullability from notNull()', () => {
		expectTypeOf(everything.$inferSelect).toEqualTypeOf<{
			id: number;
			small: number | null;
			whole: number;
			big: bigint;
			bigNum: number | null;
			exact: string | null;
			exactNum: number;
			single: number | null;
			dbl: number | null;
			code: string;
			name: string;
			note: string | null;
			active: boolean;
			at: Date | null;
			atText: string | null;
			stamp: Date;
			stampText: string | null;
			day: Date | null;
			dayText: string | null;
			clock: string | null;
			price: string | null;
			tags: (string | null)[] | null;
			counts: (bigint | null)[];
			flags: (boolean | null)[] | null;
			times: (string | null)[] | null;
		}>();
	});

	it('rejects a wrong model', () => {
		// @ts-expect-error bigint mode 'bigint' is not number
		expectTypeOf(everything.$inferSelect.big).toEqualTypeOf<number>();
		// @ts-expect-error a nullable column is not just its type
		expectTypeOf(everything.$inferSelect.small).toEqualTypeOf<number>();
		// @ts-expect-error numeric defaults to string mode
		expectTypeOf(everything.$inferSelect.exact).toEqualTypeOf<number | null>();
		// @ts-expect-error collection elements may be null
		expectTypeOf(everything.$inferSelect.counts).toEqualTypeOf<bigint[]>();
	});
});

describe('insert model', () => {
	it('makes notNull columns required and default/autoIncrement/nullable optional', () => {
		expectTypeOf(everything.$inferInsert).toEqualTypeOf<{
			id?: number | undefined;
			small?: number | null | undefined;
			whole: number;
			big: bigint;
			bigNum?: number | null | undefined;
			exact?: string | null | undefined;
			exactNum: number;
			single?: number | null | undefined;
			dbl?: number | null | undefined;
			code: string;
			name: string;
			note?: string | null | undefined;
			active?: boolean | undefined;
			at?: Date | null | undefined;
			atText?: string | null | undefined;
			stamp?: Date | undefined;
			stampText?: string | null | undefined;
			day?: Date | null | undefined;
			dayText?: string | null | undefined;
			clock?: string | null | undefined;
			price?: string | null | undefined;
			tags?: (string | null)[] | null | undefined;
			counts: (bigint | null)[];
			flags?: (boolean | null)[] | null | undefined;
			times?: (string | null)[] | null | undefined;
		}>();
	});

	it('rejects a missing required column and wrong types', () => {
		// @ts-expect-error `whole`, `big`, `exactNum`, `code`, `name` and `counts` are required
		const missing: typeof everything.$inferInsert = {};
		// @ts-expect-error `id` is optional
		expectTypeOf(everything.$inferInsert.id).toEqualTypeOf<number>();
		const wrong: Partial<typeof everything.$inferInsert> = {
			// @ts-expect-error a number is not a bigint
			big: 1,
			// @ts-expect-error a string is not a Date
			at: '2024-01-01',
			// @ts-expect-error a number is not a boolean
			active: 1,
			// @ts-expect-error nested arrays are not elements
			tags: [['a']],
		};
		void missing;
		void wrong;
	});
});

describe('column names and modifiers', () => {
	it('uses the key as the name when no name is given', () => {
		expectTypeOf(everything.id._.name).toEqualTypeOf<'id'>();
		expectTypeOf(everything.small._.name).toEqualTypeOf<'small_col'>();
		expectTypeOf(everything.bigNum._.name).toEqualTypeOf<'big_num'>();
		expectTypeOf(everything.tags._.name).toEqualTypeOf<'tags'>();
		expectTypeOf(everything._.name).toEqualTypeOf<'everything'>();
	});

	it('marks autoIncrement and primaryKey in the column config', () => {
		expectTypeOf(everything.id._.isAutoincrement).toEqualTypeOf<true>();
		expectTypeOf(everything.id._.isPrimaryKey).toEqualTypeOf<true>();
		expectTypeOf(everything.id._.notNull).toEqualTypeOf<true>();
		expectTypeOf(everything.whole._.isAutoincrement).toEqualTypeOf<false>();
	});

	it('offers autoIncrement only on integer types', () => {
		smallint().autoIncrement();
		bigint({ mode: 'bigint' }).autoIncrement();
		bigint({ mode: 'number' }).autoIncrement();
		// @ts-expect-error not an integer type
		varchar({ length: 1 }).autoIncrement();
		// @ts-expect-error not an integer type
		double().autoIncrement();
	});

	it('keeps $type()', () => {
		const t = cubridTable('typed', { id: integer().$type<1 | 2>().notNull() });
		expectTypeOf(t.$inferSelect).toEqualTypeOf<{ id: 1 | 2 }>();
	});
});

describe('builder arguments', () => {
	it('refuses invalid configs', () => {
		// @ts-expect-error bigint needs a mode
		bigint('x');
		// @ts-expect-error unknown mode
		bigint('x', { mode: 'string' });
		// @ts-expect-error varchar needs a length
		varchar('x');
		// @ts-expect-error char needs a length
		char();
		// @ts-expect-error time has no mode
		time('x', { mode: 'date' });
		// @ts-expect-error numeric mode is string or number
		numeric({ mode: 'bigint' });
		// @ts-expect-error collections need an element
		set('x');
		// @ts-expect-error collections cannot be nested
		set({ element: set({ element: integer() }) });
	});
});

describe('table extra config', () => {
	it('passes the built columns to the callback', () => {
		const t = cubridTable('pairs', { a: integer().notNull(), b: varchar({ length: 5 }).notNull() }, (self) => {
			expectTypeOf(self.a._.name).toEqualTypeOf<'a'>();
			return [primaryKey({ columns: [self.a, self.b] }), unique('u_ab').on(self.b, self.a)];
		});
		expectTypeOf(t.$inferInsert).toEqualTypeOf<{ a: number; b: string }>();
	});
});

describe('indexes and foreign keys (#157)', () => {
	const parents = cubridTable('parents', { id: integer().primaryKey() });

	it('accepts indexes and foreign keys in extra config without changing the models', () => {
		const t = cubridTable(
			'children',
			{
				id: integer().primaryKey(),
				parentId: integer().references(() => parents.id, { onDelete: 'cascade', onUpdate: 'set null' }),
				self: integer().references((): CubridColumn => t.id),
				code: varchar({ length: 5 }).notNull(),
			},
			(self) => [
				index('ix_code').on(self.code),
				uniqueIndex('ux_parent_code').on(self.parentId, self.code),
				foreignKey({ name: 'fk_parent', columns: [self.parentId], foreignColumns: [parents.id] })
					.onDelete('no action')
					.onUpdate('restrict'),
			],
		);
		expectTypeOf(t.$inferSelect).toEqualTypeOf<{
			id: number;
			parentId: number | null;
			self: number | null;
			code: string;
		}>();
	});

	it('limits actions to what CUBRID has', () => {
		expectTypeOf<CubridForeignKeyAction>().toEqualTypeOf<'cascade' | 'restrict' | 'no action' | 'set null'>();
		expectTypeOf<CubridForeignKeyUpdateAction>().toEqualTypeOf<'restrict' | 'no action' | 'set null'>();
		const fk = foreignKey({ columns: [parents.id], foreignColumns: [parents.id] });
		// @ts-expect-error CUBRID has no SET DEFAULT
		fk.onDelete('set default');
		// @ts-expect-error CUBRID has no ON UPDATE CASCADE
		fk.onUpdate('cascade');
		// @ts-expect-error CUBRID has no ON UPDATE CASCADE
		integer().references(() => parents.id, { onUpdate: 'cascade' });
	});

	it('takes plain columns only, and at least one', () => {
		// @ts-expect-error at least one column
		index('ix').on();
		// @ts-expect-error not a column: descending and expression indexes are written by hand
		index('ix').on('id');
		// @ts-expect-error an index needs a name
		uniqueIndex();
		// @ts-expect-error foreign keys need at least one column on each side
		foreignKey({ columns: [], foreignColumns: [] });
		// @ts-expect-error no USING / WHERE builders
		index('ix').on(parents.id).where;
	});
});

describe('binary columns (#216)', () => {
	const files = cubridTable('files', {
		id: integer().primaryKey(),
		hash: binary({ length: 32 }).notNull(),
		data: varbinary('data', { length: 1024 }),
		parts: set({ element: varbinary({ length: 4 }) }),
	});

	it('reads and writes bytes: Buffer with Node types, Uint8Array without them', () => {
		// tests/native has no Node types, so CubridBytes is Uint8Array here;
		// a consumer with @types/node gets Buffer (scripts/packed-types-check.mjs
		// checks the packed tarball both ways in the Node 18 consumer jobs).
		expectTypeOf<CubridBytes>().toEqualTypeOf<Uint8Array>();
		expectTypeOf(files.$inferSelect).toEqualTypeOf<{
			id: number;
			hash: CubridBytes;
			data: CubridBytes | null;
			parts: (CubridBytes | null)[] | null;
		}>();
		expectTypeOf(files.$inferInsert).toEqualTypeOf<{
			id: number;
			hash: CubridBytes;
			data?: CubridBytes | null | undefined;
			parts?: (CubridBytes | null)[] | null | undefined;
		}>();
	});

	it('refuses strings and a missing length', () => {
		// @ts-expect-error a binary value is bytes, not hex text
		const row: typeof files.$inferInsert = { id: 1, hash: 'cafe' };
		expectTypeOf(row).not.toBeAny();
		// @ts-expect-error binary needs a length
		binary('x');
		// @ts-expect-error varbinary needs a length
		varbinary();
	});
});
