# SurplusBid Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the SurplusBid backend (auth, lots, concurrency-safe bidding, Stripe escrow payments, disputes, admin) in 3 days, submitted by 2026-09-07 23:59 for the 60-mark tier.

**Architecture:** Node.js/TypeScript/Express REST API, layered as routes → controllers → services → Prisma, one folder per domain module under `src/modules`. Two `node-cron` jobs handle time-driven state transitions (lot closing, payment-deadline forfeiture) since the app runs as a persistent Render web service, not serverless.

**Tech Stack:** Express 4, TypeScript, PostgreSQL + Prisma, Zod, Redis (ioredis), Stripe, Multer + Cloudinary, JWT + Passport Google OAuth, bcrypt, helmet, cors, express-rate-limit, node-cron, Jest + Supertest, deployed on Render.

**Spec:** `docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md`

## Global Constraints

- All routes under `/api/v1`.
- Every response is `{ success: true, message, data }` or `{ success: false, message, errors }` — no exceptions, enforced by one centralized error handler, never per-route try/catch.
- Every POST/PATCH body is validated with a Zod schema before touching the database.
- Money is stored as integer cents (`amountCents`, `priceCents`, etc.) everywhere — never floats — matching Stripe's own amount format.
- Every list endpoint returning more than a handful of rows uses `select`/`include` scoped to what the endpoint returns, never a full-row fetch.
- Money-moving and race-prone logic (bid placement, lot settlement, payment deadline sweep) runs inside a Prisma `$transaction`.
- Soft delete only (`deletedAt`) — never `prisma....delete()` on `User` or `Lot`.
- Target deadline: 2026-09-07 23:59 (60-mark tier). Tasks are grouped by day; each task ends in a commit, so commit count tracks task count (28 tasks ≈ 28+ commits, clearing the 20-commit minimum).

---

## Day 1 (2026-09-04–05): Foundation + the two hard problems

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `.env`, `.gitignore`
- Create: `src/server.ts`, `src/app.ts`
- Create: `src/config/env.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Produces: `app` (default export from `src/app.ts`, an Express `Application`) — every later task mounts routes on this. `env` (named export from `src/config/env.ts`) — a typed object every later config file reads from.

- [ ] **Step 1: Init the project and install dependencies**

```bash
cd "/Users/joyntoghosh/Assignment 6"
git init
npm init -y
npm install express dotenv cors helmet express-rate-limit bcrypt jsonwebtoken \
  zod @prisma/client ioredis stripe multer cloudinary multer-storage-cloudinary \
  passport passport-google-oauth20 node-cron
npm install -D typescript ts-node-dev @types/express @types/node @types/cors \
  @types/bcrypt @types/jsonwebtoken @types/multer @types/passport \
  @types/passport-google-oauth20 @types/node-cron prisma jest ts-jest \
  @types/jest supertest @types/supertest
npx tsc --init --rootDir src --outDir dist --target ES2020 --module commonjs \
  --esModuleInterop --resolveJsonModule --strict --skipLibCheck
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 3: Write `.env.example` and a local `.env`**

```
# .env.example
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/surplusbid
JWT_ACCESS_SECRET=change-me
JWT_REFRESH_SECRET=change-me-too
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
REDIS_URL=redis://localhost:6379
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
CLOUDINARY_CLOUD_NAME=xxx
CLOUDINARY_API_KEY=xxx
CLOUDINARY_API_SECRET=xxx
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_CALLBACK_URL=http://localhost:4000/api/v1/auth/google/callback
CORS_ORIGIN=http://localhost:3000
DEPOSIT_PERCENT=10
PAYMENT_DEADLINE_HOURS=48
```

Copy it to `.env` and fill in real local values (a local Postgres and Redis, and Stripe test keys — Google/Cloudinary can stay placeholder until Task 5/7 need them).

- [ ] **Step 4: Write `src/config/env.ts`**

```typescript
import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? '',
  },
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  depositPercent: Number(process.env.DEPOSIT_PERCENT ?? 10),
  paymentDeadlineHours: Number(process.env.PAYMENT_DEADLINE_HOURS ?? 48),
};
```

- [ ] **Step 5: Write `src/app.ts`**

```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
app.use(
  rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false })
);

app.get('/api/v1/health', (_req, res) => {
  res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
});

export default app;
```

- [ ] **Step 6: Write `src/server.ts`**

```typescript
import app from './app';
import { env } from './config/env';

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`SurplusBid API listening on port ${env.port}`);
});
```

- [ ] **Step 7: Configure Jest** — add to `package.json`:

```json
{
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "jest --runInBand"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node"
  }
}
```

- [ ] **Step 8: Write the failing test**

```typescript
// tests/health.test.ts
import request from 'supertest';
import app from '../src/app';

describe('GET /api/v1/health', () => {
  it('returns success envelope', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
```

- [ ] **Step 9: Run it and confirm it passes** (app already exists, so this proves the harness works)

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Express/TypeScript project with health check"
```

### Task 2: Prisma schema, migration, and seed data

**Files:**
- Create: `prisma/schema.prisma`, `prisma/seed.ts`
- Create: `src/config/prisma.ts`
- Modify: `package.json` (seed script)

**Interfaces:**
- Consumes: `env.databaseUrl` from Task 1.
- Produces: `prisma` (named export, `PrismaClient` singleton from `src/config/prisma.ts`) — every service in later tasks imports this. All Prisma model names/enums below (`User`, `Lot`, `Bid`, `DepositHold`, `Payment`, `Dispute`, `AuditLog`, `Category`, `Role`, `AuthProvider`, `VerificationStatus`, `LotStatus`, `BidStatus`, `HoldStatus`, `PaymentStatus`, `DisputeStatus`) are the exact names later tasks use.

- [ ] **Step 1: Init Prisma**

```bash
npx prisma init --datasource-provider postgresql
```

- [ ] **Step 2: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  BUYER
  SELLER
  ADMIN
}

enum AuthProvider {
  LOCAL
  GOOGLE
}

enum VerificationStatus {
  UNVERIFIED
  PENDING
  VERIFIED
  REJECTED
}

enum LotStatus {
  DRAFT
  LIVE
  ENDED
  SOLD
  UNSOLD
  CANCELLED
}

enum BidStatus {
  ACTIVE
  OUTBID
  WINNING
}

enum HoldStatus {
  AUTHORIZED
  CAPTURED
  RELEASED
  FAILED
}

enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
  REFUNDED
}

enum DisputeStatus {
  OPEN
  UNDER_REVIEW
  RESOLVED
  REJECTED
}

model User {
  id                    String              @id @default(uuid())
  email                 String              @unique
  passwordHash          String?
  authProvider          AuthProvider        @default(LOCAL)
  googleId              String?             @unique
  role                  Role
  companyName           String
  taxId                 String?
  verificationStatus    VerificationStatus  @default(UNVERIFIED)
  verificationDocUrl    String?
  createdAt             DateTime            @default(now())
  updatedAt             DateTime            @updatedAt
  deletedAt             DateTime?

  lots               Lot[]         @relation("SellerLots")
  bids               Bid[]
  holds              DepositHold[]
  payments           Payment[]
  highestBidOnLots   Lot[]         @relation("CurrentHighestBidder")
  disputesRaised     Dispute[]     @relation("DisputeRaisedBy")
  disputesResolved   Dispute[]     @relation("DisputeResolvedBy")
  auditLogs          AuditLog[]

  @@index([email])
}

model Category {
  id   String @id @default(uuid())
  name String @unique
  slug String @unique
  lots Lot[]
}

model Lot {
  id                          String    @id @default(uuid())
  sellerId                    String
  seller                      User      @relation("SellerLots", fields: [sellerId], references: [id])
  categoryId                  String
  category                    Category  @relation(fields: [categoryId], references: [id])
  title                       String
  description                 String
  images                      String[]
  condition                   String
  quantity                    Int
  startingPriceCents          Int
  reservePriceCents           Int
  bidIncrementCents           Int
  startTime                   DateTime
  endTime                     DateTime
  status                      LotStatus @default(DRAFT)
  currentHighestBidAmountCents Int?
  currentHighestBidderId      String?
  currentHighestBidder        User?     @relation("CurrentHighestBidder", fields: [currentHighestBidderId], references: [id])
  createdAt                   DateTime  @default(now())
  updatedAt                   DateTime  @updatedAt
  deletedAt                   DateTime?

  bids     Bid[]
  holds    DepositHold[]
  payments Payment[]
  disputes Dispute[]

  @@index([status, endTime])
  @@index([categoryId, status])
}

model Bid {
  id        String    @id @default(uuid())
  lotId     String
  lot       Lot       @relation(fields: [lotId], references: [id])
  buyerId   String
  buyer     User      @relation(fields: [buyerId], references: [id])
  amountCents Int
  status    BidStatus @default(ACTIVE)
  createdAt DateTime  @default(now())

  @@index([lotId, createdAt])
}

model DepositHold {
  id                    String     @id @default(uuid())
  lotId                 String
  lot                   Lot        @relation(fields: [lotId], references: [id])
  buyerId               String
  buyer                 User       @relation(fields: [buyerId], references: [id])
  stripePaymentIntentId String     @unique
  amountCents           Int
  status                HoldStatus @default(AUTHORIZED)
  createdAt             DateTime   @default(now())

  @@unique([lotId, buyerId])
}

model Payment {
  id                    String        @id @default(uuid())
  lotId                 String
  lot                   Lot           @relation(fields: [lotId], references: [id])
  buyerId               String
  buyer                 User          @relation(fields: [buyerId], references: [id])
  stripePaymentIntentId String?       @unique
  amountCents           Int
  status                PaymentStatus @default(PENDING)
  dueAt                 DateTime
  paidAt                DateTime?
  createdAt             DateTime      @default(now())

  @@index([status, dueAt])
}

model Dispute {
  id             String        @id @default(uuid())
  lotId          String
  lot            Lot           @relation(fields: [lotId], references: [id])
  raisedById     String
  raisedBy       User          @relation("DisputeRaisedBy", fields: [raisedById], references: [id])
  reason         String
  description    String
  status         DisputeStatus @default(OPEN)
  resolutionNote String?
  resolvedById   String?
  resolvedBy     User?         @relation("DisputeResolvedBy", fields: [resolvedById], references: [id])
  createdAt      DateTime      @default(now())
  resolvedAt     DateTime?
}

model AuditLog {
  id         String   @id @default(uuid())
  actorId    String?
  actor      User?    @relation(fields: [actorId], references: [id])
  action     String
  entityType String
  entityId   String
  metadata   Json?
  createdAt  DateTime @default(now())

  @@index([entityType, entityId])
}
```

(`actorId` is nullable: most audit entries are a human admin action, but Tasks 14/16's cron jobs also log automated `Lot`/`Payment` status transitions per spec §6, and those have no human actor.)

- [ ] **Step 3: Run the first migration**

```bash
npx prisma migrate dev --name init
```

Expected: migration applies cleanly against your local `DATABASE_URL`.

- [ ] **Step 4: Write `src/config/prisma.ts`**

```typescript
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

- [ ] **Step 5: Write `prisma/seed.ts`**

```typescript
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Passw0rd!', 10);

  await prisma.user.upsert({
    where: { email: 'admin@surplusbid.com' },
    update: {},
    create: {
      email: 'admin@surplusbid.com',
      passwordHash,
      role: 'ADMIN',
      companyName: 'SurplusBid HQ',
      verificationStatus: 'VERIFIED',
    },
  });

  await prisma.user.upsert({
    where: { email: 'seller@surplusbid.com' },
    update: {},
    create: {
      email: 'seller@surplusbid.com',
      passwordHash,
      role: 'SELLER',
      companyName: 'Acme Surplus Co',
      verificationStatus: 'VERIFIED',
    },
  });

  await prisma.user.upsert({
    where: { email: 'buyer@surplusbid.com' },
    update: {},
    create: {
      email: 'buyer@surplusbid.com',
      passwordHash,
      role: 'BUYER',
      companyName: 'Contoso Industrial',
      verificationStatus: 'VERIFIED',
    },
  });

  const categories = ['Machinery', 'Electronics', 'Vehicles', 'Furniture', 'Raw Materials'];
  for (const name of categories) {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    await prisma.category.upsert({ where: { slug }, update: {}, create: { name, slug } });
  }

  // eslint-disable-next-line no-console
  console.log('Seed complete. Demo admin: admin@surplusbid.com / Passw0rd!');
}

