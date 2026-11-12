# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `db.transaction()` now runs on a connection owned by `cubrid-client`'s `transaction()` instead of `BEGIN`/`COMMIT` on the shared client, so concurrent queries can no longer join, commit or roll back another request's transaction (#185).
- A failed `ROLLBACK TO SAVEPOINT` no longer replaces the nested callback's error; it is attached as `rollbackError`.

### Changed
- `accessMode`, `withConsistentSnapshot` and `isolationLevel: "read uncommitted"` are rejected, since CUBRID does not support them.

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
