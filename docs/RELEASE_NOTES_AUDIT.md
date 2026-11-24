# Release notes audit: v0.1.0, v0.2.0, v0.2.1

Audit of the technical claims in `docs/releases/v0.1.0.md`, `v0.2.0.md` and `v0.2.1.md` against the tagged code, the tag CI runs, the npm registry and the commit history (#233). It is separate from the editorial check in [RELEASE_NOTES_QUALITY.md](RELEASE_NOTES_QUALITY.md) and from the GitHub Release body byte-equality check done for #234.

Verdicts: **verified** (evidence below), **corrected** (the note was wrong or unproven; a correction is proposed in a follow-up PR, see [Proposed corrections](#proposed-corrections)) and **unverifiable** (no evidence at the tag either way).

## Public Release bodies

At the time of this audit the three published GitHub Release bodies are byte-equal to `docs/releases/v0.1.0.md`, `v0.2.0.md` and `v0.2.1.md` on `main` (#234). This document changes neither. The corrections below are proposed in a separate follow-up PR that edits only those three files. No Release body, tag, title, date, asset or npm artifact was changed by this audit.

A merge to `main` that touches `docs/releases/**` triggers `.github/workflows/sync-release-notes.yml`, which runs `gh release edit --notes-file` for every existing tag, so merging the follow-up PR rewrites the three public bodies. That merge needs separate approval with a backup of the current bodies, a remote concurrency check and a fresh API read afterwards (see [RELEASE_NOTES_QUALITY.md](RELEASE_NOTES_QUALITY.md)). Until it is merged, the public bodies keep the text this audit marks as corrected.

## Tags, commits and published artifacts

All three tags are lightweight tags. Each npm tarball's `gitHead` equals the tag commit, and its `engines` and `peerDependencies` equal `package.json` at the tag.

| Tag | Tag commit | npm `gitHead` | npm published (UTC) | GitHub Release published (UTC), author |
|---|---|---|---|---|
| v0.1.0 | `9e41c6c96d7fd4dc053a5814ea18fb149671959d` | same | 2026-03-13T04:06:42Z | 2026-03-13T04:06:43Z, `github-actions[bot]` |
| v0.2.0 | `760d88847e20a4206fcfa11ceaa298a1bd6f7d3d` | same | 2026-03-14T13:28:31Z | 2026-03-14T13:27:31Z, `yeongseon` |
| v0.2.1 | `de1484a9973d701f8e702be82434d7b2c4b30d72` | same | 2026-03-14T13:58:16Z | 2026-03-14T13:58:14Z, `yeongseon` |

- v0.1.0 and v0.2.0 were published by the tag-triggered `Publish to npm` workflow (runs 23035690626 and 23088879753; CI matrix Node 18/20/22 and the publish job succeeded, and the npm publish time falls inside the publish job).
- v0.2.1 was **not** published by the workflow. Run 23089371007 passed its Node 18/20/22 CI jobs, but its publish job started at 13:58:39Z and failed, after npm already had 0.2.1 (13:58:16Z) and the Release had been created by `yeongseon` (13:58:14Z). The npm publisher of all three versions is the npm user `yeongseon`; none has provenance attestations. The 0.2.1 tarball's `dist/` files are byte-identical to 0.2.0's, and its `package.json` differs only in `version` and the `cubrid-client` development dependency, so the manual publish did not change the shipped code.
- The release dates in the note headings match the npm and GitHub publish dates (UTC).
- `CHANGELOG.md` has a section only for 0.1.0, at every tag and on `main`; there are no 0.2.0 or 0.2.1 sections to compare with.

## Contributor provenance

All 13 commits up to and including v0.2.1 (`git log v0.2.1`: 4 up to v0.1.0, 7 more to v0.2.0, 2 more to v0.2.1) are authored by `Yeongseon Choe <yeongseon.choe@gmail.com>`, GitHub login `yeongseon` (GitHub commits API). The initial commit `a7c6868` was created on GitHub: its committer is GitHub (`web-flow`) and it is signed (`verification.verified: true`). The other 12 are committed by `yeongseon` and unsigned (`verification.verified: false`). None is associated with a pull request, so the notes correctly link commits rather than PRs. Every commit except `a7c6868` carries a `Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>` trailer, an AI coding agent, not a person; the notes credit only `@yeongseon`, which is correct.

## v0.1.0

Commits: `a7c6868`, `78f4680`, `e495233`, `9e41c6c` (tag).

| Claim | Evidence | Verdict |
|---|---|---|
| Requires Node.js 18 or newer | `engines.node` is `>=18.0.0` at the tag and on npm; tag CI and publish runs passed on Node 18, 20 and 22 (offline unit tests only). Not tested above Node 22. | verified |
| `drizzle-orm` and `cubrid-client` are peer dependencies | `peerDependencies` `drizzle-orm >=0.38.0`, `cubrid-client >=0.1.0` at the tag and on npm | verified |
| Development dependency pointed to `../cubrid-client`; "v0.2.1 replaced it with the published package" | `devDependencies.cubrid-client` is `file:../cubrid-client` at v0.1.0. v0.2.1 changed only `package.json`; its lockfile and workflows still used the sibling checkout (see v0.2.1) | **corrected** |
| `drizzle()` integration and "CUBRID table/column definitions" | `src/driver.ts`, `src/table.ts` at the tag. But the standard column builders were not exported at runtime: the published `dist/index.js` and `dist/index.cjs` export 28 names without `int`, `varchar` and the other MySQL column builders, while `dist/index.d.ts` declares them through `export * from 'drizzle-orm/mysql-core/columns/...'`. `import { int } from 'drizzle-cubrid'` type-checks and `require('drizzle-cubrid').int` is `undefined`. Rebuilding the tag reproduces the same export list. | **corrected**: narrowed to `cubridTable()`, and the missing exports are stated |
| Query operations, schema builders, collection/monetary columns | `and`, `eq`, `sql`, … and `set`, `multiset`, `sequence`, `monetary` are in the runtime export list; `tests/types.test.ts`, `tests/query.test.ts` | verified |
| Full Changelog link | `commits/v0.1.0` | verified |

The tagged suite passes: 49 tests, `tsc --noEmit` and `npm run build` (with the sibling dependency replaced by `cubrid-client@1.0.0` and `drizzle-orm` 0.38.4). The tests import `src/`, not the build, so they did not catch the missing exports. `CHANGELOG.md`'s 0.1.0 entry ("All MySQL-compatible column types") has the same gap; it is left unchanged here.

## v0.2.0

Commits after v0.1.0: `80b40db` (badge workflow, not user-facing, omitted from the note), `4e74f36`, `c624959`, `53740a9`, `b38b0fe`, `5ccabca`, `760d888` (tag).

| Claim | Evidence | Verdict |
|---|---|---|
| Fix package-root column exports "in the ESM build" | `4e74f36` replaces `export *` with explicit named re-exports in `src/columns.ts`. Published 0.2.0 exports 54 names in both ESM and CJS, including `int` and `varchar`; 0.1.0 exported 28 in both. The fix covers CommonJS too. | **corrected**: "both the ESM and CommonJS builds" |
| (missing) TypeScript removal | The removed `export * from 'drizzle-orm/mysql-core/columns/common'` and the other star re-exports took out the type-only exports of drizzle-orm's column classes, builder types and column config types. `import type { MySqlColumn, MySqlIntBuilder } from 'drizzle-cubrid'` type-checks against 0.1.0 and fails with TS2305 against 0.2.0, as do `AnyMySqlColumn`, `ReferenceConfig`, `ConvertCustomConfig`, `CustomTypeValues`, `CustomTypeParams`, `TimeConfig`, `DatetimeFsp` and `TimestampFsp`. All are still exported by `drizzle-orm/mysql-core`. | **corrected**: Upgrade note added |
| Transaction begin/commit/rollback integration with the CUBRID client | `4e74f36` `src/session.ts`: when the client has `beginTransaction()`/`commit()`/`rollback()` they are called, otherwise SQL `begin`/`commit`/`rollback` is sent. `cubrid-client` 1.0.0's `CubridClient` declares these methods. Without those methods the SQL is as in v0.1.0 (`begin`, or `SET TRANSACTION` and `START TRANSACTION …` for a config). With them, `SET TRANSACTION` is still sent for a config but the `START TRANSACTION` options (`accessMode`, `withConsistentSnapshot`) are not. | verified (offline, mock client); bullet reworded, and the dropped options added as an Upgrade note |
| Transactional client regression tests | `5ccabca` adds three tests to `tests/session.test.ts` (begin/commit without and with config, rollback on error); all pass at the tag (52 tests) | verified |
| Schema, query and troubleshooting guides "with runnable usage examples" | `760d888` adds `docs/SCHEMA.md`, `docs/QUERIES.md`, `docs/TROUBLESHOOTING.md` and README examples. They are code snippets; nothing at the tag runs them. | **corrected**: "with usage examples" |
| PRD design philosophy, `llms.txt`/README keywords, community files and templates | `c624959`, `53740a9`, `b38b0fe` (which also adds `biome.json`, not mentioned) | verified |
| Node and peer ranges | Unchanged from v0.1.0; CI passed on Node 18/20/22 | verified (not claimed in the note) |
| Full Changelog link | `compare/v0.1.0...v0.2.0` | verified |

## v0.2.1

Commits after v0.2.0: `13b0767`, `de1484a` (version bump, tag).

| Claim | Evidence | Verdict |
|---|---|---|
| Replace `file:../cubrid-client` with the published `cubrid-client@^1.0.0` | `13b0767` changes that one line of `package.json` | verified |
| "so contributors and CI no longer need a sibling `cubrid-client` checkout" | At the tag, `package-lock.json` still resolves `cubrid-client` as a link to `../cubrid-client` (version 0.1.0), and `ci.yml` and `publish.yml` still clone it. `npm ci` in a clean export of the tag without a sibling fails: `lock file's cubrid-client@0.1.0 does not satisfy cubrid-client@…`. The requirement was removed after the tag by `3f815fe` (workflows), `be6709c` and `60474c2` (lockfile), which no tag contains. `cubrid-client` 1.0.0 was published at 13:57:07Z, after `13b0767`. | **corrected** |
| Peer range unchanged | `peerDependencies` identical to v0.2.0 at the tag and on npm | verified |
| Category "Bug Fixes" for a development-only change | The published library is unchanged: `dist/` byte-identical to 0.2.0 | kept; a Compatibility bullet should say so |
| Full Changelog link | `compare/v0.2.0...v0.2.1` | verified |

## Proposed corrections

Proposed in the follow-up PR to `docs/releases/v*.md` (branch `docs/release-notes-corrections-233`). Before is the current source and public body; after is the proposed source.

v0.1.0:
- Summary, added: "Import standard column builders such as `int` from `drizzle-orm/mysql-core`, or upgrade to v0.2.0 (see Compatibility)."
- Compatibility, added: "The package root's TypeScript declarations list the standard MySQL-compatible column builders (`int`, `varchar` and others), but neither the ESM nor the CommonJS build exports them, so importing them from `drizzle-cubrid` type-checks and fails at runtime; fixed in v0.2.0."
- Compatibility. Before: "v0.2.1 replaced it with the published package". After: "v0.2.1 changed `package.json` to the published package, and the lockfile and CI stopped using the sibling checkout after v0.2.1".
- Features. Before: "Provide `drizzle()` integration and CUBRID table/column definitions through Drizzle ORM". After: "Provide `drizzle()` integration and the `cubridTable()` table builder through Drizzle ORM".

v0.2.0:
- Summary, added: the TypeScript import change for drizzle-orm's column classes, builder types and column config types.
- New Upgrade notes: the removed type-only re-exports (still importable from `drizzle-orm/mysql-core`), and that with a client that has `beginTransaction()`, `accessMode` and `withConsistentSnapshot` no longer send `START TRANSACTION` options.
- Bug Fixes. Before, one bullet: "Fix package-root column type exports in the ESM build by using explicit named re-exports, and correct transaction begin/commit/rollback integration with the CUBRID client". After, two bullets for `4e74f36`: "Export the standard column builders (`int`, `varchar` and others) from the package root at runtime in both the ESM and CommonJS builds by using explicit named re-exports" and "Run `db.transaction()` through the client's `beginTransaction()`/`commit()`/`rollback()` when it provides them; other clients get the same SQL statements as in v0.1.0".
- Documentation. Before: "with runnable usage examples". After: "with usage examples".

v0.2.1:
- Summary. Before: "Remove the need for a sibling `cubrid-client` checkout in contributor and CI installs." After: "Point the `cubrid-client` development dependency in `package.json` at the published package. The published library is unchanged from v0.2.0; no user action is needed."
- Bug Fixes. Before: "Replace the local `file:../cubrid-client` development dependency with the published `cubrid-client@^1.0.0`, so contributors and CI no longer need a sibling `cubrid-client` checkout; the published package's peer range was unchanged". After: "Change the `cubrid-client` development dependency in `package.json` from `file:../cubrid-client` to the published `^1.0.0`".
- New Compatibility bullets: the published `dist`, `engines` and peer ranges are identical to v0.2.0; and the tagged lockfile and CI/publish workflows still used the sibling checkout (`npm ci` at the tag fails without one), removed after v0.2.1 by `3f815fe`, `be6709c` and `60474c2`. The second bullet has no credit because it describes a remaining defect, not a change.

## Reproduce

```sh
# Tags, package metadata and npm
for t in v0.1.0 v0.2.0 v0.2.1; do git rev-parse "$t^{commit}"; git show "$t:package.json" | jq '{version, engines, peerDependencies, devDependencies}'; done
for v in 0.1.0 0.2.0 0.2.1; do npm view "drizzle-cubrid@$v" engines peerDependencies gitHead dist.tarball _npmUser --json; done
npm view drizzle-cubrid time --json
git log --format='%h %an <%ae> %s' v0.2.1
gh api repos/cubrid-lab/drizzle-cubrid/releases --jq '.[] | [.tag_name, .published_at, .author.login] | @tsv'
gh api 'repos/cubrid-lab/drizzle-cubrid/actions/runs?created=2026-03-12..2026-03-15&per_page=100' --jq '.workflow_runs[] | [.id, .head_sha[0:7], .name, .head_branch, .conclusion] | @tsv'

# Runtime exports of the published packages (drizzle-orm@0.38.4 and cubrid-client@1.0.0 installed)
npm pack drizzle-cubrid@0.1.0 drizzle-cubrid@0.2.0   # unpack each under node_modules/dc<version>
node -e 'for (const v of ["0.1.0", "0.2.0"]) { const m = require("dc" + v); console.log(v, Object.keys(m).length, typeof m.int) }'

# v0.2.1: npm ci without a sibling checkout
git archive v0.2.1 | tar x -C /path/to/empty-dir && cd /path/to/empty-dir && npm ci --ignore-scripts

# Editorial checks
python3 scripts/release_notes_quality.py
python3 -m unittest discover -s scripts -p test_release_notes_quality.py -v
```

No live CUBRID database was used; no claim in these notes depends on server behavior beyond what the offline tests cover.

## Follow-up audit: v0.3.2 (2026-11-24)

This is a read-only evidence update to the historical audit above (#233, #270,
#271, #274). It does not change a versioned note or trigger a historical body
sync. The v0.3.1 migration history remains a separate editorial and provenance
review.

### Public identity and canonical text

- [Public v0.3.2 Release](https://github.com/cubrid-lab/drizzle-cubrid/releases/tag/v0.3.2):
  Release ID `454875530`, published 2026-11-23 01:02:02 UTC, zero attached assets.
- The tag resolves to [`3af52582d9932fa1e5bd03de9591d39c32182c9b`](https://github.com/cubrid-lab/drizzle-cubrid/commit/3af52582d9932fa1e5bd03de9591d39c32182c9b).
  The five existing public Release bodies (v0.1.0, v0.2.0, v0.2.1, v0.3.1,
  v0.3.2) each matched their corresponding `docs/releases/` file exactly
  in the November 24 API comparison. This is a content match, not a claim
  that all five pass an editorial or registry-artifact audit.

### Tagged evidence and contributor credit

| Claim in v0.3.2 | Evidence and limit |
| --- | --- |
| Node and peer ranges | [Tagged package.json](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/package.json#L127-L142): Node >=18.0.0, drizzle-orm >=0.44.1 <0.46.0, cubrid-client >=1.4.0 <2.0.0; development dependency ^1.6.0. |
| Client argument typing | [PR #271](https://github.com/cubrid-lab/drizzle-cubrid/pull/271), [tagged native session](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/src/native/session.ts#L235-L255) and [legacy session](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/src/session.ts#L92-L110) show the array-row/stream parameter change to allow undefined; this is a declaration correction, not evidence of new SQL functionality. |
| Iterator diagnostic | [Tagged native session](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/src/native/session.ts#L496-L506) names client/pool streaming from 1.4 and transaction-client streaming from 1.5.0. |
| Packed declarations | [Tagged packed-types check](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/scripts/packed-types-check.mjs) requires driver >=1.6.0 for this check, exercises root and legacy calls, and filters only drizzle-orm declaration errors. This is not a claim that all supported peer combinations pass strict declaration checks. |
| Contributor | PR #271 was opened by `@yeongseon`; its merged commit is [316429a](https://github.com/cubrid-lab/drizzle-cubrid/commit/316429a32c4bab4840e11b40d1a2774cb47f16da). The two branch commits use an AI account and carry Claude AI co-author trailers; do not count these as human co-authors. |

The two Bug Fixes bullets cite PR #271 and credit its human PR author.
The Tests bullet also cites #271 but omits the same verified credit. A future
separately approved source/body repair should add `by @yeongseon` to that
bullet. Do not change the versioned note as part of this audit: the existing
sync workflow can write public bodies on a merge.

### Existing executed CI versus registry verification

The [tag publish run](https://github.com/cubrid-lab/drizzle-cubrid/actions/runs/45092002346)
on the tag commit completed successfully, including all eight jobs: lint,
Node 20/22 type/unit checks, candidate pack, live CUBRID 11.4 with locked
and floor peers, Node 18 consumer, and publishing the tested tarball.
The separate [CI run](https://github.com/cubrid-lab/drizzle-cubrid/actions/runs/45091936165)
on the same SHA reports successful live and fault-injection jobs.
The [tagged compatibility guide](https://github.com/cubrid-lab/drizzle-cubrid/blob/v0.3.2/docs/COMPATIBILITY.md)
distinguishes fault injection on the locked 1.6.0 driver from the 1.4.0
floor live lane; the publish run does not contain a fault-injection job.

This follow-up did not rerun database tests, download the npm tarball, or
independently check registry `gitHead`, integrity, or provenance attestation.
Successful historical publish CI is evidence of the workflow outcome, not
independent registry verification. The editorial finding and registry
verification remain open work; no public release, tag, asset, or package
was changed.