main().finally(() => prisma.$disconnect());
```

- [ ] **Step 6: Wire the seed script into `package.json`**

```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  }
}
```

- [ ] **Step 7: Run the seed and verify**

```bash
npx prisma db seed
npx prisma studio
```

Expected: `prisma studio` opens and shows 3 users and 5 categories.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Prisma schema, migration, and seed data"
```

### Task 3: Response envelope, error handling, and JWT utilities

**Files:**
- Create: `src/utils/ApiError.ts`, `src/utils/response.ts`, `src/utils/asyncHandler.ts`, `src/utils/jwt.ts`
- Create: `src/middleware/errorHandler.ts`
- Modify: `src/app.ts` (mount error handler last)
- Test: `tests/errorHandler.test.ts`

**Interfaces:**
- Produces: `ApiError` class (`new ApiError(statusCode: number, message: string, errors?: string[])`), `sendSuccess(res, statusCode, message, data)`, `asyncHandler(fn: RequestHandler)`, `errorHandler` (Express error middleware, 4-arg signature), `signAccessToken(payload: { id: string; role: string })`, `signRefreshToken(payload: { id: string })`, `verifyAccessToken(token: string)`, `verifyRefreshToken(token: string)`. Every controller in every later task uses `asyncHandler`, `sendSuccess`, and throws `ApiError` for failures — never a raw `throw new Error(...)`.

- [ ] **Step 1: Write `src/utils/ApiError.ts`**

```typescript
export class ApiError extends Error {
  statusCode: number;
  errors: string[];

  constructor(statusCode: number, message: string, errors: string[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
  }
}
```

- [ ] **Step 2: Write `src/utils/response.ts`**

```typescript
import { Response } from 'express';

export function sendSuccess(res: Response, statusCode: number, message: string, data: unknown = {}) {
  return res.status(statusCode).json({ success: true, message, data });
}
```

- [ ] **Step 3: Write `src/utils/asyncHandler.ts`**

```typescript
import { NextFunction, Request, RequestHandler, Response } from 'express';

export function asyncHandler(fn: RequestHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
```

- [ ] **Step 4: Write `src/middleware/errorHandler.ts`**

```typescript
import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/ApiError';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ success: false, message: err.message, errors: err.errors });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'A record with this value already exists',
        errors: [String(err.meta?.target ?? 'unique constraint')],
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Record not found', errors: [] });
    }
  }

  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ success: false, message: 'Something went wrong', errors: [] });
}
```

- [ ] **Step 5: Mount it in `src/app.ts`** — add as the LAST `app.use()`, after all routes are mounted in later tasks:

```typescript
import { errorHandler } from './middleware/errorHandler';
// ... after all route mounts (added incrementally in later tasks) ...
app.use(errorHandler);
```

- [ ] **Step 6: Write `src/utils/jwt.ts`**

```typescript
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  id: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN';
}

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessExpiresIn });
}

export function signRefreshToken(payload: { id: string }) {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { id: string } {
  return jwt.verify(token, env.jwtRefreshSecret) as { id: string };
}
```

- [ ] **Step 7: Write the failing test**

```typescript
// tests/errorHandler.test.ts
import express from 'express';
import request from 'supertest';
import { ApiError } from '../src/utils/ApiError';
import { asyncHandler } from '../src/utils/asyncHandler';
import { errorHandler } from '../src/middleware/errorHandler';

const testApp = express();
testApp.get(
  '/boom',
  asyncHandler(async () => {
    throw new ApiError(400, 'Bad input', ['field is required']);
  })
);
testApp.use(errorHandler);

describe('errorHandler', () => {
  it('converts ApiError into the standard error envelope', async () => {
    const res = await request(testApp).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Bad input', errors: ['field is required'] });
  });
});
```

- [ ] **Step 8: Run it to verify it fails first, then passes**

Run: `npm test -- errorHandler`
Expected: PASS (the pieces above are written before the test runs, so this confirms wiring, not TDD-red — that's fine for infrastructure glue code).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add response envelope, centralized error handler, and JWT utilities"
```

### Task 4: Local auth — register, login, refresh, logout

**Files:**
- Create: `src/modules/auth/auth.validation.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.routes.ts`
- Create: `src/middleware/validate.ts`
- Modify: `src/app.ts` (mount `/api/v1/auth`)
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `ApiError`, `sendSuccess`, `asyncHandler` (Task 3), `signAccessToken`, `signRefreshToken`, `verifyRefreshToken` (Task 3).
- Produces: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh-token`, `POST /api/v1/auth/logout`. `validate(schema: ZodSchema)` middleware (named export from `src/middleware/validate.ts`) — every later module's routes use this the same way.

- [ ] **Step 1: Write `src/middleware/validate.ts`**

```typescript
import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return next(new ApiError(422, 'Validation failed', errors));
    }
    req.body = result.data;
    next();
  };
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/auth.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: 'newbuyer@test.com' } });
  await prisma.$disconnect();
});

describe('Auth', () => {
  it('registers a new buyer and returns tokens', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'newbuyer@test.com',
      password: 'Passw0rd!',
      role: 'BUYER',
      companyName: 'Test Co',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects registration with an invalid email', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      password: 'Passw0rd!',
      role: 'BUYER',
      companyName: 'Test Co',
    });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'newbuyer@test.com',
      password: 'Passw0rd!',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects login with wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'newbuyer@test.com',
      password: 'wrong',
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- auth`
Expected: FAIL (route `/api/v1/auth/register` does not exist yet — 404)

- [ ] **Step 4: Write `src/modules/auth/auth.validation.ts`**

```typescript
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['BUYER', 'SELLER']),
  companyName: z.string().min(2),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
```

- [ ] **Step 5: Write `src/modules/auth/auth.service.ts`**

```typescript
import bcrypt from 'bcrypt';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';

export async function registerUser(input: { email: string; password: string; role: 'BUYER' | 'SELLER'; companyName: string }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new ApiError(409, 'Email already registered');

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      role: input.role,
      companyName: input.companyName,
    },
    select: { id: true, email: true, role: true },
  });

  return {
    user,
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refreshToken: signRefreshToken({ id: user.id }),
  };
}

export async function loginUser(input: { email: string; password: string }) {
  const user = await prisma.user.findFirst({ where: { email: input.email, deletedAt: null } });
  if (!user || !user.passwordHash) throw new ApiError(401, 'Invalid email or password');

  const matches = await bcrypt.compare(input.password, user.passwordHash);
  if (!matches) throw new ApiError(401, 'Invalid email or password');

  return {
    user: { id: user.id, email: user.email, role: user.role },
    accessToken: signAccessToken({ id: user.id, role: user.role }),
    refreshToken: signRefreshToken({ id: user.id }),
  };
}
```

- [ ] **Step 6: Write `src/modules/auth/auth.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { loginUser, registerUser } from './auth.service';
import { verifyRefreshToken, signAccessToken } from '../../utils/jwt';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await registerUser(req.body);
  sendSuccess(res, 201, 'Registration successful', result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await loginUser(req.body);
  sendSuccess(res, 200, 'Login successful', result);
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken: token } = req.body;
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }
  const user = await prisma.user.findFirst({ where: { id: payload.id, deletedAt: null } });
  if (!user) throw new ApiError(401, 'Invalid or expired refresh token');

  const accessToken = signAccessToken({ id: user.id, role: user.role });
  sendSuccess(res, 200, 'Token refreshed', { accessToken });
});

export const logout = asyncHandler(async (_req: Request, res: Response) => {
  // Stateless JWTs: logout is client-side (discard tokens). Nothing to invalidate server-side in v1.
  sendSuccess(res, 200, 'Logged out', {});
});
```

- [ ] **Step 7: Write `src/modules/auth/auth.routes.ts`**

```typescript
import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema, refreshSchema } from './auth.validation';
import { register, login, refreshToken, logout } from './auth.controller';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/refresh-token', validate(refreshSchema), refreshToken);
router.post('/logout', logout);

export default router;
```

- [ ] **Step 8: Mount the router in `src/app.ts`**

```typescript
import authRoutes from './modules/auth/auth.routes';
// ... after the health route, before the error handler ...
app.use('/api/v1/auth', authRoutes);
```

- [ ] **Step 9: Run the test and verify it passes**

Run: `npm test -- auth`
Expected: PASS (all 4 cases)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add local auth (register, login, refresh, logout)"
```

### Task 5: JWT auth middleware + role-based access control

**Files:**
- Create: `src/middleware/auth.ts`, `src/middleware/rbac.ts`, `src/types/express.d.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken` (Task 3).
- Produces: `authenticate` (Express middleware, named export from `src/middleware/auth.ts`, sets `req.user = { id, role }`), `requireRole(...roles: Array<'BUYER'|'SELLER'|'ADMIN'>)` (named export from `src/middleware/rbac.ts`). Every protected route in every later task is `router.get('/path', authenticate, requireRole('ADMIN'), controller)`.

- [ ] **Step 1: Write `src/types/express.d.ts`**

```typescript
import { AccessTokenPayload } from '../utils/jwt';

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export {};
```

- [ ] **Step 2: Write `src/middleware/auth.ts`**

```typescript
import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new ApiError(401, 'Missing or invalid Authorization header'));
  }
  const token = header.slice('Bearer '.length);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired access token'));
  }
}
```

- [ ] **Step 3: Write `src/middleware/rbac.ts`**

```typescript
import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';

type Role = 'BUYER' | 'SELLER' | 'ADMIN';

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have access to this resource'));
    }
    next();
  };
}
```

- [ ] **Step 4: Write the failing test**

```typescript
// tests/rbac.test.ts
import express from 'express';
import request from 'supertest';
import { authenticate } from '../src/middleware/auth';
import { requireRole } from '../src/middleware/rbac';
import { errorHandler } from '../src/middleware/errorHandler';
import { signAccessToken } from '../src/utils/jwt';

const testApp = express();
testApp.get('/admin-only', authenticate, requireRole('ADMIN'), (_req, res) => res.json({ success: true }));
testApp.use(errorHandler);

describe('RBAC', () => {
  it('rejects a buyer token on an admin-only route with 403', async () => {
    const token = signAccessToken({ id: 'u1', role: 'BUYER' });
    const res = await request(testApp).get('/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows an admin token through', async () => {
    const token = signAccessToken({ id: 'u1', role: 'ADMIN' });
    const res = await request(testApp).get('/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a missing token with 401', async () => {
    const res = await request(testApp).get('/admin-only');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then passes**

Run: `npm test -- rbac`
Expected: PASS once Steps 1–3 are in place.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add JWT auth middleware and role-based access control"
```

### Task 6: Google OAuth login

**Files:**
- Create: `src/config/passport.ts`, `src/modules/auth/googleAuth.controller.ts`
- Modify: `src/modules/auth/auth.routes.ts`, `src/app.ts`

**Interfaces:**
- Consumes: `env.google` (Task 1), `prisma` (Task 2), `signAccessToken`/`signRefreshToken` (Task 3).
- Produces: `GET /api/v1/auth/google`, `GET /api/v1/auth/google/callback` — issues the same access/refresh token pair as local login, redirecting the frontend with them as query params.

- [ ] **Step 1: Write `src/config/passport.ts`**

```typescript
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from './env';
import { prisma } from './prisma';

passport.use(
  new GoogleStrategy(
    {
      clientID: env.google.clientId,
      clientSecret: env.google.clientSecret,
      callbackURL: env.google.callbackUrl,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('Google account has no email'));

      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            authProvider: 'GOOGLE',
            googleId: profile.id,
            role: 'BUYER',
            companyName: profile.displayName || email,
          },
        });
      }
      return done(null, user);
    }
  )
);

export default passport;
```

- [ ] **Step 2: Write `src/modules/auth/googleAuth.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { User } from '@prisma/client';
import { signAccessToken, signRefreshToken } from '../../utils/jwt';

export function googleCallback(req: Request, res: Response) {
  const user = req.user as unknown as User;
  const accessToken = signAccessToken({ id: user.id, role: user.role });
  const refreshToken = signRefreshToken({ id: user.id });
  res.redirect(`${process.env.CORS_ORIGIN}/oauth-callback?accessToken=${accessToken}&refreshToken=${refreshToken}`);
}
```

- [ ] **Step 3: Wire routes into `src/modules/auth/auth.routes.ts`**

```typescript
import passport from '../../config/passport';
import { googleCallback } from './googleAuth.controller';

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/google/callback', passport.authenticate('google', { session: false }), googleCallback);
```

- [ ] **Step 4: Initialize passport in `src/app.ts`**

```typescript
import passport from './config/passport';
app.use(passport.initialize());
```

- [ ] **Step 5: Manual verification** (Google OAuth needs a real browser redirect — not unit-testable without a live Google app):

Run: `npm run dev`, open `http://localhost:4000/api/v1/auth/google` in a browser with real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL` set in `.env` (register the callback URL in Google Cloud Console first).
Expected: redirects through Google consent, lands on the callback with `accessToken`/`refreshToken` in the URL, and a new `User` row appears in `prisma studio` with `authProvider = GOOGLE`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Google OAuth login"
```

### Task 7: Profile + business verification endpoints

**Files:**
- Create: `src/config/cloudinary.ts`, `src/middleware/upload.ts`
- Create: `src/modules/users/users.validation.ts`, `src/modules/users/users.service.ts`, `src/modules/users/users.controller.ts`, `src/modules/users/users.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/users.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireRole` (Task 5), `validate` (Task 4), `prisma` (Task 2).
- Produces: `GET /api/v1/users/me`, `PATCH /api/v1/users/me`, `POST /api/v1/users/verify`. `upload` (named export, a configured Multer instance) — reused by Task 9's lot-image upload.

- [ ] **Step 1: Write `src/config/cloudinary.ts`**

```typescript
import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
});

export default cloudinary;
```

- [ ] **Step 2: Write `src/middleware/upload.ts`**

```typescript
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary';

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'surplusbid', resource_type: 'auto' } as never,
});

