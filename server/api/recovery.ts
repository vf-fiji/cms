import { Router, type Request } from "express";
import { logError } from "../log";
import { get, getSettings, logActivity } from "../db";
import { HttpError } from "../auth";
import { str } from "../http";
import { sendMail, getMailTransport } from "../mail";
import { rateLimit, envLimit } from "../ratelimit";
import { createResetToken, findValidReset, resetPasswordWithToken, RESET_TTL_MINUTES, MIN_PASSWORD_LENGTH } from "../resets";

/** Self-service "Forgot password?" (unauthenticated). */
export const recovery = Router();

const isProd = () => process.env.NODE_ENV === "production";
const emailOf = (req: Request) => String(req.body?.email ?? "").trim().toLowerCase().slice(0, 200);
const TOO_MANY = "Too many reset requests. Please wait a few minutes and try again.";

/**
 * Links in emails must not be built from the Host header (anyone can send a request
 * with a forged one), so production needs REEF_PUBLIC_URL. Development falls back to
 * the address you're browsing.
 */
export function publicBaseUrl(req: Request): string | null {
  const configured = process.env.REEF_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return isProd() ? null : `${req.protocol}://${req.get("host")}`;
}

const GENERIC = "If an account exists for that email, we've sent a link to reset its password. Check your inbox (and spam folder).";

recovery.post(
  "/auth/forgot",
  rateLimit({ max: envLimit("REEF_RATE_LIMIT_RESET", 5), windowMs: 15 * 60_000, message: TOO_MANY }),
  rateLimit({ max: 3, windowMs: 60 * 60_000, key: (req) => `email:${emailOf(req)}`, message: TOO_MANY }),
  (req, res) => {
    const email = str(req.body?.email, "Email", { required: true, max: 200 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
    // Same answer and no waiting on email delivery, whether or not the account exists.
    res.json({ ok: true, message: GENERIC });
    try {
      sendResetLink(req, email);
    } catch (e: any) {
      console.error(`[auth] Couldn't start a password reset for ${email}: ${e?.message ?? e}`);
    }
  },
);

function sendResetLink(req: Request, email: string) {
  const user = get("SELECT id, name, email FROM users WHERE email = ? AND active = 1", email);
  if (!user) return;
  const base = publicBaseUrl(req);
  if (!base) {
    logError("auth", new Error("Password reset requested but REEF_PUBLIC_URL isn't set, so no link can be sent. Set it to the site's public https:// address."));
    return;
  }
  if (!getMailTransport().delivers) {
    console.warn(`[auth] Password reset requested for ${user.email}, but email isn't configured (set SMTP_HOST). No link was sent.`);
    return;
  }
  const token = createResetToken(user.id);
  const link = `${base}/admin/reset-password#token=${token}`;
  const site = getSettings().siteName || "VodaForge";
  const text = [
    `Hi ${user.name},`,
    "",
    `Someone (hopefully you) asked to reset the password for your ${site} admin account (${user.email}).`,
    "",
    `Choose a new password here. The link works once and expires in ${RESET_TTL_MINUTES} minutes:`,
    link,
    "",
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
  ].join("\n");
  sendMail({ to: user.email, subject: `Reset your ${site} password`, text }).catch((e) =>
    console.error(`[auth] Couldn't send the password reset email to ${user.email}: ${e?.message ?? e}`),
  );
}

const resetLimit = rateLimit({ max: 20, windowMs: 15 * 60_000, message: TOO_MANY });

recovery.post("/auth/reset/check", resetLimit, (req, res) => {
  const valid = findValidReset(req.body?.token);
  res.json(valid ? { valid: true, email: valid.email } : { valid: false });
});

recovery.post("/auth/reset", resetLimit, (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password.length > 500) throw new HttpError(400, "That password is too long.");
  const done = resetPasswordWithToken(req.body?.token, password);
  if (!done) throw new HttpError(400, "This reset link has expired or was already used. Request a new one from the sign-in page.");
  logActivity(done.userId, "reset their password", "user", done.userId, done.name);
  res.json({ ok: true, email: done.email });
});
