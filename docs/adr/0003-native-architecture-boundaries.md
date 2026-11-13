# ADR 0003: Native CUBRID architecture boundaries

- **Status:** Accepted
- **Date:** 2026-11-07 (proposed)
- **Accepted:** 2026-11-13 by maintainer yeongseon, after ADR 0001, recorded in PR #225
- **Prerequisite:** Release policy ADR 0001 (accepted 2026-11-13)
- **Decision scope:** TypeScript Drizzle ORM CUBRID-native dialect and migration ownership

## Context

The current adapter inherits MySqlDatabase/MySqlDialect and aliases mysqlTable. A MySQL-compatible SQL string is not proof of semantic compatibility with CUBRID; Drizzle may not expose a stable third-party dialect extension API. cubrid-client supplies CAS execution, not Drizzle query compilation.

This decision is grounded in drizzle-cubrid's own public interfaces, repository code, and CUBRID correctness requirements. External implementations cannot substitute for local validation.

## Decision

Target a CUBRID-specific SQL compiler, schema/column builders, result/transaction adapter and independently verified migration/DDL path. Use Drizzle's **verified public database-neutral extension points** where stable; treat MySQL ORM implementation solely as reference, not runtime dependency, type alias, SQL fallback or migration engine. If Drizzle upstream has no sufficient extension API, **do not claim the native dialect is implemented**: complete a typed-query feasibility prototype and pursue an upstream integration change or an explicitly scoped standalone implementation first. Use cubrid-client's actual query/execute metadata and connection contract; keep types and syntax aligned to CUBRID.

## Explicitly prohibited architecture dependencies

For the shipped native adapter there is **no MySQL or other database compatibility mode**: do not import, extend, alias, re-export or call MySQL/MariaDB/PostgreSQL/SQLite/SingleStore/PlanetScale database-specific dialects, query/schema builders, sessions, transaction backends, connectors, migration generators, or SQL transpilers. An unsupported CUBRID capability must fail explicitly rather than invoke foreign-DB SQL or a fallback path.

The permitted interface reuse is limited to **verified database-neutral** Drizzle primitives and the CUBRID-specific `cubrid-client` execution boundary. Reading other DB implementations as non-authoritative documentation does not establish a runtime dependency. Verify the final npm tarball's ESM/CJS exports and declarations as well as source; require a CI regression guard that catches new foreign-dialect use. Acceptance and implementation tracking: [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192).

Current 0.x MySQL-derived classes are migration debt, **not an approved exception**. Remove them through independently tested native replacements before declaring the 1.0 design implemented.

## Alternatives considered

Keep MySqlDialect/MySqlDatabase as a permanent facade (rejected for unverified SQL semantics); rewrite generated MySQL strings into CUBRID SQL (rejected for hidden DDL/transaction/type mismatches); fork upstream Drizzle immediately (deferred until public extension feasibility is proven).

## Consequences and trade-offs

The first stable release may need upstream coordination and migration notes for old 0.x callers. Tests must distinguish SQL snapshot correctness, type inference and live CUBRID semantics. The native Drizzle layer cannot claim a CUBRID migration implementation solely because Drizzle Kit MySQL mode emits some plausible DDL.

## Node.js consumer compatibility constraint

The planned stable 1.x native dialect cannot require Node >18 at runtime. Build tools may run on Node 22, but all compiled package exports and tested Drizzle/driver peers must pass independent Node 18 consumer smoke tests; a minimum runtime raise is reserved for a future **2.0** major release. See [release-policy ADR 0006](0006-node-18-support-through-1x.md). This does not prove runtime compatibility yet.

## Verification / acceptance criteria

Compile an independently typed table and representative SELECT/JOIN without importing mysql-core; execute on actual CUBRID; verify DML metadata, duplicate aliases, transaction connection ownership, type codecs and transactional DDL under supported DB versions; resolve unsupported extension gaps before a 1.0 guarantee.

- [x] Approve release/compatibility policy ADR 0001 **before** accepting this architecture ADR (accepted in the same PR, #225, in that order).
- [ ] The feasibility evidence and exact supported versions are recorded; unknown or unsupported behavior is not reported as implemented.
- [ ] Separate implementation issues, regression tests and release documentation agree with this decision.
- [x] A maintainer reviews the decision and records acceptance explicitly; draft status alone never authorizes 1.0. (2026-11-13, PR #225.)

## References

[architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md), [feasibility #156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156), [release policy ADR 0001](0001-release-governance.md) (#168)

**Accepting this ADR approves the architecture direction and authorizes native implementation work under the acceptance criteria above (#155–#165, #192). It is not a runtime implementation, migration completion, CI pass or approved release; the unchecked criteria remain open.**
