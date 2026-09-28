require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { randomInt } = require('crypto');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { pool, initDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_LIFETIME_HOURS = 2;

// CORS — allow your Netlify frontend to call this backend
const allowedOrigins = Array.from(new Set([
  process.env.FRONTEND_URL,
  'https://tapcardphnfc.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
].filter(Boolean).map(o => o.replace(/\/$/, ''))));

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// The four physical formats every purchasable product can be ordered in, and the JSON key
// each is stored under on `products.variants`. Shared by checkout verification and the
// admin pricing endpoint so both sides always agree on what a "format" is.
const PRODUCT_FORMATS = {
  business_card: 'Business Card',
  standee: 'NFC Standee',
  sticker: 'NFC Sticker / Square',
  safetag_circle: 'NFC Safetag Circle'
};

// Raised limit (default is 100kb) so a base64-encoded GCash payment screenshot can be submitted
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());

// Baseline security headers. Keep the storefront architecture unchanged while
// preventing MIME sniffing, framing, and accidental referrer leakage of tracking URLs.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Only accept image data URLs, and cap the effective image size (base64 is ~33% larger than raw bytes)
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5MB
function isValidScreenshotDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return false;
  const approxBytes = (match[2].length * 3) / 4;
  return approxBytes <= MAX_SCREENSHOT_BYTES;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
}

// Rate Limiter for Authentication to prevent brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' }
});

// Public write endpoints need abuse protection too. These are intentionally separate
// from the stricter owner-auth limiter so normal shoppers can still browse freely.
const customerWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});

// ── PostgreSQL helpers (param style: $1, $2, ...) ──────────────────────────
const dbGet = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};
const dbAll = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows;
};
const dbRun = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  // Emulate SQLite's `this.lastID` for INSERT ... RETURNING id
  return { lastID: result.rows[0]?.id || null, changes: result.rowCount };
};

// In-Memory Temporary Password Reset Codes (Code -> { email, expiresAt })
const resetCodes = new Map();

// -------------------------------------------------------------
// GMAIL NOTIFICATION SERVICE
// -------------------------------------------------------------
let mailTransporter = null;

if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  console.log(`[Gmail] Notification service configured for: ${process.env.GMAIL_USER}`);
} else {
  console.log('[Gmail] Notice: GMAIL_USER or GMAIL_APP_PASSWORD not set in .env. Notifications will be logged to console.');
}

async function sendGmailAlert(subject, htmlContent, textContent) {
  const recipient = process.env.OWNER_NOTIFICATION_EMAIL || process.env.GMAIL_USER;
  console.log(`\n================== [OWNER NOTIFICATION] ==================`);
  console.log(`Subject: ${subject}`);
  console.log(`To: ${recipient || 'Owner'}`);
  console.log(`==========================================================\n`);

  if (!mailTransporter || !recipient) return false;

  try {
    await mailTransporter.sendMail({
      from: `"Tapcard PH NFC Alerts" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: subject,
      text: textContent || htmlContent.replace(/<[^>]*>/g, ''),
      html: htmlContent
    });
    console.log(`[Gmail] Alert successfully delivered to: ${recipient}`);
    return true;
  } catch (err) {
    console.error(`[Gmail] Delivery error:`, err.message);
    return false;
  }
}

// Middleware: Strict Server-Side Owner Authorization
async function requireOwner(req, res, next) {
  const origin = req.get('origin');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Request origin is not allowed.' });
  }

  const sessionToken = req.cookies.tapcard_owner_session || req.headers['x-owner-session'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized: Owner session required.' });
  }

  try {
    const session = await dbGet(
      `SELECT s.*, u.email FROM admin_sessions s 
       JOIN admin_users u ON s.user_id = u.id 
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [sessionToken]
    );

    if (!session) {
      res.clearCookie('tapcard_owner_session', { path: '/', sameSite: 'none', secure: true });
      return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }

    req.owner = { id: session.user_id, email: session.email };
    next();
  } catch (err) {
    console.error('Session validation error:', err);
    res.status(500).json({ error: 'Internal security verification error.' });
  }
}

// -------------------------------------------------------------
// 0. HEALTH CHECK ENDPOINT
// -------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Tapcard PH NFC',
    gmailEnabled: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && mailTransporter),
    notificationEmail: process.env.OWNER_NOTIFICATION_EMAIL || process.env.GMAIL_USER || null,
    uptime: Math.floor(process.uptime())
  });
});

