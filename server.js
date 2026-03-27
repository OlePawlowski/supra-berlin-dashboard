require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { createDb } = require("./src/db");
const { EmailService } = require("./src/email");

const app = express();
const PORT = Number(process.env.PORT || 3030);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SESSION_COOKIE = "supra_admin_session";

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createDb({ dataDir: DATA_DIR });
const emailService = new EmailService({
  db,
  dataDir: DATA_DIR,
  env: process.env
});

const appConfig = {
  restaurantName: process.env.RESTAURANT_NAME || "Supra Berlin",
  adminPassword: process.env.ADMIN_PASSWORD || "supra-admin",
  sessionSecret: process.env.SESSION_SECRET || "supra-session-secret",
  minimumGroupSize: Number(process.env.MIN_GROUP_SIZE || 9),
  syncIntervalMs: Number(process.env.IMAP_SYNC_INTERVAL_MS || 60000)
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/public", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.PUBLIC_CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

function parseCookies(headerValue = "") {
  return headerValue
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separator = part.indexOf("=");
      if (separator === -1) {
        return accumulator;
      }

      const key = part.slice(0, separator);
      const value = decodeURIComponent(part.slice(separator + 1));
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function makeSessionToken() {
  const payload = JSON.stringify({
    role: "admin",
    createdAt: Date.now()
  });
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = crypto.createHmac("sha256", appConfig.sessionSecret).update(encoded).digest("hex");
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) {
    return false;
  }

  const [encoded, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", appConfig.sessionSecret).update(encoded).digest("hex");
  if (signature !== expected) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload.role === "admin";
  } catch (error) {
    return false;
  }
}

function setSessionCookie(res) {
  const token = makeSessionToken();
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 12}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || "");
  const isAuthenticated = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!isAuthenticated) {
    return res.status(401).json({ error: "Nicht angemeldet." });
  }

  next();
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return /^\d{2}:\d{2}$/.test(value);
}

function validateRequestPayload(payload, minimumGuests = appConfig.minimumGroupSize) {
  const errors = [];

  if (!payload.customerName || payload.customerName.trim().length < 2) {
    errors.push("Bitte einen gültigen Namen eingeben.");
  }

  if (!payload.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.customerEmail)) {
    errors.push("Bitte eine gültige E-Mail-Adresse eingeben.");
  }

  if (!payload.customerPhone || payload.customerPhone.trim().length < 6) {
    errors.push("Bitte eine gültige Telefonnummer eingeben.");
  }

  const guestCount = Number(payload.guestCount);
  if (!Number.isInteger(guestCount) || guestCount < minimumGuests || guestCount > 100) {
    errors.push(`Die Gruppengröße muss zwischen ${minimumGuests} und 100 Personen liegen.`);
  }

  if (!isValidDate(payload.reservationDate)) {
    errors.push("Bitte ein gültiges Datum wählen.");
  }

  if (!isValidTime(payload.reservationTime)) {
    errors.push("Bitte eine gültige Uhrzeit wählen.");
  }

  return errors;
}

function serializeBootstrap(month, filters = {}) {
  return {
    summary: db.getDashboardSummary(),
    requests: db.listRequests(filters),
    calendar: db.getCalendarItems(month),
    recentActivity: db.listRecentActivity(8),
    config: {
      restaurantName: appConfig.restaurantName,
      minimumGroupSize: appConfig.minimumGroupSize,
      imapSyncEnabled: emailService.imapConfigured,
      smtpEnabled: emailService.smtpConfigured
    }
  };
}

app.post("/api/public/requests", async (req, res) => {
  const errors = validateRequestPayload(req.body);
  if (errors.length) {
    return res.status(400).json({ errors });
  }

  const request = db.createRequest({
    customerName: req.body.customerName,
    customerEmail: req.body.customerEmail,
    customerPhone: req.body.customerPhone,
    guestCount: req.body.guestCount,
    reservationDate: req.body.reservationDate,
    reservationTime: req.body.reservationTime,
    occasion: req.body.occasion,
    notes: req.body.notes,
    source: "website-form",
    status: "new"
  });

  db.addMessage({
    requestId: request.id,
    direction: "outbound",
    channel: "timeline",
    senderName: "System",
    senderEmail: null,
    subject: "Anfrage erfolgreich eingegangen",
    body: `Eingangsnotiz für ${request.customerEmail}: Anfrage ${request.publicCode} wurde erfasst.`
  });

  res.status(201).json({
    request: {
      id: request.id,
      publicCode: request.publicCode,
      status: request.status
    }
  });
});