export const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
```

- [ ] **Step 3: Write the failing test**

```typescript
// tests/users.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string;
let token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({
    data: { email: 'profile-test@test.com', role: 'BUYER', companyName: 'Test Co', passwordHash: 'x' },
  });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyer.id, role: 'BUYER' });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: buyerId } });
  await prisma.$disconnect();
});

describe('Profile', () => {
  it('returns the current user on GET /users/me', async () => {
    const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('profile-test@test.com');
  });

  it('updates companyName on PATCH /users/me', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyName: 'Updated Co' });
    expect(res.status).toBe(200);
    expect(res.body.data.companyName).toBe('Updated Co');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- users`
Expected: FAIL (route does not exist — 404)

- [ ] **Step 5: Write `src/modules/users/users.validation.ts`**

```typescript
import { z } from 'zod';

export const updateProfileSchema = z.object({
  companyName: z.string().min(2).optional(),
  taxId: z.string().optional(),
});
```

- [ ] **Step 6: Write `src/modules/users/users.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

const SAFE_FIELDS = {
  id: true, email: true, role: true, companyName: true, taxId: true,
  verificationStatus: true, authProvider: true, createdAt: true,
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: SAFE_FIELDS });
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

export async function updateMe(userId: string, data: { companyName?: string; taxId?: string }) {
  return prisma.user.update({ where: { id: userId }, data, select: SAFE_FIELDS });
}

export async function submitVerification(userId: string, docUrl: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { verificationStatus: 'PENDING', verificationDocUrl: docUrl },
    select: SAFE_FIELDS,
  });
}
```

- [ ] **Step 7: Write `src/modules/users/users.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { getMe, submitVerification, updateMe } from './users.service';

export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = await getMe(req.user!.id);
  sendSuccess(res, 200, 'Profile fetched', user);
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await updateMe(req.user!.id, req.body);
  sendSuccess(res, 200, 'Profile updated', user);
});

export const verify = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file as Express.Multer.File & { path: string };
  if (!file) throw new ApiError(422, 'Verification document is required');
  const user = await submitVerification(req.user!.id, file.path);
  sendSuccess(res, 200, 'Verification submitted for review', user);
});
```

- [ ] **Step 8: Write `src/modules/users/users.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { upload } from '../../middleware/upload';
import { updateProfileSchema } from './users.validation';
import { me, updateProfile, verify } from './users.controller';

const router = Router();

router.get('/me', authenticate, me);
router.patch('/me', authenticate, validate(updateProfileSchema), updateProfile);
router.post('/verify', authenticate, upload.single('document'), verify);

export default router;
```

- [ ] **Step 9: Mount in `src/app.ts`**

```typescript
import usersRoutes from './modules/users/users.routes';
app.use('/api/v1/users', usersRoutes);
```

- [ ] **Step 10: Run the test and verify it passes**

Run: `npm test -- users`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add profile and business verification endpoints"
```

### Task 8: Category endpoints

**Files:**
- Create: `src/modules/categories/categories.validation.ts`, `src/modules/categories/categories.service.ts`, `src/modules/categories/categories.controller.ts`, `src/modules/categories/categories.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/categories.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireRole` (Task 5), `validate` (Task 4).
- Produces: `GET /api/v1/categories` (public), `POST /api/v1/categories` (admin only).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/categories.test.ts
import request from 'supertest';
import app from '../src/app';
import { signAccessToken } from '../src/utils/jwt';
import { prisma } from '../src/config/prisma';

afterAll(async () => {
  await prisma.category.deleteMany({ where: { slug: 'test-category' } });
  await prisma.$disconnect();
});

describe('Categories', () => {
  it('lists categories without auth', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rejects category creation from a non-admin', async () => {
    const token = signAccessToken({ id: 'u1', role: 'BUYER' });
    const res = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Category' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to create a category', async () => {
    const token = signAccessToken({ id: 'u1', role: 'ADMIN' });
    const res = await request(app)
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Category' });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('test-category');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- categories`
Expected: FAIL (404)

- [ ] **Step 3: Write `src/modules/categories/categories.validation.ts`**

```typescript
import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(2),
});
```

- [ ] **Step 4: Write `src/modules/categories/categories.service.ts`**

```typescript
import { prisma } from '../../config/prisma';

export function listCategories() {
  return prisma.category.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } });
}

export function createCategory(name: string) {
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
  return prisma.category.create({ data: { name, slug } });
}
```

- [ ] **Step 5: Write `src/modules/categories/categories.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createCategory, listCategories } from './categories.service';

export const list = asyncHandler(async (_req: Request, res: Response) => {
  const categories = await listCategories();
  sendSuccess(res, 200, 'Categories fetched', categories);
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const category = await createCategory(req.body.name);
  sendSuccess(res, 201, 'Category created', category);
});
```

- [ ] **Step 6: Write `src/modules/categories/categories.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createCategorySchema } from './categories.validation';
import { create, list } from './categories.controller';

const router = Router();

router.get('/', list);
router.post('/', authenticate, requireRole('ADMIN'), validate(createCategorySchema), create);

export default router;
```

- [ ] **Step 7: Mount in `src/app.ts`**

```typescript
import categoriesRoutes from './modules/categories/categories.routes';
app.use('/api/v1/categories', categoriesRoutes);
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npm test -- categories`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add category listing and creation"
```

---

## Day 2 (2026-09-05–06): Lots, Redis, and the concurrency-safe bidding engine

### Task 9: Lot creation, draft editing, publish, soft delete, my-listings

**Files:**
- Create: `src/modules/lots/lots.validation.ts`, `src/modules/lots/lots.service.ts`, `src/modules/lots/lots.controller.ts`, `src/modules/lots/lots.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/lots.crud.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireRole` (Task 5), `validate` (Task 4), `upload` (Task 7), `prisma` (Task 2).
- Produces: `POST /api/v1/lots`, `PATCH /api/v1/lots/:id`, `DELETE /api/v1/lots/:id`, `PATCH /api/v1/lots/:id/publish`, `GET /api/v1/lots/my-listings`. `lots.service.ts` exports `getOwnedDraftOr404(lotId, sellerId)` — Task 10 and Task 11 both need to load a lot by id, so its `findLotById` export is reused there too.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/lots.crud.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let sellerId: string;
let categoryId: string;
let sellerToken: string;
let buyerToken: string;

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: 'lot-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x', verificationStatus: 'VERIFIED' },
  });
  sellerId = seller.id;
  sellerToken = signAccessToken({ id: seller.id, role: 'SELLER' });
  buyerToken = signAccessToken({ id: 'nonexistent-buyer', role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Test Lots Category', slug: 'test-lots-category' } });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: sellerId } });
  await prisma.$disconnect();
});

describe('Lot CRUD', () => {
  let lotId: string;

  it('lets a seller create a draft lot', async () => {
    const res = await request(app)
      .post('/api/v1/lots')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        title: 'Used Forklift',
        description: 'Well-maintained forklift, 2019 model',
        categoryId,
        condition: 'Used - Good',
        quantity: 1,
        startingPriceCents: 500000,
        reservePriceCents: 400000,
        bidIncrementCents: 10000,
        startTime: new Date(Date.now() + 60_000).toISOString(),
        endTime: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    lotId = res.body.data.id;
  });

  it('rejects a buyer trying to create a lot', async () => {
    const res = await request(app)
      .post('/api/v1/lots')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ title: 'x' });
    expect(res.status).toBe(403);
  });

  it('lets the owning seller publish the draft', async () => {
    const res = await request(app)
      .patch(`/api/v1/lots/${lotId}/publish`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('LIVE');
  });

  it('lists the seller their own listings', async () => {
    const res = await request(app)
      .get('/api/v1/lots/my-listings')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((l: { id: string }) => l.id === lotId)).toBe(true);
  });

  it('soft-deletes the lot instead of hard-deleting it', async () => {
    const res = await request(app)
      .delete(`/api/v1/lots/${lotId}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(res.status).toBe(200);
    const row = await prisma.lot.findUnique({ where: { id: lotId } });
    expect(row?.deletedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- lots.crud`
Expected: FAIL (404 — routes don't exist yet)

- [ ] **Step 3: Write `src/modules/lots/lots.validation.ts`**

```typescript
import { z } from 'zod';

export const createLotSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  categoryId: z.string().uuid(),
  condition: z.string().min(2),
  quantity: z.number().int().positive(),
  startingPriceCents: z.number().int().positive(),
  reservePriceCents: z.number().int().positive(),
  bidIncrementCents: z.number().int().positive(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
}).refine((d) => new Date(d.endTime) > new Date(d.startTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

export const updateLotSchema = createLotSchema.partial();
```

- [ ] **Step 4: Write `src/modules/lots/lots.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

const LOT_LIST_SELECT = {
  id: true, title: true, images: true, categoryId: true, status: true,
  startingPriceCents: true, currentHighestBidAmountCents: true, endTime: true,
} as const;

export async function findLotById(lotId: string) {
  const lot = await prisma.lot.findFirst({ where: { id: lotId, deletedAt: null } });
  if (!lot) throw new ApiError(404, 'Lot not found');
  return lot;
}

export async function getOwnedDraftOr404(lotId: string, sellerId: string) {
  const lot = await findLotById(lotId);
  if (lot.sellerId !== sellerId) throw new ApiError(403, 'You do not own this lot');
  return lot;
}

export function createLot(sellerId: string, data: Record<string, unknown>) {
  return prisma.lot.create({
    data: { ...data, sellerId, images: [] } as never,
  });
}

export async function updateDraftLot(lotId: string, sellerId: string, data: Record<string, unknown>) {
  const lot = await getOwnedDraftOr404(lotId, sellerId);
  if (lot.status !== 'DRAFT') throw new ApiError(409, 'Only draft lots can be edited');
  return prisma.lot.update({ where: { id: lotId }, data: data as never });
}

export async function softDeleteLot(lotId: string, sellerId: string) {
  await getOwnedDraftOr404(lotId, sellerId);
  return prisma.lot.update({ where: { id: lotId }, data: { deletedAt: new Date() } });
}

export async function publishLot(lotId: string, sellerId: string) {
  const lot = await getOwnedDraftOr404(lotId, sellerId);
  if (lot.status !== 'DRAFT') throw new ApiError(409, 'Only draft lots can be published');
  return prisma.lot.update({ where: { id: lotId }, data: { status: 'LIVE' } });
}

export function listMyLots(sellerId: string) {
  return prisma.lot.findMany({ where: { sellerId, deletedAt: null }, select: LOT_LIST_SELECT, orderBy: { createdAt: 'desc' } });
}
```

- [ ] **Step 5: Write `src/modules/lots/lots.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createLot, listMyLots, publishLot, softDeleteLot, updateDraftLot } from './lots.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const lot = await createLot(req.user!.id, req.body);
  sendSuccess(res, 201, 'Lot created as draft', lot);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const lot = await updateDraftLot(req.params.id, req.user!.id, req.body);
  sendSuccess(res, 200, 'Lot updated', lot);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await softDeleteLot(req.params.id, req.user!.id);
  sendSuccess(res, 200, 'Lot deleted', {});
});

export const publish = asyncHandler(async (req: Request, res: Response) => {
  const lot = await publishLot(req.params.id, req.user!.id);
  sendSuccess(res, 200, 'Lot is now live', lot);
});

export const myListings = asyncHandler(async (req: Request, res: Response) => {
  const lots = await listMyLots(req.user!.id);
  sendSuccess(res, 200, 'Your listings', lots);
});
```

- [ ] **Step 6: Write `src/modules/lots/lots.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createLotSchema, updateLotSchema } from './lots.validation';
import { create, myListings, publish, remove, update } from './lots.controller';

const router = Router();

router.post('/', authenticate, requireRole('SELLER'), validate(createLotSchema), create);
router.get('/my-listings', authenticate, requireRole('SELLER'), myListings);
router.patch('/:id', authenticate, requireRole('SELLER'), validate(updateLotSchema), update);
router.delete('/:id', authenticate, requireRole('SELLER'), remove);
router.patch('/:id/publish', authenticate, requireRole('SELLER'), publish);

export default router;
```

Note: `/my-listings` is registered before `/:id` routes so Express doesn't treat `my-listings` as an `:id` value — Task 10 appends the public `GET /` and `GET /:id` routes to this same router and must preserve that ordering.

- [ ] **Step 7: Mount in `src/app.ts`**

```typescript
import lotsRoutes from './modules/lots/lots.routes';
app.use('/api/v1/lots', lotsRoutes);
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npm test -- lots.crud`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add lot creation, draft editing, publish, and soft delete"
```

### Task 10: Lot browse — pagination, filtering, sorting, search + Redis-cached detail view

**Files:**
- Create: `src/config/redis.ts`
- Create: `src/modules/lots/lots.query.ts`
- Modify: `src/modules/lots/lots.service.ts`, `src/modules/lots/lots.controller.ts`, `src/modules/lots/lots.routes.ts`
- Test: `tests/lots.browse.test.ts`

**Interfaces:**
- Consumes: `findLotById` (Task 9).
- Produces: `redis` (named export, `Redis` instance from `src/config/redis.ts`) — Task 12 and Task 15's rate limiter reuse this same client. `GET /api/v1/lots` (public, paginated/filtered/sorted/searched), `GET /api/v1/lots/:id` (public, Redis-cached).

- [ ] **Step 1: Write `src/config/redis.ts`**

```typescript
import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.redisUrl);
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/lots.browse.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { signAccessToken } from '../src/utils/jwt';

let sellerId: string, categoryId: string, lotId: string;

beforeAll(async () => {
  const seller = await prisma.user.create({
    data: { email: 'browse-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x', verificationStatus: 'VERIFIED' },
  });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Browse Test Category', slug: 'browse-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Industrial Generator', description: 'A generator for the browse test',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
});

afterAll(async () => {
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: sellerId } });
  await redis.quit();
  await prisma.$disconnect();
});

describe('Lot browse', () => {
  it('paginates lot listings', async () => {
    const res = await request(app).get('/api/v1/lots?page=1&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeLessThanOrEqual(5);
    expect(res.body.data.meta.page).toBe(1);
  });

  it('filters by category and status', async () => {
    const res = await request(app).get(`/api/v1/lots?categoryId=${categoryId}&status=LIVE`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.every((l: { categoryId: string }) => l.categoryId === categoryId)).toBe(true);
  });

  it('searches by keyword in the title', async () => {
    const res = await request(app).get('/api/v1/lots?q=Generator');
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((l: { id: string }) => l.id === lotId)).toBe(true);
  });

  it('gets a single lot by id, hiding reservePriceCents from a non-owner', async () => {
    const token = signAccessToken({ id: 'someone-else', role: 'BUYER' });
    const res = await request(app).get(`/api/v1/lots/${lotId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.reservePriceCents).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- lots.browse`
Expected: FAIL (`GET /api/v1/lots` and `GET /api/v1/lots/:id` don't exist yet)

- [ ] **Step 4: Write `src/modules/lots/lots.query.ts`**

```typescript
import { z } from 'zod';

export const browseLotsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
  categoryId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'LIVE', 'ENDED', 'SOLD', 'UNSOLD', 'CANCELLED']).optional(),
  sortBy: z.enum(['createdAt', 'endTime', 'currentHighestBidAmountCents']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
});
```

- [ ] **Step 5: Add browse + detail functions to `src/modules/lots/lots.service.ts`**

```typescript
import { redis } from '../../config/redis';
import { browseLotsSchema } from './lots.query';
import { z } from 'zod';

