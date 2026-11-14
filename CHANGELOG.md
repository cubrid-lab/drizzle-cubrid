# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `drizzle-cubrid/native` gets `drizzle(client)` with a native SELECT builder and session: `select()`/`selectDistinct()` with inner, left, right and cross joins, `where`, `groupBy`, `having`, `orderBy`, `limit`/`offset`, `.for('update')`, subqueries with `.as()`, `prepare()` with placeholders, `toSQL()` and `db.execute()`. Rows are read with `rowMode: 'array'` and mapped by position; values are typed binds by default (`binding: 'literal'` opts out); identifiers are double-quoted with embedded quotes doubled; date and time reads are refused from a client that does not decode in UTC. FULL JOIN, lateral joins, set operations, `offset()` without `limit()`, `for('share')`/`noWait`/`skipLocked` and collection values in conditions are refused (#158, #160).
- Experimental `drizzle-cubrid/native` entry point, the first slice of the CUBRID-native dialect (ADR 0007): `cubridTable()` with composite `primaryKey()` and `unique()` constraints, and column builders with CUBRID SQL types and codecs: `smallint`, `integer`/`int`, `bigint` (`mode: 'bigint'` exact; `mode: 'number'` throws beyond 2^53 − 1 instead of rounding), `numeric`/`decimal` (exact strings by default), `float`, `double`, `char`, `varchar`, `string`, `boolean` (SMALLINT 0/1), `datetime`, `timestamp`, `date`, `time` (UTC wall clock), `monetary`, and `set`/`multiset`/`sequence` with per-element codecs. It has no query builder or session yet and is not for production; see [docs/NATIVE_API.md](docs/NATIVE_API.md). The root `drizzle-cubrid` entry is unchanged (#157, #162).
- Lint and formatting are enforced in CI with Biome, pinned to 2.6.7: `npm run lint` runs `biome ci --error-on-warnings .` and `npm run format` applies fixes. The unused ESLint scripts and dependencies, which had no configuration and could not run, are removed (#167).
- Live CUBRID tests (`tests/integration.test.ts`, `npm run integration`) for transactions, joins, write metadata and collections, run in CI against CUBRID 11.4 (#181, #164).

### Fixed
- `package.json` `exports` give `require` consumers the `.d.cts` declarations (nested `import`/`require` conditions); TypeScript with `moduleResolution: node16` resolved the ESM `.d.ts` for CommonJS before.
- `monetary()` columns returned the driver's number although typed as `string`; they now return the number's shortest decimal string (`12.34` → `'12.34'`). Code that did arithmetic on the value without converting it now gets a string (#217).
- `datetime`, `timestamp`, `date` and `time` columns read cubrid-client's `Date` values. `select()` of a `datetime()` or `timestamp()` column threw `value.replace is not a function`, `date()` came back shifted by the process's UTC offset, and `mode: 'string'` columns returned a `Date` (#207).
- `db.$count(table, where?)` failed with `SqlSyntaxError`: Drizzle aliases the count `as count`, a reserved word in CUBRID, and read a mysql2-shaped result. The alias is dropped and the count read by position; it works in transactions and as a subquery (#199).
- Statement values are sent as typed binds through cubrid-client's `queryPrepared()`/`executePrepared()` instead of being written into the SQL text, despite the prepared-query naming (#191).
- Collection values are written as `CAST(SET{?, ?} AS SET(<element type>))`: with typed binds CUBRID refused `UPDATE ... SET q = SEQUENCE{?, ?}` (-494, cannot coerce host var). String elements, and collections without `element`, cast to `STRING`, except CHAR elements, which cast to their `CHAR(n)` so `eq()` on a CHAR collection still matches; element types with no known SQL type are not cast.
- Collection DDL now maps `bigint`, `double`, `float`, `boolean`, `datetime`, `timestamp`, `date` and `time` elements to their CUBRID types instead of `NUMBER`, `DATE` or the Drizzle JavaScript category.
- `insert`, `update` and `delete` report `affectedRows` and `lastInsertId` from cubrid-client's `execute()`; they returned `[]` with no counts. `$returningId()` returned `[]` and now returns the key of a one-row INSERT, keeping a `bigint` key exact (#182).
- SET, MULTISET and SEQUENCE columns: values are written as typed collection literals with one parameter per element (`SET{?, ?}`) and read as the arrays cubrid-client returns. Writing failed (`item.replaceAll is not a function`, or a SQL error) and reading parsed arrays as text (#184).
- Selected fields are now read from `query(sql, params, { rowMode: 'array' })` in select-list order instead of `Object.values()` of object rows. Joins whose tables share column names (`id`, `name`) returned one table's values under the other's fields; a partial select could return the wrong column under a field name (#183).
- `db.transaction()` now runs on a connection owned by `cubrid-client`'s `transaction()` instead of `BEGIN`/`COMMIT` on the shared client, so concurrent queries can no longer join, commit or roll back another request's transaction (#185).
- A failed `ROLLBACK TO SAVEPOINT` no longer replaces the nested callback's error; it is attached as `rollbackError`.

### Changed
- SQL that Drizzle's MySQL builders emit and CUBRID 11.4 always rejects with a generic -493 syntax error is refused before it is sent, with an error naming the alternative: `ilike()`/`notIlike()`, `.offset()` without `.limit()`, lateral joins, `.for('share')` and the `noWait`/`skipLocked` options, `insert().ignore()` and `delete().orderBy()`. CUBRID rejected each of these on the server. The refusal is thrown while the query is built, so `.catch()` on such a query throws synchronously; raw SQL given to `db.execute()` is refused if it uses ILIKE outside quotes and comments (#189).
- Relational queries that load relations with `with` now throw `Relational queries with 'with' (...) are not supported on CUBRID` before sending anything. In `mode: "default"` they failed with a syntax error (CUBRID has no `LEFT JOIN LATERAL`); in `mode: "planetscale"` CUBRID's JSON aggregation rejected DATE/DATETIME columns and garbled non-ASCII text in ISO-8859-1 databases, and Drizzle's `JSON.parse` of it rounded BIGINT values beyond 2^53. **Breaking for planetscale mode:** `with` on relations whose columns are only integers and ASCII (or any text in a UTF-8 database) returned correct results before and now throws. `findMany()`/`findFirst()` without `with` are unchanged (#200).
- **Breaking:** date and time columns follow Drizzle's MySQL convention, where the stored wall clock is UTC, and are read only from a client that decodes in UTC: create it with `timezone: 'utc'` or run with `TZ=UTC`. Selecting them with `select()` or `db.query` through a local-zone client in a non-UTC process is refused before the query is sent; other columns and `extras` that return a `Date` are passed through as they are (#207, #210).
- CUBRID's TIMESTAMP and TIME hold whole seconds and drop fractional seconds without an error; this is documented in `docs/SCHEMA.md`, and comparisons such as `gt(t.ts, new Date())` keep working (#207).
- **Breaking:** `date()` returns midnight UTC of the stored date; `mode: 'string'` columns return strings: `datetime` `YYYY-MM-DD HH:MM:SS.mmm`, `timestamp` `YYYY-MM-DD HH:MM:SS`, `date` `YYYY-MM-DD`, and `time` `HH:MM:SS` (#207).
- New `binding` option for `drizzle()`: `'prepared'` (default) or `'literal'`. Under the default, `drizzle()` throws at construction for a custom client without `queryPrepared()`, or with `execute()` but no `executePrepared()`, instead of falling back to SQL literals or losing write counts.
- `$returningId()` with an AUTO_INCREMENT key refuses a multi-row INSERT before sending it, since CUBRID does not report or promise consecutive keys. The result of `insert`, `update` and `delete` is typed `CubridRawQueryResult` with optional `affectedRows` and `lastInsertId`.
- Collection builders take a type parameter for the element type (`cubridSet<number>(...)`, `string` by default) and refuse non-array values and unsupported elements; the old brace-string parser and writer are removed.
- A custom client passed to `drizzle()` must return array rows from `query(sql, params, { rowMode: 'array' })`; object rows are refused for selects that map fields.
- Peer ranges are now `drizzle-orm >=0.44.1 <0.46.0` and `cubrid-client >=1.4.0 <2.0.0`. Older `drizzle-orm` versions fail to type-check (`tsc --noEmit`); see `docs/COMPATIBILITY.md` (#186).
- `accessMode`, `withConsistentSnapshot` and `isolationLevel: "read uncommitted"` are rejected, since CUBRID does not support them. `isolationLevel` needs cubrid-client 1.3.0 or later and is rejected with older drivers instead of being ignored.
- A custom client passed to `drizzle()` that has a `transaction` method must accept `(callback, options?)` and run the callback on the transaction's connection; `db.transaction()` now calls it.
- A callback error is rethrown as the same object with the driver's error attached as `transactionError` (and `rollbackError` when rolling back failed).

## [0.1.0] - 2026-03-13

### Added
- Initial release
- Drizzle ORM dialect for CUBRID database built on `mysql-core`
- `drizzle()` factory function with full type inference
- `cubridTable` — table builder (alias for `mysqlTable`)
- All MySQL-compatible column types (except JSON, which CUBRID does not support)
- CUBRID-specific custom types: `SET`, `MULTISET`, `SEQUENCE`, `MONETARY`
- `CubridSession`, `CubridPreparedQuery`, `CubridTransaction` — session layer
- Transaction support with savepoints (without `RELEASE SAVEPOINT`)
- Full query builder support: SELECT, INSERT, UPDATE, DELETE, JOIN
- Dual module format: ESM + CJS with TypeScript declarations
- 49 offline tests with 99%+ code coverage

[0.1.0]: https://github.com/cubrid-lab/drizzle-cubrid/releases/tag/v0.1.0
