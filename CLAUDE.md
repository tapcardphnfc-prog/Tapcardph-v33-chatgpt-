# Tapcard PH NFC V19.2 — Claude Code Base Instructions

## 1. Baseline rule
Treat **Tapcard PH NFC V19.2 as the FINAL BASELINE**.

This project is a production-oriented Tapcard PH NFC storefront/admin system. Make the **smallest possible patch** that solves the user's requested problem.

### Never do this unless explicitly requested
- Do not redesign the UI.
- Do not rewrite the application.
- Do not migrate to another framework.
- Do not replace Express/PostgreSQL/SQLite compatibility with Firebase, Prisma, Supabase, etc.
- Do not replace the authentication/2FA architecture.
- Do not remove existing functionality to solve an unrelated bug.
- Do not reset/drop production databases.
- Do not run destructive Git commands.

Preserve the V18.1 visual design, branding, navigation, product presentation, owner dashboard, authentication, 2FA, NFC functionality, and order flow unless the user explicitly asks for a change.

## 2. Current V18.1 customer payment flow
Customer payment methods are:
- GCash
- Maribank
- Union Bank
- Cash On Delivery (COD)

For GCash/Maribank/Union Bank:
- Display the configured account number.
- Provide a clear Copy button.
- Customer pays manually.
- Customer can submit payment reference number and amount paid when applicable.
- Do not reintroduce an online payment gateway or payment screenshot upload unless explicitly requested.

For Cash On Delivery:
- Do not request an account number.
- Do not request online payment details.
- Tell the customer to pay the order amount to the delivery rider upon delivery.
- Include COD clearly in the order notification.

## 3. Delivery fee
The delivery fee is **owner-editable** from the Owner Dashboard.

Rules:
- The owner can change the delivery fee from the admin settings.
- The fee applies to new orders.
- Existing orders must retain the delivery fee/total they were created with.
- Keep a sensible static storefront fallback in `config.js` for cases where the Netlify frontend cannot reach the backend.
- Do not expose owner-only settings as a client-side authorization mechanism; server-side authorization remains authoritative.

## 4. Current order submission
The customer storefront intentionally does not depend on a missing `/api/orders/checkout` endpoint for the current Netlify checkout flow.

Customer orders are submitted through **Web3Forms** and should include all customer-filled checkout information as explicit top-level fields, including:
- order number / identifier
- customer name
- mobile number
- email
- complete delivery / business address
- customer notes
- payment method
- payment account number and account name when applicable
- ordered products, formats, quantities, and item count
- subtotal
- service fee
- delivery fee
- order total
- payment status
- receipt/payment type status
- payment reference status
- receipt channel
- order terms accepted
- NFC finalization acknowledgement
- submission timestamp

For non-COD orders, the customer enters the final receipt/payment type and reference number after the initial order is submitted. Those final payment details are recorded in a separate Web3Forms **Payment Details Update** submission for the same order number.

The order notification and final payment-details update are intended for the Tapcard PH order inbox configured through the Web3Forms access key.

Do not add a customer tracking-link requirement unless explicitly requested.

## 5. Existing backend architecture
The project uses:
- Node.js
- Express
- PostgreSQL/SQLite compatibility
- bcryptjs
- cookie-parser
- CORS
- express-rate-limit
- Nodemailer
- OTP/TOTP via otplib
- QR code generation

Important existing API areas include products, payment settings, delivery fee settings, orders, tracking, order history, owner authentication, password reset, and 2FA.

Before changing a frontend API call:
1. Check whether the endpoint exists in `server.js`.
2. Check `config.js` for `window.TAPCARD_API_BASE`.
3. Determine whether the frontend is same-origin or cross-origin.
4. Fix the root cause rather than inventing a duplicate endpoint.

## 6. Security rules
Preserve:
- server-side owner authentication
- httpOnly owner session cookies
- server-side 2FA verification
- password hashing
- authentication rate limiting
- server-side authorization for owner/admin routes
- server-side validation
- CORS protections

Never place these in frontend files:
- database passwords
- JWTs
- session cookies
- private API keys
- Gmail passwords/app passwords
- TOTP secrets

Do not create client-side admin bypasses.

## 7. Error-fixing workflow
When the user provides a browser-console error or deployment error:
1. Identify the exact failing URL/file/line.
2. Trace it through the existing V13 code.
3. Confirm whether the route actually exists.
4. Fix only the root cause.
5. Avoid unrelated refactoring.
6. Test the affected path.
7. Report the exact files changed and what was intentionally left untouched.

For a 404, do not blindly create a new API route. First determine why the current request is being made and whether V13 intentionally uses Web3Forms/static fallback instead.

## 8. Database safety
Never:
- drop tables
- reset production data
- delete customer orders
- overwrite the production database

