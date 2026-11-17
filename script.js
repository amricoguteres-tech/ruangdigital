const dialog = document.querySelector("#project-dialog");
const authDialog = document.querySelector("#auth-dialog");
const projectType = document.querySelector("#project-type");
const estimateValue = document.querySelector("#estimate-value");
const toast = document.querySelector("#toast");
const loginLink = document.querySelector('.login-link[href="#masuk"]');
const accountOrdersLink = document.querySelector(".account-orders");
const adminLink = document.querySelector(".admin-link");
const projectForm = document.querySelector("#project-form");
const ordersDialog = document.querySelector("#orders-dialog");
const myOrdersList = document.querySelector("#my-orders-list");
const heroVideo = document.querySelector(".hero-video");
const isGitHubPages = window.location.hostname.endsWith(".github.io");
let toastTimer;
let pendingAction = null;
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

function openAuthDialog(mode = "login") {
  if (!authDialog.open) authDialog.showModal();
  window.dispatchEvent(new CustomEvent("ruangdigital:auth-mode", { detail: mode }));
}

window.addEventListener("ruangdigital:toast", (event) => showToast(event.detail));
window.addEventListener("ruangdigital:auth-success", (event) => {
  activeUser = event.detail;
  updateAccountLink();
  const action = pendingAction;
  pendingAction = null;
  Promise.resolve().then(() => action?.()).catch((error) => showToast(error.message));
});
window.addEventListener("ruangdigital:auth-registered", () => {
  pendingAction = null;
});

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

async function requireLogin(action) {
  await sessionReady;
  if (getUser()) {
    await action();
    return;
  }
  pendingAction = action;
  openAuthDialog("login");
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

if (heroVideo) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncHeroVideo = () => {
    if (reducedMotion.matches || document.hidden) {
      heroVideo.pause();
      return;
    }
    if (heroVideo.paused) {
      heroVideo.play().catch((error) => {
        console.warn("Hero video could not start automatically.", error);
      });
    }
  };

  syncHeroVideo();
  document.addEventListener("visibilitychange", syncHeroVideo);
  reducedMotion.addEventListener("change", syncHeroVideo);
}

function initializeStaticPreview() {
  document.documentElement.classList.add("github-pages-preview");
  document.querySelectorAll("[data-open-form], [data-order], [data-maintenance], .domain-form").forEach((control) => {
    control.hidden = true;
  });
  document.querySelectorAll(".login-link, .domain-result, #domain-request-button, #auth-dialog, #orders-dialog, #project-dialog, .footer-contact").forEach((element) => {
    element.hidden = true;
  });
  document.querySelectorAll(".static-pages-notice").forEach((notice) => {
    notice.hidden = false;
  });
}

function initializeScrollChrome() {
  const scrollProgress = document.querySelector(".scroll-progress");
  const siteHeader = document.querySelector(".site-header");
  const sectionLinks = [...document.querySelectorAll('.main-nav a[href^="#"]')];
  const sectionTargets = sectionLinks
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  let scrollUpdatePending = false;

  function updateActiveNavigation() {
    const marker = Math.min(window.innerHeight * 0.32, 240);
    const activeSection = sectionTargets
      .filter((section) => section.getBoundingClientRect().top <= marker)
      .at(-1);
    if (!activeSection) return;
    sectionLinks.forEach((link) => {
      if (link.getAttribute("href") === `#${activeSection.id}`) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  function updateScrollChrome() {
    const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrollableHeight > 0 ? window.scrollY / scrollableHeight : 0;
    document.documentElement.style.setProperty("--scroll-progress", String(progress));
    siteHeader?.classList.toggle("is-scrolled", window.scrollY > 12);
    updateActiveNavigation();
    scrollUpdatePending = false;
  }

  if (!scrollProgress || !siteHeader) return;
  updateScrollChrome();
  window.addEventListener("scroll", () => {
    if (scrollUpdatePending) return;
    scrollUpdatePending = true;
    window.requestAnimationFrame(updateScrollChrome);
  }, { passive: true });
  window.addEventListener("resize", updateScrollChrome, { passive: true });
}

function initializeKnowledgeSearch() {
  document.querySelector("#knowledge-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = document.querySelector("#knowledge-query").value.trim().toLowerCase();
    const entries = [...document.querySelectorAll(".faq-list details")];
    const result = document.querySelector("#knowledge-result");

    if (!query) {
      entries.forEach((entry) => {
        entry.hidden = false;
        entry.open = false;
      });
      result.textContent = "Masukkan kata kunci untuk mencari.";
      return;
    }

    const matches = entries.filter((entry) => {
      const matched = entry.textContent.toLowerCase().includes(query);
      entry.hidden = !matched;
      entry.open = matched;
      return matched;
    });

    result.textContent = matches.length
      ? `${matches.length} jawaban ditemukan di FAQ.`
      : "Belum ada jawaban yang cocok. Hubungi tim untuk bantuan.";
    document.querySelector("#faq").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

initializeScrollChrome();
initializeKnowledgeSearch();

if (isGitHubPages) initializeStaticPreview();

updateAccountLink();
const sessionReady = isGitHubPages ? Promise.resolve() : api("/api/auth/me")
  .then(({ user }) => {
    activeUser = user;
    updateAccountLink();
  })
  .catch(() => {
    activeUser = null;
    updateAccountLink();
  });

document.querySelectorAll("[data-open-form]").forEach((button) => {
  button.addEventListener("click", () => {
    const type = button.dataset.project || "";
    requireLogin(() => openProjectForm(type));
  });
});

document.querySelector(".auth-close").addEventListener("click", () => {
  pendingAction = null;
  authDialog.close();
});

authDialog.addEventListener("cancel", () => {
  pendingAction = null;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !authDialog.open) return;
  event.preventDefault();
  pendingAction = null;
  authDialog.close();
});

authDialog.addEventListener("click", (event) => {
  if (event.target === authDialog) {
    pendingAction = null;
    authDialog.close();
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
    result.textContent = `${data.domain}: ${data.message}`;
    if (data.status === "possibly_available") {
      requestButton.hidden = false;
      requestButton.dataset.domain = data.domain;
    }
  } catch (error) {
    result.textContent = error.message;
  }
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
  openAuthDialog("login");
});

document.querySelectorAll("[data-auth-home]").forEach((link) => {
  link.addEventListener("click", () => {
    pendingAction = null;
    authDialog.close();
  });
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
      status.textContent = `Pembayaran: ${order.paymentStatus} | Layanan: ${serviceLabels[order.serviceStatus] || order.serviceStatus}`;
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
          ["Port", order.serviceDetails.port || "-"],
          ["Catatan", order.serviceDetails.notes || "-"],
          ["Mulai", order.serviceDetails.startedAt],
          ["Berakhir", order.expiresAt],
        ]) {
          const line = document.createElement("span");
          line.textContent = `${label}: ${value || "-"}`;
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

document.querySelector("#domain-request-button").addEventListener("click", () => {
  const domain = document.querySelector("#domain-request-button").dataset.domain;
  requireLogin(() => {
    openProjectForm("Domain");
    document.querySelector('[name="details"]').value = `Saya ingin dibantu mendaftarkan domain ${domain}. Mohon konfirmasi harga dan ketersediaan registrar.`;
  });
});

const csrfReady = isGitHubPages ? Promise.resolve() : fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("CSRF initialization failed")))
  .then((result) => {
    csrfToken = result.token;
  })
  .catch((error) => {
    console.error("Could not initialize secure session", error);
    showToast("Gagal menyiapkan sesi aman. Muat ulang halaman sebelum melanjutkan.");
  });
