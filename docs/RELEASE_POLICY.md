# Release and compatibility policy (proposed)

> **Decision stage:** Draft policy for review, 2026-11-07. This document is a release contract proposal; no version, tag, dependency or publication workflow changes are made by this PR. Architecture/implementation follow only after approval and merge.

## TypeScript Drizzle adapter correctness and verification

Review [the repository-specific engineering invariants](ENGINEERING_INVARIANTS.md) before accepting behavioral CUBRID changes or declaring database compatibility. The checklist follows this repository's own API, implementation risks, and verifiable CUBRID behavior. **Written review rules are not executable checks**: the real-CUBRID release gate below remains mandatory, and any missing test coverage is tracked as implementation work rather than claimed complete.

## Reproducible development setup prerequisite

[Setup ADR 0005](adr/0005-development-setup.md) and the [language-specific development setup guide](DEVELOPMENT_SETUP.md) define the pre-implementation environment contract. A release candidate must be built from a clean checkout with the reviewed manifest and supported compiler/runtime, and must verify the **actual distributed artifact** independently of local workspace source. Setup ready, offline tests passed, live CUBRID verified, and registry publication confirmed are distinct outcomes. Document missing lint config, non-resolving module/crate dependency or absent integration harness as **blocking/unverified**, not green. A passing unit suite cannot waive the candidate's real-database gate. Changing the minimum supported consumer runtime/module path/MSRV is separately reviewed for SemVer impact; no such change is authorized by this setup documentation.

## Version numbers

Use SemVer for **each publicly distributed package/module/crate**. A compatibility-generation relationship between the CUBRID driver and its ORM adapter does not override an individual package's SemVer contract.

| Change | Before 1.0 | From 1.0 onward |
| --- | --- | --- |
| New backward-compatible functionality | MINOR (0.y+1.0) | MINOR |
| Incompatible public API, supported runtime, connection/result behavior, or SQL/migration contract | MINOR with explicit migration notes | MAJOR |
| Backward-compatible defect, security, documentation or tooling fix | PATCH when published behavior remains compatible | PATCH |
| Internal-only code/documentation without user-visible change | No release required unless part of a reviewed release batch | Same |

A severe correctness defect is repaired promptly; explain any observable change, regression tests and consumer impact. Do not conceal an incompatible change as PATCH. Do not infer compatibility from unchanged type signatures alone: SQL meaning, column value mapping and schema migration behavior can break applications.

A release's **version, supported runtime/database ranges, published package exports, immutable tag and release notes must agree**. The new version is not considered released merely because a manifest was edited or a draft PR merged.

## Node.js 18 compatibility for every 1.x adapter release

**Approved direction for design, pending ADR review:** The first stable `drizzle-cubrid@1.0.0` and **all subsequent 1.x MINOR/PATCH/maintenance releases** must retain **`engines.node >=18`**. A Node minimum above 18 is a possible future **2.0 MAJOR** change only, subject to separately reviewed breaking-change policy, migration notes and actual downstream/driver compatibility. `cubrid-client@1.x` retains Node 18 throughout its own 1.x generation. These compatibility promises do not force identical minor/patch numbers or automatic major bumps between packages.

A modern Node 22 compiler/Vitest/ESLint development job is independent of a required **Node 18 external npm-tarball ESM/CJS consumer smoke**, using tested `cubrid-client` and `drizzle-orm` versions. Incompatible Vitest toolchain under Node 18 does not justify raising the 1.x consumer minimum or counting a cancelled Node 18 lane as successful. Maintain modern toolchain/coverage checks separately and fail closed when the Node 18 consumer check does not run or fails. See [ADR 0006](adr/0006-node-18-support-through-1x.md) and [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100).

## Driver ↔ ORM compatibility generations

