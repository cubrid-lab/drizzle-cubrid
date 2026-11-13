# Queries Guide

This guide covers all query operations in `drizzle-cubrid` — SELECT, INSERT, UPDATE, DELETE, transactions, and raw SQL.

## Setup

```ts
import { createClient } from "cubrid-client";
import { drizzle } from "drizzle-cubrid";
import { cubridTable, int, varchar, timestamp } from "drizzle-cubrid";
import { eq, gt, lt, gte, lte, ne, and, or, not, sql } from "drizzle-cubrid";

// Define schema
const users = cubridTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  age: int("age"),
  created_at: timestamp("created_at").defaultNow(),
});

// Create client and Drizzle instance
const client = createClient({
  host: "localhost",
  port: 33000,
  database: "demodb",
  user: "dba",
});

const db = drizzle(client);
```

## SELECT

### Select All Columns

```ts
const allUsers = await db.select().from(users);
// SELECT `id`, `name`, `email`, `age`, `created_at` FROM `users`
```

### Select Specific Columns

```ts
const names = await db
  .select({ id: users.id, name: users.name })
  .from(users);
// SELECT `id`, `name` FROM `users`
```

### WHERE Clause

```ts
// Single condition
const alice = await db
  .select()
  .from(users)
  .where(eq(users.name, "Alice"));
// SELECT ... FROM `users` WHERE `name` = 'Alice'

// Multiple conditions with AND
const result = await db
  .select()
  .from(users)
  .where(and(gt(users.age, 18), lt(users.age, 65)));
// SELECT ... FROM `users` WHERE `age` > 18 AND `age` < 65

// OR conditions
const result2 = await db
  .select()
  .from(users)
  .where(or(eq(users.name, "Alice"), eq(users.name, "Bob")));
// SELECT ... FROM `users` WHERE `name` = 'Alice' OR `name` = 'Bob'
```

### Available Operators

| Function | SQL | Example |
|----------|-----|---------|
| `eq(col, val)` | `=` | `eq(users.name, "Alice")` |
| `ne(col, val)` | `<>` | `ne(users.status, "inactive")` |
| `gt(col, val)` | `>` | `gt(users.age, 18)` |
| `gte(col, val)` | `>=` | `gte(users.age, 18)` |
| `lt(col, val)` | `<` | `lt(users.age, 65)` |
| `lte(col, val)` | `<=` | `lte(users.age, 65)` |
| `and(...conds)` | `AND` | `and(eq(...), gt(...))` |
| `or(...conds)` | `OR` | `or(eq(...), eq(...))` |
| `not(cond)` | `NOT` | `not(eq(users.name, "Alice"))` |

### ORDER BY

```ts
import { asc, desc } from "drizzle-cubrid";

const sorted = await db
  .select()
  .from(users)
  .orderBy(asc(users.name));
// SELECT ... FROM `users` ORDER BY `name` ASC

const newest = await db
  .select()
  .from(users)
  .orderBy(desc(users.created_at));
```

### LIMIT and OFFSET

```ts
const page = await db
  .select()
  .from(users)
  .limit(10)
  .offset(20);
// SELECT ... FROM `users` LIMIT 10 OFFSET 20
```

### Aggregations

```ts
import { count, sum, avg, min, max } from "drizzle-cubrid";

const stats = await db
  .select({
    total: count(),
    avg_age: avg(users.age),
    max_age: max(users.age),
    min_age: min(users.age),
  })
  .from(users);
// SELECT COUNT(*), AVG(`age`), MAX(`age`), MIN(`age`) FROM `users`
```

### GROUP BY

```ts
const byAge = await db
  .select({
    age: users.age,
    cnt: count(),
  })
  .from(users)
  .groupBy(users.age);
// SELECT `age`, COUNT(*) FROM `users` GROUP BY `age`
```

### Joins

```ts
const posts = cubridTable("posts", {
  id: int("id").primaryKey().autoincrement(),
  title: varchar("title", { length: 200 }).notNull(),
  author_id: int("author_id").notNull(),
});

// Inner join
const result = await db
  .select({
    userName: users.name,
    postTitle: posts.title,
  })
  .from(users)
  .innerJoin(posts, eq(users.id, posts.author_id));
// SELECT `users`.`name`, `posts`.`title`
// FROM `users` INNER JOIN `posts` ON `users`.`id` = `posts`.`author_id`

// Left join
const result2 = await db
  .select()
  .from(users)
  .leftJoin(posts, eq(users.id, posts.author_id));
```

