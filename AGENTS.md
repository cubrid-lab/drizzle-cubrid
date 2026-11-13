# AGENTS.md

## Issue and pull request guidance (drizzle-cubrid)

See [the local contributor guide](CONTRIBUTING.md). Every issue title needs a lowercase type-only prefix (`feat:`, `bug:`, `docs:`, `test:`, `chore:` or `ci:`) without a module scope; issues use `bug:`, not the commit type `fix:`. Issue bodies communicate the clear objective, evidence and verifiable acceptance. Triage checks duplicates, scope, priority and size; PRs/commits retain existing Conventional Commits rules, CI and actual validation evidence. Avoid personal comments and agent bookkeeping in issue text.

Project knowledge base for AI coding agents.

## Project Overview

**drizzle-cubrid** is a Drizzle ORM dialect for the CUBRID relational database.
It extends Drizzle's `mysql-core` infrastructure to provide type-safe schema definitions,
query building, and migration support for CUBRID via the `cubrid-client` TypeScript driver.

- **Language**: TypeScript (ES2022+, strict mode)
- **Framework**: Drizzle ORM (mysql-core)
- **License**: MIT
- **Version**: 0.1.0

## Architecture

```mermaid
flowchart TD
    A[drizzle-cubrid/] --> B[src/]
    B --> B1[index.ts - Public API exports]
    B --> B2[driver.ts - Driver and drizzle factory]
    B --> B3[session.ts - Session, prepared query, transaction]
    B --> B4[columns.ts - mysql-core re-exports plus CUBRID columns]
    B --> B5[table.ts - cubridTable schema builder]
    B --> B6[types.ts - SET, MULTISET, SEQUENCE, MONETARY]
    A --> C[tests/]
    C --> C1[session.test.ts - Session and transaction tests]
    C --> C2[driver.test.ts - drizzle factory tests]
    C --> C3[columns.test.ts - Column compilation tests]
    C --> C4[types.test.ts - Custom type tests]
    C --> C5[query.test.ts - Query builder integration tests]
    C --> C6[integration.test.ts - Live DB tests]
    A --> D[docs/]
    D --> D1[PRD.md - Product requirements]
    A --> E[package.json]
    A --> F[tsconfig.json]
    A --> G[tsup.config.ts]
    A --> H[vitest.config.ts]
    A --> I[README.md]
```

### Module Responsibilities

| Module | Role |
|---|---|
| `driver.ts` | `CubridDriver` class creates sessions. `CubridDatabase` extends `MySqlDatabase`. `drizzle()` factory function creates database instance from `CubridClient`. |
| `session.ts` | `CubridSession` extends `MySqlSession` — bridges `cubrid-client` into Drizzle's query system. `CubridPreparedQuery` extends `MySqlPreparedQuery` — executes SQL via `client.query()`. `CubridTransaction` extends `MySqlTransaction` — transaction lifecycle. |
| `columns.ts` | Re-exports all mysql-core column types + defines CUBRID-specific columns (SET, MULTISET, SEQUENCE, MONETARY). |
| `table.ts` | `cubridTable()` — table schema builder function (wraps `mysqlTable` with CUBRID defaults). |
| `types.ts` | Custom Drizzle column types for CUBRID: `CubridSet`, `CubridMultiset`, `CubridSequence`, `CubridMonetary`. |
| `index.ts` | Public API surface — re-exports everything users need. |

### Drizzle Extension Pattern

drizzle-cubrid follows the same pattern as `drizzle-orm/mysql2` and `drizzle-orm/mysql-proxy`:

```mermaid
flowchart TD
    A[MySqlDialect from mysql-core<br/>SQL generation reused as-is] --> B[MySqlSession abstract<br/>Session interface]
    B --> C[CubridSession implementation<br/>Bridges cubrid-client]
    C --> D[CubridPreparedQuery implementation<br/>Executes via client.query()]
    D --> E[CubridTransaction implementation<br/>Transaction lifecycle]
    E --> F[CubridDatabase extends MySqlDatabase<br/>User-facing database instance]
    F --> G[drizzle(client) factory<br/>Entry point]
```

