# SurplusBid Backend — Design Spec

**Date**: 2026-09-04
**Assignment**: Apollo Level2 Web Dev B7A6 (backend-only REST API assignment)
**Requirements source**: https://github.com/Apollo-Level2-Web-Dev/B7A6 (`project_requirements.md`, `README.md`)

## 1. What this is

SurplusBid is a B2B industrial surplus & liquidation auction platform.
Sellers list surplus equipment/inventory as timed auction lots. Buyers
place competing bids; the highest bid when the clock runs out wins. To
bid, a buyer must first authorize a refundable deposit hold on their card
(Stripe, `capture_method: manual`) — no charge happens yet. When a lot
closes: losing buyers' holds are released automatically; the winner's held
deposit is applied toward a final invoice they must pay within a deadline,
or the lot rolls to the next-highest bidder and the deposit is forfeited.

This satisfies the assignment's "choose a unique project outside the idea
hub" allowance (not e-commerce, not in `idea-hub.md`), and its "hard to
implement" backend challenges are: race-condition-safe bid placement,
a real authorize/capture escrow payment flow (not a fake status field),
and a deadline-driven settlement state machine.

## 2. Roles (the 3 required, strictly enforced)

| Role | Can do |
|---|---|
| **Buyer** | Browse/search lots, authorize deposit, place bids, view own bid history, pay final invoice, watchlist, file disputes |
| **Seller** | Create/edit/publish own lots, view bids on own lots, view own payouts, respond to disputes on own lots |
| **Admin** | Verify buyer/seller business accounts, manage categories, resolve disputes, view audit logs & platform stats, manage users |

RBAC middleware checks `req.user.role` against each route's allowed roles.
A Buyer hitting a Seller-only or Admin-only route gets `403 Forbidden`.

## 3. Data model (Prisma / PostgreSQL)

Core entities and relationships:

- **User** — `id, email, passwordHash (nullable), authProvider (LOCAL|GOOGLE), googleId (nullable), role (BUYER|SELLER|ADMIN), companyName, taxId, verificationStatus (UNVERIFIED|PENDING|VERIFIED|REJECTED), createdAt, deletedAt`
- **Category** — `id, name, slug`
- **Lot** — `id, sellerId → User, categoryId → Category, title, description, images (string[]), condition, quantity, startingPrice, reservePrice (hidden from buyers until close), bidIncrement, startTime, endTime, status (DRAFT|PENDING_APPROVAL|LIVE|ENDED|SOLD|UNSOLD|CANCELLED), currentHighestBidId (nullable, self-relation to Bid), deletedAt`
- **Bid** — `id, lotId → Lot, buyerId → User, amount, status (ACTIVE|OUTBID|WINNING), createdAt` (append-only; never updated in place, only status flips)
- **DepositHold** — `id, lotId → Lot, buyerId → User, stripePaymentIntentId, amount, status (AUTHORIZED|CAPTURED|RELEASED|FAILED), createdAt` — one per (buyer, lot)
- **Payment** — `id, lotId → Lot, buyerId → User, stripePaymentIntentId, amount, status (PENDING|SUCCEEDED|FAILED|REFUNDED), dueAt, paidAt`
- **Dispute** — `id, lotId → Lot, raisedById → User, reason, description, status (OPEN|UNDER_REVIEW|RESOLVED|REJECTED), resolutionNote, resolvedById → User (nullable), createdAt`
- **AuditLog** — `id, actorId → User, action, entityType, entityId, metadata (JSON), createdAt`

**Indexes**: `Lot(status, endTime)` (cron sweep), `Lot(categoryId, status)`
(filtered browse), `Bid(lotId, createdAt)` (bid history), `User(email)`
unique.

## 4. Core workflows

### 4.1 Auth
Email/password (bcrypt-hashed) and Google OAuth (GCP), both issuing the
same JWT access token (short-lived) + refresh token (longer-lived,
rotated on use). `authProvider` distinguishes login method; Google-issued
accounts have no `passwordHash`.

### 4.2 Lot lifecycle
`DRAFT → LIVE → ENDED → (SOLD | UNSOLD)`, with `CANCELLED` reachable from
`DRAFT`. A verified seller publishes a draft straight to `LIVE` — no
separate per-lot admin approval step. (The real gatekeeping is admin
verification of the *seller's business account* in §4.1/§2, not a
second review of every listing — cut to fit the 3-day target deadline;
add a `PENDING_APPROVAL` step back later if moderation becomes a
problem.)

### 4.3 Concurrency-safe bidding (the core hard problem)
Placing a bid runs inside a single Prisma `$transaction`:
1. Row-lock the `Lot` with `SELECT ... FOR UPDATE` via `$queryRaw` as the
   first statement inside the transaction.
2. Re-read the current highest bid within the transaction.
3. Reject if `amount < currentHighestBid + bidIncrement`, or if the lot
   isn't `LIVE`, or if the buyer has no `AUTHORIZED` `DepositHold` for
   this lot.
4. Insert the new `Bid` (`WINNING`), flip the previous winning bid to
   `OUTBID`, update `Lot.currentHighestBidId`.
5. **Anti-sniping**: if `now > endTime - 2min`, extend `endTime` by 2
   minutes, in the same transaction.

This serializes concurrent bids on the same lot so two simultaneous bids
can never both be recorded as winning.

### 4.4 Deposit / escrow payment flow
- `POST /lots/:id/deposit` creates a Stripe PaymentIntent
  (`capture_method: manual`) for `startingPrice * DEPOSIT_PERCENT`, where
  `DEPOSIT_PERCENT` is a single platform-wide setting (env-configured in
  v1, default 10%; not editable per-lot), stores a `DepositHold` as
  `AUTHORIZED`. A buyer needs exactly one active hold per lot to bid.
