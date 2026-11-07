## Summary

Describe the problem, behavior and the CUBRID-specific change.

## Related issues

Link exact issues or write N/A.

## Change type

- [ ] Bug fix or regression
- [ ] Feature / public API or type inference
- [ ] Documentation
- [ ] Refactor
- [ ] CI, tooling, dependencies or release infrastructure

## Implementation and test evidence

Report commands **actually run**, their results and skips. Mocked SQL and coverage do not establish real CUBRID behavior.

- [ ] The owning component (Drizzle adapter, upstream Drizzle/SeaQuery or cubrid-client driver) and the proposed contract/ADR are documented.
- [ ] For behavior changes: describe observed failing RED case, passing GREEN fix and REFACTOR regression checks; or state why TDD is N/A.
- [ ] Run applicable `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:cov` on a supported development toolchain; report failures without lowering **95%** thresholds.
- [ ] For database behavior: record real CUBRID version, actual executed SQL, type/transaction/DDL results and pass/fail/skip counts, or explicitly mark unverified.
- [ ] For runtime/packaging changes: install the built npm tarball and verify **Node 18** ESM/CJS consumers with the tested `cubrid-client` and `drizzle-orm` peer versions. Every `drizzle-cubrid@1.x` release retains Node 18 support.
- [ ] No unsupported MySQL SQL, silently discarded clause, fabricated generated ID or swallowed transaction failure is claimed as CUBRID-native correctness.
- [ ] Documentation, supported versions, migration guidance and release notes match validated behavior.

## Merge and release coordination

List files shared with other PRs (especially `ci.yml`, `package-lock.json` or native dialect interfaces), the intended integration order and actual final-head CI. A docs-only job is not a release candidate gate.

## Reviewers

Mention relevant reviewers, or state unassigned.

## Repository-owned change and reference review

- [ ] This PR stays within **drizzle-cubrid** responsibilities (TypeScript Drizzle dialect, CUBRID SQL generation and npm peer compatibility), rather than copying another project's API or release process.
- [ ] Cross-repository references have a genuine driver/ORM dependency, independent JDBC comparison, or coordination purpose; they are not substitutes for this repository's test evidence.
- [ ] Issue/PR/ADR text does not contain copied tooling, version commitments or test claims from an unrelated language or repository.