### cubrid-client API (Driver We Wrap)

```typescript
// Key interfaces from cubrid-client
interface CubridClient {
  query<T>(sql: string, params?: QueryParams): Promise<T[]>;
  transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TransactionClient {
  query<T>(sql: string, params?: QueryParams): Promise<T[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

type QueryParam = string | number | boolean | bigint | Date | Buffer | null;
type QueryParams = readonly QueryParam[];
type QueryResultRow = Record<string, unknown>;
```

## Development

### Setup

```bash
git clone https://github.com/cubrid-lab/drizzle-cubrid.git
cd drizzle-cubrid
npm install
```

### Key Commands

```bash
npm test              # Unit tests with vitest
npm run test:cov      # Tests with coverage (95% threshold)
npm run build         # Build ESM + CJS via tsup
npm run lint          # Biome lint + format check, no changes (CI)
npm run format        # Biome: rewrite formatting and safe fixes
npm run typecheck     # tsc --noEmit
npm run integration   # Live CUBRID tests; needs CUBRID_TEST_HOST (see below)
```

### Real CUBRID integration tests

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

## Code Conventions

### Style

- **Linter and formatter**: Biome (`biome.json`, pinned version); tabs, single quotes
- **Line length**: 120 characters
- **Target**: ES2022, Node.js 18+
- **Imports**: ESM-first (`import/export`)
- **Type hints**: Full TypeScript strict mode, no `any` escapes
- **Class inheritance**: Use TypeScript/JavaScript `super()` syntax and the actual Drizzle extension interface.

### Naming

- Classes: `CubridSession`, `CubridPreparedQuery`, `CubridTransaction`, `CubridDatabase`
- Test files: `tests/*.test.ts`
- Test descriptions: `describe('CubridSession', () => { it('should execute query', ...) })`

### Patterns to Follow

- All Drizzle entity classes must have `static readonly [entityKind]: string = 'ClassName'`
- **Current implementation only:** `src/session.ts` subclasses MySQL session types; this is transitional and **not** the target CUBRID API contract. The proposed native dialect follows verified Drizzle extension points and real CUBRID SQL behavior.
- **Current implementation only:** prepared queries use MySQL-derived types. Do not treat them as native CUBRID semantics; verify independent prepared-binding behavior before replacing these adapters.
- Use `fillPlaceholders()` from `drizzle-orm/sql` for parameter mapping
- Use `mapResultRow()` only where the current row/field shape is proven compatible; native CUBRID duplicate-column and value mapping require separate verification.
- HKT types: `CubridQueryResultHKT`, `CubridPreparedQueryHKT` — required for type inference

### Anti-Patterns (Never Do)

