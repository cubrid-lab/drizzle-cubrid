# CUBRID-native Drizzle architecture and version policy

> **Status:** Proposed design; not shipped. This document records the intended architecture and acceptance gates. It does not claim that the current code already satisfies them.
>
> **Snapshot:** 2026-11-07. `drizzle-cubrid` currently declares package version `0.2.1`; `cubrid-client` is released at `1.2.0`.

## Decision

`drizzle-cubrid` must implement a **CUBRID-native Drizzle ORM dialect**, rather than claim MySQL compatibility or delegate SQL, schema, query or migration semantics to MySQL modules.

The MySQL implementation in Drizzle ORM may be **studied as a reference** for patterns and interfaces. The target native implementation must not import, subclass, alias, re-export, or delegate to `drizzle-orm/mysql-core` for its dialect, database, sessions, table/column builders, query builders or migrations.

Dialect-neutral, stable Drizzle primitives may be reused **only after verifying their actual extension points and type-level compatibility**. If public extension points are insufficient, choose an explicit alternative—upstream Drizzle changes or a justified independently maintained integration layer—before shipping a fragile private-API workaround.

A query that looks valid for MySQL is **not** evidence that it is valid or equivalent on CUBRID. CUBRID reference behavior and live CUBRID execution determine correctness.

## Existing code and migration risk

| Existing implementation | Intended native replacement |
| --- | --- |
| `MySqlDialect` in `src/driver.ts` | Native CUBRID SQL generation |
| `MySqlDatabase` in `src/driver.ts` | CUBRID database and typed query facade |
| MySQL session/prepared-query/transaction bases in `src/session.ts` | Native session, row mapper, transaction lifecycle |
| `mysqlTable` alias in `src/table.ts` | Native CUBRID table builder |
| MySQL columns re-exported by `src/columns.ts` | CUBRID column builders and codecs |
| `dialect: 'mysql'` in the migration example | Validated CUBRID-specific DDL and migration strategy |

This requires a staged replacement. The current 0.x code and documentation are not evidence of live database correctness, and existing public APIs must not be silently broken.

## Proposed responsibility boundaries

```text
Application (Drizzle-style API)
        |
CUBRID-native schema and query builders
        |
CUBRID SQL dialect and result/column codecs
        |
CUBRID session and transaction adapter
        |
cubrid-client (CAS protocol, connections, execution, errors)
        |
CUBRID database
```

The migration component is a **separate path**: CUBRID schema metadata + CUBRID DDL planning and generation + a validated migration executor -> `cubrid-client` -> CUBRID database. It must not assume Drizzle Kit's MySQL generation or application modes work for CUBRID.

The following are **design tasks**, not implemented claims:

1. **Schema and types:** CUBRID table metadata, constraints, identifier rules, defaults, supported numeric/temporal/text/binary/collection types, codecs, and TypeScript inference.
2. **SQL:** SELECT, JOIN, filtering, ordering, relations, INSERT/UPDATE/DELETE, supported conflict handling, generated keys and unsupported SQL constructs.
3. **Driver contract:** separate row queries from commands, parameter binding, duplicate column aliases, error kinds and query metadata. No guessing returned IDs.
4. **Transaction contract:** ownership of transaction-scoped connections, nested savepoints, commit/rollback, concurrent use and failure semantics.
5. **Prepared queries and streaming:** expose features only after proving their semantics on the actual driver, especially cursor lifetime and transaction isolation.
6. **DDL and migrations:** independent feasibility review, generation, plan/apply, catalog metadata and safe recovery.

### Explicit driver facts to preserve

The current public `cubrid-client` API distinguishes:

- `query()` -> result rows; DML returns an empty array.
- `execute()` -> command metadata including `affectedRows` and `lastInsertId`; do not assume generated IDs are consecutive, present, or safely representable as JavaScript `number`.
- `queryResult()` -> rows plus ordered column metadata. Duplicate result labels are lossy in object-shaped rows and need an explicit adapter policy.
- `queryPrepared()` / `executePrepared()` -> opt-in prepared binding, not a reusable server statement object.
- `stream()` -> streaming with a connection/cursor lifetime contract; availability in the driver does not automatically mean Drizzle's `iterator()` is safe.
- Collection values are decoded as arrays, with element types needing explicit and tested mapping.

