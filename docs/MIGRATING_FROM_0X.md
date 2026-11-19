# Migrating from the 0.x API

Since **0.3.0** the root entry, `drizzle-cubrid`, is the CUBRID-native
dialect. The 0.x API, built on Drizzle's MySQL classes, moved to
`drizzle-cubrid/legacy`. It is **deprecated** and will be **removed in 1.0**
([ADR 0010](adr/0010-promote-native-root-deprecate-0x.md)).

| Release | `drizzle-cubrid` (root) | `drizzle-cubrid/native` | `drizzle-cubrid/legacy` |
| --- | --- | --- | --- |
| 0.2.x | 0.x API (MySQL-based) | Native preview | — |
| **0.3.x** | **Native API** | Alias of the root (same module) | 0.x API, deprecated, warns once |
| 1.x | Native API | Alias of the root, kept through 1.x | **Removed** |

There are two steps. Step 1 keeps your application running on 0.3 without
touching your code beyond imports. Step 2 moves it to the native API before
1.0.

## Step 1: keep the 0.x API on 0.3 (one import change)

Replace every `'drizzle-cubrid'` import of the 0.x API with
`'drizzle-cubrid/legacy'`. Names, objects and behaviour are unchanged.

```diff
-import { cubridTable, drizzle, eq, int, varchar, cubridSet } from 'drizzle-cubrid';
+import { cubridTable, drizzle, eq, int, varchar, cubridSet } from 'drizzle-cubrid/legacy';
```

Loading `drizzle-cubrid/legacy` prints one warning per process:

```text
(node:1234) [DRIZZLE_CUBRID_LEGACY] DeprecationWarning: drizzle-cubrid/legacy is the 0.x API built on Drizzle's MySQL classes. It is deprecated and will be removed in drizzle-cubrid 1.0. …
```

It is a standard Node.js deprecation warning, code `DRIZZLE_CUBRID_LEGACY`:

| To | Use |
| --- | --- |
| Silence all deprecation warnings | `node --no-deprecation`, or `NODE_OPTIONS=--no-deprecation` |
| Silence only this one (Node 20.11+/21.3+) | `node --disable-warning=DRIZZLE_CUBRID_LEGACY` |
| Find the code that imports it | `node --trace-deprecation` |
| Make it fail (CI) | `node --throw-deprecation`: the import throws |
| Handle it yourself | `process.on('warning', (w) => w.code === 'DRIZZLE_CUBRID_LEGACY' && …)` |

The root entry and `drizzle-cubrid/native` never print it. Editors show every
`drizzle-cubrid/legacy` export as deprecated (`@deprecated`), with the native
replacement in the hover text. (`mysqlEnum` is the one export whose note is not
in the published types; see ADR 0010.)

If you skip step 1, 0.x code that imports from the root fails loudly instead
of misbehaving:

- A name that the native API has too (`drizzle`, `cubridTable`, `int`,
  `varchar`, `timestamp`, `set`, …) now means the native one. Its options
  differ (below), so TypeScript reports errors such as
  `Property 'autoincrement' does not exist`.
- A 0.x name the native API does not have (`cubridSet`, `cubridMultiset`,
  `cubridSequence`, `customType`, `tinyint`, `mediumint`, `serial`, `year`,
  `real`, `text`, `tinytext`, `mediumtext`, `longtext`,
  `CubridPreparedQuery`) is a placeholder: TypeScript refuses to call it and
  prints what to use (`Type 'RemovedFromRoot<"drizzle-cubrid: cubridSet() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use set({ element }) from 'drizzle-cubrid'.">' has no call signatures`);
  at run time it throws `CubridRemovedExportError` with the same message.
- `mysqlEnum` and the 0.x types `CubridQueryable`, `CubridExecuteResult`,
  `CubridRawQueryResult`, `CubridCollectionElement` and
  `Cubrid{Set,Multiset,Sequence}ColumnBuilder` are not exported by the root:
  `has no exported member` in TypeScript, an import error in ESM.
- Drizzle's operators (`and`, `asc`, `avg`, `count`, `desc`, `eq`, `gt`,
  `gte`, `lt`, `lte`, `max`, `min`, `ne`, `not`, `or`, `placeholder`, `sql`,
  `sum`) are still exported by the root; they are drizzle-orm's own objects.

