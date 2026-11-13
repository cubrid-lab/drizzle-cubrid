# Native dialect feasibility (#156)

> **Result:** feasible, with caveats. A CUBRID dialect can be built on Drizzle ORM's database-neutral modules without any MySQL or other foreign-database code, and keep Drizzle's type inference. The decision that follows from this is [ADR 0007](adr/0007-drizzle-extension-boundary.md). Evidence date: 2026-11-13.

## What was tested

A throwaway prototype, about 700 lines kept outside this repository per the temporary-tooling rule in CONTRIBUTING, implemented:

- `cubridTable`
- `int`, `varchar` and `set` column builders
- `select()` with `where`, `innerJoin`, `leftJoin` and `limit`
- `insert().values()`, `update().set().where()` and `delete().where()`

Its only Drizzle imports were `drizzle-orm` and the subpaths `casing`, `column`, `column-builder`, `entity`, `operations`, `query-builders/select.types`, `query-promise`, `sql/sql`, `table` and `utils`. A grep guard over its sources and build output found no `*-core` import or identifier, and a canary `import 'drizzle-orm/mysql-core'` made the guard fail.

| Check | drizzle-orm 0.45.4 | drizzle-orm 0.44.1 (peer floor) | 1.0.0-rc.5 |
|---|---|---|---|
| `tsc --noEmit --strict`, with 16 type-equality assertions and 10 `@ts-expect-error` cases | pass | pass | 121 errors |
| Negative control: weakening 3 assertions makes `tsc` fail | pass | — | — |
| Runtime against a fake client: SQL text, parameters and mapped rows | same output | same output | — |
| Clean consumer `import()` and `require()` of every neutral symbol used | 108 ok | 106 ok; `drizzle-orm/errors` has no `DrizzleError` | — |

The type assertions cover:
- `$inferSelect` and `$inferInsert`: `notNull()` columns are required on insert, and `default()` makes them optional.
- A full `select()` gives `{ id: number; name: string; tags: string[] | null }[]`, and a partial select is exact.
- An `innerJoin` stays non-null. A partial `leftJoin` makes its fields `T | null`, and a full-table `leftJoin` makes the joined table object nullable.
- `sql<number>` keeps its type.
- Drizzle's generic `eq`, `and` and `gt` accept the CUBRID columns, and `eq(users.id, 'one')` is rejected.
- `insert` rejects a missing `notNull` field, a wrong type and an unknown key. `update().set()` rejects a wrong type and an unknown column.

### On a real CUBRID server

The SQL the prototype generates was run with cubrid-client 1.4.0 on CUBRID 11.4.7.1995:

| Statement (identifiers double-quoted, typed binds) | Result |
|---|---|
| `select … where "users"."id" = ?`, also with `[x]` and backtick quoting | all three quoting forms parse and run |
| multi-row `insert … values (?, ?, …), (?, upper('bob'), default)` | `affectedRows` 2; `DEFAULT` stored the column default |
| `… inner join … where (… = ? and … > ?) limit 5` | correct row |
| `… left join …` | unmatched row returned with `NULL` columns |
| `update … set "title" = ?, "views" = "posts"."views" + 1 where …` | `affectedRows` 1; `views` 5 → 6 |
| `delete … where "posts"."author_id" = ?` | `affectedRows` 2 |

