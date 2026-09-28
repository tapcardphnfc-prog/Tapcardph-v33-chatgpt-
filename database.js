const { Pool } = require('pg');

// PostgreSQL connection pool — uses DATABASE_URL from environment (set on Render/Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Initialize all tables and seed default products
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Owner / Admin Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        totp_secret TEXT,
        totp_enabled INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP
      )
    `);

    // Active Owner Sessions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id SERIAL PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        ip_address TEXT,
        user_agent TEXT,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Orders Table (Cryptographic tracking_token ensures IDOR immunity)
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number TEXT UNIQUE NOT NULL,
        tracking_token TEXT UNIQUE NOT NULL,
        device_id TEXT,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT,
        customer_address TEXT NOT NULL,
        customer_notes TEXT,
        payment_method TEXT NOT NULL,
        payment_reference TEXT,
        payment_amount_claimed REAL,
        payment_screenshot TEXT,
        payment_status TEXT DEFAULT 'Unpaid',
        status TEXT DEFAULT 'Pending Payment',
        subtotal REAL NOT NULL,
        fee REAL NOT NULL,
        total REAL NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Backfill columns for databases created before these fields existed
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS device_id TEXT`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_amount_claimed REAL`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot TEXT`);

    // Index for fast per-device order history lookups
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_device_id ON orders(device_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC)`);

    // Order Items
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        price REAL NOT NULL,
        qty INTEGER NOT NULL,
        item_total REAL NOT NULL
      )
    `);

    // Order Messages (Two-way communications)
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_messages (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        sender_role TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Products Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        cat TEXT NOT NULL,
        price REAL,
        description TEXT,
        tag TEXT,
        img TEXT,
        is_active INTEGER DEFAULT 1,
        variants JSONB
      )
    `);

    // Backfill for products tables created before per-format pricing existed
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB`);

    // Backfill for order_items created before per-format tracking existed
    await client.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS format TEXT`);

    // Payment Accounts — the actual GCash/bank numbers customers are told to pay to.
    // Editable by the owner via /api/admin/payment-settings so numbers can change without a redeploy.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        channel TEXT PRIMARY KEY,
        account_name TEXT,
        account_number TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const { rows: paySettingsCount } = await client.query('SELECT COUNT(*) as count FROM payment_settings');
    if (parseInt(paySettingsCount[0].count) === 0) {
      const defaultAccounts = [
        ['GCash', 'Tapcard PH NFC', '09658433149'],
        ['Maribank', 'Tapcard PH NFC', '18048717491'],
        ['Union Bank', 'Tapcard PH NFC', '1098 12316617']
      ];
      for (const [channel, name, number] of defaultAccounts) {
        await client.query(
          `INSERT INTO payment_settings (channel, account_name, account_number) VALUES ($1,$2,$3) ON CONFLICT (channel) DO NOTHING`,
          [channel, name, number]
        );
      }
      console.log('[DB] Seeded default payment account settings.');
    }

    // Generic owner-editable app settings (delivery fee, and anywhere else a single
    // owner-controlled number/string is needed later without a schema change).
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('delivery_fee', '60') ON CONFLICT (key) DO NOTHING`
    );

    // Delivery fee charged at checkout time, stored per-order so past orders keep the fee
    // that was actually in effect even if the owner changes it later.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee REAL DEFAULT 0`);

    // Audit Logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Seed default products if table is empty
    const { rows } = await client.query('SELECT COUNT(*) as count FROM products');
    if (parseInt(rows[0].count) === 0) {
      const defaults = [
        [1, 'NFC Google Review Card', 'Review', 999, 'Drive more customers directly to your Google reviews.', 'POPULAR', 'assets/slide-7.png'],
        [2, 'NFC Facebook Review Card', 'Review', 999, 'Send customers straight to your Facebook review page.', 'NEW', 'assets/slide-4.png'],
        [3, 'NFC Digital Business Card', 'Business', 1299, 'Share your contact details and social profiles with one tap.', 'READY TO ORDER', 'assets/slide-1.png'],
        [4, 'NFC Smart Menu Card', 'Restaurant', 1499, 'Send customers straight to your digital menu or ordering page.', 'BUSINESS', 'assets/slide-6.png'],
        [5, 'NFC LTMS GOV. Card (LTO & SSS)', 'Government', 999, 'A dedicated NFC card for LTO / LTMS and SSS links.', 'GOVERNMENT', 'assets/slide-3.png'],
        [6, 'NFC Social Media Card', 'Marketing', 999, 'Connect customers to Facebook, Instagram, TikTok and more.', 'READY TO ORDER', 'assets/slide-5.png'],
        [7, 'Custom NFC System', 'Custom', null, 'Custom NFC workflows, landing pages and business systems.', 'CUSTOM', 'assets/slide-9.png']
      ];
      for (const d of defaults) {
        await client.query(
          `INSERT INTO products (id, name, cat, price, description, tag, img) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          d
        );
      }
      console.log('[DB] Seeded default products.');
    }

    // Give every purchasable product (i.e. one with a price) the four standard formats
    // if it doesn't have variant pricing yet — covers both freshly seeded rows and
    // pre-existing databases upgrading from single-price products. All four formats
    // start at the same price; the owner adjusts each individually in the admin
    // Product Pricing tab.
    await client.query(`
      UPDATE products
      SET variants = jsonb_build_object(
        'business_card', price,
        'standee', price,
        'sticker', price,
        'safetag_circle', price
      )
      WHERE variants IS NULL AND price IS NOT NULL
    `);

    await client.query('COMMIT');
    console.log('[DB] All tables initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
