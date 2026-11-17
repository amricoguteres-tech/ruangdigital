import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import express from "express";
import PDFDocument from "pdfkit";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import nodemailer from "nodemailer";
import { z } from "zod";
import { decryptAccessData, encryptAccessData, loadAccessDataKeyring } from "./access-data.js";
import { closeDatabase, databasePath, db } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || "local-development-session-secret-change-me";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:8000";
const accessDataKeyring = loadAccessDataKeyring(process.env, isProduction);
const sessionLifetime = 8 * 60 * 60 * 1000;
const rememberLifetime = 30 * 24 * 60 * 60 * 1000;
const app = express();
const mailPreview = [];
let mailTransport;
let drainingOutbox = false;

if (isProduction && sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
}

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));
app.use(express.json({ limit: "20kb" }));

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare("SELECT sess, expire FROM sessions WHERE sid = ?").get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + sessionLifetime;
      db.prepare(`
        INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
      `).run(sid, JSON.stringify(value), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + sessionLifetime;
      db.prepare("UPDATE sessions SET expire = ? WHERE sid = ?").run(expiresAt, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

app.use(session({
  name: "ruangdigital.sid",
  secret: sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: sessionLifetime,
  },
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan. Coba lagi beberapa saat." },
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Permintaan reset terlalu sering. Coba lagi nanti." },
});

app.use("/api", apiLimiter, (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.path !== "/payments/midtrans/notification") {
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("host")) {
          return res.status(403).json({ error: "Asal permintaan tidak diizinkan." });
        }
      } catch {
        return res.status(403).json({ error: "Asal permintaan tidak valid." });
      }
    }
  }
  next();
});

app.get("/api/csrf", (req, res) => {
  req.session.csrfToken ||= crypto.randomBytes(32).toString("base64url");
  res.set("Cache-Control", "no-store");
  res.json({ token: req.session.csrfToken });
});

app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/payments/midtrans/notification") return next();
  const supplied = Buffer.from(req.get("x-csrf-token") || "");
  const expected = Buffer.from(req.session.csrfToken || "");
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: "Token keamanan tidak valid. Muat ulang halaman lalu coba lagi." });
  }
  next();
});

const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(8).max(128);
const projectTypes = ["Website", "Aplikasi", "Game", "Hosting", "VPS", "Maintenance", "Domain"];
const consultationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Batas permintaan konsultasi tercapai. Coba lagi satu jam lagi." },
});
const domainLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Terlalu banyak pemeriksaan domain. Coba lagi beberapa saat." },
});
const packages = {
  "hosting-basic": { name: "Hosting Basic", amount: 25000 },
  "hosting-pro": { name: "Hosting Pro", amount: 75000 },
  "vps-cloud": { name: "VPS Cloud", amount: 180000 },
};

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { error: issue ? `${issue.path.join(" ")} ${issue.message}`.trim() : "Data tidak valid." };
  }
  return { data: result.data };
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

async function createDatabaseBackup() {
  const backupDirectory = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(databasePath), "backups"));
  await fs.mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const fileName = `ruangdigital-${stamp}.sqlite`;
  const destination = path.join(backupDirectory, fileName);
  await db.backup(destination);
  const { size } = await fs.stat(destination);
  db.prepare("INSERT INTO backup_runs (id, backup_path, created_at, size_bytes) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), destination, new Date().toISOString(), size);

  const oldBackups = db.prepare(`
    SELECT id, backup_path FROM backup_runs
    ORDER BY created_at DESC LIMIT -1 OFFSET 14
  `).all();
  for (const backup of oldBackups) {
    await fs.rm(backup.backup_path, { force: true });
    db.prepare("DELETE FROM backup_runs WHERE id = ?").run(backup.id);
  }
  return { path: destination, size };
}

function scheduleDatabaseBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 15, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const timer = setTimeout(async () => {
    try {
      const backup = await createDatabaseBackup();
      console.info("Database backup completed", { path: backup.path, size: backup.size });
    } catch (error) {
      console.error("Database backup failed", error);
    } finally {
      scheduleDatabaseBackup();
    }
  }, next.getTime() - now.getTime());
  timer.unref();
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
  if (req.session.user.role !== "admin") return res.status(403).json({ error: "Akses khusus administrator." });
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: Boolean(user.email_verified ?? true),
  };
}

function startSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    const csrfToken = req.session.csrfToken;
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.user = publicUser(user);
      if (csrfToken) req.session.csrfToken = csrfToken;
      req.session.cookie.maxAge = remember ? rememberLifetime : sessionLifetime;
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

function endSession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
}

function configuredMailer() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;
  mailTransport ||= nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return mailTransport;
}

