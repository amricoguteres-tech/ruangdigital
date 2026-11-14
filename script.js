const dialog = document.querySelector("#project-dialog");
const authDialog = document.querySelector("#auth-dialog");
const projectType = document.querySelector("#project-type");
const estimateValue = document.querySelector("#estimate-value");
const toast = document.querySelector("#toast");
const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
const loginLink = document.querySelector('.login-link[href="#masuk"]');
const accountOrdersLink = document.querySelector(".account-orders");
const adminLink = document.querySelector(".admin-link");
const authForm = document.querySelector("#auth-form");
const projectForm = document.querySelector("#project-form");
const ordersDialog = document.querySelector("#orders-dialog");
const myOrdersList = document.querySelector("#my-orders-list");
const passwordResetRequest = document.querySelector("#password-reset-request");
const passwordResetForm = document.querySelector("#password-reset-form");
const resendVerificationButton = document.querySelector("#resend-verification");
let toastTimer;
let pendingAction = null;
let authMode = "login";
let activeUser = null;

let csrfToken;

const estimates = {
  Website: "Mulai dari Rp3.500.000",
  Aplikasi: "Mulai dari Rp8.000.000",
  Game: "Mulai dari Rp10.000.000",
  Hosting: "Mulai dari Rp25.000 / bulan",
  VPS: "Mulai dari Rp180.000 / bulan",
  Maintenance: "Paket mulai dari Rp350.000 / bulan",
};

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4200);
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && path !== "/api/payments/midtrans/notification") {
    if (!csrfToken) {
      const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
      const csrfData = await csrfResponse.json().catch(() => ({}));
      if (!csrfResponse.ok || !csrfData.token) throw new Error("Gagal memulai sesi aman. Muat ulang halaman.");
      csrfToken = csrfData.token;
    }
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method) ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Permintaan gagal. Coba lagi.");
  return data;
}

function getUser() {
  return activeUser;
}

function updateAccountLink() {
  const user = getUser();
  loginLink.textContent = user ? "Keluar" : "Masuk";
  loginLink.setAttribute("aria-label", user ? `Keluar dari akun ${user.name}` : "Masuk ke akun");
  loginLink.title = user ? user.email : "";
  accountOrdersLink.hidden = !user || user.role === "admin";
  adminLink.hidden = user?.role !== "admin";
}

function setAuthMode(mode) {
  showAuthForm(authForm);
  authMode = mode;
  const isRegister = mode === "register";
  document.querySelector("#auth-title").textContent = isRegister ? "Buat akun baru" : "Selamat datang kembali!";
  document.querySelector("#auth-description").textContent = isRegister
    ? "Daftar untuk menyimpan dan melanjutkan pesananmu."
    : "Masuk ke akunmu untuk melanjutkan.";
  document.querySelector("#auth-name-field").hidden = !isRegister;
  document.querySelector("#auth-name").required = isRegister;
  document.querySelector("#auth-name").autocomplete = isRegister ? "name" : "off";
  document.querySelector("#auth-confirm-field").hidden = !isRegister;
  document.querySelector("#auth-confirm").required = isRegister;
  document.querySelector("#auth-password").autocomplete = isRegister ? "new-password" : "current-password";
  document.querySelector("#auth-submit").innerHTML = isRegister
    ? 'Daftar sekarang <span aria-hidden="true">→</span>'
    : 'Masuk sekarang <span aria-hidden="true">→</span>';
  document.querySelector("#auth-switch-copy").textContent = isRegister ? "Sudah punya akun?" : "Belum punya akun?";
  document.querySelector("#auth-switch-button").innerHTML = isRegister
    ? 'Masuk sekarang <span>↗</span>'
    : 'Daftar sekarang <span>↗</span>';
  document.querySelector("#auth-switch-button").dataset.authMode = isRegister ? "login" : "register";
  document.querySelector("#forgot-password").hidden = isRegister;
  document.querySelectorAll("[data-auth-mode]").forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("active", active);
    if (tab.getAttribute("role") === "tab") tab.setAttribute("aria-selected", String(active));
  });
}

async function requireLogin(action) {
  await sessionReady;
  if (getUser()) {
    await action();
    return;
  }
  pendingAction = action;
  setAuthMode("login");
  authDialog.showModal();
}

function openProjectForm(type = "") {
  if (!dialog.open) dialog.showModal();
  if (type) {
    const option = [...projectType.options].find((item) => item.value === type || item.textContent === type);
    if (option) {
      projectType.value = option.value || option.textContent;
      updateEstimate();
    }
  }
  menuToggle?.setAttribute("aria-expanded", "false");
  mainNav?.classList.remove("open");
}

