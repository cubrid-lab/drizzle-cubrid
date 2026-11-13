# Contributing to drizzle-cubrid

**Issue titles** always start with a lowercase type-only prefix (`feat:`, `bug:`, `docs:`, `test:`, `chore:` or `ci:`) without a module scope; the issue forms prefill one. **PRs and commits** continue to use Conventional Commits and local CI. See [AGENTS.md](AGENTS.md) for evidence, triage and verification responsibilities.

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Issues](#reporting-issues)

---

**Supported consumer runtime (planned 1.x):** `drizzle-cubrid@1.x` retains Node 18 through every minor/patch release, coordinating with `cubrid-client@1.x`. Node 22 (`.nvmrc`) is the development-tool baseline, not a consumer-floor change. For Node 18 CI, test a clean packed adapter with compatible peers rather than attempting to start incompatible Vitest 4 on Node 18. No Node 18 removal until a separately reviewed **2.0 MAJOR**. See [ADR 0006](docs/adr/0006-node-18-support-through-1x.md) and [#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100).

## Development Setup

### Prerequisites

- Node.js 22 recommended for local **developer tooling**. The package still declares Node >=18 for consumers; its CI and dependency compatibility require a separate reviewed decision ([#100](https://github.com/cubrid-lab/drizzle-cubrid/issues/100)).
- Git and npm
- A disposable CUBRID server for the live tests (`tests/integration.test.ts`, `npm run integration`); see [Real CUBRID integration](#real-cubrid-integration) below. No root Docker Compose file is checked in.
- [Development setup and actual blockers](docs/DEVELOPMENT_SETUP.md)

### Installation

```bash
# Clone only the adapter; the checked-in npm lockfile resolves cubrid-client
git clone https://github.com/cubrid-lab/drizzle-cubrid.git
cd drizzle-cubrid

# Install the exact committed dependency tree
npm ci

# Build
npm run build
```

---



## Test-driven implementation

For bug fixes or behavioral features, start from a reviewed interface/SQL/transaction design. Use the [TDD decision](docs/adr/0004-test-first-development.md): **Red** (run a new focused test and capture the genuine target failure), **Green** (smallest production change passing that test), **Refactor** (rerun related tests and final PR CI). In the PR description record the failing assertion/error **actually observed**, the passing assertion, which regressions ran, and whether real CUBRID validation ran or remains unverified. A mock-only pass cannot establish server compatibility; the exact release candidate still requires full live DB validation. No deliberate failing tests or skipped release checks may be left to satisfy the TDD process. For documentation and upstream feasibility work, describe the design/probe evidence rather than forcing an irrelevant Red test. The ADR and design contracts are proposals until reviewed and accepted.

## CUBRID correctness and regression evidence

For changes to Drizzle SQL/schema/types and verified npm driver integration, read [this repository's engineering invariants](docs/ENGINEERING_INVARIANTS.md) **before** implementation and review. The requirements follow the TypeScript Drizzle adapter and its own ORM/driver integration contract, not another package's failure reports or test results. In the pull request, describe the behavioral invariant affected, the normal and failure cases tested, and which checks were offline, real CUBRID or independently compared with JDBC. State the exact CUBRID/runtime/driver versions and test outcomes when claiming database compatibility. **Do not mark tests as passed when they were skipped, missing or never executed.**

For documentation-only or nonbehavioral changes, explain why a database run is unnecessary rather than manufacturing an integration result. The final **release candidate** still follows the repository's full live-CUBRID release gate, separate from ordinary PR path optimization. These expectations supplement, and do not weaken, the established review/CI rules.

## Running Tests

### Unit Tests

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:cov

# Watch mode
npm run test:watch
```

### Real CUBRID integration

Run the live CUBRID tests against a disposable database:

```bash
docker run -d --name cubrid-test -e CUBRID_DB=testdb -p 33000:33000 cubrid/cubrid:11.4
CUBRID_TEST_HOST=127.0.0.1 node scripts/wait-for-cubrid.mjs 300
CUBRID_TEST_HOST=127.0.0.1 npm run integration
```

`tests/integration.test.ts` reads `CUBRID_TEST_HOST` (required), `CUBRID_TEST_PORT`,
`CUBRID_TEST_DATABASE`, `CUBRID_TEST_USER` and `CUBRID_TEST_PASSWORD`. Without a host
it fails instead of skipping. It creates uniquely named tables and drops them at
the end. CI runs it on every code change in the **Live CUBRID 11.4** job, which
also fails if any test was skipped. Mock-only unit tests are not database
evidence; cover database behavior here.

Add a live test for any change to SQL generation, row mapping, transactions or
type codecs. See [Development setup](docs/DEVELOPMENT_SETUP.md).

### Type Checking

```bash
npm run typecheck
```

---

## Code Style

[Biome](https://biomejs.dev) lints and formats the code, configured in `biome.json` (tabs, single quotes, 120 columns) and pinned to an exact version in `package.json`. `npm run lint` runs `biome ci --error-on-warnings .`: it changes nothing and fails on any lint finding, formatting difference or unsorted import, and CI runs it on every code change. `npm run format` (`biome check --write .`) rewrites files to match; run it on purpose, never as a read-only check.

```bash
npm run typecheck
npm test
npm run build
npm run lint
```

---

## Foreign-dialect boundary

drizzle-cubrid is moving from Drizzle's MySQL classes to a CUBRID-native
dialect ([ADR 0003](docs/adr/0003-native-architecture-boundaries.md),
[ADR 0007](docs/adr/0007-drizzle-extension-boundary.md)). CI runs
`scripts/check-dialect-boundary.mjs` on `src` and on the packed npm tarball. It
parses each file with the TypeScript compiler, so comments never count, and
reports:

- a `drizzle-orm/...` import outside ADR 0007's neutral list (for example
  `drizzle-orm/mysql-core` or `drizzle-orm/cache/...`), or a driver package for
  another database
- a foreign dialect's class or builder name (`MySqlDialect`, `mysqlTable`,
  `PgTable`, ...) or backend mode (`'planetscale'`, `dialect: 'mysql'`) in code;
  comments are ignored
- in native code (`src/native/**`), any Drizzle internal access outside
  `src/native/internal.ts` (`Symbol.for('drizzle:…')`, `.shouldDisableInsert`,
  `.decoder` other than `this.decoder`, and any cast through `unknown`), and any
  relative import that leaves `src/native`, since the 0.x modules are built on
  Drizzle's MySQL classes

Native code may have no findings at all. The 0.x code's existing findings are
pinned by file, rule and count in `scripts/dialect-boundary-baseline.json`: a
new or increased finding fails, and so does an entry that no longer occurs, so
the baseline only shrinks as the native replacements land. Run
`npm run check:boundary` locally. When a change removes 0.x findings, refresh
the baseline with
`node scripts/check-dialect-boundary.mjs src --update-baseline` and
`node scripts/check-dialect-boundary.mjs package --pack --update-baseline`
(after `npm run build`), and explain any entry that grows in the PR.

Two limits are deliberate:
- **Counts are per file.** The baseline counts findings per file, not per line, so replacing one 0.x use with another in the same file passes. Findings still cannot move between files or grow.
- **Static strings only.** Module names built at run time (`'drizzle-orm/' + name`) are not recognised; reviewers watch for them.

## Temporary scripts, probes and workflows

One-off compatibility probes, debugging helpers, migration code and workaround
workflows are temporary. Prefer running them ephemerally: keep the script in a
scratch directory or a local branch, and commit only the evidence and the
permanent test it justifies. If a temporary file must be committed, its PR
records:

- **Purpose:** what it checks or works around, with the exact `drizzle-orm`,
  `cubrid-client`, Node and CUBRID versions it applies to.
- **Owner and issue:** the person responsible and the local issue tracking it.
- **Removal event:** the condition that ends it, such as a merged fix, a
  released version or a closed issue, rather than a date alone.
- **Evidence to keep:** the issue comment, live test or CHANGELOG entry that
  must remain after removal. Coverage gates and live CUBRID tests are never
  removed with it.

When the removal event happens, the owner records a retain or remove decision
in the cleanup issue (#172) after checking callers in tests, builds, CI,
published files and docs. No scheduled audit or extra required CI is added for
this.

**Example:** the #189 compatibility probe ran 93 Drizzle operations against a
throwaway CUBRID 11.4 container from scratch scripts that were never
committed. What was kept: the evidence matrix in the #189 issue comments, the
refusals and their unit tests (#218), and the live test that runs the suggested
alternatives in the **Live CUBRID 11.4** job.

## Pull Request Review and Merge Policy

The same contributor process applies to human-written and AI-assisted
changes (OpenCode, Codex, Claude Code, ChatGPT, Copilot, etc.).
Use the repository's GitHub Actions CI checks for authoritative final
validation, with local checks encouraged but not separately required.
Review the implementation, tests, security, compatibility and documentation.
Oracle, Copilot and other AI review output is optional advisory context.
The responsible maintainer makes the final merge decision after required
checks and actionable findings are resolved or documented. Security,
CI permissions and release/publishing changes get independent maintainer
scrutiny. No existing repository CI or release safeguards are waived.

---

## Pull Request Guidelines

### Before Submitting

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/my-feature main
   ```

2. **Write tests** for any new functionality.

3. **Run the test suite locally** (recommended; the final-head GitHub CI is authoritative):
   ```bash
   npm test
   npm run typecheck
   ```

4. **Run lint:** `npm run lint` must pass; use the pinned Biome from `npm ci`, not an unpinned `npx @biomejs/biome` download.

### PR Content

- Keep PRs focused — one feature or fix per PR.
- Write a clear title and description explaining _what_ and _why_.
- Reference any related issues (e.g., `Fixes #42`).
- Update documentation if your change affects the public API.
- Update `CHANGELOG.md` with a summary of your change.

### Review Process

- See [Pull Request Review and Merge Policy](#pull-request-review-and-merge-policy).
- Required CI (type check, build, tests) must pass at the final head.
- Maintain backward compatibility unless explicitly approved.

---

## Issue ownership and coding agents

Before implementation, compare the latest code, all open issues and any PRs
touching the same behavior. New issues start with `status: needs triage`; see
the [triage procedure](AGENTS.md#issue-triage-lifecycle).

An issue is claimed when it has an assignee or a linked open PR. Comment on the
issue before starting so overlapping PRs are avoided. Outside contributors can
work on unclaimed issues without a required AI review or GitHub Assignee
access. Maintainer-operated autonomous agents must have authorization and must
not take over claimed work. Merge readiness follows the
[Pull Request Review and Merge Policy](#pull-request-review-and-merge-policy).

## Reporting Issues

When reporting a bug, please include:

- Node.js version (`node --version`)
- Drizzle ORM version
- CUBRID server version
- drizzle-cubrid version
- Minimal reproduction code
- Full error output

For feature requests, describe the use case and expected behavior.

---

## Questions?

Open a [GitHub Discussion](https://github.com/cubrid-lab/drizzle-cubrid/discussions)
or file an [issue](https://github.com/cubrid-lab/drizzle-cubrid/issues).


## Issue handoff and development progress

Use the issue and PR's actual state as evidence. Classification, authorization,
implementation, review and completion are **different decisions**:

1. **Intake / triage:** A newly filed issue starts with `status: needs triage`.
   Check evidence or reproduction, duplicate open/closed issues and overlapping
   PRs, repository scope, type, priority, size, dependencies, and verifiable
   acceptance criteria. A maintainer removes the intake label only after
   confirming the saved GitHub metadata. Do not infer priority, size, or triage
   completion automatically from the title or an AI suggestion.
2. **Ready:** Triage completion alone does not authorize development. Record
   the Ready decision in the issue only when the intended outcome and non-goals are bounded, blockers
   have been resolved, and any repository-specific product, architecture,
   safety or compatibility decisions have been accepted. Unresolved research
   remains investigation; blocked work records its dependency and next action.
3. **In Progress:** Before maintainer-directed or autonomous implementation,
   identify the actual implementer in the GitHub Assignee field, check whether
   another open PR already owns the change, and link the implementation PR to
   its issue. Human-led outside contributors may propose a change on an
   unclaimed issue without prior assignment or an AI-tool-specific approval;
   coordinate with existing assignees and follow the local contribution rules.
4. **In Review:** A PR is in review only when its scoped change and verification
   evidence are available. Check the required CI on the final PR head, test
   coverage appropriate to the risk, unresolved review findings and any
   repository-specific independent review or live-system validation. A bot
   review or passing CI cannot replace an outstanding product/safety decision.
5. **Done:** Record the actual disposition: a merged and validated change,
   a completed investigation with evidence, or an explained duplicate/not-
   planned closure. Use an issue-closing PR keyword only if merging actually
   satisfies its acceptance criteria. A merged PR is not proof that any
   deferred integration, fault, security or release verification has passed.

**Tracking without boards:** GitHub Issues and pull requests are the only
workflow tracker. The sole lifecycle label is `status: needs triage` for
unreviewed intake. Once triage is completed, remove that label after checking
the actual saved issue metadata; do not create `status: ready`, `status: in
progress`, or other duplicate workflow labels. Record the **Ready** decision,
remaining dependencies, and next action in the issue. For **In Progress**,
identify the actual implementer using Assignees and add a concise start/handoff
comment; link the working PR when it exists. **In Review** is visible from the
linked open, non-draft PR and its actual review/check status. A **Blocked**
issue records the blocker, responsible party, and unblock condition in a
comment. **Done** is the issue's Closed state with the recorded validated
outcome or explained disposition, not merely the existence of a merged PR.
Do not configure or depend on GitHub Projects/boards. Priority measures impact,
and size estimates effort; neither represents work-in-progress.
This guidance introduces no new automated merge gate and does not supersede
this repository's design, testing, security, or release requirements.
