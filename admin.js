const alertBox = document.querySelector("#admin-alert");
const consultationRows = document.querySelector("#consultation-rows");
const orderRows = document.querySelector("#order-rows");
const adminRefreshButton = document.querySelector("#admin-refresh");

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  let csrfToken;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
    const csrfData = await csrfResponse.json().catch(() => ({}));
    if (!csrfResponse.ok || !csrfData.token) throw new Error("Gagal memulai sesi aman. Muat ulang halaman.");
    csrfToken = csrfData.token;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Permintaan gagal.");
  return data;
}

function cell(content, className = "", label = "") {
  const element = document.createElement("td");
  if (className) element.className = className;
  if (label) element.dataset.label = label;
  element.textContent = content;
  return element;
}

function emptyRow(body, columnCount, message) {
  const row = document.createElement("tr");
  const item = cell(message, "admin-empty");
  item.colSpan = columnCount;
  row.append(item);
  body.replaceChildren(row);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatAmount(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
}

async function loadDashboard() {
  alertBox.textContent = "Memuat data dashboard...";
  document.querySelector("#stat-consultations").textContent = "Memuat...";
  document.querySelector("#stat-pending").textContent = "Memuat...";
  document.querySelector("#stat-paid").textContent = "Memuat...";
  emptyRow(consultationRows, 6, "Memuat permintaan konsultasi...");
  emptyRow(orderRows, 6, "Memuat pesanan paket...");
  if (adminRefreshButton) {
    adminRefreshButton.disabled = true;
    adminRefreshButton.setAttribute("aria-busy", "true");
  }

  try {
    const [summary, consultations, orders] = await Promise.all([
      api("/api/admin/summary"),
      api("/api/admin/consultations"),
      api("/api/admin/orders"),
    ]);
    document.querySelector("#stat-consultations").textContent = summary.consultations;
    document.querySelector("#stat-pending").textContent = summary.pendingOrders;
    document.querySelector("#stat-paid").textContent = summary.paidOrders;
    renderConsultations(consultations.consultations);
    renderOrders(orders.orders);
    alertBox.textContent = "";
  } catch (error) {
    alertBox.textContent = `Data dashboard gagal dimuat. ${error.message}`;
    document.querySelector("#stat-consultations").textContent = "Tidak tersedia";
    document.querySelector("#stat-pending").textContent = "Tidak tersedia";
    document.querySelector("#stat-paid").textContent = "Tidak tersedia";
    emptyRow(consultationRows, 6, "Permintaan gagal dimuat. Pilih Muat ulang untuk mencoba lagi.");
    emptyRow(orderRows, 6, "Pesanan gagal dimuat. Pilih Muat ulang untuk mencoba lagi.");
    if (error.message.includes("masuk") || error.message.includes("administrator")) {
      window.location.assign("/");
    }
  } finally {
    if (adminRefreshButton) {
      adminRefreshButton.disabled = false;
      adminRefreshButton.removeAttribute("aria-busy");
    }
  }
}

function renderConsultations(items) {
  if (!items.length) return emptyRow(consultationRows, 6, "Belum ada permintaan. Data tampil setelah formulir konsultasi dikirim.");
  const rows = items.map((item) => {
    const row = document.createElement("tr");
    const contact = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const email = document.createElement("small");
    email.textContent = `${item.contact} · akun ${item.accountEmail}`;
    contact.dataset.label = "Kontak";
    contact.append(name, email);
    row.append(contact, cell(item.project, "", "Kebutuhan"), cell(item.budget, "", "Budget"), cell(item.details || "Tidak ada pesan", "", "Pesan"), cell("", "", "Status"));
    const statusCell = row.lastElementChild;
    const status = document.createElement("select");
    status.setAttribute("aria-label", `Status permintaan ${item.name}`);
    for (const [value, label] of [["new", "Baru"], ["contacted", "Dihubungi"], ["closed", "Selesai"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = item.status === value;
      status.append(option);
    }
    status.addEventListener("change", async () => {
      status.disabled = true;
      try {
        await api(`/api/admin/consultations/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: status.value }),
        });
        alertBox.textContent = "Status permintaan diperbarui.";
        await loadDashboard();
      } catch (error) {
        alertBox.textContent = error.message;
        status.disabled = false;
      }
    });
    statusCell.append(status);
    row.append(cell(formatDate(item.createdAt), "", "Diterima"));
    return row;
  });
  consultationRows.replaceChildren(...rows);
}

function renderOrders(items) {
  if (!items.length) return emptyRow(orderRows, 6, "Belum ada pesanan. Data tampil setelah checkout dibuat.");
  const rows = items.map((item) => {
    const row = document.createElement("tr");
    const customer = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = item.customerName;
    const email = document.createElement("small");
    email.textContent = item.customerEmail;
    customer.dataset.label = "Pelanggan";
    customer.append(name, email);
    const statusCell = document.createElement("td");
    statusCell.dataset.label = "Pembayaran";
    const status = document.createElement("span");
    status.className = `admin-status ${item.paymentStatus}`;
    status.textContent = item.paymentStatus;
    statusCell.append(status);
    const serviceCell = document.createElement("td");
    serviceCell.dataset.label = "Layanan";
    const serviceStatus = document.createElement("span");
    serviceStatus.className = `admin-status ${item.serviceStatus}`;
    serviceStatus.textContent = serviceStatusLabel(item.serviceStatus);
    serviceCell.append(serviceStatus);
    if (item.expiresAt) {
      const expiry = document.createElement("small");
      expiry.className = "admin-service-details";
      expiry.textContent = `Berakhir ${item.expiresAt}`;
      serviceCell.append(expiry);
    }
    const actions = document.createElement("td");
    actions.className = "admin-order-actions";
    actions.dataset.label = "Tindakan";
    if (item.paymentStatus === "paid" && item.serviceStatus === "awaiting_activation") {
      actions.append(serviceActionButton(item, "processing", "Proses"));
    } else if (item.paymentStatus === "paid" && item.serviceStatus === "processing") {
      actions.append(serviceActivationForm(item));
    } else if (item.paymentStatus === "paid" && item.serviceStatus === "active") {
      actions.append(
        serviceActionButton(item, "completed", "Selesai"),
        serviceActionButton(item, "expired", "Kedaluwarsa"),
      );
    }
    actions.append(serviceHistory(item));
    const packageCell = document.createElement("td");
    packageCell.dataset.label = "Paket / invoice";
    packageCell.textContent = item.packageName;
    const invoice = document.createElement("small");
    invoice.textContent = item.invoiceNumber || item.id;
    packageCell.append(invoice);
    row.append(customer, packageCell, cell(formatAmount(item.amount), "", "Jumlah"), statusCell, serviceCell, actions);
    return row;
  });
  orderRows.replaceChildren(...rows);
}

function serviceStatusLabel(status) {
  return ({
    awaiting_payment: "Menunggu bayar",
    awaiting_activation: "Menunggu proses",
    processing: "Diproses",
    active: "Aktif",
    completed: "Selesai",
    expired: "Kedaluwarsa",
    cancelled: "Dibatalkan",
  })[status] || status;
}

function serviceActionButton(order, serviceStatus, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-small button-outline";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.id)}/service`, {
        method: "PATCH",
        body: JSON.stringify({ serviceStatus }),
      });
      alertBox.textContent = `Status layanan diperbarui menjadi ${serviceStatusLabel(serviceStatus).toLowerCase()}.`;
      await loadDashboard();
    } catch (error) {
      alertBox.textContent = error.message;
      button.disabled = false;
    }
  });
  return button;
}

function labeledInput(labelText, name, type, value = "", required = false) {
  const label = document.createElement("label");
  label.append(document.createTextNode(labelText));
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value;
  input.required = required;
  label.append(input);
  return { label, input };
}

function serviceActivationForm(order) {
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Isi detail & aktifkan";
  const form = document.createElement("form");
  form.className = "admin-service-form";
  const typeLabel = document.createElement("label");
  typeLabel.append(document.createTextNode("Jenis layanan"));
  const type = document.createElement("select");
  type.name = "serviceType";
  for (const [value, labelText] of [["hosting", "Hosting"], ["vps", "VPS"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labelText;
    type.append(option);
  }
  typeLabel.append(type);
  form.append(
    typeLabel,
    labeledInput("Host / IP", "host", "text", "", true).label,
    labeledInput("Username", "username", "text", "", true).label,
    labeledInput("Port (opsional)", "port", "number").label,
    labeledInput("Tanggal aktif", "startedAt", "date", new Date().toISOString().slice(0, 10), true).label,
    labeledInput("Tanggal berakhir", "expiresAt", "date", defaultExpirationDate(), true).label,
  );
  const notesLabel = document.createElement("label");
  notesLabel.append(document.createTextNode("Catatan akses"));
  const notes = document.createElement("textarea");
  notes.name = "notes";
  notes.maxLength = 2000;
  notesLabel.append(notes);
  const warning = document.createElement("small");
  warning.className = "admin-service-warning";
  warning.textContent = "Jangan masukkan kata sandi, token, atau kunci pribadi. Berikan kredensial secara terpisah melalui kanal aman.";
  form.append(notesLabel, warning);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button button-small button-dark";
  submit.textContent = "Aktifkan layanan";
  form.append(submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    const values = Object.fromEntries(new FormData(form).entries());
    const port = values.port ? Number(values.port) : null;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(order.id)}/service`, {
        method: "PATCH",
        body: JSON.stringify({ serviceStatus: "active", ...values, port }),
      });
      alertBox.textContent = "Layanan aktif. Pelanggan akan menerima email pemberitahuan.";
      await loadDashboard();
    } catch (error) {
      alertBox.textContent = error.message;
      submit.disabled = false;
    }
  });
  disclosure.append(summary, form);
  return disclosure;
}

function defaultExpirationDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

function serviceHistory(order) {
  const disclosure = document.createElement("details");
  disclosure.className = "admin-order-history";
  const summary = document.createElement("summary");
  summary.textContent = "Riwayat";
  const list = document.createElement("small");
  list.className = "admin-service-details";
  list.textContent = "Buka untuk memuat riwayat perubahan.";
  disclosure.append(summary, list);
  disclosure.addEventListener("toggle", async () => {
    if (!disclosure.open || disclosure.dataset.loaded) return;
    list.textContent = "Memuat riwayat…";
    try {
      const { events } = await api(`/api/admin/orders/${encodeURIComponent(order.id)}/history`);
      list.textContent = events.length
        ? events.map((event) => `${event.eventType === "status_changed" ? `${serviceStatusLabel(event.fromStatus)} → ${serviceStatusLabel(event.toStatus)}` : "Detail akses disimpan"} · ${event.actorEmail} · ${formatDate(event.createdAt)}`).join(" | ")
        : "Belum ada perubahan layanan.";
      disclosure.dataset.loaded = "true";
    } catch (error) {
      list.textContent = error.message;
    }
  });
  return disclosure;
}

const adminLogoutButton = document.querySelector("#admin-logout");
const adminBackupButton = document.querySelector("#admin-backup");

if (adminRefreshButton) {
  adminRefreshButton.addEventListener("click", loadDashboard);
}

if (adminBackupButton) {
  adminBackupButton.addEventListener("click", async () => {
    adminBackupButton.disabled = true;
    try {
      const backup = await api("/api/admin/backups", { method: "POST", body: JSON.stringify({}) });
      alertBox.textContent = `Backup database berhasil dibuat (${Math.ceil(backup.sizeBytes / 1024)} KB).`;
    } catch (error) {
      alertBox.textContent = error.message;
    } finally {
      adminBackupButton.disabled = false;
    }
  });
}

if (adminLogoutButton) {
  adminLogoutButton.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
      window.location.assign("/");
    } catch (error) {
      alertBox.textContent = error.message;
    }
  });
}

(async () => {
  try {
    const { user } = await api("/api/auth/me");
    if (!user || user.role !== "admin") {
      window.location.assign("/");
      return;
    }

    const adminIdentity = document.querySelector("#admin-identity");
    if (adminIdentity) adminIdentity.textContent = user.email;
    await loadDashboard();
  } catch (error) {
    if (alertBox) alertBox.textContent = error.message;
    window.location.assign("/");
  }
})();