// -------------------------------------------------------------
// 1. PUBLIC CUSTOMER ENDPOINTS
// -------------------------------------------------------------

// Get Products
app.get('/api/products', async (req, res) => {
  try {
    const products = await dbAll('SELECT * FROM products WHERE is_active = 1');
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve products' });
  }
});

// Get Payment Account Details (public — customers need this to know where to send GCash/bank payment)
app.get('/api/payment-settings', async (req, res) => {
  try {
    const rows = await dbAll('SELECT channel, account_name, account_number FROM payment_settings');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve payment settings' });
  }
});

// Get the current delivery fee (public — shown at checkout before the order is placed)
async function getDeliveryFee() {
  const row = await dbGet(`SELECT value FROM app_settings WHERE key = 'delivery_fee'`);
  const fee = row ? Number(row.value) : 0;
  return Number.isFinite(fee) && fee >= 0 ? fee : 0;
}

app.get('/api/settings/delivery-fee', async (req, res) => {
  try {
    res.json({ deliveryFee: await getDeliveryFee() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve delivery fee' });
  }
});

// Customer Checkout (Creates Order & Returns Private Tracking Token)
app.post('/api/orders/checkout', customerWriteLimiter, async (req, res) => {
  try {
    const { name, phone, email, address, notes, paymentMethod, items, deviceId } = req.body;

    if (!name || !phone || !address || !Array.isArray(items) || !items.length || items.length > 50) {
      return res.status(400).json({ error: 'Please provide valid required fields (Name, Phone, Address, and 1–50 Items).' });
    }

    const cleanName = cleanText(name, 120);
    const cleanPhone = cleanText(phone, 40);
    const cleanEmail = cleanText(email || '', 160);
    const cleanAddress = cleanText(address, 500);
    const cleanNotes = cleanText(notes || '', 2000);
    const allowedPaymentMethods = new Set(['GCash', 'Maribank', 'Union Bank', 'Pay Personal', 'Cash On Delivery']);
    const cleanPaymentMethod = cleanText(paymentMethod || 'GCash', 40);

    if (!cleanName || !cleanPhone || !cleanAddress || !allowedPaymentMethods.has(cleanPaymentMethod)) {
      return res.status(400).json({ error: 'Invalid customer or payment information.' });
    }

    // deviceId is a random, unguessable token generated client-side (same trust model as
    // tracking_token) so we can group a customer's own past orders into a history view
    // without requiring them to create an account.
    const safeDeviceId = (typeof deviceId === 'string' && /^tc_dev_[a-f0-9]{20,80}$/.test(deviceId))
      ? deviceId
      : null;

    // Verify prices & calculate totals on backend (tamper-proof)
    const productRows = await dbAll('SELECT id, name, price, variants FROM products');
    const productMap = new Map(productRows.map(p => [p.id, p]));

    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const prod = productMap.get(item.id);
      if (!prod || prod.price === null) continue;

      // If this product has per-format pricing, the format the customer picked decides
      // the price — verified against the server's own variants, never trusting a price
      // the client sent. Falls back to the base price for products without variants yet.
      let price = prod.price;
      let format = null;
      if (prod.variants && typeof prod.variants === 'object') {
        const requestedFormat = PRODUCT_FORMATS[item.format] ? item.format : 'business_card';
        if (prod.variants[requestedFormat] != null) {
          price = prod.variants[requestedFormat];
          format = requestedFormat;
        }
      }

      const qty = Math.max(1, parseInt(item.qty, 10) || 1);
      const itemTotal = price * qty;
      subtotal += itemTotal;
      verifiedItems.push({ productId: prod.id, name: prod.name, price, qty, itemTotal, format });
    }

    if (!verifiedItems.length) {
      return res.status(400).json({ error: 'Cart contains no valid purchaseable items.' });
    }

    const fee = subtotal * 0.05;
    const deliveryFee = await getDeliveryFee();
    const total = subtotal + fee + deliveryFee;

    const orderNumber = 'TC-' + randomInt(100000, 1000000);
    const trackingToken = 'tc_track_' + uuidv4().replace(/-/g, '') + Buffer.from(Date.now().toString()).toString('hex');

    // Create the order, its items, and its initial customer note atomically.
    // A failed item/message insert must never leave a half-created order behind.
    const client = await pool.connect();
    let orderId;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO orders 
         (order_number, tracking_token, device_id, customer_name, customer_phone, customer_email, customer_address, customer_notes, payment_method, subtotal, fee, delivery_fee, total, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending Payment') RETURNING id`,
        [orderNumber, trackingToken, safeDeviceId, cleanName, cleanPhone, cleanEmail, cleanAddress, cleanNotes, cleanPaymentMethod, subtotal, fee, deliveryFee, total]
      );
      orderId = result.rows[0].id;

      for (const it of verifiedItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, price, qty, item_total, format)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orderId, it.productId, it.name, it.price, it.qty, it.itemTotal, it.format ? PRODUCT_FORMATS[it.format] : null]
        );
      }

      if (cleanNotes) {
        await client.query(
          `INSERT INTO order_messages (order_id, sender_role, sender_name, message)
           VALUES ($1,'customer',$2,$3)`,
          [orderId, cleanName, cleanNotes]
        );
      }

      await client.query('COMMIT');
    } catch (txErr) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw txErr;
    } finally {
      client.release();
    }

    const dashUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/admin.html` : 'https://tapcardphnfc.netlify.app/admin.html';

    sendGmailAlert(
      `🚨 [Tapcard PH] New Order #${orderNumber} received from ${escapeHtml(cleanName)} (₱${total.toLocaleString('en-PH', {minimumFractionDigits: 2})})`,
      `<div style="font-family:sans-serif;padding:20px;color:#102238">
        <h2 style="color:#002348">New Customer Order Received!</h2>
        <p><b>Order Number:</b> #${orderNumber}</p>
        <p><b>Customer:</b> ${escapeHtml(cleanName)} (${escapeHtml(cleanPhone)})</p>
        <p><b>Delivery Address:</b> ${escapeHtml(cleanAddress)}</p>
        <p><b>Payment Method:</b> ${escapeHtml(cleanPaymentMethod)}</p>
        <p><b>Total Amount:</b> ₱${total.toLocaleString('en-PH', {minimumFractionDigits: 2})}</p>
        ${cleanNotes ? `<p><b>Customer Note:</b> ${escapeHtml(cleanNotes)}</p>` : ''}
        <hr style="border:none;border-top:1px solid #e1e6eb;margin:20px 0">
        <p><a href="${dashUrl}" style="background:#002348;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open Owner Dashboard →</a></p>
      </div>`
    );

    res.status(201).json({
      success: true,
      orderNumber,
      trackingToken,
      total,
      message: 'Order created successfully. Save your tracking link.'
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to process order.' });
  }
});

