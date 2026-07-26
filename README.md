# drizzle-cubrid

**Drizzle ORM dialect for the CUBRID database** — TypeScript-first, type-safe schema definition and query builder for Node.js.

[🇰🇷 한국어](docs/README.ko.md) · [🇺🇸 English](README.md)

<!-- BADGES:START -->
[![npm version](https://img.shields.io/npm/v/drizzle-cubrid)](https://www.npmjs.com/package/drizzle-cubrid)
[![node version](https://img.shields.io/node/v/drizzle-cubrid)](https://nodejs.org)
[![ci workflow](https://github.com/cubrid-lab/drizzle-cubrid/actions/workflows/ci.yml/badge.svg)](https://github.com/cubrid-lab/drizzle-cubrid/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/cubrid-lab/drizzle-cubrid/branch/main/graph/badge.svg)](https://codecov.io/gh/cubrid-lab/drizzle-cubrid)
[![license](https://img.shields.io/github/license/cubrid-lab/drizzle-cubrid)](https://github.com/cubrid-lab/drizzle-cubrid/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/cubrid-lab/drizzle-cubrid)](https://github.com/cubrid-lab/drizzle-cubrid)
<!-- BADGES:END -->

---

## Why drizzle-cubrid?

[Drizzle ORM](https://orm.drizzle.team/) is a modern TypeScript ORM with a SQL-like query API, zero dependencies, and first-class type inference. Until now, there was no Drizzle dialect for CUBRID.

`drizzle-cubrid` bridges that gap:

- **Type-safe queries** — Full TypeScript inference from schema to query results
- **Drizzle query API** — `select()`, `insert()`, `update()`, `delete()` with the familiar Drizzle chain syntax
- **CUBRID-specific types** — `SET`, `MULTISET`, `SEQUENCE`, `MONETARY` as native column builders
- **Transactions with savepoints** — Nested transaction support via CUBRID savepoints
- **Relations** — Drizzle relational query API (`db.query.users.findMany({ with: { posts: true } })`)
- **99%+ test coverage** — 52 offline tests, no database required for CI

### Architecture

```mermaid
flowchart TD
    A[Application] --> B[Drizzle ORM]
    B --> C[drizzle-cubrid dialect<br/>CubridDialect]
    C --> D[cubrid-client]
    D --> E[CUBRID Server]
```

## Installation

```bash
npm install drizzle-cubrid drizzle-orm cubrid-client
```

| Package | Purpose |
|---------|---------|
| `drizzle-cubrid` | CUBRID dialect for Drizzle (this package) |
| `drizzle-orm` | Drizzle ORM core |
| `cubrid-client` | TypeScript CUBRID driver |

**Requirements**: Node.js 18+, CUBRID 10.2+

## Quick Start

### 1. Define Your Schema

```ts
// schema.ts
import { cubridTable, int, varchar, timestamp } from "drizzle-cubrid";

export const users = cubridTable("users", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});
```

### 2. Connect and Query

```ts
// app.ts
import { createClient } from "cubrid-client";
import { drizzle } from "drizzle-cubrid";
import { eq } from "drizzle-cubrid";
import { users } from "./schema";

const client = createClient({
  host: "localhost",
  port: 33000,
  database: "demodb",
  user: "dba",
});

const db = drizzle(client);

// Insert
await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
});

// Select with type-safe results
const allUsers = await db.select().from(users);
// allUsers: { id: number; name: string; email: string; created_at: Date | null }[]

// Where clause
const alice = await db
  .select()
  .from(users)
  .where(eq(users.name, "Alice"));

// Update
await db
  .update(users)
  .set({ name: "Alicia" })
  .where(eq(users.id, 1));

// Delete
await db.delete(users).where(eq(users.id, 1));

// Close connection
await client.close();
```

## CUBRID-Specific Column Types

Beyond standard SQL types, CUBRID has collection types and a monetary type:

```ts
import { cubridTable, int, varchar } from "drizzle-cubrid";
import { cubridSet, cubridMultiset, cubridSequence, monetary } from "drizzle-cubrid";

export const products = cubridTable("products", {
  id: int("id").primaryKey().autoincrement(),
  name: varchar("name", { length: 100 }),

  // SET — unordered unique values → SET(VARCHAR(50))
  tags: cubridSet("tags", { element: varchar("tag_item", { length: 50 }) }),

  // MULTISET — unordered, allows duplicates → MULTISET(VARCHAR(50))
  categories: cubridMultiset("categories", { element: varchar("category_item", { length: 50 }) }),

  // SEQUENCE — ordered, allows duplicates → SEQUENCE(INTEGER)
  rankings: cubridSequence("rankings", { element: int("rank_item") }),

  // MONETARY — CUBRID native monetary type → MONETARY
  price: monetary("price"),
});
```

```ts
// Insert with collection values
await db.insert(products).values({
  name: "Widget",
  tags: ["sale", "new"],           // string[] → SET
  categories: ["electronics"],     // string[] → MULTISET
  rankings: ["1", "3", "5"],       // string[] → SEQUENCE
});

// Select — collections return string[]
const rows = await db.select().from(products);
console.log(rows[0].tags); // ["sale", "new"]
```

## Transactions

### Automatic (Recommended)

```ts
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: "Alice", email: "a@example.com" });
  await tx.insert(users).values({ name: "Bob", email: "b@example.com" });
  // Auto-committed on success, auto-rolled back on error
});
```

### Nested Transactions (Savepoints)

```ts
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: "Alice", email: "a@example.com" });

  try {
    await tx.transaction(async (tx2) => {
      // SAVEPOINT sp1
      await tx2.insert(users).values({ name: "Bob", email: "b@example.com" });
      throw new Error("rollback inner only");
      // ROLLBACK TO SAVEPOINT sp1
    });
  } catch {
    // Inner rolled back, outer continues
  }

  await tx.insert(users).values({ name: "Charlie", email: "c@example.com" });
  // Alice + Charlie committed, Bob rolled back
});
```

## Relations

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

```ts
import * as schema from "./schema";

const db = drizzle(client, { schema, mode: "default" });

const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

## Error Handling

Errors propagate from `cubrid-client` with structured error types:

```ts
import { ConnectionError, QueryError, TransactionError } from "cubrid-client";

try {
  await db.select().from(users);
} catch (error) {
  if (error instanceof QueryError) {
    console.error("Query failed:", error.message);
    console.error("Cause:", error.cause);
  }
}
```

## CUBRID Limitations

| Feature | Status | Notes |
|---------|--------|-------|
| `INSERT ... RETURNING` | ❌ Not supported | Use separate SELECT after INSERT |
| Streaming / iterators | ❌ Not supported | Use LIMIT/OFFSET for pagination |
| JSON columns | ❌ Not supported | Use VARCHAR with manual serialization |
| Native BOOLEAN | ❌ Not supported | Mapped to SMALLINT (0/1) |
| Sequences | ❌ Not supported | Use AUTO_INCREMENT |

## Documentation

| Document | Description |
|----------|-------------|
| [Schema Guide](docs/SCHEMA.md) | Column types, CUBRID types, relations, custom types |
| [Queries Guide](docs/QUERIES.md) | SELECT, INSERT, UPDATE, DELETE, joins, aggregations, raw SQL |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common errors, TypeScript issues, performance tips |
| [Migration Example](examples/migration/README.md) | Drizzle Kit config, schema, and CUBRID migration notes |

## Development

```bash
git clone https://github.com/cubrid-labs/drizzle-cubrid.git
cd drizzle-cubrid
npm install
npm run build        # TypeScript compilation
npm run check        # Lint + type-check + test
npm test             # Run tests
```

## Ecosystem

| Package | Description |
|---------|-------------|
| [cubrid-client](https://github.com/cubrid-labs/cubrid-client) | TypeScript CUBRID driver |
| [drizzle-cubrid](https://github.com/cubrid-labs/drizzle-cubrid) | Drizzle ORM dialect (this package) |

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for this project's direction and next milestones.

For the ecosystem-wide view, see the [CUBRID Labs Ecosystem Roadmap](https://github.com/cubrid-labs/.github/blob/main/ROADMAP.md) and [Project Board](https://github.com/orgs/cubrid-labs/projects/2).

## License

MIT — see [LICENSE](LICENSE).
