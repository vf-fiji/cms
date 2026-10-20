import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Anything that can deliver a message. Swap it with setMailTransport() (tests, other providers). */
export interface MailTransport {
  /** Shown in the start-up log, e.g. "SMTP smtp.example.com:587". */
  describe: string;
  /** False when messages go nowhere a person will read them (production without SMTP). */
  delivers: boolean;
  send(msg: MailMessage): Promise<void>;
}

const isProd = () => process.env.NODE_ENV === "production";

/** SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS, SMTP_FROM. */
export function smtpTransportFromEnv(env = process.env): MailTransport | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT) || 587;
  const secure = env.SMTP_SECURE ? /^(1|true|yes)$/i.test(env.SMTP_SECURE) : port === 465;
  const from = env.SMTP_FROM?.trim() || `Reef CMS <no-reply@${host.replace(/^smtp\./, "")}>`;
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    describe: `SMTP ${host}:${port}${secure ? " (TLS)" : ""}`,
    delivers: true,
    async send(msg) {
      await transporter.sendMail({ from, ...msg });
    },
  };
}

/** Development fallback: print the message, links included, so you can click through. */
export const consoleTransport: MailTransport = {
  describe: "console (SMTP not configured; emails are printed here)",
  delivers: true,
  async send(msg) {
    console.log(`\n[mail] To: ${msg.to}\n[mail] Subject: ${msg.subject}\n${msg.text.replace(/^/gm, "[mail] ")}\n`);
  },
};

/** Production without SMTP: never print message bodies (they contain reset links). */
export const disabledTransport: MailTransport = {
  describe: "disabled (set SMTP_HOST to send email)",
  delivers: false,
  async send(msg) {
    console.warn(`[mail] Not sent: email isn't configured. Set SMTP_HOST to deliver “${msg.subject}” to ${msg.to}.`);
  },
};

let transport: MailTransport | null = null;

export function getMailTransport(): MailTransport {
  transport ??= smtpTransportFromEnv() ?? (isProd() ? disabledTransport : consoleTransport);
  return transport;
}

export function setMailTransport(t: MailTransport | null) {
  transport = t;
}

export function sendMail(msg: MailMessage): Promise<void> {
  return getMailTransport().send(msg);
}
