import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import {
  decryptAccessData,
  encryptAccessData,
  loadAccessDataKeyring,
  migrateAccessDataRows,
} from "../access-data.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruangdigital-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempDir, "test.sqlite");
process.env.SESSION_SECRET = "test-session-secret-with-more-than-32-characters";
process.env.PUBLIC_BASE_URL = "http://localhost:8000";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "test-admin-password-123";
process.env.BACKUP_DIR = path.join(tempDir, "backups");
process.env.ACCESS_DATA_KEY_VERSION = "v1";
process.env.ACCESS_DATA_KEY = crypto.randomBytes(32).toString("base64");
delete process.env.MIDTRANS_SERVER_KEY;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

let app;
let db;
let closeDatabase;
let customer;
let admin;
let mailPreview;
let userId;

async function mutate(agent, method, url, body, clientIp) {
  const { body: csrf } = await agent.get("/api/csrf");
  const mutation = agent[method](url).set("x-csrf-token", csrf.token);
  if (clientIp) mutation.set("x-forwarded-for", clientIp);
  return mutation.send(body);
}

function emailToken(recipient, subject, parameter) {
  const message = mailPreview.filter((item) => item.to === recipient && item.subject.includes(subject)).at(-1);
  const link = message?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, `Expected ${subject} email for ${recipient}`);
  return new URL(link).searchParams.get(parameter);
}

before(async () => {
  const server = await import("../server.js");
  app = server.app;
  closeDatabase = server.closeDatabase;
  mailPreview = server.mailPreview;
  db = (await import("../database.js")).db;
  await server.seedAdministrator();
  admin = request.agent(app);
  const adminLogin = await mutate(admin, "post", "/api/auth/login", {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assert.equal(adminLogin.status, 200);
});

after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("health and package catalog are available", async () => {
  const health = await request(app).get("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok", database: "connected" });
  const catalog = await request(app).get("/api/catalog");
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.packages.map((item) => item.id), ["hosting-basic", "hosting-pro", "vps-cloud"]);
});

test("service access data is authenticated, encrypted, and supports key rotation", () => {
  const firstKey = process.env.ACCESS_DATA_KEY;
  const firstKeyring = loadAccessDataKeyring(process.env, true);
  const value = { host: "private.example.test", username: "customer", notes: "safe note" };
  const envelope = encryptAccessData(value, firstKeyring);
  assert.match(envelope, /^rd-access:1:v1:/);
  assert.equal(envelope.includes(value.host), false);
  assert.deepEqual(decryptAccessData(envelope, firstKeyring), value);

  const parts = envelope.split(":");
  const tamperedTag = Buffer.from(parts[4], "base64");
  tamperedTag[0] ^= 1;
  parts[4] = tamperedTag.toString("base64");
  assert.throws(() => decryptAccessData(parts.join(":"), firstKeyring), /authenticated/i);

  const wrongKeyring = loadAccessDataKeyring({
    ACCESS_DATA_KEY_VERSION: "v1",
    ACCESS_DATA_KEY: crypto.randomBytes(32).toString("base64"),
  }, true);
  assert.throws(() => decryptAccessData(envelope, wrongKeyring), /authenticated/i);
  assert.throws(() => loadAccessDataKeyring({}, true), /ACCESS_DATA_KEY/);
  assert.throws(() => loadAccessDataKeyring({
    ACCESS_DATA_KEY_VERSION: "v1",
    ACCESS_DATA_KEY: Buffer.alloc(16).toString("base64"),
  }, true), /32-byte/);

  const rotatedKeyring = loadAccessDataKeyring({
    ACCESS_DATA_KEY_VERSION: "v2",
    ACCESS_DATA_KEY: crypto.randomBytes(32).toString("base64"),
    ACCESS_DATA_KEY_V1: firstKey,
  }, true);
  assert.deepEqual(decryptAccessData(envelope, rotatedKeyring), value);
  assert.match(encryptAccessData(value, rotatedKeyring), /^rd-access:1:v2:/);
});

