# Roadmap

> **Last updated**: 2026-11-19
>
> This roadmap reflects current priorities.

## Links

- 📋 [GitHub Milestones](https://github.com/cubrid-lab/drizzle-cubrid/milestones)

## Next Release — v0.3.0 — Native dialect at the root

- `drizzle-cubrid` becomes the CUBRID-native dialect; `drizzle-cubrid/native`
  stays as an alias through 1.x, and `drizzle-cubrid/migrator` joins
  `drizzle-cubrid/native/migrator` ([ADR 0010](docs/adr/0010-promote-native-root-deprecate-0x.md))
- The MySQL-based 0.x API moves to `drizzle-cubrid/legacy`, deprecated with a
  one-time `DRIZZLE_CUBRID_LEGACY` warning ([migration guide](docs/MIGRATING_FROM_0X.md))
- Implemented on `main`, not yet released; the release itself is the
  maintainer's decision under [ADR 0001](docs/adr/0001-release-governance.md)

## Then — v1.0.0 — Stable Release

- API freeze and stability guarantees
- Removal of `drizzle-cubrid/legacy` and every MySQL-derived class, so the
  foreign-dialect baseline is empty ([#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155), [#192](https://github.com/cubrid-lab/drizzle-cubrid/issues/192))
- CUBRID-native schema migrations: the applier of CUBRID SQL files and the
  initial-schema generator exist ([MIGRATIONS.md](docs/MIGRATIONS.md)); schema
  diffing, `ALTER` generation and catalog reflection are not implemented, and
  Drizzle Kit's MySQL mode is not a supported path ([#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163))
- Relational queries with `with` ([#158](https://github.com/cubrid-lab/drizzle-cubrid/issues/158))
  and streaming ([#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165))
  are implemented in the native API; streaming inside `db.transaction()` and
  of relational queries is still refused
- Live tests on every supported CUBRID server version; only 11.4 is tested now ([#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164))
- Design sign-off ([DESIGN_SIGNOFF.md](docs/DESIGN_SIGNOFF.md))

These are plans, not shipped features; see the
[PRD](docs/PRD.md#native-architecture-status).

## Compatibility

Node.js 18+ (`engines.node` `>=18.0.0`), `drizzle-orm` `>=0.44.1 <0.46.0`, `cubrid-client` `>=1.4.0 <2.0.0`. See [peer dependency compatibility](docs/COMPATIBILITY.md) for what is verified. Real CUBRID server coverage is tracked in #164.