- Target **1.x driver + 1.x ORM** for each language's first verified stable integration. This is a *supported compatibility generation*, not simultaneous publication or equality of full version strings.
- Driver and ORM MINOR/PATCH releases are independent. A newer driver release does not automatically authorize a new ORM release.
- Driver MAJOR release triggers an ORM compatibility assessment and tested peer/module/crate version policy. Publish a new adapter MAJOR **only when its own compatibility promise changes incompatibly**; do not force a pointless MAJOR just for matching digits.
- If an ORM's own API needs a MAJOR independently of the driver, honor SemVer and document the temporary numeric mismatch. Never hide breaking changes to keep the numbers equal.
- Publish bounded **actually tested** dependency support ranges, not open-ended assumptions. Include explicitly tested CUBRID database versions. Unverified combinations must be labeled unverified.

## Workflow and release notes

1. Merge scoped code/test/documentation PRs with required final-head CI. Architectural notes and mocked tests are not substitutes for live CUBRID tests.
2. Open a **reviewed release candidate PR** containing the proposed version change, manifest/lockfile or crate metadata, release notes, API/compatibility notes, and any migration instructions. No automatic publish directly from arbitrary feature PR merges.
3. Run an explicit **release preflight** on the exact candidate commit: quality/lint/tests, real supported database matrix where the release makes DB behavior claims, package/build artifact verification, dependency lower-bound and consumer smoke tests, and security/secret checks. Fail closed for missing, failed, cancelled or skipped required release checks.
4. A maintainer approves the candidate and release notes. Release/publishing permission changes need independent security review. Only then create immutable tags and publish to the language's registry. Do not overwrite tags or re-publish an existing version.
5. Verify the public registry artifact and GitHub Release match the reviewed commit and tag. Record evidence and a release recovery/retry procedure; do not mask a partial publish as a success.

Recommended release-note headings (omit empty sections): **Highlights**, **Breaking changes / Migration**, **Fixes**, **Compatibility**, **Dependencies**, and **Contributors**. Attribute contributions inline with `by @username` where provenance is known; optionally welcome verified first-time contributors. Avoid broken Markdown line wrapping, misleading first-contribution claims, and autogenerated duplicate contributor credits.

Release automation may prepare a candidate PR, but **must not skip the review, release gate or registry verification**. Choose language-appropriate tools and do not copy an npm workflow into Go or Cargo unmodified.

## Mandatory live-CUBRID release verification

**Release rule, not an existing CI claim:** Before publishing **any release that changes or claims database behavior**, run DB-backed tests against the exact candidate commit and testable published package/module/crate; before **1.0**, complete the full documented supported CUBRID version matrix. For ordinary doc-only or tooling PRs, lightweight checks may be sufficient, but the eventual **release candidate** must not use the docs-only shortcut to skip a required database gate.

**Minimum evidence by responsibility:**

| Verification category | Database driver | ORM/dialect adapter |
| --- | --- | --- |
| Connection and session | Broker/CAS handshake, version discovery, disconnect/reconnect, stale handles | Driver connection acquisition and correct transaction-bound session |
| Query behavior | Prepared/parameterized execution, SELECT and DML results, cursor/stream cleanup | Actual ORM-generated SELECT/JOIN/CRUD SQL, result mapping, associations |
| Data fidelity | NULL, BIGINT, decimal precision, text/Unicode, bytes, date/time, collections as supported | ORM-level round trips and type inference/conversion for the same supported types |
| Transactions | Commit, rollback, concurrent clients, failed/uncertain commit, isolation | Nested transactions/savepoints if advertised, rollback and error propagation |
| Failure/recovery | Timeout, CAS restart, broken connection, SQL/server errors, no unsafe replay | Failed queries/transactions, connection loss and no silent success |
| Schema/migration | Catalog or DDL only where the driver advertises support | Schema discovery and real CREATE/ALTER/index/constraint changes, destructive-change safety and recovery |

**Matrix and test validity:**

