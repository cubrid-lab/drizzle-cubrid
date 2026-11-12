# Parallel issue and PR execution plan

> **Snapshot:** 2026-11-08. **Scope:** Open issues and PRs in `cubrid-lab/drizzle-cubrid`. Triage labels have been applied directly to all listed GitHub items. This plan does **not** approve an ADR, mark an issue fixed or authorize a merge. Refresh issue/PR/CI state before execution, as new items may appear.

## Scheduling rule

The 21 open PRs mostly share a failing test matrix; do NOT serialize all issue development behind that CI defect. Split Node 18 packed runtime, 95% coverage, docs-only routing, native extension feasibility, live DB harness and type/SQL contracts into independent lanes. Production merge follows shared interface choices; research and RED tests do not.

- **Start in parallel** unless a concrete technical interface or release artifact really requires an upstream result. A policy/ADR is a prerequisite for **final architecture acceptance or release**, not a blanket ban on independent research, tests, developer setup and CI improvements.
- Scope each PR to one testable outcome; start RED tests or feasibility spikes independently. Coordinate only the final merge on shared files/interfaces, not every investigation.
- Real CUBRID setup, JDBC comparison, failure-case tests and build/tool CI improvements are independent workstreams. Do not call a skipped or zero-case DB lane green.
- Developer Node 22 tooling must not raise the Node 18 consumer minimum during Node driver/Drizzle 1.x; other languages use their own native toolchains.
- Preserve established CI/security/release requirements. A green docs PR is not a release candidate, and no red, cancelled or skipped mandatory check is an automatic merge.
- Use native `priority: critical/high/medium/low` labels on issues and PRs; numeric internal priority codes are not used as titles. Workstream assignment is **not** a hard dependency.

## Open issues — complete inventory (22)

