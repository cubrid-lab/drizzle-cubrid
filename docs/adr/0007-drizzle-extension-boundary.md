# ADR 0007: Build the native dialect on Drizzle's database-neutral modules

- **Status:** Accepted
- **Date:** 2026-11-13 (proposed)
- **Accepted:** 2026-11-14 by maintainer yeongseon, recorded in PR #227
- **Decision scope:** Which Drizzle ORM modules the native CUBRID dialect may import, how it touches Drizzle internals, and the supported Drizzle version envelope
- **Prerequisites:** [ADR 0003](0003-native-architecture-boundaries.md) (accepted), feasibility issue [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156)
- **Relation to ADR 0003:** ADR 0003 prefers Drizzle's *public* database-neutral extension points and, where they are insufficient, an upstream change or "an explicitly scoped standalone implementation". Drizzle has no public dialect API, so this ADR chooses the **explicitly scoped standalone implementation**, with a narrow, bounded exception for the Drizzle internals listed in decision 2.

## Context

ADR 0003 requires a CUBRID-native dialect with no foreign-database implementation. #156 asked whether Drizzle ORM allows that. The evidence is in [the feasibility report](../NATIVE_FEASIBILITY.md):

- **Drizzle has no third-party dialect API.** Dialects ship inside drizzle-orm. Its `Dialect` type is a closed union (`'pg' | 'mysql' | 'sqlite' | 'singlestore' | 'common' | 'gel'`). No upstream issue, discussion or roadmap item offers an extension API.
- **The database-neutral modules are enough for the core of a dialect.** A throwaway prototype built a CUBRID table, column builders, SELECT with inner and left joins, INSERT, UPDATE and DELETE. Its own code imports nothing from any `*-core` dialect folder. Subqueries, aliases, table extra config, relational queries and Node 18 were **not** prototyped. It type-checks under `tsc --strict` on drizzle-orm 0.44.1 and 0.45.4, with inference assertions that a negative control confirms are live. The SQL it generates ran on a real CUBRID 11.4 server.
- **Two Drizzle runtime protocols are `@internal`.** (`ColumnBuilder.build()` is also needed, but each dialect declares it itself.) Registering columns on a table uses the `Symbol.for('drizzle:…')` keys behind `Table.Symbol`. Decoding a `sql` expression uses `SQL#decoder`. Both are identical across 0.44.1–0.45.4.
- **Drizzle v1 (1.0.0-rc.5) rewrites the neutral column generics.** The prototype fails there with 121 type errors.

## Decision

1. **Imports.** Native code imports Drizzle only from the root `drizzle-orm` entry or these database-neutral subpaths: `casing`, `column`, `column-builder`, `entity`, `operations`, `query-builders/select.types`, `query-promise`, `relations`, `sql/sql`, `table` and `utils`. It never imports from a `*-core` folder, a driver adapter folder (`mysql2`, `node-postgres`, …), `drizzle-orm/cache/*` or `drizzle-orm/errors` (that subpath resolves to different files within the peer range).
2. **Internals in one shim (bounded exception).** The only Drizzle internals allowed are those this list names:
   - **Used by the prototype:** the `Table.Symbol` keys (`Symbol.for('drizzle:…')`), `SQL#decoder`, and a dialect-declared `ColumnBuilder.build()`.
   - **Anticipated, not yet needed:** `setName` (key-as-name columns), `Column.shouldDisableInsert`, and the JS-only `mapResultRow` / `orderSelectedFields`. Native code should prefer its own row mapping and ordering.

   All access to them goes through typed accessor functions exported by a single `src/native/internal.ts`. Each accessor carries a comment naming the Drizzle file and the versions it was checked against. Outside that file, native code may not touch them in any form: no import, no `Symbol.for('drizzle:…')`, no `.decoder` access on a Drizzle `SQL` object, no `.shouldDisableInsert` access, and no `as unknown as` cast at all. Adding an internal to the list needs an amendment to this ADR.
3. **Reuse types, own runtime.** Reuse Drizzle's neutral types and functions as imported dependencies, never as copied code:
   - result inference: `select.types`, `InferSelectModel`/`InferInsertModel`
   - SQL rendering: `SQL`, `sql`, `Param`, `Placeholder`
   - operators and aggregates
   - relations config

   drizzle-cubrid writes and owns the builders, the SQL compiler, row mapping, the session and the codecs.