1. Identify actual CUBRID **server and broker** versions under test and the exact driver/ORM/runtime/dependency versions. A proposed range (e.g. 10.2–11.4) is not a verified range until each advertised version family is tested or its limits explicitly stated.
2. Provision an isolated CUBRID database with a reliable readiness probe. Create unique test tables or databases; clean up safely even after failures. Never run destructive migration tests on shared or production databases.
3. Run non-vacuous tests that **connect to the server, execute SQL and assert stored/read results**. A healthy Docker container, successful ping, mock test, query snapshot or passing job with zero integration tests is **not evidence**.
4. Include both success and failure-path evidence. Add selected JDBC-based semantic comparisons where valuable for rows, types and transaction outcomes, but do not depend on byte-for-byte parity or use JDBC as an implementation blueprint.
5. Record the tested commit SHA, CUBRID version and image/reference digest where possible, test command, counts of passed/failed/skipped cases, and artifacts/logs. Zero executed tests, missing environment, skipped required cases or failing required database jobs block the relevant release claim.
6. Run a **release-candidate-only full verification** even when change-impact routing skips DB jobs on docs-only pull requests. Fail closed for inconclusive evidence; rerun on the exact final candidate after a code or release-manifest change.
7. Test the **actual distributed artifact** in a small external consumer (Go module, Rust crate or npm tarball). In-repository tests cannot alone confirm release metadata, dependency resolution, or imported runtime behavior.

**Scope:** This is a policy requirement. Existing green CI runs are not reclassified as complete integration evidence. Implementation of new CI jobs, server provisioning and tests must be separately reviewed. No automatic 1.0 release is authorized by this document.

**Drizzle-specific blocker:** `.github/workflows/ci.yml` currently runs Node typecheck/build/Vitest only; `package.json` references an `integration` script and an integration test file that are not checked in. Release preflight must add nonempty real-CUBRID integration tests for independently generated SQL, Drizzle type mapping, generated keys, relational queries, transactions and any advertised migration behavior. The available `cubrid-client@1.x` driver test matrix does **not** certify `drizzle-cubrid`.

Implementation tracker: [#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164), [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163).

## 1.0 release gate

A 1.0 release requires: a reviewed/frozen public interface, documented supported runtime and CUBRID matrix, real-database evidence for advertised database behavior, transaction/result/precision/error correctness, packaged consumer/install test, reproducible CI, explicit unsupported features, and upgrade instructions from 0.x. Documentation or test-count badges alone do not satisfy this gate.

Design PRs may be developed as drafts in parallel, but **must not be treated as implementing or approving a release contract**. Do not remove, overwrite or silently narrow an existing 0.x public feature while preparing this policy.

## TypeScript / Drizzle policy

- Current declared package version: `0.2.1`. `cubrid-client` has published `1.2.0`, but current adapter peer ranges `drizzle-orm >=0.38.0` and `cubrid-client >=0.1.0` are **not** evidence of tested compatibility.
- Target `drizzle-cubrid@1.0.0` only after its independent CUBRID SQL dialect, types, execution, transactions, and any advertised migrations are validated. The target driver-generation is verified `cubrid-client@1.x`; do not assume the full 1.x interval works without tests.
- Drizzle ORM API/SQL compiler compatibility is an **independent** axis from the driver version. Bound peer ranges after checking the oldest and newest versions actually verified.
- ESM/CJS exports, emitted `.d.ts`, public schema/query inference and Node.js minimum are versioned APIs. Test an installed `npm pack` tarball with real ESM/CJS/TypeScript consumers, not only in-repo imports.
- Categorize query semantics, generated keys and migrations as potentially breaking, even if TypeScript API signatures remain unchanged.
- `.github/workflows/publish.yml` currently publishes on a `v*` tag after a Node matrix; it is **not** the release-candidate workflow used by `cubrid-client`. First design an idempotent reviewed-release gate (e.g. Release Please, as used by `cubrid-client`), then change automation in a separate PR after independent security review. Do **not** create an automatic tag or npm publication in this policy PR.
- Align the minimum tested npm consumer Node/Drizzle/driver versions with the build toolchain without silently dropping advertised Node support.

Related: [version/peer policy #151](https://github.com/cubrid-lab/drizzle-cubrid/issues/151), [native dialect #155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155), [draft architecture PR #166](https://github.com/cubrid-lab/drizzle-cubrid/pull/166).
