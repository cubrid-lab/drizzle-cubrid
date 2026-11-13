# Design sign-off and TDD acceptance plan

> **Status: Not signed off / design under review.** This plan captures *expected* test behavior, not tests already written or run. ADR 0001 (release governance) and the native architecture ADR 0003 were accepted on 2026-11-13 (#ACCEPT_PR); ADR 0002/0004/0005/0006 remain Proposed. Accepting ADR 0003 approves the direction, not this checklist. No implementation, CI success, approved public API or live DB outcome is implied.

## CUBRID-only final acceptance (mandatory, not yet passed)

- [ ] All SQL, schema/table/column builders, sessions, transaction classes, type codecs and migrations are independently CUBRID-native. No MySQL, MariaDB, PostgreSQL, SQLite, SingleStore, PlanetScale or other foreign database implementation is imported, subclassed, delegated to or repurposed.
- [ ] No foreign-dialect SQL generation, string translation, legacy migration fallback, `mysql-core` alias, `dialect: 'mysql'`, or `mode: 'planetscale'` remains in the native source, examples or public exports.
- [ ] A **failing-on-regression** static guard inspects production source plus packed ESM/CJS and emitted TypeScript declarations; negative tests prove it detects banned foreign-dialect imports and aliases (cross-cutting issue [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192)).
- [ ] Only verified public Drizzle **database-neutral** primitives and `cubrid-client` at the CUBRID driver boundary are reused. Upstream Drizzle transitive packages are not automatically forbidden.
- [ ] Real CUBRID 11.4 SQL and result verification demonstrates correctness independent of a static import ban (#164/#181). Unsupported native behavior rejects clearly instead of falling back to another DB.
- [ ] Current legacy 0.x imports are treated as **unresolved blockers**, not grandfathered acceptance; do not delete them without tested native replacements or claim a completed migration.

This mandate applies even if a foreign-dialect compatibility path would make an individual test pass. It is a product requirement, not optional simplification.

## Project setup prerequisite

**ADR 0005 and the development setup guide** were merged as Proposed in #168; check [the setup documentation](DEVELOPMENT_SETUP.md) and the manifest/CI before checking these boxes.

- [ ] **Clean checkout verified:** language-native runtime/compiler and tooling are selected with a documented developer versus published consumer support distinction.
- [ ] **Dependency resolution verified:** npm lockfile, Drizzle peer dependencies and published driver compatibility resolve without undocumented replacement, incompatible versions, or incorrect import paths.
- [ ] **Read-only setup checks executed:** record **actual** build/type/lint/unit results, not command examples; all known missing config/scripts have explicit blockers.
- [ ] **Real DB harness decided:** identify a disposable real CUBRID service and concrete test selection, or mark missing harness as blocked. A Docker healthcheck, fake broker or zero/fully skipped suite is not evidence.
- [ ] **External package consumer planned:** packed ESM/CJS/TypeScript npm consumer checks, with release preflight separate from initial setup.
- [ ] **Repository developer guidance consistent:** README, CONTRIBUTING, AGENTS, tooling and CI refer to commands that actually exist and do not silently raise the supported runtime floor.
- [ ] **Maintainer approval recorded** for ADR 0005 and any associated npm peer ranges, Node.js engines, TypeScript API and CI compatibility, dependency or CI changes.

These are **not completed** merely because the files are written. If setup is blocked, fix or explicitly scope it in a separate reviewed task before claiming the design is ready for implementation.

### Node.js 18 through every stable 1.x release

- [ ] All planned `drizzle-cubrid@1.x` releases retain `engines.node >=18`; the Node 22 development toolchain is not a reason to raise that floor.
- [ ] Verify **packed adapter ESM/CJS runtime on Node 18**, together with the actually supported `cubrid-client@1.x` and `drizzle-orm` peer versions; TypeScript/Vitest running on Node 22 is a separate test tier.
- [ ] The CI design prevents a Node 18 failure from hiding modern-Node results, and release gates fail closed if Node 18 consumer evidence is missing.
- [ ] Node 18 removal is **a future 2.0 MAJOR consideration only**, requiring reviewed migration notes and an independent compatibility decision. See [ADR 0006](adr/0006-node-18-support-through-1x.md).

## Design-first gate

Before implementation changes are treated as approved, establish each of the following in reviewed project documentation and link the evidence. Check only when genuinely resolved, not merely because this template exists.

- [ ] **Boundaries and interfaces:** owned layer, public API, language-native patterns, tested public dependency interfaces, version and compatibility requirements.
- [ ] **Protocol/SQL contract:** CUBRID-specific wire/query semantics, supported and unsupported behaviors, parameter/result mapping, resource lifetimes.
- [ ] **State and failure model:** connection/session/transaction/statement states, cancellation, retries, ambiguous outcomes and cleanup.
- [ ] **Data types and precision:** NULL, signed integers, exact numeric, text, date/time, collections, binary/LOB and errors.
- [ ] **Schema/migration contract (where applicable):** CUBRID DDL, introspection, reversible behavior, destructive change guardrails.
- [ ] **Security and operations:** credentials/log redaction, timeout limits, resource bounds, cancellation behavior and diagnostics.
- [ ] **Verification design:** red/green cases (below), real CUBRID versions, non-vacuous failure gate, independent JDBC semantic comparison when appropriate.
- [ ] **Release readiness:** published package and supported consumer matrix, reviewed release notes, stable 1.0 exit conditions.
- [ ] **Upstream feasibility:** independently verify third-party ORM public extension APIs and unsupported methods before committing to architecture.
- [ ] **Review approval:** maintainers explicitly approve the language-native architecture ADR, test contract and open blockers; no speculative sign-off.

The PR/issue must distinguish **decided**, **proposed**, **blocked**, and **requires live verification**. If a significant feasibility constraint prevents the proposed direction, update the ADR and its alternatives before implementing a workaround.

## TDD acceptance cases

For each feature or bug: first run a targeted test that fails for the intended reason (**Red**), make the smallest implementation pass (**Green**), refactor under the same tests, and verify live database behavior before claiming compatibility. A red failure log may be summarized truthfully in the PR but need not be committed. The final PR must have green required checks.

| Test contract (proposed) | Expected observable outcome | First test layer | TDD starting point |
| --- | --- | --- | --- |
| Native table + type inference | `cubridTable` and native columns produce CUBRID schema metadata with correct typed nullability | typecheck/tsd-like fixture + snapshot + live DDL | write compile/type and live DDL negative test first |
| Native query compilation | SELECT projection, JOIN, aliases, params and DML generate CUBRID SQL without `mysql-core` | Vitest SQL assertions + real CUBRID | first demonstrate MySQL-derived output violating a specified CUBRID case |
| Driver result mapping | Overlapping column names and NULL-joined rows preserve position; DML uses `execute()` metadata, no guessed generated IDs | fake driver contract + actual select/insert SQL | red alias collision and no `Object.values` assumptions |
| Transaction scope | Every query uses transaction-bound client; rollback and error propagation never silently escape to autocommit | fake tx client + real DB with two sessions | red illegal cross-client command then green |
| Migrations and recovery | CUBRID DDL rollback, catalog reflection, unsafe ALTER fail safely; no Drizzle Kit MySQL fallback | migration dry run + isolated CUBRID | verify feasibility before promising migration support |

## Project boundary

**Role:** TypeScript CUBRID dialect for Drizzle.

The native builder must not inherit MySQL SQL generation; `cubrid-client` owns CAS connections and returns real driver metadata. Drizzle public extension feasibility is not established.

## Decisions still blocking full sign-off

#156 Drizzle public extension feasibility, #157 schema, #158 SELECT, #159 DML, #160 driver mapping, #161 transaction scope, #162 types, #163 migrations, #164 live DB. No native design signoff until the extension/migration path is justified.

These are outstanding verifications, not proof of failure. Existing code and currently declared support are not silently reclassified as unsupported merely because a test is absent.

## Release and implementation sequencing

1. Accept the repository release policy and [TDD ADR 0004](adr/0004-test-first-development.md) (merged as Proposed in #168).
2. Resolve the above design/feasibility blockers with evidence, review [native architecture](CUBRID_NATIVE_ARCHITECTURE.md), and explicitly accept the architecture/contract ADR when applicable.
3. Implement each scoped issue with test-first evidence, one observable contract at a time. No implementation-wide PR before essential extension feasibility.
4. Run real CUBRID and downstream consumer tests on the final release candidate; document exact versions and test counts; do not publish based on mocks alone.

**Design PR:** #166 (merged as Proposed). This file is a **sign-off checklist**, not a signed-off design.
