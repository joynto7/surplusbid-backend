# SurplusBid Backend

B2B industrial surplus & liquidation auction platform. Sellers list surplus
equipment as timed auction lots; buyers authorize a refundable deposit hold
(Stripe, manual capture) before bidding. When a lot closes, losing holds are
released automatically, the winner's deposit is applied to a final invoice
due within a deadline, and unpaid invoices roll the lot to the next-highest
bidder with the deposit forfeited.

On top of the auction engine it serves a marketplace layer (search filters,
reviews, seller profiles, public stats, contact inbox, newsletter, admin
analytics) and an AI layer built on Claude, each with a built-in fallback so
nothing breaks without an API key.

See [`docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md`](docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md)
for the original design, and [`docs/superpowers/plans/2026-09-04-surplusbid-backend.md`](docs/superpowers/plans/2026-09-04-surplusbid-backend.md)
for the task-by-task implementation plan.

## Tech stack

Node.js, Express 5, TypeScript (strict), PostgreSQL (Prisma ORM), Redis,
Stripe (authorize/capture escrow), Cloudinary (image/document uploads), JWT
auth with Google OAuth, `node-cron` for lot-closing and payment-deadline jobs,
the Anthropic SDK (Claude) for AI features, Jest + Supertest.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (local Postgres,
   local Redis, Stripe **test-mode** keys, Cloudinary, Google OAuth, and
   optionally an Anthropic API key).
3. `npx prisma migrate dev`
4. `npm run seed`
5. `npm run dev`

Run the test suite with `npm test` (point `DATABASE_URL` and `REDIS_URL` at a
throwaway test database). Run a production-equivalent build with
`npm run build && npm start`.

### Seed data

`npm run seed` is safe to re-run: it upserts the demo accounts and the 8
categories, and loads the demo catalogue only when the database has no lots.
`npm run seed:reset` **wipes every table** and loads it again (never run it
against a database you care about).

The catalogue has about 28 businesses, 50 lots (live, sold, unsold and draft)
with photos, specs and pickup locations, a realistic bid history, payments,
reviews, two disputes, contact messages and newsletter subscribers. It is
generated from a fixed random seed, so every reset looks the same.

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Postgres and Redis connections |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_*_EXPIRES_IN` | Token signing; the frontend's `JWT_ACCESS_SECRET` must match |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe test mode |
| `CLOUDINARY_*` | Uploads |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth |
| `CORS_ORIGIN` | The frontend URL |
| `DEPOSIT_PERCENT`, `PAYMENT_DEADLINE_HOURS` | Auction rules |
| `ANTHROPIC_API_KEY` | Optional. Enables Claude; without it the AI endpoints use the built-in engines |
| `AI_MODEL` | Optional. Defaults to `claude-opus-5-5` |

## API

All routes are under `/api/v1`. Responses use the envelope
`{ success, message, data }`; lists return `{ items, meta: { page, limit, total, totalPages } }`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh-token`, `/auth/logout`, `GET /auth/google` |
| Profile | `GET/PATCH /users/me` (company, tax ID, contact name, phone, location, bio), `POST /users/verify` |
| Categories | `GET /categories` (with live lot counts), `POST /categories` (admin) |
| Lots | `GET /lots` (search, category, status, price range, location, condition, seller, ids, 5 sorts, pagination), `GET /lots/:id`, `GET /lots/:id/related`, `POST /lots/:id/view`, seller CRUD + publish |
| Bidding | `POST /lots/:id/deposit`, `POST /lots/:id/bids`, `GET /lots/:id/bids`, `GET /bids/my-bids` |
| Payments | `POST /payments/initiate`, `GET /payments/my-payments`, `GET /payments/:id`, Stripe webhook |
| Disputes | `POST /disputes`, `GET /disputes/mine`, `GET /disputes` (admin, with status counts), `PATCH /disputes/:id/resolve` |
| Reviews | `GET /reviews/latest`, `POST /reviews` (winning buyer of a sold lot, once), `GET /reviews/mine`, `/reviews/reviewable`, `/reviews/received` |
| Sellers | `GET /sellers/top`, `/sellers/:id`, `/sellers/:id/reviews` |
| Public | `GET /stats`, `POST /contact`, `POST /newsletter` |
| AI | `POST /ai/chat`, `GET /ai/suggest`, `POST /ai/search-intent`, `GET /ai/recommendations`, `GET /ai/trending`, `POST /ai/listing-assist` (seller) |
| Admin | `GET /admin/users`, `PATCH /admin/users/:id/verify`, `GET /admin/dashboard-stats`, `/admin/analytics`, `/admin/ai-insights`, `/admin/audit-logs`, `GET/PATCH /admin/messages`, `GET/DELETE /admin/reviews` |

## AI features

| Endpoint | With Claude | Built-in fallback |
| --- | --- | --- |
| `/ai/chat` | Tool use (`search_lots`, `get_lot_details`, `marketplace_overview`) through the SDK's tool runner | Knowledge base + lot search |
| `/ai/search-intent` | Structured output (Zod schema) turns a sentence into filters | Heuristic parser for categories, prices, locations, conditions and sorts |
| `/ai/suggest` | — | Typo-tolerant suggestions (edit distance) with a preview of the parsed intent |
| `/ai/recommendations`, `/ai/trending` | — | TF-IDF similarity over recently viewed lots; activity-weighted trending |
| `/ai/listing-assist` | Writes the description and specs | Template writer that also extracts specs from notes; price guidance from comparable sales either way |
| `/admin/ai-insights` | Writes the narrative summary | Rule-based summary; z-score anomaly detection either way |

Every response carries `mode: "ai" | "smart"`. Claude calls use a 45-second
timeout, low effort and the server-side refusal fallback, and a failed call
falls back to the built-in result instead of an error. Chat is rate limited
to 20 messages per 10 minutes per user or IP.

## Demo credentials (submission)

The seed creates three demo accounts. On a fresh database they get the
password defined in `prisma/seed.ts`; existing accounts keep theirs. The live
deployment's passwords are given only in the assignment submission form,
never committed here.

- Admin: `admin@surplusbid.com`
- Seller: `seller@surplusbid.com` (Acme Surplus Co)
- Buyer: `buyer@surplusbid.com` (Contoso Industrial)

## Links

- Live API: https://surplusbid-backend-1.onrender.com/api/v1
- API docs (Postman): https://documenter.getpostman.com/view/56417304/2sBYAxPUve
- Demo video: `<video URL>`

## Postman collection

Import both files from `docs/` into Postman:
- `SurplusBid.postman_collection.json` — every endpoint, organized by
  module. A collection-level pre-request script attaches
  `Authorization: Bearer {{accessToken}}` automatically once you've logged
  in once.
- `SurplusBid.postman_environment.json` — sets `baseUrl`; point it at
  `http://localhost:4000/api/v1` for local testing or
  `https://surplusbid-backend-1.onrender.com/api/v1` for the live deployment.
