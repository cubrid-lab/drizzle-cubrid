# ADR 0010: Promote the native dialect to the root entry and deprecate the 0.x API

- **Status:** Accepted
- **Date:** 2026-11-19 (proposed)
- **Accepted:** 2026-11-20 by maintainer yeongseon, recorded in PR #260
- **Decision scope:** The package's export map (`drizzle-cubrid`, `drizzle-cubrid/native`, `drizzle-cubrid/migrator`, `drizzle-cubrid/native/migrator`, `drizzle-cubrid/legacy`), the runtime and type-level deprecation of the MySQL-based 0.x API, and the plan to remove it in 1.0
- **Prerequisites:** [ADR 0001](0001-release-governance.md) (accepted), [ADR 0003](0003-native-architecture-boundaries.md) (accepted), [ADR 0006](0006-node-18-support-through-1x.md), [ADR 0007](0007-drizzle-extension-boundary.md) (accepted), [ADR 0009](0009-cubrid-native-migrations.md); epic [#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155), boundary issue [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192)

## Context

Until 0.2.1 the root entry, `drizzle-cubrid`, is the 0.x API: Drizzle's MySQL
dialect, database, session and column builders, subclassed or re-exported
(`src/index.ts` before this change). ADR 0003 forbids that path in the final
adapter, and #192's guard pins its findings in
`scripts/dialect-boundary-baseline.json` as debt that may only shrink.

The CUBRID-native dialect lives in `drizzle-cubrid/native` (#157–#163, #165,
#216): tables, constraints, indexes and foreign keys, column builders with
codecs, select/set operations/subqueries, insert/update/delete, transactions
with savepoints, relational queries with `with`, prepared queries, streaming,
and a migrator (`drizzle-cubrid/native/migrator`). It runs the live CUBRID 11.4
suite and the packed-tarball lanes on every change. Every 0.x feature has a
native counterpart or a documented refusal ([NATIVE_API.md](../NATIVE_API.md),
"MySQL-only builders and their CUBRID replacements" and "Not supported in the
native dialect"), which is #155's condition for retiring 0.x functionality.

The maintainer decided **"deprecate first, then remove"**: in the next minor
release (0.3.0) the native dialect becomes the root entry and the 0.x API is
deprecated with migration notes; the 0.x API is removed entirely in 1.0.

**SemVer under ADR 0001.** ADR 0001 says an incompatible public change
"requires a reviewed breaking release (under current 0.x rules, commonly the
next 0.y.0; at 1.x+ a MAJOR)". Changing what the root entry exports is such a
change, so it belongs in 0.3.0, with migration notes (ADR 0001's acceptance
criteria), not in a 0.2.x patch. Removing `drizzle-cubrid/legacy` is a further
breaking change and is made in 1.0.0.

**How the package is built.** tsup bundles each entry on its own
(`splitting: false`), so two entries built from the same source contain two
copies of every class. A table built from one copy is not an instance of the
other copy's `CubridTable`, and a database from one rejects the other's tables.
The migrator entry already avoids importing native modules at run time for
this reason (ADR 0009, decision 1).

## Decision

1. **Export layout.**

   | Specifier | Files | Contents |
   | --- | --- | --- |
   | `drizzle-cubrid` | `dist/index.{js,cjs,d.ts,d.cts}` | The native dialect: `src/native/index.ts` |
   | `drizzle-cubrid/native` | the same `dist/index.*` files | An alias of the root, kept through all of 1.x |
   | `drizzle-cubrid/migrator` | `dist/native-migrator.*` | The migrator (`migrate`, `readMigrationFiles`, `CubridMigrationError`) |
   | `drizzle-cubrid/native/migrator` | the same `dist/native-migrator.*` files | An alias, kept through all of 1.x |
   | `drizzle-cubrid/legacy` | `dist/legacy.*` | The deprecated 0.x API, unchanged: `src/legacy.ts` (the former `src/index.ts`) |

   `main`, `module` and `types` keep pointing at `dist/index.*`. TypeScript's
   `moduleResolution: node10` (the default for `module: commonjs`) ignores
   `exports`, so `typesVersions` maps `legacy`, `native`, `migrator` and
   `native/migrator` to the same `.d.ts` files; without it those subpaths fail
   with TS2307 for exactly the CommonJS 0.x users step 1 of the migration
   addresses (`scripts/packed-types-check.mjs` checks both resolutions).

2. **One module instance per alias.** `drizzle-cubrid` and
   `drizzle-cubrid/native` resolve to the *same files* in the export map; no
   separate `native` bundle is built. Node caches a module by its resolved
   path, so `require('drizzle-cubrid') === require('drizzle-cubrid/native')`
   and `await import('drizzle-cubrid') === await import('drizzle-cubrid/native')`,
   and every class is one object. The same holds for the two migrator paths.
   (A process that loads the package both with `require()` and with `import`
   still gets one CommonJS and one ESM instance, as before; that is Node's
   dual-package behaviour and unchanged by this ADR.) The packed smoke tests
   assert both identities on Node 18.

3. **Why `legacy`.** The subpath must tell a reader at the import site that
   the code is on its way out, without naming a version or another database:
   - `legacy` is the conventional word for "still works, being replaced" and
     is what the docs, the guard and the issues already call this code.
   - `v0`/`0x` would read as "the API of version 0.x" in a package whose
     version is 0.3, and would make no sense in a 1.x changelog entry that
     removes it.
   - `mysql`/`mysql-compat` would advertise MySQL compatibility, which #187
     and ADR 0003 explicitly withdraw, and would trip the boundary guard's
     foreign-name rule in every document and test that mentions it.

   Migrating to the deprecated entry is one import change per file:
   `'drizzle-cubrid'` → `'drizzle-cubrid/legacy'`. Every 0.x export keeps its
   name, its object identity and its behaviour.

4. **The root fails loudly for 0.x names it no longer has.** Most 0.x names
   have a native export of the same name (`drizzle`, `cubridTable`, `int`,
   `varchar`, `set`, `monetary`, …). Some 0.x usages of them fail to compile
   (`.autoincrement()` is `.autoIncrement()`, `bigint` needs a mode), but
   others compile unchanged and run with native semantics: an `int` value
   with a fraction throws, `boolean` writes 1/0, `date()` writes only
   `YYYY-MM-DD`, `timestamp()` writes whole seconds, and `db.execute()`
   returns the driver's rows (no `affectedRows` on them). The migration
   guide's "Behaviour differences" lists each; these names are therefore not
   a loud failure, which is why step 1 of the guide is an import change and
   not "fix what the compiler reports". Drizzle's operators the 0.x root re-exported (`and`,
   `asc`, `avg`, `count`, `desc`, `eq`, `gt`, `gte`, `lt`, `lte`, `max`, `min`,
   `ne`, `not`, `or`, `placeholder`, `sql`, `sum`) stay exported from the root
   as drizzle-orm's own objects, so `import { eq, sql } from 'drizzle-cubrid'`
   keeps working. For the remaining 0.x values without a native counterpart
   (`cubridSet`, `cubridMultiset`, `cubridSequence`, `customType`, `tinyint`,
   `mediumint`, `serial`, `year`, `real`, `text`, `tinytext`, `mediumtext`,
   `longtext`, `CubridPreparedQuery`) the root exports a **placeholder**
   (`src/native/removed.ts`):
   - its type, `RemovedFromRoot<'…message…'>`, is not callable, so a call does
     not compile and TypeScript's error prints the message
     (`Type 'RemovedFromRoot<"drizzle-cubrid: cubridSet() is a 0.x export that moved to 'drizzle-cubrid/legacy' in 0.3 (removed in 1.0). Use set({ element }) from 'drizzle-cubrid'.">' has no call signatures`);
   - at run time, calling it, constructing it or using it with `instanceof`
     throws `CubridRemovedExportError` with that message and a link to the
     migration guide, instead of failing later on `undefined`.

   `mysqlEnum` gets no placeholder: native code may not contain that name
   (#192 guard), so importing it from the root fails as an unknown export
   (an ESM link error, a TypeScript `has no exported member` error, `undefined`
   in CommonJS). The 0.x type-only exports (`CubridQueryable`,
   `CubridExecuteResult`, `CubridRawQueryResult`, the collection builder
   types) fail the same way; [MIGRATING_FROM_0X.md](../MIGRATING_FROM_0X.md)
   maps each. The placeholders are removed in 1.0 together with the legacy
   entry.

5. **Runtime deprecation warning.** Loading `drizzle-cubrid/legacy` calls
   `process.emitWarning(message, { type: 'DeprecationWarning', code: 'DRIZZLE_CUBRID_LEGACY' })`
   (`src/deprecation.ts`), **once per process**: the flag is a
   `Symbol.for('drizzle-cubrid.legacy-deprecation-warned')` property of
   `globalThis`, so loading both the CommonJS and the ESM build still warns
   once. The root entry, `drizzle-cubrid/native` and the migrator never import
   that module and never warn. The warning is emitted at load time rather than
   at first use, so it appears once at start-up instead of in the middle of a
   request. Node's standard controls apply: `--no-deprecation` (or
   `NODE_OPTIONS=--no-deprecation`) silences it, `--throw-deprecation` makes the
   process fail with an uncaught `DeprecationWarning` on the next tick (Node
   throws it asynchronously, so a `try`/`catch` around the `require` or
   `import` catches nothing; for a catchable check use a
   `process.on('warning')` listener), `--trace-deprecation` adds the stack of the
   importing code, a `process.on('warning')` listener can filter on
   `warning.code === 'DRIZZLE_CUBRID_LEGACY'`, and on Node 21.3+/20.11+
   `--disable-warning=DRIZZLE_CUBRID_LEGACY` silences only this one.

6. **`@deprecated` JSDoc on every legacy export,** at its declaration so that
   it survives tsup's bundled `.d.ts` (tsup drops JSDoc written on re-export
   specifiers): the 0.x classes, functions and types in `src/driver.ts`,
   `src/session.ts`, `src/table.ts`, `src/types.ts`, `src/columns/*.ts`; the
   MySQL builders and Drizzle's operators as local constants in
   `src/columns.ts` and `src/legacy.ts`. Each note names the native
   replacement. One exception: `mysqlEnum` stays a plain re-export, because a
   local declaration would mention that MySQL name more often in the bundles
   than the #192 baseline allows (decision 7); its note is in the source only.
   The placeholders of decision 4 are `@deprecated` too.