function mailConfigured() {
  if (process.env.RESEND_API_KEY || process.env.RESEND_FROM) {
    return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
  }
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

async function sendEmail({ recipient, subject, text }) {
  if (process.env.RESEND_API_KEY || process.env.RESEND_FROM) {
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
      throw new Error("RESEND_API_KEY and RESEND_FROM must both be configured.");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: [recipient],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Resend API request failed (${response.status}): ${result?.message || response.statusText}`);
    }
    return;
  }

  const mailer = configuredMailer();
  if (!mailer) throw new Error("Email delivery is not configured.");
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: recipient,
    subject,
    text,
  });
}

function encryptEmailText(text) {
  const key = crypto.createHash("sha256").update(sessionSecret).update(":ruangdigital-email-outbox-v1").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
}

function decryptEmailText(value) {
  const { iv, tag, data } = JSON.parse(value);
  const key = crypto.createHash("sha256").update(sessionSecret).update(":ruangdigital-email-outbox-v1").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

function queueEmail(recipient, subject, text) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO email_outbox (id, recipient, subject, encrypted_text, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, recipient, subject, encryptEmailText(text), Date.now(), new Date().toISOString());
  return id;
}

async function drainEmailOutbox() {
  if (drainingOutbox || !mailConfigured()) return;
  drainingOutbox = true;
  try {
    const messages = db.prepare(`
      SELECT id, recipient, subject, encrypted_text, attempts
      FROM email_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at ASC LIMIT 10
    `).all(Date.now());
    for (const message of messages) {
      const claimed = db.prepare("UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status = 'pending'").run(message.id);
      if (!claimed.changes) continue;
      try {
        await sendEmail({
          recipient: message.recipient,
          subject: message.subject,
          text: decryptEmailText(message.encrypted_text),
        });
        db.prepare("UPDATE email_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
          .run(new Date().toISOString(), message.id);
      } catch (error) {
        const attempts = message.attempts + 1;
        const status = attempts >= 8 ? "failed" : "pending";
        const retryAt = Date.now() + Math.min(30_000 * (2 ** message.attempts), 6 * 60 * 60 * 1000);
        db.prepare(`
          UPDATE email_outbox
          SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?
        `).run(status, attempts, retryAt, String(error.message).slice(0, 500), message.id);
        console.error("Email delivery failed", { id: message.id, attempt: attempts, message: error.message });
      }
    }
  } finally {
    drainingOutbox = false;
  }
}

function enqueueEmailNotification(recipient, subject, text) {
  if (!recipient) return;
  queueEmail(recipient, subject, text);
  void drainEmailOutbox().catch((error) => console.error("Email outbox processing failed", error));
}

async function seedAdministrator() {
  const emailResult = emailSchema.safeParse(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!emailResult.success || !password) return;
  const checkedPassword = passwordSchema.safeParse(password);
  if (!checkedPassword.success) {
    throw new Error("ADMIN_PASSWORD must contain 8–128 characters.");
  }
  const email = emailResult.data;
  const existing = db.prepare("SELECT id, role, password_hash FROM users WHERE email = ?").get(email);
  if (existing) {
    if (existing.role !== "admin") {
      if (!await bcrypt.compare(password, existing.password_hash)) {
        throw new Error("ADMIN_EMAIL already belongs to a non-admin account. Promote it only after verifying ownership.");
      }
      db.prepare("UPDATE users SET role = 'admin', email_verified = 1 WHERE id = ?").run(existing.id);
    }
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (id, name, email, password_hash, role, email_verified, created_at) VALUES (?, ?, ?, ?, 'admin', 1, ?)")
    .run(crypto.randomUUID(), "Administrator", email, hash, new Date().toISOString());
}

app.get("/api/health", (_req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ status: "ok", database: "connected" });
});

app.get("/api/catalog", (_req, res) => {
  res.json({ packages: Object.entries(packages).map(([id, item]) => ({ id, ...item })) });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  if (!mailConfigured() && process.env.NODE_ENV !== "test") {
    return res.status(503).json({ error: "Pendaftaran belum tersedia karena layanan email verifikasi belum dikonfigurasi." });
  }
  const parsed = validate(z.object({
    name: z.string().trim().min(2).max(100),
    email: emailSchema,
    password: passwordSchema,
    remember: z.boolean().optional().default(false),
  }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const { name, email, password } = parsed.data;
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      return res.status(409).json({ error: "Email sudah terdaftar." });
    }
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      role: "customer",
      password_hash: await bcrypt.hash(password, 12),
      email_verified: 0,
    };
    const createdAt = new Date().toISOString();
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const createUser = db.transaction(() => {
      db.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(Date.now());
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, email_verified, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(user.id, user.name, user.email, user.password_hash, user.role, createdAt);
      db.prepare(`
        INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), user.id, tokenHash, expiresAt, createdAt);
    });
    createUser();
    const verificationUrl = new URL("/", publicBaseUrl);
    verificationUrl.searchParams.set("verify_email", token);
    if (process.env.NODE_ENV === "test") {
      mailPreview.push({ to: user.email, subject: "Verifikasi email RuangDigital", text: verificationUrl.href });
    } else {
      enqueueEmailNotification(
        user.email,
        "Verifikasi email RuangDigital",
        `Halo ${user.name}, verifikasi alamat email Anda dalam 24 jam dengan membuka tautan berikut:\n${verificationUrl.href}`,
      );
    }
    res.status(201).json({ message: "Akun dibuat. Verifikasi alamat email melalui tautan yang dikirim sebelum masuk." });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Email sudah terdaftar." });
    next(error);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  const parsed = validate(z.object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    remember: z.boolean().optional().default(false),
  }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(parsed.data.email);
    const valid = user && await bcrypt.compare(parsed.data.password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Email atau kata sandi tidak cocok." });
    if (!user.email_verified) {
      return res.status(403).json({ error: "EMAIL_NOT_VERIFIED: Verifikasi email sebelum masuk." });
    }
    await startSession(req, user, parsed.data.remember);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/email/verify", authLimiter, async (req, res, next) => {
  const parsed = validate(z.object({ token: z.string().min(32).max(128) }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: "Tautan verifikasi tidak valid atau kedaluwarsa." });
  try {
    const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
    const record = db.prepare(`
      SELECT t.id, t.user_id FROM email_verification_tokens t
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?
    `).get(tokenHash, Date.now());
    if (!record) return res.status(400).json({ error: "Tautan verifikasi tidak valid atau kedaluwarsa." });
    const verify = db.transaction(() => {
      const consumed = db.prepare(`
        UPDATE email_verification_tokens SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(Date.now(), record.id, Date.now());
      if (!consumed.changes) return false;
      db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(record.user_id);
      return true;
    });
    if (!verify()) return res.status(400).json({ error: "Tautan verifikasi tidak valid atau kedaluwarsa." });
    res.json({ message: "Email berhasil diverifikasi. Silakan masuk." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/email/resend", authLimiter, (req, res) => {
  const parsed = validate(z.object({ email: emailSchema }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!mailConfigured() && process.env.NODE_ENV !== "test") {
    return res.status(503).json({ error: "Layanan email belum dikonfigurasi." });
  }
  const user = db.prepare("SELECT id, name, email, email_verified FROM users WHERE email = ?").get(parsed.data.email);
  if (user && !user.email_verified) {
    const token = crypto.randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL").run(user.id);
    db.prepare(`
      INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      user.id,
      crypto.createHash("sha256").update(token).digest("hex"),
      Date.now() + 24 * 60 * 60 * 1000,
      createdAt,
    );
    const verificationUrl = new URL("/", publicBaseUrl);
    verificationUrl.searchParams.set("verify_email", token);
    if (process.env.NODE_ENV === "test") {
      mailPreview.push({ to: user.email, subject: "Verifikasi email RuangDigital", text: verificationUrl.href });
    } else {
      enqueueEmailNotification(user.email, "Verifikasi email RuangDigital", `Verifikasi email Anda:\n${verificationUrl.href}`);
    }
  }
  res.json({ message: "Jika akun belum terverifikasi, tautan verifikasi akan dikirim." });
});

app.post("/api/auth/logout", requireAuth, async (req, res, next) => {
  try {
    await endSession(req);
    res.clearCookie("ruangdigital.sid", { httpOnly: true, sameSite: "lax", secure: isProduction, path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/password/forgot", resetLimiter, async (req, res, next) => {
  const parsed = validate(z.object({ email: emailSchema }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!mailConfigured() && process.env.NODE_ENV !== "test") {
    return res.status(503).json({ error: "Fitur reset kata sandi belum dikonfigurasi. Hubungi administrator." });
  }

  try {
    const user = db.prepare("SELECT id, email FROM users WHERE email = ? AND email_verified = 1").get(parsed.data.email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = Date.now() + 30 * 60 * 1000;
      db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(Date.now());
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL").run(user.id);
      db.prepare(`
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), user.id, tokenHash, expiresAt, new Date().toISOString());
      const resetUrl = new URL("/", publicBaseUrl);
      resetUrl.searchParams.set("reset_token", rawToken);
      const emailText = `Gunakan tautan ini dalam 30 menit untuk membuat kata sandi baru: ${resetUrl.href}\nJika Anda tidak meminta reset, abaikan email ini.`;
      if (process.env.NODE_ENV === "test") {
        mailPreview.push({ to: user.email, subject: "Reset kata sandi RuangDigital", text: emailText });
      } else {
        enqueueEmailNotification(user.email, "Reset kata sandi RuangDigital", emailText);
      }
    }
    res.json({ message: "Jika email terdaftar, tautan reset akan dikirim." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/password/reset", resetLimiter, async (req, res, next) => {
  const parsed = validate(z.object({
    token: z.string().min(32).max(128),
    password: passwordSchema,
  }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
    const reset = db.prepare(`
      SELECT id, user_id FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(tokenHash, Date.now());
    if (!reset) return res.status(400).json({ error: "Tautan reset tidak valid atau sudah kedaluwarsa." });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const updateReset = db.transaction(() => {
      const consumed = db.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(Date.now(), reset.id, Date.now());
      if (!consumed.changes) return false;
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, reset.user_id);
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ?").run(reset.user_id);
      return true;
    });
    if (!updateReset()) return res.status(400).json({ error: "Tautan reset tidak valid atau sudah kedaluwarsa." });
    res.json({ message: "Kata sandi berhasil diubah. Silakan masuk kembali." });
  } catch (error) {
    next(error);
  }
});

app.post("/api/consultations", consultationLimiter, requireAuth, (req, res) => {
  const parsed = validate(z.object({
    name: z.string().trim().min(2).max(100),
    contact: z.string().trim().min(3).max(254),
    project: z.enum(projectTypes),
    budget: z.string().trim().max(80).default("Belum ditentukan"),
    details: z.string().trim().max(3000).default(""),
    website: z.string().max(500).optional().default(""),
  }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.data.website) return res.status(202).json({ message: "Permintaan konsultasi tersimpan." });

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO consultations (id, user_id, name, contact, project, budget, details, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(
    id,
    req.session.user.id,
    parsed.data.name,
    parsed.data.contact,
    parsed.data.project,
    parsed.data.budget,
    parsed.data.details,
    new Date().toISOString(),
  );
  const account = db.prepare("SELECT email FROM users WHERE id = ?").get(req.session.user.id);
  enqueueEmailNotification(
    account.email,
    "Permintaan konsultasi diterima — RuangDigital",
    `Halo ${parsed.data.name}, permintaan konsultasi ${parsed.data.project} Anda sudah kami terima. Tim kami akan menghubungi melalui ${parsed.data.contact}.`,
  );
  enqueueEmailNotification(
    process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL,
    "Permintaan konsultasi baru — RuangDigital",
    `Nama: ${parsed.data.name}\nKontak: ${parsed.data.contact}\nLayanan: ${parsed.data.project}\nBudget: ${parsed.data.budget}\nRincian: ${parsed.data.details || "-"}`,
  );
  res.status(201).json({ id, status: "new", message: "Permintaan konsultasi tersimpan." });
});

app.post("/api/domain/check", domainLimiter, async (req, res, next) => {
  const parsed = validate(z.object({
    domain: z.string().trim().toLowerCase().max(253),
  }).strict(), req.body);
  const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (parsed.error || !domainPattern.test(parsed.data?.domain || "")) {
    return res.status(400).json({ error: "Masukkan nama domain yang valid, misalnya namabisnis.com." });
  }

  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(parsed.data.domain)}`, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": "RuangDigitalDomainCheck/1.0" },
      signal: AbortSignal.timeout(7000),
    });
    if (response.status === 404) {
      return res.json({
        domain: parsed.data.domain,
        status: "possibly_available",
        message: "Domain tidak ditemukan di RDAP. Ketersediaan akhir tetap perlu dikonfirmasi registrar.",
      });
    }
    if (response.ok) {
      return res.json({
        domain: parsed.data.domain,
        status: "registered",
        message: "Domain tercatat di RDAP. Periksa registrar untuk opsi dan status terkini.",
      });
    }
    res.status(502).json({ error: "Layanan pemeriksaan domain sedang tidak tersedia. Coba lagi nanti." });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return res.status(504).json({ error: "Pemeriksaan domain melewati batas waktu. Coba lagi." });
    }
    next(error);
  }
});

app.post("/api/orders", rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false }), requireAuth, async (req, res, next) => {
  const parsed = validate(z.object({ packageId: z.string().min(1).max(50) }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const item = packages[parsed.data.packageId];
  if (!item) return res.status(400).json({ error: "Paket tidak dikenal." });
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) return res.status(503).json({ error: "Pembayaran belum dikonfigurasi. Silakan hubungi administrator." });

  const orderId = `RD-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const invoiceNumber = `INV-${new Date().getUTCFullYear()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  db.prepare(`
    INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status, invoice_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(orderId, req.session.user.id, parsed.data.packageId, item.name, item.amount, invoiceNumber, timestamp, timestamp);

  try {
    const production = process.env.MIDTRANS_IS_PRODUCTION === "true";
    const endpoint = production
      ? "https://app.midtrans.com/snap/v1/transactions"
      : "https://app.sandbox.midtrans.com/snap/v1/transactions";
    const providerResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        transaction_details: { order_id: orderId, gross_amount: item.amount },
        item_details: [{ id: parsed.data.packageId, price: item.amount, quantity: 1, name: item.name }],
        customer_details: { first_name: req.session.user.name, email: req.session.user.email },
        callbacks: { finish: new URL("/?payment=finish", publicBaseUrl).href },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const providerData = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok || !providerData.token || !providerData.redirect_url) {
      db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), orderId);
      console.error("Midtrans transaction creation failed", { status: providerResponse.status });
      enqueueEmailNotification(
        req.session.user.email,
        `Pembayaran belum dibuat — Invoice ${invoiceNumber}`,
        `Checkout untuk ${item.name} belum dapat dibuat. Tidak ada pembayaran yang diproses. Silakan coba lagi nanti.`,
      );
      return res.status(502).json({ error: "Pembayaran belum dapat dibuat. Coba lagi atau hubungi administrator." });
    }
    db.prepare("UPDATE orders SET midtrans_token = ?, redirect_url = ?, updated_at = ? WHERE id = ?")
      .run(providerData.token, providerData.redirect_url, new Date().toISOString(), orderId);
    enqueueEmailNotification(
      req.session.user.email,
      `Invoice ${invoiceNumber} — RuangDigital`,
      `Pesanan ${item.name} telah dibuat.\nNomor invoice: ${invoiceNumber}\nJumlah: ${formatCurrency(item.amount)}\nStatus: menunggu pembayaran.\nInvoice: ${new URL(`/api/orders/${encodeURIComponent(orderId)}/invoice.pdf`, publicBaseUrl).href}\nLanjutkan pembayaran: ${providerData.redirect_url}`,
    );
    enqueueEmailNotification(
      process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL,
      `Pesanan baru ${invoiceNumber} — RuangDigital`,
      `Pelanggan: ${req.session.user.name} (${req.session.user.email})\nPaket: ${item.name}\nJumlah: ${formatCurrency(item.amount)}\nStatus: menunggu pembayaran.`,
    );
    res.status(201).json({ orderId, redirectUrl: providerData.redirect_url });
  } catch (error) {
    db.prepare("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), orderId);
    next(error);
  }
});

app.get("/api/orders", requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT id, package_id AS packageId, package_name AS packageName, amount,
      payment_status AS paymentStatus, redirect_url AS redirectUrl, invoice_number AS invoiceNumber,
      service_status AS serviceStatus, service_details AS storedServiceDetails,
      expires_at AS expiresAt, created_at AS createdAt
    FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.session.user.id);
  res.json({
    orders: orders.map(({ storedServiceDetails, serviceStatus, ...order }) => ({
      ...order,
      serviceStatus,
      serviceDetails: ["active", "completed", "expired"].includes(serviceStatus) && storedServiceDetails
        ? decryptAccessData(storedServiceDetails, accessDataKeyring)
        : null,
    })),
  });
});

app.get("/api/orders/:id", requireAuth, (req, res) => {
  const order = db.prepare(`
    SELECT id, package_id AS packageId, package_name AS packageName, amount,
      payment_status AS paymentStatus, service_status AS serviceStatus,
      service_details AS storedServiceDetails, expires_at AS expiresAt, created_at AS createdAt
    FROM orders WHERE id = ? AND (? = 'admin' OR user_id = ?)
  `).get(req.params.id, req.session.user.role, req.session.user.id);
  if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
  const { storedServiceDetails, ...publicOrder } = order;
  res.json({
    order: {
      ...publicOrder,
      serviceDetails: ["active", "completed", "expired"].includes(order.serviceStatus) && storedServiceDetails
        ? decryptAccessData(storedServiceDetails, accessDataKeyring)
        : null,
    },
  });
});

app.get("/api/orders/:id/invoice.pdf", requireAuth, (req, res, next) => {
  const order = db.prepare(`
    SELECT o.id, o.invoice_number AS invoiceNumber, o.package_name AS packageName,
      o.amount, o.payment_status AS paymentStatus, o.service_status AS serviceStatus,
      o.created_at AS createdAt, u.name AS customerName, u.email AS customerEmail
    FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.id = ? AND (? = 'admin' OR o.user_id = ?)
  `).get(req.params.id, req.session.user.role, req.session.user.id);
  if (!order) return res.status(404).json({ error: "Invoice tidak ditemukan." });

  const invoiceNumber = order.invoiceNumber || `INV-${order.id.slice(-10).toUpperCase()}`;
  res.set({
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${invoiceNumber}.pdf"`,
    "cache-control": "private, no-store",
  });
  const document = new PDFDocument({ size: "A4", margin: 54, info: { Title: `Invoice ${invoiceNumber}`, Author: "RuangDigital" } });
  document.on("error", next);
  document.pipe(res);
  document.fillColor("#173c73").fontSize(23).font("Helvetica-Bold").text("RuangDigital");
  document.moveDown(0.35).fillColor("#66758e").fontSize(10).font("Helvetica").text("Invoice layanan digital");
  document.moveDown(1.7).fillColor("#17233b").fontSize(19).font("Helvetica-Bold").text("INVOICE");
  document.moveDown(0.5).fontSize(10).font("Helvetica").fillColor("#5c6b82")
    .text(`Nomor invoice: ${invoiceNumber}`)
    .text(`Tanggal: ${new Date(order.createdAt).toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "UTC" })}`)
    .moveDown(1.2);
  document.fillColor("#17233b").font("Helvetica-Bold").text("Ditagihkan kepada");
  document.font("Helvetica").fillColor("#5c6b82").text(order.customerName).text(order.customerEmail);
  document.moveDown(1.5);
  const tableTop = document.y;
  document.fillColor("#edf3ff").roundedRect(54, tableTop, 487, 31, 6).fill();
  document.fillColor("#294b7b").font("Helvetica-Bold").fontSize(9)
    .text("DESKRIPSI", 66, tableTop + 10)
    .text("JUMLAH", 410, tableTop + 10, { width: 120, align: "right" });
  document.fillColor("#25334a").font("Helvetica").fontSize(11)
    .text(order.packageName, 66, tableTop + 49)
    .text(formatCurrency(order.amount), 340, tableTop + 49, { width: 190, align: "right" });
  document.moveTo(66, tableTop + 78).lineTo(529, tableTop + 78).strokeColor("#e4eaf3").stroke();
  document.fillColor("#66758e").fontSize(10).text("Total", 340, tableTop + 94, { width: 90, align: "right" });
  document.fillColor("#173c73").font("Helvetica-Bold").fontSize(14)
    .text(formatCurrency(order.amount), 340, tableTop + 91, { width: 190, align: "right" });
  document.moveDown(4);
  document.fillColor("#66758e").font("Helvetica").fontSize(10)
    .text(`Status pembayaran: ${order.paymentStatus}`)
    .text(`Status layanan: ${order.serviceStatus}`);
  document.moveDown(1.5)
    .fontSize(9)
    .text("Dokumen ini diterbitkan secara elektronik oleh RuangDigital. Pembayaran diproses melalui Midtrans.");
  document.end();
});

app.post("/api/payments/midtrans/notification", async (req, res) => {
  const parsed = validate(z.object({
    order_id: z.string().min(1).max(50),
    status_code: z.string().regex(/^\d{1,10}$/),
    gross_amount: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/),
    signature_key: z.string().regex(/^[a-fA-F0-9]{128}$/),
    transaction_status: z.string().min(1).max(30),
    fraud_status: z.string().max(30).optional(),
  }), req.body);
  if (parsed.error) return res.status(400).json({ error: "Notifikasi pembayaran tidak valid." });
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey) return res.status(503).json({ error: "Pembayaran belum dikonfigurasi." });

  const data = parsed.data;
  const expected = crypto.createHash("sha512")
    .update(`${data.order_id}${data.status_code}${data.gross_amount}${serverKey}`)
    .digest("hex");
  const receivedBytes = Buffer.from(data.signature_key.toLowerCase(), "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (receivedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(receivedBytes, expectedBytes)) {
    return res.status(403).json({ error: "Signature pembayaran tidak valid." });
  }

  const order = db.prepare(`
    SELECT o.id, o.amount, o.payment_status, o.package_name, o.invoice_number,
      u.id AS userId, u.name AS customerName, u.email AS customerEmail
    FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?
  `).get(data.order_id);
  const grossAmount = Number(data.gross_amount);
  if (!order || !Number.isSafeInteger(grossAmount) || order.amount !== grossAmount) {
    return res.status(404).json({ error: "Pesanan tidak ditemukan atau jumlah tidak sesuai." });
  }

  let paymentStatus = "pending";
  if (data.transaction_status === "settlement" ||
      (data.transaction_status === "capture" && data.fraud_status === "accept")) paymentStatus = "paid";
  else if (["deny", "expire"].includes(data.transaction_status)) paymentStatus = "failed";
  else if (data.transaction_status === "cancel") paymentStatus = "cancelled";
  else if (["refund", "partial_refund"].includes(data.transaction_status)) paymentStatus = "refunded";

  if (order.payment_status === "paid" && paymentStatus !== "refunded") paymentStatus = "paid";
  if (order.payment_status === "refunded") paymentStatus = "refunded";
  const now = new Date().toISOString();
  const updated = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE orders
      SET payment_status = ?,
          service_status = CASE WHEN ? = 'paid' AND service_status = 'awaiting_payment' THEN 'awaiting_activation' ELSE service_status END,
          updated_at = ?
      WHERE id = ? AND payment_status != ?
    `).run(paymentStatus, paymentStatus, now, order.id, paymentStatus);
    return changed.changes > 0;
  })();
  if (updated && paymentStatus === "paid") {
    enqueueEmailNotification(
      order.customerEmail,
      `Pembayaran berhasil — Invoice ${order.invoice_number}`,
      `Halo ${order.customerName}, pembayaran ${formatCurrency(order.amount)} untuk ${order.package_name} berhasil diterima.\nStatus layanan: menunggu aktivasi.\nInvoice: ${new URL(`/api/orders/${encodeURIComponent(order.id)}/invoice.pdf`, publicBaseUrl).href}`,
    );
    enqueueEmailNotification(
      process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL,
      `Pembayaran berhasil — ${order.invoice_number}`,
      `Pelanggan: ${order.customerName} (${order.customerEmail})\nPaket: ${order.package_name}\nJumlah: ${formatCurrency(order.amount)}\nStatus layanan: menunggu aktivasi.`,
    );
  } else if (updated && ["failed", "cancelled", "refunded"].includes(paymentStatus)) {
    enqueueEmailNotification(
      order.customerEmail,
      `Pembaruan pembayaran — Invoice ${order.invoice_number}`,
      `Status pembayaran ${order.invoice_number} (${order.package_name}) berubah menjadi ${paymentStatus}.\nInvoice: ${new URL(`/api/orders/${encodeURIComponent(order.id)}/invoice.pdf`, publicBaseUrl).href}`,
    );
    enqueueEmailNotification(
      process.env.ADMIN_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL,
      `Status pembayaran ${paymentStatus} — ${order.invoice_number}`,
      `Pelanggan: ${order.customerName} (${order.customerEmail})\nPaket: ${order.package_name}\nJumlah: ${formatCurrency(order.amount)}\nStatus: ${paymentStatus}.`,
    );
  }
  res.status(200).json({ status: "ok" });
});

app.get("/api/admin/summary", requireAdmin, (_req, res) => {
  const consultations = db.prepare("SELECT COUNT(*) AS count FROM consultations WHERE status = 'new'").get().count;
  const pendingOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE payment_status = 'pending'").get().count;
  const paidOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE payment_status = 'paid'").get().count;
  res.json({ consultations, pendingOrders, paidOrders });
});

app.post("/api/admin/backups", requireAdmin, async (_req, res, next) => {
  try {
    const backup = await createDatabaseBackup();
    res.status(201).json({ created: true, sizeBytes: backup.size, fileName: path.basename(backup.path) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/consultations", requireAdmin, (_req, res) => {
  const consultations = db.prepare(`
    SELECT c.id, c.name, c.contact, c.project, c.budget, c.details, c.status,
      c.created_at AS createdAt, u.email AS accountEmail
    FROM consultations c JOIN users u ON u.id = c.user_id
    ORDER BY c.created_at DESC LIMIT 100
  `).all();
  res.json({ consultations });
});

app.patch("/api/admin/consultations/:id", requireAdmin, (req, res) => {
  const parsed = validate(z.object({ status: z.enum(["new", "contacted", "closed"]) }).strict(), req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const consultation = db.prepare(`
    SELECT c.status AS previousStatus, c.project, c.name, u.email
    FROM consultations c JOIN users u ON u.id = c.user_id WHERE c.id = ?
  `).get(req.params.id);
  if (!consultation) return res.status(404).json({ error: "Permintaan tidak ditemukan." });
  db.prepare("UPDATE consultations SET status = ? WHERE id = ?").run(parsed.data.status, req.params.id);
  if (consultation.previousStatus !== parsed.data.status) {
    enqueueEmailNotification(
      consultation.email,
      "Pembaruan permintaan konsultasi — RuangDigital",
      `Halo ${consultation.name}, status permintaan ${consultation.project} Anda berubah menjadi ${parsed.data.status}.`,
    );
  }
  res.json({ status: parsed.data.status });
});

app.get("/api/admin/orders", requireAdmin, (_req, res) => {
  const orders = db.prepare(`
    SELECT o.id, o.package_name AS packageName, o.amount, o.payment_status AS paymentStatus,
      o.invoice_number AS invoiceNumber, o.service_status AS serviceStatus, o.expires_at AS expiresAt,
      o.created_at AS createdAt, u.name AS customerName, u.email AS customerEmail
    FROM orders o JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT 100
  `).all();
  res.json({ orders });
});

app.patch("/api/admin/orders/:id/service", requireAdmin, (req, res, next) => {
  const statusResult = validate(z.object({
    serviceStatus: z.enum(["processing", "active", "completed", "expired", "cancelled"]),
  }).passthrough(), req.body);
  if (statusResult.error) return res.status(400).json({ error: statusResult.error });

  const nextStatus = statusResult.data.serviceStatus;
  let accessDetails;
  let expiresAt = null;
  if (nextStatus === "active") {
    if (!accessDataKeyring.activeVersion) {
      return res.status(503).json({ error: "Enkripsi detail akses belum dikonfigurasi." });
    }
    const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "tanggal tidak valid");
    const activationResult = validate(z.object({
      serviceStatus: z.literal("active"),
      serviceType: z.enum(["hosting", "vps"]),
      host: z.string().trim().min(1).max(255),
      username: z.string().trim().min(1).max(100),
      port: z.number().int().min(1).max(65535).nullable(),
      notes: z.string().trim().max(2000),
      startedAt: dateSchema,
      expiresAt: dateSchema,
    }).strict(), req.body);
    if (activationResult.error) return res.status(400).json({ error: activationResult.error });
    if (activationResult.data.expiresAt <= activationResult.data.startedAt) {
      return res.status(400).json({ error: "Tanggal berakhir harus setelah tanggal aktif." });
    }
    accessDetails = {
      serviceType: activationResult.data.serviceType,
      host: activationResult.data.host,
      username: activationResult.data.username,
      port: activationResult.data.port,
      notes: activationResult.data.notes,
      startedAt: activationResult.data.startedAt,
    };
    expiresAt = activationResult.data.expiresAt;
  } else if (Object.keys(req.body || {}).length !== 1) {
    return res.status(400).json({ error: "Perubahan status ini tidak menerima detail akses." });
  }

  const order = db.prepare(`
    SELECT o.id, o.user_id AS userId, o.payment_status AS paymentStatus,
      o.service_status AS serviceStatus, o.package_name AS packageName,
      o.invoice_number AS invoiceNumber, u.email AS customerEmail
    FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
  if (order.paymentStatus !== "paid") {
    return res.status(409).json({ error: "Layanan hanya dapat diproses setelah pembayaran berhasil." });
  }

  const transitions = {
    awaiting_activation: ["processing", "cancelled"],
    processing: ["active", "cancelled"],
    active: ["completed", "expired"],
  };
  if (!transitions[order.serviceStatus]?.includes(nextStatus)) {
    return res.status(409).json({ error: `Status layanan tidak dapat diubah dari ${order.serviceStatus} menjadi ${nextStatus}.` });
  }

  const now = new Date().toISOString();
  try {
    const saveServiceUpdate = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE orders
        SET service_status = ?, service_details = COALESCE(?, service_details),
            expires_at = COALESCE(?, expires_at), updated_at = ?
        WHERE id = ? AND payment_status = 'paid' AND service_status = ?
      `).run(
        nextStatus,
        accessDetails ? encryptAccessData(accessDetails, accessDataKeyring) : null,
        expiresAt,
        now,
        order.id,
        order.serviceStatus,
      );
      if (!updated.changes) return false;
      db.prepare(`
        INSERT INTO service_order_events (id, order_id, actor_user_id, event_type, from_status, to_status, created_at)
        VALUES (?, ?, ?, 'status_changed', ?, ?, ?)
      `).run(crypto.randomUUID(), order.id, req.session.user.id, order.serviceStatus, nextStatus, now);
      if (accessDetails) {
        db.prepare(`
          INSERT INTO service_order_events (id, order_id, actor_user_id, event_type, from_status, to_status, created_at)
          VALUES (?, ?, ?, 'access_details_saved', ?, ?, ?)
        `).run(crypto.randomUUID(), order.id, req.session.user.id, order.serviceStatus, nextStatus, now);
      }
      return true;
    })();
    if (!saveServiceUpdate) {
      return res.status(409).json({ error: "Status pesanan berubah. Muat ulang dashboard lalu coba lagi." });
    }
    if (nextStatus === "active") {
      enqueueEmailNotification(
        order.customerEmail,
        `Layanan aktif — Invoice ${order.invoiceNumber}`,
        `Layanan ${order.packageName} Anda sudah aktif. Masuk ke akun RuangDigital untuk melihat detail akses pesanan secara aman.`,
      );
    }
    res.json({ serviceStatus: nextStatus });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/orders/:id/history", requireAdmin, (req, res) => {
  const exists = db.prepare("SELECT 1 FROM orders WHERE id = ?").get(req.params.id);
  if (!exists) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
  const events = db.prepare(`
    SELECT e.event_type AS eventType, e.from_status AS fromStatus, e.to_status AS toStatus,
      e.created_at AS createdAt, u.email AS actorEmail
    FROM service_order_events e JOIN users u ON u.id = e.actor_user_id
    WHERE e.order_id = ? ORDER BY e.created_at DESC
  `).all(req.params.id);
  res.json({ events });
});

const staticOptions = { dotfiles: "deny", maxAge: isProduction ? "1h" : 0 };
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get(["/privacy.html", "/terms.html", "/style.css", "/script.js", "/admin.css", "/admin.js"], (req, res, next) => {
  const allowedFiles = new Set(["privacy.html", "terms.html", "style.css", "script.js", "admin.css", "admin.js"]);
  const fileName = path.basename(req.path);
  if (!allowedFiles.has(fileName)) return next();
  res.sendFile(path.join(__dirname, fileName));
});
app.use("/ui", express.static(path.join(__dirname, "dist"), { ...staticOptions, maxAge: 0 }));
app.use("/assets", express.static(path.join(__dirname, "assets"), staticOptions));
app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));

app.use((error, _req, res, _next) => {
  console.error("Request failed", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Terjadi kesalahan server. Coba lagi nanti." });
});

export { app, closeDatabase, createDatabaseBackup, drainEmailOutbox, mailPreview, seedAdministrator, sendEmail };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await seedAdministrator();
    const port = Number(process.env.PORT || 8000);
    app.listen(port, "0.0.0.0", () => {
      console.log(`RuangDigital backend listening on port ${port}`);
      if (mailConfigured()) {
        db.prepare("UPDATE email_outbox SET status = 'pending' WHERE status = 'sending'").run();
        void drainEmailOutbox().catch((error) => console.error("Email outbox processing failed", error));
        const outboxTimer = setInterval(() => {
          void drainEmailOutbox().catch((error) => console.error("Email outbox processing failed", error));
        }, 15_000);
        outboxTimer.unref();
      }
      scheduleDatabaseBackup();
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
        console.warn("Admin is not provisioned. Set ADMIN_EMAIL and ADMIN_PASSWORD in the server environment.");
      }
    });
  } catch (error) {
    console.error("Server startup failed", error);
    process.exitCode = 1;
    closeDatabase();
  }
}
