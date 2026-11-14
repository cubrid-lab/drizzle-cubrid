# Peer dependency compatibility

`drizzle-cubrid` declares these peer ranges in `package.json`:

| Peer | Declared range | Why this floor | Why this ceiling |
| --- | --- | --- | --- |
| `drizzle-orm` | `>=0.44.1 <0.46.0` | 0.44.0 and older fail to type-check (below) | 0.46 and the 1.0 release candidates are untested |
| `cubrid-client` | `>=1.4.0 <2.0.0` | the only version verified against a real CUBRID server (#185); `isolationLevel` also needs 1.3.0 or later | a 2.x driver may change its API |

A version outside these ranges is **unsupported**, even if it happens to install.
A version inside them is **verified** only where the tables below say so.

## drizzle-orm

Measured on 2026-11-13 (Node 24, tsup 9): install the version with
`npm install --no-save drizzle-orm@<version>`, then run `npx tsc --noEmit` and
`npx vitest run`. The first sweep (0.38.0 to 0.45.4) ran on the code before
#185; the rows marked † were rerun on the current code.

| Version | Type check | Unit tests | Status |
| --- | --- | --- | --- |
| 0.38.0, 0.39.0, 0.40.0, 0.41.0, 0.42.0 | fail: `drizzle-orm/cache/core/cache` does not exist; `MySqlPreparedQuery` takes no constructor arguments | 72 passed | unsupported |
| 0.43.1 † | fail, as above | 94 passed | unsupported |
| 0.44.0 † | fail: `MySqlPreparedQuery` requires a `Cache` argument | 94 passed | unsupported |
| 0.44.1 †, 0.44.3 † | pass | 94 passed | verified (0.44.1 is the floor checked in CI) |
| 0.44.2, 0.44.4 – 0.44.7, 0.45.0 | pass | 72 passed | verified |
| 0.45.4 † | pass | 94 passed | verified (lockfile version, CI and Node 18 consumer) |

The type check is the deciding column. The unit tests mock parts of
`drizzle-orm`, so they pass on versions the code cannot be compiled against,
and tsup 9 emits the bundle and declarations even when `tsc` reports errors.

CI checks both ends of the range on every code change:

- `lint-and-test` and the Node 18 packed-package consumer use the lockfile
  version (newest supported).
- `Lowest supported drizzle-orm` installs the floor taken from
  `peerDependencies` and runs the type check, build and tests.

### drizzle-orm internals this package depends on

The adapter extends Drizzle's MySQL classes, so it imports modules that are not
part of Drizzle's documented public API. These can change in any minor
release, which is why the ceiling is the next minor version:

- `drizzle-orm/mysql-core/session`: `MySqlSession`, `MySqlPreparedQuery`,
  `MySqlTransaction` (subclassed)
- `drizzle-orm/mysql-core/db`, `drizzle-orm/mysql-core/dialect`:
  `MySqlDatabase`, `MySqlDialect`
- `drizzle-orm/cache/core/cache`, `drizzle-orm/cache/core/types`: cache types
  passed to `MySqlPreparedQuery`
- `drizzle-orm/utils`: `mapResultRow`, which is not in the package's type
  declarations and is read through a cast

Replacing these with a native CUBRID dialect is tracked in #155. The
experimental `drizzle-cubrid/native` entry ([NATIVE_API.md](NATIVE_API.md))
imports only Drizzle's database-neutral modules (`column`, `column-builder`,
`entity`, `table`, `utils`) and reaches two internals through
`src/native/internal.ts`: the `Symbol.for('drizzle:Columns')` and
`Symbol.for('drizzle:ExtraConfigColumns')` table keys and
`ColumnBuilder#setName`, both checked on 0.44.1 and 0.45.4 (ADR 0007).

## cubrid-client

Measured the same way with `npm install --no-save cubrid-client@<version>`
(1.1.0 and 1.2.0 on the code before #185, the others on the current code):

| Version | Type check | Unit tests | Real CUBRID 11.4 | Status |
| --- | --- | --- | --- | --- |
| 1.0.0 – 1.2.0 | pass | 94 / 72 passed | not run | unsupported: `transaction()` takes no options; not verified against a server |
| 1.3.0 | pass | 94 passed | not run | unsupported: not verified against a server |
| 1.4.0 | pass | 94 passed | transaction isolation checks from #185 | verified |

Passing unit tests and a clean install are not database compatibility. The
live suite (`npm run integration`, CI job Live CUBRID 11.4) runs with the
lockfile versions; other server versions and peer combinations are tracked in
#164.

## Node.js

`engines.node` is `>=18`. The Node 18 job installs the packed tarball with the
lockfile's peer versions and imports it through CommonJS and ESM; see
[CI validation](CI_VALIDATION.md).