Prefer additive, backward-compatible changes. If schema changes are required, preserve existing data and use safe migrations/`IF NOT EXISTS` patterns consistent with the current project.

## 9. Testing checklist
For checkout/payment changes, verify:
- products display
- delivery fee displays
- owner-edited delivery fee is reflected for new orders
- GCash account number displays and Copy works
- Maribank account number displays and Copy works
- Union Bank account number displays and Copy works
- COD displays without an account number
- COD order notification clearly says Cash On Delivery
- Web3Forms receives the complete order
- order confirmation appears after successful submission

For owner/admin changes, verify:
- owner login works
- 2FA remains enforced
- unauthorized users cannot access owner settings
- delivery fee edits are owner-only

## 10. Claude Code behavior
Before editing, inspect the relevant existing code. Do not assume the architecture.

When finished, report:
- Root cause / requested change
- Files changed
- What was preserved
- Tests performed
- Any remaining limitation

Keep changes minimal and production-safe.

## 11. User preference
The user explicitly wants the current Tapcard PH NFC design preserved. Favor **small, targeted patches over rewrites**.


## 12. Order review and final-confirmation flow
The storefront now has a sticky **View Order** button in the top navigation. Preserve it.

The intended customer flow is:
1. Customer adds products.
2. Customer can tap **View Order** at any time to review the current cart.
3. The order review screen allows quantity changes and item removal.
4. Customer continues to checkout only after reviewing/editing the cart.
5. The final checkout screen requires explicit acceptance of the order-finalization notice before submission.
6. The final notice explains that after confirmation, changes/cancellations may no longer be possible because the NFC domain/link may be programmed or embedded into the physical chip during fulfillment.
7. The accepted finalization notice must be included in the Web3Forms notification so the owner can verify that the customer acknowledged it.

Do not weaken or remove the required confirmation checkbox. Do not allow the final order to be submitted while the checkbox is unchecked.

## 13. Order-review UI preservation
- Keep the existing current visual design and spacing.
- Keep the top **View Order** action visible/sticky on desktop and mobile.
- Keep cart quantity editing available.
- The checkout modal must include a clear **Review / Edit Order** action.
- Do not make the customer hunt through the page to edit their order before final confirmation.
- Do not imply that an order can be edited after final confirmation.

## V14.1 small patch
- Non-COD customers can open the Tapcard PH Messenger account from the final order confirmation to send payment reference + receipt screenshot.
- The site copies an order-specific receipt message to the clipboard; the customer adds the reference number and attaches the screenshot in Messenger.
- The order email now records payment as PENDING — OWNER VERIFICATION REQUIRED for manual-payment methods. COD remains PAY ON DELIVERY.
- No payment gateway, automatic payment verification, new backend architecture, or database migration was added.
- Treat V19.2 as the current architecture/structure baseline; future changes remain small patches only.



## Historical receipt-flow notes
- Do not redesign or restructure the project. Preserve all existing architecture, UI, backend, auth/2FA, COD, Web3Forms, payment accounts, and Messenger behavior.

## 6. Current final confirmation/payment-receipt flow
For non-COD orders:
- Customer selects the receipt/payment type (GCash, Maribank, or Union Bank).
- The receipt type must match the payment method selected at checkout.
- Customer enters the payment reference number.
- Customer taps **Done** to save the payment details.
- The payment type/reference are recorded to Web3Forms in a separate **Payment Details Update** submission for the same order number.
- Only after the payment details are saved is the **Send Receipt via Messenger** step shown.
- Messenger opens `https://m.me/NFCTapCardPh`. The customer attaches the receipt screenshot manually.
- A normal Messenger link cannot reliably attach an image automatically.
- Do not redesign this flow or move it earlier unless explicitly requested.

The confirmation modal also includes the Tapcard PH thank-you message, 3–10 minute verification notice, high-order-volume apology, and an X close button that returns the customer to the browser page.

For COD:
- Keep the existing COD confirmation flow unchanged.
- Do not request receipt type or reference number.


## V19.2 small patch — final receipt action / Botcake Messenger
- V19.2 is based directly on the uploaded V19 codebase.
- For GCash, Maribank, and Union Bank, the final confirmation action is **Please Send Receipt**.
- The customer enters the receipt/payment type and reference number, then **Please Send Receipt** records the final payment details to Web3Forms and opens the configured Botcake Messenger Ref URL.
- The receipt screenshot is still attached manually by the customer in Messenger.
- Cash On Delivery is excluded from the receipt workflow: no receipt type, reference number, Botcake receipt button, or online-payment prompt is shown. COD keeps the normal thank-you/Done confirmation.
- The Botcake page token is not placed in browser code. Botcake's Messenger Ref URL is used for the customer-facing handoff.
- Configure `window.TAPCARD_BOTCAKE_RECEIPT_URL` in `config.js` to the exact Botcake Messenger Ref URL if a different Ref URL is created.