- No `as any` — no type assertions to `any`
- No `@ts-ignore` or `@ts-expect-error`
- No raw SQL string interpolation (always parameterized)
- No empty `catch` blocks
- No `console.log` in production code (use Drizzle's Logger interface)




## Node.js 18 compatibility throughout stable 1.x

The eventual `drizzle-cubrid@1.0.0` and **every 1.x release** must retain `engines.node >=18`, coordinated with the independent Node 18 guarantee of `cubrid-client@1.x`. [ADR 0006](docs/adr/0006-node-18-support-through-1x.md) is the source for this compatibility decision. Build, lint and test on modern Node where toolchain dependencies require it, but run **Node 18 smoke tests of packed ESM/CJS artifacts with verified peer versions**. The minimum Node floor may be reconsidered **no earlier than a reviewed 2.0 MAJOR**. Do not implement #100 by raising `engines.node` in 1.x or by skipping the Node 18 consumer lane.

## Development setup before design and TDD implementation

Use the repository-specific [development setup guide](docs/DEVELOPMENT_SETUP.md) and [setup ADR 0005](docs/adr/0005-development-setup.md) (**Proposed**) before changing this repository's public behavior or tooling. Verify the **actual** manifest, supported developer toolchain, dependency resolution, read-only offline checks, and availability/absence of real CUBRID integration separately. Do not invent a nonexistent integration harness, lint command, published package, or dependency path. A successful unit build is not a successful real-database test or a published package. Record observed setup blockers as issues; do not silently change the project's public compatibility contract, weaken CI, or modify release credentials to make onboarding appear green.

## Test-first implementation after architecture review

Before implementing a CUBRID behavior change, check the approved API/SQL/protocol contract and [TDD ADR 0004](docs/adr/0004-test-first-development.md) (**currently Proposed**). Follow **Red → Green → Refactor** in focused slices: execute a deterministic failure for the intended reason first, implement the smallest fix, rerun the case and relevant regressions, then refactor. Explain the initial failure and actual checks in the PR without inventing command output. A final PR must pass its required CI; never keep a deliberately failing regression as proof of Red. Confirm database-dependent behavior through real CUBRID tests and the release candidate matrix; mocks alone cannot certify it. Upstream feasibility prototypes and docs-only changes are exempt from ritual Red steps but must show their own accurate evidence. Release policy and architecture decisions must be approved before classifying design as completed.

## Architecture decisions and release order

Read the [repository ADR index](docs/adr/README.md) before proposing changes to public behavior, release contracts, this repository's architecture, transaction ownership or public API. ADR 0001 (release governance), architecture ADR 0003 (native CUBRID boundaries) and ADR 0007 (native dialect on Drizzle's database-neutral modules) are **Accepted**; ADR 0002, 0004, 0005 and 0006 remain **Proposed**. Do not treat a Proposed ADR as approved, and do not treat an Accepted ADR as proof that its acceptance criteria are met; require actual tested evidence before claiming implementation or release readiness. Use the [ADR template](docs/adr/TEMPLATE.md) for material new decisions, not for every trivial change.

## CUBRID correctness lessons and native regression review

Before changing Drizzle query/schema generation, type codecs, transaction/result mapping, npm peer compatibility or releases, review [the repository-specific engineering invariants](docs/ENGINEERING_INVARIANTS.md). These rules are grounded in the TypeScript Drizzle adapter and its own ORM/driver integration contract, and verifiable CUBRID behavior. Distinguish mock tests, live CUBRID execution and independent differential evidence; never claim a check ran without its actual CI result. For an unrelated docs-only change, the checklist is advisory and does not mandate unnecessary database jobs. Existing repository review and merge requirements remain authoritative.

## Development Workflow (drizzle-cubrid)

Apply this repository's own Drizzle/TypeScript/CUBRID contracts. Do not inherit a different repository's architecture or mandate any named AI reviewer.

1. **Scope and design:** Identify this adapter's affected public API, Drizzle extension contract, real CUBRID SQL/driver behavior, compatibility requirements, and any proposed ADR. Mark proposed decisions as proposed.
2. **Test-first implementation:** For behavioral changes, reproduce an observed RED case, make the minimal GREEN change, then refactor and preserve regression tests. Explain why TDD is not applicable for pure docs updates.
3. **Verification and documentation:** Record actually executed typecheck, build, tests/coverage and, where behavior requires, real CUBRID integration and Node 18 packed-consumer evidence. Update only documentation affected by the change and do not claim missing tests passed.
4. **Review and merge:** Address review findings and check final-head CI, repository protections and relevant maintainer review requirements. Independent maintainer review is necessary for high-risk security, release/publishing or protection changes where required. Optional Oracle/Copilot/agent reviews are **advisory**, never substitutes for human judgment or automatic approval.

There are no mandatory AI-specific pre/post review calls. Trivial docs edits do not require invented integration results or unrelated CI jobs.

## Test Structure

```mermaid
flowchart TD
    A[tests/] --> B[session.test.ts - Session and transaction classes]
    A --> C[driver.test.ts - drizzle factory and database]
    A --> D[columns.test.ts - Column definitions and SQL compilation]
    A --> E[types.test.ts - SET, MULTISET, SEQUENCE, MONETARY]
    A --> F[query.test.ts - SELECT, INSERT, UPDATE, DELETE]
    A --> G[table.test.ts - cubridTable builder]
    A --> H[integration.test.ts - Live CUBRID 11.4 tests, npm run integration]
```