### Subqueries

```ts
const sq = db
  .select({ author_id: posts.author_id, cnt: count().as("cnt") })
  .from(posts)
  .groupBy(posts.author_id)
  .as("post_counts");

const activeAuthors = await db
  .select({
    name: users.name,
    postCount: sq.cnt,
  })
  .from(users)
  .innerJoin(sq, eq(users.id, sq.author_id));
```

## INSERT

### Single Row

```ts
await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
  age: 30,
});
// INSERT INTO `users` (`name`, `email`, `age`) VALUES ('Alice', 'alice@example.com', 30)
```

### Multiple Rows

```ts
await db.insert(users).values([
  { name: "Alice", email: "alice@example.com", age: 30 },
  { name: "Bob", email: "bob@example.com", age: 25 },
  { name: "Charlie", email: "charlie@example.com", age: 35 },
]);
```

### Insert with Default Values

Columns with `.default()` or `.defaultNow()` are optional:

```ts
await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
  // age defaults to null, created_at defaults to now()
});
```

### Affected rows and generated keys

`insert`, `update` and `delete` run through cubrid-client's `execute()`. The
result is an empty array that carries `affectedRows`, and for an INSERT that
generated an AUTO_INCREMENT value, `lastInsertId` (a `bigint` when it is beyond
`Number.MAX_SAFE_INTEGER`):

```ts
const result = await db.update(users).set({ age: 31 }).where(eq(users.id, 1));
result.affectedRows; // 1

const inserted = await db.insert(users).values({ name: "Alice", email: "a@example.com" });
inserted.lastInsertId; // 42
```

`$returningId()` returns the keys of the inserted rows:

```ts
const [{ id }] = await db.insert(users).values({ name: "Alice", email: "a@example.com" }).$returningId();
```

- An AUTO_INCREMENT key is reported only for an INSERT of **one row**. CUBRID
  reports just the first key of a multi-row INSERT and does not promise the
  others are consecutive, so a multi-row `$returningId()` with an
  AUTO_INCREMENT key is refused before anything is inserted. Insert those rows
  one at a time.
- The key is left out when the server reports none: when the INSERT sets the
  key itself, and when its values contain SQL functions or subqueries
  (cubrid-client reads the key only for a plain `INSERT ... VALUES`).
- With `onDuplicateKeyUpdate()`, an INSERT that updated an existing row reports
  `affectedRows: 2` and a `lastInsertId` CUBRID consumed without inserting; that
  value is no row's key, so `$returningId()` leaves it out.
- `INSERT ... SELECT` cannot report AUTO_INCREMENT keys and is refused.
- The key is returned in the column's JavaScript type: `bigint` for
  `bigint({ mode: "bigint" })`. A key a `number` column cannot hold exactly is
  refused.
- Keys from `$defaultFn()` are returned for every row.

`db.execute(sql\`...\`)` returns rows and reports no counts; use the query
builders when you need `affectedRows`.

## UPDATE

```ts
// Update specific rows
await db
  .update(users)
  .set({ name: "Alicia", age: 31 })
  .where(eq(users.id, 1));
// UPDATE `users` SET `name` = 'Alicia', `age` = 31 WHERE `id` = 1

// Update with expression
await db
  .update(users)
  .set({ age: sql`${users.age} + 1` })
  .where(gt(users.age, 0));
```

## DELETE

```ts
// Delete specific rows
await db.delete(users).where(eq(users.id, 1));
// DELETE FROM `users` WHERE `id` = 1

// Delete with conditions
await db.delete(users).where(lt(users.age, 18));
```

## Transactions

### Automatic Transaction

The callback pattern auto-commits on success and auto-rolls back on error:

```ts
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: "Alice", email: "a@example.com" });
  await tx.insert(users).values({ name: "Bob", email: "b@example.com" });
  // Auto-committed
});
```

Each `db.transaction()` runs on its own connection, taken through
`cubrid-client`'s `transaction(callback, options)` on a `CubridClient` or a
`CubridPool`. Queries made through `db` outside the callback, including from
concurrent requests, never join, commit or roll back that transaction. The
error the callback throws (including the `TransactionRollbackError` from
`tx.rollback()`) is rethrown as the same object. The driver's own error is
added to it as `error.transactionError`, and a failed rollback also as
`error.rollbackError`.

