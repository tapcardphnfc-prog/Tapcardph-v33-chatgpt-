/**
 * Tapcard PH NFC - Cryptographic & Storage Core
 * Implements RFC 6238 TOTP (Google Authenticator), PBKDF2 Password Hashing, 
 * Cryptographic Token Generation, and IDOR-Immune Data Management.
 */

const TapcardCore = (function () {
  const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  // Base32 Decoding
  function base32ToBytes(base32) {
    base32 = base32.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = '';
    for (let i = 0; i < base32.length; i++) {
      const val = BASE32_CHARS.indexOf(base32.charAt(i));
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return new Uint8Array(bytes);
  }

  // Base32 Encoding
  function bytesToBase32(bytes) {
    let bits = '';
    for (let i = 0; i < bytes.length; i++) {
      bits += bytes[i].toString(2).padStart(8, '0');
    }
    let base32 = '';
    for (let i = 0; i < bits.length; i += 5) {
      const chunk = bits.substr(i, 5);
      if (chunk.length < 5) {
        base32 += BASE32_CHARS[parseInt(chunk.padEnd(5, '0'), 2)];
      } else {
        base32 += BASE32_CHARS[parseInt(chunk, 2)];
      }
    }
    return base32;
  }

  // Generate 16-character Random Base32 Secret for Google Authenticator
  function generateTotpSecret() {
    const randomBytes = new Uint8Array(20);
    window.crypto.getRandomValues(randomBytes);
    return bytesToBase32(randomBytes).substring(0, 16);
  }

  // Compute 6-Digit TOTP using Web Crypto HMAC-SHA1
  async function computeTotp(secretBase32, timeStepOffset = 0) {
    const epochSeconds = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epochSeconds / 30) + timeStepOffset;

    const counterBuffer = new ArrayBuffer(8);
    const counterView = new DataView(counterBuffer);
    counterView.setUint32(0, 0, false);
    counterView.setUint32(4, counter, false);

    const keyBytes = base32ToBytes(secretBase32);
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: { name: 'SHA-1' } },
      false,
      ['sign']
    );

    const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, counterBuffer);
    const hash = new Uint8Array(signature);

    const offset = hash[hash.length - 1] & 0x0f;
    const binary =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const otp = binary % 1000000;
    return otp.toString().padStart(6, '0');
  }

  // Verify TOTP token with +/- 4 time steps (2 minutes) window for clock drift tolerance
  async function verifyTotp(secretBase32, inputCode) {
    if (!secretBase32 || !inputCode) return false;
    const cleanCode = inputCode.toString().trim().replace(/\s/g, '');
    for (let offset = -4; offset <= 4; offset++) {
      const generated = await computeTotp(secretBase32, offset);
      if (generated === cleanCode) return true;
    }
    return false;
  }

  // PBKDF2 Password Hashing (Salt + 100,000 iterations)
  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    salt = salt || window.crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

    const baseKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const derivedBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      256
    );

    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return `${saltHex}:${hashHex}`;
  }

  // Verify Password
  async function verifyPassword(password, storedHashWithSalt) {
    if (!storedHashWithSalt || !storedHashWithSalt.includes(':')) return false;
    const [saltHex, expectedHashHex] = storedHashWithSalt.split(':');
    const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const computed = await hashPassword(password, saltBytes);
    return computed.split(':')[1] === expectedHashHex;
  }

  // Generate Cryptographic UUIDv4 / Random Token
  function generateSecureToken(prefix = 'tc_sec_') {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return prefix + hex + Date.now().toString(36);
  }

  // Anonymous Per-Browser Device Identity (used for "My Orders" history — no login required)
  // Pure lowercase-hex payload so it matches the backend's tc_dev_[a-f0-9]{20,80} validation.
  const DEVICE_ID_KEY = 'tapcard_device_id';

  function generateDeviceId() {
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return 'tc_dev_' + hex;
  }

  function getOrCreateDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id || !/^tc_dev_[a-f0-9]{20,80}$/.test(id)) {
        id = generateDeviceId();
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    } catch (e) {
      // localStorage unavailable (private mode, etc.) — fall back to a session-only id
      return generateDeviceId();
    }
  }

  // Storage & Session Manager
  const STORE_KEYS = {
    OWNER_USER: 'tapcard_owner_config',
    ACTIVE_SESSION: 'tapcard_owner_active_session',
    ORDERS: 'tapcard_all_orders_db',
    PRODUCTS: 'tapcard_products_db'
  };

  function getStoredOrders() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEYS.ORDERS) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveOrders(orders) {
    localStorage.setItem(STORE_KEYS.ORDERS, JSON.stringify(orders));
  }

  // Create Order in Client Storage (used when backend server is not running)
  function createOrderClientSide(orderData) {
    const orders = getStoredOrders();
    const orderNumber = 'TC-' + Math.floor(100000 + Math.random() * 900000);
    const trackingToken = generateSecureToken('tc_track_');

    const newOrder = {
      orderNumber,
      trackingToken,
      customerName: orderData.name,
      customerPhone: orderData.phone,
      customerEmail: orderData.email || '',
      customerAddress: orderData.address,
      customerNotes: orderData.notes || '',
      paymentMethod: orderData.paymentMethod || 'GCash',
      paymentReference: '',
      paymentStatus: 'Unpaid',
      status: 'Pending Payment',
      items: orderData.items || [],
      subtotal: orderData.subtotal,
      fee: orderData.fee,
      total: orderData.total,
      messages: orderData.notes ? [
        {
          senderRole: 'customer',
          senderName: orderData.name,
          message: orderData.notes,
          createdAt: new Date().toISOString()
        }
      ] : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    orders.unshift(newOrder);
    saveOrders(orders);
    return newOrder;
  }

  // IDOR Protection: Find Order Strictly by Tracking Token
  function getOrderByTrackingToken(token) {
    if (!token) return null;
    const orders = getStoredOrders();
    return orders.find(o => o.trackingToken === token) || null;
  }

  // Customer Submits Payment Reference
  function submitPaymentReference(token, reference) {
    const orders = getStoredOrders();
    const order = orders.find(o => o.trackingToken === token);
    if (!order) return false;

    order.paymentReference = reference;
    order.paymentStatus = 'Pending Verification';
    order.status = 'Payment Submitted';
    order.updatedAt = new Date().toISOString();

    order.messages.push({
      senderRole: 'customer',
      senderName: order.customerName,
      message: `Submitted payment reference: ${reference}`,
      createdAt: new Date().toISOString()
    });

    saveOrders(orders);
    return true;
  }

  // Customer Sends Message to Owner
  function addCustomerMessage(token, text) {
    const orders = getStoredOrders();
    const order = orders.find(o => o.trackingToken === token);
    if (!order) return false;

    order.messages.push({
      senderRole: 'customer',
      senderName: order.customerName,
      message: text,
      createdAt: new Date().toISOString()
    });
    order.updatedAt = new Date().toISOString();
    saveOrders(orders);
    return true;
  }

  // Owner Management: Get All Orders (Owner Only)
  function getOwnerOrders() {
    if (!isOwnerAuthenticated()) return null;
    return getStoredOrders();
  }

  // Owner Updates Order Lifecycle Status
  function updateOrderStatus(orderNumber, newStatus, paymentStatus, ownerNote) {
    if (!isOwnerAuthenticated()) return false;
    const orders = getStoredOrders();
    const order = orders.find(o => o.orderNumber === orderNumber);
    if (!order) return false;

    order.status = newStatus;
    if (paymentStatus) order.paymentStatus = paymentStatus;
    order.updatedAt = new Date().toISOString();

    if (ownerNote && ownerNote.trim()) {
      order.messages.push({
        senderRole: 'owner',
        senderName: 'Owner / Tapcard PH',
        message: ownerNote.trim(),
        createdAt: new Date().toISOString()
      });
    }

    saveOrders(orders);
    return true;
  }

  // Owner Sends Reply Message to Customer
  function addOwnerMessage(orderNumber, messageText) {
    if (!isOwnerAuthenticated()) return false;
    const orders = getStoredOrders();
    const order = orders.find(o => o.orderNumber === orderNumber);
    if (!order) return false;

    order.messages.push({
      senderRole: 'owner',
      senderName: 'Owner / Tapcard PH',
      message: messageText.trim(),
      createdAt: new Date().toISOString()
    });
    order.updatedAt = new Date().toISOString();
    saveOrders(orders);
    return true;
  }

  // Owner Session Management
  function getOwnerConfig() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEYS.OWNER_USER) || 'null');
    } catch (e) {
      return null;
    }
  }

  function saveOwnerConfig(cfg) {
    localStorage.setItem(STORE_KEYS.OWNER_USER, JSON.stringify(cfg));
  }

  function isOwnerAuthenticated() {
    try {
      const sess = JSON.parse(sessionStorage.getItem(STORE_KEYS.ACTIVE_SESSION) || 'null');
      if (!sess || !sess.token || !sess.expiresAt) return false;
      if (Date.now() > sess.expiresAt) {
        logoutOwner();
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function getActiveOwnerSession() {
    if (!isOwnerAuthenticated()) return null;
    return JSON.parse(sessionStorage.getItem(STORE_KEYS.ACTIVE_SESSION) || 'null');
  }

  function createOwnerSession(email) {
    const session = {
      token: generateSecureToken('tc_sess_'),
      email: email,
      createdAt: Date.now(),
      expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours idle timeout
    };
    sessionStorage.setItem(STORE_KEYS.ACTIVE_SESSION, JSON.stringify(session));
    return session;
  }

  function logoutOwner() {
    sessionStorage.removeItem(STORE_KEYS.ACTIVE_SESSION);
  }

  return {
    generateTotpSecret,
    computeTotp,
    verifyTotp,
    hashPassword,
    verifyPassword,
    generateSecureToken,
    generateDeviceId,
    getOrCreateDeviceId,
    createOrderClientSide,
    getOrderByTrackingToken,
    submitPaymentReference,
    addCustomerMessage,
    getOwnerOrders,
    updateOrderStatus,
    addOwnerMessage,
    getOwnerConfig,
    saveOwnerConfig,
    isOwnerAuthenticated,
    getActiveOwnerSession,
    createOwnerSession,
    logoutOwner
  };
})();

// Expose the core API for storefront code and legacy integrations.
window.TapcardCore = TapcardCore;