app.get("/api/public/calendar", (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const items = db.getCalendarItems(month).filter((item) => item.status !== "declined");
  const days = items.reduce((accumulator, item) => {
    const existing = accumulator[item.reservationDate] || {
      date: item.reservationDate,
      requestCount: 0,
      guestTotal: 0,
      confirmedCount: 0,
      pendingCount: 0,
      times: []
    };

    existing.requestCount += 1;
    existing.guestTotal += item.guestCount;
    if (item.status === "confirmed") {
      existing.confirmedCount += 1;
    } else {
      existing.pendingCount += 1;
    }
    existing.times.push(item.reservationTime);

    accumulator[item.reservationDate] = existing;
    return accumulator;
  }, {});

  res.json({
    month,
    minimumGroupSize: appConfig.minimumGroupSize,
    days: Object.values(days).sort((left, right) => left.date.localeCompare(right.date))
  });
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body.password || "");
  if (password !== appConfig.adminPassword) {
    return res.status(401).json({ error: "Falsches Passwort." });
  }

  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/session", (req, res) => {
  const cookies = parseCookies(req.headers.cookie || "");
  res.json({
    authenticated: verifySessionToken(cookies[SESSION_COOKIE]),
    config: {
      restaurantName: appConfig.restaurantName,
      minimumGroupSize: appConfig.minimumGroupSize
    }
  });
});

app.get("/api/admin/bootstrap", requireAdmin, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const status = req.query.status || "all";
  const search = (req.query.search || "").trim();

  res.json(serializeBootstrap(month, { status, search, month }));
});

app.get("/api/admin/requests", requireAdmin, (req, res) => {
  res.json({
    requests: db.listRequests({
      status: req.query.status || "all",
      search: (req.query.search || "").trim(),
      month: req.query.month || undefined
    })
  });
});

app.get("/api/admin/requests/:id", requireAdmin, (req, res) => {
  const request = db.getRequest(Number(req.params.id));
  if (!request) {
    return res.status(404).json({ error: "Anfrage nicht gefunden." });
  }

  res.json({ request });
});

app.put("/api/admin/requests/:id", requireAdmin, (req, res) => {
  const errors = validateRequestPayload(req.body, 1);
  if (errors.length) {
    return res.status(400).json({ errors });
  }

  const request = db.updateRequest(Number(req.params.id), req.body);
  if (!request) {
    return res.status(404).json({ error: "Anfrage nicht gefunden." });
  }

  res.json({ request });
});

app.patch("/api/admin/requests/:id/status", requireAdmin, async (req, res) => {
  const requestId = Number(req.params.id);
  const status = String(req.body.status || "");
  const emailBody = String(req.body.emailBody || "").trim();
  const sendEmail = Boolean(req.body.sendEmail);

  try {
    const updatedRequest = db.updateStatus(
      requestId,
      status,
      `Status wurde auf "${status}" gesetzt.`
    );

    if (!updatedRequest) {
      return res.status(404).json({ error: "Anfrage nicht gefunden." });
    }

    let delivery = null;
    if (sendEmail && ["confirmed", "declined", "review"].includes(status)) {
      const templateType = status === "review" ? "followup" : status;
      delivery = await emailService.sendStatusTemplate({
        request: updatedRequest,
        requestId,
        templateType,
        customBody: emailBody
      });
    }

    res.json({
      request: db.getRequest(requestId),
      delivery
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admin/requests/:id/messages", requireAdmin, async (req, res) => {
  const requestId = Number(req.params.id);
  const request = db.getRequest(requestId);
  if (!request) {
    return res.status(404).json({ error: "Anfrage nicht gefunden." });
  }

  const body = String(req.body.body || "").trim();
  const subject = String(req.body.subject || "").trim() || "Nachricht zu Ihrer Gruppenanfrage";
  const channel = String(req.body.channel || "email");

  if (!body) {
    return res.status(400).json({ error: "Nachricht darf nicht leer sein." });
  }

  if (channel === "note") {
    const updated = db.addMessage({
      requestId,
      direction: "internal",
      channel: "note",
      senderName: "Team",
      senderEmail: null,
      subject: "Interne Notiz",
      body
    });

    return res.status(201).json({ request: updated });
  }

  const delivery = await emailService.sendEmail({
    request,
    requestId,
    subject,
    body
  });

  res.status(201).json({
    request: db.getRequest(requestId),
    delivery
  });
});

app.get("/api/admin/calendar", requireAdmin, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json({ items: db.getCalendarItems(month) });
});

app.post("/api/admin/inbox/sync", requireAdmin, async (_req, res) => {
  const result = await emailService.syncInbox();
  res.json(result);
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: appConfig.restaurantName,
    smtpEnabled: emailService.smtpConfigured,
    imapSyncEnabled: emailService.imapConfigured
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`${appConfig.restaurantName} Dashboard läuft auf http://localhost:${PORT}`);
});

if (emailService.imapConfigured) {
  emailService.syncInbox().catch((error) => {
    console.error("Erste Inbox-Synchronisation fehlgeschlagen:", error.message);
  });

  setInterval(() => {
    emailService.syncInbox().catch((error) => {
      console.error("Inbox-Synchronisation fehlgeschlagen:", error.message);
    });
  }, appConfig.syncIntervalMs);
}
