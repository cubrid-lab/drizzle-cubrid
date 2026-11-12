# ADR 0006: Preserve Node.js 18 for the entire 1.x generation

- **Status:** Proposed (explicit compatibility decision for the planned 1.x adapter)
- **Date:** 2026-11-08
- **Scope:** `drizzle-cubrid` npm consumer runtime, peer compatibility and test separation
- **Coordinated driver contract:** `cubrid-client` retains Node 18 for its 1.x releases

## Context

`drizzle-cubrid` is currently at 0.x and declares `engines.node >=18`. Its intended first stable major line is 1.x, which must remain compatible with **Node.js 18 for its entire lifetime**. Current Vitest 4/bundler and ESLint 10 development tooling require a newer Node runtime, causing [Node 18 CI failure #100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100). Developer test-runner incompatibility does **not** justify silently withdrawing Node 18 support from the emitted, packaged adapter. The adapter also depends on separately versioned `cubrid-client` and `drizzle-orm`.

## Decision

1. **Keep `engines.node >=18` throughout `drizzle-cubrid@1.x`**, including stable 1.0.0 and all subsequent 1.x MINOR, PATCH and maintenance releases. The currently declared 0.x Node 18 consumer support is not removed as part of project setup.
2. A change to the Node minimum above 18 may be proposed **no earlier than `drizzle-cubrid@2.0.0`**. It requires a reviewed breaking-change ADR, explicit migration notes, independently tested ecosystem/driver compatibility and a release decision. A `cubrid-client` major-version bump does **not** automatically require the Drizzle adapter to bump; respect each package's own SemVer.
3. Use Node 22 for development, Vitest 4/ESLint 10, typecheck/build/coverage and architecture/TDD feedback where required. This **does not** alter the runtime requirement of the output artifact.
4. **Split CI responsibilities**: modern Node runs build/compile/Vitest/lint/coverage; a Node 18 lane installs the **actually built and packed** adapter in a clean fixture with compatible `cubrid-client@1.x` and an *explicitly tested* Drizzle ORM version, and tests CommonJS/ESM imports, key exports, and representative non-DB behavior. Add real-CUBRID adapter integration tests separately. A green Node 22 Vitest run is not a Node 18 runtime pass.
5. Fix [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100) **without raising `engines.node` to 20/22**: avoid running an incompatible Vitest bundler on Node 18, prevent fail-fast cancellation of unrelated matrix lanes, and fail closed if the Node 18 consumer suite does not run or fails.
6. Validate new **runtime** dependencies and peer ranges against the supported Node 18 consumer environment; test the lowest and newest declared supported versions where possible. If a required Drizzle major cannot run under Node 18, do not advertise that combination; constrain the peer range and document an explicit compatibility decision rather than falsely claiming 1.x support.

## Alternatives considered

- **Rejected:** The former #100 suggestion to raise `engines.node` to `>=20.12.0` in 1.x. This would violate the explicit Node 18 1.x commitment.
- **Rejected:** Downgrade all development tooling to Node 18 just to keep Node 18 tests; use a separate runtime compatibility lane.
- **Rejected:** Treat successful tests of `cubrid-client` as evidence that Drizzle's packaged adapter works under Node 18.
- **Rejected:** Release the adapter as 1.x with open-ended unverified `drizzle-orm` and `cubrid-client` peer ranges.

## Consequences and trade-offs

1.x support for an EOL Node runtime requires retaining compatible output and dependencies and keeping an explicit CI lane. Recommend an actively supported Node LTS for new deployments without misrepresenting the library's 1.x minimum. A future 2.x is a **possible** compatibility boundary, not an automatic or scheduled upgrade.

## Verification / acceptance criteria

- [ ] `engines.node` stays `>=18` on every 1.x release candidate.
- [ ] Modern developer toolchain checks (including 95% coverage threshold where currently defined) run on an actually compatible runtime, without lowering required quality gates.
- [ ] Node 18 **clean external packed-artifact** ESM/CJS runtime tests pass, with precise `drizzle-orm`/`cubrid-client` dependencies and nonzero test counts.
- [ ] A failing Node 18 lane does not cancel or conceal modern-Node checks; no skipped lane is presented as supported.
- [ ] Actual CUBRID SQL/integration tests and driver/ORM version matrix remain separate, mandatory evidence for any database compatibility claim and stable 1.0.
- [ ] This proposed decision receives maintainer sign-off; it changes no package manifest, runtime implementation or release tags by itself.

## References

[Release policy](../RELEASE_POLICY.md), [development setup](../DEVELOPMENT_SETUP.md), [architecture draft PR #166](https://github.com/cubrid-lab/drizzle-cubrid/pull/166), [CI issue #100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100), [runtime/tooling issue #167](https://github.com/cubrid-lab/drizzle-cubrid/issues/167).