The prototype writes a SET column by binding a JavaScript array. cubrid-client cannot bind arrays, so the live run used the 0.x typed literal `CAST(SET{?} AS SET(STRING))` for that one column. The native codec work (#162) owns this.

Not verified: Node 18 (the prototype ran on Node 24), subqueries, aliases, table extra config (indexes, foreign keys), and relational queries.

## Drizzle's extension surface

- **No third-party dialect API.** `Dialect` is the closed union `'pg' | 'mysql' | 'sqlite' | 'singlestore' | 'common' | 'gel'` (`column-builder.d.ts`). The dialect-keyed helpers `BuildColumn` and `ChangeColumnTableName` branch on it, so a native dialect defines its own column-building types.
- **The `exports` map is not a stability signal.** It lists every built file: 447 subpaths in 0.45.4, 443 in 0.44.1. A subpath can move inside the peer range: `drizzle-orm/errors` resolves to different files in 0.44.1 and 0.45.4. Prefer the root entry.
- **Public and enough for a dialect:**
  - the `Table`, `Column` and `ColumnBuilder` constructors and the `notNull`, `default` and `primaryKey` chain methods
  - the `ColumnBaseConfig`, `ColumnBuilderBaseConfig` and `MakeColumnConfig` types
  - `SQL`, `sql`, `Param`, `Placeholder` and `fillPlaceholders`
  - `QueryPromise`, `entityKind` and `is`
  - `InferSelectModel`, `InferInsertModel`, `getTableColumns` and `DrizzleTypeError`
  - `SelectedFields` and `SelectedFieldsOrdered`
  - `SelectResult`, `AppendToResult`, `BuildSubquerySelection` and `AppendToNullabilityMap` from `query-builders/select.types`
  - `relations`, `extractTablesRelationalConfig`, `Logger` and `CasingCache`
- **Internal but needed:**
  - `Table.Symbol` keys, created with `Symbol.for('drizzle:…')`, to register columns
  - `ColumnBuilder.build()`, which each dialect declares itself
  - `setName`, for key-as-name columns
  - `Column.shouldDisableInsert`
  - `SQL#decoder`
  - `mapResultRow` and `orderSelectedFields`, which exist in the JavaScript but not in the declarations

  ADR 0007 confines these to one shim.
- **Stability:**
  - **0.44.1 → 0.45.4:** the neutral declarations used (column, column-builder, table, entity, query-promise, sql, conditions, casing, relations) are byte-identical. Only `select.types` and `operations` gained `Subquery` handling.
  - **1.0.0-rc.5:** rewrites the column generics, for example `ColumnBaseConfig<TDataType>` with `dataType` strings like `'number int32'`.
- **Neutral is not dialect-free inside Drizzle.**
  - **Declarations:** `column-builder.d.ts` imports every dialect folder's declarations, so `skipLibCheck: false` reports errors inside drizzle-orm (upstream issue 5187).
  - **Runtime:** `sql/sql.js` and `relations.js` load `pg-core` helpers.

  These belong to Drizzle; #192 checks drizzle-cubrid's own sources and published files.

## Relational queries

In 0.4x, `db.query.x.findMany()` is built by dialect classes (`mysql-core/query-builders/query`, `MySqlDialect.buildRelationalQuery`). The neutral parts are:
- `relations`
- `extractTablesRelationalConfig`
- `normalizeRelation`
- `mapRelationalRow`
- the `DBQueryConfig` and `BuildQueryResult` types

A native version needs its own query builder and a CUBRID strategy for loading relations without `LATERAL` or JSON aggregation: joins with grouping, or one query per relation. 0.x already refuses `with` (#200), so `findMany`/`findFirst` without `with` come first. Drizzle 1.0 exports more relational helpers from its root; not evaluated here.

## Current imports in `src/` (main, 2026-11-13)

| Module | Used in | Classification |
|---|---|---|
| `drizzle-orm` (root) | `index.ts` | public, neutral |
| `drizzle-orm/entity`, `/logger`, `/column`, `/column-builder`, `/relations`, `/sql/sql` | driver, session, dialect, columns/temporal, columns/collections | public subpaths, neutral |
| `drizzle-orm/utils`: `Assume`, `DrizzleConfig`, `isConfig` | driver, session | public, neutral |
| `drizzle-orm/utils`: `mapResultRow`, through a namespace cast | session | **internal**: not in the declarations |
| private `joinsNotNullableMap` field | session | **internal** field access |
| `drizzle-orm/cache/core/cache`, `/cache/core/types` (types only) | session | exported but undocumented: **internal** |
| `drizzle-orm/mysql-core`: `mysqlTable`, `customType` | table, types, columns/collections | **foreign** |
| `mysql-core/db`, `/dialect`, `/session` | driver, dialect, session | **foreign** |
| `mysql-core/query-builders/select.types` | session | **foreign**; the neutral equivalent is `drizzle-orm/operations` |
| `mysql-core/columns/*` (19 re-exports, temporal subclasses) | columns, columns/temporal | **foreign**, and part of the public 0.x API |

## Licensing

- **The two licenses:** drizzle-orm is Apache-2.0 according to its `package.json`. Its npm tarball ships no LICENSE file; the upstream repository has the Apache-2.0 text and no NOTICE file. drizzle-cubrid is MIT.
- **Importing:** importing Drizzle's modules and types creates no copy obligation.
- **Copying or adapting:** Apache-2.0 §4 then requires shipping the license text, keeping upstream copyright and attribution notices, and marking modified files.
- **Current `src/`:** a manual check found no copied Drizzle code; it subclasses Drizzle classes and calls them. This was not a clone-detection scan. A full provenance audit is #220.

## Ownership boundary

- **Drizzle (imported, never copied):**
  - `entity`/`is`, `SQL`/`sql`/`Param`/`Placeholder` and the operators
  - the `Column`, `ColumnBuilder` and `Table` bases, and `QueryPromise`
  - `Infer*` and `select.types`
  - relations config, `Logger` and `CasingCache`
- **drizzle-cubrid (the CUBRID dialect):**
  - column builders and codecs
  - `cubridTable` and its extra config
  - the internal shim
  - the SQL compiler: quoting, LIMIT/OFFSET, and explicit refusal of unsupported features
  - query builders and row mapping
  - the session and transaction adapter
  - migrations
- **cubrid-client:**
  - the CAS protocol and connections
  - `query`/`queryPrepared` with `rowMode: 'array'`
  - `execute`/`executePrepared` metadata
  - `transaction()` and `stream()`
  - collection decoding and errors

## Implementation sequence

1. **#192:** import guard over `src` and the packed ESM/CJS/`.d.ts`, allow-listing today's 0.x debt. Add a type-test job against the peer floor and latest 0.45.x, plus a non-required Drizzle 1.0 canary. *Risk:* a regex guard can miss things, so pair it with an exports scan.
2. **#157 + #162:** native column builders, `cubridTable` and codecs (bigint, numeric, collections, UTC temporal), under a separate entry point beside the 0.x API. *Risk:* the 0.x builder API changes, so migration notes are needed.
3. **#158:** the select builder on `select.types`. *Risk:* subquery `.as()`, aliases and set operations are the largest part.
4. **#160:** session and row mapping on array rows; drop the cache import.
5. **#159:** insert, update and delete, with `affectedRows` and `lastInsertId`.
6. **#161:** transactions on `client.transaction()`, and savepoints.
7. **#165:** prepared queries and streaming. *Risk:* cursor lifetime.
8. **#163:** migrations, independent of drizzle-kit.

Real-server checks (#164) gate each step.
