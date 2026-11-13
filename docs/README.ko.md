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

> **커뮤니티 어댑터:** `drizzle-cubrid`는 CUBRID Lab이 독립적으로 유지보수하는 어댑터이며, 공식 `drizzle-orm` 다이얼렉트나 Drizzle Kit 내장 통합이 아닙니다. CUBRID 전용 스키마 마이그레이션은 설계 중이며, Drizzle Kit의 MySQL 다이얼렉트가 CUBRID와 호환된다고 가정하지 마세요. [마이그레이션 설계](https://github.com/cubrid-lab/drizzle-cubrid/issues/163), [네이티브 다이얼렉트 설계](https://github.com/cubrid-lab/drizzle-cubrid/issues/155) 참고.

## 왜 drizzle-cubrid인가?

CUBRID는 한국 공공기관 및 기업 환경에서 널리 사용되는 고성능 오픈소스 관계형
데이터베이스입니다. 지금까지 CUBRID를 위한 Drizzle ORM 다이얼렉트는
존재하지 않았습니다.

**drizzle-cubrid**가 그 공백을 채웁니다:

- **완전한 타입 안전성**을 갖춘 TypeScript 우선 Drizzle ORM 다이얼렉트
- 커버리지 95% 기준의 오프라인 단위 테스트와, CI에서 코드 변경마다 실행되는 CUBRID 11.4 실서버 테스트
- [`cubrid-client`](https://github.com/cubrid-lab/cubrid-client) 기반 — 모던 TypeScript CUBRID 드라이버
- CUBRID 고유 타입 지원: `SET`, `MULTISET`, `SEQUENCE`, `MONETARY`
- drizzle-orm의 `mysql-core`를 통한 MySQL 호환 SQL 생성
- 세이브포인트를 활용한 트랜잭션 지원

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

## 빠른 시작

### 스키마 정의

```typescript
import { cubridTable, int, varchar } from 'drizzle-cubrid';

export const users = cubridTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 200 }).unique(),
});
```

### 쿼리

```typescript
import { createClient } from 'cubrid-client';
import { drizzle } from 'drizzle-cubrid';
import { eq } from 'drizzle-orm';
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

// 삽입
await db.insert(users).values({ name: 'Alice', email: 'alice@example.com' });

// 조회
const allUsers = await db.select().from(users);

// 조건 조회
const alice = await db.select().from(users).where(eq(users.name, 'Alice'));

// 수정
await db.update(users).set({ name: 'Bob' }).where(eq(users.id, 1));

// 삭제
await db.delete(users).where(eq(users.id, 1));
```

## CUBRID 고유 타입

```typescript
import { cubridTable, int, varchar } from 'drizzle-cubrid';
import { set, multiset, sequence, monetary } from 'drizzle-cubrid';

export const products = cubridTable('products', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 100 }),
  tags: set('tags', { element: varchar('tag', { length: 50 }) }),
  categories: multiset('categories', { element: varchar('category', { length: 50 }) }),
  rankings: sequence<number>('rankings', { element: int('rank') }),
  price: monetary('price'),
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

- `eq`, `and`, `or`, `asc`, `desc`, `sql` 등 일부 연산자만 `drizzle-cubrid`에서 다시 내보냅니다. `relations`, `like`, `inArray` 등 그 밖의 헬퍼는 `drizzle-orm`에서 가져오세요.
- `with`로 관계를 불러오는 관계형 쿼리는 지원하지 않으며 오류를 던집니다 ([#200](https://github.com/cubrid-lab/drizzle-cubrid/issues/200)).
- 스트리밍(`.iterator()`)은 구현되지 않았습니다 ([#165](https://github.com/cubrid-lab/drizzle-cubrid/issues/165)).
- 스키마 마이그레이션과 DDL 생성은 제공하지 않습니다 ([#163](https://github.com/cubrid-lab/drizzle-cubrid/issues/163)).
- JSON, BLOB, CLOB 컬럼 빌더는 제공하지 않습니다.
- 자세한 내용은 영문 [README](../README.md#cubrid-limitations)를 참고하세요.

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