const PUBLIC_LOT_SELECT = {
  id: true, title: true, description: true, images: true, condition: true, quantity: true,
  categoryId: true, sellerId: true, status: true, startingPriceCents: true, bidIncrementCents: true,
  currentHighestBidAmountCents: true, startTime: true, endTime: true, createdAt: true,
} as const;

export async function browseLots(query: z.infer<typeof browseLotsSchema>) {
  const where = {
    deletedAt: null,
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lot.findMany({
      where,
      select: PUBLIC_LOT_SELECT,
      orderBy: { [query.sortBy]: query.sortOrder },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.lot.count({ where }),
  ]);

  return { items, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
}

export async function getLotDetail(lotId: string, requesterId: string | undefined) {
  const cacheKey = `lot:${lotId}:highestBid`;
  const lot = await findLotById(lotId);

  const cachedHighest = await redis.get(cacheKey);
  const currentHighestBidAmountCents = cachedHighest !== null ? Number(cachedHighest) : lot.currentHighestBidAmountCents;

  const { reservePriceCents, ...publicFields } = lot;
  const isOwner = requesterId === lot.sellerId;
  return { ...publicFields, currentHighestBidAmountCents, ...(isOwner ? { reservePriceCents } : {}) };
}
```

(`prisma` is already imported at the top of `lots.service.ts` from Task 9 — no new import needed there.)

- [ ] **Step 6: Add controller actions to `src/modules/lots/lots.controller.ts`**

```typescript
import { browseLotsSchema } from './lots.query';
import { browseLots, getLotDetail } from './lots.service';

export const browse = asyncHandler(async (req: Request, res: Response) => {
  const query = browseLotsSchema.parse(req.query);
  const result = await browseLots(query);
  sendSuccess(res, 200, 'Lots fetched', result);
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  const lot = await getLotDetail(req.params.id, req.user?.id);
  sendSuccess(res, 200, 'Lot fetched', lot);
});
```

- [ ] **Step 7: Add public routes to `src/modules/lots/lots.routes.ts`** — append after the existing routes, and add an optional-auth middleware so `req.user` is set when a token is present without rejecting anonymous requests:

```typescript
import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../../utils/jwt';
import { browse, detail } from './lots.controller';

function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try { req.user = verifyAccessToken(header.slice(7)); } catch { /* ignore invalid token, stay anonymous */ }
  }
  next();
}

router.get('/', browse);
router.get('/:id', optionalAuth, detail);
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npm test -- lots.browse`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add paginated/filtered/searchable lot browsing with Redis-cached detail view"
```

### Task 11: Stripe deposit hold (authorize, don't capture)

**Files:**
- Create: `src/config/stripe.ts`
- Create: `src/modules/bids/bids.validation.ts`, `src/modules/bids/bids.service.ts`, `src/modules/bids/bids.controller.ts`, `src/modules/bids/bids.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/deposit.test.ts`

**Interfaces:**
- Consumes: `findLotById` (Task 9), `authenticate`, `requireRole` (Task 5), `prisma` (Task 2).
- Produces: `stripe` (named export, configured `Stripe` client). `POST /api/v1/lots/:id/deposit`. `bids.service.ts` exports `getActiveHold(lotId, buyerId)` — Task 12's bid placement depends on this to confirm a hold exists before accepting a bid.

- [ ] **Step 1: Write `src/config/stripe.ts`**

```typescript
import Stripe from 'stripe';
import { env } from './env';

export const stripe = new Stripe(env.stripeSecretKey, { apiVersion: '2024-06-20' });
```

- [ ] **Step 2: Write the failing test** (mocks Stripe — no real card network calls in the test suite)

```typescript
// tests/deposit.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';
import { stripe } from '../src/config/stripe';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_test_123', client_secret: 'secret_123' }) } },
}));

let buyerId: string, sellerId: string, categoryId: string, lotId: string, buyerToken: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'deposit-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  buyerToken = signAccessToken({ id: buyer.id, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'deposit-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Deposit Test Category', slug: 'deposit-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Deposit Test Lot', description: 'For deposit testing',
      condition: 'Used', quantity: 1, startingPriceCents: 200000, reservePriceCents: 150000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
});

afterAll(async () => {
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Deposit hold', () => {
  it('creates a Stripe payment intent and stores an AUTHORIZED hold at 10% of startingPriceCents', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/deposit`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(201);
    expect(res.body.data.amountCents).toBe(20000);
    expect(res.body.data.status).toBe('AUTHORIZED');
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20000, currency: 'usd', capture_method: 'manual' })
    );
  });

  it('rejects a second deposit request for the same lot/buyer pair', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/deposit`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- deposit`
Expected: FAIL (route doesn't exist)

- [ ] **Step 4: Write `src/modules/bids/bids.validation.ts`**

```typescript
import { z } from 'zod';

export const placeBidSchema = z.object({
  amountCents: z.number().int().positive(),
});
```

- [ ] **Step 5: Write `src/modules/bids/bids.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { findLotById } from '../lots/lots.service';

export async function getActiveHold(lotId: string, buyerId: string) {
  return prisma.depositHold.findFirst({ where: { lotId, buyerId, status: 'AUTHORIZED' } });
}

export async function createDepositHold(lotId: string, buyerId: string) {
  const lot = await findLotById(lotId);
  if (lot.status !== 'LIVE') throw new ApiError(409, 'This lot is not open for bidding');

  const existing = await prisma.depositHold.findUnique({ where: { lotId_buyerId: { lotId, buyerId } } });
  if (existing) throw new ApiError(409, 'A deposit hold already exists for this lot');

  const amountCents = Math.round(lot.startingPriceCents * (env.depositPercent / 100));
  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    capture_method: 'manual',
    metadata: { lotId, buyerId },
  });

  return prisma.depositHold.create({
    data: { lotId, buyerId, amountCents, stripePaymentIntentId: intent.id, status: 'AUTHORIZED' },
  });
}
```

- [ ] **Step 6: Write `src/modules/bids/bids.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createDepositHold } from './bids.service';

export const deposit = asyncHandler(async (req: Request, res: Response) => {
  const hold = await createDepositHold(req.params.id, req.user!.id);
  sendSuccess(res, 201, 'Deposit authorized', hold);
});
```

- [ ] **Step 7: Write `src/modules/bids/bids.routes.ts`** (mounted under `/api/v1/lots` so `:id` resolves to the lot)

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { deposit } from './bids.controller';

const router = Router({ mergeParams: true });

router.post('/:id/deposit', authenticate, requireRole('BUYER'), deposit);

export default router;
```

- [ ] **Step 8: Mount in `src/app.ts`** — before the existing `lotsRoutes` mount, since both hang off `/api/v1/lots`:

```typescript
import bidsRoutes from './modules/bids/bids.routes';
app.use('/api/v1/lots', bidsRoutes);
app.use('/api/v1/lots', lotsRoutes);
```

- [ ] **Step 9: Run the test and verify it passes**

Run: `npm test -- deposit`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add Stripe deposit hold (authorize-only) before bidding"
```

### Task 12: Concurrency-safe bid placement with anti-sniping (the core hard problem)

**Files:**
- Modify: `src/modules/bids/bids.service.ts`, `src/modules/bids/bids.controller.ts`, `src/modules/bids/bids.routes.ts`
- Test: `tests/bids.concurrency.test.ts`

**Interfaces:**
- Consumes: `getActiveHold` (Task 11), `redis` (Task 10).
- Produces: `POST /api/v1/lots/:id/bids`, exporting `placeBid(lotId, buyerId, amountCents)` from `bids.service.ts` — Task 14's cron settlement job reads the `Bid` rows this writes, matched on `status: 'WINNING'`.

- [ ] **Step 1: Write the failing test** — this is the test that matters most in the whole plan: it fires two bids at the same lot concurrently and asserts only one wins.

```typescript
// tests/bids.concurrency.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { create: jest.fn().mockResolvedValue({ id: `pi_${Math.random()}` }) } },
}));

let buyerAId: string, buyerBId: string, sellerId: string, categoryId: string, lotId: string;
let tokenA: string, tokenB: string;

beforeAll(async () => {
  const [buyerA, buyerB, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'concurrency-a@test.com', role: 'BUYER', companyName: 'A Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'concurrency-b@test.com', role: 'BUYER', companyName: 'B Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'concurrency-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } }),
  ]);
  buyerAId = buyerA.id; buyerBId = buyerB.id; sellerId = seller.id;
  tokenA = signAccessToken({ id: buyerAId, role: 'BUYER' });
  tokenB = signAccessToken({ id: buyerBId, role: 'BUYER' });
  const category = await prisma.category.create({ data: { name: 'Concurrency Test Category', slug: 'concurrency-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Concurrency Test Lot', description: 'For race-condition testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;

  await request(app).post(`/api/v1/lots/${lotId}/deposit`).set('Authorization', `Bearer ${tokenA}`);
  await request(app).post(`/api/v1/lots/${lotId}/deposit`).set('Authorization', `Bearer ${tokenB}`);
});

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerAId, buyerBId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Concurrency-safe bidding', () => {
  it('rejects a bid below the minimum increment', async () => {
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/bids`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ amountCents: 100001 });
    expect(res.status).toBe(409);
  });

  it('requires a deposit hold before accepting a bid', async () => {
    const unfundedToken = signAccessToken({ id: 'no-deposit-buyer', role: 'BUYER' });
    const res = await request(app)
      .post(`/api/v1/lots/${lotId}/bids`)
      .set('Authorization', `Bearer ${unfundedToken}`)
      .send({ amountCents: 105000 });
    expect(res.status).toBe(403);
  });

  it('never lets two simultaneous bids both become WINNING', async () => {
    const [resA, resB] = await Promise.all([
      request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenA}`).send({ amountCents: 110000 }),
      request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenB}`).send({ amountCents: 110000 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]); // one accepted, one rejected as no-longer-highest

    const winningBids = await prisma.bid.findMany({ where: { lotId, status: 'WINNING' } });
    expect(winningBids).toHaveLength(1);
  });

  it('extends endTime when a bid lands inside the anti-sniping window', async () => {
    await prisma.lot.update({ where: { id: lotId }, data: { endTime: new Date(Date.now() + 60_000) } });
    const before = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });

    await request(app).post(`/api/v1/lots/${lotId}/bids`).set('Authorization', `Bearer ${tokenA}`).send({ amountCents: 120000 });

    const after = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(after.endTime.getTime()).toBeGreaterThan(before.endTime.getTime());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- bids.concurrency`
Expected: FAIL (`POST /api/v1/lots/:id/bids` doesn't exist)

- [ ] **Step 3: Add `placeBid` to `src/modules/bids/bids.service.ts`**

```typescript
const ANTI_SNIPE_WINDOW_MS = 2 * 60 * 1000;
const ANTI_SNIPE_EXTENSION_MS = 2 * 60 * 1000;

