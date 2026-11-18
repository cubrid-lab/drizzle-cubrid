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
  `db.execute()` (see [Queries](#queries)), set operations and scalar
  subqueries (see [Set operations](#set-operations) and
  [Subqueries as values](#subqueries-as-values)), `db.insert()`, `db.update()`
  and `db.delete()` (see [Writes](#writes-insert-update-delete)),
  `db.transaction()` with nested transactions (see [Transactions](#transactions)),
  and relational queries, `db.query.<table>.findMany()`/`findFirst()` with
  `with` (see [Relational queries](#relational-queries)).
- `prepare()` on every query, relational ones included (see
  [Prepared queries](#prepared-queries)), and `iterator()` streaming of
  selects and set operations (see [Streaming](#streaming)).
- Schema migrations: `migrate()` from `drizzle-cubrid/native/migrator`
  applies ordered CUBRID SQL files, and `generateInitialMigration(schema)`
  writes the first one (`CREATE TABLE`). See [MIGRATIONS.md](MIGRATIONS.md).

**Not yet:** streaming inside `db.transaction()` or of relational queries
(both refused, see [Streaming](#streaming)), schema diffing and `ALTER` generation (#163), and
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
const db = drizzle(client); // or drizzle(pool)

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
| `.for('update')` | Locks the rows until the transaction ends; use it inside `db.transaction()` |
| `.as(alias)` | A subquery for `from()` and joins. Inside it each column is named by its key path (`"users.id"`, `"pets.id"`), so joined tables that share column names stay apart, and a `sql` field, which needs `.as('name')`, keeps that name, so the subquery's own `having`/`orderBy` can use it. Outside, every use of a field (select list, `where`, `on`, `orderBy`, `having`) reads `"alias"."name"`. Names that differ only in case are refused, as CUBRID compares identifiers ignoring case. A subquery's `sql` fields are typed `SQL.Aliased`, as in Drizzle, but at runtime they are plain `sql` expressions (`sq.n.fieldAlias` is `undefined`), so that conditions on them render qualified |
| `.prepare()` | Builds the SQL once; `execute({ name: value })` fills `sql.placeholder('name')`. A client-side plan, not a server-side statement: see [Prepared queries](#prepared-queries) |
| `.iterator(values?, options?)` | Streams the rows one at a time with cubrid-client's `stream()`; see [Streaming](#streaming) |
| `.toSQL()`, `$dynamic()`, `await`/`then` | As in Drizzle |
| `db.execute(sql\`...\`)` | Runs a raw statement; rows come back as cubrid-client returns them (objects by label), not decoded |

Rows are read with `rowMode: 'array'` and mapped by position, so joined tables
that share column names (`users.id`, `posts.id`) keep both values.

### Set operations

```ts
import { desc } from 'drizzle-orm';
import { union } from 'drizzle-cubrid/native';

const names = await db
  .select({ id: users.id, name: users.name })
  .from(users)
  .unionAll(db.select({ id: admins.userId, name: admins.login }).from(admins))
  .orderBy(({ name }) => desc(name))
  .limit(10);

// posts.authorId is nullable, so it goes first: every operand's rows must fit the first's type.
const ids = union(
  db.select({ id: posts.authorId }).from(posts),
  db.select({ id: users.id }).from(users),
  db.select({ id: admins.userId }).from(admins),
);
```

| Method | SQL |
| --- | --- |
| `.union(q)`, `union(a, b, ...rest)` | `(a) union (b)` |
| `.unionAll(q)`, `unionAll(...)` | `(a) union all (b)` |
| `.intersect(q)`, `intersect(...)` | `(a) intersect (b)` |
| `.intersectAll(q)`, `intersectAll(...)` | `(a) intersect all (b)`: each row as often as the select that returns it least |
| `.except(q)`, `except(...)` | `(a) except (b)` |
| `.exceptAll(q)`, `exceptAll(...)` | `(a) except all (b)`: each row of `a` as often as it occurs there more than in `b` |

They are methods of a select and of a set operation, standalone functions
exported from `drizzle-cubrid/native`, and callbacks (`.union(({ intersect })
=> intersect(b, c))`), as in Drizzle. Every one, with the ALL forms' bag
semantics, was verified on CUBRID 11.4 (which also spells them `INTERSECTION`
and `DIFFERENCE`).

- **Operands** are native selects or set operations with the same keys in
  the same order, and (at the type level) rows assignable to the first
  select's. Each operand is parenthesised, so its own `orderBy()`,
  `limit()` and `offset()` apply to it.
- **Order:** chained operators run left to right; `a.union(b).intersect(c)`
  is `((a) union (b)) intersect (c)`. CUBRID gives UNION, INTERSECT and
  EXCEPT one precedence (unlike standard SQL, where INTERSECT binds tighter),
  and the parentheses make the order explicit. A set operation passed as an
  operand (`a.union(b.intersect(c))`) is parenthesised as one.
- **Result:** `orderBy()`, `limit()` and `offset()` after the last operator
  apply to the whole result. `orderBy()` takes fields of the first select
  (or a callback receiving them), bare or in `asc()`/`desc()`, and sends
  their positions (`order by 2 desc`). Anything else is refused: another
  column, raw `sql`, and an expression such as ``sql`length(${t.s})` ``
  (its column would become a position, `length(2)`, which CUBRID rejects
  with -494). A set operator called after them makes the ordered result an
  operand. Calling a set operator returns a new set operation; the one it
  is called on is not changed.
- **Operands are not copied:** a select used as an operand stays part of the
  set operation, so changing it afterwards (`a.where(...)` after
  `a.union(b)`) changes the set operation too, as with Drizzle's builders.
  Build each operand completely before combining them.
- **Rows** have the first select's fields and types and are read by position
  with its codecs. The server gives each result column the common type of
  the operands, so a field whose column has another SQL type than the first
  select's is refused when the set operation is built: DATE with DATETIME or
  TIMESTAMP comes back as a DATETIME, which a `date()` codec would cut to
  midnight. Length, precision and mode do not count (`numeric(10, 2)` with
  `numeric(38, 10)` is allowed), and CHAR, VARCHAR and STRING count as one
  type. A `sql` field without a column codec is refused under a date or time
  field; under any other codec it is allowed, and the codec throws on a value
  it cannot read (an `integer()` codec refuses NUMERIC `'1.50'` rather than
  rounding it), while the server rejects INTEGER with VARCHAR (-181). To
  combine other types, cast and map with the first select's column:
  ``sql`cast(${events.at} as date)`.mapWith(events.day)``.
  A left join of the first select makes its fields nullable as for a select.
- `.as(alias)`, `.prepare()` with placeholders in any operand, `.toSQL()`,
  `$dynamic()` and use as a value list (`inArray(col, a.union(b))`) work as
  for a select.

### Subqueries as values

A select made into a subquery with `.as(alias)` can be a selected field when
it selects exactly one field, as in Drizzle 0.45 (drizzle-cubrid types it the
same way on drizzle-orm 0.44, whose own types lack it); it is sent as `(select ...)` and
read with that field's codec (a column's, or a `sql` field's `mapWith()`).
Outer columns in its conditions are qualified, so correlated subqueries work.
A subquery field (or a callback's field) used in `where`, `having`, `orderBy`
or `groupBy` is sent as the same `(select ...)`:

```ts
import { count, eq, exists, inArray, max, sql } from 'drizzle-orm';

const postCount = db
  .select({ n: count().as('n') }) // a sql field in a subquery needs .as()
  .from(posts)
  .where(eq(posts.authorId, users.id))
  .as('post_count');
const rows = await db.select({ id: users.id, postCount }).from(users);
// { id: bigint; postCount: number }[]

await db.select().from(users).where(exists(db.select({ one: sql`1` }).from(posts).where(eq(posts.authorId, users.id))));
await db.select().from(users).where(inArray(users.id, db.select({ id: posts.authorId }).from(posts)));
await db.select({ id: users.id, top: sql<number>`${db.select({ m: max(posts.id) }).from(posts)}` }).from(users);
```

- A subquery that returns more than one row fails on the server (-459); use
  `limit(1)` or an aggregate. One that returns no row gives `null`, though
  Drizzle's types do not add `| null` (declare a `sql<T | null>` field when
  that matters).
- A select used inside `sql`, `exists()` or `inArray()` needs no `.as()`; it
  is sent in parentheses. Such a `sql` field is not decoded unless it has
  `mapWith()`.
- **The same table inside and outside:** a subquery field that reads a
  table (or subquery alias) the outer query also reads is refused, since
  inside the subquery that name means the subquery's own rows, so
  `where(eq(employees.boss, employees.id))` would compare each inner row with
  itself. Read the inner table through Drizzle's `aliasedTable()`, which is
  written as `"employees" "staff"`; this also works in `from()` and joins:

  ```ts
  import { aliasedTable, count, eq } from 'drizzle-orm';

  const staff = aliasedTable(employees, 'staff');
  const reports = db
    .select({ c: count().as('c') })
    .from(staff)
    .where(eq(staff.boss, employees.id))
    .as('reports');
  await db.select({ id: employees.id, reports }).from(employees);
  ```

  `aliasedTable()` keeps the table's type, so it does not give a join its
  own nullability at the type level. Selects used inside `sql`, `exists()`
  or `inArray()` are not checked: as in SQL, a table name there means the
  inner table.
- A subquery of several fields is typed as an error, as in Drizzle, and
  refused at runtime. A subquery field is allowed only at the top level of
  the selection (Drizzle types it `never` inside an object), and not in a
  select made into a subquery with `.as()`: use
  ``sql`${query}`.as('name')`` there.

### Binding

By default values are sent as typed binds with cubrid-client's
`queryPrepared()`; `drizzle()` refuses a client without it. With
`{ binding: 'literal' }` they go through `query()`, where cubrid-client writes
each value into the SQL text as an escaped literal. Values are encoded by the
column they are compared with (`eq(users.active, true)` sends `1`), except
`sql.placeholder()` values, which are sent as given, as in Drizzle's other
dialects. An array parameter is refused: cubrid-client cannot bind one.
A stream (`iterator()`) always sends its values as literals, whatever the
binding: see [Streaming](#streaming).

A string bound to a `char()` column is sent as `cast(? as CHAR(n))` under both
bindings (`inArray(t.code, ['ab', 'cd'])` is
`"t"."code" in (cast(? as CHAR(10)), cast(? as CHAR(10)))`). CUBRID 11.4
types the bound values of an `IN` list of two or more as `VARCHAR` and
compares a `CHAR` column with `VARCHAR` values without space padding, so with
typed binds `inArray()` matched no row and `notInArray()` every row; typed
`CHAR`, they compare padded, as `eq()` always did. A value longer than `n` is
cast to its own length (UTF-8 bytes), so it never matches by truncation (#237).

A `sql.placeholder()` has no column and its value is not known when the SQL
is built, so it is not cast. With typed binds (the default), an `inArray()` or
`notInArray()` list of two or more elements, one of them a placeholder, on a
`char()` column is sent as `("t"."code" = ? or "t"."code" = ?)` and
`("t"."code" <> ? and "t"."code" <> ?)` instead, in `where` and in selected
fields: each `= ?` compares padded, where an `IN` list of untyped placeholders
matched no row. On CUBRID 11.4 this gave the same rows and the same
true/false/NULL values as `IN`/`NOT IN` in every case tested, NULL
placeholder values and `not(...)` of the list included; a value longer than
`n` matches nothing. Under `binding: 'literal'` the list is sent unchanged:
literal lists compare padded already, and with literals CUBRID takes
`code = NULL` inside `OR` as false rather than unknown, so the expanded form
would differ under `not()` (#239). `eq(t.code, sql.placeholder('c'))` and a
one-element list need nothing. Only the exact `inArray()` shape is expanded
(also `` sql`${t.code} in ${[a, b]}` ``); in other `sql` templates write
`` sql`(${t.code} = ${a} or ${t.code} = ${b})` `` yourself for typed binds.

### Identifier quoting

Identifiers are double-quoted and an embedded `"` is doubled (`we"ird` →
`"we""ird"`), which CUBRID 11.4 accepts. Every column is qualified with its
table or subquery alias. CUBRID stores identifiers in lower case.

### Errors and refusals

cubrid-client errors are passed through unchanged, with their `code`, `kind`
and `cause`. These are refused before anything is sent:

| Refused | Why |
| --- | --- |
| FULL JOIN, lateral joins | No method: CUBRID has no FULL JOIN or LATERAL |
| `.for('update')` on a select of a set operation | CUBRID 11.4 rejects FOR UPDATE on an operand (-494) and on the result (-493); a set operation has no `for()` |
| Set operation operands with different keys (or in another order) | CUBRID rejects a different column count (-493); keys are checked as in Drizzle |
| `orderBy()` of a set operation on anything but a field of the first select, bare or in `asc()`/`desc()` | Not a column of the result; an expression would be sent with positions in it (-494) |
| A set operation whose operand field has another SQL type than the first select's (DATE with DATETIME), or a `sql` value without a column codec under a date or time field | The first select's codec decodes every row; a DATE codec would truncate the DATETIME the server returns |
| A subquery field reading a table or alias the outer query reads | Inside it the name means the subquery's own rows; use `aliasedTable()` |
| A subquery of more than one field (or a nested object) selected as a field | CUBRID 11.4 rejects it (-493) |
| A subquery selected as a field inside an object, or inside a select made into a subquery with `.as()` | Drizzle's select types allow a subquery field only at the top level; use ``sql`${query}`.as('name')`` inside `.as()` |
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
| `.prepare()`, `.toSQL()`, `$dynamic()`, `await`/`then` | `prepare()` builds the SQL once, generating `$defaultFn()` values once (every `execute()` reuses them; see [`$returningId()`](#returningid)); `execute({ name: value })` fills `sql.placeholder('name')` (see [Prepared queries](#prepared-queries)) |

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
- **Known limit, concurrent inserts on a pool:** with cubrid-client 1.4.0,
  generated keys are sometimes missing when many inserts run at once on a
  pool, mostly on newly created tables. In one run, about 6 to 8 of 60
  concurrent inserts on new tables reported no key
  ([cubrid-client#297](https://github.com/cubrid-lab/cubrid-client/issues/297)).
  No reported key has been wrong. The row is inserted and `$returningId()`
  throws the "do not retry" error above. If a key you get back is all you
  need, read it back by a unique column when that error occurs, or call
  `$returningId()` from one connection at a time until #297 is fixed.
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

## Transactions

```ts
import { drizzle } from 'drizzle-cubrid/native';

const db = drizzle(pool); // or drizzle(client)

const orderId = await db.transaction(
  async (tx) => {
    const [order] = await tx.insert(orders).values({ item: 'Widget' }).$returningId();
    const [stock] = await tx.select().from(inventory).where(eq(inventory.item, 'Widget')).for('update');
    if (!stock || stock.qty < 1) tx.rollback();
    await tx.update(inventory).set({ qty: stock.qty - 1 }).where(eq(inventory.item, 'Widget'));
    // A nested transaction is a savepoint: its failure undoes only its own work.
    await tx
      .transaction(async (audit) => {
        await audit.insert(auditLog).values({ orderId: order.id });
      })
      .catch(() => undefined);
    return order.id;
  },
  { isolationLevel: 'repeatable read' },
);
```

`db.transaction(callback, config?)` runs on cubrid-client's
`transaction(callback, options)`, which gives the callback a connection of its
own (a pooled one for a pool). `tx` is a native database (`CubridTransaction`)
bound to that connection, with the same `select`, `insert`, `update`,
`delete`, `execute`, binding and logger as `db`. Every statement of `tx`
belongs to the transaction, and statements of `db` (even on the same client
while the transaction runs) never do. Date and time reads in `tx` are checked
against the time zone of the client or pool that started it: `CubridClient`
and `CubridPool` declare their zone and are never probed, and for a custom
client that declares none the zone probe runs on that outer client or pool,
not inside the transaction.

| Behavior | Details |
| --- | --- |
| Result | Commits when the callback resolves and resolves to its value |
| Callback rejects | Rolls back and rejects with the callback's own error. cubrid-client's wrapping `TransactionError` is kept on it as `transactionError`, and a failed rollback as `rollbackError`; neither replaces it |
| A statement of `tx` fails | It rejects with cubrid-client's error unchanged; for a transaction client that is a `TransactionError` carrying the server's `code` and `kind` (`'unique-violation'`, …). Uncaught, it rolls the transaction back as above |
| Commit fails | Rejects with cubrid-client's error unchanged; check its `outcomeUnknown` (the commit may have happened) before retrying |
| `tx.rollback()` | Throws `CubridTransactionRollbackError` (a subclass of Drizzle's `TransactionRollbackError`), so the level it was called in rolls back and its `transaction()` rejects with that error |
| `tx.transaction(cb)` | `savepoint "spN"` (N is the depth) before `cb`, and `rollback to savepoint "spN"` when `cb` rejects; the error is rethrown, so the outer transaction goes on if you catch it, and rolls back if you do not. CUBRID has no `RELEASE SAVEPOINT`, so a savepoint stays until the transaction ends. It takes no config (typed `never`) |
| While a nested transaction runs | Statements and new nested transactions of the enclosing level (also through the outer `tx` captured inside the nested callback) throw `… await the nested transaction first` before anything is sent: rolling back to the savepoint would undo them too. Query builders run only when awaited, so in `Promise.all([tx.insert(…), tx.transaction(…)])` the insert is refused even though it is listed first: await it before opening the nested transaction |
| Rolling back to a savepoint fails | The nested error is rethrown with `rollbackError`, and the enclosing level can only roll back: its statements throw `… can only roll back` (with the nested error as `cause`), and when its callback resolves anyway it rejects with the nested error, so the transaction (or the enclosing savepoint) rolls back instead of committing the nested work |
| `config.isolationLevel` | `'read committed'`, `'repeatable read'` or `'serializable'`, applied by cubrid-client before the transaction starts (verified on 11.4: under `'repeatable read'` and `'serializable'` a row committed meanwhile by another connection stays invisible) |
| Parallel statements in one `tx` | Allowed (`Promise.all`) while no nested transaction is open in that level; cubrid-client runs them one at a time on the transaction's connection. Await them all before the callback returns, and await every nested transaction too: one still running when the callback returns makes the level reject (`… was still running …`) and roll back instead of committing |
| `db` inside the callback | Runs outside the transaction on another connection. On a pool whose connections are all held (for example `max: 1`, held by this transaction) it waits for one and rejects with cubrid-client's `ConnectionError` after `acquireTimeoutMs` (30 s by default); uncaught, that rolls the transaction back. Use `tx` for work that belongs to the transaction |
| Using `tx` after its callback settled | Every statement, `transaction()` and `rollback()` of it (and of its nested transactions) throws `This transaction has ended …` before anything is sent; a nested `tx` ends when its own callback settles |

Refused before a connection is taken:

| Refused | Why |
| --- | --- |
| `isolationLevel: 'read uncommitted'` or any other level | CUBRID has no READ UNCOMMITTED |
| `accessMode`, `withConsistentSnapshot`, any other config key | CUBRID has no read-only transactions or consistent-snapshot start; cubrid-client options such as `lockTimeout` are not passed yet |
| A client without `transaction()` | `BEGIN`/`COMMIT` on a connection that other callers may share would let their statements join, commit or roll back the transaction (#185). Pass a cubrid-client 1.3+ client or pool |
| `isolationLevel` with a `transaction()` that declares no options parameter | It would run at the server's default level |
| Two nested transactions of one level at the same time | They would roll back to the same point of one connection |
| A config that is not a plain object (`null`, an array); only an own `isolationLevel` is read | |

## Failures

What a caller sees when the server or the network fails. Every row below is
verified on CUBRID 11.4 with cubrid-client 1.4.0 by `tests/faults.test.ts`
(`npm run integration:faults`), which checks the outcome the caller gets and
then reads what the database actually holds through a new connection. The
adapter adds no retry or reconnect of its own: it passes cubrid-client's
errors through (see [Transactions](#transactions)), and cubrid-client never
sends a statement or a COMMIT a second time.

| Failure | What the caller sees | What the database holds |
| --- | --- | --- |
| Connection lost between two statements of `db.transaction()` (socket reset, CAS process killed) | The next statement, so the transaction, rejects at once with `TransactionError`, `kind: 'connection-lost'`. `outcomeUnknown` depends on when the driver noticed: `true` when it wrote the statement to a socket that turned out to be reset (observed for a reset between statements), `false` when it saw the socket close before sending (observed for a killed CAS process). Either way the transaction is lost | Nothing of the transaction: the server rolls it back when the connection closes |
| Connection lost while a statement of the transaction was on the wire (the server ran it, the reply never came) | Same, with `outcomeUnknown: true` | Nothing: the statement was part of the transaction, which the server rolled back |
| Database server restart (`cubrid server restart`) during a transaction | The next statement rejects with `TransactionError`, `code: -224` ("A database has not been restarted"), **no `kind`** in cubrid-client 1.4.0, `outcomeUnknown: false` | Nothing of the transaction |
| Server or broker restart between queries on a pool or client | The next query succeeds: the CAS reconnects to a restarted server by itself, and cubrid-client checks an idle connection's CAS (`CHECK_CAS`) before each statement outside a transaction and opens a new connection when it is gone, before the statement is sent | The statement ran once |
| Server unreachable (connections reset and new ones refused) | Queries reject at once with `kind: 'connection-lost'`, `outcomeUnknown: false` (a `QueryError` when an idle connection could not be replaced, a `ConnectionError` when a pool could not open one) | Nothing was sent; the next query after the server is back succeeds |
| Connection lost during COMMIT of `db.transaction()` | Rejects with cubrid-client's error unchanged: `TransactionError`, `kind: 'connection-lost'`, `outcomeUnknown: true` | **Unknown to the caller.** Verified both ways: when the COMMIT never reached the server nothing is committed; when only its reply was lost the transaction **is committed**. The error is the same in both cases |
| Connection lost during the COMMIT of an autocommit write (`db.insert()` outside a transaction) | `QueryError`, `kind: 'connection-lost'`, `outcomeUnknown: true` | The row can be committed (verified: committed once, never sent again) |
| Lock wait longer than the client's `lockTimeout` | The statement rejects with `TransactionError`, `kind: 'lock-timeout'` (code -75), whose `cause` is cubrid-client's `LockTimeoutError`; only the statement failed. Uncaught, the transaction rolls back | Nothing of the transaction; caught in a nested `tx.transaction()`, only the nested work is rolled back and the outer work commits |
| Deadlock victim | `TransactionError`, `kind: 'deadlock'`, `code: -72`, `cause` a `DeadlockError`. The server has already rolled back the **whole** transaction | Nothing of the victim; the other transaction commits |
| Deadlock victim inside a nested `tx.transaction()` | The nested transaction rejects as above, with the failed `rollback to savepoint` as its `rollbackError`; the outer level can then only roll back: its next statement throws a plain `Error` (`… can only roll back`) whose `cause` is the nested deadlock error, and the outer transaction rejects with it even if the nested error was caught | Nothing of the outer transaction, never a commit of work the server already rolled back |
| No reply within the client's `readTimeout` (stalled network, paused server, a lock wait longer than `readTimeout`) | `ReadTimeoutError`, `kind: 'read-timeout'`, `outcomeUnknown: true`, after `readTimeout` (with `readTimeout: 1000` the tests observed 1.00–1.02 s on a local container); the connection is discarded and the transaction rejects | Nothing of the transaction, also when the server runs the statement after the lock is released |
| Stalled network and no `readTimeout` | The statement waits; it completes when traffic resumes | Unchanged |
| Connection lost between the statements of a relational query with `with` | Rejects with no partial result: `QueryError`, `kind: 'connection-lost'` (the class it has outside a transaction, cubrid-client's `TransactionError` as `transactionError`) | Nothing written; the same query succeeds afterwards |

After every failure above the pool served the next statement, with no
connection left leased and no socket left open that it does not count.

**Commit outcome unknown.** When a COMMIT fails with `outcomeUnknown: true`
(or the property is absent), the transaction may or may not have been
committed, and nothing in the error tells which. Do not retry the transaction
blindly: read the database to find out (for example by a key the transaction
wrote), or make the transaction idempotent so that running it twice is
harmless. `outcomeUnknown: false` means cubrid-client knows which requests
the server answered; it is no permission to retry either.

Recommendations:

- Set `readTimeout` on the client or pool above your longest statement, so a
  stalled network or a hung server rejects instead of waiting forever (it is
  off by default), and `lockTimeout` for lock waits.
- Inside `db.transaction()`, classify errors by `kind` (or by `cause`), not by
  class: a failed statement is a `TransactionError` whose `cause` is the class
  it has outside a transaction (`LockTimeoutError`, `DeadlockError`, …), while
  a read timeout is a `ReadTimeoutError` itself.
- After a deadlock retry the whole transaction, not the statement: the server
  rolled all of it back. Look for `kind: 'deadlock'` along the `cause` chain,
  not only on the error itself: when the victim was a nested transaction whose
  error was caught, the outer transaction rejects with the `… can only roll
  back` error, and the deadlock is its `cause`.
- A `code: -224` statement error after a server restart has no `kind` in
  cubrid-client 1.4.0; treat it as a lost transaction.

## Relational queries

```ts
import { createPool } from 'cubrid-client';
import { relations } from 'drizzle-orm';
import { drizzle } from 'drizzle-cubrid/native';

export const usersRelations = relations(users, ({ one, many }) => ({
  posts: many(posts),
  manager: one(users, { fields: [users.managerId], references: [users.id], relationName: 'manager' }),
  reports: many(users, { relationName: 'manager' }),
  memberships: many(memberships), // many-to-many: two one-to-many hops through the junction table
}));
export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));

// schema: the tables and relations, e.g. `import * as schema`; see Consistency and connections for the pool's level
const pool = createPool({ host, database, user, password, timezone: 'utc', isolationLevel: 'repeatable read' });
const db = drizzle(pool, { schema });

const rows = await db.query.users.findMany({
  columns: { id: true, name: true },
  where: (u, { gt }) => gt(u.id, 0n),
  orderBy: (u, { asc }) => asc(u.name),
  limit: 20,
  offset: 40,
  extras: (u, { sql }) => ({ nameLength: sql<number>`char_length(${u.name})`.mapWith(Number).as('name_length') }),
  with: {
    manager: { columns: { name: true } }, // object or null
    posts: {
      where: (p, { like }) => like(p.title, 'A%'),
      orderBy: (p, { desc }) => desc(p.id),
      limit: 3, // per user
      with: { comments: true },
    },
    memberships: { columns: {}, with: { group: true } },
  },
});
const first = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, 1n) }); // row or undefined
```

`drizzle(client, { schema })` takes the native tables and Drizzle's
`relations()` (from `drizzle-orm`, the v1 relations API of Drizzle 0.44 and
0.45) and adds `db.query.<table>` with `findMany()` and `findFirst()`, as in
Drizzle's other dialects: `columns` (include with `true`, or exclude with
`false`; `{}` selects none), `with` to any depth, `where` and `orderBy` as values or
callbacks, `limit` (and `offset` at the root), and `extras`; `limit` and
`offset` may be `sql.placeholder()`s of a prepared query (see
[Prepared queries](#prepared-queries)). Result types are Drizzle's
neutral `BuildQueryResult`: a `one()` relation is an object, or `null` when its
`fields` are nullable or nothing matches; a `many()` relation is an array. `tx.query`
works the same inside `db.transaction()`. Without `schema`, `db.query` is a
type error, as in Drizzle.

### How it loads

CUBRID has no `LATERAL`, and its JSON aggregation loses value types (and
rejects date and time values), so relations are not loaded as JSON. Instead:

1. One SELECT reads the root rows.
2. For each relation in `with`, one SELECT reads the related rows of all
   parents of that level: `where "posts"."author_id" in (?, ?, …)`, with the
   distinct non-NULL parent keys. A composite key uses a row-value `IN`
   (`("lines"."region", "lines"."num") in ((?, ?), (?, ?))`, verified on 11.4).
   Keys are sent in chunks of 1,000: CUBRID 11.4 ran `IN` lists of 100,000
   bound values, and a chunk keeps one statement small. Parent keys are bound
   with the parent column's codec.
3. Nested relations repeat step 2 on the rows just loaded.
4. The rows are joined in JavaScript on the key values. When a key column
   and the column it references have the same SQL type and codec, the
   related rows are matched on that column as read. Otherwise each related
   row also reads `cast(<reference> as <parent column type>)`, decoded by the
   parent column's codec, so both sides decode alike and a row the server
   returned is never dropped.

Key column pairs (see [Key types](#key-types)) that the server compares and
casts reliably are matched that way; any other pair is refused before
anything is sent.

So a query sends **1 + (relations in `with`) × (key chunks)** statements,
however many parent rows there are; a level whose parents have no keys sends
nothing. Each SELECT goes through the native select compiler and its values
are decoded by their column codecs, so `bigint`, `Date`, collections and
booleans keep exact types at every level; `extras` keep their
`.mapWith()` decoders. Key columns that `columns` leaves out are still read,
and dropped from the result.

`orderBy` of a `many()` relation orders its rows within each parent. Its
`limit` applies **per parent**:
`row_number() over (partition by <key> order by <orderBy>)` in a derived
table, keeping ranks up to the limit. CUBRID 11.4 evaluates `ROW_NUMBER()`
with `PARTITION BY`, with or without `ORDER BY`, in a derived table with bound
`IN` values. Without `orderBy`, which rows are kept is up to the server, as in
Drizzle. A row that several parents share (a many-to-one target) appears as a
separate object under each.

As in Drizzle's types, a nested relation takes no `offset`, and a `one()`
relation takes no `where`, `orderBy`, `limit` or `offset`; those are refused
at runtime too, rather than given a meaning Drizzle does not type.

### Key types

| Parent key and reference | Matched | Verified on 11.4 |
| --- | --- | --- |
| Same SQL type and codec | On the reference as read | |
| `SMALLINT`, `INTEGER`, `BIGINT`, `NUMERIC(p,s)` with each other (also other precisions and scales) | On the reference cast to the parent type | `BIGINT` with `INTEGER` (both directions), `NUMERIC(10,2)` with `NUMERIC(10,3)`: `1.500` matches `1.50`, `1.505` matches nothing |
| `CHAR(n)` with `CHAR(m)` | On the reference cast to the parent type; the keys are sent as `cast(? as CHAR(n))`, as every `CHAR` value is (see [Binding](#binding)) | `CHAR(5)` with `CHAR(10)`: both space-padded, `'ab'` matches `'ab'` |
| `VARCHAR(n)`/`STRING` with each other | On the reference cast to the parent type | |
| `CHAR` with `VARCHAR`, numbers with strings, `FLOAT` with `DOUBLE`, dates with times, any other pair | Refused | CUBRID matched a `VARCHAR` value against `CHAR` column values but not a `CHAR` value against `VARCHAR` ones, and `FLOAT` `0.1` does not equal `DOUBLE` `0.1` |
| A SET/MULTISET/SEQUENCE column | Refused | cubrid-client cannot bind a collection value |

`VARCHAR` comparison is exact on 11.4: trailing spaces and case count. A
column with a case-insensitive collation can match on the server values
that differ in case; those rows are not joined in JavaScript, so give such
keys a binary collation.

### Consistency and connections

All statements of one query run on one connection. Outside
`db.transaction()`, `drizzle(client, { schema, relationalReads })` decides how
a query with `with` runs (a query without `with` is one statement, run as
`select()` runs it):

| `relationalReads` | What runs | Guarantee | Cost |
| --- | --- | --- | --- |
| `'snapshot'` (default) | cubrid-client's `transaction(callback, { isolationLevel: 'repeatable read' })` | One snapshot: under `'repeatable read'` CUBRID 11.4 reads every statement of the transaction from the snapshot of the first one, so a row committed by another connection between the statements is not seen (verified live) | A `CubridPool` created with `isolationLevel: 'repeatable read'` reuses its connection. Any other pool closes the connection after each such query, because the transaction ran at another level than the pool's (cubrid-client keeps no connection with changed settings), and opens a new one for the next: verified live, pool size 1 → 0. A pool created with `'serializable'` is also run at `'repeatable read'` and loses its connection; use `'client'` there. A `CubridClient` opens a connection of its own for every such query |
| `'client'` | `transaction(callback)` at the client's own isolation level | One snapshot when that level is `'repeatable read'` or `'serializable'` (verified live for both); at `'read committed'` (CUBRID's default) each statement sees what was committed when it ran, so a row committed between two statements can be missing from one level and present in the next (verified live) | A pool keeps its connection at any level. A `CubridClient` opens a connection per query |
| `'separate'` | The statements one by one on the client, outside a transaction | Each statement sees what was committed when it ran | None; a pool may run each on another connection |

Recommended: a pool created with `isolationLevel: 'repeatable read'` and the
default `'snapshot'` (or `'client'`, which is the same there); with a pool
that must stay at `'read committed'`, choose between `'snapshot'` (snapshot
reads, a new connection per query) and `'client'` (no reconnects, statements
may see different commits). cubrid-client's settings are private, so the
dialect cannot tell what level a pool was created with.

`'snapshot'` needs a client whose `transaction()` declares an options
parameter, and `'client'` a client with `transaction()`; for any other client
a query with `with` is refused before anything is sent unless
`relationalReads: 'separate'` is given.

Inside `db.transaction()` the query always uses the transaction's connection
and isolation level, whatever `relationalReads` says; uncommitted writes of
the transaction are seen. Pass `{ isolationLevel: 'repeatable read' }` to
`db.transaction()` for one snapshot there.

### Errors

A failed statement rejects the query with the error class cubrid-client
gives the same statement outside a transaction: inside the query's own
transaction (`'snapshot'` or `'client'`), cubrid-client reports a statement
error as a `TransactionError`, so it is given the `QueryError` class (or
`ConstraintError`, `SqlSyntaxError`, `DeadlockError` or `LockTimeoutError`
by its `kind`, as cubrid-client picks them) with the same `message` (`Query
failed.`), `code`, `kind` and `cause`; cubrid-client's `TransactionError` is
kept as `transactionError`. A failed commit is passed through unchanged.
Inside `db.transaction()` statement errors stay `TransactionError`s, as for
`tx.select()`.

### Refused

Refused before anything is sent:

| Refused | Why |
| --- | --- |
| `iterator()` | A row is complete only after every level is loaded and stitched; stream a `select()` instead |
| Anything but a non-negative integer or a `sql.placeholder()` as `limit` or `offset` (a placeholder's value is checked the same way when the prepared query runs) | Not a row count |
| A `sql.placeholder()` without a value, at any level (also when the query is awaited, which runs it with no values) | Drizzle's `No value for placeholder "name" was provided`, before the root statement is sent |
| `offset` without `limit` at the root | CUBRID needs `LIMIT` with `OFFSET` |
| `offset` on a nested relation; `where`, `orderBy`, `limit` or `offset` on a `one()` relation | Not in Drizzle's types |
| Key columns of types that cannot be matched reliably | See [Key types](#key-types) |
| A query with `with` on a client without the `transaction()` its `relationalReads` needs | See [Consistency and connections](#consistency-and-connections) |
| A relation name the table does not have, an option Drizzle does not have (`having`), `columns`/`with` that are not objects, an `extras` value without `.as()`, a `where` that is not `sql`, an `orderBy` item that is not a column or `sql` | Not a relational query |
| `columns: {}` with no `extras` and no `with` | Nothing to select (Drizzle refuses it too) |
| A relation whose table is not in `schema`, or a schema table that is not a native table | It cannot be loaded with the native compiler |

Collection values compared in `where` are refused as in `select()` (see
[Errors and refusals](#errors-and-refusals)), and date and time columns need a
UTC-decoding client at every level (see [Date and time](#date-and-time)).

## Prepared queries

```ts
const byAuthor = db
  .select({ id: posts.id, title: posts.title })
  .from(posts)
  .where(eq(posts.authorId, sql.placeholder('author')))
  .limit(sql.placeholder('n'))
  .prepare();
await byAuthor.execute({ author: 1n, n: 10 });
await byAuthor.execute({ author: 2n, n: 5 });

const withPosts = db.query.users
  .findMany({ where: (u, { gt }) => gt(u.id, sql.placeholder('min')), limit: sql.placeholder('n'), with: { posts: true } })
  .prepare();
await withPosts.execute({ min: 0n, n: 20 });
```

`prepare()` is a **client-side plan, not a server-side prepared statement.**
cubrid-client 1.4 has no statement handle that outlives a call: under the
default binding each `queryPrepared()`/`executePrepared()` prepares, runs and
closes its own server statement, and under `binding: 'literal'` each
`query()`/`execute()` sends SQL text. So a prepared query costs the same round
trips as an awaited one; what it saves is the client-side work. See
[ADR 0008](adr/0008-prepared-queries-and-streaming.md).

| Query | What `prepare()` keeps | Each `execute(values)` |
| --- | --- | --- |
| `select()`, `selectDistinct()`, set operations | The SQL text for the binding, the parameters with their placeholders, the row mapping; also the SQL rendered for literals that `iterator()` sends. Both are rendered by `prepare()`, so a `Date` or array given to the builder and changed afterwards reaches neither (verified live) | Fills the placeholders and sends the statement through the session's binding; returns decoded rows |
| `insert()`, `update()`, `delete()` | The SQL text and parameters, and the `$defaultFn()`/`$onUpdateFn()` values generated once (every execution writes the same ones: see the warning below) | Fills the placeholders and runs the statement; resolves to `{ affectedRows, lastInsertId? }` |
| `insert(…).$returningId()` | As for `insert()`, plus which keys to report (checked once) | Fills the placeholders; a key written as a placeholder is reported with that execution's value, an AUTO_INCREMENT key from the server's generated keys |
| `db.query.<t>.findMany()`/`findFirst()` | The checked plan: options, relations, key types, the results of the `where`/`orderBy`/`extras` callbacks | Checks every placeholder (and each placeholder `limit`/`offset` as a non-negative integer) before anything is sent, then builds and runs its statements as an awaited query does, in one transaction when it loads relations (see [Consistency and connections](#consistency-and-connections)). The key lists of related levels are values read from the parent rows, never placeholders |

> **`$defaultFn()` and `$onUpdateFn()` run once per `prepare()`, not once per
> `execute()`.** A prepared insert of a table with `id: varchar().$defaultFn(() => randomUUID())`
> or `createdAt: datetime().$defaultFn(() => new Date())` writes the **same**
> UUID or timestamp on every execution (a repeated primary key then fails as a
> duplicate). Drizzle's own dialects do the same: their `prepare()` builds the
> INSERT, and calls the functions, once (drizzle-orm 0.45 `MySqlInsertBase.prepare()` → `buildInsertQuery()`).
> Pass such values as placeholders, `.values({ id: sql.placeholder('id') })`,
> or let the database generate them (`.default()`, `AUTO_INCREMENT`). An
> awaited insert builds the statement each time, so it gets new values.

Placeholders:

- A placeholder without a value is refused before anything is sent, with
  Drizzle's `No value for placeholder "name" was provided`; for a relational
  query this covers every level, so a nested level never fails after the
  root statement ran. Awaiting a query that has placeholders runs it with no
  values and fails the same way.
- Values no placeholder names are ignored, as in Drizzle, so one values
  object can serve several queries. Values that are not an object are
  refused.
- `limit()` and `offset()` of selects, set operations, `update()` and
  `delete()` take a placeholder (bound as a parameter); so do a relational
  query's `limit` and `offset`.
- A placeholder value is sent as given (it has no column to encode it),
  except in `insert().values()` and `update().set()`, where the column
  encodes it. With typed binds, an `inArray()`/`notInArray()` list of
  placeholders on a `char()` column is expanded as described in
  [Binding](#binding) (#239); a prepared query keeps that form for every
  execution.
- A prepared query belongs to the database or `tx` that built it: one built
  from `tx` is refused once its transaction ended.

## Streaming

```ts
const db = drizzle(pool, { binding: 'literal' }); // see "Binding" below
for await (const row of db.select().from(events).where(gt(events.id, 0)).orderBy(events.id).iterator()) {
  await send(row); // rows decoded as execute() decodes them
  if (done(row)) break; // closes the cursor and gives the connection back to the pool
}

const prepared = db.select().from(events).where(eq(events.kind, sql.placeholder('kind'))).prepare();
const controller = new AbortController();
for await (const row of prepared.iterator({ kind: 'click' }, { signal: controller.signal, fetchSize: 1000 })) {
  // ...
}

// Under the default binding: refused unless this stream opts in to literal semantics.
const typedDb = drizzle(pool);
for await (const row of typedDb.select().from(events).iterator({}, { literal: true })) {
  // ...
}
```

`iterator(placeholderValues?, options?)` on a select, a set operation or a
prepared select reads the rows through cubrid-client's `stream()` with
`rowMode: 'array'`, and decodes each row by position with the same codecs as
`execute()` (bigint, CHAR padding, dates, collections, `mapWith()`). It
returns an `AsyncGenerator` of the select's row type.

**Binding: a stream never silently differs from `execute()`.** cubrid-client
1.4's `stream()` can send values only as SQL literals, and CUBRID compares
some values differently as literals than as typed binds. Verified on 11.4:

| Condition | Typed binds (`execute()` under `'prepared'`) | Literals (a stream) |
| --- | --- | --- |
| `not(or(eq(t.c, sql.placeholder('p')), eq(t.id, 1)))` with `p: null` (also `undefined`, a plain `eq(col, null)`, VARCHAR columns) | `c = NULL` is unknown, so no row | `c = NULL` inside `OR` is false, so every row but `id = 1` |
| `like(t.s, sql.placeholder('p'))` with `p: 'ab'` | Matches `'ab'` and `'ab  '`: trailing spaces are ignored | Matches `'ab'` only |
| `like(t.s, …)` with `p: ''` | Matches `'  '` | Matches `''` |
| A denormal double such as `5e-324` | Bound | Its literal is a syntax error (`SqlSyntaxError`) |

So:

- Under `binding: 'literal'`, `execute()` and `iterator()` both send
  literals and return the same rows; `iterator()` works without options.
  Verified live with a matrix of 90+ conditions (strings with quotes,
  backslashes, `%`/`_`, Unicode and spaces, NULL and `undefined`
  placeholders under `NOT`/`OR`, CHAR `IN` lists, BIGINT extremes, doubles,
  dates): each returned the same rows, or the same error, from `execute()`,
  a prepared `iterator()` and a direct `iterator()`.
- Under `binding: 'prepared'` (the default), `iterator()` is **refused**
  before anything is sent, with an error naming the two ways out: create the
  database with `drizzle(client, { binding: 'literal' })`, or pass
  `{ literal: true }` to that `iterator()` call to accept literal semantics
  for that stream, with the differences above. The stream's SQL is then
  rendered as for `binding: 'literal'`: a CHAR placeholder list is not
  expanded (#239), since literal lists compare padded already.
- This is revisited when cubrid-client can stream with typed binds
  (cubrid-lab/cubrid-client#307).

| Behavior | Details |
| --- | --- |
| When it is sent | The binding, placeholders (also an array value), options (`fetchSize`, `consumerTimeout`, `signal`, `literal`) and the transaction are checked when `iterator()` is called, before anything is sent; the statement is sent, the UTC-decoding check made and a pool's connection taken on the first read |
| Memory and backpressure | cubrid-client holds one server reply of rows at a time and asks for the next only when the loop wants more rows (CUBRID 10.2–11.4 send about 16 KiB of rows per reply whatever `fetchSize` says). The dialect decodes one row at a time and keeps none. Verified live with 10,000 rows on one pool connection |
| Connection | A pool's stream holds one connection from the first read until it ends; a statement awaited inside the loop takes another connection of the pool (or waits for one). A `CubridClient`'s stream holds the client's shared connection: its other statements wait, and one awaited inside the loop is refused with cubrid-client's `kind: 'stream-busy'` `QueryError` after `consumerTimeout` (5000 ms by default) since it could never run. Stream next to other work with a pool |
| Ending early | `break`, a `return`, a throw in the loop body or `iterator.return()` closes the server cursor and releases the connection (verified live: `pool.stats().active` back to 0). Drive it with `for await`; code that calls `next()` by hand must call `return()`, or the connection stays held |
| Cancellation | `options.signal`: aborting it makes the next read reject with `signal.reason`, closes the cursor and releases the connection; already aborted, nothing is sent. A reply already awaited is not interrupted (cubrid-client's `readTimeout` limits it) |
| Errors | cubrid-client's errors pass through unchanged. CUBRID evaluates a result when the statement runs, so a server error (division by zero, a failed cast) rejects the first read, before any row (verified on 11.4). A row that fails to decode (a codec or `mapWith()` error) rejects that read and closes the stream |
| Binding | Always literals; see above. Rows equal `execute()`'s when the database uses `binding: 'literal'`; under `'prepared'` only with `{ literal: true }`, and then they can differ as the table above shows |
| `options` | `literal` (see above), and `signal`, `fetchSize` (an integer from 1 to 2^31 − 1) and `consumerTimeout` (an integer from 0 to 2^31 − 1 ms), passed to cubrid-client. Any other key, `rowMode` included, is refused |
| Concurrency | Several streams on a pool each hold a connection (verified live with three interleaved streams). **More open streams than the pool's `max`, read in lockstep, cannot all start**: the first read of the extra one waits for a connection that only the streams beside it, which the same code is not reading, could release. It does not hang forever: it rejects with cubrid-client's `ConnectionError`, `kind: 'pool-timeout'`, after `acquireTimeoutMs` (30 s by default; verified live with `max: 2`, `acquireTimeoutMs: 1000`), and the open streams keep their connections until they end. Keep the number of streams open at once at or below `max`, or end one before starting another. Several streams on one `CubridClient` take turns on its connection |

Refused, before anything is sent:

| Refused | Why |
| --- | --- |
| `iterator()` under `binding: 'prepared'` without `{ literal: true }` | See Binding above |
| A prepared select of a `tx` iterated after its transaction ended | `This transaction has ended …`, as for its `execute()` |
| `iterator()` inside `db.transaction()` (on `tx` or a nested `tx`) | cubrid-client 1.4's transaction client has no `stream()`. It is refused even for a client that has one: an open cursor's interaction with savepoints and with a callback that returns has no defined behavior yet. Await the select in the transaction, or stream with `db`, which runs outside it and sees only committed rows |
| `iterator()` on a client without `stream()` (such as a cubrid-client transaction client passed to `drizzle()`) | Nothing to stream with |
| `iterator()` on a relational query | Its rows are complete only after every level is loaded; stream a `select()` |
| Writes | Have no `iterator()` |

The 0.x API (`drizzle-cubrid`) is unchanged: its `iterator()` still throws.

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
| `mysqlEnum` | `varchar({ length }).$type<'a' \| 'b'>()`; CUBRID `ENUM` has no builder (see [Not supported in the native dialect](#not-supported-in-the-native-dialect)) |
| `text`, `tinytext`, `mediumtext`, `longtext` | `string()` or `varchar({ length })` |
| `real` | `double()` |
| `binary`, `varbinary` | Being added by [#216](https://github.com/cubrid-lab/drizzle-cubrid/issues/216); not in a release yet |
| `blob` | No builder; see [Not supported in the native dialect](#not-supported-in-the-native-dialect) |
| `json` | No builder; see [Not supported in the native dialect](#not-supported-in-the-native-dialect) |

## Not supported in the native dialect

These CUBRID types have no column builder in `drizzle-cubrid/native`.
`drizzle-cubrid/native` has no custom-type facility either, so there is no
supported way to declare such a column in a `cubridTable()`. The only
workaround is raw `sql` in queries on a table created outside the schema (for
example by a [migration](MIGRATIONS.md)), which bypasses the column codecs: you
read and write the driver's own values and nothing is range-checked or
converted for you.

| CUBRID type | Today | Status |
| --- | --- | --- |
| `TIMESTAMPTZ`, `DATETIMETZ`, `TIMESTAMPLTZ`, `DATETIMELTZ` (zone-aware temporal types) | No builder. The `datetime`, `timestamp`, `date` and `time` builders follow the UTC wall-clock rules in [Date and time](#date-and-time) and do not carry a zone. Raw `sql` only | Not planned for 1.0; open an issue to request |
| `BLOB`, `CLOB` | No builder. Raw `sql` only | Not planned for 1.0; open an issue to request |
| `ENUM` | No builder. Store the value in `varchar({ length }).$type<'a' \| 'b'>()` instead; that column is a `VARCHAR`, so CUBRID does not enforce the allowed values. Raw `sql` for a real `ENUM` column | Not planned for 1.0; open an issue to request |
| `JSON` | No builder. Store text in `string()` and parse it in your code, or use raw `sql` | Not planned for 1.0; open an issue to request |
| `BIT`, `BIT VARYING` (binary) | No builder yet | Being added by [#216](https://github.com/cubrid-lab/drizzle-cubrid/issues/216); not in a release yet |

## Known CUBRID behaviors

- `CHAR(n)` values come back padded with spaces to `n`.
- A `CHAR` column compared with a `VARCHAR` operand compares without space
  padding, so `'ab'` stored in `CHAR(10)` does not equal it. That covers an
  `IN` list of two or more untyped bound values, which CUBRID types `VARCHAR`
  (the dialect sends `CHAR` values typed `CHAR` and expands placeholder lists;
  see [Binding](#binding)), but also any `VARCHAR` expression or subquery:
  `` eq(t.code, sql`concat(…)`) `` and `` inArray(t.code, sql`(select varcharCol …)`) ``
  match no row. Cast such an expression or subquery column to `CHAR` when
  comparing it with a `CHAR` column (`` sql`cast(concat(…) as CHAR(10))` ``).
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