- On lot close (cron job, below): every `AUTHORIZED` hold except the
  winner's is cancelled via Stripe (`PaymentIntent.cancel`) →
  `DepositHold.status = RELEASED`. The winner's hold is left `AUTHORIZED`
  pending final payment.
- Winner has `paymentDeadlineHours` (default 48h) to complete
  `POST /payments/initiate` → capture the deposit hold + charge the
  remaining balance → Stripe webhook (`POST /payments/webhook`) confirms
  → `Payment.status = SUCCEEDED`, `DepositHold.status = CAPTURED`.
- **Missed deadline**: a scheduled sweep finds `Payment.status = PENDING`
  past `dueAt`, forfeits the deposit (`DepositHold` stays `CAPTURED` but
  is recorded as forfeited revenue, not refunded), sets `Lot` back to
  settle with the next-highest `Bid`, and repeats the deposit/payment
  cycle for that buyer.

### 4.5 Scheduled job
`node-cron`, every minute, in-process (deployment target is Render, a
persistent Node process — see §6): sweeps `Lot` rows where
`status = LIVE AND endTime <= now` and runs the close/settle logic in
§4.3–4.4; separately sweeps `Payment` rows past `dueAt` for the
forfeiture/rollover logic.

### 4.6 Disputes
Either party (buyer or seller) can file a `Dispute` against a lot. Admin
reviews and resolves it (`RESOLVED`/`REJECTED`) with a note; resolution
is logged to `AuditLog`. No automated refund logic tied to disputes in
v1 — resolution is a recorded decision; any refund is a manual Stripe
action by the admin outside the API (documented as a known limitation,
not built, per YAGNI — nothing in the requirements demands automated
dispute-triggered refunds).

## 5. API surface

All routes under `/api/v1`. Response envelope on every endpoint:
`{ success, message, data }` or `{ success: false, message, errors }`.

- **Auth** (4): register, login, refresh-token, logout
- **OAuth** (1): Google OAuth callback
- **Profile** (3): `GET /users/me`, `PATCH /users/me`,
  `POST /users/verify` (submit business verification docs)
- **Categories** (2): `GET /categories`, `POST /categories` (admin)
- **Lots** (7): create, list (pagination + filter by category/status +
  sort + keyword search), get by id, update (draft only), soft-delete,
  publish, `GET /lots/my-listings` (seller)
- **Bidding** (4): create deposit hold, place bid, `GET /lots/:id/bids`
  (paginated history), `GET /bids/my-bids`
- **Payments** (4): initiate, webhook, get by id, `GET /payments/my-payments`
- **Disputes** (2): create, admin resolve
- **Admin** (4): list users (paginated/filterable), verify user,
  dashboard stats, audit logs (paginated/filterable)

Total: 28 endpoints — clears the 20+ minimum without padding; every one
maps to an actual workflow above, none are dummy CRUD for the count.
(Watchlist and per-lot admin approval were cut for the 3-day target —
see §8.)

## 6. Non-functional / rubric coverage

- **Validation & error handling**: Zod schemas on every POST/PATCH body; a
  single centralized Express error-handling middleware converts every
  thrown error (validation, Prisma, Stripe, auth) into the standard
  `{ success: false, message, errors }` envelope — no per-route try/catch
  duplicating this logic.
- **Query efficiency**: Prisma reads use explicit `select`/`include` for
  the fields each endpoint actually returns, not full-row fetches, per
  the assignment's performance guideline.
- **Security**: bcrypt password hashing, `helmet`, `cors` restricted to
  configured origins, `express-rate-limit` globally, plus a tighter
  Redis-backed rate limit specifically on the bid-placement endpoint
  (per buyer per lot) to block bid-spam.
- **Redis**: caches each live lot's current highest bid (read-heavy
  during active bidding), invalidated on every accepted bid.
- **Transactions**: bid placement (§4.3) and lot settlement (§4.4) are
  the two places correctness depends on atomicity.
- **Soft deletes**: `Lot.deletedAt`, `User.deletedAt`.
- **Audit log**: every admin action (verify, resolve dispute, approve
  lot) and every `Lot`/`Payment` status transition.
- **Pagination/filter/search**: `GET /lots` supports all three;
  `GET /admin/users` and `GET /admin/audit-logs` support pagination +
  filter.

## 7. Tech stack & deployment

Node.js + TypeScript + Express, PostgreSQL + Prisma, Zod, Redis
(ioredis), Stripe, Multer + Cloudinary (lot images), JWT (`jsonwebtoken`),
Passport Google OAuth strategy, `bcrypt`, `helmet`, `cors`,
`express-rate-limit`, `node-cron`. Deployed on **Render** as a persistent
web service (chosen specifically so the in-process cron job works —
Vercel serverless functions don't stay alive for a `node-cron` process).

## 8. Out of scope / explicit assumptions

- **Target is the Sept 7 deadline (60 marks), 3 days out from this spec.**
  Cut for time (none are mandatory rubric items): watchlist, per-lot admin
  approval (§4.2), seller payout/earnings reporting. All can be added back
  after submission without touching the core data model.
- No real-time transport (WebSockets/SSE) — bid updates are pull-based
  (poll `GET /lots/:id`, cached in Redis to keep it cheap). Nothing in
  the requirements demands push updates; adding one would be scope the
  assignment doesn't ask for.
- No automated dispute-triggered refunds (§4.6).
- No multi-currency support — single currency (USD) throughout.
- Seed script provides one demo user per role, including the admin
  credentials required for submission.
