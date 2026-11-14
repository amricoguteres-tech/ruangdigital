import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const databasePath = path.resolve(process.env.DB_PATH || ".data/ruangdigital.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

  CREATE TABLE IF NOT EXISTS consultations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    project TEXT NOT NULL,
    budget TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS consultations_created_idx ON consultations(created_at DESC);

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    package_id TEXT NOT NULL,
    package_name TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    payment_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
    midtrans_token TEXT,
    redirect_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_expire_idx ON password_reset_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_verification_expire_idx ON email_verification_tokens(expires_at);

  CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    encrypted_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS email_outbox_pending_idx ON email_outbox(status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    backup_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    size_bytes INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_order_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('status_changed', 'access_details_saved')),
    from_status TEXT,
    to_status TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS service_order_events_order_idx
    ON service_order_events(order_id, created_at DESC);
`);

const userColumns = new Set(db.pragma("table_info(users)").map((column) => column.name));
if (!userColumns.has("email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
}
if (!userColumns.has("phone_whatsapp")) {
  db.exec("ALTER TABLE users ADD COLUMN phone_whatsapp TEXT");
}
db.exec("UPDATE users SET email_verified = 1 WHERE role = 'admin' AND email_verified = 0");

const orderColumns = new Set(db.pragma("table_info(orders)").map((column) => column.name));
if (!orderColumns.has("invoice_number")) {
  db.exec("ALTER TABLE orders ADD COLUMN invoice_number TEXT");
}
if (!orderColumns.has("service_status")) {
  db.exec("ALTER TABLE orders ADD COLUMN service_status TEXT NOT NULL DEFAULT 'awaiting_payment'");
}
if (!orderColumns.has("service_details")) {
  db.exec("ALTER TABLE orders ADD COLUMN service_details TEXT");
}
if (!orderColumns.has("expires_at")) {
  db.exec("ALTER TABLE orders ADD COLUMN expires_at TEXT");
}
db.exec(`
  UPDATE orders
  SET invoice_number = 'INV-' || substr(replace(id, '-', ''), 1, 12)
  WHERE invoice_number IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_idx ON orders(invoice_number);
`);

export function closeDatabase() {
  if (db.open) db.close();
}
