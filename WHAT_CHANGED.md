# What changed — Tapcard PH NFC V19.1

## Small patch only
V19.1 is based directly on the uploaded **Tapcard PH NFC V19** codebase. No architecture or visual redesign was made.

### Final receipt step
- Online payment methods (GCash, Maribank, Union Bank) now finish the confirmation workflow with **Please Send Receipt**.
- The button saves the receipt/payment type and reference number to the existing Web3Forms Payment Details Update, then opens the configured Botcake Messenger Ref URL.
- The customer manually attaches the payment receipt screenshot in Messenger.
- The order-specific receipt message is copied to the clipboard.

### Cash On Delivery
- COD is excluded from the receipt/payment-reference workflow.
- COD does not show receipt fields or the Botcake receipt button.
- COD keeps the normal thank-you confirmation and Done action.

### Botcake
- Added `TAPCARD_BOTCAKE_RECEIPT_URL` to `config.js`.
- Default: `https://m.me/111145857242731?ref=tapcard_receipt`.
- The supplied Botcake API token is intentionally not placed in client-side code. Direct Botcake API calls require a customer PSID and flow ID; the Messenger Ref URL is the appropriate customer-facing handoff for this checkout flow.

### Preserved
- V19 storefront design
- Web3Forms order recording
- Web3Forms payment-details update
- COD
- payment accounts
- checkout/review flow
- authentication/2FA
- owner dashboard
- NFC functionality
- existing backend architecture


## V19.2 clarification patch
- The thank-you verification message now applies to all orders, including COD and online payments.
- The verification window is **3–10 minutes**.
- The message says Tapcard PH is verifying and processing the order and explains the delay is due to a high volume of customer orders.
- COD remains: Thank You → 3–10 minute verification notice → Done.
- Online payment remains: Thank You → payment details → Please Send Receipt → Messenger/Botcake.
- No architecture or visual redesign.


## V20.2 — Confirmation Flow Patch
- Online payment: payment type + reference are completed first, then customer taps Done.
- After Done, the Thank You + 3–10 minute verification message appears, followed by Please Send Receipt for Messenger/Botcake.
- COD: Done → Thank You → 3–10 minute verification message stating that Tapcard PH will send a Messenger or text update. No receipt/Botcake step.
- No architecture redesign.


## V31 — Product category and format structure
- Implemented category-specific product options and prices from the approved V30 structure.
- Set every NFC Standee option to ₱999.
- Social Media Card now offers Business Card (₱899) and NFC SafeTag Size (₱599), with buy 3 get 1 NFC SafeTag Size free.
- Added visible selected-option labels and promotion details in the catalog/cart/order summary.
- Preserved V29 layout and existing checkout/authentication behavior.