4. **No copied Drizzle source by default.** If a file is later adapted from drizzle-orm (Apache-2.0), that PR adds the Apache-2.0 text and attribution in a `THIRD_PARTY_NOTICES` file and marks the file as modified, per Apache-2.0 §4. drizzle-cubrid itself stays MIT.
5. **Version envelope.** The peer range stays `>=0.44.1 <0.46.0`, the range tested today. CI type-checks and tests the native dialect against the peer floor and the latest allowed 0.45.x, and runs the packed package on Node 18. A non-required canary job runs the same type tests against the next drizzle-orm minor and the current 1.0 release candidate. The upper bound moves to a new minor only after the type tests, unit tests and live tests pass on it. Supporting Drizzle 1.x is a separate port.
6. **Upstream.** A narrow upstream request is drafted in [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156#issuecomment-6865978359): public table-column registration, a public `ColumnBuilder.build`/`setName`, public `SQL` decoders, and an open `Dialect` union. The maintainer decides whether and when to file it. Native work does not wait for it.
7. **Identifier quoting.** Quote identifiers in the native SQL compiler with the form verified on the supported server versions. On CUBRID 11.4, double quotes, square brackets and backticks all work as identifier quotes; the choice and its escaping are made in #158.

8. **Drizzle-internal foreign code.** Drizzle's own neutral modules call dialect helpers internally: `sql/sql.js` calls `isPgEnum` from `pg-core` while rendering every query, and `relations.js` loads a `pg-core` helper. drizzle-cubrid does not import, extend or call these itself. ADR 0003 and the [architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md) do not ban "incidental transitive internals owned by upstream Drizzle", so this is accepted as **Drizzle's code, not drizzle-cubrid's**. The #192 guard checks drizzle-cubrid's own sources and published files, not `node_modules/drizzle-orm`. If upstream removes that coupling, nothing here changes.
9. **First scope and identity.** The first native release covers what the prototype proved: tables, column builders, SELECT with joins, INSERT, UPDATE and DELETE. Everything else (subqueries, aliases, set operations, relational `with`, migrations) either lands with its own issue and tests or is refused with an explicit error. The package keeps the `drizzle-cubrid` npm name and its independent community-adapter identity (#187).

## Alternatives considered

- **Upstream extension API first:** rejected as a prerequisite. No such API exists or is planned, and new dialects are added in-tree. It remains a parallel request (decision 6).
- **Fork drizzle-orm:** rejected. It avoids internals but means owning all of Drizzle, splits users from the upstream package and adds release work, while the two internal protocols used here have been stable.
- **Copy Drizzle's MySQL builders and adapt them:** rejected. It imports MySQL semantics that ADR 0003 forbids. It would also bring Apache-2.0 attribution on most of the codebase and keep upstream fixes from flowing in.
- **Keep `mysql-core`:** rejected by ADR 0003.

## Consequences and trade-offs

- **More code to own.** About 3–4k lines of builders, compiler, row mapping and codecs, plus tests. That replaces about 3.1k lines of JS and 1.9k of declarations inherited from Drizzle's MySQL classes today. Builder features Drizzle adds later have to be implemented here by hand.
- **Internals can break on upgrade.** A Drizzle release can break the internal shim without a SemVer signal. The canary job and the version-pinned comments are the mitigation.
- **Drizzle 1.0 is blocked.** Users can't move to drizzle-orm 1.0 with the native dialect until the port is done. The peer range states this.
- **Drizzle's own declarations need `skipLibCheck: true`.** Drizzle's neutral declaration files import every dialect folder, so a consumer's `skipLibCheck: false` reports errors inside drizzle-orm (see decision 8).
- **The 0.x API changes.** The public 0.x API re-exports MySQL builders such as `mysqlEnum` and the `int` options. The native builders replace them, so the release needs migration notes (ADR 0001).

## Verification / acceptance criteria

- [x] Compile-time proof: an independent CUBRID table and SELECT/JOIN/DML preserve inference without `mysql-core`, on drizzle-orm 0.44.1 and 0.45.4 (feasibility report, prototype evidence).
- [x] The prototype's generated SQL executes on a real CUBRID 11.4 server (feasibility report).
- [ ] #192 adds the guard: banned import specifiers over `src` and the packed ESM/CJS/`.d.ts`, plus a search outside `src/native/internal.ts` for `Symbol.for('drizzle:`, `.shouldDisableInsert`, any `as unknown as`, and `.decoder` on Drizzle `SQL` values (matched so that drizzle-cubrid's own codec members do not trip it). Each rule has a canary that must fail it.
- [ ] CI type-checks the native dialect against the drizzle-orm peer floor and latest 0.45.x, runs the packed package on Node 18, and has a non-required canary for the next minor and 1.0.
- [ ] The current `src/` export paths (including `cache/core/*` and the `mysql-core/*` re-exports) are confirmed from a clean consumer before the 0.x paths are removed.
- [x] The upstream request (decision 6) is drafted and linked here ([#156 draft](https://github.com/cubrid-lab/drizzle-cubrid/issues/156#issuecomment-6865978359)); filing it is left to the maintainer.
- [x] A maintainer accepts this ADR explicitly, recorded in this file (2026-11-14, PR #227).

## References

- [Feasibility report](../NATIVE_FEASIBILITY.md)
- [ADR 0003](0003-native-architecture-boundaries.md) and [architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md)
- Issues: [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156), [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192), [#157](https://github.com/cubrid-lab/drizzle-cubrid/issues/157)–[#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)
