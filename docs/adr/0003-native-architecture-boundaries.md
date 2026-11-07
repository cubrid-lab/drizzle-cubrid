# ADR 0003: Native CUBRID architecture boundaries

- **Status:** Proposed
- **Date:** 2026-11-07
- **Prerequisite:** Approval and merge of this repository's release policy ADR in its earlier release-policy PR
- **Decision scope:** TypeScript Drizzle ORM CUBRID-native dialect and migration ownership

## Context

The current adapter inherits MySqlDatabase/MySqlDialect and aliases mysqlTable. A MySQL-compatible SQL string is not proof of semantic compatibility with CUBRID; Drizzle may not expose a stable third-party dialect extension API. cubrid-client supplies CAS execution, not Drizzle query compilation.

The CUBRID Python driver and SQLAlchemy dialect provide engineering lessons about protocol, SQL and transaction correctness, **not** implementations or cross-language public APIs to copy.

## Decision

Target a CUBRID-specific SQL compiler, schema/column builders, result/transaction adapter and independently verified migration/DDL path. Use Drizzle's **verified public database-neutral extension points** where stable; treat MySQL ORM implementation solely as reference, not runtime dependency, type alias, SQL fallback or migration engine. If Drizzle upstream has no sufficient extension API, **do not claim the native dialect is implemented**: complete a typed-query feasibility prototype and pursue an upstream integration change or an explicitly scoped standalone implementation first. Use cubrid-client's actual query/execute metadata and connection contract; keep types and syntax aligned to CUBRID.

## Alternatives considered

Keep MySqlDialect/MySqlDatabase as a permanent facade (rejected for unverified SQL semantics); rewrite generated MySQL strings into CUBRID SQL (rejected for hidden DDL/transaction/type mismatches); fork upstream Drizzle immediately (deferred until public extension feasibility is proven).

## Consequences and trade-offs

The first stable release may need upstream coordination and migration notes for old 0.x callers. Tests must distinguish SQL snapshot correctness, type inference and live CUBRID semantics. The native Drizzle layer cannot claim a CUBRID migration implementation solely because Drizzle Kit MySQL mode emits some plausible DDL.

## Verification / acceptance criteria

Compile an independently typed table and representative SELECT/JOIN without importing mysql-core; execute on actual CUBRID; verify DML metadata, duplicate aliases, transaction connection ownership, type codecs and transactional DDL under supported DB versions; resolve unsupported extension gaps before a 1.0 guarantee.

- [ ] Approve release/compatibility policy ADR 0001 **before** accepting this architecture ADR.
- [ ] The feasibility evidence and exact supported versions are recorded; unknown or unsupported behavior is not reported as implemented.
- [ ] Separate implementation issues, regression tests and release documentation agree with this decision.
- [ ] A maintainer reviews the decision and records acceptance explicitly; draft status alone never authorizes 1.0.

## References

[architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md), [feasibility #156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156), [release policy PR #168](https://github.com/cubrid-lab/drizzle-cubrid/pull/168)

**This ADR is an architecture proposal, not a runtime implementation, migration completion, CI pass or approved release.**