`isolationLevel` accepts `"read committed"`, `"repeatable read"` and
`"serializable"`, and needs cubrid-client 1.3.0 or later (`createPool()` needs
1.4.0). CUBRID has no `"read uncommitted"` level, read-only mode or
consistent-snapshot start, so `accessMode`, `withConsistentSnapshot` and
`"read uncommitted"` are rejected before the transaction starts:

```ts
await db.transaction(async (tx) => {
  // ...
}, { isolationLevel: "serializable" });
```

A custom client object passed to `drizzle()` must return each row as an array
of its values in select-list order from `query(sql, params, { rowMode: "array" })`,
as cubrid-client 1.4.0 does; selects that map fields refuse object rows, because
a column label shared by two tables keeps only one value in an object. A custom
client with a `transaction(callback, options?)` method must
run `callback` with a client for the transaction's connection, commit when it
resolves and roll back when it rejects. One without `transaction()` falls back
to `BEGIN`/`COMMIT` on its single connection, which is only safe if nothing
else uses that connection at the same time.

### Transaction with Rollback

```ts
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: "Alice", email: "a@example.com" });

    // Force rollback
    throw new Error("Something went wrong");
    // Auto-rolled back
  });
} catch (error) {
  console.error("Transaction failed:", error.message);
}
```

### Nested Transactions (Savepoints)

`drizzle-cubrid` supports nested transactions via CUBRID savepoints:

```ts
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: "Alice", email: "a@example.com" });

  // Nested transaction — creates SAVEPOINT sp1
  try {
    await tx.transaction(async (tx2) => {
      await tx2.insert(users).values({ name: "Bob", email: "b@example.com" });
      throw new Error("Inner failed");
      // ROLLBACK TO SAVEPOINT sp1
    });
  } catch {
    // Inner transaction rolled back, outer continues
  }

  // This still executes
  await tx.insert(users).values({ name: "Charlie", email: "c@example.com" });
  // Alice and Charlie are committed; Bob is rolled back
});
```

## Raw SQL

Use `sql` tagged template for raw SQL expressions:

```ts
import { sql } from "drizzle-cubrid";

// Raw query
const result = await db.execute(sql`SELECT COUNT(*) as cnt FROM users WHERE age > ${18}`);

// Raw expression in select
const result2 = await db
  .select({
    id: users.id,
    upper_name: sql<string>`UPPER(${users.name})`.as("upper_name"),
  })
  .from(users);
```

## Placeholders (Prepared Statements)

Use `placeholder()` to create reusable prepared queries:

```ts
import { placeholder } from "drizzle-cubrid";

const prepared = db
  .select()
  .from(users)
  .where(eq(users.id, placeholder("id")))
  .prepare();

// Execute with different values
const user1 = await prepared.execute({ id: 1 });
const user2 = await prepared.execute({ id: 2 });
```

## Logging

Enable SQL logging to see generated queries:

```ts
const db = drizzle(client, { logger: true });
// All queries will be logged to console
```

Or provide a custom logger:

```ts
import type { Logger } from "drizzle-orm";

class MyLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    console.log({ query, params });
  }
}

const db = drizzle(client, { logger: new MyLogger() });
```

## CUBRID-Specific Notes

### No RETURNING Clause

CUBRID does not support `INSERT ... RETURNING`. Use separate queries to fetch inserted rows:

```ts
// Insert then fetch
await db.insert(users).values({ name: "Alice", email: "a@example.com" });
const [inserted] = await db
  .select()
  .from(users)
  .where(eq(users.email, "a@example.com"));
```

### No Streaming

CUBRID does not support server-side cursors for streaming. Calling `.iterator()` on prepared queries throws an error. Use `LIMIT`/`OFFSET` for pagination instead.

### Identifier Case

CUBRID folds unquoted identifiers to lowercase. Column names in results will be lowercase:

```ts
const rows = await db.execute(sql`SELECT Name FROM users`);
// Column key is "name" (lowercase), not "Name"
```

## Next Steps

- [Schema Definition](./SCHEMA.md) — Column types, CUBRID-specific types, relations
- [Troubleshooting](./TROUBLESHOOTING.md) — Common errors and solutions