// Customer Track Order (IDOR-Protected)
app.get('/api/orders/track/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || !token.startsWith('tc_track_')) {
      return res.status(404).json({ error: 'Order not found or invalid tracking token.' });
    }

    const order = await dbGet(
      `SELECT order_number, customer_name, customer_phone, customer_email, customer_address, 
              payment_method, payment_reference, payment_amount_claimed,
              payment_status, status, subtotal, fee, delivery_fee, total, 
              created_at, updated_at, id
       FROM orders WHERE tracking_token = $1`,
      [token]
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const items = await dbAll(
      `SELECT product_name, price, qty, item_total, format FROM order_items WHERE order_id = $1`,
      [order.id]
    );

    const messages = await dbAll(
      `SELECT sender_role, sender_name, message, created_at FROM order_messages WHERE order_id = $1 ORDER BY created_at ASC`,
      [order.id]
    );

    delete order.id;

    res.json({ success: true, order, items, messages });
  } catch (err) {
    console.error('Tracking error:', err);
    res.status(500).json({ error: 'Error fetching order.' });
  }
});

// Customer Submits Payment Reference
app.post('/api/orders/track/:token/payment', customerWriteLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { referenceNumber, amountPaid, screenshot } = req.body;
    if (screenshot && typeof screenshot !== 'string') return res.status(400).json({ error: 'Invalid screenshot data.' });

    if (typeof referenceNumber !== 'string' || !referenceNumber.trim() || referenceNumber.trim().length > 120) {
      return res.status(400).json({ error: 'Please enter a valid payment reference number.' });
    }

    let safeAmount = null;
    if (amountPaid !== undefined && amountPaid !== null && amountPaid !== '') {
      const n = Number(amountPaid);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'Please enter a valid amount paid.' });
      }
      safeAmount = n;
    }

    let safeScreenshot = null;
    if (screenshot) {
      if (!isValidScreenshotDataUrl(screenshot)) {
        return res.status(400).json({ error: 'Screenshot must be a PNG/JPG/WEBP image under 5MB.' });
      }
      safeScreenshot = screenshot.trim();
    }

    const order = await dbGet(`SELECT id, order_number, customer_name, total FROM orders WHERE tracking_token = $1`, [token]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    await dbRun(
      `UPDATE orders 
       SET payment_reference=$1, payment_amount_claimed=COALESCE($2, payment_amount_claimed),
           payment_screenshot=COALESCE($3, payment_screenshot),
           status='Payment Submitted', payment_status='Pending Verification', updated_at=NOW()
       WHERE id=$4`,
      [referenceNumber.trim(), safeAmount, safeScreenshot, order.id]
    );

    const amountNote = safeAmount !== null ? ` — Amount paid (customer-reported): ₱${safeAmount.toLocaleString('en-PH', {minimumFractionDigits: 2})}` : '';
    await dbRun(
      `INSERT INTO order_messages (order_id, sender_role, sender_name, message)
       VALUES ($1,'customer','Customer',$2)`,
      [order.id, `Submitted payment reference: ${escapeHtml(referenceNumber.trim())}${amountNote}${safeScreenshot ? ' (screenshot attached)' : ''}`]
    );

    const dashUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/admin.html` : 'https://tapcardphnfc.netlify.app/admin.html';

    sendGmailAlert(
      `💳 [Tapcard PH] Payment Reference Submitted for Order #${escapeHtml(order.order_number)}`,
      `<div style="font-family:sans-serif;padding:20px;color:#102238">
        <h2 style="color:#002348">Customer Submitted Payment Reference!</h2>
        <p><b>Order Number:</b> #${escapeHtml(order.order_number)}</p>
        <p><b>Customer:</b> ${escapeHtml(order.customer_name)}</p>
        <p><b>Payment Reference:</b> <strong style="font-size:16px;color:#176b4d">${escapeHtml(referenceNumber.trim())}</strong></p>
        ${safeAmount !== null ? `<p><b>Amount Paid (customer-reported):</b> ₱${safeAmount.toLocaleString('en-PH', {minimumFractionDigits: 2})}</p>` : ''}
        <p><b>Order Total:</b> ₱${order.total.toLocaleString('en-PH', {minimumFractionDigits: 2})}</p>
        ${safeScreenshot ? `<p><b>Screenshot:</b> attached — view in Owner Dashboard</p>` : ''}
        <p><a href="${dashUrl}" style="background:#002348;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Verify in Owner Dashboard →</a></p>
      </div>`
    );

    res.json({ success: true, message: 'Payment reference submitted. The owner will verify it shortly.' });
  } catch (err) {
    console.error('Payment submission error:', err);
    res.status(500).json({ error: 'Failed to record payment reference.' });
  }
});

