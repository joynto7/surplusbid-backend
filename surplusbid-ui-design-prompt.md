# SurplusBid — Complete UI Design Prompt

Paste this into Claude Design to generate the full screen set. Screens marked
**[ALREADY BUILT]** are done — skip them, or regenerate only if you want them
redone to match this system exactly.

## Product

SurplusBid is a B2B industrial surplus & liquidation auction platform.
Buyers (procurement managers, warehouse operators) bid on time-limited lots
of used equipment/inventory listed by sellers. Admins verify businesses and
resolve disputes. Standard, professional B2B SaaS dashboard style — familiar
enterprise-software conventions, easy to scan, nothing experimental.

## Visual system

- **Fonts**: "Inter" for all UI text and headings; "JetBrains Mono" for
  every number — prices, bid amounts, countdown timers, lot IDs,
  timestamps — so figures align cleanly in tables and lists.
- **Colors**: background white / `#F8FAFC`; primary text `#0F172A`,
  secondary text `#64748B`; borders `#E2E8F0`; primary action/links
  `#2563EB` (blue); success/verified/paid `#16A34A` (green);
  warning/pending/closing-soon `#D97706` (amber); danger/error/outbid
  `#DC2626` (red).
- **Components**: left sidebar navigation + top bar (search, profile menu);
  cards with 8px corner radius and a soft shadow; dense data tables for
  dashboards and admin views; pill-shaped status badges (colored by the
  semantic colors above); standard modal dialogs for actions; solid
  primary buttons + outline secondary buttons; 4/8px spacing grid.
- **Voice**: plain, direct button labels ("Place bid," "Release hold,"
  "Verify account") — never vague "Submit"/"Confirm." Empty and error
  states explain what happened and what to do next.

Desktop-first, usable down to tablet width.

---

## A. Public & Authentication

1. **Landing page** — value proposition, how it works (list → bid → win →
   pay), trust signals (verified businesses only, secure escrow deposits),
   CTA to register as Buyer or Seller.
2. **Login** — email/password fields, "Continue with Google" button, link
   to register and to forgot password.
3. **Register** — role choice (Buyer / Seller), company name, email,
   password, terms checkbox.
4. **Forgot password** — email input, confirmation message state.
5. **Reset password** — new password + confirm fields, success state.
6. **Business verification submission** — company legal name, tax/business
   ID, document upload (registration certificate), submit for review.
7. **Verification pending** — "Your account is under review" state with
   expected timeline; separate success state once approved.

## B. Buyer

8. **Buyer dashboard (home)** — active bids summary, lots closing soon,
   watchlist preview, recent notifications.
9. **Lot browse/search** — **[ALREADY BUILT]**
10. **Lot detail** — **[ALREADY BUILT]**
11. **Place-bid / deposit modal** — **[ALREADY BUILT]**
12. **My Bids / Watchlist** — **[ALREADY BUILT]**
13. **Checkout — final payment** — after winning: remaining balance owed,
    deposit already applied shown as a line item, payment method entry,
    payment deadline countdown.
14. **Payment success** — confirmation, receipt link, next steps
    (arrange pickup/delivery).
15. **Payment failed** — reason shown plainly, retry action, deadline
    remaining before the lot forfeits to the next bidder.
16. **Invoice / receipt view** — itemized: deposit, final payment, total,
    downloadable.
17. **Buyer profile & settings** — company info, saved payment methods,
    notification preferences, password/Google account management.
18. **Notifications center** — outbid alerts, "auction ending soon," "you
    won," payment reminders — list with read/unread state.
19. **File a dispute** — select order/lot, reason category, description,
    evidence upload, submit.
20. **Empty states** — one artboard showing: no search results, no active
    bids, empty watchlist — each with a short explanation and a next action.

## C. Seller

21. **Seller dashboard (home)** — active listings, ending soon, total
    sales this month, pending payouts.
22. **Lot creation wizard** — **[ALREADY BUILT]**
23. **Edit draft lot** — same form as creation, pre-filled, for unpublished
    drafts only.
24. **Seller listings table** — **[ALREADY BUILT]**
25. **Lot performance detail** — single lot: bid history graph, unique
    bidder count, view count, current status.
26. **Payouts & earnings** — completed sales list, payout status
    (pending/paid), payout history table.
27. **Seller profile & settings** — company info, payout bank/account
    details, notification preferences.
28. **Seller notifications** — "new bid on your lot," "lot sold," "dispute
    raised against your lot."

## D. Admin

29. **Admin overview dashboard** — KPI cards: active auctions, GMV,
    pending verifications, open disputes.
30. **Verification queue** — **[ALREADY BUILT, as part of admin console]**
31. **Verification detail** — one business's submitted documents, approve/
    reject with a reason field.
32. **User management** — searchable/filterable table of all users, role,
    verification status, suspend/reinstate action.
33. **Category management** — list of lot categories, create/edit/delete.
34. **Dispute queue** — **[ALREADY BUILT, as part of admin console]**
35. **Dispute resolution detail** — both parties' evidence, resolution
    options (refund, release funds, reject), decision notes.
36. **Audit log** — **[ALREADY BUILT, as part of admin console]**
37. **Platform settings** — deposit percentage default, payment deadline
    window, platform fee percentage.

## E. Shared system states

38. **404 Not Found**
39. **403 Unauthorized** — "You don't have access to this page" with a link
    back to the user's own dashboard.
40. **Session expired** — re-login prompt, preserves the page they were on.
