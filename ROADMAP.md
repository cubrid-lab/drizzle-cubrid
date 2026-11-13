# Roadmap

> **Last updated**: 2026-11-13
>
> This roadmap reflects current priorities.

## Links

- 📋 [GitHub Milestones](https://github.com/cubrid-lab/drizzle-cubrid/milestones)

## Next Release — v1.0.0 — Stable Release

- API freeze and stability guarantees
- CUBRID-native dialect replacing the MySQL-derived classes ([#155](https://github.com/cubrid-lab/drizzle-cubrid/issues/155))
- CUBRID-native schema migrations; none exist today and Drizzle Kit's MySQL mode is not a supported path ([#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163))
- Relational queries with `with` ([#158](https://github.com/cubrid-lab/drizzle-cubrid/issues/158)) and streaming ([#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)), both unsupported today
- Live tests on every supported CUBRID server version; only 11.4 is tested now ([#164](https://github.com/cubrid-lab/drizzle-cubrid/issues/164))

These are plans, not shipped features; see the
[PRD](docs/PRD.md#planned-native-architecture-not-implemented).

## Compatibility

Node.js 18+ (`engines.node` `>=18.0.0`), `drizzle-orm` `>=0.44.1 <0.46.0`, `cubrid-client` `>=1.4.0 <2.0.0`. See [peer dependency compatibility](docs/COMPATIBILITY.md) for what is verified. Real CUBRID server coverage is tracked in #164.
