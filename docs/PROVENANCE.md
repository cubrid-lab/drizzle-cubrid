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
  original code that imports drizzle-orm's dialect-neutral modules and subclasses some of its classes (`Column`,
  `ColumnBuilder`, `Table`, `Subquery`, `QueryPromise`, `TransactionRollbackError`). Its overlap with drizzle-orm is
  limited to what Drizzle's public API dictates, and all of it was read by hand:
  - the public `findMany()`/`findFirst()` signatures in `relational.ts` (`DBQueryConfig`, `KnownKeysOnly`,
    `BuildQueryResult`), identical to Drizzle's relational query builders so that `db.query` has Drizzle's types
    (the longest runs: 50 identical, 84 same-shape tokens);
  - type-parameter lists (`TFullSchema`/`TSchema = ExtractTablesWithRelations<TFullSchema>` in `db.ts`, 35
    identical), the `db.query` type guard, which reuses Drizzle's `DrizzleTypeError` message so a missing schema
    generic reads as it does in Drizzle, and column and builder declarations;
  - one-line builder methods (`unique()`, `autoIncrement()`, `limit()`, `$dynamic()`, `getSQL()`, `toSQL()`), an
    export list in `index.ts` (59 same-shape tokens) and common loops.

  No method body or algorithm follows drizzle-orm; no notice is needed.
