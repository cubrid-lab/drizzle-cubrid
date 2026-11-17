# `drizzle-cubrid/native` (experimental preview)

> **Preview, not for production.** `drizzle-cubrid/native` is the first slice
> of the CUBRID-native dialect ([ADR 0003](adr/0003-native-architecture-boundaries.md),
> [ADR 0007](adr/0007-drizzle-extension-boundary.md)). Its API can change in
> any release. The supported API is still the root `drizzle-cubrid` entry.

## What it provides today

- `cubridTable(name, columns, extraConfig?)`: a typed table on Drizzle's
  database-neutral `Table`, with `$inferSelect` and `$inferInsert`.
- Column builders with CUBRID names, CUBRID SQL types (`getSQLType()`) and
  codecs (`mapToDriverValue()` / `mapFromDriverValue()`) for the values
  cubrid-client 1.x sends and returns.
- Table constraints in `extraConfig`: `primaryKey({ name?, columns })` and
  `unique(name?).on(...columns)`, read back with `getTableConfig(table)`.
- `collectionLiteralSql(column, count)`: the typed literal a statement uses to
  write a collection (see [Collections](#collections)).
- `drizzle(client)` with `db.select()`, `db.selectDistinct()` and
  `db.execute()` (see [Queries](#queries)), and `db.insert()`, `db.update()`
  and `db.delete()` (see [Writes](#writes-insert-update-delete)).

**Not yet:** transactions through Drizzle
(#161; use cubrid-client's `transaction()` and pass its client to `drizzle()`),
relational queries (`db.query`), set operations (`union` and friends),
scalar subqueries as selected fields, migrations or DDL generation (#163), and
indexes or foreign keys in `extraConfig`. Native tables are not supported by
the 0.x `drizzle()` from `drizzle-cubrid`.

```ts
import { bigint, cubridTable, integer, primaryKey, set, varchar } from 'drizzle-cubrid/native';

export const users = cubridTable('users', {
  id: integer().primaryKey().autoIncrement(), // column name "id" (the key)
  name: varchar('user_name', { length: 50 }).notNull(),
  visits: bigint({ mode: 'bigint' }).notNull().default(0n),
  tags: set({ element: varchar({ length: 20 }) }),
});

type User = typeof users.$inferSelect;
// { id: number; name: string; visits: bigint; tags: (string | null)[] | null }

export const memberships = cubridTable(
  'memberships',
  { userId: integer().notNull(), groupId: integer().notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
);
```

A builder called without a name takes its key in the table as the column
name. Every builder has Drizzle's neutral modifiers `.notNull()`,
`.default()`, `.$defaultFn()`, `.$onUpdateFn()`, `.$type<T>()` and
`.primaryKey()`, plus `.unique(name?)`. `smallint`, `integer`/`int` and
`bigint` also have `.autoIncrement()` (CUBRID `AUTO_INCREMENT`), which makes
the column optional on insert. `.generatedAlwaysAs()` throws: CUBRID generated
columns are not supported yet.

## Queries

```ts
import { createClient } from 'cubrid-client';
import { count, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-cubrid/native';

const client = createClient({ host, database, user, password, timezone: 'utc' });
const db = drizzle(client); // or drizzle(pool), drizzle(tx) inside client.transaction()

const rows = await db
  .select({ name: users.name, posts: count(posts.id) })
  .from(users)
  .leftJoin(posts, eq(users.id, posts.authorId))
  .groupBy(users.name)
  .having(({ posts }) => gt(posts, 1))
  .orderBy(users.name)
  .limit(10)
  .offset(20);
```

`drizzle(client, { logger?, binding? })` takes a cubrid-client 1.4 client,
pool or transaction client (anything with `query()`, and `queryPrepared()` for
the default binding). Result types come from Drizzle's database-neutral select
types, so they match Drizzle's other dialects.

| Feature | Notes |
| --- | --- |
| `select()`, `select({ ... })`, `selectDistinct()` | Partial selections may nest objects and include `sql` fields; `sql.mapWith()` decoders are applied |
| `from(table \| subquery)` | Only native tables and subqueries made with `.as(alias)` |
| `innerJoin`, `leftJoin`, `rightJoin`, `crossJoin` | A left join makes the joined fields nullable, a right join the earlier ones. As in Drizzle, a top-level object (a table in `select()`, or `{ pet: { ... } }`) becomes `null` when its column fields all come from one such table or subquery and are all NULL; plain `sql` fields in it do not count. A join changes the builder it is called on, as Drizzle's do |
| `where`, `groupBy`, `having`, `orderBy` | Drizzle's operators and aggregates (`eq`, `and`, `inArray`, `count`, `sum`, `asc`, `desc`, ...); callbacks receive the selected fields |
| `limit`, `offset` | Bound as parameters; `offset()` needs `limit()` |
| `.for('update')` | Locks the rows until the transaction ends; use it inside `client.transaction()` |
| `.as(alias)` | A subquery for `from()` and joins. Inside it each column is named by its key path (`"users.id"`, `"pets.id"`), so joined tables that share column names stay apart, and a `sql` field, which needs `.as('name')`, keeps that name, so the subquery's own `having`/`orderBy` can use it. Outside, every use of a field (select list, `where`, `on`, `orderBy`, `having`) reads `"alias"."name"`. Names that differ only in case are refused, as CUBRID compares identifiers ignoring case. A subquery's `sql` fields are typed `SQL.Aliased`, as in Drizzle, but at runtime they are plain `sql` expressions (`sq.n.fieldAlias` is `undefined`), so that conditions on them render qualified |
| `.prepare()` | Builds the SQL once; `execute({ name: value })` fills `sql.placeholder('name')` |
| `.toSQL()`, `$dynamic()`, `await`/`then` | As in Drizzle |
| `db.execute(sql\`...\`)` | Runs a raw statement; rows come back as cubrid-client returns them (objects by label), not decoded |

Rows are read with `rowMode: 'array'` and mapped by position, so joined tables
that share column names (`users.id`, `posts.id`) keep both values.

### Binding

By default values are sent as typed binds with cubrid-client's
`queryPrepared()`; `drizzle()` refuses a client without it. With
`{ binding: 'literal' }` they go through `query()`, where cubrid-client writes
each value into the SQL text as an escaped literal. Values are encoded by the
column they are compared with (`eq(users.active, true)` sends `1`), except
`sql.placeholder()` values, which are sent as given, as in Drizzle's other
dialects. An array parameter is refused: cubrid-client cannot bind one.

### Identifier quoting

Identifiers are double-quoted and an embedded `"` is doubled (`we"ird` →
`"we""ird"`), which CUBRID 11.4 accepts. Every column is qualified with its
table or subquery alias. CUBRID stores identifiers in lower case.

### Errors and refusals

cubrid-client errors are passed through unchanged, with their `code`, `kind`
and `cause`. These are refused before anything is sent:

| Refused | Why |
| --- | --- |
| FULL JOIN, lateral joins, `union`/`intersect`/`except` | No method: CUBRID has no FULL JOIN or LATERAL; set operations are a later slice |
| `offset()` without `limit()` | CUBRID needs `LIMIT` with `OFFSET` |
| `.for('share')`, `noWait`, `skipLocked` | CUBRID has only FOR UPDATE, without options |
| `.for('update')` with DISTINCT, GROUP BY or HAVING | CUBRID 11.4 rejects it (-494) |
| A SET/MULTISET/SEQUENCE column compared with a value (`eq(t.tags, ['a'])`) | cubrid-client cannot bind an array; collection values are written only as insert and update values |
| Selected date or time columns (also through `mapWith()`, subqueries and collections of them) from a client that does not decode in UTC | See [Date and time](#date-and-time) |

## Writes: INSERT, UPDATE, DELETE

```ts
import { desc, eq, gt, lt, sql } from 'drizzle-orm';

const { lastInsertId } = await db.insert(users).values({ name: 'Ann' });
await db.insert(users).values([{ name: 'Bob' }, { name: 'Cy', tags: ['a', 'b'] }]);
const [{ id }] = await db.insert(users).values({ name: 'Dee' }).$returningId();

await db
  .insert(users)
  .values({ id: 1, name: 'Ann' })
  .onDuplicateKeyUpdate({ set: { visits: sql`${users.visits} + 1` } });
await db.insert(archive).select((qb) => qb.select({ name: users.name }).from(users).where(gt(users.id, 10)));

const { affectedRows } = await db.update(users).set({ name: 'Ann B.' }).where(eq(users.id, 1));
await db.update(users).set({ visits: 0n }).orderBy(desc(users.id)).limit(10);
await db.delete(users).where(lt(users.visits, 1n)).limit(100);
```

| Method | Notes |
| --- | --- |
| `insert(t).values(row \| rows)` | Every column of the table is listed; an `.autoIncrement()` column also accepts `null` (the server generates it). A column a row leaves out (or gives `undefined`) gets its `$defaultFn()` value, else its `$onUpdateFn()` value when it has no `.default()`, else the `DEFAULT` keyword. `null` writes NULL. An empty array is refused |
| `insert(t).select(query \| (qb) => query)` | INSERT … SELECT with a native select. Each selected field's key names the table column it goes to (`select({ name: users.name })` writes `name`); columns not selected get their DDL default, and `$defaultFn()` is not applied. A key that is not a column of the table, or a nested object or table, is refused. It is a separate method, so it cannot be combined with `values()` |
| `.onDuplicateKeyUpdate({ set })` | `ON DUPLICATE KEY UPDATE "col" = value, …`; values as in `update().set()`, `$onUpdateFn()` columns not named are set too. An empty `set` is refused |
| `update(t).set(values)` | Values are encoded by their columns; `undefined` ones are left out, and a set with no value is refused. Columns with `$onUpdateFn()` that `set` does not name get its value |
| `.where()`, `.orderBy()`, `.limit()` on update | `orderBy()` decides which rows `limit()` updates |
| `delete(t)`, `.where()`, `.limit()` | Without `where()` every row is deleted. There is no `orderBy()` (see below) |
| `.prepare()`, `.toSQL()`, `$dynamic()`, `await`/`then` | `prepare()` builds the SQL once, generating `$defaultFn()` values once (every `execute()` reuses them; see [`$returningId()`](#returningid)); `execute({ name: value })` fills `sql.placeholder('name')` |

Any value can also be a `sql` expression or a `sql.placeholder()`
(placeholders are encoded by their column when the prepared statement runs),
except that a placeholder cannot stand for a collection value.

`.default(value)` keeps Drizzle's semantics: insert writes the `DEFAULT`
keyword, so the value comes from the table's DDL (`DEFAULT value` in
`CREATE TABLE`), not from the TypeScript declaration. A database whose DDL
has no default stores NULL (or rejects the row for a NOT NULL column).

### Results

`insert`, `update` and `delete` resolve to `CubridDmlResult`,
`{ affectedRows: number; lastInsertId?: number | bigint }`, taken unchanged
from cubrid-client's `executePrepared()` (or `execute()` with
`binding: 'literal'`); a client without that method is refused. As
cubrid-client documents, `lastInsertId` is set only when the INSERT left the
session with a new AUTO_INCREMENT value; it is a `number` while it is a safe
integer and a `bigint` beyond that. With `onDuplicateKeyUpdate()`,
`affectedRows` is 1 for an inserted row and 2 for every row that hit a
duplicate key, also when the update left the row unchanged (MySQL reports 0
then; verified on CUBRID 11.4). No ID is ever derived from another. Driver errors pass through unchanged, so a duplicate key rejects with
the driver's error and its `code` (-670 on CUBRID 11.4).

### `$returningId()`

`insert(...).$returningId()` resolves to one object per inserted row with the
table's `.primaryKey()` columns that have `.autoIncrement()` or `$defaultFn()`
(typed so):

- An AUTO_INCREMENT key comes from the keys the server says the INSERT
  generated: `$returningId()` runs it with cubrid-client's
  `generatedKeys: true` (CAS GET_GENERATED_KEYS), which is exact for every
  INSERT, including one with a collection literal or a `sql` value, and a key
  equal to the one the connection saw before (cubrid-client's plain
  `lastInsertId` leaves such a key out as ambiguous). The key is read through
  the column's codec (a `bigint({ mode: 'bigint' })` key stays exact above
  2^53; an `integer()` key that does not fit throws). If the row was inserted
  but the server still reports no key, `$returningId()` throws, saying the
  row was inserted, so do not retry it.
- **Tables with an INSERT trigger:** CUBRID 11.0–11.4 rejects a generated-keys
  INSERT on a table with an INSERT trigger (-983) before inserting anything
  (verified on 11.4, also inside `client.transaction()`). Use `insert()`
  without `$returningId()` on such tables and read the key back by a unique
  column. Inserts without `$returningId()`, and `$returningId()` on tables
  whose only keys are `$defaultFn()` keys, never ask for generated keys.
- CUBRID does not promise that the keys of a multi-row INSERT are
  consecutive, so a multi-row `values()` into a table with an AUTO_INCREMENT
  key is refused before anything is sent: insert the rows one at a time.
- A key the row gives itself (a value or a placeholder's value) is returned
  as the column reads it back (`5` for a `bigint({ mode: 'bigint' })` key is
  returned as `5n`). An AUTO_INCREMENT column also accepts `null`, which
  makes the server generate the key, as when it is left out.
- A `$defaultFn()` key is the value written for that row, generated or given.
  A key written as `sql` is unknown and left out.
- With `onDuplicateKeyUpdate()`, keys are reported only when the row was
  inserted (`affectedRows` 1). A row that hit a duplicate key keeps its old
  key, which the statement does not report, so the result is `[]`. A
  multi-row upsert is refused before anything is sent when the table has
  such keys, as CUBRID does not report which rows were inserted.
- A row with no reported key is left out, so a table without such keys
  returns `[]`.
- INSERT … SELECT is refused before anything is sent: select the rows back by
  a unique column.

> **Prepared inserts reuse generated values.** As in Drizzle's other
> dialects, `prepare()` runs `$defaultFn()` once, when it builds the
> statement, and every `execute()` writes those same values. For a
> `$defaultFn()` key (a UUID, say), a second `execute()` writes the same key
> and fails with a duplicate key, and `$returningId()` reports the same key
> each time. Pass such keys through `sql.placeholder()`, or build the insert
> anew for each row instead of preparing it.

There is no `.returning()`: CUBRID has no RETURNING clause.

### Collections in writes

A SET, MULTISET or SEQUENCE value in `values()`, `set()` or
`onDuplicateKeyUpdate()` is written as the typed literal from
[Collections](#collections), one parameter per element encoded by the element
codec: `CAST(SET{?, ?} AS SET(STRING))`. An empty array writes
`CAST(SET{} AS SET(STRING))`, which CUBRID 11.4 stores as an empty collection
(not NULL); `null` writes NULL. This works under both bindings.

### Date and time in writes

Date and time values are written as the UTC wall-clock text their codecs
produce, which does not depend on how the client decodes, so writes are not
refused for a client that does not decode in UTC. INSERT … SELECT reads
nothing back into JavaScript, so it is not checked either; its select is
built and refused by the same rules as any native select.

### Refused writes

| Refused | Why |
| --- | --- |
| `values([])`, `set({})`, `onDuplicateKeyUpdate({ set: {} })` | Nothing to write |
| `delete().orderBy()` | No method: CUBRID 11.4 rejects DELETE with ORDER BY (-493, #189) |
| `insert().ignore()` / INSERT IGNORE, `.returning()` | No method: CUBRID has neither |
| `values(col)` / `sql\`values(${t.col})\`` in `onDuplicateKeyUpdate()` | CUBRID 11.4 rejects MySQL's `VALUES()` function there (#189); repeat the value instead |
| Multi-row `$returningId()` with an AUTO_INCREMENT key or with `onDuplicateKeyUpdate()`; `$returningId()` of INSERT … SELECT | See [`$returningId()`](#returningid) |
| `sql.placeholder()` as a collection value | cubrid-client cannot bind an array |

## Column builders

| Builder | SQL type | TypeScript type | Codec |
| --- | --- | --- | --- |
| `smallint()` | `SMALLINT` | `number` | Reads integers. Writes only integer numbers in −32768..32767; `1.5` throws a `TypeError` instead of being rounded by the server |
| `integer()`, `int()` | `INTEGER` | `number` | As `smallint`, range −2^31..2^31−1 |
| `bigint({ mode: 'bigint' })` | `BIGINT` | `bigint` | Exact for the whole 64-bit range. Writes a `bigint` in the signed 64-bit range; a safe-integer `number` is also accepted and sent as a `bigint`, any other number throws |
| `bigint({ mode: 'number' })` | `BIGINT` | `number` | Reading or writing a value outside ±(2^53 − 1) throws a `RangeError` instead of rounding; fractional writes throw a `TypeError` |
| `numeric({ precision?, scale?, mode? })`, `decimal()` | `NUMERIC(p,s)` | `string` (default) or `number` | String mode returns cubrid-client's exact decimal string (`NUMERIC(10,2)` reads `'12.50'`). Number mode converts with `Number()`, which rounds beyond a double's ~15–17 significant digits. A `number` is written as its shortest round-trip digits in plain decimal notation (`1e-7` → `'0.0000001'`, `1e21` → `'1000000000000000000000'`; CUBRID rejects exponent text), and `NaN`/`±Infinity` throw. `precision` must be 1–38 and `scale` 0–`precision` |
| `float()` | `FLOAT` | `number` | 32-bit: `1.1` reads back as `Math.fround(1.1)` = `1.100000023841858`. Driver text is read only as decimal notation (`'0x10'` throws) |
| `double()` | `DOUBLE` | `number` | 64-bit, the same as a JavaScript `number` |
| `char({ length })` | `CHAR(n)` | `string` | Read as sent: CUBRID pads to `n` with spaces (`'ab'` in `CHAR(5)` reads `'ab   '`) |
| `varchar({ length })` | `VARCHAR(n)` | `string` | `length` is required |
| `string()` | `STRING` | `string` | `VARCHAR(1073741823)` |
| `boolean()` | `SMALLINT` | `boolean` | Writes 1/0, reads 1/0; any other value throws on read and write |
| `datetime({ mode? })` | `DATETIME` | `Date` (default) or `string` | `YYYY-MM-DD HH:MM:SS.mmm` |
| `timestamp({ mode? })` | `TIMESTAMP` | `Date` or `string` | `YYYY-MM-DD HH:MM:SS`; whole seconds |
| `date({ mode? })` | `DATE` | `Date` or `string` | `YYYY-MM-DD`; a `Date` is midnight UTC |
| `time()` | `TIME` | `string` | `HH:MM:SS`; whole seconds |
| `monetary()` | `MONETARY` | `string` | cubrid-client returns a number, read as its shortest decimal string without an exponent (`12.34` → `'12.34'`, `1e21` → `'1000000000000000000000'`) |
| `set({ element })` | `SET(T)` | `(E \| null)[]` | See [Collections](#collections) |
| `multiset({ element })` | `MULTISET(T)` | `(E \| null)[]` | |
| `sequence({ element })` | `SEQUENCE(T)` | `(E \| null)[]` | |

### Date and time

The stored wall clock is UTC, as in the 0.x API: a `Date` is written as the
text of its UTC fields, and the `Date`s cubrid-client returns are read with
UTC getters. Writes therefore do not depend on the process zone, but reads are
exact only from a client that decodes in UTC: create it with
`createClient({ ..., timezone: 'utc' })` or run with `TZ=UTC`. A native
`select()` that reads a date or time column refuses any other client before
sending the statement. It reads the client's declared `timezone`, or runs one
probe query for a client that declares none, as the 0.x guard does.
`db.execute()` does not decode, so it is not checked, and neither is a raw
`sql\`${t.at}\`` field without `mapWith()`, which returns the driver's value. `mode: 'string'` reads the wall clock in the formats above and
writes the string as given; text from the driver is accepted only in those
formats.

A `Date` outside CUBRID's years 0001–9999 is refused with a `RangeError`
before anything is sent, instead of being written as `+010000-…`. A
`timestamp()` `Date` must also lie within 1970-01-01 00:00:01 to
2038-01-19 03:14:07 UTC (verified on CUBRID 11.4 with a UTC session; the
server reads TIMESTAMP text in the session time zone).

### Collections

`set`, `multiset` and `sequence` take an element builder, such as `integer()`
or `varchar({ length: 20 })`; the element's name is ignored and collections
cannot be nested. Values are arrays of the element's type with `null`
elements allowed. Each element goes through the element column's codec, so a
`sequence({ element: boolean() })` writes `[true, null]` as `[1, null]` and a
`multiset({ element: bigint({ mode: 'bigint' }) })` keeps 64-bit values exact.
Writing a non-array, a nested array or `undefined` throws, and so does reading
anything but an array. A `SET` removes duplicates and, like `MULTISET`, has no
defined order; `SEQUENCE` keeps duplicates and order.

cubrid-client cannot bind an array as one parameter. A statement writes a
collection as a typed literal with one parameter per element, whose values are
what `mapToDriverValue()` returns:

```ts
collectionLiteralSql(users.tags, 2); // 'CAST(SET{?, ?} AS SET(STRING))'
```

The cast uses the element's declared type, except that `VARCHAR` and `STRING`
elements cast to `STRING`, so the cast cannot truncate a value that the column
would refuse. `insert()` and `update()` emit this literal themselves (see
[Collections in writes](#collections-in-writes)).

## MySQL-only builders and their CUBRID replacements

The 0.x API re-exports Drizzle's MySQL builders. These have no CUBRID type and
are not in `drizzle-cubrid/native`:

| 0.x / MySQL builder | Use instead |
| --- | --- |
| `tinyint` | `smallint()` (CUBRID has no 8-bit integer) |
| `mediumint` | `integer()` |
| `int({ unsigned: true })`, other `unsigned` options | The next wider signed type (`bigint` for unsigned `int`); CUBRID has no unsigned integers |
| `serial` | `bigint({ mode: 'bigint' }).primaryKey().autoIncrement()` (or `integer()`) |
| `year` | `smallint()` |
| `mysqlEnum` | `varchar({ length }).$type<'a' \| 'b'>()`; CUBRID `ENUM` is not supported yet |
| `text`, `tinytext`, `mediumtext`, `longtext` | `string()` or `varchar({ length })` |
| `real` | `double()` |
| `binary`, `varbinary`, `blob` | Not available yet (#216) |
| `json` | Not available yet |

## Known CUBRID behaviors

- `CHAR(n)` values come back padded with spaces to `n`.
- `FLOAT` is 32-bit; use `double()` for JavaScript-exact numbers.
- `MONETARY` is stored as a double: amounts have double precision, not exact
  decimal precision. Use `numeric({ precision, scale })` for exact money.
- `TIMESTAMP` and `TIME` hold whole seconds; the server drops milliseconds.
  `TIMESTAMP` covers 1970-01-01 00:00:01 to 2038-01-19 03:14:07 UTC.
- `NUMERIC` reads with the column's scale (`'12.5'` stored in `NUMERIC(10,2)`
  reads `'12.50'`), and the server rounds extra fractional digits without an
  error: `'0.00000000005'` written to `NUMERIC(38,10)` reads `'0.0000000001'`.
- Collection values cannot be passed to Drizzle's generic operators
  (`eq(t.tags, ['a'])`); they are written only by insert and update.
- An empty collection written by insert or update reads back as `[]`, not
  `null`.
- Typing: as in Drizzle, a `sql` field keeps its declared type even from a
  left-joined table; declare `sql<number | null>` when it can be NULL.
- COUNT(*) is a BIGINT: Drizzle's `count()` maps it to a number; a bare
  `sql\`count(*)\`` without `mapWith()` returns a `bigint`.
- Identifiers are case-insensitive: CUBRID stores `"userName"` as `username`.