export async function placeBid(lotId: string, buyerId: string, amountCents: number) {
  const hold = await getActiveHold(lotId, buyerId);
  if (!hold) throw new ApiError(403, 'You must authorize a deposit hold before bidding on this lot');

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; endTime: Date; currentHighestBidAmountCents: number | null; bidIncrementCents: number }[]>`
      SELECT id, status, "endTime", "currentHighestBidAmountCents", "bidIncrementCents"
      FROM "Lot" WHERE id = ${lotId} FOR UPDATE
    `;
    const lot = rows[0];
    if (!lot) throw new ApiError(404, 'Lot not found');
    if (lot.status !== 'LIVE') throw new ApiError(409, 'This lot is not open for bidding');

    const currentHighest = lot.currentHighestBidAmountCents ?? 0;
    const minimumAcceptable = currentHighest === 0 ? currentHighest : currentHighest + lot.bidIncrementCents;
    if (amountCents < minimumAcceptable || (currentHighest > 0 && amountCents < currentHighest + lot.bidIncrementCents)) {
      throw new ApiError(409, `Bid must be at least ${currentHighest + lot.bidIncrementCents} cents`);
    }

    await tx.bid.updateMany({ where: { lotId, status: 'WINNING' }, data: { status: 'OUTBID' } });
    const bid = await tx.bid.create({ data: { lotId, buyerId, amountCents, status: 'WINNING' } });

    const now = Date.now();
    const extendEndTime = lot.endTime.getTime() - now < ANTI_SNIPE_WINDOW_MS
      ? new Date(lot.endTime.getTime() + ANTI_SNIPE_EXTENSION_MS)
      : lot.endTime;

    await tx.lot.update({
      where: { id: lotId },
      data: { currentHighestBidAmountCents: amountCents, currentHighestBidderId: buyerId, endTime: extendEndTime },
    });

    await redis.set(`lot:${lotId}:highestBid`, amountCents);
    return bid;
  }, { isolationLevel: 'ReadCommitted' });
}
```

- [ ] **Step 4: Add the controller action to `src/modules/bids/bids.controller.ts`**

```typescript
import { placeBid } from './bids.service';

export const bid = asyncHandler(async (req: Request, res: Response) => {
  const result = await placeBid(req.params.id, req.user!.id, req.body.amountCents);
  sendSuccess(res, 201, 'Bid placed', result);
});
```

- [ ] **Step 5: Add the route to `src/modules/bids/bids.routes.ts`**

```typescript
import { validate } from '../../middleware/validate';
import { placeBidSchema } from './bids.validation';
import { bid } from './bids.controller';

router.post('/:id/bids', authenticate, requireRole('BUYER'), validate(placeBidSchema), bid);
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test -- bids.concurrency`
Expected: PASS, including the concurrent-bid test — this is the one worth re-running a few times (`npm test -- bids.concurrency --runInBand` a few times in a row) since a race-condition fix that only passes sometimes is not fixed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add concurrency-safe bid placement with anti-sniping extension"
```

### Task 13: Bid history endpoints

**Files:**
- Modify: `src/modules/bids/bids.service.ts`, `src/modules/bids/bids.controller.ts`, `src/modules/bids/bids.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/bids.history.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2).
- Produces: `GET /api/v1/lots/:id/bids` (paginated), `GET /api/v1/bids/my-bids`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bids.history.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string, sellerId: string, categoryId: string, lotId: string, token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'history-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyerId, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'history-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'History Test Category', slug: 'history-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'History Test Lot', description: 'For bid history testing',
      condition: 'Used', quantity: 1, startingPriceCents: 50000, reservePriceCents: 40000, bidIncrementCents: 1000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'LIVE',
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId, amountCents: 51000, status: 'WINNING' } });
});

afterAll(async () => {
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Bid history', () => {
  it('returns paginated bid history for a lot, newest first', async () => {
    const res = await request(app).get(`/api/v1/lots/${lotId}/bids`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].amountCents).toBe(51000);
  });

  it("returns the authenticated buyer's own bids", async () => {
    const res = await request(app).get('/api/v1/bids/my-bids').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((b: { lotId: string }) => b.lotId === lotId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- bids.history`
Expected: FAIL

- [ ] **Step 3: Add to `src/modules/bids/bids.service.ts`**

```typescript
export async function getBidHistory(lotId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.bid.findMany({
      where: { lotId },
      select: { id: true, buyerId: true, amountCents: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bid.count({ where: { lotId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getMyBids(buyerId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.bid.findMany({
      where: { buyerId },
      select: { id: true, lotId: true, amountCents: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.bid.count({ where: { buyerId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
```

- [ ] **Step 4: Add to `src/modules/bids/bids.controller.ts`**

```typescript
import { getBidHistory, getMyBids } from './bids.service';

export const history = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await getBidHistory(req.params.id, page, limit);
  sendSuccess(res, 200, 'Bid history fetched', result);
});

export const myBids = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await getMyBids(req.user!.id, page, limit);
  sendSuccess(res, 200, 'Your bids fetched', result);
});
```

- [ ] **Step 5: Add routes to `src/modules/bids/bids.routes.ts`** (note the second router mounted at top level, not under `/lots`)

```typescript
import { history, myBids } from './bids.controller';

router.get('/:id/bids', history); // stays on the `/lots`-mounted router

export const myBidsRouter = Router();
myBidsRouter.get('/my-bids', authenticate, requireRole('BUYER'), myBids);
```

- [ ] **Step 6: Mount the new router in `src/app.ts`**

```typescript
import { myBidsRouter } from './modules/bids/bids.routes';
app.use('/api/v1/bids', myBidsRouter);
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `npm test -- bids.history`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add paginated bid history and my-bids endpoints"
```

### Task 14: Lot-closing cron job (settle winner, release losing holds)

**Files:**
- Create: `src/jobs/closeLots.job.ts`
- Modify: `src/server.ts`
- Test: `tests/jobs.closeLots.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `stripe` (Task 11), `env.paymentDeadlineHours` (Task 1).
- Produces: `closeLots()` (named export, an idempotent async function — Task 15's payment flow reads the `Payment` rows this creates, matched on `status: 'PENDING'` and `dueAt`). `startCronJobs()` (named export from the same file) registers it on a 1-minute `node-cron` schedule.

- [ ] **Step 1: Write the failing test** — calls `closeLots()` directly rather than waiting on a real cron tick, so it's fast and deterministic.

```typescript
// tests/jobs.closeLots.test.ts
import { prisma } from '../src/config/prisma';
import { closeLots } from '../src/jobs/closeLots.job';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { cancel: jest.fn().mockResolvedValue({}) } },
}));

let sellerId: string, categoryId: string, lotId: string, winnerId: string, loserId: string;

beforeAll(async () => {
  const [winner, loser, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'close-winner@test.com', role: 'BUYER', companyName: 'W Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'close-loser@test.com', role: 'BUYER', companyName: 'L Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'close-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
  ]);
  winnerId = winner.id; loserId = loser.id; sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Close Test Category', slug: 'close-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Close Test Lot', description: 'For close-job testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() - 1000), status: 'LIVE',
      currentHighestBidAmountCents: 120000, currentHighestBidderId: winnerId,
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId: winnerId, amountCents: 120000, status: 'WINNING' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: winnerId, amountCents: 10000, stripePaymentIntentId: 'pi_winner', status: 'AUTHORIZED' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: loserId, amountCents: 10000, stripePaymentIntentId: 'pi_loser', status: 'AUTHORIZED' } });
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, loserId, sellerId] } } });
  await prisma.$disconnect();
});

describe('closeLots job', () => {
  it('marks an ended lot SOLD, releases the loser hold, and opens a payment window for the winner', async () => {
    await closeLots();

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.status).toBe('SOLD');

    const loserHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: loserId } });
    expect(loserHold.status).toBe('RELEASED');

    const winnerHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(winnerHold.status).toBe('AUTHORIZED');

    const payment = await prisma.payment.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(payment.status).toBe('PENDING');
    expect(payment.amountCents).toBe(120000 - winnerHold.amountCents);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- jobs.closeLots`
Expected: FAIL (`closeLots` module doesn't exist)

- [ ] **Step 3: Write `src/jobs/closeLots.job.ts`**

```typescript
import cron from 'node-cron';
import { prisma } from '../config/prisma';
import { stripe } from '../config/stripe';
import { env } from '../config/env';

