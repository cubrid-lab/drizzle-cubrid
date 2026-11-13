# ADR 0005: Reproducible, language-native development setup

- **Status:** Proposed
- **Date:** 2026-11-07
- **Scope:** TypeScript/Drizzle developer setup, quality tooling and environment contracts
- **Prerequisites:** Release governance ADR 0001 and TDD ADR 0004; architecture ADR 0003 remains proposed until reviewed.

## Context

A correct CUBRID design and test-first workflow can still fail when contributors use inconsistent compiler/runtime versions, lockfiles, phantom integration tests or package/module paths that cannot be installed by an external consumer. A developer passing offline tests must not claim real broker/DDL or published package compatibility. This repository therefore requires a reproducible, language-native toolchain, independently executable real CUBRID verification, and honest evidence for its Drizzle ORM APIs, npm peer dependency ranges, native SQL/DDL, and real CUBRID integration.

## Decision

Recommend Node 22 for local build/tooling while **committing to Node >=18 consumers for all 1.x versions**, with real ESM/CJS tests of the packed package. Any increase to the minimum Node runtime is a possible **2.0 major** decision only. Use `npm ci` with the committed lockfile. Explicitly block false integration test instructions: the package's `integration` script references `tests/integration.test.ts`, but that file and Docker Compose are absent on main. Do not introduce a MySQL-based DB setup as a substitute for a CUBRID dialect.

- Maintain a **single repository-local onboarding guide** [DEVELOPMENT_SETUP.md](../DEVELOPMENT_SETUP.md) that names the actual install/build/offline/live-CUBRID/publish-consumer steps, without requiring other-language package tools.
- Use the repo's checked-in lockfile or module manifest and keep dependency update/publishing workflows separately reviewed. Do not blindly regenerate a lockfile or raise a published runtime floor to fix a development-tool problem.
- Run **non-mutating** preflight/format checks by default. Code-formatters that rewrite files are separate intentional developer actions, not read-only readiness checks.
- Distinguish **setup ready**, **offline tests passed**, **real CUBRID integration passed** and **release artifact verified** as four distinct states. No passing prerequisite implies later states.
- Avoid adding heavyweight per-PR jobs just to demonstrate setup. Reserve required live DB matrix and external consumer checks for relevant behavioral changes and final release candidates.

## 1.x Node.js 18 support constraint

[ADR 0006](0006-node-18-support-through-1x.md) makes the **Node 18 consumer floor mandatory for all planned 1.x releases**; it is not merely retained "until" a possible 1.x decision to change it. Development tools may require Node 22. Verify emitted code and peer dependencies by installing the **packed artifact in a clean Node 18 consumer**, separately from Vitest/ESLint on Node 22. Raising `engines.node` above 18 is a future **2.0 major** proposal only. Keep the existing [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100) toolchain failure as an open CI issue until that separation is actually implemented and tested.

## Alternatives considered

- **Rejected:** An externally copied setup that ignores this repository's actual toolchain, dependency graph, and test commands.
- **Rejected:** Treat the green CI of an unrelated driver as proof the ORM or new developer machine is ready.
- **Rejected:** Silently replace dependencies, module imports or runtime support bounds during documentation/setup work.
- **Rejected:** Install a non-CUBRID fake server to make a missing real integration test appear green.

## Consequences and trade-offs

The setup guide makes current blockers visible rather than working around them. Some integration commands must remain explicitly blocked until a real CUBRID harness, correct package dependencies and verified ORM extension contracts are validated. Tool-version upgrades may need independent consumer compatibility reviews.

## Blocking questions before setup approval

Resolve existing #100 Node 18 Vitest incompatibility without silently raising supported consumer floor; identify lint configuration and missing integration test; verify Drizzle/cubrid-client peer support and packed exports before stable release.

## Verification / acceptance criteria

- [ ] A clean checkout installs/builds using the declared manifest/toolchain and reproducible documented commands, with actual observed results.
- [ ] A read-only check can identify baseline tools, missing files and unsupported operations without modifying tracked source.
- [ ] The setup guide has no phantom scripts, Docker Compose file or declared test coverage.
- [ ] Language-specific compiler/runtime and package/module path requirements are coherent with existing consumers; divergent development vs consumer versions are explicit.
- [x] Real CUBRID integration is separately executable and cannot be marked passed when missing/zero/skipped (`npm run integration`, CI job Live CUBRID 11.4).
- [ ] Final release candidate CI and external consumer/registry verification remain mandatory according to ADR 0001.
- [ ] Maintainer approves the decision and its outstanding blockers. Documentation alone does not mean setup validation passed.

## References

[Design sign-off](../DESIGN_SIGNOFF.md) (currently proposed), [engineering invariants](../ENGINEERING_INVARIANTS.md), [TDD ADR 0004](0004-test-first-development.md), [release ADR 0001](0001-release-governance.md).

**This ADR records a proposed setup contract. It does not itself install tooling, execute tests, change dependency metadata, or authorize a release.**
