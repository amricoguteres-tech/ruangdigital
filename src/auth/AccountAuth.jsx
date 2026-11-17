import React, { useEffect, useRef, useState } from "react";

const initialMessage = {
  login: "Masuk untuk melihat pesanan dan perkembangan layananmu.",
  register: "Buat akun untuk menyimpan dan melanjutkan pesanan.",
};

function notify(message) {
  window.dispatchEvent(new CustomEvent("ruangdigital:toast", { detail: message }));
}

function closeDialog() {
  const dialog = document.querySelector("#auth-dialog");
  if (dialog?.open) dialog.close();
}

function cleanTokenFromUrl(key) {
  const url = new URL(window.location.href);
  url.searchParams.delete(key);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function EyeIcon({ visible }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {visible ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
          <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.8 4.5 9.5 6.1a1.8 1.8 0 0 1 0 1.8 12.5 12.5 0 0 1-3.1 3.7" />
          <path d="M6.2 6.2a13.2 13.2 0 0 0-3.7 4.9 1.8 1.8 0 0 0 0 1.8A10.6 10.6 0 0 0 12 19a10 10 0 0 0 3-.5" />
        </>
      ) : (
        <>
          <path d="M2.5 12s3.2-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.2 6.5-9.5 6.5S2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      )}
    </svg>
  );
}

function Field({ id, label, type = "text", value, onChange, autoComplete, required = true, ...props }) {
  return (
    <label className="magic-auth-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        {...props}
      />
    </label>
  );
}

function PasswordField({ id, label, value, onChange, visible, onToggle, autoComplete, ...props }) {
  return (
    <div className="magic-auth-field">
      <label htmlFor={id}>{label}</label>
      <span className="magic-auth-password">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          required
          {...props}
        />
        <button
          className="magic-auth-eye"
          type="button"
          aria-label={visible ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
          onClick={onToggle}
        >
          <EyeIcon visible={visible} />
        </button>
      </span>
    </div>
  );
}

export default function AccountAuth() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [visiblePassword, setVisiblePassword] = useState(false);
  const [visibleConfirm, setVisibleConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeType, setNoticeType] = useState("info");
  const [resendVisible, setResendVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const csrfToken = useRef("");
  const resetToken = useRef("");

  async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const writes = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (writes && !csrfToken.current) {
      const csrfResponse = await fetch("/api/csrf", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const csrfData = await csrfResponse.json().catch(() => ({}));
      if (!csrfResponse.ok || !csrfData.token) {
        throw new Error("Gagal memulai sesi aman. Muat ulang halaman.");
      }
      csrfToken.current = csrfData.token;
    }

    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(writes ? { "x-csrf-token": csrfToken.current } : {}),
        ...options.headers,
      },
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Permintaan gagal. Coba lagi.");
    return data;
  }

  function showNotice(message, type = "info") {
    setNotice(message);
    setNoticeType(type);
  }

  useEffect(() => {
    const handleMode = (event) => {
      const nextMode = event.detail;
      if (nextMode !== "login" && nextMode !== "register") return;
      setMode(nextMode);
      setNotice("");
      setResendVisible(false);
    };
    window.addEventListener("ruangdigital:auth-mode", handleMode);

    const params = new URLSearchParams(window.location.search);
    const token = params.get("reset_token");
    const verificationToken = params.get("verify_email");
    if (token) {
      resetToken.current = token;
      setMode("reset");
      document.querySelector("#auth-dialog")?.showModal();
      cleanTokenFromUrl("reset_token");
    } else if (verificationToken) {
      cleanTokenFromUrl("verify_email");
      api("/api/auth/email/verify", {
        method: "POST",
        body: JSON.stringify({ token: verificationToken }),
      }).then(({ message }) => {
        notify(message);
      }).catch((error) => {
        notify(error.message);
      });
    }

    return () => window.removeEventListener("ruangdigital:auth-mode", handleMode);
  }, []);

  function setFormMode(nextMode) {
    setMode(nextMode);
    setNotice(initialMessage[nextMode] || "");
    setNoticeType("info");
    setResendVisible(false);
    setVisiblePassword(false);
    setVisibleConfirm(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    setResendVisible(false);

    try {
      if (mode === "login" || mode === "register") {
        if (mode === "register" && password !== confirmPassword) {
          showNotice("Konfirmasi kata sandi tidak sama.", "error");
          return;
        }
        const body = {
          email: email.trim().toLowerCase(),
          password,
          ...(mode === "login" ? { remember } : { name: name.trim() }),
        };
        const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
        const result = await api(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (mode === "register") {
          setFormMode("login");
          setEmail("");
          setName("");
          setPassword("");
          setConfirmPassword("");
          setRemember(false);
          closeDialog();
          window.dispatchEvent(new CustomEvent("ruangdigital:auth-registered"));
          notify(result.message);
          return;
        }
        setEmail("");
        setPassword("");
        setConfirmPassword("");
        setRemember(false);
        closeDialog();
        window.dispatchEvent(new CustomEvent("ruangdigital:auth-success", { detail: result.user }));
        notify(`Berhasil masuk sebagai ${result.user.name}.`);
        return;
      }

      if (mode === "forgot") {
        const result = await api("/api/auth/password/forgot", {
          method: "POST",
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        showNotice(result.message, "success");
        return;
      }

      if (password !== confirmPassword) {
        showNotice("Konfirmasi kata sandi tidak sama.", "error");
        return;
      }
      const result = await api("/api/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({ token: resetToken.current, password }),
      });
      setPassword("");
      setConfirmPassword("");
      setFormMode("login");
      showNotice(result.message, "success");
    } catch (error) {
      const message = error.message.replace(/^EMAIL_NOT_VERIFIED:\s*/, "");
      showNotice(message, "error");
      setResendVisible(error.message.includes("EMAIL_NOT_VERIFIED"));
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!email.trim()) {
      showNotice("Isi email akun terlebih dahulu.", "error");
      document.querySelector("#magic-auth-email")?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await api("/api/auth/email/resend", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      showNotice(result.message, "success");
      setResendVisible(false);
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === "login";
  const isRegister = mode === "register";
  const isReset = mode === "reset";
  const isForgot = mode === "forgot";
  const title = isReset
    ? "Atur kata sandi baru"
    : isForgot
      ? "Pulihkan akses akun"
      : isRegister
        ? "Mulai dari sini."
        : "Senang bertemu lagi.";
  const description = isReset
    ? "Buat kata sandi baru untuk mengamankan akunmu."
    : isForgot
      ? "Kami akan mengirim tautan pemulihan ke email akunmu."
      : initialMessage[mode];

  return (
    <div className="magic-auth-grid">
      <section className="magic-auth-visual" aria-label="RuangDigital">
        <div className="magic-auth-visual-content">
          <span className="magic-auth-overline">AKUN RUANGDIGITAL</span>
          <h1>Kelola layanan<br /><span>dengan jelas.</span></h1>
          <p>Masuk untuk melihat pesanan, status pembayaran, dan informasi layanan yang terhubung ke akunmu.</p>
          <ul className="magic-auth-account-list">
            <li>Pesanan dan invoice</li>
            <li>Status pembayaran</li>
            <li>Informasi aktivasi layanan</li>
          </ul>
          <span className="magic-auth-signature">AKUN <i /> PESANAN <i /> LAYANAN</span>
        </div>
      </section>

      <section className="magic-auth-panel" aria-label="Akses akun">
        <div className="magic-auth-form-wrap">
          <div className="magic-auth-mobile-brand" aria-hidden="true">
            ruang<span>digital</span>
          </div>
          {!isForgot && !isReset && (
            <div className="magic-auth-tabs" role="group" aria-label="Jenis akses akun">
              <button
                type="button"
                aria-pressed={isLogin}
                className={isLogin ? "active" : ""}
                onClick={() => setFormMode("login")}
              >Masuk</button>
              <button
                type="button"
                aria-pressed={isRegister}
                className={isRegister ? "active" : ""}
                onClick={() => setFormMode("register")}
              >Daftar</button>
            </div>
          )}

          <div className="magic-auth-heading">
            <span className="magic-auth-kicker">{isForgot || isReset ? "BANTUAN AKUN" : "AKUN RUANGDIGITAL"}</span>
            <h2 id="auth-title">{title}</h2>
            <p>{description}</p>
          </div>

          <form className="magic-auth-form" onSubmit={handleSubmit}>
            {isRegister && (
              <Field
                id="magic-auth-name"
                label="Nama lengkap"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                minLength={2}
                maxLength={100}
              />
            )}

            {(isLogin || isRegister || isForgot) && (
              <Field
                id="magic-auth-email"
                label="Alamat email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
              />
            )}

            {(isLogin || isRegister || isReset) && (
              <PasswordField
                id="magic-auth-password"
                label={isReset ? "Kata sandi baru" : "Kata sandi"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                visible={visiblePassword}
                onToggle={() => setVisiblePassword((value) => !value)}
                autoComplete={isLogin ? "current-password" : "new-password"}
                minLength={8}
                maxLength={128}
              />
            )}

            {(isRegister || isReset) && (
              <PasswordField
                id="magic-auth-confirm"
                label="Ulangi kata sandi"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                visible={visibleConfirm}
                onToggle={() => setVisibleConfirm((value) => !value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
              />
            )}

            {isLogin && (
              <div className="magic-auth-options">
                <label className="magic-auth-remember">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                  <span>Ingat saya</span>
                </label>
                <button type="button" className="magic-auth-text-button" onClick={() => setFormMode("forgot")}>
                  Lupa kata sandi?
                </button>
              </div>
            )}

            {notice && (
              <p className={`magic-auth-notice ${noticeType}`} role="status" aria-live="polite">
                {notice}
              </p>
            )}

            <button className="magic-auth-submit" type="submit" disabled={busy}>
              <span>{busy ? "Memproses..." : isLogin ? "Masuk ke akun" : isRegister ? "Buat akun" : isForgot ? "Kirim tautan reset" : "Simpan kata sandi"}</span>
            </button>
          </form>

          {resendVisible && (
            <button type="button" className="magic-auth-resend" disabled={busy} onClick={resendVerification}>
              Kirim ulang tautan verifikasi
            </button>
          )}

          {(isLogin || isRegister) && (
            <p className="magic-auth-switch">
              {isLogin ? "Belum punya akun?" : "Sudah punya akun?"}
              <button type="button" onClick={() => setFormMode(isLogin ? "register" : "login")}>
                {isLogin ? "Daftar sekarang" : "Masuk"}
              </button>
            </p>
          )}

          {(isForgot || isReset) && (
            <button type="button" className="magic-auth-back" onClick={() => setFormMode("login")}>
              <span aria-hidden="true">←</span> Kembali ke masuk
            </button>
          )}

          <p className="magic-auth-security"><span aria-hidden="true">◆</span> Perlindungan CSRF · Sesi server-side</p>
        </div>
      </section>
    </div>
  );
}