function updateEstimate() {
  estimateValue.textContent = estimates[projectType.value] || "Pilih layanan untuk melihat perkiraan";
}

updateAccountLink();
const sessionReady = api("/api/auth/me")
  .then(({ user }) => {
    activeUser = user;
    updateAccountLink();
  })
  .catch(() => {
    activeUser = null;
    updateAccountLink();
  });

const revealTargets = document.querySelectorAll(
  ".section-heading, .service-card, .domain-check, .price-card, .work-card, .testimonial, .article-card, .knowledge-box, .process-intro, .step, .maintenance-copy, .maintenance-list > div, .about-grid > *, .faq-layout > *, .cta-inner, .footer-main > *",
);

if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14, rootMargin: "0px 0px -35px 0px" });

  revealTargets.forEach((element, index) => {
    element.classList.add("reveal-on-scroll");
    element.style.setProperty("--reveal-delay", `${(index % 3) * 90}ms`);
    revealObserver.observe(element);
  });
}

document.querySelectorAll("[data-open-form]").forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.dataset.project || "";
    requireLogin(() => openProjectForm(type));
  });
});

document.querySelectorAll("[data-auth-mode]").forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
});

document.querySelector(".auth-close").addEventListener("click", () => {
  pendingAction = null;
  authDialog.close();
});

authDialog.addEventListener("click", (event) => {
  if (event.target === authDialog) {
    pendingAction = null;
    authDialog.close();
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!authForm.reportValidity()) return;

  const email = document.querySelector("#auth-email").value.trim().toLowerCase();
  const password = document.querySelector("#auth-password").value;
  if (authMode === "register" && password !== document.querySelector("#auth-confirm").value) {
    document.querySelector("#auth-confirm").setCustomValidity("Konfirmasi kata sandi tidak sama.");
    document.querySelector("#auth-confirm").reportValidity();
    document.querySelector("#auth-confirm").setCustomValidity("");
    return;
  }
  const body = {
    email,
    password,
    remember: document.querySelector("#remember-me").checked,
  };
  if (authMode === "register") body.name = document.querySelector("#auth-name").value.trim();
  const submitButton = document.querySelector("#auth-submit");
  submitButton.disabled = true;
  try {
    const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    if (authMode === "register") {
      pendingAction = null;
      authForm.reset();
      setAuthMode("login");
      authDialog.close();
      showToast(result.message);
      return;
    }
    const { user } = result;
    activeUser = user;
    updateAccountLink();
    const action = pendingAction;
    pendingAction = null;
    authForm.reset();
    setAuthMode("login");
    authDialog.close();
    showToast(`Berhasil masuk sebagai ${user.name}.`);
    await action?.();
  } catch (error) {
    showToast(error.message);
    resendVerificationButton.hidden = !error.message.includes("EMAIL_NOT_VERIFIED");
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
projectType.addEventListener("change", updateEstimate);

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!projectForm.reportValidity()) return;
  const submitButton = projectForm.querySelector('[type="submit"]');
  const body = Object.fromEntries(new FormData(projectForm).entries());
  submitButton.disabled = true;
  try {
    await api("/api/consultations", { method: "POST", body: JSON.stringify(body) });
    dialog.close();
    projectForm.reset();
    updateEstimate();
    showToast("Permintaan konsultasi berhasil tersimpan. Tim kami akan menghubungi kamu.");
  } catch (error) {
    if (error.message.includes("masuk")) {
      const draft = body;
      dialog.close();
      activeUser = null;
      updateAccountLink();
      await requireLogin(async () => {
        openProjectForm(draft.project);
        for (const [name, value] of Object.entries(draft)) {
          const field = projectForm.elements.namedItem(name);
          if (field) field.value = value;
        }
        updateEstimate();
      });
    } else {
      showToast(error.message);
    }
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelectorAll("[data-order]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const packageId = link.dataset.order;
    requireLogin(async () => {
      link.setAttribute("aria-busy", "true");
      try {
        const { redirectUrl } = await api("/api/orders", {
          method: "POST",
          body: JSON.stringify({ packageId }),
        });
        window.location.assign(redirectUrl);
      } catch (error) {
        showToast(error.message);
      } finally {
        link.removeAttribute("aria-busy");
      }
    });
  });
});

document.querySelector("[data-maintenance]").addEventListener("click", (event) => {
  event.preventDefault();
  requireLogin(() => openProjectForm("Maintenance"));
});

