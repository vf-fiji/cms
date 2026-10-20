// Time-based one-time passwords (RFC 6238), compatible with Google
// Authenticator, Microsoft Authenticator, 1Password, Authy and others.
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The 6-digit code for a 30-second time step. */
export function totp(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/**
 * Checks a code, allowing one step of clock drift either way. Returns the
 * matching step so callers can refuse the same code twice.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const c = String(code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    const expected = totp(secret, step + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step + d;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const normaliseRecovery = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Ten single-use recovery codes like "k7qz-2mpd". Returns the codes and their hashes. */
export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { codes, hashes: codes.map((c) => sha(normaliseRecovery(c))) };
}

/** Returns the remaining hashes if `code` matched one, otherwise null. */
export function useRecoveryCode(hashes: string[], code: string): string[] | null {
  const h = sha(normaliseRecovery(code));
  if (!normaliseRecovery(code) || !hashes.includes(h)) return null;
  return hashes.filter((x) => x !== h);
}
