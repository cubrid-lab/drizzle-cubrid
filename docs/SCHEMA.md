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

`cubridTable` is an alias for `mysqlTable` from `drizzle-orm/mysql-core`. CUBRID's SQL dialect is MySQL-compatible, so all `mysql-core` column builders work with CUBRID.

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

> **Note**: CUBRID does not have a native `BOOLEAN` type. The `boolean()` column compiles to `SMALLINT` with values 0/1. The `serial()` column compiles to `BIGINT UNSIGNED AUTO_INCREMENT`.

### String Types

```ts
import {
  cubridTable,
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

### Binary Types

```ts
import { cubridTable, int, binary, varbinary } from "drizzle-cubrid";

export const files = cubridTable("files", {
  id: int("id").primaryKey().autoincrement(),
  hash: binary("hash", { length: 32 }),
  file_data: varbinary("file_data", { length: 1024 }),
});
```

## CUBRID-Specific Types

CUBRID has unique collection types and a monetary type not found in MySQL. `drizzle-cubrid` provides custom column builders for these:

### SET

An unordered collection of unique values:

```ts
import { cubridTable, int, set, varchar } from "drizzle-cubrid";

export const articles = cubridTable("articles", {
  id: int("id").primaryKey().autoincrement(),
  tags: set("tags", { element: varchar("tag", { length: 50 }) }),
});
```

Generates: `tags SET(VARCHAR(50))`

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

Generates: `error_codes MULTISET(INTEGER)`

### SEQUENCE (LIST)

An ordered collection that allows duplicates:

```ts
import { cubridTable, decimal, int, sequence } from "drizzle-cubrid";

export const rankings = cubridTable("rankings", {
  id: int("id").primaryKey().autoincrement(),
  scores: sequence("scores", { element: decimal("score", { precision: 5, scale: 2 }) }),
});
```

Generates: `scores SEQUENCE(DECIMAL(5,2))`. NUMERIC elements are returned as
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

Generates: `price MONETARY`

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

// Fetch users with their posts
const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
```

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