- **0.x API** (`drizzle-cubrid/legacy`): subclasses of drizzle-orm's MySQL classes. Parts of two files follow
  drizzle-orm's MySQL drivers (0.38.x to 0.45.x) closely: in `src/session.ts` the `CubridPreparedQuery` constructor
  and the start of `execute()`, the `CubridSession` constructor and `prepareQuery()` (73 identical tokens with
  mysql-proxy's `MySqlRemoteSession.prepareQuery()` in 0.44.1), `all()`, the BEGIN/COMMIT fallback of
  `transaction()` and the savepoints of `CubridTransaction.transaction()`; in `src/driver.ts` the logger and schema
  setup of `construct()`. At 0.1.0 `src/session.ts` had runs of 86 identical and 169 same-shape tokens with
  drizzle-orm 0.38.x. Much of this is dictated by drizzle-orm's abstract `MySqlSession`/`MySqlTransaction` API, and
  whether it is copyrightable expression is not decided here. As a precaution both files carry an Apache-2.0
  attribution and change notice, and the package ships [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) with
  the Apache-2.0 text.
- **Earlier releases:** 0.1.0, 0.2.0 and 0.2.1 shipped `dist/index.*`, `README.md` and `LICENSE` (MIT) only, without
  this notice; the 0.2.1 tarball was checked and mentions no Apache license. The notice applies from the next
  release.
- **cubrid-client** (MIT, same organisation): imported, never bundled; the only overlap is the re-declared shape of
  its public `query()` signature (22 tokens).
- **Package**: `dist` contains only this repository's code. drizzle-orm and cubrid-client are peer dependencies,
  imported, not bundled; no other third-party code is bundled.

## Method

Upstream source. drizzle-orm's npm tarballs embed their TypeScript source in source maps (`sourcesContent`).
The source was taken from the published tarballs of the versions that matter:

| Version | Why |
| --- | --- |
| 0.38.4 | locked when the 0.x code was written (0.1.0 depended on `^0.38.0`) |
| 0.44.1 | floor of the peer range `>=0.44.1 <0.46.0` |
| 0.45.4 | locked version at this audit (0.45.1 and 0.45.2, locked before, were also scanned) |

Two sampled files (`mysql2/session.ts`, `mysql-core/dialect.ts`) are byte-identical to the GitHub tag `0.45.4`.

Token comparison (`scripts/check-provenance.mjs similarity`). Every `src/**/*.ts` file and every upstream file is
parsed with the TypeScript compiler and reduced to the leaf tokens of the syntax tree, so comments, JSDoc and
whitespace never count and template literals and regular expressions are split as the parser sees them. Two
comparisons:

- *identical*: the same tokens, identifiers and literals included;
- *same shape*: identifiers, strings, numbers and template parts replaced by placeholders, which finds renamed
  copies.

The scan reports every run of at least 25 identical or 50 same-shape tokens (the defaults). The audit itself also
ran at 20 identical / 40 same-shape tokens and measured the longest run per file; every hit at the defaults was
read by hand, and every subclass of a drizzle-orm class in the 0.x code was also compared by hand with the matching
mysql2/mysql-proxy driver class. Reviewed hits are recorded in `scripts/provenance-reviewed.json` by content: file,
comparison (`raw` identical or `norm` same-shape), length and the SHA-256 of the compared tokens, with a category
(`api`: dictated by Drizzle's public API; `attributed`: covered by the Apache-2.0 notice) and the reason. The
enclosing declaration (`where`), line range and upstream file are recorded as hints only. A hit is accepted when
its content hash matches and it is not longer than reviewed, so moving reviewed code (lines inserted above it,
reindenting) keeps it reviewed, while changing a matched token or a longer run fails the scan. Any other hit fails
too. The 41 entries cover the hits of drizzle-orm 0.38.4, 0.44.1 and 0.45.4 compared alone and together (which
upstream file matches best, and so a run's extent, depends on the versions compared).

Controls (`tests/provenance-scan.test.ts`, run by `npm test`; it also checks that reviewed entries survive inserted
lines and reindenting, and that a changed or longer run needs a new review): 120 lines of `mysql-core/dialect.ts` with `MySql`
renamed to `Cubrid`, `sql` renamed and the indentation changed are found as one same-shape run of more than 200
tokens; a renamed copy of `MySql2Session` placed after template literals is found as a run of more than 300 tokens.
The scan also flags the 0.1.0 tree (commit `78f4680`) against drizzle-orm 0.38.4 with 18 hits, among them
`src/session.ts` runs of 81, 86 and 53 identical and 169 same-shape tokens. The first version of the scan used a
plain token scanner that mis-read code after a template literal; its numbers are superseded by this page.

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
| `relational.ts` | 619 | original, imports | 50 | 84 | `findMany()`/`findFirst()` signatures (`:605-617`) as in Drizzle's relational query builders: the public `db.query` types. The loader (batched `IN (...)`, no LATERAL/JSON) shares no code with Drizzle's |
| `dialect.ts` | 679 | original, imports | 24 | 35 | SQL compiler for CUBRID. Compared with mysql-core, pg-core and sqlite-core `dialect.ts`: no shared method bodies; the longest runs are loops over `Object.entries` |
| `select.ts` | 871 | original, imports | 24 | 48 | Shared runs are the `select()`/`selectDistinct()` overloads and type-parameter lists of Drizzle's public select types (`SelectMode`, `JoinNullability`, `AppendToResult`) |
| `dml.ts` | 422 | original, imports | 27 | 42 | `limit()`, `$dynamic()`, `getSQL()`, `toSQL()`; `ReturnedKeyColumns` computes the same keys as mysql-core's `PrimaryKeyKeys` but is written differently |
| `db.ts` | 216 | original, imports, subclass | 35 | 49 | Database type parameters (`:61-64`, `:157-159`), config generic defaults, the `db.query` type guard with Drizzle's `DrizzleTypeError` message; `relationalSchema()` calls Drizzle's public `extractTablesRelationalConfig()` |
| `session.ts` | 665 | original, imports | 17 | 39 | Not a `MySqlSession`; its own transaction scopes and savepoints |
| `table.ts` | 330 | original, subclass | 16 | 33 | `CubridTable` extends `Table` |
| `index.ts` | 215 | original, imports | 9 | 59 | The longest run is its export list |
| `internal.ts` | 170 | original, imports | 9 | 22 | Reads Drizzle internals in one place (ADR 0007) |
| `ddl.ts`, `foreign-keys.ts`, `removed.ts`, `timezone.ts` | 513 | original, imports | ≤ 18 | ≤ 39 | |
| `migrator.ts`, `migration-sql.ts` | 703 | original | ≤ 18 | ≤ 26 | Not modelled on drizzle-orm's migrators |
| `columns/common.ts` | 147 | original, subclass | 41 | 50 | `unique()` and `autoIncrement()` are the same assignments as mysql-core's (`config.isUnique`, `config.uniqueName`, `config.autoIncrement`, `config.hasDefault`), dictated by `ColumnBuilder`'s config and types |
| `columns/*.ts` (others) | 1625 | original, subclass | ≤ 25 | ≤ 50 | Builders with CUBRID types and codecs; shared runs are builder declarations (`constructor(name) { super(name, …) }`, `static [entityKind]`), `getSQLType()` and `mapFromDriverValue()` openings |

### 0.x API (`src/*.ts`, `src/columns/*.ts`, in `dist/legacy.*`)

| File | Lines | Category | Identical | Shape | Notes |
| --- | ---: | --- | ---: | ---: | --- |
| `session.ts` | 699 | subclass, **adapted (partial)** | 73 (86 at 0.1.0) | 74 (169 at 0.1.0) | `CubridPreparedQuery` constructor (mysql-proxy `PreparedQuery`, 55) and start of `execute()` (`MySql2PreparedQuery`, 38); `CubridSession` constructor and `prepareQuery()` (`MySql2Session`, mysql-proxy `MySqlRemoteSession`, 73); `all()` (`MySqlRemoteSession`, 46); BEGIN/COMMIT fallback of `transaction()` (`MySql2Session`, 40); savepoints of `CubridTransaction.transaction()` (`MySql2Transaction`, 34). Changed for cubrid-client transactions, isolation levels, binding, no `RELEASE SAVEPOINT`, row mapping. Apache-2.0 notice in the header |
| `driver.ts` | 178 | subclass, **adapted (partial)** | 46 | 49 | Logger and relational-schema setup in `construct()` follow `drizzle()` in `mysql2/driver.ts`; `CubridDatabase` extends `MySqlDatabase`. Apache-2.0 notice in the header |
| `dialect.ts` | 354 | subclass | 16 | 31 | Extends `MySqlDialect`; its overrides refuse unsupported SQL or rewrite the input, then call the parent method |
| `columns/temporal.ts` | 265 | subclass | 16 | 25 | Extends mysql-core date/time classes with cubrid-client value mapping |
| `columns/collections.ts` | 279 | original, imports | 11 | 25 | `customType()` collections |
| `columns.ts`, `table.ts`, `types.ts` | 132 | imports | 0 | ≤ 18 | Re-exports of mysql-core builders, `mysqlTable`, `customType` |
| `legacy.ts`, `deprecation.ts`, `timezone.ts` | 222 | original | ≤ 11 | ≤ 18 | |

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

Releases 0.1.0 to 0.2.1 were published without these notices (verified on the 0.2.1 tarball: `LICENSE`,
`README.md`, `package.json` and `dist/index.*`, no Apache text or attribution). The notices apply from the next
release.

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

Add the peer floor and the locked drizzle-orm version if they changed. The similarity scan prints how many hits
match `scripts/provenance-reviewed.json` (`--verbose` lists them) and fails on any other hit. For each new hit,
read both sides: if Drizzle's public API dictates it, add an `api` entry with the reason; if new code follows
upstream code, rewrite it or attribute it (file header, THIRD_PARTY_NOTICES.md, an `attributed` entry and the
matrix). `--emit` prints the unreviewed hits as entry skeletons (file, field, tokens, sha256 and the hints) to
complete with `where`, `category` and `reason` after the review. Unrelated edits elsewhere in a file never
invalidate an entry; editing the matched code does, and the hit is reviewed again. Delete entries whose code is
gone. `--upstream=<dir>` compares with a local checkout, `--min-raw`/`--min-normalized` change the thresholds and
`--reviewed=none` shows every hit.

The pack check fails when a file is missing or unexpected, LICENSE is not MIT, THIRD_PARTY_NOTICES.md or the
`dist/legacy.*` attribution is missing, a peer is a dependency, drizzle-orm classes appear in `dist`, or a source
map lists anything outside `src/`. CI runs it in the packed-package job, including for a change to
THIRD_PARTY_NOTICES.md alone.

## Open maintainer items

- **Copyright line.** Resolved: the maintainer unified the organisation name as "CUBRID Lab" (the GitHub display
  name; `cubrid-lab` is the login), so `LICENSE` now says "Copyright (c) 2026 CUBRID Lab", matching the org.
  `package.json` still names an individual author. CONTRIBUTING.md states no inbound license terms, CLA or
  copyright assignment, so contributors keep the copyright in their contributions, presumably licensed under the
  project's MIT license.
- **Precautionary attribution.** The notices on `src/session.ts` and `src/driver.ts` can be kept until the 0.x API
  is removed in 1.0 (ADR 0010), when both files and the drizzle-orm part of THIRD_PARTY_NOTICES.md go away.
- **npm provenance.** From 0.3.1 on, `publish.yml` publishes with npm trusted publishing (OIDC), with no stored npm
  token, and npm attaches a provenance attestation to each version it publishes this way. 0.3.1 was published from
  the `npm-publish` environment; from 0.3.2 on, the job runs in the `production` environment
  ([#268](https://github.com/cubrid-lab/drizzle-cubrid/pull/268)). Versions up to 0.2.1 have none
  ([RELEASE_NOTES_AUDIT.md](RELEASE_NOTES_AUDIT.md)); 0.3.0 was tagged but never published. The Trusted Publisher is
  configured on npmjs.com in the package's settings (`cubrid-lab` / `drizzle-cubrid` / `publish.yml` / environment
  `production`); see [RELEASE_PROCESS.md](RELEASE_PROCESS.md#repository-settings).
- **Release gate.** `publish.yml` does not run `check-provenance.mjs pack`; CI does on every code change.
  Adding it to the release `package` job is a one-line change if wanted.