### Testing Approach

- **Unit tests** — mock `cubrid-client` with fake implementations
- **Query tests** — use Drizzle's `drizzle.mock()` or equivalent for SQL generation verification
- **Integration tests** — `tests/integration.test.ts`, run by `npm run integration` against a real CUBRID server and in the **Live CUBRID 11.4** CI job; it fails rather than skips without a database.

### Coverage

- Threshold: 95% (CI-enforced)
- Runner: vitest with c8/v8 provider

## CUBRID-Specific Knowledge

### Key Differences from MySQL

- **No RETURNING** — `INSERT/UPDATE/DELETE ... RETURNING` not supported
- **No native BOOLEAN** — mapped to `SMALLINT` (0/1)
- **No JSON type** — no JSON data type or functions
- **No ARRAY** — uses `SET`, `MULTISET`, `SEQUENCE` collection types
- **No Sequences** — uses `AUTO_INCREMENT` only
- **No RELEASE SAVEPOINT** — must skip in nested transactions
- **DDL auto-commits** — `transactional_ddl = false`
- **6 isolation levels** — standard 4 + class-level + instance-level
- **Identifier folding** — lowercase (not uppercase like SQL standard)
- **Max identifier length** — 254 characters
- **Paramstyle** — `?` positional (same as MySQL)

### Connection Format

```
SQLAlchemy URL: cubrid://user:password@host:port/dbname
CUBRID native:  CUBRID:host:port:dbname:::
cubrid-client: createClient({ host, port, database, user, password })
```

## CI/CD

### Workflows