// Customer Order History by Device (no login required — deviceId is an unguessable
// client-generated token, same trust model as a tracking_token)
app.get('/api/orders/history/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId || !/^tc_dev_[a-f0-9]{20,80}$/.test(deviceId)) {
      return res.status(400).json({ error: 'Invalid device identifier.' });
    }

    const orders = await dbAll(
      `SELECT order_number, tracking_token, status, payment_status, payment_method, total, created_at, updated_at
       FROM orders WHERE device_id = $1 ORDER BY created_at DESC`,
      [deviceId]
    );

    res.json({ success: true, orders });
  } catch (err) {
    console.error('Order history error:', err);
    res.status(500).json({ error: 'Failed to retrieve order history.' });
  }
});

// Customer Sends Message to Owner
app.post('/api/orders/track/:token/messages', customerWriteLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    const order = await dbGet(`SELECT id, order_number, customer_name FROM orders WHERE tracking_token = $1`, [token]);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    await dbRun(
      `INSERT INTO order_messages (order_id, sender_role, sender_name, message)
       VALUES ($1,'customer',$2,$3)`,
      [order.id, order.customer_name, message.trim()]
    );

    const dashUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/admin.html` : 'https://tapcardphnfc.netlify.app/admin.html';

    sendGmailAlert(
      `💬 [Tapcard PH] New Customer Message on Order #${escapeHtml(order.order_number)}`,
      `<div style="font-family:sans-serif;padding:20px;color:#102238">
        <h2 style="color:#002348">New Message from Customer</h2>
        <p><b>Order:</b> #${escapeHtml(order.order_number)} (${escapeHtml(order.customer_name)})</p>
        <div style="background:#f7f3e8;padding:15px;border-radius:8px;border-left:4px solid #d4af37">
          "${escapeHtml(message.trim())}"
        </div>
        <p><a href="${dashUrl}" style="background:#002348;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Reply in Dashboard →</a></p>
      </div>`
    );

    res.json({ success: true, message: 'Message sent to Owner.' });
  } catch (err) {
    console.error('Message error:', err);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// -------------------------------------------------------------
// 2. OWNER AUTHENTICATION, FORGOT PASSWORD & 2FA
// -------------------------------------------------------------

app.get('/api/auth/owner/status', async (req, res) => {
  try {
    const owner = await dbGet('SELECT id, email, totp_enabled FROM admin_users LIMIT 1');
    res.json({ configured: !!owner, totpEnabled: !!(owner && owner.totp_enabled) });
  } catch (err) {
    res.status(500).json({ error: 'Database check error.' });
  }
});

app.post('/api/auth/owner/setup', authLimiter, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM admin_users LIMIT 1');
    if (existing) return res.status(400).json({ error: 'Owner account is already configured.' });

    const configuredSetupKey = process.env.OWNER_SETUP_KEY;
    const suppliedSetupKey = req.get('x-owner-setup-key') || req.body.setupKey;
    if (!configuredSetupKey || !suppliedSetupKey || suppliedSetupKey !== configuredSetupKey) {
      return res.status(503).json({ error: 'Owner setup is locked. Configure OWNER_SETUP_KEY on the backend before creating the first Owner account.' });
    }

    const { email, password } = req.body;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Email and strong password (min 8 characters) required.' });
    }

    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);
    const totpSecret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(email, 'Tapcard PH NFC', totpSecret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    await dbRun(
      `INSERT INTO admin_users (email, password_hash, totp_secret, totp_enabled) VALUES ($1,$2,$3,0)`,
      [email.toLowerCase().trim(), passwordHash, totpSecret]
    );

    res.json({ success: true, email: email.toLowerCase().trim(), totpSecret, qrCodeDataUrl });
  } catch (err) {
    console.error('Owner setup error:', err);
    res.status(500).json({ error: 'Failed to configure Owner account.' });
  }
});