7. **Dialect boundary (#192).** The root entry is native code:
   - `src/native/**` keeps every native rule; the root is built from
     `src/native/index.ts` directly, so no root file exists outside
     `src/native/`.
   - In the package scan, `dist/index.*` joins `dist/native*.*` as a packed
     native entry: the `native-dynamic` rule reads its JavaScript, and a
     finding in any packed native file, its `.d.ts`/`.d.cts` included, is
     never baselinable (before, a packed native `.d.ts` finding could have been
     baselined).
   - The baseline changes by renames only: the 223 package entries move from
     `dist/index.*` to `dist/legacy.*` with identical rules, matches and counts
     (509 findings in total, unchanged); no `src` entry changes, because the
     0.x modules stay where they are and `src/legacy.ts` names no foreign
     identifier. A test asserts that packed 0.x findings exist only under
     `dist/legacy.*`.

8. **Removal in 1.0.** 1.0.0 deletes `drizzle-cubrid/legacy`, its source
   (`src/legacy.ts`, `src/deprecation.ts`, `src/driver.ts`, `src/session.ts`,
   `src/dialect.ts`, `src/table.ts`, `src/columns.ts`, `src/columns/*`,
   `src/types.ts`, `src/timezone.ts`), the root placeholders and every
   baseline entry, so the baseline is empty and the guard can drop its
   ratchet. `drizzle-cubrid/native` and `drizzle-cubrid/native/migrator` stay
   as aliases through all of 1.x and may be removed no earlier than 2.0.
   Until 1.0, the 0.x API gets security and data-correctness fixes only, and
   its live tests keep running against `src/legacy.ts` (the packed lane
   against `drizzle-cubrid/legacy`).

## Alternatives considered

- **Keep the 0.x API at the root and the native one at `/native` until 1.0,
  then swap.** Rejected by the maintainer's decision: users would meet the
  breaking swap and the removal in the same release, without a deprecation
  period in which both work side by side.
- **A second `native` bundle next to the root bundle.** Rejected: two copies of
  every class (Context). `instanceof`/`is()` checks and table identity would
  break for code that mixes both specifiers.
- **Remove the 0.x API in 0.3.** Rejected by the maintainer's decision; also
  ADR 0001 asks for migration notes before a removal, and users of 0.2.1 need
  a release in which both APIs work.
- **Re-export the 0.x API from the root alongside the native one.**
  Impossible without renaming: both export `drizzle`, `cubridTable`, `int`,
  `varchar`, `set`, … with incompatible types. It would also put MySQL-derived
  code back into the root bundle, which the guard forbids.
- **Warn on first use instead of at load.** Rejected: there is no single
  "use" (builders run at schema-definition time, `drizzle()` later), wrapping
  every export would change object identity, and a load-time warning is
  deterministic and still suppressible.
- **No placeholders; let removed names be `undefined`.** Rejected for the
  names with an obvious successor: a CommonJS user would get
  `cubridSet is not a function` with no hint, and TypeScript users only
  `has no exported member`.
- **Subpath name `drizzle-cubrid/v0`, `drizzle-cubrid/mysql` or
  `drizzle-cubrid/compat`.** See decision 3.

## Consequences and trade-offs

- **Breaking for every 0.x user in 0.3.0.** The fix is mechanical
  (`'drizzle-cubrid'` → `'drizzle-cubrid/legacy'`), and the deprecation
  warning tells them where to go next. A schema imported partly from the root
  and partly from `/legacy` does not work: the two APIs' tables and databases
  are not interchangeable.
- **Current `drizzle-cubrid/native` users are unaffected**; they may switch
  to the root at their own pace, and both specifiers yield the same objects.
- **The native root gains 18 Drizzle operator re-exports and 14
  placeholders** (plus `CubridRemovedExportError` and the
  `RemovedFromRoot` type). The operators stay through 1.x; the placeholders
  go in 1.0.
- **The deprecation warning is visible** in the logs of every process that
  loads `/legacy`, once. Test runners that treat warnings as errors need
  `--no-deprecation` or a filter until the migration is done.
- **`mysqlEnum` has no `@deprecated` note in the published `.d.ts`** (decision
  6); the runtime warning and the migration guide cover it.
- **The native API is still pre-1.0.** Promoting it to the root does not
  freeze it; ADR 0001 still governs breaking changes before 1.0.

## Verification / acceptance criteria

- [x] Export map, tsup entries and alias identity are unit-tested
  (`tests/package-exports.test.ts`) and asserted on the packed tarball on
  Node 18, CommonJS and ESM (`scripts/packed-exports-smoke.cjs`), including
  `require('drizzle-cubrid').cubridTable === require('drizzle-cubrid/native').cubridTable`
  and the same for `import`.
- [x] The warning is emitted once, with its type and code, only by the legacy
  entry (`tests/legacy-entry.test.ts`); in a real Node 18 process it appears
  once for `require` plus `import`, not at all with `--no-deprecation`, ends the
  process with an uncaught `DeprecationWarning` with `--throw-deprecation`, and never for the root or `/native`
  (`scripts/packed-exports-smoke.cjs`).
- [x] The placeholders throw `CubridRemovedExportError` naming the
  replacement (`tests/native/removed.test.ts`) and do not compile when called
  (`tests/native/removed.test-d.ts`, `scripts/packed-types-check.mjs`).
- [x] The boundary guard treats `dist/index.*` as native and the baseline
  changes by renames only (`tests/dialect-boundary.test.ts`,
  `npm run check:boundary`).
- [x] The live suite runs the 0.x tests through `src/legacy.ts` and the native
  tests through the root; the packed live lane runs them through
  `drizzle-cubrid/legacy` and `drizzle-cubrid`, with `drizzle-cubrid/native`
  used by the DDL helper and the CommonJS smoke.
- [x] Migration guide: [MIGRATING_FROM_0X.md](../MIGRATING_FROM_0X.md); CHANGELOG
  **Breaking** and **Deprecated** entries.
- [x] A maintainer accepts this ADR explicitly in a reviewed PR.
- [ ] 0.3.0 is released by the maintainer under ADR 0001's release gate (not
  done by this change; the version in `package.json` is unchanged).
- [ ] 1.0.0 removes the legacy entry, its sources, the placeholders and the
  baseline (decision 8).

## References

- [#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155) (native architecture epic), [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192) (foreign-dialect boundary), [#187](https://github.com/cubrid-lab/drizzle-cubrid/issues/187) (honest package identity)
- [MIGRATING_FROM_0X.md](../MIGRATING_FROM_0X.md), [NATIVE_API.md](../NATIVE_API.md), [MIGRATIONS.md](../MIGRATIONS.md), [COMPATIBILITY.md](../COMPATIBILITY.md)
- `src/native/index.ts`, `src/native/removed.ts`, `src/legacy.ts`, `src/deprecation.ts`, `tsup.config.ts`, `package.json` `exports`, `scripts/check-dialect-boundary.mjs`
- Node.js: [`process.emitWarning()`](https://nodejs.org/api/process.html#processemitwarningwarning-options), [`--no-deprecation`](https://nodejs.org/api/cli.html#--no-deprecation), [`--disable-warning`](https://nodejs.org/api/cli.html#--disable-warningcode-or-type)
