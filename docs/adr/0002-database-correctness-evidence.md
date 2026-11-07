# ADR 0002: CUBRID correctness and failure-evidence boundaries

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** drizzle-cubrid correctness obligations and review evidence

## Context

The CUBRID Python driver and its SQLAlchemy dialect revealed that apparently successful queries can hide transaction-scope mistakes, accidental retries after uncertain execution, stale broker handles, precision loss and unverified ORM-generated SQL. The purpose of learning from them is to **reuse verified invariants and test design**, never Python API signatures or implementation code. The current repository has its own runtime, public API and released compatibility obligations.

## Decision

The ORM must compile CUBRID SQL and own schema/types/migration semantics; it must not quietly inherit MySQL's compiler or assume MySQL DDL behavior. The cubrid-client owns CAS transport, connection and result metadata, and the adapter must use its actual query/execute return contracts. Query row/alias ordering, generated IDs, bigint/precision/collections, transaction-bound connections, rollback and migration behavior each require an actual CUBRID test for production claims. Fail unsupported SQL and missing result metadata explicitly. Drizzle core extension feasibility is a prerequisite for an independent native implementation.

Use source-linked test cases as engineering references, then implement targeted **native-language** regression tests. Identify whether a test actually talked to CUBRID, which server/broker and client/ORM versions were used, what SQL/outcome was asserted, and whether any required case was skipped. The fact that a Python project passes its tests does **not** certify this package.

## Alternatives considered

- **Rejected:** Subclassing MySQL dialect/database and re-exporting mysqlTable as a permanent compatibility strategy; rewriting MySQL SQL strings; assuming query() returns DML insert metadata; claiming migrations from a MySQL-mode Drizzle Kit example.
- **Rejected:** A generic cross-language implementation copied verbatim from Python.
- **Rejected:** Marking an unsupported/unverified feature as absent simply because one server or connector failed in a particular test.

## Consequences and trade-offs

More upfront architecture and test work is required and current 0.x APIs may need versioned migration guidance; native semantics prevent a superficially passing but incorrect ORM. Ordinary documentation-only PRs need not run an expensive database matrix; **the final release candidate still must run all required real-CUBRID checks** for its promised compatibility.

## Verification / acceptance criteria

- [ ] Normal and failure-path tests cover the actual decision's affected behavior.
- [ ] No silent statement replay, fabricated database values, unknown-success transaction or stale-handle reuse for the supported public API.
- [ ] Real DB tests use an isolated ready-checked CUBRID instance, assert actual stored/returned values and report nonzero executed-case counts; skip/missing is not success.
- [ ] Independent JDBC (or verified official driver) comparisons evaluate meaning and type, not matching source implementation.
- [ ] Public docs, type declarations and compatibility claims are reconciled with observed behavior; unsupported operations fail clearly.
- [ ] Maintainer accepts this ADR and separately reviews release/code changes; neither this record nor a checklist fixes existing defects.

## References

[engineering checks](../ENGINEERING_INVARIANTS.md), [native design #155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155), [real DB #164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164)

**No claim of implementation completion is made.**
