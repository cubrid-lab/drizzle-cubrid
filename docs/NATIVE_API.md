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

**Not yet:** there is no query builder, session or `drizzle()` for native
tables (#158, #160), no relations, no migrations or DDL generation (#163),
and no indexes or foreign keys in `extraConfig`. Native tables are not
supported by the 0.x `drizzle()` from `drizzle-cubrid`.

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
`createClient({ ..., timezone: 'utc' })` or run with `TZ=UTC`. The columns only
convert values; refusing a client that decodes in another zone, as the 0.x
session does, belongs to the native session (#160), which will reuse the 0.x
timezone guard. `mode: 'string'` reads the wall clock in the formats above and
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
would refuse. The native query builder (#158, #159) will emit this literal
itself.

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
- Native columns assume a client that decodes date and time values in UTC
  (`timezone: 'utc'` or `TZ=UTC`); nothing enforces it until the native
  session (#160).
- Collection values cannot be passed to Drizzle's generic operators
  (`eq(t.tags, ['a'])`) yet: they need the collection literal, which the native
  query builder will emit (#158).
- Identifiers are case-insensitive: CUBRID stores `"userName"` as `username`.