document.querySelector("#domain-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = event.currentTarget.elements.domain;
  const domain = field.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const result = document.querySelector("#domain-result");
  const requestButton = document.querySelector("#domain-request-button");
  result.textContent = "Memeriksa data RDAP…";
  requestButton.hidden = true;
  try {
    const data = await api("/api/domain/check", { method: "POST", body: JSON.stringify({ domain }) });
    result.textContent = `${data.domain} — ${data.message}`;
    if (data.status === "possibly_available") {
      requestButton.hidden = false;
      requestButton.dataset.domain = data.domain;
    }
  } catch (error) {
    result.textContent = error.message;
  }
});

menuToggle.addEventListener("click", () => {
  const isExpanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isExpanded));
  mainNav.classList.toggle("open", !isExpanded);
});

mainNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuToggle.setAttribute("aria-expanded", "false");
    mainNav.classList.remove("open");
  });
});

loginLink.addEventListener("click", async (event) => {
  event.preventDefault();
  if (getUser()) {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (error) {
      if (!error.message.includes("masuk")) {
        showToast(error.message);
        return;
      }
    }
    activeUser = null;
    updateAccountLink();
    showToast("Kamu sudah keluar dari akun.");
    return;
  }
  pendingAction = null;
  setAuthMode("login");
  authDialog.showModal();
});

document.querySelectorAll("[data-auth-home]").forEach((link) => {
  link.addEventListener("click", () => {
    pendingAction = null;
    authDialog.close();
  });
});

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const field = document.getElementById(button.dataset.passwordToggle);
    const showPassword = field.type === "password";
    field.type = showPassword ? "text" : "password";
    button.setAttribute("aria-label", showPassword ? "Sembunyikan kata sandi" : "Tampilkan kata sandi");
    button.classList.toggle("visible", showPassword);
  });
});

document.querySelector("#auth-confirm").addEventListener("input", (event) => {
  event.currentTarget.setCustomValidity("");
});

function showAuthForm(formToShow) {
  document.querySelector(".auth-tabs").hidden = formToShow !== authForm;
  authForm.hidden = formToShow !== authForm;
  passwordResetRequest.hidden = formToShow !== passwordResetRequest;
  passwordResetForm.hidden = formToShow !== passwordResetForm;
  document.querySelector(".auth-switch").hidden = formToShow !== authForm;
}

document.querySelector("#forgot-password").addEventListener("click", () => {
  resendVerificationButton.hidden = true;
  showAuthForm(passwordResetRequest);
  document.querySelector("#reset-request-email").value = document.querySelector("#auth-email").value;
});

document.querySelector(".reset-back").addEventListener("click", () => showAuthForm(authForm));

passwordResetRequest.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#reset-request-email").value.trim().toLowerCase();
  const note = document.querySelector("#reset-request-note");
  try {
    const data = await api("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) });
    note.textContent = data.message;
  } catch (error) {
    note.textContent = error.message;
  }
});

passwordResetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = new URLSearchParams(location.search).get("reset_token");
  const password = document.querySelector("#reset-new-password").value;
  const confirm = document.querySelector("#reset-confirm-password").value;
  const note = document.querySelector("#reset-password-note");
  if (password !== confirm) {
    note.textContent = "Konfirmasi kata sandi tidak sama.";
    return;
  }
  try {
    const data = await api("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    note.textContent = data.message;
    passwordResetForm.reset();
    showAuthForm(authForm);
  } catch (error) {
    note.textContent = error.message;
  }
});