test("registration creates a hashed account and a persistent login session", async () => {
  customer = request.agent(app);
  const registration = await mutate(customer, "post", "/api/auth/register", {
    name: "Rina Example",
    email: "Rina@example.com",
    password: "example-password-123",
    remember: true,
  });
  assert.equal(registration.status, 201);
  assert.match(registration.body.message, /verifikasi/i);
  const stored = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("rina@example.com");
  assert.notEqual(stored.password_hash, "example-password-123");
  userId = db.prepare("SELECT id FROM users WHERE email = ?").get("rina@example.com").id;
  assert.equal((await customer.get("/api/auth/me")).body.user, null);
  const unverifiedLogin = await mutate(customer, "post", "/api/auth/login", {
    email: "rina@example.com",
    password: "example-password-123",
  });
  assert.equal(unverifiedLogin.status, 403);
  assert.match(unverifiedLogin.body.error, /EMAIL_NOT_VERIFIED/);

  const duplicate = await mutate(customer, "post", "/api/auth/register", {
    name: "Another Name",
    email: "rina@example.com",
    password: "example-password-123",
  });
  assert.equal(duplicate.status, 409);

  const verificationEmail = mailPreview.find((message) => message.to === "rina@example.com" && message.subject.includes("Verifikasi"));
  const verificationToken = new URL(verificationEmail.text).searchParams.get("verify_email");
  const verified = await mutate(customer, "post", "/api/auth/email/verify", { token: verificationToken });
  assert.equal(verified.status, 200);
  const login = await mutate(customer, "post", "/api/auth/login", {
    email: "rina@example.com",
    password: "example-password-123",
    remember: true,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.emailVerified, true);
  assert.equal((await customer.get("/api/auth/me")).body.user.name, "Rina Example");
  assert.equal((await mutate(customer, "post", "/api/auth/logout", {})).status, 204);
  assert.equal((await mutate(customer, "post", "/api/auth/login", {
    email: "rina@example.com",
    password: "example-password-123",
  })).status, 200);
});

test("consultation requests require auth, validate input, and persist", async () => {
  const payload = {
    name: "Rina Example",
    contact: "rina@example.com",
    project: "Website",
    budget: "Rp5–15 juta",
    details: "Toko online untuk produk lokal.",
  };
  assert.equal((await request(app).post("/api/consultations").send(payload)).status, 403);
  const created = await mutate(customer, "post", "/api/consultations", payload);
  assert.equal(created.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consultations WHERE user_id = ?").get(userId).count, 1);
  const countBeforeTrap = db.prepare("SELECT COUNT(*) AS count FROM consultations").get().count;
  const trapped = await mutate(customer, "post", "/api/consultations", { ...payload, website: "spam" });
  assert.equal(trapped.status, 202);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM consultations").get().count, countBeforeTrap);
  assert.equal((await admin.get("/api/admin/consultations")).body.consultations[0].details, payload.details);
});

test("admin endpoints reject customers and allow admin sessions", async () => {
  assert.equal((await customer.get("/api/admin/summary")).status, 403);
  const summary = await admin.get("/api/admin/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.consultations, 1);
  const consultation = (await admin.get("/api/admin/consultations")).body.consultations[0];
  const updated = await mutate(admin, "patch", `/api/admin/consultations/${consultation.id}`, { status: "contacted" });
  assert.equal(updated.status, 200);
  assert.equal(db.prepare("SELECT status FROM consultations WHERE id = ?").get(consultation.id).status, "contacted");
});

test("domain input is validated and never reports simulated availability", async () => {
  const invalid = await mutate(request.agent(app), "post", "/api/domain/check", { domain: "not a domain" });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /domain/i);
});

test("checkout fails clearly until Midtrans is configured", async () => {
  const unauthenticated = await mutate(request.agent(app), "post", "/api/orders", { packageId: "hosting-basic" });
  assert.equal(unauthenticated.status, 401);
  delete process.env.MIDTRANS_SERVER_KEY;
  const unconfigured = await mutate(customer, "post", "/api/orders", { packageId: "hosting-basic" });
  assert.equal(unconfigured.status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
  process.env.MIDTRANS_SERVER_KEY = "test-midtrans-server-key";
});

test("password reset request returns a non-enumerating response", async () => {
  const response = await mutate(customer, "post", "/api/auth/password/forgot", { email: "rina@example.com" });
  assert.equal(response.status, 200);
});

test("password reset links expire, work once, and revoke prior sessions", async () => {
  const resetEmail = "reset@example.com";
  const clientIp = "198.51.100.11";
  const resetCustomer = request.agent(app);
  assert.equal((await mutate(resetCustomer, "post", "/api/auth/register", {
    name: "Reset Customer",
    email: resetEmail,
    password: "original-password-123",
  }, clientIp)).status, 201);
  const verifyToken = emailToken(resetEmail, "Verifikasi", "verify_email");
  assert.equal((await mutate(resetCustomer, "post", "/api/auth/email/verify", { token: verifyToken }, clientIp)).status, 200);
  assert.equal((await mutate(resetCustomer, "post", "/api/auth/login", {
    email: resetEmail,
    password: "original-password-123",
  }, clientIp)).status, 200);

  assert.equal((await mutate(resetCustomer, "post", "/api/auth/password/forgot", { email: resetEmail }, clientIp)).status, 200);
  const expiredToken = emailToken(resetEmail, "Reset", "reset_token");
  db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?")
    .run(Date.now() - 1, db.prepare("SELECT id FROM users WHERE email = ?").get(resetEmail).id);
  assert.equal((await mutate(request.agent(app), "post", "/api/auth/password/reset", {
    token: expiredToken,
    password: "replacement-password-123",
  }, clientIp)).status, 400);

  assert.equal((await mutate(resetCustomer, "post", "/api/auth/password/forgot", { email: resetEmail }, clientIp)).status, 200);
  const resetToken = emailToken(resetEmail, "Reset", "reset_token");
  assert.equal((await mutate(request.agent(app), "post", "/api/auth/password/reset", {
    token: resetToken,
    password: "replacement-password-123",
  }, clientIp)).status, 200);
  assert.equal((await mutate(request.agent(app), "post", "/api/auth/password/reset", {
    token: resetToken,
    password: "another-password-123",
  }, clientIp)).status, 400);
  assert.equal((await resetCustomer.get("/api/auth/me")).body.user, null);
  assert.equal((await mutate(request.agent(app), "post", "/api/auth/login", {
    email: resetEmail,
    password: "replacement-password-123",
  }, clientIp)).status, 200);
  assert.equal((await mutate(request.agent(app), "post", "/api/auth/login", {
    email: resetEmail,
    password: "original-password-123",
  }, clientIp)).status, 401);
});

test("CSRF is required on authenticated changes", async () => {
  const response = await customer.post("/api/auth/logout");
  assert.equal(response.status, 403);
  assert.match(response.body.error, /token keamanan/i);
});

test("Midtrans webhook validates signatures and moves a paid order to activation", async () => {
  const initialEmails = db.prepare("SELECT COUNT(*) AS count FROM email_outbox").get().count;
  const orderId = `RD-${crypto.randomUUID()}`;
  const invoiceNumber = `INV-2026-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status,
      invoice_number, created_at, updated_at)
    VALUES (?, ?, 'hosting-basic', 'Hosting Basic', 25000, 'pending', ?, ?, ?)
  `).run(orderId, userId, invoiceNumber, timestamp, timestamp);

  const body = {
    order_id: orderId,
    status_code: "200",
    gross_amount: "25000.00",
    transaction_status: "settlement",
    signature_key: "",
  };
  body.signature_key = crypto.createHash("sha512")
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${process.env.MIDTRANS_SERVER_KEY}`)
    .digest("hex");
  const invalidSignature = await request(app).post("/api/payments/midtrans/notification")
    .send({ ...body, signature_key: "a".repeat(128) });
  assert.equal(invalidSignature.status, 403);

  const paid = await request(app).post("/api/payments/midtrans/notification").send(body);
  assert.equal(paid.status, 200);
  assert.deepEqual(
    db.prepare("SELECT payment_status, service_status FROM orders WHERE id = ?").get(orderId),
    { payment_status: "paid", service_status: "awaiting_activation" },
  );
  const replay = await request(app).post("/api/payments/midtrans/notification").send(body);
  assert.equal(replay.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM email_outbox").get().count - initialEmails, 2);
});

test("Midtrans denied and expired notifications update pending orders once", async () => {
  for (const transactionStatus of ["deny", "expire"]) {
    const orderId = `RD-${crypto.randomUUID()}`;
    const invoiceNumber = `INV-2026-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status,
        invoice_number, created_at, updated_at)
      VALUES (?, ?, 'hosting-basic', 'Hosting Basic', 25000, 'pending', ?, ?, ?)
    `).run(orderId, userId, invoiceNumber, timestamp, timestamp);

    const body = {
      order_id: orderId,
      status_code: "200",
      gross_amount: "25000.00",
      transaction_status: transactionStatus,
      signature_key: "",
    };
    body.signature_key = crypto.createHash("sha512")
      .update(`${body.order_id}${body.status_code}${body.gross_amount}${process.env.MIDTRANS_SERVER_KEY}`)
      .digest("hex");
    const initialEmails = db.prepare("SELECT COUNT(*) AS count FROM email_outbox").get().count;
    assert.equal((await request(app).post("/api/payments/midtrans/notification").send(body)).status, 200);
    assert.equal((await request(app).post("/api/payments/midtrans/notification").send(body)).status, 200);
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(orderId).payment_status, "failed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM email_outbox").get().count - initialEmails, 2);
  }
});

test("customers can only download their own PDF invoices and admin backups are restorable SQLite files", async () => {
  const orderId = `RD-${crypto.randomUUID()}`;
  const invoiceNumber = `INV-2026-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status,
      invoice_number, created_at, updated_at)
    VALUES (?, ?, 'hosting-basic', 'Hosting Basic', 25000, 'paid', ?, ?, ?)
  `).run(orderId, userId, invoiceNumber, timestamp, timestamp);
  const invoice = await customer.get(`/api/orders/${orderId}/invoice.pdf`);
  assert.equal(invoice.status, 200);
  assert.match(invoice.headers["content-type"], /application\/pdf/);
  assert.equal(invoice.body.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await request.agent(app).get(`/api/orders/${orderId}/invoice.pdf`)).status, 401);

  const activationOrderId = `RD-${crypto.randomUUID()}`;
  const activationInvoice = `INV-2026-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
  db.prepare(`
    INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status,
      service_status, invoice_number, created_at, updated_at)
    VALUES (?, ?, 'hosting-basic', 'Hosting Basic', 25000, 'paid', 'awaiting_activation', ?, ?, ?)
  `).run(activationOrderId, userId, activationInvoice, timestamp, timestamp);
  const activationPayload = {
    serviceStatus: "active",
    serviceType: "hosting",
    host: "server.example.test",
    username: "rina",
    port: 2083,
    notes: "Panel hosting",
    startedAt: "2026-11-14",
    expiresAt: "2026-12-14",
  };
  assert.equal((await mutate(customer, "patch", `/api/admin/orders/${activationOrderId}/service`, {
    serviceStatus: "processing",
  })).status, 403);
  assert.equal((await customer.get(`/api/orders/${activationOrderId}`)).body.order.serviceDetails, null);
  assert.equal((await mutate(admin, "patch", `/api/admin/orders/${activationOrderId}/service`, {
    serviceStatus: "processing",
  })).status, 200);
  assert.equal((await customer.get(`/api/orders/${activationOrderId}`)).body.order.serviceDetails, null);
  assert.equal((await mutate(admin, "patch", `/api/admin/orders/${activationOrderId}/service`, {
    ...activationPayload,
    password: "must-not-be-accepted",
  })).status, 400);
  assert.equal((await mutate(admin, "patch", `/api/admin/orders/${activationOrderId}/service`, {
    ...activationPayload,
    expiresAt: activationPayload.startedAt,
  })).status, 400);
  assert.equal((await mutate(admin, "patch", `/api/admin/orders/${activationOrderId}/service`, activationPayload)).status, 200);
  const customerOrder = (await customer.get(`/api/orders/${activationOrderId}`)).body.order;
  assert.deepEqual(customerOrder.serviceDetails, {
    serviceType: "hosting",
    host: "server.example.test",
    username: "rina",
    port: 2083,
    notes: "Panel hosting",
    startedAt: "2026-11-14",
  });
  assert.equal(customerOrder.expiresAt, "2026-12-14");
  assert.deepEqual((await customer.get("/api/orders")).body.orders.find((order) => order.id === activationOrderId).serviceDetails, customerOrder.serviceDetails);
  assert.deepEqual((await admin.get(`/api/orders/${activationOrderId}`)).body.order.serviceDetails, customerOrder.serviceDetails);
  const audit = db.prepare(`
    SELECT event_type, from_status, to_status, actor_user_id
    FROM service_order_events WHERE order_id = ? ORDER BY event_type, created_at
  `).all(activationOrderId);
  assert.deepEqual(audit.map(({ event_type, from_status, to_status }) => ({ event_type, from_status, to_status })), [
    { event_type: "access_details_saved", from_status: "processing", to_status: "active" },
    { event_type: "status_changed", from_status: "awaiting_activation", to_status: "processing" },
    { event_type: "status_changed", from_status: "processing", to_status: "active" },
  ]);
  assert.ok(audit.every((event) => event.actor_user_id === db.prepare("SELECT id FROM users WHERE email = ?").get(process.env.ADMIN_EMAIL).id));
  assert.equal((await admin.get(`/api/admin/orders/${activationOrderId}/history`)).body.events.length, 3);
  assert.equal((await customer.get(`/api/admin/orders/${activationOrderId}/history`)).status, 403);
  const encryptedDetails = db.prepare("SELECT service_details FROM orders WHERE id = ?").get(activationOrderId).service_details;
  assert.match(encryptedDetails, /^rd-access:1:v1:/);
  assert.equal(encryptedDetails.includes(activationPayload.host), false);
  assert.deepEqual(decryptAccessData(encryptedDetails, loadAccessDataKeyring(process.env, true)), customerOrder.serviceDetails);

  const otherCustomer = request.agent(app);
  const otherEmail = "other@example.com";
  await mutate(otherCustomer, "post", "/api/auth/register", {
    name: "Other Customer",
    email: otherEmail,
    password: "other-password-123",
  }, "198.51.100.12");
  const otherUserId = db.prepare("SELECT id FROM users WHERE email = ?").get(otherEmail).id;
  const otherToken = emailToken(otherEmail, "Verifikasi", "verify_email");
  await mutate(otherCustomer, "post", "/api/auth/email/verify", { token: otherToken }, "198.51.100.12");
  assert.equal((await mutate(otherCustomer, "post", "/api/auth/login", {
    email: otherEmail,
    password: "other-password-123",
  }, "198.51.100.12")).status, 200);
  assert.deepEqual((await otherCustomer.get("/api/orders")).body.orders, []);
  assert.equal((await otherCustomer.get(`/api/orders/${orderId}`)).status, 404);
  assert.equal((await otherCustomer.get(`/api/orders/${orderId}/invoice.pdf`)).status, 404);
  assert.equal((await otherCustomer.get(`/api/orders/${activationOrderId}`)).status, 404);
  assert.ok(otherUserId);

  const legacyOrderId = `RD-${crypto.randomUUID()}`;
  const legacyDetails = { serviceType: "vps", host: "legacy.example.test", username: "legacy", port: 22, notes: "", startedAt: "2026-11-14" };
  db.prepare(`
    INSERT INTO orders (id, user_id, package_id, package_name, amount, payment_status,
      service_status, service_details, invoice_number, created_at, updated_at)
    VALUES (?, ?, 'vps-cloud', 'VPS Cloud', 180000, 'paid', 'active', ?, ?, ?, ?)
  `).run(legacyOrderId, userId, JSON.stringify(legacyDetails), `INV-2026-${crypto.randomUUID().slice(0, 10).toUpperCase()}`, timestamp, timestamp);
  const rotatedKeyring = loadAccessDataKeyring({
    ACCESS_DATA_KEY_VERSION: "v2",
    ACCESS_DATA_KEY: crypto.randomBytes(32).toString("base64"),
    ACCESS_DATA_KEY_V1: process.env.ACCESS_DATA_KEY,
  }, true);
  assert.equal(migrateAccessDataRows(db, rotatedKeyring), 2);
  const migratedRows = db.prepare("SELECT id, service_details FROM orders WHERE id IN (?, ?) ORDER BY id")
    .all(activationOrderId, legacyOrderId);
  assert.ok(migratedRows.every((row) => row.service_details.startsWith("rd-access:1:v2:")));
  assert.deepEqual(decryptAccessData(
    migratedRows.find((row) => row.id === legacyOrderId).service_details,
    rotatedKeyring,
  ), legacyDetails);
  assert.deepEqual(decryptAccessData(
    migratedRows.find((row) => row.id === activationOrderId).service_details,
    rotatedKeyring,
  ), customerOrder.serviceDetails);

  const backupResponse = await mutate(admin, "post", "/api/admin/backups", {});
  assert.equal(backupResponse.status, 201);
  const backupPath = path.join(process.env.BACKUP_DIR, backupResponse.body.fileName);
  assert.equal(fs.existsSync(backupPath), true);
  const backupDb = (await import("better-sqlite3")).default;
  const snapshot = new backupDb(backupPath, { readonly: true });
  assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM users").get().count, 4);
  snapshot.close();
});
