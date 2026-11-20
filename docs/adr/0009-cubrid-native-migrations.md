# ADR 0009: Apply CUBRID schema migrations as ordered SQL files, one transaction per migration

- **Status:** Accepted
- **Date:** 2026-11-18 (proposed)
- **Accepted:** 2026-11-20 by maintainer yeongseon, recorded in PR #PRNUM
- **Decision scope:** How drizzle-cubrid generates and applies schema migrations for `drizzle-cubrid/native`: the `drizzle-cubrid/native/migrator` entry, its file format, metadata table, transaction boundary, concurrency guard, SQL refusals and recovery policy; what stays unsupported
- **Prerequisites:** [ADR 0003](0003-native-architecture-boundaries.md) (accepted), [ADR 0007](0007-drizzle-extension-boundary.md) (accepted), issue [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)

## Context

ADR 0003 forbids a foreign-database migration path: no drizzle-kit in a MySQL (or any other) dialect mode, no foreign driver and no rewriting of SQL generated for another database. The former `dialect: 'mysql'` example was removed in #193, so drizzle-cubrid had no migration path at all.

**Drizzle Kit has no CUBRID extension point.** Its generators and appliers are per dialect inside drizzle-kit (`dialect` is a closed set of `postgresql`, `mysql`, `sqlite`, `turso`, `singlestore`, `gel`), and its snapshots and diff are built from the dialect's own `*-core` table classes. A native `CubridTable` is neither. The only drizzle-kit route would be the MySQL mode that ADR 0003 forbids.

**Measured DDL behavior.** The safety of any applier depends on what CUBRID does with DDL inside a transaction, so it was measured first, on CUBRID **11.4.7.1995** (the pinned `cubrid/cubrid:11.4` image, the only server version this project tests) through cubrid-client 1.4's `transaction()`. Each result is now a live test in `tests/integration.test.ts` (`DDL in a transaction on CUBRID (#163, ADR 0009)`):

