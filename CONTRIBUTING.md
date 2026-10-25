# Contributing to drizzle-cubrid

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style](#code-style)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Issues](#reporting-issues)

---

## Development Setup

### Prerequisites

- Node.js 18 or later
- Git
- Docker (for integration tests)

### Installation

```bash
# Clone the repository (and cubrid-client for local dependency)
git clone https://github.com/cubrid-lab/cubrid-client.git
git clone https://github.com/cubrid-lab/drizzle-cubrid.git
cd drizzle-cubrid

# Install dependencies
npm install

# Build
npm run build
```

---

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

### Integration Tests (Requires an external CUBRID)

The repository currently has **no `docker-compose.yml`**. Provision an
isolated CUBRID database separately and configure the integration tests for
its actual endpoint, then run:

```bash
npm run integration
```

Do not claim live verification from `npm test` or a CI run without a database.
The current Node 18/Vitest CI compatibility problem is tracked in issue #100;
do not weaken the test gate to make a documentation PR pass.

### Type Checking

```bash
npm run typecheck
```

---

## Code Style

The current `package.json` defines `npm run lint` and `npm run format` using ESLint, not Biome. Check the actual installed tooling and report any unavailable lint check rather than claiming it ran.

### Rules

- **Indent**: Tabs
- **Line width**: 100 characters
- **Quote style**: Double quotes
- **Semicolons**: Always

### Running Checks

```bash
# Check lint and format
npm run lint

# Auto-fix
npm run format
```

---

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

4. **Run lint checks**:
   ```bash
   npx biome check src/ tests/
   ```

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

## Issue ownership and coding agents

Before implementation, compare the latest code, all open issues and any PRs
touching the same behavior. New issues begin with `status: needs triage`;
maintainers verify evidence, duplicates, scope, issue type and relative
urgency before confirming one `priority: critical/high/medium/low` and one
`size: XS/S/M/L/XL`. Read back the saved labels before clearing triage.

Outside contributors can work on unclaimed issues without a required Oracle
review or GitHub Assignee access. Maintainer-operated autonomous agents must
have authorization and a confirmed implementer for reserved work. Required
GitHub CI on the final PR head and project maintainers decide merge readiness.
The tool-neutral review change is already tracked by PR #131; the existing
issue-intake change is PR #134, not a reason to duplicate either workflow.

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
