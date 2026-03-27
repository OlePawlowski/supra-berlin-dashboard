const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-").toLowerCase();
}

function formatOutboundSubject(request, subject) {
  return `[${request.publicCode}] ${subject}`;
}

function buildTemplate(type, request, customBody) {
  const formattedDate = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "full"
  }).format(new Date(`${request.reservationDate}T12:00:00`));

  const baseIntro = `Hallo ${request.customerName},`;
  const signature = `Viele Grüße\nSupra Berlin\nAm Zwirngraben 6-7\n10178 Berlin`;

  if (type === "confirmed") {
    return {
      subject: `Ihre Gruppenanfrage ist bestätigt`,
      body: customBody?.trim() || `${baseIntro}

wir freuen uns, Ihre Gruppenanfrage bestätigen zu können.

Termin: ${formattedDate} um ${request.reservationTime} Uhr
Personen: ${request.guestCount}
Referenz: ${request.publicCode}

Falls sich noch etwas ändert, antworten Sie einfach auf diese E-Mail.

${signature}`
    };
  }

  if (type === "declined") {
    return {
      subject: `Ihre Gruppenanfrage konnten wir leider nicht annehmen`,
      body: customBody?.trim() || `${baseIntro}

vielen Dank für Ihre Anfrage. Leider können wir den angefragten Termin aktuell nicht bestätigen.

Termin: ${formattedDate} um ${request.reservationTime} Uhr
Personen: ${request.guestCount}
Referenz: ${request.publicCode}

Gerne können Sie uns auf diese E-Mail antworten, damit wir gemeinsam eine Alternative finden.

${signature}`
    };
  }

  return {
    subject: "Rückfrage zu Ihrer Gruppenanfrage",
    body: customBody?.trim() || `${baseIntro}

vielen Dank für Ihre Anfrage. Wir haben noch eine Rückfrage zu Ihrer Reservierung.

Referenz: ${request.publicCode}

Bitte antworten Sie direkt auf diese E-Mail.

${signature}`
  };
}

class EmailService {
  constructor({ db, dataDir, env, logger = console }) {
    this.db = db;
    this.env = env;
    this.logger = logger;
    this.outboxDir = path.join(dataDir, "email-outbox");
    this.statePath = path.join(dataDir, "imap-state.json");
    ensureDir(this.outboxDir);

    this.smtpConfigured = Boolean(
      env.SMTP_HOST &&
      env.SMTP_PORT &&
      env.SMTP_USER &&
      env.SMTP_PASS &&
      env.SMTP_FROM
    );

    this.imapConfigured = Boolean(
      env.IMAP_HOST &&
      env.IMAP_PORT &&
      env.IMAP_USER &&
      env.IMAP_PASS
    );

    this.transport = this.smtpConfigured
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT),
          secure: String(env.SMTP_SECURE || "false") === "true",
          auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS
          }
        })
      : null;
  }

  async sendEmail({ request, subject, body, requestId }) {
    const finalSubject = formatOutboundSubject(request, subject);
    const payload = {
      from: this.env.SMTP_FROM || "Supra Berlin <noreply@local.invalid>",
      to: request.customerEmail,
      replyTo: this.env.SMTP_REPLY_TO || this.env.SMTP_FROM || undefined,
      subject: finalSubject,
      text: body
    };

    let delivery = {
      mode: "logged"
    };

    if (this.transport) {
      const info = await this.transport.sendMail(payload);
      delivery = {
        mode: "smtp",
        messageId: info.messageId || null
      };
    } else {
      const outboxEntry = {
        createdAt: new Date().toISOString(),
        requestId,
        publicCode: request.publicCode,
        to: payload.to,
        subject: finalSubject,
        body
      };

      const fileName = `${Date.now()}-${safeFilename(request.publicCode)}.json`;
      fs.writeFileSync(path.join(this.outboxDir, fileName), JSON.stringify(outboxEntry, null, 2));
    }

    this.db.addMessage({
      requestId,
      direction: "outbound",
      channel: "email",
      senderName: "Supra Berlin",
      senderEmail: this.env.SMTP_FROM || "noreply@local.invalid",
      subject: finalSubject,
      body,
      externalId: delivery.messageId || null
    });

    return delivery;
  }

  async sendStatusTemplate({ request, requestId, templateType, customBody }) {
    const template = buildTemplate(templateType, request, customBody);
    return this.sendEmail({
      request,
      requestId,
      subject: template.subject,
      body: template.body
    });
  }

  loadImapState() {
    if (!fs.existsSync(this.statePath)) {
      return { lastUid: 0 };
    }

    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch (error) {
      this.logger.error("IMAP-Status konnte nicht gelesen werden:", error);
      return { lastUid: 0 };
    }
  }

  saveImapState(state) {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  async syncInbox() {
    if (!this.imapConfigured) {
      return { synced: false, reason: "imap-not-configured" };
    }

    const client = new ImapFlow({
      host: this.env.IMAP_HOST,
      port: Number(this.env.IMAP_PORT),
      secure: String(this.env.IMAP_SECURE || "true") === "true",
      auth: {
        user: this.env.IMAP_USER,
        pass: this.env.IMAP_PASS
      }
    });

    const state = this.loadImapState();
    let highestUid = state.lastUid || 0;
    let imported = 0;

    try {
      await client.connect();
      await client.mailboxOpen("INBOX");

      const searchQuery = highestUid ? { uid: `${highestUid + 1}:*` } : { all: true };
      const messages = await client.search(searchQuery);

      for await (const message of client.fetch(messages, { uid: true, source: true })) {
        highestUid = Math.max(highestUid, message.uid);

        const parsed = await simpleParser(message.source);
        const subject = parsed.subject || "";
        const match = subject.match(/\[(SUPRA-REQ-\d+)\]/i);
        if (!match) {
          continue;
        }

        const publicCode = match[1].toUpperCase();
        const request = this.db.getRequestByCode(publicCode);
        if (!request) {
          continue;
        }

        const externalId = parsed.messageId || `imap-${message.uid}`;

        try {
          this.db.addMessage({
            requestId: request.id,
            direction: "inbound",
            channel: "email",
            senderName: parsed.from?.value?.[0]?.name || parsed.from?.text || "Gast",
            senderEmail: parsed.from?.value?.[0]?.address || "",
            subject,
            body: (parsed.text || parsed.html || "").trim() || "(Leere Antwort erhalten)",
            externalId,
            createdAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString()
          });
          imported += 1;
        } catch (error) {
          if (!String(error.message).includes("UNIQUE")) {
            throw error;
          }
        }
      }

      this.saveImapState({ lastUid: highestUid });
      return { synced: true, imported };
    } finally {
      try {
        await client.logout();
      } catch (error) {
        this.logger.error("IMAP-Logout fehlgeschlagen:", error);
      }
    }
  }
}

module.exports = {
  EmailService
};