export async function closeLots() {
  const endedLots = await prisma.lot.findMany({
    where: { status: 'LIVE', endTime: { lte: new Date() } },
  });

  for (const lot of endedLots) {
    await prisma.$transaction(async (tx) => {
      const holds = await tx.depositHold.findMany({ where: { lotId: lot.id, status: 'AUTHORIZED' } });

      if (!lot.currentHighestBidderId) {
        await tx.lot.update({ where: { id: lot.id }, data: { status: 'UNSOLD' } });
        for (const hold of holds) {
          await stripe.paymentIntents.cancel(hold.stripePaymentIntentId);
          await tx.depositHold.update({ where: { id: hold.id }, data: { status: 'RELEASED' } });
        }
        await tx.auditLog.create({
          data: { actorId: null, action: 'LOT_UNSOLD', entityType: 'Lot', entityId: lot.id, metadata: { reason: 'no bids' } },
        });
        return;
      }

      for (const hold of holds) {
        if (hold.buyerId === lot.currentHighestBidderId) continue;
        await stripe.paymentIntents.cancel(hold.stripePaymentIntentId);
        await tx.depositHold.update({ where: { id: hold.id }, data: { status: 'RELEASED' } });
      }

      const winnerHold = holds.find((h) => h.buyerId === lot.currentHighestBidderId);
      const winningAmount = lot.currentHighestBidAmountCents ?? 0;
      const remainingCents = winnerHold ? winningAmount - winnerHold.amountCents : winningAmount;

      await tx.lot.update({ where: { id: lot.id }, data: { status: 'SOLD' } });
      await tx.payment.create({
        data: {
          lotId: lot.id,
          buyerId: lot.currentHighestBidderId,
          amountCents: remainingCents,
          status: 'PENDING',
          dueAt: new Date(Date.now() + env.paymentDeadlineHours * 60 * 60 * 1000),
        },
      });
      await tx.auditLog.create({
        data: { actorId: null, action: 'LOT_SOLD', entityType: 'Lot', entityId: lot.id, metadata: { winnerId: lot.currentHighestBidderId, amountCents: winningAmount } },
      });
    });
  }
}

export function startCronJobs() {
  cron.schedule('* * * * *', () => {
    closeLots().catch((err) => console.error('closeLots job failed:', err));
  });
}
```

- [ ] **Step 4: Wire it into `src/server.ts`**

```typescript
import { startCronJobs } from './jobs/closeLots.job';

app.listen(env.port, () => {
  console.log(`SurplusBid API listening on port ${env.port}`);
  startCronJobs();
});
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -- jobs.closeLots`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add lot-closing cron job that settles winners and releases losing holds"
```

---

## Day 3 (2026-09-06–07): Payments, disputes, admin, hardening, deployment, submission

### Task 15: Final payment — initiate, Stripe webhook, status tracking

**Files:**
- Create: `src/modules/payments/payments.service.ts`, `src/modules/payments/payments.controller.ts`, `src/modules/payments/payments.routes.ts`
- Modify: `src/app.ts` (raw-body webhook route must be mounted BEFORE `express.json()`)
- Test: `tests/payments.test.ts`

**Interfaces:**
- Consumes: `stripe` (Task 11), `prisma` (Task 2), `authenticate`, `requireRole` (Task 5).
- Produces: `POST /api/v1/payments/initiate`, `POST /api/v1/payments/webhook`, `GET /api/v1/payments/:id`, `GET /api/v1/payments/my-payments`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/payments.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

jest.mock('../src/config/stripe', () => ({
  stripe: {
    paymentIntents: { capture: jest.fn().mockResolvedValue({ id: 'pi_winner', status: 'succeeded' }) },
    webhooks: { constructEvent: jest.fn() },
  },
}));

import { stripe } from '../src/config/stripe';

let buyerId: string, sellerId: string, categoryId: string, lotId: string, paymentId: string, token: string;

beforeAll(async () => {
  const buyer = await prisma.user.create({ data: { email: 'payment-buyer@test.com', role: 'BUYER', companyName: 'Buyer Co', passwordHash: 'x' } });
  buyerId = buyer.id;
  token = signAccessToken({ id: buyerId, role: 'BUYER' });
  const seller = await prisma.user.create({ data: { email: 'payment-seller@test.com', role: 'SELLER', companyName: 'Seller Co', passwordHash: 'x' } });
  sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Payment Test Category', slug: 'payment-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Payment Test Lot', description: 'For payment testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() - 1000), status: 'SOLD', currentHighestBidderId: buyerId,
    },
  });
  lotId = lot.id;
  await prisma.depositHold.create({ data: { lotId, buyerId, amountCents: 10000, stripePaymentIntentId: 'pi_winner', status: 'AUTHORIZED' } });
  const payment = await prisma.payment.create({
    data: { lotId, buyerId, amountCents: 110000, status: 'PENDING', dueAt: new Date(Date.now() + 3_600_000) },
  });
  paymentId = payment.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.$disconnect();
});

describe('Final payment', () => {
  it('initiates payment by capturing the deposit hold and returns it as PENDING', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentId });
    expect(res.status).toBe(200);
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith('pi_winner');
  });

  it('marks the payment SUCCEEDED when the webhook reports success', async () => {
    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_winner' } },
    });
    const res = await request(app).post('/api/v1/payments/webhook').set('stripe-signature', 'test-sig').send({});
    expect(res.status).toBe(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('SUCCEEDED');
  });

  it("returns the buyer's own payments", async () => {
    const res = await request(app).get('/api/v1/payments/my-payments').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((p: { id: string }) => p.id === paymentId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- payments`
Expected: FAIL

- [ ] **Step 3: Write `src/modules/payments/payments.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { stripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';

export async function initiatePayment(paymentId: string, buyerId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, buyerId } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status !== 'PENDING') throw new ApiError(409, 'This payment has already been processed');

  const hold = await prisma.depositHold.findFirstOrThrow({ where: { lotId: payment.lotId, buyerId, status: 'AUTHORIZED' } });
  await stripe.paymentIntents.capture(hold.stripePaymentIntentId);
  await prisma.depositHold.update({ where: { id: hold.id }, data: { status: 'CAPTURED' } });

  return prisma.payment.update({
    where: { id: paymentId },
    data: { stripePaymentIntentId: hold.stripePaymentIntentId },
  });
}

export async function handleWebhookEvent(event: { type: string; data: { object: { id: string } } }) {
  if (event.type === 'payment_intent.succeeded') {
    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: event.data.object.id },
      data: { status: 'SUCCEEDED', paidAt: new Date() },
    });
  }
  if (event.type === 'payment_intent.payment_failed') {
    await prisma.payment.updateMany({
      where: { stripePaymentIntentId: event.data.object.id },
      data: { status: 'FAILED' },
    });
  }
}

export async function getPaymentById(paymentId: string, requesterId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, buyerId: requesterId } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  return payment;
}

export async function getMyPayments(buyerId: string, page: number, limit: number) {
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where: { buyerId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.payment.count({ where: { buyerId } }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
```

- [ ] **Step 4: Write `src/modules/payments/payments.controller.ts`**

```typescript
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { stripe } from '../../config/stripe';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { getMyPayments, getPaymentById, handleWebhookEvent, initiatePayment } from './payments.service';

export const initiate = asyncHandler(async (req: Request, res: Response) => {
  const payment = await initiatePayment(req.body.paymentId, req.user!.id);
  sendSuccess(res, 200, 'Payment initiated', payment);
});

export const webhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = env.nodeEnv === 'test'
      ? (stripe.webhooks.constructEvent(req.body, signature as string, '') as unknown as Stripe.Event)
      : stripe.webhooks.constructEvent(req.body, signature as string, env.stripeWebhookSecret);
  } catch {
    throw new ApiError(400, 'Invalid webhook signature');
  }
  await handleWebhookEvent(event as never);
  res.json({ received: true });
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const payment = await getPaymentById(req.params.id, req.user!.id);
  sendSuccess(res, 200, 'Payment fetched', payment);
});

export const myPayments = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await getMyPayments(req.user!.id, page, limit);
  sendSuccess(res, 200, 'Your payments fetched', result);
});
```

- [ ] **Step 5: Write `src/modules/payments/payments.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { getById, initiate, myPayments, webhook } from './payments.controller';

const router = Router();

router.post('/initiate', authenticate, requireRole('BUYER'), initiate);
router.post('/webhook', webhook);
router.get('/my-payments', authenticate, requireRole('BUYER'), myPayments);
router.get('/:id', authenticate, requireRole('BUYER'), getById);

export default router;
```

- [ ] **Step 6: Mount in `src/app.ts`** — the webhook route needs the RAW body, not the JSON-parsed one, so mount it before `express.json()`:

```typescript
import paymentsRoutes from './modules/payments/payments.routes';
import express from 'express';

app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
// ... (this line goes ABOVE `app.use(express.json())` from Task 1) ...
app.use('/api/v1/payments', paymentsRoutes);
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `npm test -- payments`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add final payment initiation and Stripe webhook handling"
```

### Task 16: Payment-deadline sweep — forfeiture and rollover to next bidder

**Files:**
- Create: `src/jobs/settlePayments.job.ts`
- Modify: `src/jobs/closeLots.job.ts` (export `startCronJobs` registers both jobs)
- Test: `tests/jobs.settlePayments.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `stripe` (Task 11), `env.paymentDeadlineHours` (Task 1).
- Produces: `sweepOverduePayments()` (named export).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/jobs.settlePayments.test.ts
import { prisma } from '../src/config/prisma';
import { sweepOverduePayments } from '../src/jobs/settlePayments.job';

jest.mock('../src/config/stripe', () => ({
  stripe: { paymentIntents: { capture: jest.fn().mockResolvedValue({}) } },
}));

let sellerId: string, categoryId: string, lotId: string, winnerId: string, nextBidderId: string;

beforeAll(async () => {
  const [winner, nextBidder, seller] = await Promise.all([
    prisma.user.create({ data: { email: 'settle-winner@test.com', role: 'BUYER', companyName: 'W Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'settle-next@test.com', role: 'BUYER', companyName: 'N Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'settle-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
  ]);
  winnerId = winner.id; nextBidderId = nextBidder.id; sellerId = seller.id;
  const category = await prisma.category.create({ data: { name: 'Settle Test Category', slug: 'settle-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Settle Test Lot', description: 'For settlement testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(Date.now() - 7_200_000), endTime: new Date(Date.now() - 3_600_000), status: 'SOLD',
      currentHighestBidAmountCents: 120000, currentHighestBidderId: winnerId,
    },
  });
  lotId = lot.id;
  await prisma.bid.create({ data: { lotId, buyerId: winnerId, amountCents: 120000, status: 'WINNING' } });
  await prisma.bid.create({ data: { lotId, buyerId: nextBidderId, amountCents: 115000, status: 'OUTBID' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: winnerId, amountCents: 10000, stripePaymentIntentId: 'pi_settle_winner', status: 'AUTHORIZED' } });
  await prisma.depositHold.create({ data: { lotId, buyerId: nextBidderId, amountCents: 10000, stripePaymentIntentId: 'pi_settle_next', status: 'AUTHORIZED' } });
  await prisma.payment.create({
    data: { lotId, buyerId: winnerId, amountCents: 110000, status: 'PENDING', dueAt: new Date(Date.now() - 1000) },
  });
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, nextBidderId, sellerId] } } });
  await prisma.$disconnect();
});

describe('sweepOverduePayments', () => {
  it('forfeits the missed-deadline winner and rolls the lot to the next-highest bidder', async () => {
    await sweepOverduePayments();

    const winnerHold = await prisma.depositHold.findFirstOrThrow({ where: { lotId, buyerId: winnerId } });
    expect(winnerHold.status).toBe('CAPTURED');

    const lot = await prisma.lot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.currentHighestBidderId).toBe(nextBidderId);
    expect(lot.status).toBe('SOLD');

    const nextPayment = await prisma.payment.findFirstOrThrow({ where: { lotId, buyerId: nextBidderId } });
    expect(nextPayment.status).toBe('PENDING');
    expect(nextPayment.amountCents).toBe(115000 - 10000);

    const cachedHighest = await redis.get(`lot:${lotId}:highestBid`);
    expect(Number(cachedHighest)).toBe(115000);

    const auditActions = await prisma.auditLog.findMany({ where: { entityId: { in: [lotId, ...(await prisma.payment.findMany({ where: { lotId }, select: { id: true } })).map((p) => p.id)] } } });
    expect(auditActions.map((a) => a.action)).toEqual(expect.arrayContaining(['PAYMENT_DEADLINE_FORFEITED', 'LOT_ROLLED_OVER']));
  });
});
```

Add the import at the top of the test file:

```typescript
import { redis } from '../src/config/redis';
```

And close it in `afterAll`:

```typescript
afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: { in: ['Lot', 'Payment'] }, entityId: lotId } });
  await prisma.payment.deleteMany({ where: { lotId } });
  await prisma.depositHold.deleteMany({ where: { lotId } });
  await prisma.bid.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [winnerId, nextBidderId, sellerId] } } });
  await redis.quit();
  await prisma.$disconnect();
});
```

(this replaces the earlier `afterAll` in this same test file — Step 1 above defined a simpler one before the audit-log/cache assertions existed).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- jobs.settlePayments`
Expected: FAIL

