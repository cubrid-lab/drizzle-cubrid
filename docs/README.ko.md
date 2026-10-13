# drizzle-cubrid

<!-- CUBRID-LAB-ROLE-ICON:START -->
<a href="https://github.com/cubrid-lab/brand">
  <img src="https://raw.githubusercontent.com/cubrid-lab/brand/aa62d38b48d165e39f0c56ed706a9dadb090a2bb/studies/icons/drizzle-cubrid.svg" alt="CUBRID Lab ORM icon (TypeScript)" width="80" />
</a>
<!-- CUBRID-LAB-ROLE-ICON:END -->

**CUBRID 데이터베이스를 위한 Drizzle ORM 다이얼렉트**

[🇰🇷 한국어](README.ko.md) · [🇺🇸 English](../README.md)

[![npm](https://img.shields.io/npm/v/drizzle-cubrid.svg)](https://www.npmjs.com/package/drizzle-cubrid)
[![CI](https://github.com/cubrid-labs/drizzle-cubrid/actions/workflows/ci.yml/badge.svg)](https://github.com/cubrid-labs/drizzle-cubrid/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-blue.svg)](https://nodejs.org/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.38-green.svg)](https://orm.drizzle.team/)
[![Coverage 99%](https://img.shields.io/badge/coverage-99%25-brightgreen.svg)](https://github.com/cubrid-labs/drizzle-cubrid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 왜 drizzle-cubrid인가?

CUBRID는 한국 공공기관 및 기업 환경에서 널리 사용되는 고성능 오픈소스 관계형
데이터베이스입니다. 지금까지 CUBRID를 위한 Drizzle ORM 다이얼렉트는
존재하지 않았습니다.

**drizzle-cubrid**가 그 공백을 채웁니다:

- **완전한 타입 안전성**을 갖춘 TypeScript 우선 Drizzle ORM 다이얼렉트
- **49개 오프라인 테스트**, **99% 이상의 코드 커버리지**
- [`cubrid-client`](https://github.com/cubrid-labs/cubrid-client) 기반 — 모던 TypeScript CUBRID 드라이버
- CUBRID 고유 타입 지원: `SET`, `MULTISET`, `SEQUENCE`, `MONETARY`
- drizzle-orm의 `mysql-core`를 통한 MySQL 호환 SQL 생성
- 세이브포인트를 활용한 트랜잭션 지원

## 요구 사항

- Node.js 18+
- Drizzle ORM 0.38+
- [cubrid-client](https://github.com/cubrid-labs/cubrid-client) 0.1.0+

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
  tags: set('tags', 'VARCHAR(50)'),
  categories: multiset('categories', 'VARCHAR(50)'),
  rankings: sequence('rankings', 'INTEGER'),
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

## 에코시스템

| 계층 | 패키지 | 설명 |
|------|---------|------|
| 드라이버 | [cubrid-client](https://github.com/cubrid-labs/cubrid-client) | TypeScript CUBRID 드라이버 |
| ORM 다이얼렉트 | [drizzle-cubrid](https://github.com/cubrid-labs/drizzle-cubrid) | Drizzle ORM 다이얼렉트 (이 패키지) |
| Python 드라이버 | [pycubrid](https://github.com/cubrid-labs/pycubrid) | 순수 Python CUBRID 드라이버 |
| Python ORM | [sqlalchemy-cubrid](https://github.com/cubrid-labs/sqlalchemy-cubrid) | SQLAlchemy 2.0 다이얼렉트 |
| 쿡북 | [cubrid-cookbook](https://github.com/cubrid-labs/cubrid-cookbook) | 사용 예제 및 레시피 |

## 기여

기여를 환영합니다! 이슈를 열거나 풀 리퀘스트를 제출해 주세요.

## 라이선스

MIT — [LICENSE](../LICENSE) 참조.