app.post('/api/auth/owner/setup/verify', authLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    const owner = await dbGet('SELECT id, totp_secret FROM admin_users LIMIT 1');
    if (!owner) return res.status(400).json({ error: 'No owner account found.' });

    const isValid = authenticator.check(token, owner.totp_secret);
    if (!isValid) return res.status(400).json({ error: 'Invalid 6-digit verification code.' });

    await dbRun('UPDATE admin_users SET totp_enabled=1 WHERE id=$1', [owner.id]);
    res.json({ success: true, message: '2FA successfully enabled!' });
  } catch (err) {
    res.status(500).json({ error: 'Verification error.' });
  }
});

app.post('/api/auth/owner/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) return res.status(400).json({ error: 'Email and password required.' });

    const owner = await dbGet('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!owner || !bcrypt.compareSync(password, owner.password_hash)) {
      return res.status(401).json({ error: 'Invalid owner credentials.' });
    }

    res.json({ success: true, requires2FA: true, email: owner.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Authentication server error.' });
  }
});

app.post('/api/auth/owner/verify-2fa', authLimiter, async (req, res) => {
  try {
    const { email, password, totpCode } = req.body;
    if (!email || !password || !totpCode) return res.status(400).json({ error: 'Missing required 2FA parameters.' });

    const owner = await dbGet('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!owner || !bcrypt.compareSync(password, owner.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!authenticator.check(totpCode.trim(), owner.totp_secret)) {
      return res.status(401).json({ error: 'Invalid 2FA code. Please check your Authenticator app.' });
    }

    const sessionToken = 'tc_sess_' + uuidv4().replace(/-/g, '') + Buffer.from(Date.now().toString()).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_HOURS * 3600 * 1000).toISOString();

    await dbRun(
      `INSERT INTO admin_sessions (token, user_id, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [sessionToken, owner.id, req.ip, req.headers['user-agent'] || '', expiresAt]
    );

    await dbRun('UPDATE admin_users SET last_login=NOW() WHERE id=$1', [owner.id]);

    res.cookie('tapcard_owner_session', sessionToken, {
      httpOnly: true,
      sameSite: 'none',
      path: '/',
      maxAge: SESSION_LIFETIME_HOURS * 3600 * 1000,
      secure: true
    });

    res.json({ success: true, message: 'Owner authentication successful.' });
  } catch (err) {
    console.error('2FA verification error:', err);
    res.status(500).json({ error: '2FA verification failed.' });
  }
});

app.post('/api/auth/owner/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const owner = await dbGet('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!owner) return res.json({ success: true, message: 'If this email is the registered Owner, a security reset code has been dispatched.' });

    const resetCode = randomInt(100000, 1000000).toString();
    resetCodes.set(owner.email, { code: resetCode, expiresAt: Date.now() + 15 * 60 * 1000 });

    sendGmailAlert(
      `🔐 [Tapcard PH Security] Password Reset Verification Code: ${resetCode}`,
      `<div style="font-family:sans-serif;padding:20px;color:#102238">
        <h2 style="color:#002348">Owner Password Reset Request</h2>
        <div style="background:#f7f3e8;padding:18px;border-radius:10px;text-align:center;margin:20px 0">
          <p style="font-size:11px;color:#66758a;margin:0 0 6px">YOUR 6-DIGIT VERIFICATION CODE</p>
          <strong style="font-size:32px;letter-spacing:6px;color:#002348;font-family:monospace">${resetCode}</strong>
        </div>
        <p style="font-size:12px;color:#66758a">This code expires in 15 minutes.</p>
      </div>`
    );

    res.json({ success: true, message: 'A 6-digit security code has been dispatched to your registered Gmail account.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

app.post('/api/auth/owner/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, code, totpCode, newPassword } = req.body;
    if (typeof email !== 'string' || !email.trim() || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Valid email and strong new password (min 8 characters) required.' });
    }

    const owner = await dbGet('SELECT * FROM admin_users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!owner) return res.status(400).json({ error: 'Invalid request.' });

    let isAuthorized = false;
    if (code) {
      const stored = resetCodes.get(owner.email);
      if (stored && stored.code === code.trim() && Date.now() < stored.expiresAt) {
        isAuthorized = true;
        resetCodes.delete(owner.email);
      }
    }
    if (!isAuthorized && totpCode && authenticator.check(totpCode.trim(), owner.totp_secret)) {
      isAuthorized = true;
    }

    if (!isAuthorized) return res.status(401).json({ error: 'Invalid or expired verification code / 2FA code.' });

    const newHash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(12));
    await dbRun('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [newHash, owner.id]);
    await dbRun('DELETE FROM admin_sessions WHERE user_id=$1', [owner.id]);

    sendGmailAlert(`🛡️ [Tapcard PH Security] Your Owner Password was Successfully Changed`,
      `<p>Your Tapcard PH Owner account password was successfully reset. If you did not do this, secure your account immediately.</p>`);

    res.json({ success: true, message: 'Password reset successful! You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

app.post('/api/auth/owner/logout', async (req, res) => {
  const sessionToken = req.cookies.tapcard_owner_session || req.headers['x-owner-session'];
  if (sessionToken) await dbRun('DELETE FROM admin_sessions WHERE token=$1', [sessionToken]);
  res.clearCookie('tapcard_owner_session', { path: '/', sameSite: 'none', secure: true });
  res.json({ success: true, message: 'Logged out successfully.' });
});

// -------------------------------------------------------------
// 3. OWNER / ADMIN DASHBOARD & SECURITY CONTROLS
// -------------------------------------------------------------

app.get('/api/admin/security/2fa-qr', requireOwner, async (req, res) => {
  try {
    const owner = await dbGet('SELECT email, totp_secret FROM admin_users WHERE id=$1', [req.owner.id]);
    if (!owner) return res.status(404).json({ error: 'Owner record not found.' });

    const otpauth = authenticator.keyuri(owner.email, 'Tapcard PH NFC', owner.totp_secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth);

    res.json({ success: true, email: owner.email, totpSecret: owner.totp_secret, qrCodeDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate 2FA QR.' });
  }
});

app.get('/api/admin/analytics', requireOwner, async (req, res) => {
  try {
    const orders = await dbAll('SELECT * FROM orders');
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => {
      const recognized = o.payment_status === 'Verified' || o.status === 'Completed';
      return recognized ? sum + (Number(o.total) || 0) : sum;
    }, 0);
    const paidOrders = orders.filter(o => o.payment_status === 'Verified' || o.status === 'Completed').length;
    const pendingOrders = orders.filter(o => o.status === 'Pending Payment' || o.status === 'Payment Submitted').length;

    const paymentBreakdown = {};
    orders.forEach(o => { paymentBreakdown[o.payment_method] = (paymentBreakdown[o.payment_method] || 0) + 1; });

    const topProducts = await dbAll(`
      SELECT product_name, SUM(qty) as total_qty, SUM(item_total) as total_sales
      FROM order_items GROUP BY product_name ORDER BY total_qty DESC LIMIT 5
    `);

    res.json({ totalRevenue, totalOrders, paidOrders, pendingOrders, paymentBreakdown, topProducts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate analytics.' });
  }
});

app.get('/api/admin/orders', requireOwner, async (req, res) => {
  try {
    const orders = await dbAll('SELECT * FROM orders ORDER BY created_at DESC');
    if (!orders.length) return res.json([]);
    const ids = orders.map(o => o.id);
    const items = await dbAll('SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC', [ids]);
    const messages = await dbAll('SELECT * FROM order_messages WHERE order_id = ANY($1::int[]) ORDER BY created_at ASC', [ids]);
    const itemsByOrder = new Map();
    const messagesByOrder = new Map();
    for (const item of items) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push(item);
    }
    for (const msg of messages) {
      if (!messagesByOrder.has(msg.order_id)) messagesByOrder.set(msg.order_id, []);
      messagesByOrder.get(msg.order_id).push(msg);
    }
    for (const ord of orders) {
      ord.items = itemsByOrder.get(ord.id) || [];
      ord.messages = messagesByOrder.get(ord.id) || [];
    }
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders.' });
  }
});

app.patch('/api/admin/orders/:id/status', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, note } = req.body;

    await dbRun(
      `UPDATE orders SET status=$1, payment_status=COALESCE($2, payment_status), updated_at=NOW() WHERE id=$3`,
      [status, paymentStatus || null, id]
    );

    if (note && note.trim()) {
      await dbRun(
        `INSERT INTO order_messages (order_id, sender_role, sender_name, message)
         VALUES ($1,'owner','Owner / Tapcard PH',$2)`,
        [id, note.trim()]
      );
    }

    res.json({ success: true, message: `Order status updated to "${status}".` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order status.' });
  }
});

// Owner edits a product's per-format prices (Business Card / Standee / NFC Sticker / Square / Safetag
// Circle). Changes are saved to Postgres so every device and the storefront itself see the
// same price immediately — this replaces the old browser-localStorage-only pricing.
app.patch('/api/admin/products/:id', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { variants } = req.body;

    if (!variants || typeof variants !== 'object') {
      return res.status(400).json({ error: 'variants object is required, e.g. {"business_card":999,"standee":1499,"sticker":599,"safetag_circle":799}' });
    }

    const existing = await dbGet('SELECT * FROM products WHERE id = $1', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    // Only accept the four known format keys, and only positive numbers — everything else
    // is dropped rather than trusted, since this is written straight into pricing.
    const cleanVariants = {};
    for (const key of Object.keys(PRODUCT_FORMATS)) {
      const raw = variants[key];
      const num = Number(raw);
      if (raw != null && Number.isFinite(num) && num >= 0) {
        cleanVariants[key] = num;
      } else if (existing.variants && existing.variants[key] != null) {
        cleanVariants[key] = existing.variants[key]; // keep prior value if this one wasn't sent/valid
      }
    }

    // Base `price` stays in sync with the Business Card variant, since that's what
    // checkout falls back to for any product that somehow has no variants yet.
    const basePrice = cleanVariants.business_card ?? existing.price;

    const updated = await dbGet(
      `UPDATE products SET variants = $1, price = $2 WHERE id = $3 RETURNING *`,
      [JSON.stringify(cleanVariants), basePrice, id]
    );

    await dbRun(
      `INSERT INTO audit_logs (action, details, ip_address) VALUES ($1,$2,$3)`,
      ['product_price_update', `Product #${id} (${existing.name}) prices updated by ${req.owner.email}: ${JSON.stringify(cleanVariants)}`, req.ip]
    );

    res.json({ success: true, product: updated });
  } catch (err) {
    console.error('Product price update error:', err);
    res.status(500).json({ error: 'Failed to update product pricing.' });
  }
});

