<!-- CUBRID-LAB-ICON:START -->
<p align="center">
  <a href="https://github.com/cubrid-lab/brand"><img src="https://raw.githubusercontent.com/cubrid-lab/brand/e55990a6a0b2c3b0d133985951d41e42b62a8588/dist/icons/drizzle-cubrid.svg" alt="drizzle-cubrid icon (CUBRID Lab brand repository)" width="120"></a>
</p>
<!-- CUBRID-LAB-ICON:END -->

# drizzle-cubrid

**CUBRID 데이터베이스를 위한 Drizzle ORM 다이얼렉트**

[🇰🇷 한국어](README.ko.md) · [🇺🇸 English](../README.md)

[![npm](https://img.shields.io/npm/v/drizzle-cubrid.svg)](https://www.npmjs.com/package/drizzle-cubrid)
[![CI](https://github.com/cubrid-lab/drizzle-cubrid/actions/workflows/ci.yml/badge.svg)](https://github.com/cubrid-lab/drizzle-cubrid/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-blue.svg)](https://nodejs.org/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.44.1–0.45-green.svg)](https://orm.drizzle.team/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

> **커뮤니티 어댑터:** `drizzle-cubrid`는 CUBRID Lab이 독립적으로 유지보수하는 어댑터이며, 공식 `drizzle-orm` 다이얼렉트나 Drizzle Kit 내장 통합이 아닙니다. Drizzle Kit은 어떤 다이얼렉트로도 지원하지 않으며, Drizzle Kit의 MySQL 다이얼렉트가 CUBRID와 호환된다고 가정하지 마세요. CUBRID 전용 마이그레이터가 CUBRID SQL 파일을 순서대로 적용합니다 ([스키마 마이그레이션](MIGRATIONS.md), [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)).

> **0.3부터 루트 엔트리가 바뀝니다.** `drizzle-cubrid`는 이제 CUBRID 네이티브 다이얼렉트입니다(0.2까지의 `drizzle-cubrid/native` 미리보기이며, 이 경로도 별칭으로 계속 동작합니다). Drizzle의 MySQL 클래스를 기반으로 한 0.x API는 **`drizzle-cubrid/legacy`** 로 옮겨졌습니다. 이 API는 더 이상 권장되지 않으며(deprecated), 처음 불러올 때 `DRIZZLE_CUBRID_LEGACY` 코드의 DeprecationWarning을 한 번 출력하고, 1.0에서 제거됩니다. [0.x에서 마이그레이션하기](MIGRATING_FROM_0X.md)(영문)와 [ADR 0010](adr/0010-promote-native-root-deprecate-0x.md)을 참고하세요.

## 왜 drizzle-cubrid인가?

CUBRID는 한국 공공기관 및 기업 환경에서 널리 사용되는 고성능 오픈소스 관계형
데이터베이스입니다. **drizzle-cubrid**는 다른 데이터베이스의 다이얼렉트를 빌려
쓰지 않고 CUBRID를 위해 작성한 Drizzle ORM 다이얼렉트입니다
([ADR 0003](adr/0003-native-architecture-boundaries.md), [ADR 0007](adr/0007-drizzle-extension-boundary.md)):

- **완전한 타입 안전성**을 갖춘 TypeScript 우선 Drizzle ORM 다이얼렉트
- 커버리지 95% 기준의 오프라인 단위 테스트와, CI에서 코드 변경마다 실행되는 CUBRID 11.4 실서버 테스트 및 패키징된 tarball 실서버 테스트
- [`cubrid-client`](https://github.com/cubrid-lab/cubrid-client) 기반 — 모던 TypeScript CUBRID 드라이버
- 코덱을 갖춘 CUBRID 타입: `SET`, `MULTISET`, `SEQUENCE`, `MONETARY`, 정확한 문자열 `NUMERIC`, `bigint` `BIGINT`, `Buffer` `BIT`
- 세이브포인트를 활용한 트랜잭션, `with`를 지원하는 관계형 쿼리, `prepare()`, 스트리밍(`iterator()`)
- 1.0 이전 API이므로 마이너 릴리스에서 마이그레이션 안내와 함께 바뀔 수 있습니다 ([ADR 0001](adr/0001-release-governance.md)).

## 요구 사항

- Node.js 18+
- CUBRID 11.4 (CI에서 테스트하는 버전이며, 다른 서버 버전은 검증되지 않았습니다)
- `drizzle-orm` `>=0.44.1 <0.46.0`
- [cubrid-client](https://github.com/cubrid-lab/cubrid-client) `>=1.4.0 <2.0.0`
- 검증 범위는 [peer dependency compatibility](COMPATIBILITY.md)를 참고하세요.

## 설치

```bash
npm install drizzle-cubrid drizzle-orm cubrid-client
```

### 엔트리 포인트

| import | 내용 |
| --- | --- |
| `drizzle-cubrid` | CUBRID 네이티브 다이얼렉트: 테이블, 컬럼 빌더, `drizzle()`, Drizzle 연산자(`eq`, `and`, `sql` 등) |
| `drizzle-cubrid/migrator` | CUBRID SQL 마이그레이션용 `migrate()`, `readMigrationFiles()` ([MIGRATIONS.md](MIGRATIONS.md)) |
| `drizzle-cubrid/native`, `drizzle-cubrid/native/migrator` | 위 두 엔트리의 별칭(1.x 동안 유지). 같은 모듈이므로 클래스도 같습니다 |
| `drizzle-cubrid/legacy` | **Deprecated** 0.x API(MySQL 기반), 1.0에서 제거 ([마이그레이션 가이드](MIGRATING_FROM_0X.md)) |

## 빠른 시작

### 스키마 정의

```typescript
import { cubridTable, integer, varchar } from 'drizzle-cubrid';

export const users = cubridTable('users', {
  id: integer().primaryKey().autoIncrement(),
  name: varchar({ length: 100 }).notNull(),
  email: varchar({ length: 200 }).unique(),
});
```

이름 없이 호출한 빌더는 테이블의 키를 컬럼 이름으로 씁니다. 첫 마이그레이션은
`generateInitialMigration(schema)`로 생성하고 `drizzle-cubrid/migrator`의
`migrate()`로 적용합니다 ([MIGRATIONS.md](MIGRATIONS.md)).

### 쿼리

```typescript
import { createClient } from 'cubrid-client';
import { drizzle, eq } from 'drizzle-cubrid';
import { users } from './schema';

const client = createClient({
  host: 'localhost',
  port: 33000,
  database: 'demodb',
  user: 'dba',
  // 날짜·시간 컬럼을 읽으려면 필요합니다 (영문 README의 "Date and time columns" 참고).
  timezone: 'utc',
});

const db = drizzle(client);

// 삽입 (생성된 키 반환)
const [{ id }] = await db.insert(users).values({ name: 'Alice', email: 'alice@example.com' }).$returningId();

// 조회
const allUsers = await db.select().from(users);

// 조건 조회
const alice = await db.select().from(users).where(eq(users.name, 'Alice'));

// 수정
await db.update(users).set({ name: 'Bob' }).where(eq(users.id, id));

// 삭제
await db.delete(users).where(eq(users.id, id));
```

## CUBRID 고유 타입

```typescript
import { cubridTable, integer, monetary, multiset, sequence, set, varchar } from 'drizzle-cubrid';

export const products = cubridTable('products', {
  id: integer().primaryKey().autoIncrement(),
  name: varchar({ length: 100 }),
  tags: set({ element: varchar({ length: 50 }) }),
  categories: multiset({ element: varchar({ length: 50 }) }),
  rankings: sequence({ element: integer() }),
  price: monetary(),
});
```

## 트랜잭션

```typescript
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice', email: 'alice@example.com' });
  await tx.insert(users).values({ name: 'Bob', email: 'bob@example.com' });
});
```

## 제한 사항

- `INSERT ... RETURNING`은 지원하지 않습니다. `$returningId()`나 `lastInsertId`를 사용하세요.
- 스트리밍은 `select()`와 집합 연산에서만 가능하며, `db.transaction()` 안이나 관계형 쿼리에서는 거부됩니다.
- 스키마 비교(diff), `ALTER` 생성, 카탈로그 리플렉션, Drizzle Kit은 지원하지 않습니다 ([MIGRATIONS.md](MIGRATIONS.md), [#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)).
- JSON, BLOB, CLOB, ENUM 컬럼 빌더는 제공하지 않습니다.
- 자세한 내용은 영문 [README](../README.md#cubrid-limitations)와 [NATIVE_API.md](NATIVE_API.md)를 참고하세요.

## 에코시스템

| 계층 | 패키지 | 설명 |
|------|---------|------|
| 드라이버 | [cubrid-client](https://github.com/cubrid-lab/cubrid-client) | TypeScript CUBRID 드라이버 |
| ORM 다이얼렉트 | [drizzle-cubrid](https://github.com/cubrid-lab/drizzle-cubrid) | Drizzle ORM 다이얼렉트 (이 패키지) |
| Python 드라이버 | [pycubrid](https://github.com/cubrid-lab/pycubrid) | 순수 Python CUBRID 드라이버 |
| Python ORM | [sqlalchemy-cubrid](https://github.com/cubrid-lab/sqlalchemy-cubrid) | SQLAlchemy 2.0 다이얼렉트 |

## 기여

기여를 환영합니다! 이슈를 열거나 풀 리퀘스트를 제출해 주세요.

## 라이선스

MIT — [LICENSE](../LICENSE) 참조.
