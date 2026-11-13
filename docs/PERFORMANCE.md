# Performance Guide

This document explains expected performance behavior for `drizzle-cubrid` and tuning patterns.

## Overview

`drizzle-cubrid` is a Drizzle ORM dialect layer on top of `cubrid-client`.

```mermaid
flowchart LR
    App[TypeScript Application] --> Drizzle[Drizzle ORM Query Builder]
    Drizzle --> Dialect[drizzle-cubrid Dialect]
    Dialect --> Driver[cubrid-client]
    Driver --> CAS[CAS Binary Protocol]
    CAS --> Server[(CUBRID Server)]
```

```mermaid
flowchart TD
    DSL[Drizzle query DSL] --> SQL[SQL generation]
    SQL --> Params[Parameter serialization]
    Params --> Execute[Driver execute]
    Execute --> Parse[Row parsing]
    Parse --> Map[Typed result mapping]
```

## Benchmark Results

Source: [cubrid-benchmark](https://github.com/cubrid-lab/cubrid-benchmark)

Environment: Intel Core i5-9400F @ 2.90GHz, 6 cores, Linux x86_64, Docker containers.

Driver baseline workload: TypeScript `cubrid-client` vs `mysql2`, 100 rows x 3 rounds.

| Scenario | CUBRID (cubrid-client baseline) | MySQL (mysql2) | Ratio (CUBRID/MySQL) |
|---|---:|---:|---:|
| insert_sequential | 6.18s | 14.85s | 0.4x |
| select_by_pk | 6.57s | 13.89s | 0.5x |
| select_full_scan | 5.60s | 14.71s | 0.4x |
| update_indexed | 6.32s | 14.87s | 0.4x |

Note: Drizzle adds query builder and mapping overhead on top of the driver baseline.

## Performance Characteristics

The overhead of `drizzle-cubrid` on top of `cubrid-client` has not been
measured; the numbers above are for the driver alone.

- Query builder composition adds work compared to direct driver calls.
- With the default typed binding, each statement prepares and releases a
  server statement, so it takes more round trips than `binding: "literal"`
  ([how values reach the server](QUERIES.md#how-values-reach-the-server)).
- `.prepare()` reuses the built SQL on the Drizzle side only; it does not keep
  a server-side prepared statement.

## Optimization Tips

- Build high-volume queries once with `.prepare()` to skip repeated query building.
- Use batched inserts/updates for write-heavy workloads.
- Avoid unnecessary joins/select columns in latency-sensitive endpoints.
- Profile generated SQL and verify index usage in CUBRID plans.

```mermaid
flowchart TD
    Start[Optimize Drizzle path] --> Hot{Hot endpoint?}
    Hot -->|Yes| Prepared[Use prepared reusable queries]
    Hot -->|No| Continue[Keep standard query builder flow]
    Prepared --> Batch{Write-heavy?}
    Batch -->|Yes| Bulk[Batch writes]
    Batch -->|No| Plan[Inspect query plans]
    Continue --> Plan
```

## Running Benchmarks

1. Clone `https://github.com/cubrid-lab/cubrid-benchmark`.
2. Start benchmark Docker services for CUBRID and MySQL.
3. Run the TypeScript driver baseline suite (`cubrid-client` vs `mysql2`).
4. Add Drizzle ORM scenarios using the same dataset shape for fair comparison.
5. Compare driver-only and ORM-layer timings to quantify abstraction overhead.

Use benchmark repo docs/scripts for the exact command matrix.