The adapter must validate actual supported driver versions rather than presume these APIs exist across every `cubrid-client@1.x` release.

## Major-version alignment policy

**Compatibility-generation alignment:** the first validated native stable release targets `drizzle-cubrid@1.0.0` as an adapter for a **tested range of `cubrid-client@1.x`**.

- Align **major compatibility generations**, not exact semver digits. Example: `drizzle-cubrid@1.0.0` can support `cubrid-client@1.2.0` when tested; independent minor and patch releases are expected.
- Stay at `drizzle-cubrid@0.x` until the native architecture, compatibility evidence, and stable public contract are ready. **Do not bump versions to create artificial alignment.**
- Publish a **bounded, verified** `cubrid-client` peer range for the stable adapter (for example, `>=1.2.0 <2.0.0` **only if** that minimum and range have been validated). The existing open-ended `>=0.1.0` is not itself a support guarantee.
- Validate and declare the supported Drizzle ORM version ranges **separately**. A Drizzle upstream breaking change is not a CUBRID driver version change.
- For a future `cubrid-client@2.x`, verify breaking changes and coordinate an adapter release. A synchronized adapter major is appropriate **when its public compatibility contract actually breaks**; do not bump an adapter major automatically for an unrelated driver release or bypass semantic-versioning obligations.
- If a future adapter-breaking change occurs independently of a driver major release, record the unavoidable SemVer versus lockstep tradeoff explicitly before a release decision; never conceal a breaking API change with a minor bump solely to preserve equal major numbers.
- Document compatibility as a tested matrix, not inferred from the major numbers alone.

## Validation and release gates

**Before the first native 1.0 release:**

- [ ] Confirm a stable independent Drizzle integration path using source evidence and TypeScript type-level prototypes.
- [ ] Eliminate production `mysql-core` reliance from the native dialect and distributed exports; add regression checks.
- [ ] Validate SQL generation **and execution** against actual selected CUBRID versions; start with a candidate matrix of CUBRID 10.2, 11.0, 11.2, and 11.4, narrowing or expanding solely on evidence.
- [ ] Test the supported `cubrid-client`, Drizzle ORM, Node.js and TypeScript version combinations, including relevant lower bounds.
- [ ] Cover numeric precision, bigint IDs, collections, nullability, alias collisions, generated keys, transactions, concurrency, savepoints and errors.
- [ ] Independently verify migration generation, execution, failure and recovery; unverified migration features must not be advertised as supported.
- [ ] Keep compatibility and semantic behavior visible in README, PRD, schema/query guides, examples, and contribution instructions.
- [ ] Resolve currently tracked CI and coverage reliability issues without silently weakening release gates.
- [ ] Produce clear migration notes from the 0.x public API before announcing stability.

## Implementation tracking

- [Architecture decision and implementation program](https://github.com/cubrid-lab/drizzle-cubrid/issues/155)
- [Independent Drizzle extension feasibility](https://github.com/cubrid-lab/drizzle-cubrid/issues/156)
- [Native table and column builders](https://github.com/cubrid-lab/drizzle-cubrid/issues/157)
- [Native SELECT and relational queries](https://github.com/cubrid-lab/drizzle-cubrid/issues/158)
- [Native DML and generated keys](https://github.com/cubrid-lab/drizzle-cubrid/issues/159)
- [Native driver and result mapping](https://github.com/cubrid-lab/drizzle-cubrid/issues/160)
- [Native transaction handling](https://github.com/cubrid-lab/drizzle-cubrid/issues/161)
- [Type and collection codecs](https://github.com/cubrid-lab/drizzle-cubrid/issues/162)
- [Native migration design](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)
- [Real CUBRID verification matrix](https://github.com/cubrid-lab/drizzle-cubrid/issues/164)
- [Prepared queries and streaming feasibility](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)
- [Compatibility and peer dependency policy](https://github.com/cubrid-lab/drizzle-cubrid/issues/151)

This document establishes **design intent only**. Implementation PRs must demonstrate actual source changes, regression tests, live-CUBRID evidence where applicable, and honest support claims.
