# ADR 0001: Release governance and compatibility contract

- **Status:** Proposed
- **Date:** 2026-11-07
- **Decision scope:** drizzle-cubrid release and supported-consumer contract
- **Owner:** Repository maintainers (approval not yet recorded)

## Context

The CUBRID Lab language drivers and ORM adapters progressed at different rates. An optimistic package number, borrowed ORM backend, passing mocks or a green but empty integration job must not accidentally imply production readiness. The Python driver and SQLAlchemy dialect established useful regression evidence, but release rules must follow each ecosystem's real package manager and compatibility obligations.

## Decision

Keep 0.x package instability explicitly documented. Do not release 1.0 merely to match cubrid-client's current 1.x. Target stable 1.x only when independent CUBRID SQL, TypeScript inference, transactions, results and any advertised migration capability have actual real-DB evidence. Coordinate **tested compatibility generations** with cubrid-client@1.x, but release adapter MINOR/PATCH independently. Bound both cubrid-client and drizzle-orm peer ranges using proven combinations. Review compiled ESM/CJS and TypeScript declaration consumers. Adopt a reviewed release candidate and full live CUBRID gate before npm publication.

Applicable SemVer classification: a compatible bug/security fix is generally PATCH, an additive feature MINOR, and an incompatible public behavior or supported-environment change requires a reviewed breaking release (under current 0.x rules, commonly the next 0.y.0; at 1.x+ a MAJOR). Changes to SQL generation, data types, migrations or transactions can be compatibility-breaking without exported-type changes. A release candidate must have a reviewed version and notes, a final immutable commit, actual live CUBRID evidence when database behavior is claimed, and verified published artifacts. Keep omitted/failed checks visible; never invent approval or successful publication.

## Runtime compatibility during adapter 1.x

The planned stable adapter **must support Node 18 throughout all 1.x releases**. `engines.node >=18` may not be raised during 1.x to satisfy development tools; Node 22 can be used for compiling/Vitest/ESLint while Node 18 independently tests the packed runtime with compatible `cubrid-client@1.x` and tested Drizzle ORM peer dependencies. Dropping Node 18 is **no earlier than a reviewed 2.0 MAJOR**, not an automatic or scheduled change. See [ADR 0006](0006-node-18-support-through-1x.md). This applies independently of driver major/minor/patch synchrony.

## Alternatives considered

- **Rejected:** Force adapter version equal to driver version; or keep open-ended >= peer dependencies as support guarantees; or publish directly from a user-created tag without reviewed preflight.
- **Rejected:** One centrally synchronized release number and a generic Python-style policy for all languages; each distribution has separate SemVer, packaging and runtime constraints.
- **Rejected:** Treat an issue, green mock suite, GitHub tag or draft changelog as sufficient release evidence.

## Consequences and trade-offs

Initial 1.0 is blocked pending dialect feasibility and actual CUBRID integration. Existing 0.x users need migration notes for the removal of MySQL-derived implementations.

Maintainers must explicitly review the supported matrix and any runtime/API removal. Compatible fixes may be released independently when their own gates pass. Release automation can prepare PRs but must not bypass a maintainer review, exact candidate test or registry verification.

## Verification / acceptance criteria

- [ ] Maintainer reviews and accepts this ADR, links the approval and records acceptance date.
- [ ] Published README/release guide and dependency version declarations agree with the reviewed compatibility contract.
- [ ] A candidate-specific CI check identifies supported CUBRID server versions, tests run/passed/failed/skipped, runtime and driver/ORM versions, and actual artifact.
- [ ] Required release checks reject failed, missing, zero-case or skipped live tests, with scoped exceptions documented as unsupported/unverified—not counted as passes.
- [ ] User-visible breaking changes have accurate migration notes; correct author attribution in curated release notes comes from verified merged contributions.
- [ ] Existing immutable tags and published versions remain untouched by adopting this ADR.

## References

[release policy](../RELEASE_POLICY.md), [compatibility issue #151](https://github.com/cubrid-lab/drizzle-cubrid/issues/151), [architecture design #155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155)

**This ADR does not update version numbers, create a release, authorize publishing, or claim any database test has passed.** Its status remains **Proposed** until explicit maintainer approval.
