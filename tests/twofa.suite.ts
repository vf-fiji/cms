import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";
import { base32Decode, base32Encode, newRecoveryCodes, totp, useRecoveryCode, verifyTotp } from "../server/totp";

describe("TOTP", () => {
  it("matches the RFC 6238 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.equal(totp(secret, Math.floor(59 / 30)), "287082");
    assert.equal(totp(secret, Math.floor(1111111109 / 30)), "081804");
    assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
  });

  it("accepts one step of clock drift and nothing more", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    assert.equal(verifyTotp(secret, totp(secret, step), now), step);
    assert.equal(verifyTotp(secret, totp(secret, step - 1), now), step - 1);
    assert.equal(verifyTotp(secret, totp(secret, step + 2), now), null);
    assert.equal(verifyTotp(secret, "12345", now), null);
  });

  it("makes single-use recovery codes", () => {
    const { codes, hashes } = newRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.match(codes[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
    const left = useRecoveryCode(hashes, codes[3].toUpperCase().replace("-", " "))!;
    assert.equal(left.length, 9);
    assert.equal(useRecoveryCode(left, codes[3]), null);
  });
});

describe("two-factor sign-in", () => {
  let server: TestServer;
  let admin: Client;
  let secret = "";
  let recovery: string[] = [];
  const step = () => Math.floor(Date.now() / 30_000);

  before(async () => {
    server = await startServer();
    admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
  });
  after(async () => {
    await server?.stop();
  });

  it("won't require 2FA for everyone until your own account has it", async () => {
    const r = await admin.put("/api/settings", { require2fa: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /your own account first/);
  });

  it("sets up with a QR code and a confirming code", async () => {
    const setup = await admin.post("/api/auth/2fa/setup");
    assert.equal(setup.status, 200);
    assert.match(setup.body.qr, /^data:image\/png;base64,/);
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/.+secret=/);
    secret = setup.body.secret;
    assert.equal((await admin.post("/api/auth/2fa/enable", { code: "000000" })).status, 400);
    const ok = await admin.post("/api/auth/2fa/enable", { code: totp(secret) });
    assert.equal(ok.status, 200);
    recovery = ok.body.recoveryCodes;
    assert.equal(recovery.length, 10);
    assert.equal((await admin.get("/api/auth/me")).body.user.twoFactorEnabled, true);
  });

  it("asks for a code after the password, and refuses wrong or reused codes", async () => {
    const c = new Client(server.url);
    const first = await c.post("/api/auth/login", { email: ADMIN.email, password: ADMIN.password });
    assert.equal(first.body.twoFactor, true);
    assert.ok(first.body.ticket);
    assert.equal((await c.get("/api/pages")).status, 401, "no session until the code is entered");

    assert.equal((await c.post("/api/auth/login/2fa", { ticket: first.body.ticket, code: "111111" })).status, 401);
    // the code used to switch 2FA on can't be replayed
    assert.equal((await c.post("/api/auth/login/2fa", { ticket: first.body.ticket, code: totp(secret, step()) })).status, 401);
    const ok = await c.post("/api/auth/login/2fa", { ticket: first.body.ticket, code: totp(secret, step() + 1) });
    assert.equal(ok.status, 200);
    assert.equal((await c.get("/api/pages")).status, 200);
    assert.equal((await c.post("/api/auth/login/2fa", { ticket: first.body.ticket, code: totp(secret, step() + 1) })).status, 401, "tickets are single-use");
  });

  it("signs in with a recovery code exactly once", async () => {
    const use = async () => {
      const c = new Client(server.url);
      const t = (await c.post("/api/auth/login", { email: ADMIN.email, password: ADMIN.password })).body.ticket;
      return c.post("/api/auth/login/2fa", { ticket: t, code: recovery[0] });
    };
    const ok = await use();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.recoveryCodesLeft, 9);
    assert.equal((await use()).status, 401);
  });

  it("locks out a challenge after five wrong codes", async () => {
    const c = new Client(server.url);
    const t = (await c.post("/api/auth/login", { email: ADMIN.email, password: ADMIN.password })).body.ticket;
    for (let i = 0; i < 4; i++) await c.post("/api/auth/login/2fa", { ticket: t, code: "000000" });
    const fifth = await c.post("/api/auth/login/2fa", { ticket: t, code: "000000" });
    assert.match(fifth.body.error, /Too many wrong codes|Too many attempts/);
    const after = await c.post("/api/auth/login/2fa", { ticket: t, code: totp(secret, step() + 1) });
    assert.equal(after.status === 401 || after.status === 429, true);
  });

  it("enforces 2FA for everyone once required, until each person sets it up", async () => {
    assert.equal((await admin.put("/api/settings", { require2fa: true })).status, 200);
    const roles = await admin.get("/api/roles");
    const editorRole = roles.body.find((r: any) => r.name === "Editor");
    const made = await admin.post("/api/users", { name: "Eddie Editor", email: "editor-2fa@test.local", roleId: editorRole.id });
    const editor = new Client(server.url);
    await editor.login("editor-2fa@test.local", made.body.temporaryPassword);

    const blocked = await editor.get("/api/pages");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.details.needs2fa, true);
    assert.equal((await editor.get("/api/settings")).status, 200, "can read settings to render the app");
    assert.equal((await editor.put("/api/settings", { require2fa: false })).status, 403, "can't switch the requirement off");
    assert.equal((await editor.get("/api/auth/2fa/status")).body.required, true);

    const setup = await editor.post("/api/auth/2fa/setup");
    assert.equal((await editor.post("/api/auth/2fa/enable", { code: totp(setup.body.secret) })).status, 200);
    const me = await editor.get("/api/auth/me");
    assert.equal(me.body.user.twoFactorEnabled, true);
    assert.equal((await editor.get("/api/pages")).status, 200);
    assert.equal((await editor.post("/api/auth/2fa/disable", { password: made.body.temporaryPassword })).status, 400, "can't turn it off while required");
  });

  it("lets an administrator reset someone's 2FA, signing them out", async () => {
    const users = await admin.get("/api/users");
    const ed = users.body.find((u: any) => u.email === "editor-2fa@test.local");
    assert.equal(ed.twoFactorEnabled, true);
    assert.equal((await admin.post(`/api/users/${ed.id}/reset-2fa`)).status, 200);
    const after = (await admin.get("/api/users")).body.find((u: any) => u.email === "editor-2fa@test.local");
    assert.equal(after.twoFactorEnabled, false);
    await admin.put("/api/settings", { require2fa: false });
  });
});
