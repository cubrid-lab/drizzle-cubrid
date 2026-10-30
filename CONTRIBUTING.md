# Contributing to drizzle-cubrid

**Issue titles** always start with a lowercase type-only prefix (`feat:`, `bug:`, `docs:`, `test:`, `chore:` or `ci:`) without a module scope; the issue forms prefill one. **PRs and commits** continue to use Conventional Commits and local CI. See the [organization standard](https://github.com/cubrid-lab/.github/blob/main/docs/ISSUE_PR_COMMIT_STANDARD.md) for evidence, triage and verification responsibilities.

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
git clone https://github.com/cubrid-labs/cubrid-client.git
git clone https://github.com/cubrid-labs/drizzle-cubrid.git
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

### Integration Tests (Requires CUBRID)

```bash
# Start a CUBRID container
docker compose up -d

# Run integration tests
npm run integration

# Stop the container when done
docker compose down
```

### Type Checking

```bash
npm run typecheck
```

---

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

### Rules

- **Indent**: Tabs
- **Line width**: 100 characters
- **Quote style**: Double quotes
- **Semicolons**: Always

### Running Checks

```bash
# Check lint and format
npx biome check src/ tests/

# Auto-fix
npx biome check --write src/ tests/
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

Open a [GitHub Discussion](https://github.com/cubrid-labs/drizzle-cubrid/discussions)
or file an [issue](https://github.com/cubrid-labs/drizzle-cubrid/issues).
