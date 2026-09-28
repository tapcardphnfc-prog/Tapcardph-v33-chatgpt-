/**
 * Tapcard PH NFC — Frontend Config
 *
 * If your frontend (Netlify) and backend (Render/Railway/etc.) are on the SAME domain
 * (e.g. you deployed the Node server and it serves these HTML files itself), leave this
 * as an empty string — every fetch() call will just hit relative "/api/..." paths.
 *
 * If your frontend is on Netlify and your backend is a SEPARATE URL (e.g.
 * https://tapcard-ph-nfc.onrender.com), set it below. No trailing slash.
 */
window.TAPCARD_API_BASE = 'https://tapcard-ph-nfc-backend.onrender.com';

// Web3Forms is the direct order inbox for the V11 static storefront. The access
// key is intended to be public/client-side by Web3Forms. Make sure this key is
// registered to tapcardsphnfc@gmail.com in your Web3Forms account.
window.TAPCARD_WEB3FORMS_ACCESS_KEY = '44f68dc5-7000-49a8-839b-e9a8fd66fdc0';
window.TAPCARD_ORDER_EMAIL = 'tapcardsphnfc@gmail.com';

// Botcake Messenger Ref URL used by the final online-payment receipt step.
// This is a public Messenger URL; keep the Botcake API token server-side and never place it here.
window.TAPCARD_BOTCAKE_RECEIPT_URL = 'https://m.me/111145857242731?ref=tapcard_receipt';

// Fallback delivery fee used by the static Netlify storefront when no backend API
// is configured. The owner can edit the live fee from the Owner Dashboard when
// TAPCARD_API_BASE points to the V11 backend.
window.TAPCARD_DEFAULT_DELIVERY_FEE = 60;

// Static manual-payment account numbers used by the V10 storefront and tracking page.
// No online payment gateway is used in this patch.
window.TAPCARD_PAYMENT_FALLBACKS = {
  'gcash': { channel: 'GCash', account_number: '09658433149', account_name: '' },
  'maribank': { channel: 'Maribank', account_number: '18048717491', account_name: '' },
  'union bank': { channel: 'Union Bank', account_number: '109812316617', account_name: '' }
};

// Copies text to the clipboard and reports success/failure back via callback(ok).
// Used by the GCash/Maribank/Union Bank "Copy" buttons on checkout and tracking.
window.tcCopyText = function (text, callback) {
  const done = (ok) => { if (typeof callback === 'function') callback(ok); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(false));
    return;
  }
  // Fallback for older/non-secure contexts
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    done(ok);
  } catch (e) {
    done(false);
  }
};

// Small fetch helper used across pages: prefixes API_BASE, always sends cookies
// (needed for the owner session cookie), and normalizes error handling.
window.tcApi = async function (path, options = {}) {
  const url = (window.TAPCARD_API_BASE || '') + path;
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* no JSON body */ }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

/**
 * Web3Forms client-side notification — an ADDITIONAL, independent backup notifier.
 * The server's own Gmail alert (sendGmailAlert in server.js) remains the primary
 * notification system and is untouched; this just gives the owner a second, direct
 * copy of key events straight from the customer's browser.
 *
 * This is fire-and-forget by design: it must never throw, block, or affect the
 * calling flow. Call it AFTER a real backend call (checkout / payment reference)
 * has already succeeded — never in place of it.
 */
window.tcNotifyWeb3Forms = function (payload) {
  try {
    fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_key: '44f68dc5-7000-49a8-839b-e9a8fd66fdc0',
        ...payload
      })
    }).catch(err => console.warn('[Web3Forms] notification failed (non-blocking, order/payment unaffected):', err));
  } catch (err) {
    console.warn('[Web3Forms] notification setup failed (non-blocking):', err);
  }
};
