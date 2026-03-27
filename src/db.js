const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const VALID_STATUSES = ["new", "review", "confirmed", "declined", "completed"];

function nowIso() {
  return new Date().toISOString();
}

function formatPublicCode(id) {
  return `SUPRA-REQ-${String(id).padStart(4, "0")}`;
}

function ensureDataDir(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
}

function createDb({ dataDir }) {
  ensureDataDir(dataDir);

  const dbPath = path.join(dataDir, "supra-dashboard.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publicCode TEXT UNIQUE,
      customerName TEXT NOT NULL,
      customerEmail TEXT NOT NULL,
      customerPhone TEXT NOT NULL,
      guestCount INTEGER NOT NULL,
      reservationDate TEXT NOT NULL,
      reservationTime TEXT NOT NULL,
      occasion TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      source TEXT NOT NULL DEFAULT 'website-form',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requestId INTEGER NOT NULL,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      senderName TEXT,
      senderEmail TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      externalId TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (requestId) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_date_time ON requests(reservationDate, reservationTime);
    CREATE INDEX IF NOT EXISTS idx_messages_requestId ON messages(requestId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_externalId ON messages(externalId) WHERE externalId IS NOT NULL;
  `);

  const insertRequest = db.prepare(`
    INSERT INTO requests (
      customerName,
      customerEmail,
      customerPhone,
      guestCount,
      reservationDate,
      reservationTime,
      occasion,
      notes,
      status,
      source,
      createdAt,
      updatedAt
    ) VALUES (
      @customerName,
      @customerEmail,
      @customerPhone,
      @guestCount,
      @reservationDate,
      @reservationTime,
      @occasion,
      @notes,
      @status,
      @source,
      @createdAt,
      @updatedAt
    )
  `);

  const updatePublicCode = db.prepare(`
    UPDATE requests
    SET publicCode = @publicCode, updatedAt = @updatedAt
    WHERE id = @id
  `);

  const insertMessage = db.prepare(`
    INSERT INTO messages (
      requestId,
      direction,
      channel,
      senderName,
      senderEmail,
      subject,
      body,
      externalId,
      createdAt
    ) VALUES (
      @requestId,
      @direction,
      @channel,
      @senderName,
      @senderEmail,
      @subject,
      @body,
      @externalId,
      @createdAt
    )
  `);

  const getRequestRow = db.prepare(`
    SELECT *
    FROM requests
    WHERE id = ?
  `);

  const getRequestByCodeRow = db.prepare(`
    SELECT *
    FROM requests
    WHERE publicCode = ?
  `);

  const updateStatusStmt = db.prepare(`
    UPDATE requests
    SET status = @status, updatedAt = @updatedAt
    WHERE id = @id
  `);

  const updateRequestStmt = db.prepare(`
    UPDATE requests
    SET
      customerName = @customerName,
      customerEmail = @customerEmail,
      customerPhone = @customerPhone,
      guestCount = @guestCount,
      reservationDate = @reservationDate,
      reservationTime = @reservationTime,
      occasion = @occasion,
      notes = @notes,
      updatedAt = @updatedAt
    WHERE id = @id
  `);

  const listMessagesStmt = db.prepare(`
    SELECT *
    FROM messages
    WHERE requestId = ?
    ORDER BY datetime(createdAt) ASC, id ASC
  `);

  function withMessages(row) {
    if (!row) {
      return null;
    }

    return {
      ...row,
      messages: listMessagesStmt.all(row.id)
    };
  }

  function createRequest(payload) {
    const timestamp = nowIso();
    const record = {
      customerName: payload.customerName.trim(),
      customerEmail: payload.customerEmail.trim().toLowerCase(),
      customerPhone: payload.customerPhone.trim(),
      guestCount: Number(payload.guestCount),
      reservationDate: payload.reservationDate,
      reservationTime: payload.reservationTime,
      occasion: (payload.occasion || "").trim(),
      notes: (payload.notes || "").trim(),
      status: payload.status || "new",
      source: payload.source || "website-form",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const createTx = db.transaction((requestRecord) => {
      const result = insertRequest.run(requestRecord);
      const id = Number(result.lastInsertRowid);
      const publicCode = formatPublicCode(id);

      updatePublicCode.run({
        id,
        publicCode,
        updatedAt: timestamp
      });

      insertMessage.run({
        requestId: id,
        direction: "system",
        channel: "timeline",
        senderName: "System",
        senderEmail: null,
        subject: "Neue Gruppenanfrage",
        body: `Anfrage ${publicCode} wurde neu angelegt.`,
        externalId: null,
        createdAt: timestamp
      });

      return id;
    });

    const id = createTx(record);
    return getRequest(id);
  }

  function updateRequest(id, payload) {
    const existing = getRequestRow.get(id);
    if (!existing) {
      return null;
    }

    const updatedAt = nowIso();
    updateRequestStmt.run({
      id,
      customerName: payload.customerName.trim(),
      customerEmail: payload.customerEmail.trim().toLowerCase(),
      customerPhone: payload.customerPhone.trim(),
      guestCount: Number(payload.guestCount),
      reservationDate: payload.reservationDate,
      reservationTime: payload.reservationTime,
      occasion: (payload.occasion || "").trim(),
      notes: (payload.notes || "").trim(),
      updatedAt
    });

    insertMessage.run({
      requestId: id,
      direction: "system",
      channel: "timeline",
      senderName: "System",
      senderEmail: null,
      subject: "Anfrage aktualisiert",
      body: `Anfrage ${existing.publicCode} wurde im Dashboard aktualisiert.`,
      externalId: null,
      createdAt: updatedAt
    });

    return getRequest(id);
  }

  function addMessage(payload) {
    const timestamp = payload.createdAt || nowIso();
    insertMessage.run({
      requestId: payload.requestId,
      direction: payload.direction,
      channel: payload.channel,
      senderName: payload.senderName || null,
      senderEmail: payload.senderEmail || null,
      subject: payload.subject || null,
      body: payload.body.trim(),
      externalId: payload.externalId || null,
      createdAt: timestamp
    });

    db.prepare("UPDATE requests SET updatedAt = ? WHERE id = ?").run(timestamp, payload.requestId);
    return getRequest(payload.requestId);
  }

  function updateStatus(id, status, noteText) {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error("Ungültiger Status.");
    }

    const request = getRequestRow.get(id);
    if (!request) {
      return null;
    }

    const updatedAt = nowIso();
    const tx = db.transaction(() => {
      updateStatusStmt.run({ id, status, updatedAt });
      insertMessage.run({
        requestId: id,
        direction: "system",
        channel: "timeline",
        senderName: "System",
        senderEmail: null,
        subject: "Status aktualisiert",
        body: noteText || `Status wurde auf "${status}" gesetzt.`,
        externalId: null,
        createdAt: updatedAt
      });
    });

    tx();
    return getRequest(id);
  }

  function listRequests(filters = {}) {
    const where = [];
    const params = {};

    if (filters.status && filters.status !== "all") {
      where.push("status = @status");
      params.status = filters.status;
    }

    if (filters.month) {
      where.push("substr(reservationDate, 1, 7) = @month");
      params.month = filters.month;
    }

    if (filters.search) {
      where.push(`
        (
          customerName LIKE @search OR
          customerEmail LIKE @search OR
          customerPhone LIKE @search OR
          publicCode LIKE @search
        )
      `);
      params.search = `%${filters.search}%`;
    }

    const sql = `
      SELECT *
      FROM requests
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'new' THEN 1
          WHEN 'review' THEN 2
          WHEN 'confirmed' THEN 3
          WHEN 'completed' THEN 4
          WHEN 'declined' THEN 5
          ELSE 6
        END,
        reservationDate ASC,
        reservationTime ASC,
        createdAt DESC
    `;

    return db.prepare(sql).all(params).map((row) => ({
      ...row,
      messageCount: db.prepare("SELECT COUNT(*) AS total FROM messages WHERE requestId = ?").get(row.id).total
    }));
  }

  function getRequest(id) {
    return withMessages(getRequestRow.get(id));
  }

  function getRequestByCode(publicCode) {
    return withMessages(getRequestByCodeRow.get(publicCode));
  }

  function getCalendarItems(month) {
    return db.prepare(`
      SELECT id, publicCode, customerName, guestCount, reservationDate, reservationTime, status
      FROM requests
      WHERE substr(reservationDate, 1, 7) = ?
      ORDER BY reservationDate ASC, reservationTime ASC
    `).all(month);
  }

  function getDashboardSummary() {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0) AS newCount,
        COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS reviewCount,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmedCount,
        COALESCE(SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END), 0) AS declinedCount
      FROM requests
    `).get();

    const upcoming = db.prepare(`
      SELECT COUNT(*) AS total
      FROM requests
      WHERE reservationDate >= date('now')
        AND status IN ('new', 'review', 'confirmed')
    `).get();

    return {
      ...totals,
      upcomingCount: upcoming.total
    };
  }

  function listRecentActivity(limit = 10) {
    return db.prepare(`
      SELECT
        messages.*,
        requests.publicCode,
        requests.customerName
      FROM messages
      JOIN requests ON requests.id = messages.requestId
      ORDER BY datetime(messages.createdAt) DESC, messages.id DESC
      LIMIT ?
    `).all(limit);
  }

  return {
    VALID_STATUSES,
    createRequest,
    updateRequest,
    addMessage,
    updateStatus,
    listRequests,
    getRequest,
    getRequestByCode,
    getCalendarItems,
    getDashboardSummary,
    listRecentActivity
  };
}

module.exports = {
  createDb,
  VALID_STATUSES,
  formatPublicCode
};
