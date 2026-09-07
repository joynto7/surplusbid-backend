# SurplusBid Backend

B2B industrial surplus & liquidation auction platform. Sellers list surplus
equipment as timed auction lots; buyers authorize a refundable deposit hold
(Stripe, manual capture) before bidding. When a lot closes, losing holds are
released automatically, the winner's deposit is applied to a final invoice
due within a deadline, and unpaid invoices roll the lot to the next-highest
bidder with the deposit forfeited.

See [`docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md`](docs/superpowers/specs/2026-09-04-surplusbid-backend-design.md)
for the full design, and [`docs/superpowers/plans/2026-09-04-surplusbid-backend.md`](docs/superpowers/plans/2026-09-04-surplusbid-backend.md)
for the task-by-task implementation plan.

## Tech stack

Node.js, Express, TypeScript, PostgreSQL (Prisma ORM), Redis, Stripe
(authorize/capture escrow), Cloudinary (image/document uploads), JWT auth
with Google OAuth, `node-cron` for lot-closing and payment-deadline jobs.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in real values (local Postgres,
   local Redis, Stripe **test-mode** keys, Cloudinary, Google OAuth).
3. `npx prisma migrate dev`
4. `npx prisma db seed`
5. `npm run dev`

Run the test suite with `npm test`. Run a production-equivalent build with
`npm run build && npm start`.

## Demo credentials (submission)

The seed script (`prisma/seed.ts`) creates three demo accounts, all
originally on a placeholder password. That placeholder has since been
rotated on the live deployment — the real passwords are given only in the
assignment submission form, never committed here.

- Admin: `admin@surplusbid.com` / `<rotated password — see submission form>`
- Seller: `seller@surplusbid.com` / `<rotated password — see submission form>`
- Buyer: `buyer@surplusbid.com` / `<rotated password — see submission form>`

## Links

- Live API: https://surplusbid-api.onrender.com
- API docs (Postman): https://documenter.getpostman.com/view/56417304/2sBYAxPUve
- Demo video: `<video URL>`

## Postman collection

Import both files from `docs/` into Postman:
- `SurplusBid.postman_collection.json` — every endpoint, organized by
  module (Auth, Profile, Categories, Lots, Bidding, Payments, Disputes,
  Admin). A collection-level pre-request script attaches
  `Authorization: Bearer {{accessToken}}` automatically once you've logged
  in once.
- `SurplusBid.postman_environment.json` — sets `baseUrl`; point it at
  `http://localhost:4000/api/v1` for local testing or
  `https://surplusbid-api.onrender.com/api/v1` for the live deployment.