| Question | Measured on 11.4 |
| --- | --- |
| Does a rollback undo `CREATE TABLE`? | Yes. The table, its rows and its catalog entry are gone. |
| Does a rollback undo `ALTER TABLE … ADD COLUMN` / `DROP COLUMN`, `CREATE [UNIQUE] INDEX`, `DROP INDEX`, `ADD CONSTRAINT … UNIQUE`, `CREATE VIEW`, `CREATE SERIAL`, `DROP TABLE`, `RENAME TABLE`? | Yes, every one, in one transaction together. |
| Does DDL commit the DML before it (MySQL's implicit commit)? | No. An `INSERT` before the DDL is rolled back with it. |
| Is a table created in a transaction visible before commit? | To that transaction, yes (`db_class`, `db_attribute`). To another session, no, and that session's catalog query is not blocked. After commit it is visible to all. |
| Does another session wait on a table altered in an open transaction? | Yes. The `ALTER` holds a schema-modification lock until commit; another session's `SELECT` on that table waits for it (with the default infinite `lock_timeout`, until the commit). |
| Does a failed statement end the transaction? | No. The statement fails alone; the DDL before it stays in the open transaction and commits if the transaction commits. |
| Is `CREATE TABLE IF NOT EXISTS` safe when two sessions run it at once? | No. One of them can fail with -65 (`Class … already exists`), seen with two concurrent `migrate()` calls. |
| Who commits? | **The driver, not the engine.** Outside `transaction()`, cubrid-client sends each statement with CAS autocommit on, so each one commits at once. Inside `transaction()` autocommit is off on the transaction's own connection until it commits: another session sees neither DML nor DDL before that. |

Other statement kinds (`TRUNCATE`, `GRANT`, `CREATE USER`, stored routines, partitioning, `ALTER … AUTO_INCREMENT`, …) were **not** measured, and other server versions were not tested. This ADR makes no claim about them.

**SQL that looks like MySQL.** CUBRID 11.4 accepts some MySQL forms (backtick identifiers, `AUTO_INCREMENT = n` as a table option, `CHARSET x`, inline `KEY`/`INDEX`, `CHANGE COLUMN`, `RENAME TABLE`) and rejects others (`ENGINE=InnoDB`, `UNSIGNED`, `DEFAULT CHARSET=utf8`, `SERIAL` columns, a `#` comment). Accepting a statement is not proof that it means what it means on MySQL.

## Decision

1. **A new entry, `drizzle-cubrid/native/migrator`, applies migrations.** `migrate(db, { migrationsFolder, migrationsTable?, dryRun? })` takes the native `drizzle()` database. The entry is bundled on its own and imports no native module at runtime, so it never creates a second copy of a native class. It uses only cubrid-client through the native database, Drizzle's neutral `sql` template and Node built-ins.
2. **Migrations are ordered CUBRID SQL files** (UTF-8; symbolic links followed; a folder with no migration is refused as a likely wrong path). A migration is `<number>_<name>.sql` (`0001_create_users.sql`): the number is the order, the name is letters, digits, `_` and `-`. Numbers must be 1, 2, 3, … with no gap or duplicate. Statements are separated by `;` outside string literals, quoted identifiers (`"…"`, `[…]`) and comments (`--`, `//`, `/* */`). Other files and subfolders are ignored. There are no down migrations: a `*.down.sql` file is refused, and a change is undone by a new migration.
3. **A metadata table records what was applied.** `__drizzle_cubrid_migrations` (or `migrationsTable`) holds `id`, `name`, `checksum` (SHA-256 hex of the file, without a leading BOM and with CRLF read as LF) and `applied_at` (UTC `DATETIME`). The record must be numbered 1 to k without a gap, and every recorded migration the folder has must have the same name and checksum.
   - **A database ahead of the folder is tolerated**, as Flyway does by default: records beyond the folder's last file are returned as `ahead` and nothing is applied. An older application version must be able to start during a rolling deploy or after a rollback of the application (not of the schema); refusing would turn every such deploy into an outage. The folder's own migrations are still verified, so an edited or renamed file is still refused. There is no strict option yet; callers that must not run against a newer schema check `ahead`.
4. **Everything is checked before the first statement.** File names, numbering, the SQL of every file (decision 6) and the records are checked first. An edited, renamed or missing applied migration, or a record with a gap, rejects the whole call with an `'applied-mismatch'` error and applies nothing. A rerun when up to date runs no migration statement.
5. **One transaction per migration.** Each pending migration runs in its own `'read committed'` transaction on a connection that cubrid-client's `transaction()` owns: take the lock row, read the records again, run the statements in order, insert the record, commit. The statements and the record commit or roll back together. Because CUBRID 11.4 rolls back DDL (Context), a failed statement rolls the whole migration back: nothing of it stays and it is not recorded. Migrations before it stay committed. The error is a `CubridMigrationError` with `code: 'statement-failed'`, the migration, the statement (index, line, SQL) and the driver error as `cause`.
6. **A validator, not a transpiler.** `migrate()` and `readMigrationFiles()` refuse, with the file, line and column:
   - drizzle-kit output (`--> statement-breakpoint`, a `meta/_journal.json` folder) and backtick identifiers. CUBRID accepts backticks, but they mark SQL generated for MySQL, and drizzle-cubrid quotes with `"`.
   - MySQL forms CUBRID rejects or reads differently: `ENGINE=` (only as a `CREATE TABLE`/`ALTER TABLE` option, so `UPDATE cars SET engine = …` is accepted), `UNSIGNED`, `ZEROFILL`, `DEFAULT CHARSET`/`DEFAULT CHARACTER SET`, `/*! … */` conditional comments (MySQL runs them, CUBRID ignores them) and `#` comments.
   - MySQL statements and client commands: `USE`, `DELIMITER`, `LOCK`, `UNLOCK`.
   - Transaction control, which belongs to the migrator: `BEGIN`, `START`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `XA`, `SET TRANSACTION`; and `SET SYSTEM PARAMETERS`, whose effect inside a migration transaction was not measured.
   - `CREATE [OR REPLACE] PROCEDURE|FUNCTION`: a PL/CSQL body contains `;`, which the splitter cannot tell from a statement end.
   - `?` parameters, unterminated quotes and comments, and an empty migration.

   `AUTO_INCREMENT = n` is **not** refused: it is a documented CUBRID table option and works on 11.4. No statement is ever rewritten.
7. **Concurrency guard: a lock row.** `<migrationsTable>_lock` has one row. Each migration transaction updates it first, so a second `migrate()` waits there (for CUBRID's lock timeout) until the first commits or rolls back. It then reads the records again and skips a migration that is already recorded. The record and lock tables are created with `CREATE TABLE IF NOT EXISTS` in autocommit mode, before any migration; a failure is ignored when the table exists afterwards (the -65 race above), and so is a failed insert of the lock row when the row exists afterwards.
8. **Generation: the initial migration only.** `generateInitialMigration(schema)` in `drizzle-cubrid/native` writes `CREATE TABLE` for the native tables of a schema (columns, `AUTO_INCREMENT`, defaults, `NOT NULL`, primary keys, unique constraints, and foreign keys as table constraints with their `ON DELETE`/`ON UPDATE` actions), each followed by a `CREATE [UNIQUE] INDEX` per declared index, from the same DDL code the live tests use. Tables keep the schema's order, except that a referenced table is moved before the first table that references it (recursively; a self-reference stays inside its own `CREATE TABLE`), so the output depends only on the schema. It refuses non-native tables, the cases that code already refuses (`DEFAULT sql\`…\``, two primary keys, and the foreign key and index refusals of [NATIVE_API.md](../NATIVE_API.md#indexes-and-foreign-keys)), a foreign key to a table outside the schema, and a cycle of foreign keys between tables. A cycle is refused, not split into `ALTER TABLE … ADD CONSTRAINT`, to keep one statement per table; one key of the cycle goes in a hand-written later migration. Amended for #157, which added indexes and foreign keys. Later changes are written by hand as `ALTER` migrations.
9. **Unsupported, and refused or absent rather than emulated:** schema diffing and `ALTER` generation, catalog introspection or reflection (`pull`), `push`, down migrations, drizzle-kit `generate`/`migrate`/`push`/`pull`/`studio` in any dialect, stored routines in migration files, and migrations for the 0.x `drizzle-cubrid` entry.

## Alternatives considered

- **drizzle-kit in MySQL mode:** forbidden by ADR 0003. It would generate MySQL DDL (backticks, `ENGINE`, `UNSIGNED`) and apply it over a MySQL driver.
- **Rewrite drizzle-kit's MySQL output into CUBRID SQL:** forbidden by ADR 0003 (a transpiler). It would also hide semantic differences that only the validator's refusals make visible.
- **Schema diff from catalog introspection now:** deferred. It needs a reflected model of CUBRID types, defaults, indexes, keys and their naming (`pk_<table>_<col>`, `fk_…`), and rules for unsafe changes (type narrowing, dropping columns). It is larger than #163's applier and is better as its own issue, built on the measured catalog.
- **All pending migrations in one transaction:** rejected as the default. It would roll back migrations that succeeded, and would hold schema locks for the whole run. Per-migration transactions keep each committed step durable and still roll back the failing one whole.
- **Advisory lock (`GET_LOCK`) for concurrency:** CUBRID has no named advisory locks. A row lock in an ordinary table works on every version that has row locks and is released by the same commit or rollback.
- **No metadata table, idempotent SQL only (`IF NOT EXISTS`):** rejected. It cannot detect an edited migration, cannot express `ALTER … DROP` safely and cannot order data migrations.
- **Executing a migration's statements in autocommit mode:** rejected. A failure partway would leave the earlier statements committed and the migration unrecorded, so a rerun would fail on them.

## Consequences and trade-offs

- **Recovery is "fix and rerun".** A failed migration leaves the database at the previous migration (on 11.4, for the statement kinds measured), so the file can be fixed and `migrate()` run again. An applied migration must never be edited; the checksum refuses it. A failed `COMMIT` can have an unknown outcome (cubrid-client's `outcomeUnknown`); the statements and the record commit together, so a rerun sees either both or neither.
- **Statements whose transactional behavior was not measured** may not roll back with the migration. Keep them in a migration of their own and check the database after a failure. Back up before migrating production data.
- **`migrate()` inside the caller's own open transaction hangs.** Its migrations run on connections of their own and wait for that transaction's locks (CUBRID's default `lock_timeout` is infinite). cubrid-client tracks enclosing `transaction()` calls only in a private field, so drizzle-cubrid cannot detect this without depending on driver internals; `migrate()` refuses a `tx` it is given, and the case is documented prominently instead.
- **Migrations block the tables they change.** A migration's DDL holds schema locks until it commits: application queries on an altered table wait until then (measured), and a concurrent `migrate()` waits on the lock row, both for as long as CUBRID's `lock_timeout` allows. Keep migrations short, or run them when the application is quiet.
- **The validator can refuse valid CUBRID SQL** (backticks) and cannot catch every foreign construct. It refuses what it lists; it is not a CUBRID parser. Adding a rule can make an existing pending file fail validation; applied files are only compared by checksum, but they are still parsed, so a new rule also applies to them.
- **No generated ALTER.** Users write later migrations by hand. That is explicit in the API (the generator is named `generateInitialMigration`) and in the docs.
- **New public API** in an experimental entry: `migrate`, `readMigrationFiles`, `CubridMigrationError` and types in `drizzle-cubrid/native/migrator`, and `generateInitialMigration` in `drizzle-cubrid/native`. Like the rest of `drizzle-cubrid/native`, it can change before 1.0.

## Verification / acceptance criteria

- [x] The DDL behavior above is measured on CUBRID 11.4.7.1995 and kept as live tests (`DDL in a transaction on CUBRID (#163, ADR 0009)` in `tests/integration.test.ts`).
- [x] Live tests apply CREATE, ALTER ADD/DROP COLUMN, index and constraint (unique index, foreign key) migrations, rerun without applying anything, recover from a failing migration (rolled back whole, fixed, reapplied), refuse an edited applied migration and foreign SQL before applying anything, accept a database ahead of an older folder, ignore another owner's table of the record table's name, apply each migration once under two concurrent `migrate()` calls, and round-trip rows through the native query API on the migrated tables (`drizzle-cubrid/native/migrator on CUBRID (#163)`).
- [x] Unit tests cover splitting, every refusal rule, file naming and numbering, checksums, the record checks, dry runs and errors (`tests/migrator.test.ts`).
- [x] The packed tarball's `drizzle-cubrid/native/migrator` (ESM and CJS) is exercised on Node 18 and by the packed live suite.
- [ ] Other supported CUBRID versions, if any are declared, are measured before migration support is claimed for them.
- [x] A maintainer accepts this ADR explicitly in a reviewed PR.

## References

- [docs/MIGRATIONS.md](../MIGRATIONS.md): usage, file format, refusals and recovery
- `src/native/migrator.ts`, `src/native/migration-sql.ts`, `src/native/ddl.ts`
- [ADR 0003](0003-native-architecture-boundaries.md), [ADR 0007](0007-drizzle-extension-boundary.md)
- Issues: [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163), [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192), [#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164), [#193](https://github.com/cubrid-lab/drizzle-cubrid/pull/193)
