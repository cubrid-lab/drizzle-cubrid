# Schema Definition

This guide covers how to define your database schema using `drizzle-cubrid`.

## Table Definition

Use `cubridTable` to define tables:

```ts
import { cubridTable, int, varchar } from "drizzle-cubrid";

export const users = cubridTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }).unique(),
});
```

`cubridTable` is an alias for `mysqlTable` from `drizzle-orm/mysql-core`, and most column builders are drizzle-orm's MySQL builders re-exported unchanged. CUBRID is not fully MySQL-compatible: only the behavior described here and covered by the live CUBRID 11.4 tests is verified, and some builders have known problems (see the notes below).

## Column Types

### Numeric Types

```ts
import {
  cubridTable,
  int,
  smallint,
  bigint,
  float,
  double,
  decimal,
  serial,
  tinyint,
  mediumint,
  real,
} from "drizzle-cubrid";

export const metrics = cubridTable("metrics", {
  id: serial("id").primaryKey(),
  count: int("cnt").notNull().default(0),
  small_val: smallint("small_val"),
  big_val: bigint("big_val", { mode: "number" }),
  ratio: float("ratio"),
  precise: double("precise"),
  price: decimal("price", { precision: 10, scale: 2 }),
  tiny: tinyint("tiny"),
  medium: mediumint("medium"),
  factor: real("factor"),
});
```

