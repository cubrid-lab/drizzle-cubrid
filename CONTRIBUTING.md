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
- A disposable CUBRID server will be needed for future live integration tests, but no root Docker Compose or runnable integration test file is currently checked in.
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

### Real CUBRID integration (not set up yet)

**Do not execute the old Docker instructions as proof of a test**: this repository has no checked-in root Docker Compose file, and `npm run integration` references `tests/integration.test.ts`, which is not present on the inspected main branch. Building a real-CUBRID harness with nonzero SQL assertions is tracked in [#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164). The actual driver and Drizzle ORM version matrix must be tested separately. See [Development setup](docs/DEVELOPMENT_SETUP.md).

### Type Checking

```bash
npm run typecheck
```

---

## Code Style

The manifest currently uses ESLint (`npm run lint`, `npm run format`), **not Biome**. The inspected main branch does not include an ESLint flat configuration, so lint setup is an **open blocker**; report its actual failure rather than calling it passed. Formatting (`npm run format`) mutates files and should be an intentional action, never a read-only setup check. Follow `.editorconfig` and the [development setup guide](docs/DEVELOPMENT_SETUP.md) while the lint configuration is designed.

```bash
npm run typecheck
npm test
npm run build
# npm run lint  # run after a reviewed ESLint config has been added
```

---

## Pull Request Review and Merge Policy

The same contributor process applies to human-written and AI-assisted
changes (OpenCode, Codex, Claude Code, ChatGPT, Copilot, etc.).
Use the repository's GitHub Actions CI checks for authoritative final
validation, with local checks encouraged but not separately required.
Review the implementation, tests, security, compatibility and documentation.
Oracle, Copilot and `agent-review` output is optional advisory context.
The responsible maintainer makes the final merge decision after required
checks and actionable findings are resolved or documented. Security,
CI permissions and release/publishing changes get independent maintainer
scrutiny. No existing repository CI or release safeguards are waived.

## Pull Request Guidelines

### Before Submitting

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/my-feature main
   ```

2. **Write tests** for any new functionality.

3. **Run the full test suite** and ensure all tests pass:
   ```bash
   npm test
   npm run typecheck
   ```

4. **Track lint setup explicitly:** `npm run lint` is declared but the inspected branch lacks a compatible ESLint flat config. Do not substitute an unpinned `npx biome` download or report a lint pass until the tooling issue is resolved.

### PR Content

- Keep PRs focused — one feature or fix per PR.
- Write a clear title and description explaining _what_ and _why_.
- Reference any related issues (e.g., `Fixes #42`).
- Update documentation if your change affects the public API.
- Update `CHANGELOG.md` with a summary of your change.

### Review Process

- All PRs require at least one review before merge.
- CI must pass (lint, type check, tests).
- Maintain backward compatibility unless explicitly approved.

---

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
or file an [issue](https://github.com/cubrid-labs/drizzle-cubrid/issues).
