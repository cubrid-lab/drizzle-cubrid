# CI validation lanes

The repository separates developer-tool tests, published-package runtime compatibility, and real CUBRID database validation. This page describes what the current `.github/workflows/ci.yml` **actually checks**, not release capabilities that have not been implemented.

## Pull request checks

| Change type | CI work | What the result demonstrates |
| --- | --- | --- |
| Markdown/documentation-only PR | Diff classification, `git diff --check`, `CI gate` | Text and whitespace validation only; no package or database behavior was exercised |
| Source code, dependency, CI, toolchain or ambiguous PR | Biome lint and format check (`npm run lint`, Node 22, plus a misformatted-file probe that must fail), Node 20 and Node 22 typecheck/build/Vitest coverage, lowest supported `drizzle-orm` typecheck/build/Vitest (Node 22), live CUBRID 11.4 tests (`npm run integration`, no skipped tests allowed), Node 22 npm packaging, Node 18 clean packed-package ESM/CJS consumer, `CI gate` | Runtime and package compatibility with declared locked peers, and the behavior covered by the live CUBRID 11.4 tests |
| Push to `main` | Full runtime and packaging jobs | Ensures main does not rely on a docs-only shortcut |

Independent security workflows are not replaced by the docs-only classifier. A documentation-only PR does not disable any security policy or release preflight.

## Fixed Node.js support contract

`drizzle-cubrid@1.x` must retain the Node 18 minimum throughout the 1.x generation. We use newer Node 20/22 toolchains for Vitest and development dependencies, and a **separate Node 18 job** for the actual packed npm package. A clean Node 18 consumer uses the precise `drizzle-orm` and `cubrid-client` peer versions resolved in the candidate lockfile and checks both CommonJS `require()` and ESM `import()`, including creation of a representative table/collection column. A green Node 22 build alone is **not** Node 18 compatibility evidence.

## Coverage and database proof

The current Vitest configuration enforces **95%** for statements, branches, functions and lines. The threshold is not reduced or marked optional just to make CI pass. The Node 18 consumer job is separate from Vitest coverage.

The live suite (`tests/integration.test.ts`) runs against CUBRID 11.4 only and covers the behavior its test names describe (transactions, joins, write metadata, relational queries without `with`, collections, binding modes, date and time columns, replacements for refused SQL). Unit and packaging jobs are not database evidence, and nothing in CI verifies other server versions, catalog reflection or migrations. The real-database test work is tracked in [issue #164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164), with its own actual versions, SQL assertions and nonzero test counts. The final release candidate must complete that verification before database behavior is advertised as supported.

## Merge discipline

The `CI gate` fails if change classification is broken or if a **selected** job fails, is cancelled, is missing or is skipped. The docs-only route is limited to pull requests whose tracked changes are all documentation paths; changing a workflow, source code, dependency, `.nvmrc` or another unknown path runs the full validation. Real release artifacts, registry publishing and supported database versions require separate verification.