> **Note**: The column builders are drizzle-orm's MySQL builders, re-exported unchanged, so their SQL type names are MySQL's. drizzle-cubrid generates no DDL. CUBRID has no `BOOLEAN` and no `UNSIGNED` types (CUBRID 11.4 rejects `CREATE TABLE t (b BOOLEAN)` and `BIGINT UNSIGNED`), so create the tables yourself:
> - Declare a `boolean()` column as `SMALLINT`. `true`/`false` are stored as 1/0 and read back as `true`/`false`.
> - Declare a `serial()` column as `BIGINT AUTO_INCREMENT`.
>
> Values that differ from what the same builders return on MySQL (verified on CUBRID 11.4, [#189](https://github.com/cubrid-lab/drizzle-cubrid/issues/189)):
> - `bigint({ mode: "number" })` rounds values beyond 2^53 without an error (9007199254740993 reads back as 9007199254740992), as Drizzle does on MySQL. Use `mode: "bigint"` for exact values.
> - `float()` on a CUBRID `FLOAT` column is 32-bit: `1.1` reads back as `1.100000023841858`. Use `double()` on a `DOUBLE` column.
> - `sum()` and `avg()` return strings, as Drizzle does on MySQL; wrap them with `.mapWith(Number)` if needed.
>
> Schema migrations are tracked in [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163).

### String Types

```ts
import {
  cubridTable,
  int,
  varchar,
  char,
  text,
  tinytext,
  mediumtext,
  longtext,
} from "drizzle-cubrid";

export const documents = cubridTable("documents", {
  id: int("id").primaryKey().autoincrement(),
  code: char("code", { length: 10 }),
  title: varchar("title", { length: 255 }).notNull(),
  summary: text("summary"),
  notes: tinytext("notes"),
  body: mediumtext("body"),
  full_content: longtext("full_content"),
});
```

> **Note**: `char(n)` values come back padded with spaces to `n` characters (`'ab'` in `CHAR(5)` reads as `'ab   '`); MySQL strips the padding. Trim in your code or use `varchar` ([#189](https://github.com/cubrid-lab/drizzle-cubrid/issues/189)).

### Date/Time Types

```ts
import {
  cubridTable,
  int,
  date,
  datetime,
  timestamp,
  time,
  year,
} from "drizzle-cubrid";

export const events = cubridTable("events", {
  id: int("id").primaryKey().autoincrement(),
  event_date: date("event_date"),
  created_at: datetime("created_at"),
  updated_at: timestamp("updated_at").defaultNow(),
  start_time: time("start_time"),
  event_year: year("event_year"),
});
```

### Date and time columns

`datetime`, `timestamp`, `date` and `time` are Drizzle's MySQL builders, with the
same options and TypeScript types, adapted to the `Date` values cubrid-client
returns. They follow Drizzle's MySQL convention: the stored wall clock is UTC.

| Builder | Written | Read |
|---------|---------|------|
| `datetime()` (`mode: 'date'`) | UTC fields of the `Date`, with milliseconds | the same instant |
| `datetime({ mode: 'string' })` | the string | `YYYY-MM-DD HH:MM:SS.mmm` (CUBRID DATETIME always keeps milliseconds) |
| `timestamp()` | UTC fields of the `Date` | the same instant, in whole seconds |
| `timestamp({ mode: 'string' })` | the string | `YYYY-MM-DD HH:MM:SS` |
| `date()` | the UTC date of the `Date` | midnight UTC of that date |
| `date({ mode: 'string' })` | the string | `YYYY-MM-DD` |
| `time()` | the string | `HH:MM:SS` |

Reads are exact only when the client decodes these values in UTC. Create the
client with `timezone: 'utc'` (cubrid-client 1.4), or run the process with
`TZ=UTC`:

```ts
const client = createClient({ host, port, database, user, timezone: "utc" });
```

With any other client, a `select()` or relational query (`db.query`) of one of
these columns, of a SET/MULTISET/SEQUENCE of them, or of
`sql`...`.mapWith(column)` with one of them (as a field or in `extras`) is
refused before it is sent. Raw `sql<Date>` fields and `extras`, custom types,
`db.execute()` and `db.all()` return the driver's values unchanged. In
`db.query`, Drizzle does not apply `.mapWith()` to `extras`, so an extra
returns the driver's value even from a UTC client.

drizzle-cubrid finds the client's setting in its `timezone` option, a
`utcDates` field, or, for other clients, with one `SELECT DATETIME'...'` query
per client.

Server-side defaults such as `NOW()`, `SYS_DATETIME` or `defaultNow()` store the
server's wall clock, which reads back as UTC only when the server's time zone is
UTC. CUBRID's TIMESTAMP is converted between the session time zone and UTC on
the server; a wall clock that does not exist in the session zone (a DST gap) is
rejected by the server.

Fractional seconds: CUBRID's TIMESTAMP and TIME hold whole seconds and drop
fractions without an error, in every mode (`.678` in a `Date` or
`'01:02:03.456'` in a string is stored as `.000` / `01:02:03`). Use
`datetime()` when milliseconds matter.

### Binary Types

```ts
import { cubridTable, int, binary, varbinary } from "drizzle-cubrid";

export const files = cubridTable("files", {
  id: int("id").primaryKey().autoincrement(),
  hash: binary("hash", { length: 32 }),
  file_data: varbinary("file_data", { length: 1024 }),
});
```

> **Warning**: these builders do not round-trip on CUBRID's `BIT` / `BIT VARYING` columns: string values are written as hex digits or rejected (-494), and reads come back garbled. Do not use them until [#216](https://github.com/cubrid-lab/drizzle-cubrid/issues/216) is fixed.

## CUBRID-Specific Types

CUBRID has unique collection types and a monetary type not found in MySQL. `drizzle-cubrid` provides custom column builders for these. The "column SQL type" below is what the builder reports to Drizzle; drizzle-cubrid generates no DDL, so create the columns yourself:

### SET

An unordered collection of unique values:

```ts
import { cubridTable, int, set, varchar } from "drizzle-cubrid";

export const articles = cubridTable("articles", {
  id: int("id").primaryKey().autoincrement(),
  tags: set("tags", { element: varchar("tag", { length: 50 }) }),
});
```

Column SQL type: `SET(VARCHAR(50))`

**Reading and writing SET values:**

```ts
// Insert — pass an array
await db.insert(articles).values({
  tags: ["typescript", "cubrid", "orm"],
});

// Select — returns the array the server stored. SET removes duplicates
// and defines no order (CUBRID returned them sorted in testing).
const rows = await db.select().from(articles);
console.log(rows[0].tags); // ["cubrid", "orm", "typescript"]
```

### MULTISET

Like SET but allows duplicate values:

```ts
import { cubridTable, int, multiset } from "drizzle-cubrid";

export const logs = cubridTable("logs", {
  id: int("id").primaryKey().autoincrement(),
  error_codes: multiset<number>("error_codes", { element: int("code") }),
});
```

Column SQL type: `MULTISET(INTEGER)`

### SEQUENCE (LIST)

An ordered collection that allows duplicates:

```ts
import { cubridTable, decimal, int, sequence } from "drizzle-cubrid";

export const rankings = cubridTable("rankings", {
  id: int("id").primaryKey().autoincrement(),
  scores: sequence("scores", { element: decimal("score", { precision: 5, scale: 2 }) }),
});
```

Column SQL type: `SEQUENCE(DECIMAL(5,2))`. NUMERIC elements are returned as
decimal strings, as cubrid-client returns NUMERIC columns.

### MONETARY

CUBRID's native monetary type:

```ts
import { cubridTable, int, monetary } from "drizzle-cubrid";

export const products = cubridTable("products", {
  id: int("id").primaryKey().autoincrement(),
  price: monetary("price"),
});
```

Column SQL type: `MONETARY`

> **Note**: values are strings. CUBRID stores MONETARY as a double, so a value reads back as its shortest decimal form (`'12.30'` reads as `'12.3'`; very large or small values use exponent notation such as `'1e+21'`), with double precision; use `decimal()` for exact amounts ([#217](https://github.com/cubrid-lab/drizzle-cubrid/issues/217)).

### Collection Type Configuration

All collection types (`set`, `multiset`, `sequence`, also exported as
`cubridSet`, `cubridMultiset`, `cubridSequence`) take an optional `element`
column whose SQL type becomes the element type (`VARCHAR(100)` when omitted),
and a type parameter for the JavaScript element type (`string` by default):

```ts
set<number>("ids", { element: int("id") }); // SET(INTEGER), number[]
```

- **Reading.** cubrid-client 1.x returns the column as an array, with elements
  of the same JavaScript types as columns of the element type, and `null` for a
  NULL element. A non-array value from the driver is refused.
- **Writing.** The value must be an array. It is written as a typed collection
  literal with one parameter per element, such as `SET{?, ?}`, so quotes and
  backslashes in elements need no escaping. Elements may be strings, finite
  numbers, bigints, booleans, valid `Date`s, bytes (`Buffer` or `Uint8Array`)
  or `null`; nested arrays and other objects are refused before anything is
  sent. `[]` writes an empty collection. Bytes written into a string collection
  are stored as their hex text.
- **Element types without a CUBRID mapping** (such as `json`, `binary` and
  `varbinary` elements) are written without a cast. Under the default typed
  binding CUBRID refuses to update such a collection (-494); use
  `binding: "literal"` for it.
- **Placeholders.** `sql.placeholder()` cannot stand for a whole collection
  value in a prepared query; it is refused when the query runs. Pass the array
  directly.

## Column Modifiers

### Primary Key & Auto Increment

```ts
const table = cubridTable("example", {
  id: int("id").primaryKey().autoincrement(),
});
```

### Not Null

```ts
const table = cubridTable("example", {
  name: varchar("name", { length: 100 }).notNull(),
});
```

### Default Values

```ts
const table = cubridTable("example", {
  status: varchar("status", { length: 20 }).default("active"),
  count: int("cnt").default(0),
  created_at: timestamp("created_at").defaultNow(),
});
```

`.default()` and `.defaultNow()` make Drizzle send the `DEFAULT` keyword for a
missing value; the stored value comes from the `DEFAULT` clause in your
hand-written table DDL. A `.default("active")` with no matching `DEFAULT
'active'` in the table stores `NULL`. Use `$defaultFn()` to have Drizzle supply
the value itself.

### Unique

```ts
const table = cubridTable("example", {
  email: varchar("email", { length: 200 }).unique(),
});
```

## Relations

Define relations between tables for Drizzle's relational query API:

```ts
import { cubridTable, int, varchar } from "drizzle-cubrid";
import { relations } from "drizzle-orm";

export const users = cubridTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
});

export const posts = cubridTable("posts", {
  id: int("id").primaryKey().autoincrement(),
  title: varchar("title", { length: 200 }).notNull(),
  author_id: int("author_id").notNull(),
});

// Define relations
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.author_id],
    references: [users.id],
  }),
}));
```

Using relations in queries:

```ts
import { drizzle } from "drizzle-cubrid";
import * as schema from "./schema";

const db = drizzle(client, { schema, mode: "default" });

const someUsers = await db.query.users.findMany({ limit: 10 });
```

Loading relations with `with` is not supported on CUBRID yet and throws:
Drizzle's MySQL SQL for it uses `LEFT JOIN LATERAL` (`mode: "default"`), which
CUBRID lacks, or JSON aggregation (`mode: "planetscale"`), which CUBRID rejects
for DATE/DATETIME values and which garbles non-ASCII text in an ISO-8859-1
database; Drizzle also reads that JSON with `JSON.parse`, which rounds BIGINT
values beyond 2^53
([#200](https://github.com/cubrid-lab/drizzle-cubrid/issues/200)). Query the
related table separately or use a join; native support is tracked in
[#158](https://github.com/cubrid-lab/drizzle-cubrid/issues/158).

> **Note**: Relations require passing the `schema` option and `mode` to `drizzle()`.

## Custom Column Types

Use `customType` for types not covered by the built-in builders:

```ts
import { cubridTable, int } from "drizzle-cubrid";
import { customType } from "drizzle-cubrid";

const clob = customType<{ data: string; driverData: string }>({
  dataType() {
    return "CLOB";
  },
});

export const documents = cubridTable("documents", {
  id: int("id").primaryKey().autoincrement(),
  content: clob("content"),
});
```

## Complete Schema Example

A practical e-commerce schema:

```ts
import { cubridTable, int, varchar, decimal, timestamp, text } from "drizzle-cubrid";
import { set, monetary } from "drizzle-cubrid";
import { relations } from "drizzle-orm";

// Users table
export const users = cubridTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

// Products table with CUBRID-specific types
export const products = cubridTable("products", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  price: monetary("price"),
  tags: set("tags", { element: varchar("tag", { length: 50 }) }),
});

// Orders table
export const orders = cubridTable("orders", {
  id: int("id").primaryKey().autoincrement(),
  user_id: int("user_id").notNull(),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  created_at: timestamp("created_at").defaultNow(),
});

// Order items table
export const orderItems = cubridTable("order_items", {
  id: int("id").primaryKey().autoincrement(),
  order_id: int("order_id").notNull(),
  product_id: int("product_id").notNull(),
  quantity: int("quantity").notNull().default(1),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.user_id], references: [users.id] }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.order_id], references: [orders.id] }),
  product: one(products, { fields: [orderItems.product_id], references: [products.id] }),
}));
```

## Next Steps

- [Queries Guide](./QUERIES.md) — SELECT, INSERT, UPDATE, DELETE with full examples
- [Troubleshooting](./TROUBLESHOOTING.md) — Common errors and solutions
