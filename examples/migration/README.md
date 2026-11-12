# CUBRID schema migrations — not yet supported

**Status: blocked / design in progress.** This repository does **not** currently provide a verified CUBRID-native schema migration generator or migrator. Do not use MySQL, PostgreSQL, SQLite, or any other database dialect as a substitute.

## What was removed

The former `drizzle.config.ts` selected `dialect: 'mysql'` and suggested running `drizzle-kit generate` and `drizzle-kit migrate` against a CUBRID broker. That setup was never verified as a CUBRID migration path, could produce non-CUBRID DDL, and could attempt a foreign wire protocol. The config and its associated runnable schema example were removed rather than leaving an executable unsafe recommendation.

No replacement `drizzle-kit` configuration, generation command, `migrate()` API or SQL migration runner is shipped by this change. Do not reinterpret the absence of a config as a migration implementation.

## Native CUBRID direction

- [CUBRID-specific migration design and verification](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)
- [CUBRID-only implementation and dependency gate](https://github.com/cubrid-lab/drizzle-cubrid/issues/192)
- [Real CUBRID verification](https://github.com/cubrid-lab/drizzle-cubrid/issues/164)
- [Native architecture overview](https://github.com/cubrid-lab/drizzle-cubrid/issues/155)

The future migration implementation must generate and apply **CUBRID-native SQL** from verified CUBRID metadata and semantics, with versioned journals, idempotency, failure recovery and real-server tests. No SQL generated for other database engines and no cross-dialect transpilation or fallback are permitted.

Until such a tool exists and has passed the real CUBRID test gate, prepare schema changes using an independently verified **CUBRID-native** DDL procedure and your organization's review, backup and rollback requirements. This is a manual operational alternative, **not** a supported adapter migration API.
