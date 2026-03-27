const state = {
  requests: [],
  selectedRequestId: null,
  selectedRequest: null,
  summary: null,
  calendar: [],
  recentActivity: [],
  bootstrapConfig: null
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const message = payload?.error || payload?.errors?.join(" ") || "Unbekannter Fehler.";
    throw new Error(message);
  }

  return payload;
}

function setFeedback(element, message, type = "neutral") {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.dataset.type = type;
}

function formatStatus(status) {
  const labels = {
    new: "Neu",
    review: "In Prüfung",
    confirmed: "Bestätigt",
    declined: "Abgelehnt",
    completed: "Abgeschlossen",
    inbound: "Eingang",
    outbound: "Ausgang",
    internal: "Intern",
    system: "System"
  };

  return labels[status] || status;
}

function formatDate(dateValue) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium"
  }).format(new Date(`${dateValue}T12:00:00`));
}

function formatDateTime(isoValue) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoValue));
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function buildStatusClass(status) {
  return `status-${status || "neutral"}`;
}

function serializeForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function initPublicPage() {
  const form = document.querySelector("#public-request-form");
  const feedback = document.querySelector("#public-form-feedback");
  if (!form || !feedback) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFeedback(feedback, "Anfrage wird gesendet ...");

    try {
      const values = serializeForm(form);
      const payload = await api("/api/public/requests", {
        method: "POST",
        body: JSON.stringify(values)
      });

      form.reset();
      setFeedback(
        feedback,
        `Vielen Dank. Ihre Anfrage wurde erfasst. Referenz: ${payload.request.publicCode}`,
        "success"
      );
    } catch (error) {
      setFeedback(feedback, error.message, "error");
    }
  });
}

function renderSummary() {
  const target = document.querySelector("#summary-grid");
  if (!target || !state.summary) {
    return;
  }

  const cards = [
    { label: "Gesamt", value: state.summary.total || 0 },
    { label: "Neu", value: state.summary.newCount || 0 },
    { label: "In Prüfung", value: state.summary.reviewCount || 0 },
    { label: "Bestätigt", value: state.summary.confirmedCount || 0 },
    { label: "Anstehend", value: state.summary.upcomingCount || 0 }
  ];

  target.innerHTML = cards
    .map(
      (card) => `
        <article class="panel summary-card">
          <span class="summary-label">${card.label}</span>
          <strong class="summary-value">${card.value}</strong>
        </article>
      `
    )
    .join("");
}

function renderRequestList() {
  const target = document.querySelector("#request-list");
  const badge = document.querySelector("#request-count-badge");
  if (!target || !badge) {
    return;
  }

  badge.textContent = String(state.requests.length);

  if (!state.requests.length) {
    target.innerHTML = `
      <div class="empty-state inline-empty">
        <h3>Keine Treffer</h3>
        <p>Für den aktuellen Filter wurden keine Anfragen gefunden.</p>
      </div>
    `;
    return;
  }

  target.innerHTML = state.requests
    .map(
      (request) => `
        <button
          class="request-item ${state.selectedRequestId === request.id ? "is-active" : ""}"
          data-request-id="${request.id}"
          type="button"
        >
          <div class="request-item-top">
            <strong>${escapeHtml(request.customerName)}</strong>
            <span class="status-pill small ${buildStatusClass(request.status)}">${formatStatus(request.status)}</span>
          </div>
          <div class="request-item-meta">
            <span>${escapeHtml(request.publicCode)}</span>
            <span>${request.guestCount} Pers.</span>
          </div>
          <div class="request-item-meta">
            <span>${formatDate(request.reservationDate)}</span>
            <span>${escapeHtml(request.reservationTime)} Uhr</span>
          </div>
        </button>
      `
    )
    .join("");

  target.querySelectorAll("[data-request-id]").forEach((button) => {
    button.addEventListener("click", () => loadRequestDetail(Number(button.dataset.requestId)));
  });
}

function renderActivity() {
  const target = document.querySelector("#activity-list");
  if (!target) {
    return;
  }

  if (!state.recentActivity.length) {
    target.innerHTML = `<p class="muted">Noch keine Aktivität vorhanden.</p>`;
    return;
  }

  target.innerHTML = state.recentActivity
    .map(
      (item) => `
        <article class="activity-item">
          <div>
            <strong>${escapeHtml(item.customerName)}</strong>
            <p>${escapeHtml(item.subject || item.body)}</p>
          </div>
          <span class="activity-time">${formatDateTime(item.createdAt)}</span>
        </article>
      `
    )
    .join("");
}