// Owner edits the delivery fee charged on new orders (past orders keep whatever fee was
// in effect when they were placed — see orders.delivery_fee).
app.patch('/api/admin/settings/delivery-fee', requireOwner, async (req, res) => {
  try {
    const { deliveryFee } = req.body;
    const fee = Number(deliveryFee);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ error: 'Delivery fee must be a number ≥ 0.' });
    }

    await dbRun(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('delivery_fee', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(fee)]
    );

    await dbRun(
      `INSERT INTO audit_logs (action, details, ip_address) VALUES ($1,$2,$3)`,
      ['delivery_fee_update', `Delivery fee set to ₱${fee} by ${req.owner.email}`, req.ip]
    );

    res.json({ success: true, deliveryFee: fee });
  } catch (err) {
    console.error('Delivery fee update error:', err);
    res.status(500).json({ error: 'Failed to update delivery fee.' });
  }
});

// Owner edits where a payment channel's money actually goes (GCash/Maribank/Union Bank
// account name + number). Shown to customers at checkout and on the tracking page.
app.patch('/api/admin/payment-settings/:channel', requireOwner, async (req, res) => {
  try {
    const { channel } = req.params;
    const { accountName, accountNumber } = req.body;

    const existing = await dbGet('SELECT * FROM payment_settings WHERE channel = $1', [channel]);
    if (!existing) {
      return res.status(404).json({ error: `Unknown payment channel "${channel}".` });
    }
    if (!accountNumber || !accountNumber.trim()) {
      return res.status(400).json({ error: 'Account number is required.' });
    }

    const updated = await dbGet(
      `UPDATE payment_settings SET account_name=$1, account_number=$2, updated_at=NOW() WHERE channel=$3 RETURNING *`,
      [(accountName || '').trim(), accountNumber.trim(), channel]
    );

    await dbRun(
      `INSERT INTO audit_logs (action, details, ip_address) VALUES ($1,$2,$3)`,
      ['payment_settings_update', `${channel} account updated by ${req.owner.email}`, req.ip]
    );

    res.json({ success: true, setting: updated });
  } catch (err) {
    console.error('Payment settings update error:', err);
    res.status(500).json({ error: 'Failed to update payment settings.' });
  }
});

app.post('/api/admin/orders/:id/messages', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });

    await dbRun(
      `INSERT INTO order_messages (order_id, sender_role, sender_name, message)
       VALUES ($1,'owner','Owner / Tapcard PH',$2)`,
      [id, message.trim()]
    );

    res.json({ success: true, message: 'Reply sent to customer.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

// Serve static files
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(__dirname));

// Start Server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  TAPCARD PH NFC SERVER RUNNING ON PORT ${PORT}`);
    console.log(`  Public Storefront: http://localhost:${PORT}/index.html`);
    console.log(`  Order Tracking:    http://localhost:${PORT}/track.html`);
    console.log(`  Owner Login:       http://localhost:${PORT}/login.html`);
    console.log(`  Owner Dashboard:   http://localhost:${PORT}/admin.html`);
    console.log(`=======================================================`);
  });
}).catch(err => {
  console.error('[FATAL] Failed to initialize database:', err.message);
  process.exit(1);
});