accountOrdersLink.addEventListener("click", async (event) => {
  event.preventDefault();
  myOrdersList.textContent = "Memuat pesanan…";
  ordersDialog.showModal();
  try {
    const { orders } = await api("/api/orders");
    if (!orders.length) {
      myOrdersList.textContent = "Belum ada pesanan paket.";
      return;
    }
    const entries = orders.map((order) => {
      const item = document.createElement("article");
      item.className = "my-order";
      const name = document.createElement("strong");
      name.textContent = order.packageName;
      const amount = document.createElement("span");
      amount.textContent = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(order.amount);
      const status = document.createElement("small");
      const serviceLabels = {
        awaiting_payment: "menunggu pembayaran",
        awaiting_activation: "menunggu aktivasi",
        processing: "diproses",
        active: "aktif",
        completed: "selesai",
        expired: "kedaluwarsa",
        cancelled: "dibatalkan",
      };
      status.textContent = `Pembayaran: ${order.paymentStatus} · Layanan: ${serviceLabels[order.serviceStatus] || order.serviceStatus}`;
      item.append(name, amount, status);
      if (order.serviceDetails) {
        const access = document.createElement("div");
        access.className = "my-order-access";
        const accessTitle = document.createElement("strong");
        accessTitle.textContent = `Detail akses ${order.serviceDetails.serviceType.toUpperCase()}`;
        access.append(accessTitle);
        for (const [label, value] of [
          ["Host / IP", order.serviceDetails.host],
          ["Username", order.serviceDetails.username],
          ["Port", order.serviceDetails.port || "—"],
          ["Catatan", order.serviceDetails.notes || "—"],
          ["Mulai", order.serviceDetails.startedAt],
          ["Berakhir", order.expiresAt],
        ]) {
          const line = document.createElement("span");
          line.textContent = `${label}: ${value || "—"}`;
          access.append(line);
        }
        item.append(access);
      } else if (order.expiresAt) {
        const expiration = document.createElement("small");
        expiration.textContent = `Berakhir: ${order.expiresAt}`;
        item.append(expiration);
      }
      const invoiceLink = document.createElement("a");
      invoiceLink.href = `/api/orders/${encodeURIComponent(order.id)}/invoice.pdf`;
      invoiceLink.className = "text-link";
      invoiceLink.textContent = `Unduh invoice${order.invoiceNumber ? ` ${order.invoiceNumber}` : ""}`;
      item.append(invoiceLink);
      if (order.paymentStatus === "pending" && order.redirectUrl) {
        const paymentLink = document.createElement("a");
        paymentLink.href = order.redirectUrl;
        paymentLink.className = "text-link";
        paymentLink.textContent = "Lanjutkan pembayaran";
        item.append(paymentLink);
      }
      return item;
    });
    myOrdersList.replaceChildren(...entries);
  } catch (error) {
    myOrdersList.textContent = error.message;
  }
});
document.querySelector(".orders-close").addEventListener("click", () => ordersDialog.close());
ordersDialog.addEventListener("click", (event) => {
  if (event.target === ordersDialog) ordersDialog.close();
});

const resetToken = new URLSearchParams(location.search).get("reset_token");
if (resetToken) {
  history.replaceState(null, "", location.pathname);
  setAuthMode("login");
  showAuthForm(passwordResetForm);
  authDialog.showModal();
}

resendVerificationButton.addEventListener("click", async () => {
  const email = document.querySelector("#auth-email").value.trim().toLowerCase();
  if (!email) {
    showToast("Isi email akun terlebih dahulu.");
    document.querySelector("#auth-email").focus();
    return;
  }
  try {
    const result = await api("/api/auth/email/resend", { method: "POST", body: JSON.stringify({ email }) });
    showToast(result.message);
    resendVerificationButton.hidden = true;
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#domain-request-button").addEventListener("click", () => {
  const domain = document.querySelector("#domain-request-button").dataset.domain;
  requireLogin(() => {
    openProjectForm("Domain");
    document.querySelector('[name="details"]').value = `Saya ingin dibantu mendaftarkan domain ${domain}. Mohon konfirmasi harga dan ketersediaan registrar.`;
  });
});

const verificationToken = new URLSearchParams(location.search).get("verify_email");
if (verificationToken) {
  history.replaceState(null, "", location.pathname);
  api("/api/auth/email/verify", {
    method: "POST",
    body: JSON.stringify({ token: verificationToken }),
  }).then(({ message }) => {
    showToast(message);
  }).catch((error) => {
    showToast(error.message);
  });
}

const csrfReady = fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("CSRF initialization failed")))
  .then((result) => {
    csrfToken = result.token;
  })
  .catch((error) => {
    console.error("Could not initialize secure session", error);
    showToast("Gagal menyiapkan sesi aman. Muat ulang halaman sebelum melanjutkan.");
  });

document.querySelector("#knowledge-search").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.querySelector("#knowledge-query").value.trim().toLowerCase();
  const entries = [...document.querySelectorAll(".faq-list details")];
  const result = document.querySelector("#knowledge-result");

  if (!query) {
    result.textContent = "Masukkan kata kunci untuk mencari.";
    return;
  }

  const matches = entries.filter((entry) => {
    const matched = entry.textContent.toLowerCase().includes(query);
    entry.hidden = !matched;
    if (matched) entry.open = true;
    return matched;
  });

  result.textContent = matches.length
    ? `${matches.length} jawaban ditemukan di FAQ.`
    : "Belum ada jawaban yang cocok. Hubungi tim untuk bantuan.";
  document.querySelector("#faq").scrollIntoView({ behavior: "smooth", block: "start" });
});