- [ ] **Step 3: Write `src/jobs/settlePayments.job.ts`**

```typescript
import { prisma } from '../config/prisma';
import { stripe } from '../config/stripe';
import { env } from '../config/env';
import { redis } from '../config/redis';

export async function sweepOverduePayments() {
  const overduePayments = await prisma.payment.findMany({
    where: { status: 'PENDING', dueAt: { lte: new Date() } },
  });

  for (const payment of overduePayments) {
    await prisma.$transaction(async (tx) => {
      const hold = await tx.depositHold.findFirst({
        where: { lotId: payment.lotId, buyerId: payment.buyerId, status: 'AUTHORIZED' },
      });
      if (hold) {
        await stripe.paymentIntents.capture(hold.stripePaymentIntentId);
        await tx.depositHold.update({ where: { id: hold.id }, data: { status: 'CAPTURED' } });
      }
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      await tx.auditLog.create({
        data: { actorId: null, action: 'PAYMENT_DEADLINE_FORFEITED', entityType: 'Payment', entityId: payment.id, metadata: { buyerId: payment.buyerId, lotId: payment.lotId } },
      });

      const nextBid = await tx.bid.findFirst({
        where: { lotId: payment.lotId, buyerId: { not: payment.buyerId }, status: 'OUTBID' },
        orderBy: { amountCents: 'desc' },
      });

      if (!nextBid) {
        await tx.lot.update({ where: { id: payment.lotId }, data: { status: 'UNSOLD' } });
        return;
      }

      await tx.bid.update({ where: { id: nextBid.id }, data: { status: 'WINNING' } });
      await tx.lot.update({
        where: { id: payment.lotId },
        data: { currentHighestBidAmountCents: nextBid.amountCents, currentHighestBidderId: nextBid.buyerId, status: 'SOLD' },
      });
      // Keep the read-through cache (Task 10) consistent with the rolled-back amount —
      // otherwise a viewer of this now-re-settled lot sees the forfeited buyer's stale higher bid.
      await redis.set(`lot:${payment.lotId}:highestBid`, nextBid.amountCents);

      const nextHold = await tx.depositHold.findFirst({
        where: { lotId: payment.lotId, buyerId: nextBid.buyerId, status: 'AUTHORIZED' },
      });
      const remainingCents = nextHold ? nextBid.amountCents - nextHold.amountCents : nextBid.amountCents;

      await tx.payment.create({
        data: {
          lotId: payment.lotId,
          buyerId: nextBid.buyerId,
          amountCents: remainingCents,
          status: 'PENDING',
          dueAt: new Date(Date.now() + env.paymentDeadlineHours * 60 * 60 * 1000),
        },
      });
      await tx.auditLog.create({
        data: { actorId: null, action: 'LOT_ROLLED_OVER', entityType: 'Lot', entityId: payment.lotId, metadata: { newWinnerId: nextBid.buyerId, amountCents: nextBid.amountCents } },
      });
    });
  }
}
```

- [ ] **Step 4: Register the second cron schedule in `src/jobs/closeLots.job.ts`**

```typescript
import { sweepOverduePayments } from './settlePayments.job';

export function startCronJobs() {
  cron.schedule('* * * * *', () => {
    closeLots().catch((err) => console.error('closeLots job failed:', err));
  });
  cron.schedule('* * * * *', () => {
    sweepOverduePayments().catch((err) => console.error('sweepOverduePayments job failed:', err));
  });
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -- jobs.settlePayments`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add payment-deadline sweep with forfeiture and rollover to next bidder"
```

### Task 17: Disputes — create and admin resolution

**Files:**
- Create: `src/modules/disputes/disputes.validation.ts`, `src/modules/disputes/disputes.service.ts`, `src/modules/disputes/disputes.controller.ts`, `src/modules/disputes/disputes.routes.ts`
- Modify: `src/app.ts`
- Test: `tests/disputes.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireRole` (Task 5), `validate` (Task 4), `findLotById` (Task 9).
- Produces: `POST /api/v1/disputes`, `PATCH /api/v1/disputes/:id/resolve`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/disputes.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let buyerId: string, sellerId: string, adminId: string, categoryId: string, lotId: string;
let buyerToken: string, adminToken: string, disputeId: string;

beforeAll(async () => {
  const [buyer, seller, admin] = await Promise.all([
    prisma.user.create({ data: { email: 'dispute-buyer@test.com', role: 'BUYER', companyName: 'B Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'dispute-seller@test.com', role: 'SELLER', companyName: 'S Co', passwordHash: 'x' } }),
    prisma.user.create({ data: { email: 'dispute-admin@test.com', role: 'ADMIN', companyName: 'Admin', passwordHash: 'x' } }),
  ]);
  buyerId = buyer.id; sellerId = seller.id; adminId = admin.id;
  buyerToken = signAccessToken({ id: buyerId, role: 'BUYER' });
  adminToken = signAccessToken({ id: adminId, role: 'ADMIN' });
  const category = await prisma.category.create({ data: { name: 'Dispute Test Category', slug: 'dispute-test-category' } });
  categoryId = category.id;
  const lot = await prisma.lot.create({
    data: {
      sellerId, categoryId, title: 'Dispute Test Lot', description: 'For dispute testing',
      condition: 'Used', quantity: 1, startingPriceCents: 100000, reservePriceCents: 80000, bidIncrementCents: 5000,
      startTime: new Date(), endTime: new Date(Date.now() + 3_600_000), status: 'SOLD',
    },
  });
  lotId = lot.id;
});

afterAll(async () => {
  await prisma.dispute.deleteMany({ where: { lotId } });
  await prisma.lot.deleteMany({ where: { sellerId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId, adminId] } } });
  await prisma.$disconnect();
});

describe('Disputes', () => {
  it('lets a buyer file a dispute on a lot', async () => {
    const res = await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ lotId, reason: 'Item not as described', description: 'The equipment had undisclosed damage.' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('OPEN');
    disputeId = res.body.data.id;
  });

  it('rejects resolution attempts from a non-admin', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ status: 'RESOLVED', resolutionNote: 'Refund issued' });
    expect(res.status).toBe(403);
  });

  it('lets an admin resolve the dispute', async () => {
    const res = await request(app)
      .patch(`/api/v1/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RESOLVED', resolutionNote: 'Refund issued to buyer' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RESOLVED');
    expect(res.body.data.resolvedById).toBe(adminId);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- disputes`
Expected: FAIL

- [ ] **Step 3: Write `src/modules/disputes/disputes.validation.ts`**

```typescript
import { z } from 'zod';

export const createDisputeSchema = z.object({
  lotId: z.string().uuid(),
  reason: z.string().min(3),
  description: z.string().min(10),
});

export const resolveDisputeSchema = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  resolutionNote: z.string().min(3),
});
```

- [ ] **Step 4: Write `src/modules/disputes/disputes.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { findLotById } from '../lots/lots.service';

export async function createDispute(raisedById: string, data: { lotId: string; reason: string; description: string }) {
  await findLotById(data.lotId);
  return prisma.dispute.create({ data: { ...data, raisedById } });
}

export async function resolveDispute(disputeId: string, resolvedById: string, data: { status: 'RESOLVED' | 'REJECTED'; resolutionNote: string }) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw new ApiError(404, 'Dispute not found');

  const updated = await prisma.dispute.update({
    where: { id: disputeId },
    data: { status: data.status, resolutionNote: data.resolutionNote, resolvedById, resolvedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { actorId: resolvedById, action: 'RESOLVE_DISPUTE', entityType: 'Dispute', entityId: disputeId, metadata: data },
  });

  return updated;
}
```

- [ ] **Step 5: Write `src/modules/disputes/disputes.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { createDispute, resolveDispute } from './disputes.service';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await createDispute(req.user!.id, req.body);
  sendSuccess(res, 201, 'Dispute filed', dispute);
});

export const resolve = asyncHandler(async (req: Request, res: Response) => {
  const dispute = await resolveDispute(req.params.id, req.user!.id, req.body);
  sendSuccess(res, 200, 'Dispute resolved', dispute);
});
```

- [ ] **Step 6: Write `src/modules/disputes/disputes.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { createDisputeSchema, resolveDisputeSchema } from './disputes.validation';
import { create, resolve } from './disputes.controller';

const router = Router();

router.post('/', authenticate, requireRole('BUYER', 'SELLER'), validate(createDisputeSchema), create);
router.patch('/:id/resolve', authenticate, requireRole('ADMIN'), validate(resolveDisputeSchema), resolve);

export default router;
```

- [ ] **Step 7: Mount in `src/app.ts`**

```typescript
import disputesRoutes from './modules/disputes/disputes.routes';
app.use('/api/v1/disputes', disputesRoutes);
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npm test -- disputes`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add dispute filing and admin resolution"
```

### Task 18: Admin — user verification, list/filter users, dashboard stats, audit logs

**Files:**
- Create: `src/modules/admin/admin.service.ts`, `src/modules/admin/admin.controller.ts`, `src/modules/admin/admin.routes.ts`
- Modify: `src/modules/users/users.service.ts` (AuditLog write on verification), `src/app.ts`
- Test: `tests/admin.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `requireRole` (Task 5), `prisma` (Task 2).
- Produces: `GET /api/v1/admin/users` (paginated/filterable), `PATCH /api/v1/admin/users/:id/verify`, `GET /api/v1/admin/dashboard-stats`, `GET /api/v1/admin/audit-logs` (paginated/filterable).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/admin.test.ts
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

let adminId: string, pendingSellerId: string, adminToken: string, buyerToken: string;

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: 'admin-test@test.com', role: 'ADMIN', companyName: 'Admin', passwordHash: 'x' } });
  adminId = admin.id;
  adminToken = signAccessToken({ id: adminId, role: 'ADMIN' });
  buyerToken = signAccessToken({ id: 'someone', role: 'BUYER' });
  const pendingSeller = await prisma.user.create({
    data: { email: 'pending-seller@test.com', role: 'SELLER', companyName: 'Pending Co', passwordHash: 'x', verificationStatus: 'PENDING' },
  });
  pendingSellerId = pendingSeller.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, pendingSellerId] } } });
  await prisma.$disconnect();
});

describe('Admin', () => {
  it('rejects non-admins from listing users', async () => {
    const res = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
  });

  it('lists users filtered by verificationStatus, paginated', async () => {
    const res = await request(app)
      .get('/api/v1/admin/users?verificationStatus=PENDING&page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((u: { id: string }) => u.id === pendingSellerId)).toBe(true);
  });

  it('verifies a pending seller and writes an audit log entry', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/users/${pendingSellerId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verificationStatus: 'VERIFIED' });
    expect(res.status).toBe(200);
    expect(res.body.data.verificationStatus).toBe('VERIFIED');

    const log = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: pendingSellerId } });
    expect(log?.action).toBe('VERIFY_USER');
  });

  it('returns dashboard stats', async () => {
    const res = await request(app).get('/api/v1/admin/dashboard-stats').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('activeLots');
    expect(res.body.data).toHaveProperty('openDisputes');
  });

  it('lists audit logs, paginated', async () => {
    const res = await request(app).get('/api/v1/admin/audit-logs?page=1&limit=10').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- admin`
Expected: FAIL

- [ ] **Step 3: Write `src/modules/admin/admin.service.ts`**

```typescript
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';

export async function listUsers(page: number, limit: number, verificationStatus?: string, role?: string) {
  const where = {
    deletedAt: null,
    ...(verificationStatus ? { verificationStatus: verificationStatus as never } : {}),
    ...(role ? { role: role as never } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: { id: true, email: true, role: true, companyName: true, verificationStatus: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function verifyUser(userId: string, adminId: string, verificationStatus: 'VERIFIED' | 'REJECTED') {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw new ApiError(404, 'User not found');

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { verificationStatus },
    select: { id: true, email: true, role: true, companyName: true, verificationStatus: true },
  });

  await prisma.auditLog.create({
    data: { actorId: adminId, action: 'VERIFY_USER', entityType: 'User', entityId: userId, metadata: { verificationStatus } },
  });

  return updated;
}

export async function getDashboardStats() {
  const [activeLots, openDisputes, verifiedSellers, totalGmvCents] = await Promise.all([
    prisma.lot.count({ where: { status: 'LIVE', deletedAt: null } }),
    prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
    prisma.user.count({ where: { role: 'SELLER', verificationStatus: 'VERIFIED' } }),
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountCents: true } }),
  ]);
  return { activeLots, openDisputes, verifiedSellers, totalGmvCents: totalGmvCents._sum.amountCents ?? 0 };
}

export async function listAuditLogs(page: number, limit: number, entityType?: string) {
  const where = entityType ? { entityType } : {};
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
```

