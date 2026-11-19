# Provenance and distribution compliance

The record of [#220](https://github.com/cubrid-lab/drizzle-cubrid/issues/220): where the code in this repository
comes from, what the npm package distributes, and how to repeat the check before a release. It is a project
compliance checklist, not legal advice, and it makes no claim of infringement.

Policy (maintainer decision on #220): drizzle-cubrid stays MIT-licensed. Relicensing is out of scope. An import,
a subclass, an implementation of the same API or functional similarity is not copying; this audit looks for
copied or adapted third-party source and checks that its license conditions are met alongside the MIT-licensed
original code. Extension design is [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156); removing the
remaining MySQL dependency is [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192) and
[#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155).

## Summary

- **Native dialect** (`src/native/**`: the package root, `drizzle-cubrid/native`, `drizzle-cubrid/migrator`):
  original code that imports drizzle-orm's dialect-neutral classes and subclasses some of them (`Column`,
  `ColumnBuilder`, `Table`, `Subquery`, `QueryPromise`, `TransactionRollbackError`). No copied or adapted drizzle-orm block
  was found; the longest identical token run with any drizzle-orm file is 41 tokens (three-line setters dictated
  by Drizzle's column-builder config). No notice is needed.
- **0.x API** (`drizzle-cubrid/legacy`): subclasses of drizzle-orm's MySQL classes. Two files follow drizzle-orm
  0.38.x code closely in places: `src/session.ts` (`MySql2Session`, `MySql2Transaction`, the mysql-proxy
  `PreparedQuery`) and `src/driver.ts` (`drizzle()` in `mysql2/driver.ts`). At 0.1.0 those regions had identical
  runs of up to 86 tokens with drizzle-orm 0.38.0; they have since been rewritten for CUBRID (longest identical run
  now 46 tokens). Much of them is dictated by drizzle-orm's abstract `MySqlSession`/`MySqlTransaction` API, and
  whether they are copyrightable expression is not decided here. As a precaution they carry an Apache-2.0
  attribution and change notice, and the package ships [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) with
  the Apache-2.0 text.
- **cubrid-client** (MIT, same organisation): imported, never bundled; nothing derived from it beyond re-declaring
  the shape of its public `query()` signature.
- **Package**: `dist` contains only this repository's code. drizzle-orm and cubrid-client are peer dependencies,
  imported, not bundled; no other third-party code is bundled.

## Method

Upstream source. drizzle-orm's npm tarballs embed their TypeScript source in source maps (`sourcesContent`).
The source was taken from the published tarballs of the versions that matter:

| Version | Why |
| --- | --- |
| 0.38.4 | locked when the 0.x code was written (0.1.0 depended on `^0.38.0`) |
| 0.44.1 | floor of the peer range `>=0.44.1 <0.46.0` |
| 0.45.1, 0.45.2 | locked versions between 0.2.0 and 0.3 |
| 0.45.4 | locked version at this audit |

Two sampled files (`mysql2/session.ts`, `mysql-core/dialect.ts`) are byte-identical to the GitHub tag `0.45.4`.

Token comparison (`scripts/check-provenance.mjs similarity`). Every `src/**/*.ts` file and every upstream file is
tokenised with the TypeScript scanner, so comments and whitespace never count. Two comparisons:

- *identical*: the same tokens, identifiers included;
- *same shape*: identifiers, strings and numbers replaced by placeholders, which finds renamed copies.

It reports every run at or above a threshold (defaults 50 identical, 100 same-shape tokens). As a control, 108 lines of
`mysql-core/dialect.ts` with `MySql` renamed to `Cubrid`, `sql` renamed and the indentation changed were added
to `src/` for one run: they were reported as a 266-token same-shape run and a 63-token identical run. At the defaults the scan also flags the 0.1.0 tree (commit `78f4680`) against drizzle-orm 0.38.4: `src/session.ts` with 81-, 86- and 53-token identical runs and a 169-token same-shape run, and `src/columns.ts`' list of `export * from` re-exports (120 tokens, same shape); the current tree passes. The
audit itself ran with lower thresholds (20 identical, 40–60 same-shape) and also measured coverage by 12-token
windows; every hit was read by hand. Runs shorter than 20 tokens, and code modelled on another file but
interleaved with changes, can escape the scan, so every subclass of a drizzle-orm class in the 0.x code was also
compared by hand with the matching mysql2 driver class.

Other evidence: `git log --follow` for every file under `src/` (first commit, author), commit messages and source
comments searched for "port", "adapt", "copied", "derived", "based on", "upstream", "Apache", "copyright",
"SPDX" (no hits that describe copying; no third-party license headers), and the same comparison against
cubrid-client 1.4.0's published `dist/index.js` and `dist/index.d.ts`.

## Matrix

Longest identical / same-shape run: tokens shared with any file of drizzle-orm 0.38.4, 0.44.1 or 0.45.4.
Categories: *original*, *imports* (uses drizzle-orm's exports), *subclass* (extends a drizzle-orm class),
*adapted* (follows a specific upstream implementation closely), *copied* (none found).

### Native dialect (`src/native/**`, in `dist/index.*` and `dist/native-migrator.*`)

| File | Lines | Category | Identical | Shape | Notes |
| --- | ---: | --- | ---: | ---: | --- |
| `dialect.ts` | 679 | original, imports | 14 | 35 | SQL compiler for CUBRID. Compared with mysql-core, pg-core and sqlite-core `dialect.ts`: no shared method bodies; the longest run is an `Object.entries` loop shape in `relations.ts` |
| `select.ts` | 871 | original, imports | 23 | 44 | Compared with mysql-core and pg-core `query-builders/select.ts`: the shared runs are type-parameter lists of Drizzle's public select type helpers (`SelectMode`, `JoinNullability`, `AppendToResult`) |
| `dml.ts` | 422 | original, imports | 19 | 42 | `ReturnedKeyColumns` computes the same keys as mysql-core's `PrimaryKeyKeys` but is written differently (key remapping instead of an indexed union) |
| `relational.ts` | 619 | original, imports | 10 | 40 | Batched `IN (...)` loading; drizzle-orm's relational builders use LATERAL/JSON and share no code with it |
| `session.ts` | 665 | original, imports | 17 | 39 | Not a `MySqlSession`; its own transaction scopes and savepoints |
| `db.ts` | 216 | original, imports, subclass | 9 | 41 | `CubridTransactionRollbackError` extends `TransactionRollbackError`; `relationalSchema()` calls Drizzle's public `extractTablesRelationalConfig()` |
| `table.ts` | 330 | original, subclass | 16 | 33 | `CubridTable` extends `Table` |
| `internal.ts` | 170 | original, imports | 9 | 21 | Reads Drizzle internals in one place (ADR 0007) |
| `ddl.ts`, `foreign-keys.ts`, `index.ts`, `removed.ts`, `timezone.ts` | 728 | original, imports | ≤ 11 | ≤ 44 | `index.ts`' longest shape run is its export list |
| `migrator.ts`, `migration-sql.ts` | 703 | original | ≤ 9 | ≤ 26 | Not modelled on drizzle-orm's migrators |
| `columns/common.ts` | 147 | original, subclass | 41 | 50 | `unique()` and `autoIncrement()` are the same three assignments as mysql-core's (`config.isUnique`, `config.uniqueName`, `config.autoIncrement`, `config.hasDefault`): dictated by `ColumnBuilder`'s config and types, not adapted |
| `columns/*.ts` (others) | 1625 | original, subclass | ≤ 17 | ≤ 49 | Builders with CUBRID types and codecs; shared runs are `constructor(name) { super(name, …) }` and `static [entityKind]` declarations |

### 0.x API (`src/*.ts`, `src/columns/*.ts`, in `dist/legacy.*`)

| File | Lines | Category | Identical | Shape | Notes |
| --- | ---: | --- | ---: | ---: | --- |
| `session.ts` | 696 | subclass, **adapted (partial)** | 19 (86 at 0.1.0) | 45 (169 at 0.1.0) | Constructor and `prepareQuery()` shape and the BEGIN/COMMIT fallback of `CubridSession.transaction()` follow `MySql2Session`; `CubridTransaction.transaction()` follows `MySql2Transaction`; the `CubridPreparedQuery` constructor follows mysql-proxy `PreparedQuery` (drizzle-orm 0.38.x). Changed for cubrid-client transactions, isolation levels, binding, no `RELEASE SAVEPOINT`, row mapping. Apache-2.0 notice in the header |
| `driver.ts` | 178 | subclass, **adapted (partial)** | 46 | 49 | Logger and relational-schema setup in `construct()` follow `drizzle()` in `mysql2/driver.ts`; `CubridDatabase` extends `MySqlDatabase`. Apache-2.0 notice in the header |
| `dialect.ts` | 354 | subclass | 13 | 31 | Extends `MySqlDialect`; its overrides refuse unsupported SQL or rewrite the input, then call the parent method |
| `columns/temporal.ts` | 265 | subclass | 16 | 25 | Extends mysql-core date/time classes with cubrid-client value mapping |
| `columns/collections.ts` | 279 | original, imports | 9 | 25 | `customType()` collections |
| `columns.ts`, `table.ts`, `types.ts` | 132 | imports | 0 | ≤ 18 | Re-exports of mysql-core builders, `mysqlTable`, `customType` |
| `legacy.ts`, `deprecation.ts`, `timezone.ts` | 222 | original | ≤ 11 | ≤ 15 | |

## Apache-2.0 conditions for the adapted portions

drizzle-orm is Apache-2.0 (its repository `LICENSE`; the npm tarball ships no license file). It has no `NOTICE`
file and its source files carry no copyright headers.

| Section 4 condition | How it is met |
| --- | --- |
| (a) give recipients a copy of the License | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), shipped in the package, contains the full text |
| (b) modified files carry prominent notices of the change | `/*! … */` header in `src/session.ts` and `src/driver.ts`; esbuild keeps such comments, so they are in `dist/legacy.{js,cjs}` and `dist/legacy.d.{ts,cts}` (checked by `check-provenance.mjs pack`) |
| (c) retain copyright, patent, trademark and attribution notices | none in the upstream source; the headers and THIRD_PARTY_NOTICES.md name the Drizzle Team and the repository |
| (d) reproduce the NOTICE file | upstream has none |

The package's own `LICENSE` remains MIT for drizzle-cubrid's contributions, as Apache-2.0 section 4 allows for
modifications. Nothing else needs a notice: importing drizzle-orm or cubrid-client at runtime distributes none of
their code, and both stay separately installed peer dependencies.

## Packed artifact

Checked with `npm pack` on the build of this commit (version field 0.2.1, before the 0.3 release):

- 22 files: `package.json`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `dist/{index,legacy,native-migrator}`
  `.js`, `.cjs`, `.d.ts`, `.d.cts`, `.js.map`, `.cjs.map`.
- `dist/*.js` and `*.cjs` import `drizzle-orm` (subpaths), `cubrid-client` and Node built-ins only; the
  declarations import their types the same way. No esbuild runtime helpers are emitted.
- Every source map lists only `../src/**` files (20 for `index`, 11 for `legacy`, 2 for `native-migrator`) and
  embeds them in `sourcesContent`, identical to the repository files: the published maps contain this repository's
  MIT source (and the attributed 0.x portions), nothing from `node_modules`.
- README states the community-adapter identity (independently maintained by CUBRID Lab, not an official
  drizzle-orm dialect); `package.json`'s description now says "Community-maintained … (not an official Drizzle
  project)". The `drizzle` and `drizzle-orm` keywords describe compatibility.

## Rerun before a release

```bash
npm ci
npm run check:provenance        # build, pack, check the packed files (network-free; also runs in CI)
node scripts/check-provenance.mjs similarity \
  --version=0.38.4 --version=0.44.1 --version=0.45.4   # downloads drizzle-orm with npm pack
```

Add the peer floor and the locked drizzle-orm version if they changed. The similarity scan exits 1 on a run at or
above the thresholds; read each hit, and if new code follows upstream code, add it to the matrix, the file
header and THIRD_PARTY_NOTICES.md (or rewrite it). `--upstream=<dir>` compares with a local checkout instead,
`--min-raw`/`--min-normalized` lower the thresholds for a closer look. The pack check fails when a file is
missing or unexpected, LICENSE is not MIT, THIRD_PARTY_NOTICES.md or the `dist/legacy.*` attribution is missing,
a peer is a dependency, drizzle-orm classes appear in `dist`, or a source map lists anything outside `src/`.
CI runs it in the packed-package job, which is skipped for docs-only changes such as an edit of
THIRD_PARTY_NOTICES.md alone; run it locally then.

## Open maintainer items

- **Copyright line.** `LICENSE` says "Copyright (c) 2026 CUBRID Labs"; the organisation is "CUBRID Lab" in the
  README and brand, `cubrid-lab` on GitHub, and `package.json` names an individual author. Whether "CUBRID Labs"
  is the intended holder name is a maintainer decision; this audit does not change it. There is no CLA or
  copyright assignment in CONTRIBUTING.md, so contributors keep the copyright in their contributions, licensed
  under MIT.
- **Precautionary attribution.** The notices on `src/session.ts` and `src/driver.ts` can be kept until the 0.x API
  is removed in 1.0 (ADR 0010), when both files and the drizzle-orm part of THIRD_PARTY_NOTICES.md go away.
- **npm provenance.** `publish.yml` already grants `id-token: write` but runs `npm publish` without
  `--provenance`, and no published version has a provenance attestation
  ([RELEASE_NOTES_AUDIT.md](RELEASE_NOTES_AUDIT.md)). Adding `--provenance` (or npm trusted publishing, which can
  also replace `NPM_TOKEN`) needs a public repository on a GitHub-hosted runner, npm 9.5 or later, and a
  `repository.url` matching the repository (all already true), plus, for trusted publishing, the package's settings
  on npmjs.com. It is left to the maintainers; `publish.yml` is unchanged.
- **Release gate.** `publish.yml` does not run `check-provenance.mjs pack`; CI does on every code change.
  Adding it to the release `package` job is a one-line change if wanted.