Do not mix the two APIs in one schema: a 0.x table cannot be queried through
the native `drizzle()` and a native table cannot be queried through the 0.x
one.

## Step 2: move to the native API

### Imports

| 0.x (`drizzle-cubrid` ≤ 0.2, `drizzle-cubrid/legacy` in 0.3) | Native (`drizzle-cubrid` ≥ 0.3) |
| --- | --- |
| `drizzle(client, { schema, mode, binding, logger })` | `drizzle(client, { schema, binding, logger, relationalReads })`; there is no `mode` |
| `CubridDatabase`, `CubridSession`, `CubridTransaction` | Same names, native classes |
| `CubridPreparedQuery` | `prepare()` returns `CubridPreparedSelect`, `CubridPreparedWrite` or `CubridPreparedRelationalQuery` |
| `CubridQueryable` (client type) | `CubridNativeClient` |
| `CubridExecuteResult`, `CubridRawQueryResult` | `CubridDmlResult` (`{ affectedRows, lastInsertId? }`) for writes |
| `CubridBinding` | `CubridBinding` (same values) |
| `cubridTable(name, columns, extra?)` | `cubridTable(name, columns, extra?)`, native table with `primaryKey`, `unique`, `index`, `uniqueIndex`, `foreignKey` |
| `int('id')` | `int('id')` or `integer()` (name defaults to the key) |
| `smallint`, `bigint('x', { mode })`, `decimal`, `float`, `double`, `char`, `varchar`, `boolean` | Same names; options below |
| `tinyint` | `smallint()` (CUBRID has no 8-bit integer) |
| `mediumint` | `integer()` |
| `serial` | `bigint({ mode: 'bigint' }).primaryKey().autoIncrement()` |
| `year` | `smallint()` |
| `real` | `double()` |
| `text`, `tinytext`, `mediumtext`, `longtext` | `string()` (`STRING`) or `varchar({ length })` |
| `mysqlEnum` | `varchar({ length }).$type<'a' \| 'b'>()` (not enforced by the server) |
| `date`, `datetime`, `timestamp`, `time` | Same names; see [Date and time](#date-and-time) |
| `binary`, `varbinary` (always threw in 0.x, #216) | `binary({ length })`, `varbinary({ length })` with `Buffer` values |
| `cubridSet`, `set` | `set({ element })` |
| `cubridMultiset`, `multiset` | `multiset({ element })` |
| `cubridSequence`, `sequence` | `sequence({ element })` |
| `monetary` | `monetary()` |
| `customType` | No custom types: a built-in builder, or raw `sql` (see [NATIVE_API.md](NATIVE_API.md#not-supported-in-the-native-dialect)) |
| `eq`, `and`, `sql`, … | Unchanged (from `drizzle-cubrid` or `drizzle-orm`) |

### Schema

```diff
-import { cubridTable, cubridSet, int, timestamp, varchar } from 'drizzle-cubrid';
+import { cubridTable, datetime, integer, set, varchar } from 'drizzle-cubrid';

 export const users = cubridTable('users', {
-  id: int('id').primaryKey().autoincrement(),
-  name: varchar('name', { length: 100 }).notNull(),
-  tags: cubridSet('tags', { element: varchar('tag', { length: 20 }) }),
-  createdAt: timestamp('created_at').defaultNow(),
+  id: integer().primaryKey().autoIncrement(),
+  name: varchar({ length: 100 }).notNull(),
+  tags: set({ element: varchar({ length: 20 }) }),
+  createdAt: datetime('created_at'), // DEFAULT comes from the DDL; see below
 });
```

- **Column names.** A native builder called without a name uses its key in
  the table (`id: integer()` is column `id`). Pass the name first when it
  differs (`createdAt: datetime('created_at')`).
- **`.autoincrement()` → `.autoIncrement()`**, on `smallint`, `integer`/`int`
  and `bigint`.
- **`bigint` needs a mode:** `bigint({ mode: 'bigint' })` is exact over the
  whole 64-bit range; `mode: 'number'` throws beyond ±(2^53 − 1) instead of
  rounding.
- **No `defaultNow()`, `onUpdateNow()`, unsigned or MySQL-only options.**
  `.default(value)` writes the `DEFAULT` keyword, so the value comes from the
  table's DDL, as in Drizzle; use `$defaultFn(() => new Date())` for a value
  computed by the application.
- **`.generatedAlwaysAs()` throws:** CUBRID generated columns are not
  supported yet.
- **Collections** take an element builder whose type sets both the SQL
  element type and the TypeScript element type (no `<number>` type
  argument): `sequence({ element: integer() })` is `SEQUENCE(INTEGER)` of
  `(number | null)[]`.
- **DDL and migrations.** The 0.x API generates no DDL. The native API has
  `generateInitialMigration(schema)` and `migrate()` from
  `drizzle-cubrid/migrator` (also `drizzle-cubrid/native/migrator`); see
  [MIGRATIONS.md](MIGRATIONS.md). Drizzle Kit is not supported in any
  dialect, as before.
- **Identifiers** are double-quoted (`"users"."name"`) instead of MySQL
  backticks. CUBRID stores identifiers in lower case either way.

### Behaviour differences

| Area | 0.x | Native |
| --- | --- | --- |
| Dates | UTC wall clock; reads need a client that decodes in UTC | The same rule (`createClient({ …, timezone: 'utc' })` or `TZ=UTC`), checked before a select of a date or time column is sent. `date()` reads midnight UTC; `timestamp()` values outside 1970-01-01 00:00:01–2038-01-19 03:14:07 UTC and years outside 0001–9999 are refused before sending ([Date and time](NATIVE_API.md#date-and-time)) |
| Parameters | Typed binds by default, `binding: 'literal'` optional | The same choice, but every value goes through its column's codec: integers are range-checked, `NUMERIC` written exactly, `CHAR` values sent as `cast(? as CHAR(n))`; an array parameter is refused ([Binding](NATIVE_API.md#binding)) |
| Unsupported SQL | Some MySQL constructs refused (#189), others sent | Refused before anything is sent: FULL/LATERAL joins, `for('share')`, `offset()` without `limit()`, comparing a collection with a value, … ([Errors and refusals](NATIVE_API.md#errors-and-refusals)) |
| Binary data | `binary()`/`varbinary()` throw | `BIT(n*8)`/`BIT VARYING(n*8)` with `Buffer` values, length-checked ([Binary](NATIVE_API.md#binary)) |
| `boolean()` | MySQL boolean builder | `SMALLINT` 1/0; any other stored value throws on read |
| `monetary()` | String | String (double precision on the server, as before) |
| Relational queries | `findMany`/`findFirst` without `with`; `with` refused (#200) | `with` to any depth, without `LATERAL` or JSON; `relationalReads` decides the snapshot ([Relational queries](NATIVE_API.md#relational-queries)) |
| Write results | Array with `affectedRows`/`lastInsertId` | `CubridDmlResult` `{ affectedRows, lastInsertId? }`; `$returningId()` as before ([Results](NATIVE_API.md#results)) |
| `db.execute(sql\`…\`)` | Rows or write metadata | Rows as cubrid-client returns them, not decoded |
| Transactions | `transaction()` of the client, or `BEGIN`/`COMMIT` on a client without it | `transaction()` of the client is required (a client without it is refused, #185); nested transactions are savepoints; `tx.rollback()` throws `CubridTransactionRollbackError` ([Transactions](NATIVE_API.md#transactions)) |
| Streaming | `iterator()` throws | `iterator()` on selects and set operations ([Streaming](NATIVE_API.md#streaming)) |
| Prepared queries | `prepare()` | `prepare()` on every query, relational ones included ([Prepared queries](NATIVE_API.md#prepared-queries)) |

### Checklist

1. Install 0.3 and change `'drizzle-cubrid'` imports to
   `'drizzle-cubrid/legacy'` (step 1). Run your tests.
2. Rewrite one schema module at a time with the native builders and import
   them from `'drizzle-cubrid'`. Queries over those tables must use the native
   `drizzle()`.
3. Compare the generated SQL (`.toSQL()`) and the results of your important
   queries against a CUBRID test database.
4. When nothing imports `drizzle-cubrid/legacy` any more, run with
   `--throw-deprecation` in CI to keep it that way.
5. Upgrade to 1.0 when it is released; `drizzle-cubrid/legacy` is gone there.

See [NATIVE_API.md](NATIVE_API.md) for the full native reference and
[COMPATIBILITY.md](COMPATIBILITY.md) for what is verified.