- [ ] **Step 4: Write `src/modules/admin/admin.controller.ts`**

```typescript
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/response';
import { getDashboardStats, listAuditLogs, listUsers, verifyUser } from './admin.service';

export const users = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await listUsers(page, limit, req.query.verificationStatus as string, req.query.role as string);
  sendSuccess(res, 200, 'Users fetched', result);
});

export const verify = asyncHandler(async (req: Request, res: Response) => {
  const user = await verifyUser(req.params.id, req.user!.id, req.body.verificationStatus);
  sendSuccess(res, 200, 'User verification updated', user);
});

export const dashboardStats = asyncHandler(async (_req: Request, res: Response) => {
  const stats = await getDashboardStats();
  sendSuccess(res, 200, 'Dashboard stats fetched', stats);
});

export const auditLogs = asyncHandler(async (req: Request, res: Response) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const result = await listAuditLogs(page, limit, req.query.entityType as string);
  sendSuccess(res, 200, 'Audit logs fetched', result);
});
```

- [ ] **Step 5: Write `src/modules/admin/admin.validation.ts`**

```typescript
import { z } from 'zod';

export const verifyUserSchema = z.object({
  verificationStatus: z.enum(['VERIFIED', 'REJECTED']),
});
```

- [ ] **Step 6: Write `src/modules/admin/admin.routes.ts`**

```typescript
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { verifyUserSchema } from './admin.validation';
import { auditLogs, dashboardStats, users, verify } from './admin.controller';

const router = Router();
router.use(authenticate, requireRole('ADMIN'));

router.get('/users', users);
router.patch('/users/:id/verify', validate(verifyUserSchema), verify);
router.get('/dashboard-stats', dashboardStats);
router.get('/audit-logs', auditLogs);

export default router;
```

- [ ] **Step 7: Mount in `src/app.ts`**

```typescript
import adminRoutes from './modules/admin/admin.routes';
app.use('/api/v1/admin', adminRoutes);
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npm test -- admin`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add admin user verification, dashboard stats, and audit log endpoints"
```

### Task 19: Redis-backed rate limit on bid placement

**Files:**
- Create: `src/middleware/bidRateLimit.ts`
- Modify: `src/modules/bids/bids.routes.ts`
- Test: `tests/bidRateLimit.test.ts`

**Interfaces:**
- Consumes: `redis` (Task 10).
- Produces: `bidRateLimit` (Express middleware, named export) — a per-buyer-per-lot limit, layered on top of the global `express-rate-limit` from Task 1 which only guards overall traffic.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/bidRateLimit.test.ts
import express from 'express';
import request from 'supertest';
import { bidRateLimit } from '../src/middleware/bidRateLimit';
import { errorHandler } from '../src/middleware/errorHandler';
import { redis } from '../src/config/redis';

const testApp = express();
testApp.use((req, _res, next) => { req.user = { id: 'rate-test-buyer', role: 'BUYER' }; next(); });
testApp.post('/lots/:id/bids', bidRateLimit, (_req, res) => res.json({ success: true }));
testApp.use(errorHandler);

afterAll(async () => {
  await redis.del('bid-rate:rate-test-buyer:lot-1');
  await redis.quit();
});

describe('bidRateLimit', () => {
  it('allows the first 5 bids on a lot within the window', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(testApp).post('/lots/lot-1/bids');
      expect(res.status).toBe(200);
    }
  });

  it('rejects the 6th bid within the same window with 429', async () => {
    const res = await request(testApp).post('/lots/lot-1/bids');
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- bidRateLimit`
Expected: FAIL (module doesn't exist)

- [ ] **Step 3: Write `src/middleware/bidRateLimit.ts`**

```typescript
import { NextFunction, Request, Response } from 'express';
import { redis } from '../config/redis';
import { ApiError } from '../utils/ApiError';

const WINDOW_SECONDS = 60;
const MAX_BIDS_PER_WINDOW = 5;

export async function bidRateLimit(req: Request, _res: Response, next: NextFunction) {
  const key = `bid-rate:${req.user!.id}:${req.params.id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  if (count > MAX_BIDS_PER_WINDOW) {
    return next(new ApiError(429, 'Too many bids on this lot — slow down and try again shortly'));
  }
  next();
}
```

- [ ] **Step 4: Add it to the bid route in `src/modules/bids/bids.routes.ts`**

```typescript
import { bidRateLimit } from '../../middleware/bidRateLimit';

router.post('/:id/bids', authenticate, requireRole('BUYER'), bidRateLimit, validate(placeBidSchema), bid);
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -- bidRateLimit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Redis-backed per-buyer rate limit on bid placement"
```

### Task 20: Deploy to Render with production Postgres and Redis

**Files:**
- Create: `render.yaml`
- Modify: `package.json` (build/start scripts already added in Task 1 — verify them here)

**Interfaces:**
- Consumes: everything built in Tasks 1–19.
- Produces: a live URL (`https://surplusbid-api.onrender.com` or similar) serving `/api/v1/health`.

- [ ] **Step 1: Write `render.yaml`** (Render's Blueprint format — lets the whole stack, including managed Postgres and Redis, be created from one file)

```yaml
services:
  - type: web
    name: surplusbid-api
    env: node
    plan: free
    buildCommand: npm install && npx prisma generate && npm run build
    startCommand: npx prisma migrate deploy && npm start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: surplusbid-db
          property: connectionString
      - key: REDIS_URL
        fromService:
          name: surplusbid-redis
          type: redis
          property: connectionString
      - key: NODE_ENV
        value: production
      - key: JWT_ACCESS_SECRET
        generateValue: true
      - key: JWT_REFRESH_SECRET
        generateValue: true

databases:
  - name: surplusbid-db
    plan: free

services2:
  - type: redis
    name: surplusbid-redis
    plan: free
    ipAllowList: []
```

- [ ] **Step 2: Push the repo to GitHub** (Render deploys from a connected repo)

```bash
git remote add origin <your-github-repo-url>
git branch -M main
git push -u origin main
```

- [ ] **Step 3: Create the Render Blueprint**

In the Render dashboard: New → Blueprint → connect the pushed GitHub repo → Render reads `render.yaml` and provisions the web service, Postgres, and Redis together.

- [ ] **Step 4: Set the remaining env vars in the Render dashboard**

Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` (pointed at the Render URL), `CORS_ORIGIN`, `DEPOSIT_PERCENT=10`, `PAYMENT_DEADLINE_HOURS=48` — these hold secrets, so they're set directly in the dashboard, never committed.

- [ ] **Step 5: Verify the live deployment**

```bash
curl https://<your-render-url>/api/v1/health
```

Expected: `{"success":true,"message":"ok","data":{"time":"..."}}`

- [ ] **Step 6: Seed the production database**

Run (Render dashboard → Shell, or a one-off job): `npx prisma db seed` — this creates the demo admin/seller/buyer accounts against production, giving the exact credentials to submit (`admin@surplusbid.com` / `Passw0rd!` — change this password before submission, see Task 22).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: add Render deployment blueprint"
```

### Task 21: Postman collection

**Files:**
- Create: `docs/SurplusBid.postman_collection.json`
- Create: `docs/SurplusBid.postman_environment.json`

**Interfaces:**
- Consumes: every endpoint built in Tasks 4–19.
- Produces: an importable Postman collection with one request per endpoint, organized into folders matching the spec's API categories (Auth, Profile, Categories, Lots, Bidding, Payments, Disputes, Admin), each request pre-filled with a sample body and using `{{baseUrl}}`/`{{accessToken}}` variables from the environment file.

- [ ] **Step 1: Build the collection in the Postman app** — rather than hand-writing ~28 requests as raw JSON (error-prone and not worth the time on a 3-day budget), use Postman itself: create a collection named "SurplusBid", add one folder per module, and for each endpoint built in Tasks 4–19 add a request with the method/path/sample body from that task's controller and Zod schema.

- [ ] **Step 2: Add a `{{baseUrl}}` collection variable** — `http://localhost:4000/api/v1` for local testing, switched to the Render URL before submission.

- [ ] **Step 3: Add a pre-request script on the collection root** that reads a collection variable `accessToken` and sets the `Authorization: Bearer {{accessToken}}` header automatically, so individual requests don't need to repeat it:

```javascript
if (pm.collectionVariables.get('accessToken')) {
  pm.request.headers.add({ key: 'Authorization', value: `Bearer ${pm.collectionVariables.get('accessToken')}` });
}
```

- [ ] **Step 4: Add a test script on the Login request** that captures the token automatically for the rest of the collection:

```javascript
const data = pm.response.json().data;
pm.collectionVariables.set('accessToken', data.accessToken);
```

- [ ] **Step 5: Run every request once against the local server** to confirm the collection actually works end-to-end (register → login → create lot → publish → deposit → bid → close via manually running the cron function → pay → verify).

- [ ] **Step 6: Export the collection and environment**

In Postman: collection `...` menu → Export → save as `docs/SurplusBid.postman_collection.json`; do the same for the environment as `docs/SurplusBid.postman_environment.json`.

- [ ] **Step 7: Publish Postman documentation** — in Postman, open the collection → "..." → View Documentation → Publish, and copy the generated public documentation URL for the submission.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: add Postman collection and published API documentation"
```

### Task 22: README, submission checklist, and demo video

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the live Render URL (Task 20), the Postman documentation URL (Task 21).

- [ ] **Step 1: Write `README.md`**

```markdown
# SurplusBid Backend

B2B industrial surplus & liquidation auction platform. See
`docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md` for the
full design.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values.
3. `npx prisma migrate dev`
4. `npx prisma db seed`
5. `npm run dev`

## Demo credentials (submission)

- Admin: `admin@surplusbid.com` / `<rotated password — see submission form>`
- Seller: `seller@surplusbid.com` / `<rotated password>`
- Buyer: `buyer@surplusbid.com` / `<rotated password>`

## Links

- Live API: `<Render URL>`
- API docs: `<Postman documentation URL>`
- Demo video: `<video URL>`
```

- [ ] **Step 2: Rotate the seeded demo passwords before submission** — `Passw0rd!` from Task 2's seed script is a development placeholder, not a credential to hand to evaluators:

```bash
node -e "require('bcrypt').hash('<new-strong-password>', 10).then(console.log)"
```

Update the three seeded users' `passwordHash` in production (via `prisma studio` against the production `DATABASE_URL`, or re-run a modified seed) with the new hash, and record the plaintext password only in the submission form — never commit it.

- [ ] **Step 3: Confirm commit count**

```bash
git log --oneline | wc -l
```

Expected: 22+ (one per task above; more if any task needed a follow-up fix commit) — clears the 20-commit minimum.

- [ ] **Step 4: Record the 5–10 minute walkthrough video**, following the assignment's required structure:
  1. Project overview and architecture (Routes → Controllers → Services → Prisma).
  2. Demonstrate all 3 roles in Postman, including a role hitting another role's endpoint and getting `403`.
  3. Demonstrate CRUD on lots (create → publish → bid → close).
  4. Trigger a validation error (bad email format) and a `404`/`401` case, showing the structured error envelope.
  5. Walk through the payment flow: deposit hold → bid → lot closes → initiate final payment → webhook confirms → status updates in the database.
  6. Explain one technical challenge in depth: the concurrency-safe bid transaction (Task 12) or the Stripe authorize/capture escrow flow (Tasks 11/15/16).

- [ ] **Step 5: Upload the video** to Loom or Google Drive (sharing set to "Anyone with the link" → Viewer) and add the URL to `README.md`.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "docs: add README with setup, demo credentials, and submission links"
```

- [ ] **Step 7: Submit** using the format from the assignment's `README.md`:

```text
Project Name    : SurplusBid — B2B Industrial Surplus & Liquidation Auction Platform
Backend Repo    : <your GitHub repo URL>
Live API        : <Render URL>
API Docs        : <Postman documentation URL>
Demo Video      : <video URL>
Admin Email     : admin@surplusbid.com
Admin Password  : <rotated password from Step 2>
```