| Issue | Priority | Size | Independent workstream | Actual hard gate / merge coordination |
| --- | --- | --- | --- | --- |
| [#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155) feat: design a CUBRID-native Drizzle integration independent of MySQL | high | M | Native architecture and extension feasibility | None: design, tests and work may start independently. |
| [#156](https://github.com/cubrid-lab/drizzle-cubrid/issues/156) feat: establish independent Drizzle extension boundaries for a native CUBRID dialect | high | S | Native architecture and extension feasibility | Prove an actual Drizzle extension API before integrating native compiler code. Feasibility research does NOT block separate type/SQL/test designs. |
| [#151](https://github.com/cubrid-lab/drizzle-cubrid/issues/151) docs: define Drizzle adapter compatibility and peer dependency policy | high | S | Native architecture and extension feasibility | None: design, tests and work may start independently. |
| [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163) feat: design CUBRID-native schema migrations without MySQL Drizzle Kit mode | medium | M | Native architecture and extension feasibility | Migration feasibility study and transactional DDL tests start now; advertising Kit support depends on verified upstream path, not completion of every CRUD issue. |
| [#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165) feat: design prepared query and streaming support for native CUBRID sessions | medium | S | Native architecture and extension feasibility | Prepared-query capability may require #156 extension API; investigate streaming and driver lifecycle independently. |
| [#157](https://github.com/cubrid-lab/drizzle-cubrid/issues/157) feat: implement CUBRID-native table and column builders | high | M | Independent dialect contract slices | Native runtime merge depends on #156 extension decision; schema and type-level RED tests can begin now. |
| [#158](https://github.com/cubrid-lab/drizzle-cubrid/issues/158) feat: implement native CUBRID SELECT and relational query generation | high | M | Independent dialect contract slices | Final integration needs #156 + stable schema interfaces from #157. SQL case matrices can be designed independently. |
| [#159](https://github.com/cubrid-lab/drizzle-cubrid/issues/159) feat: implement native CUBRID INSERT UPDATE DELETE and generated-key semantics | high | M | Independent dialect contract slices | Final execution/result integration needs #156 and verified metadata contract #160; DML RED tests and SQL grammar work can begin now. |
| [#160](https://github.com/cubrid-lab/drizzle-cubrid/issues/160) feat: rebuild the Drizzle driver and row mapping around cubrid-client | high | M | Independent dialect contract slices | Final adapter integration needs #156; fake-driver tests and the cubrid-client response contract can start now. |
| [#161](https://github.com/cubrid-lab/drizzle-cubrid/issues/161) feat: implement CUBRID-native transactions and savepoint handling | high | M | Independent dialect contract slices | Final transaction integration needs adapter session contract #160, but failure-case tests can be authored independently. |
| [#162](https://github.com/cubrid-lab/drizzle-cubrid/issues/162) feat: implement CUBRID-native collection and scalar type codecs | high | M | Independent dialect contract slices | Final native integration needs #156; codec/precision tests and CUBRID type study can proceed now. |
| [#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164) test: verify native Drizzle behavior against real CUBRID versions | high | M | Live CUBRID and quality evidence | No blocker for the test harness. Establish real CUBRID CI BEFORE native SQL implementation completes. |
| [#154](https://github.com/cubrid-lab/drizzle-cubrid/issues/154) test: restore coverage thresholds without weakening the gate | high | M | Live CUBRID and quality evidence | Implement meaningful coverage tests in parallel with #100, #152 and #167; retain 95% threshold. |
| [#138](https://github.com/cubrid-lab/drizzle-cubrid/issues/138) ci: restore the 95% line-coverage threshold in lint-and-test | medium | S | Live CUBRID and quality evidence | CI baseline diagnosis independent of adding tests in #154 and Node runtime CI #100. |
| [#88](https://github.com/cubrid-lab/drizzle-cubrid/issues/88) bug: CI coverage remains below the configured 95% threshold | medium | S | Live CUBRID and quality evidence | Historical lowering proposal superseded; keep observed baseline distinct from #154 test implementation. |
| [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100) bug: Node 18 CI cannot run Vitest and hides other matrix results | high | S | CI tooling and contributor environment | None: design, tests and work may start independently. |
| [#167](https://github.com/cubrid-lab/drizzle-cubrid/issues/167) ci: align documented Biome rules with actual ESLint scripts and CI checks | high | M | CI tooling and contributor environment | None: design, tests and work may start independently. |
| [#152](https://github.com/cubrid-lab/drizzle-cubrid/issues/152) ci: avoid TypeScript compatibility matrix for documentation-only PRs | medium | M | CI tooling and contributor environment | None: design, tests and work may start independently. |
| [#123](https://github.com/cubrid-lab/drizzle-cubrid/issues/123) ci: run the stale workflow under the cubrid-lab organization name | low | S | CI tooling and contributor environment | None: design, tests and work may start independently. |
| [#102](https://github.com/cubrid-lab/drizzle-cubrid/issues/102) bug: case-colliding PR templates leave macOS and Windows worktrees dirty | medium | S | CI tooling and contributor environment | None: design, tests and work may start independently. |
| [#135](https://github.com/cubrid-lab/drizzle-cubrid/issues/135) docs: reconcile Drizzle agent instructions after review-policy PRs | medium | M | Guidance and issue intake | None: design, tests and work may start independently. |
| [#133](https://github.com/cubrid-lab/drizzle-cubrid/issues/133) chore: implement staged issue intake and label verification | medium | M | Guidance and issue intake | None: design, tests and work may start independently. |

## Open pull requests — complete inventory (21)

| PR | Priority | Workstream | Readiness / merge coordination |
| --- | --- | --- | --- |
| [#168](https://github.com/cubrid-lab/drizzle-cubrid/pull/168) docs: establish Drizzle release and driver compatibility rules | high | Release and native design decisions | Policy is first for final sign-off; CI has been red, fix gate before merge. |
| [#166](https://github.com/cubrid-lab/drizzle-cubrid/pull/166) docs: specify native CUBRID dialect and driver major-version policy (Draft) | high | Release and native design decisions | Draft only: architecture feasibility remains unresolved. Research is parallel, final acceptance follows reviewed release policy. |
| [#153](https://github.com/cubrid-lab/drizzle-cubrid/pull/153) ci: avoid full runtime matrix on documentation-only pull requests | high | Test/CI path to unblock | Docs-only routing can be developed alongside #100 and #154; must preserve required release/main checks. |
| [#101](https://github.com/cubrid-lab/drizzle-cubrid/pull/101) ci: stop Node 18 from failing and masking the other lanes | high | Test/CI path to unblock | Partially addresses matrix cancellation; lacks packed Node 18 consumer smoke. Coordinate workflow file changes with #153 at merge. |
| [#96](https://github.com/cubrid-lab/drizzle-cubrid/pull/96) test: cover collection column type mapping and literal codec | high | Test/CI path to unblock | Collection regression tests can contribute to coverage #154; ensure no false live DB claim. |
| [#136](https://github.com/cubrid-lab/drizzle-cubrid/pull/136) docs(agents): fix Drizzle agent and contributor instructions | medium | Contributor guidance and CI maintenance | Independent PR; verify exact head checks and diff before merge. |
| [#134](https://github.com/cubrid-lab/drizzle-cubrid/pull/134) chore(triage): mark and verify issue triage state | medium | Contributor guidance and CI maintenance | Independent PR; verify exact head checks and diff before merge. |
| [#131](https://github.com/cubrid-lab/drizzle-cubrid/pull/131) docs: standardize tool-neutral PR review workflow | medium | Contributor guidance and CI maintenance | Independent PR; verify exact head checks and diff before merge. |
| [#124](https://github.com/cubrid-lab/drizzle-cubrid/pull/124) ci: run the stale workflow under the cubrid-lab organization name | low | Contributor guidance and CI maintenance | Independent PR; verify exact head checks and diff before merge. |
| [#150](https://github.com/cubrid-lab/drizzle-cubrid/pull/150) chore(deps): bump @typescript-eslint/parser from 8.65.0 to 8.72.1 | medium | Dependency upgrade reviews | Coordinate eslint parser and plugin with #148; avoid incompatible mixed package versions. |
| [#149](https://github.com/cubrid-lab/drizzle-cubrid/pull/149) chore(deps): bump eslint from 10.5.0 to 10.14.0 | medium | Dependency upgrade reviews | ESLint version must match selected lint config #167; no merge on red CI. |
| [#148](https://github.com/cubrid-lab/drizzle-cubrid/pull/148) chore(deps): bump @typescript-eslint/eslint-plugin from 8.65.0 to 8.72.1 | medium | Dependency upgrade reviews | Coordinate parser/eslint-plugin pair with #150; both can be reviewed in parallel. |
| [#129](https://github.com/cubrid-lab/drizzle-cubrid/pull/129) chore(deps): bump @vitest/coverage-v8 from 4.1.9 to 5.0.5 | medium | Dependency upgrade reviews | Vitest coverage-v8 5.x is coupled to Vitest #127; coordinate versions and peer validation before merging. |
| [#127](https://github.com/cubrid-lab/drizzle-cubrid/pull/127) chore(deps): bump vitest from 4.1.9 to 5.0.5 | medium | Dependency upgrade reviews | Vitest 5.x version should be tested with coverage-v8 #129; audit and Node support require review. |
| [#125](https://github.com/cubrid-lab/drizzle-cubrid/pull/125) chore(deps): bump tsup from 8.5.1 to 9.0.0 | medium | Dependency upgrade reviews | Test compatibility and rebase individually. Do not auto-merge while CI fails. |
| [#120](https://github.com/cubrid-lab/drizzle-cubrid/pull/120) chore(deps): bump drizzle-orm from 0.45.2 to 0.45.4 | medium | Dependency upgrade reviews | Drizzle upstream peer upgrade needs versioned contract tests, independent of Node tooling design. |
| [#77](https://github.com/cubrid-lab/drizzle-cubrid/pull/77) chore(deps): bump actions/stale from 10 to 11 | low | Dependency upgrade reviews | Test compatibility and rebase individually. Do not auto-merge while CI fails. |
| [#76](https://github.com/cubrid-lab/drizzle-cubrid/pull/76) chore(deps): bump github/codeql-action from 4 to 4.37.4 | low | Dependency upgrade reviews | Test compatibility and rebase individually. Do not auto-merge while CI fails. |
| [#71](https://github.com/cubrid-lab/drizzle-cubrid/pull/71) chore(deps): bump actions/checkout from 6 to 7 | low | Dependency upgrade reviews | Test compatibility and rebase individually. Do not auto-merge while CI fails. |
| [#70](https://github.com/cubrid-lab/drizzle-cubrid/pull/70) chore(deps): bump actions/setup-node from 6 to 7 | low | Dependency upgrade reviews | Test compatibility and rebase individually. Do not auto-merge while CI fails. |
| [#117](https://github.com/cubrid-lab/drizzle-cubrid/pull/117) docs(brand): add role icon to README (Draft) | low | Nonessential visual documentation | Draft cosmetic work; lowest urgency, no dependency. |

## Priority and merge discipline

1. Tackle **critical** transactional/data-safety defects immediately and independently; do not mix them into a release policy PR.
2. Review **high** policy/setup/feasibility issues and live DB test harnesses in parallel. Policy approval is needed for stable-release sign-off, but not for independent RED tests.
3. Progress **medium** enhancements and CI cleanup on separate branches without forcing the whole roadmap to wait on one issue.
4. Schedule **low** maintenance/cosmetic items opportunistically; do not close or downgrade merely to improve issue counts.
5. Validate actual final-head CI, review comments, supported versions, rollback behavior and registry/consumer evidence before merging or releasing.

**Existing parent tracking:** [#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155). Keep this inventory up to date when an item closes, a PR merges or a new issue is filed; a new issue belongs to its own repository and owner, not a cross-repository implementation dependency.