function renderCalendar() {
  const target = document.querySelector("#calendar-grid");
  const monthInput = document.querySelector("#month-input");
  if (!target || !monthInput) {
    return;
  }

  const monthValue = monthInput.value;
  const [year, month] = monthValue.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const dayMap = new Map();

  state.calendar.forEach((item) => {
    const list = dayMap.get(item.reservationDate) || [];
    list.push(item);
    dayMap.set(item.reservationDate, list);
  });

  const cells = [];
  const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  weekdayLabels.forEach((label) => {
    cells.push(`<div class="calendar-head">${label}</div>`);
  });

  for (let index = 0; index < startOffset; index += 1) {
    cells.push(`<div class="calendar-day muted-day"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const currentDate = `${monthValue}-${String(day).padStart(2, "0")}`;
    const items = dayMap.get(currentDate) || [];

    cells.push(`
      <div class="calendar-day ${items.length ? "has-items" : ""}">
        <div class="calendar-date">${day}</div>
        <div class="calendar-events">
          ${items
            .slice(0, 3)
            .map(
              (item) => `
                <button class="calendar-event ${buildStatusClass(item.status)}" data-request-id="${item.id}" type="button">
                  <span>${escapeHtml(item.reservationTime)}</span>
                  <span>${item.guestCount} P</span>
                </button>
              `
            )
            .join("")}
          ${items.length > 3 ? `<span class="calendar-more">+${items.length - 3} weitere</span>` : ""}
        </div>
      </div>
    `);
  }

  target.innerHTML = cells.join("");
  target.querySelectorAll("[data-request-id]").forEach((button) => {
    button.addEventListener("click", () => loadRequestDetail(Number(button.dataset.requestId)));
  });
}

function fillDetailLists(request) {
  const booking = document.querySelector("#detail-booking-info");
  const contact = document.querySelector("#detail-contact-info");
  if (!booking || !contact) {
    return;
  }

  booking.innerHTML = `
    <div><dt>Datum</dt><dd>${formatDate(request.reservationDate)}</dd></div>
    <div><dt>Uhrzeit</dt><dd>${escapeHtml(request.reservationTime)} Uhr</dd></div>
    <div><dt>Personen</dt><dd>${request.guestCount}</dd></div>
    <div><dt>Anlass</dt><dd>${escapeHtml(request.occasion || "Nicht angegeben")}</dd></div>
  `;

  contact.innerHTML = `
    <div><dt>E-Mail</dt><dd>${escapeHtml(request.customerEmail)}</dd></div>
    <div><dt>Telefon</dt><dd>${escapeHtml(request.customerPhone)}</dd></div>
    <div><dt>Quelle</dt><dd>${escapeHtml(request.source)}</dd></div>
    <div><dt>Nachricht</dt><dd>${escapeHtml(request.notes || "Keine Notiz hinterlegt")}</dd></div>
  `;
}

function renderTimeline(request) {
  const target = document.querySelector("#timeline");
  if (!target) {
    return;
  }

  target.innerHTML = request.messages
    .map(
      (message) => `
        <article class="timeline-item ${buildStatusClass(message.direction)}">
          <div class="timeline-head">
            <strong>${formatStatus(message.direction)}</strong>
            <span>${formatDateTime(message.createdAt)}</span>
          </div>
          <p class="timeline-subject">${escapeHtml(message.subject || "Verlaufseintrag")}</p>
          <p>${escapeHtml(message.body)}</p>
        </article>
      `
    )
    .join("");
}

function renderDetail(request) {
  const empty = document.querySelector("#empty-detail");
  const content = document.querySelector("#detail-content");
  if (!empty || !content) {
    return;
  }

  empty.classList.add("is-hidden");
  content.classList.remove("is-hidden");

  document.querySelector("#detail-code").textContent = request.publicCode;
  document.querySelector("#detail-name").textContent = request.customerName;
  document.querySelector("#detail-meta").textContent =
    `${request.guestCount} Personen | ${formatDate(request.reservationDate)} | ${request.reservationTime} Uhr`;

  const statusPill = document.querySelector("#detail-status");
  statusPill.textContent = formatStatus(request.status);
  statusPill.className = `status-pill ${buildStatusClass(request.status)}`;

  const statusForm = document.querySelector("#status-form");
  statusForm.elements.status.value = request.status;
  statusForm.elements.emailBody.value = "";

  fillDetailLists(request);
  renderTimeline(request);
}

async function loadRequestDetail(requestId) {
  const payload = await api(`/api/admin/requests/${requestId}`);
  state.selectedRequestId = requestId;
  state.selectedRequest = payload.request;
  renderRequestList();
  renderDetail(payload.request);
}

async function loadBootstrap() {
  const month = document.querySelector("#month-input").value;
  const status = document.querySelector("#status-filter").value;
  const search = document.querySelector("#search-input").value.trim();

  const params = new URLSearchParams({
    month,
    status,
    search
  });

  const payload = await api(`/api/admin/bootstrap?${params.toString()}`);
  state.summary = payload.summary;
  state.requests = payload.requests;
  state.calendar = payload.calendar;
  state.recentActivity = payload.recentActivity;
  state.bootstrapConfig = payload.config;

  renderSummary();
  renderRequestList();
  renderCalendar();
  renderActivity();

  if (state.selectedRequestId) {
    const stillVisible = state.requests.some((request) => request.id === state.selectedRequestId);
    if (stillVisible) {
      await loadRequestDetail(state.selectedRequestId);
      return;
    }
  }

  if (state.requests.length) {
    await loadRequestDetail(state.requests[0].id);
  }
}

async function initAdminPage() {
  const monthInput = document.querySelector("#month-input");
  const overlay = document.querySelector("#admin-login-overlay");
  const loginForm = document.querySelector("#admin-login-form");
  const loginFeedback = document.querySelector("#admin-login-feedback");
  const logoutButton = document.querySelector("#logout-button");
  const reloadButton = document.querySelector("#reload-button");
  const syncButton = document.querySelector("#sync-inbox-button");

  monthInput.value = new Date().toISOString().slice(0, 7);

  async function ensureSession() {
    const payload = await api("/api/admin/session");
    overlay.classList.toggle("is-hidden", payload.authenticated);
    if (payload.authenticated) {
      await loadBootstrap();
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFeedback(loginFeedback, "Login wird geprüft ...");

    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify(serializeForm(loginForm))
      });
      loginForm.reset();
      setFeedback(loginFeedback, "Angemeldet.", "success");
      await ensureSession();
    } catch (error) {
      setFeedback(loginFeedback, error.message, "error");
    }
  });

  document.querySelector("#status-filter").addEventListener("change", loadBootstrap);
  document.querySelector("#month-input").addEventListener("change", loadBootstrap);
  document.querySelector("#reload-button").addEventListener("click", loadBootstrap);
  document.querySelector("#search-input").addEventListener("input", () => {
    window.clearTimeout(initAdminPage.searchTimer);
    initAdminPage.searchTimer = window.setTimeout(loadBootstrap, 250);
  });

  logoutButton.addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" });
    overlay.classList.remove("is-hidden");
  });

  syncButton.addEventListener("click", async () => {
    syncButton.disabled = true;
    syncButton.textContent = "Synchronisiere …";
    try {
      await api("/api/admin/inbox/sync", { method: "POST" });
      await loadBootstrap();
    } finally {
      syncButton.disabled = false;
      syncButton.textContent = "Inbox synchronisieren";
    }
  });

  document.querySelector("#status-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedRequestId) {
      return;
    }

    const form = event.currentTarget;
    const values = serializeForm(form);
    values.sendEmail = form.elements.sendEmail.checked;

    await api(`/api/admin/requests/${state.selectedRequestId}/status`, {
      method: "PATCH",
      body: JSON.stringify(values)
    });

    form.elements.emailBody.value = "";
    await loadBootstrap();
  });

  document.querySelector("#message-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedRequestId) {
      return;
    }

    const form = event.currentTarget;
    await api(`/api/admin/requests/${state.selectedRequestId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        subject: form.elements.subject.value,
        body: form.elements.body.value,
        channel: "email"
      })
    });

    form.reset();
    await loadBootstrap();
  });

  document.querySelector("#note-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedRequestId) {
      return;
    }

    const form = event.currentTarget;
    await api(`/api/admin/requests/${state.selectedRequestId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: form.elements.body.value,
        channel: "note"
      })
    });

    form.reset();
    await loadBootstrap();
  });

  await ensureSession();
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "public") {
    initPublicPage();
  }

  if (document.body.dataset.page === "admin") {
    initAdminPage();
  }
});
