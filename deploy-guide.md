# Tapcard PH NFC — Deployment & Security Operations Guide

This guide details how to operate, test, and deploy the **Owner-Only Access & Multi-User Payment System** for Tapcard PH NFC.

---

## 1. Quick Local Start (No Node Installation Required)

The entire application includes a **pure Web Cryptography & RFC 6238 TOTP Engine** (`auth-core.js`). You can open and test it immediately in any web browser!

1. Open `index.html` in your browser.
2. Browse products, add to cart, and click **Continue to Checkout**.
3. Enter customer details (Name, Mobile Number, Address, and Custom Note) and place an order.
4. The system issues a unique, private tracking link (e.g. `track.html?token=tc_track_...`).
5. Open `setup-2fa.html` to configure your master Owner Email, Password, and scan the **Google Authenticator QR code** using your phone.
6. Open `login.html`, log in with your credentials + 6-digit Google Authenticator code, and access `admin.html` to view all orders and analytics!

---

## 2. Server Deployment (Node.js + Express + SQLite)

For cloud hosting (Render, Railway, Fly.io, DigitalOcean, or AWS):

### Prerequisites
- Node.js 18+

### Setup Commands
```bash
# Install dependencies
npm install

# Start production server
npm start
```

### URLs on Server
- Storefront: `http://localhost:3000/index.html`
- Customer Tracking: `http://localhost:3000/track.html`
- Owner Setup: `http://localhost:3000/setup-2fa.html`
- Owner Login: `http://localhost:3000/login.html`
- Owner Dashboard: `http://localhost:3000/admin.html`

---

## 3. Firebase Serverless Deployment

If you prefer completely serverless hosting on Google Firebase:

```bash
# Install Firebase CLI (if not already installed)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize project
firebase init firestore
firebase init hosting

# Deploy firestore rules & hosting
firebase deploy
```

The included `firestore.rules` file enforces that:
- Customers can only read and update their own order matching `trackingToken`.
- Only the authenticated Owner UID has access to `/analytics`, `/settings`, and all customer orders.

---

## 4. Security Verification & Test Scenarios

### Scenario A: Public URL Sharing (The "100 Visitors" Test)
1. Share your public storefront link (`https://yourdomain.com/index.html`) with 100 people.
2. Each visitor can browse, checkout, and submit payment.
3. If any visitor navigates to `/admin.html` or `/api/admin/*`, the system displays the **Strict Access Lock Screen** or returns `HTTP 401 Unauthorized`.
4. Knowing or sharing the URL will never expose business data, analytics, or other customer orders.

### Scenario B: IDOR (Insecure Direct Object Reference) Test
1. Customer A places Order `#1` and receives tracking link `track.html?token=tc_track_1a2b...`.
2. Customer B places Order `#2` and receives tracking link `track.html?token=tc_track_3c4d...`.
3. If Customer A tries to access Order `#2` by altering parameters or guessing sequential numbers, the system displays `Order Not Found`.
4. Only the authenticated Owner in `admin.html` can see all orders across the business.

### Scenario C: Two-Factor Authentication (TOTP) Test
1. An attacker guessing or obtaining the Owner password attempts to log in at `login.html`.
2. The login flow immediately halts at Step 2 and requires the live 6-digit code from the Owner's physical smartphone running **Google Authenticator**.
3. Without the physical phone, access is strictly denied.
