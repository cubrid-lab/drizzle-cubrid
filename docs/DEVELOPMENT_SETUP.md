# Development setup — TypeScript Drizzle CUBRID adapter

> **Status:** Reviewed against committed manifests, not an executed setup test. [ADR 0005](adr/0005-development-setup.md) is Proposed. **Node.js developer toolchain and published consumer engine are different contracts.**

## Toolchain and fresh checkout

- Use Node.js **22 for local development** with the current Vitest 4 and ESLint 10 toolchain. `package.json` still advertises **Node >=18** to consumers; do not silently change this engine just because newer development tooling requires Node 20+. Existing [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100) tracks the Node 18 CI failure. Resolve it via a reviewed dev/tooling-versus-runtime compatibility decision before 1.0.
- Clone the adapter only; a local clone of `cubrid-client` is **not** automatically required because `npm ci` resolves it from the registry/lockfile. To test unpublished driver changes, use an explicitly reviewed linked/workspace integration approach and record the actual versions.
- Committed `package-lock.json` is authoritative for reproducible installs.

```sh
git clone https://github.com/cubrid-lab/drizzle-cubrid.git
cd drizzle-cubrid
node --version
npm --version
npm ci
npm run typecheck
npm run build
npm test
```

The repository also declares `npm run test:cov` (95% thresholds in `vitest.config.ts`) and `npm run lint` using ESLint. **The inspected main branch has no ESLint flat-config file**, and Vitest 4/Node 18 incompatibility is known. These commands may fail today; record exact errors rather than claiming setup readiness or weakening coverage thresholds. A missing lint config or incompatible toolchain is a **setup blocker**, not a reason to suppress a required check. `npm run format` is mutating (`eslint --fix`); do not run it as read-only validation.

## Node 18 runtime compatibility through 1.x

**Fixed compatibility rule:** `drizzle-cubrid@1.0.0` and **every 1.x release** must remain usable on Node 18, despite the project's Node 22 `.nvmrc` and newer Vitest/ESLint development tools. The minimum supported Node runtime can only be reconsidered at a **future 2.0 major** with reviewed migration notes; this is not an allowance to drop it in 1.x. [ADR 0006](adr/0006-node-18-support-through-1x.md) records the decision. The `cubrid-client` driver also preserves Node 18 in 1.x.

Design CI in two parts: (1) on Node 22, build/typecheck/Vitest/coverage/lint using current tooling; (2) on **Node 18**, install a **clean packed `drizzle-cubrid` artifact** with explicitly compatible peer versions and run nonzero ESM/CJS import and representative runtime tests. An incompatible Vitest 4 startup on Node 18 is a developer-tooling failure, not evidence the built library cannot run on Node 18. Do not skip the Node 18 consumer check, lower coverage, or change `engines.node` to bypass [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100).

## Real CUBRID integration — not implemented in this checkout

The `integration` npm script currently points to `tests/integration.test.ts`, **which is absent on the inspected main branch**, and there is **no committed Docker Compose file** here. Do not tell contributors that `docker compose up` followed by `npm run integration` proves a live database integration. The actual integration harness needs to be designed and built in [#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164).

The harness must use a disposable real CUBRID instance, the **actual** `cubrid-client` API, tagged supported database versions, and nonzero assertions of SQL/type/transaction/DDL behavior. Verify driver and Drizzle versions separately; neither passing SQL snapshots nor `cubrid-client`'s own integration CI certifies this adapter.

## Packaging and compatibility

```sh
npm run build
npm pack --dry-run
```

Review emitted ESM/CJS and `.d.ts` with an external TypeScript consumer (required for release; **not yet established as an automated check**). `peerDependencies` are `drizzle-orm >=0.44.1 <0.46.0` and `cubrid-client >=1.4.0 <2.0.0`, bounded by the measurements in [peer dependency compatibility](COMPATIBILITY.md); CI checks the lockfile version and the `drizzle-orm` floor. MySQL-based `examples/migration/drizzle.config.ts` is not a validated CUBRID migrator.

## Setup exit criteria

- [ ] Node 22 dev checks are reproduced from `npm ci` on a clean checkout, with observed CI/local outcomes.
- [ ] Node 18 consumer support is **retained for all 1.x releases**, with external packed ESM/CJS smoke tests. A runtime-floor increase may be proposed no earlier than a separately reviewed **2.0 MAJOR**.
- [ ] ESLint configuration and compatible coverage/runtime toolchain are verified; failures are not silenced.
- [ ] Real CUBRID integration suite exists and actually runs before database support is claimed.
- [ ] `docs/DESIGN_SIGNOFF.md` in [architecture draft PR #166](https://github.com/cubrid-lab/drizzle-cubrid/pull/166) covers the native-dialect feasibility and TDD plan; release policy PR must be approved first.