| File | Trigger | Purpose |
|---|---|---|
| `.github/workflows/ci.yml` | Push to main, PRs | Typecheck, build, unit tests with coverage, live CUBRID tests, packed-package checks (no lint step yet, see #167) |
| `.github/workflows/publish.yml` | GitHub Release | Build and publish to npm |

### CI Matrix

- **Unit** (typecheck, build, Vitest coverage): Node.js 20 and 22
- **Lowest supported `drizzle-orm`** (typecheck, build, Vitest): Node.js 22
- **Live CUBRID**: Node.js 22 × CUBRID 11.4 only, with the image pinned by digest
  and the server version checked against `CUBRID_TEST_EXPECT_VERSION`. Other
  server versions are not tested.
- **Packed-package consumer** (CJS and ESM imports of the built tarball): Node.js 18

See `docs/CI_VALIDATION.md` for which jobs run on which changes.

## Commit Convention

Follow this repository's `CONTRIBUTING.md` and existing PR/title conventions.
Describe the actual change in plain English; do not copy tool-specific credits.

```text
docs(agents): clarify contributor validation

Describe what changed and why.

Refs #N
```

Use Conventional Commits types (`feat`, `fix`, `docs`, `chore`, `ci`, `style`,
`test`, `refactor`). Keep authorship and actual coauthors accurate. A human
contributor, Codex, Claude Code, OpenCode or another agent is never required to
append a particular coauthor or AI-tool trailer.

## Release Process

1. Update version in `package.json`
2. Add changelog entry in `CHANGELOG.md`
3. Commit, tag (`v{major}.{minor}.{patch}`), push with tags
4. Create GitHub release via `gh release create`
5. npm publish triggers automatically from the release

## Human-readable communication (all agents)

Use this rule for text authored or edited by Codex, Claude Code, OpenCode,
ChatGPT, Copilot, or any other agent. It applies to issues, PRs, reviews,
comments, checklists, status updates, commit summaries, release notes,
documentation, presentations, and other maintainer-facing writing.

- Write for a reader unfamiliar with the underlying script, storyboard,
  automation run, or agent plan. Name the actual project, component,
  action, evidence, and location in ordinary, clear language.
- Never use unexplained internal identifiers as reader-facing labels or
  checklist instructions (for example, `H1, P1, C1, K1, F2` or `A1/B1/R1/R2`).
  Do not substitute `P1`/`P2` for repository priority labels.
- When an internal identifier is necessary for accurate cross-reference,
  **describe the subject first**, then add the identifier in context:
  `package introduction (0:20; storyboard shot 1)`. Use descriptive
  names and timestamps, section titles, or paths wherever practical.
- Use natural, actionable wording. Prefer `Listen to the full narration and
  verify the pronunciation of each project name` to `Maintainer full listen`.
  Avoid compressed task fragments, unexplained acronyms, and generated
  process/status jargon.
- Keep legitimate technical identifiers unchanged in code, tests, structured
  data, logs, specifications, and exact evidence references. Issue numbers,
  filenames, command names, APIs, error codes, and hashes are not prohibited.
  Do not break machine-readable references to improve prose.
- Before publishing, reread the text as a first-time maintainer. It should
  state what happened or needs to happen, why, and where without requiring a
  separate lookup table. Edit an existing editable comment to correct unclear
  wording rather than adding redundant follow-up comments.

These are local writing expectations, not a new CI check, reviewer approval,
or merge gate. Keep existing repository-specific technical and safety rules.

### Self-explanatory code comments, tests and review text

Source comments, test names and test comments, examples, PR descriptions
and review replies follow the local explanation guidance below:
when a comment is needed, say what the code does, why it matters and which
Drizzle or CUBRID constraint applies (for example, why a result row is
reshaped before Drizzle maps it), then add an issue number only for
traceability. Do not add comments that only restate the code.

Repository-specific rules in this file keep precedence: Drizzle query
semantics, `cubrid-client` compatibility, CI and the release process. The
review workflow itself is maintained in the Development Workflow section
and is not changed here. This rule is a writing convention checked during
normal review by any contributor or tool, not a CI gate or required
reviewer. Do not rename test names, fixtures or other machine-readable
identifiers only to improve prose.

## Repository ownership in issues, PRs, and design documents

This repository owns **the TypeScript Drizzle CUBRID dialect and ORM adapter**. Author issue and PR titles, summaries, ADR context, acceptance criteria, and release decisions from **drizzle-cubrid**'s actual code, public contract and evidence. For changes affecting Drizzle extension APIs, native CUBRID SQL/DDL, typed column mappings, driver result contracts, npm peer ranges, and real CUBRID ORM tests, cite local files/tests, expected behavior and actual verification. Do not use another repository's failures, ADRs, issue tracker or language-specific tooling as a governing authority or as the motivation in a title. Do not copy issue/PR templates from an unrelated package. The cubrid-client npm package is a real dependency; cite its verified public API and tested peer range, not its internal architecture or independent release schedule.

Cross-repository links are appropriate only for a **verified dependency/API compatibility boundary**, independently executed semantic comparison (such as official JDBC), or an explicitly identified coordination requirement. Label such references as context, not as this repository's acceptance proof, and keep tracking and release decisions local. During PR review, check issue title/body, PR title/body, ADRs, AGENTS/CONTRIBUTING, and user-facing release notes for misplaced external project references before merge.

## Issue triage lifecycle

Every new issue in this repository starts with `status: needs triage`.
Issue forms mark it at creation; the `issues: opened` workflow covers other
human submissions. Agents creating issues using `GITHUB_TOKEN` must include
it explicitly because their own events may not retrigger the workflow.

1. Verify observed problem and evidence, unknowns, duplicates and open PRs,
   local ownership/type, scope/non-goals, acceptance and dependencies.
2. Inspect **all currently open issues in this repository** (all pages) and
   compare urgency, effect on users/data, existing priorities, active work and
   unresolved prerequisites rather than issue age.
3. Select exactly one `priority: critical/high/medium/low` and one
   `size: XS/S/M/L/XL` (all defined in `.github/labels.yml`), based on effort; split very large independent work
   while preserving issue ownership and accepted criteria.
4. Re-fetch the saved issue, check type, priority, size and duplicate decision
   against the actual labels, then remove `status: needs triage` only when
   this manual review is complete. Keep it for unresolved questions.

Do not automatically assign a priority or mark triage complete. Existing
code, tests, security and release safeguards are unaffected.
