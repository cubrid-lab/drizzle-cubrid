# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `db.transaction()` now runs on a connection owned by `cubrid-client`'s `transaction()` instead of `BEGIN`/`COMMIT` on the shared client, so concurrent queries can no longer join, commit or roll back another request's transaction (#185).
- A failed `ROLLBACK TO SAVEPOINT` no longer replaces the nested callback's error; it is attached as `rollbackError`.

### Changed
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

[0.1.0]: https://github.com/cubrid-labs/drizzle-cubrid/releases/tag/v0.1.0
