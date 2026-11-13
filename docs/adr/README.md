# Architecture Decision Records (ADRs)

ADRs preserve **why** a consequential technical or release decision was made, the realistic alternatives, the consequences, and the evidence required to confirm it. A design guide explains *how to implement* a choice; an ADR explains *why that choice was selected*. ADRs do not replace the implementation, tests, CI or the authoritative published package contract.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-release-governance.md) | Release, SemVer and compatibility governance | Accepted (2026-11-13, #225) |
| [0002](0002-database-correctness-evidence.md) | CUBRID correctness and failure-evidence requirements | Proposed |
| [0003](0003-native-architecture-boundaries.md) | Native CUBRID architecture boundaries | Accepted (2026-11-13, #225) |
| [0004](0004-test-first-development.md) | TDD: design contract, Red–Green–Refactor and live-CUBRID verification | Proposed |
| [0005](0005-development-setup.md) | Reproducible language-native developer setup and verification | Proposed |
| [0006](0006-node-18-support-through-1x.md) | Retain Node.js 18 consumer support throughout 1.x; consider removal no earlier than 2.0 | Proposed |
| [0007](0007-drizzle-extension-boundary.md) | Build the native dialect on Drizzle's database-neutral modules | Accepted (2026-11-14, #227) |

The CUBRID-native architecture ADR 0003 was merged as Proposed in #166, together with [the architecture plan](../CUBRID_NATIVE_ARCHITECTURE.md) and [design sign-off checklist](../DESIGN_SIGNOFF.md), and accepted after ADR 0001 in #225. Acceptance approves the direction; it does not sign off the design checklist or claim any implementation exists.

## ADR lifecycle

- **Proposed:** a design decision under review. No project-wide requirement is claimed accepted merely because this file was committed to a PR.
- **Accepted:** a maintainer explicitly approves the decision in a reviewed PR, with required final-head checks. Record the acceptance PR/date by editing status and the decision record, not by guessing the reviewer.
- **Superseded:** a new numbered ADR accepts a different decision and links back to this one. Keep historic records; do not silently rewrite the reasoning to match a later implementation.
- **Rejected:** retained for traceability when the chosen alternative is not adopted.

Start from the [ADR template](TEMPLATE.md). Create a monotonically numbered `NNNN-plain-language-topic.md` file for a **material choice** (release contract, compatibility boundary, storage/transaction model, migration policy). Do not write one for every trivial code refactor or test case. Required headings: **Status, Context, Decision, Alternatives considered, Consequences and trade-offs, Verification / acceptance criteria, References**. Explain observable impact rather than using opaque tracking identifiers as the title. Link specific source code, tests, ADRs or issues.

Release policy must be reviewed **before** progressing the separate architecture proposal to acceptance. Code-level regressions remain tracked in the existing issue backlog, and real CUBRID tests remain mandatory where the release makes database-behavior claims.

Release policy: [#168](https://github.com/cubrid-lab/drizzle-cubrid/pull/168). Acceptance of ADR 0001 and 0003: #225.
