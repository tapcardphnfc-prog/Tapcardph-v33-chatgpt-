# Tapcard PH NFC V32 P499 — Security / Launch Fixes Applied

This build keeps the existing storefront architecture and UI, while fixing the launch-blocking issues found in the audit.

## Fixed

- Storefront checkout now creates the real order through `/api/orders/checkout` so PostgreSQL, Owner Dashboard, tracking tokens, and server-side Gmail notifications stay synchronized.
- Web3Forms remains a non-blocking backup notification after a successful backend order/payment update.
- Payment-reference updates from the storefront now update the PostgreSQL order instead of being Web3Forms-only.
- Owner session cookie now uses `path: '/'`, fixing authenticated `/api/admin/*` requests after login.
- Exact CORS origin matching replaces prefix matching.
- Authenticated state-changing admin requests reject disallowed origins.
- Public checkout/payment/message write endpoints have rate limiting.
- Customer input length/type validation was tightened.
- Checkout order + items + customer note are written in one PostgreSQL transaction.
- Admin order loading avoids the previous N+1 query pattern.
- Admin revenue counts only verified/completed orders.
- Admin dashboard output escapes customer-controlled text to prevent stored XSS.
- Payment screenshots are validated as image data URLs and are no longer returned by the public tracking endpoint.
- Security headers and `no-store` API caching were added.
- Password-reset codes use cryptographically secure randomness.
- `TapcardCore` is explicitly exposed on `window`, restoring compatibility with code that calls `TapcardCore.getOrCreateDeviceId()`.
- The storefront merges live backend product prices so the displayed checkout price cannot silently diverge from the server's authoritative price.
- First-time Owner setup now requires the private `OWNER_SETUP_KEY` environment variable.

## Required Render / backend environment variable

Set a strong private value before using `/setup-2fa.html` for the first Owner account:

`OWNER_SETUP_KEY=<long-random-private-value>`

Do not put this value in frontend JavaScript, HTML, Git, or public documentation.

Existing production variables should remain configured, including `DATABASE_URL`, `FRONTEND_URL`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `OWNER_NOTIFICATION_EMAIL` where applicable.

## Validation performed

- Node syntax checks passed for `server.js`, `database.js`, and `auth-core.js`.
- Inline JavaScript syntax checks passed for the storefront, admin, tracking, login, setup, and forgot-password pages.
- Static scan found no private database/Gmail credentials embedded in the frontend files.

A real production deployment test is still required for Render/PostgreSQL/Gmail/Web3Forms because those external services cannot be fully exercised from the offline audit environment.
