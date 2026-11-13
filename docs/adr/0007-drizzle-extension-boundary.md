# ADR 0007: Build the native dialect on Drizzle's database-neutral modules

- **Status:** Proposed
- **Date:** 2026-11-13
- **Decision scope:** Which Drizzle ORM modules the native CUBRID dialect may import, how it touches Drizzle internals, and the supported Drizzle version envelope
- **Prerequisites:** [ADR 0003](0003-native-architecture-boundaries.md) (accepted), feasibility issue [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156)

## Context

ADR 0003 requires a CUBRID-native dialect with no foreign-database implementation. #156 asked whether Drizzle ORM allows that. The evidence is in [the feasibility report](../NATIVE_FEASIBILITY.md):

- **Drizzle has no third-party dialect API.** Dialects ship inside drizzle-orm. Its `Dialect` type is a closed union (`'pg' | 'mysql' | 'sqlite' | 'singlestore' | 'common' | 'gel'`). No upstream issue, discussion or roadmap item offers an extension API.
- **The database-neutral modules are enough to type a dialect.** A throwaway prototype built a CUBRID table, column builders, SELECT with inner and left joins, INSERT, UPDATE and DELETE. It imports nothing from any `*-core` dialect folder. It type-checks under `tsc --strict` on drizzle-orm 0.44.1 and 0.45.4, with inference assertions that a negative control confirms are live. The SQL it generates ran on a real CUBRID 11.4 server.
- **Two runtime protocols are `@internal`.** Registering columns on a table uses the `Symbol.for('drizzle:…')` keys behind `Table.Symbol`. Decoding a `sql` expression uses `SQL#decoder`. Both are identical across 0.44.1–0.45.4.
- **Drizzle v1 (1.0.0-rc.5) rewrites the neutral column generics.** The prototype fails there with 121 type errors.

## Decision

1. **Imports.** Native code imports Drizzle only from database-neutral modules. Prefer the root `drizzle-orm` entry, and use these subpaths only where the root does not export the item: `column`, `column-builder`, `entity`, `operations`, `query-builders/select.types`, `query-promise`, `relations`, `sql/sql`, `table`, `utils` and `casing`. It never imports from a `*-core` folder, a driver adapter folder (`mysql2`, `node-postgres`, …) or `drizzle-orm/cache/*`.
2. **Internals in one shim.** Every use of an `@internal` or undeclared Drizzle member lives in a single `src/native/internal.ts`. That covers the table symbols, `SQL#decoder`, `setName`, `shouldDisableInsert`, and field ordering or row mapping that has no public declaration. Each use carries a comment naming the Drizzle file and version it was checked against. No other native file may import a Drizzle internal.
3. **Reuse types, own runtime.** Reuse Drizzle's neutral types and functions as imported dependencies, never as copied code:
   - result inference: `select.types`, `InferSelectModel`/`InferInsertModel`
   - SQL rendering: `SQL`, `sql`, `Param`, `Placeholder`
   - operators and aggregates
   - relations config

   drizzle-cubrid writes and owns the builders, the SQL compiler, row mapping, the session and the codecs.
4. **No copied Drizzle source by default.** If a file is later adapted from drizzle-orm (Apache-2.0), that PR adds the Apache-2.0 text and attribution in a `THIRD_PARTY_NOTICES` file and marks the file as modified, per Apache-2.0 §4. drizzle-cubrid itself stays MIT.
5. **Version envelope.** The native dialect supports drizzle-orm `>=0.44.1 <1.0.0`. CI type-checks it against the peer floor and the latest 0.45.x. A non-required canary job runs the same type tests against the current Drizzle 1.0 release candidate. Supporting Drizzle 1.x is a separate, planned port.
6. **Upstream.** File a narrow upstream request: public table-column registration, a public `ColumnBuilder.build`/`setName`, public `SQL` decoders, and an open `Dialect` union. Native work does not wait for it.
7. **Identifier quoting.** Quote identifiers in the native SQL compiler with the form verified on the supported server versions. On CUBRID 11.4, double quotes, square brackets and backticks all work as identifier quotes; the choice and its escaping are made in #158.

## Alternatives considered

- **Upstream extension API first:** rejected as a prerequisite. No such API exists or is planned, and new dialects are added in-tree. It remains a parallel request (decision 6).
- **Fork drizzle-orm:** rejected. It avoids internals but means owning all of Drizzle, splits users from the upstream package and adds release work, while the two internal protocols used here have been stable.
- **Copy Drizzle's MySQL builders and adapt them:** rejected. It imports MySQL semantics that ADR 0003 forbids. It would also bring Apache-2.0 attribution on most of the codebase and keep upstream fixes from flowing in.
- **Keep `mysql-core`:** rejected by ADR 0003.

## Consequences and trade-offs

- **More code to own.** About 3–4k lines of builders, compiler, row mapping and codecs, plus tests. That replaces about 3.1k lines of JS and 1.9k of declarations inherited from Drizzle's MySQL classes today. Builder features Drizzle adds later have to be implemented here by hand.
- **Internals can break on upgrade.** A Drizzle release can break the internal shim without a SemVer signal. The canary job and the version-pinned comments are the mitigation.
- **Drizzle 1.0 is blocked.** Users can't move to drizzle-orm 1.0 with the native dialect until the port is done. The peer range states this.
- **Drizzle's own declarations need `skipLibCheck: true`.** Drizzle's neutral declaration files import every dialect folder, so a consumer's `skipLibCheck: false` reports errors inside drizzle-orm. Drizzle's runtime also loads some `pg-core` helpers. These belong to Drizzle, not to drizzle-cubrid, so the #192 guard checks drizzle-cubrid's own sources and published files only.
- **The 0.x API changes.** The public 0.x API re-exports MySQL builders such as `mysqlEnum` and the `int` options. The native builders replace them, so the release needs migration notes (ADR 0001).

## Verification / acceptance criteria

- [x] Compile-time proof: an independent CUBRID table and SELECT/JOIN/DML preserve inference without `mysql-core`, on drizzle-orm 0.44.1 and 0.45.4 (feasibility report, prototype evidence).
- [x] The prototype's generated SQL executes on a real CUBRID 11.4 server (feasibility report).
- [ ] #192 adds the import guard over `src` and the packed ESM/CJS/`.d.ts`, with the shim as the only allowed path to Drizzle internals.
- [ ] CI type-checks the native dialect against the drizzle-orm peer floor and latest 0.45.x, with a non-required Drizzle 1.0 canary.
- [ ] The upstream request (decision 6) is filed and linked here.
- [ ] A maintainer accepts this ADR explicitly, recorded in this file.

## References

- [Feasibility report](../NATIVE_FEASIBILITY.md)
- [ADR 0003](0003-native-architecture-boundaries.md) and [architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md)
- Issues: [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156), [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192), [#157](https://github.com/cubrid-lab/drizzle-cubrid/issues/157)–[#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)
