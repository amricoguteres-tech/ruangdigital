# RuangDigital

Static site and same-origin Node.js backend for accounts, consultations, package orders, domain checks, and the admin dashboard.

## Run locally

```sh
npm install
cp .env.example .env
npm start
```

Open `http://localhost:8000`. The app creates `.data/ruangdigital.sqlite` on first run. For local admin access, set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` (at least 8 characters) in `.env`, then restart the server. Set `ACCESS_DATA_KEY` to a fresh 32-byte base64 value (`openssl rand -base64 32`) to enable encrypted service access details. Production startup fails if this key is missing or malformed. Never publish `.env`.

Run automated checks with `npm test`.

## Railway deployment

1. Deploy this project from its source directory. Railway uses `npm install` and `npm start`; `railway.json` configures the health check.
2. Attach a Railway Volume to the service, mounted at `/data`. SQLite is a single-instance database; keep one app replica and back up the volume regularly.
3. Configure these service variables in Railway (do not put secrets in source control):
   - `NODE_ENV=production`
   - `PORT` (Railway provides this)
   - `DB_PATH=/data/ruangdigital.sqlite`
   - `PUBLIC_BASE_URL=https://your-domain`
   - `SESSION_SECRET` (at least 32 random characters)
   - `ACCESS_DATA_KEY` (a separate base64-encoded 32-byte key) and `ACCESS_DATA_KEY_VERSION=v1`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (unique, strong password)
   - `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION=false` for sandbox; change to `true` only after Midtrans production approval and testing
   - `RESEND_API_KEY` and `RESEND_FROM` for outbound email over HTTPS (recommended on Railway Trial/Hobby; verify the sender in Resend first)
   - Alternatively, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (SMTP requires Railway Pro or above)
   - `ADMIN_NOTIFICATION_EMAIL` for operational alerts and `BACKUP_DIR=/data/backups` for snapshots on the persistent volume
4. In Midtrans, set the payment notification URL to `https://your-domain/api/payments/midtrans/notification`. Keep the Server Key private. Test the full notification flow using Midtrans Sandbox before accepting real payments.
5. Add the custom domain and enable HTTPS in Railway. Do not use the development session-secret value in production.

The admin dashboard is at `/admin`. Public registration creates customer accounts only; the administrator account is provisioned from the environment variables at startup. Orders are not created if Midtrans is unconfigured or unavailable. Paid status is set only by a valid Midtrans notification. Domain status is an RDAP lookup hint, not a registrar reservation or guarantee.

## Features and boundaries

- Passwords use bcrypt hashing; login state uses an HTTP-only server-side session cookie. New customer accounts require a single-use, 24-hour email verification link. Public registration is disabled until an email provider is configured.
- Consultations and package orders are stored in SQLite. Admin can review consultations and change their workflow status. A honeypot, API-wide and endpoint-specific rate limits, same-origin checks, and session-bound CSRF tokens protect write actions.
- Midtrans Snap checkout is server-created; webhook signatures and amounts are verified before payment state is changed. The customer can download an invoice PDF for their own order.
- Domain checks use public RDAP and are not stored. A possible-availability result offers to submit a domain registration request to the consultation queue; RDAP is not a registrar reservation.
- Email messages include verification, password reset, consultation receipt, order creation, and payment outcome/status notifications. Outbound mail is stored encrypted in a retryable database outbox. Resend uses HTTPS; SMTP is available as a fallback on providers/plans that allow outbound SMTP.
- Password reset requires an email provider. Reset links expire after 30 minutes, are single-use, and revoke prior sessions.
- After a verified payment, an admin can move a service order from awaiting activation to processing, then activate it with hosting/VPS access metadata and service dates. Access metadata is encrypted at rest using versioned AES-256-GCM keys from environment variables. Credentials/passwords are not accepted or stored; customers and admins can view access details, while other customers cannot. Service status changes are audit-logged, and activation queues an email notification. Do not put passwords or private keys in the notes field.
- If an existing database contains plaintext service details, configure `ACCESS_DATA_KEY` before starting and run `npm run migrate:access-data` once. The command also re-encrypts existing envelopes with the active key version. For rotation, keep the old key as `ACCESS_DATA_KEY_V1`, set a new `ACCESS_DATA_KEY`, and set `ACCESS_DATA_KEY_VERSION=v2`; run the migration command before removing the old key. Backups do not contain the encryption key.
- The database directory is restricted to owner access (mode `700`) and the SQLite database to owner read/write (mode `600`). Keep encryption keys in the environment manager, separate from database backups.
- SQLite online backups run daily at 03:15 server time; admins can trigger one from `/admin`. The 14 latest local snapshots are kept. Store an additional offsite copy; a Railway Volume alone is not a disaster-recovery backup.
- Hosting/VPS displayed monthly amounts are single checkout invoices and are not recurring subscriptions; renewal reminders and payment require manual follow-up until recurring billing is implemented.
- Payment configuration, service provisioning, DNS/registrar purchasing, email delivery, and legal business details require provider accounts and operational setup; they are not simulated as successful.
