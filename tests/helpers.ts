import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CMS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ADMIN = { email: "admin@test.local", password: "test-admin-password-123" };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface TestServer {
  url: string;
  dataDir: string;
  stop: () => Promise<void>;
  output: () => string;
}

export interface StartOptions {
  /** Extra environment variables (e.g. SMTP_HOST, rate limits). */
  env?: Record<string, string>;
  /** Use an existing data folder (e.g. a restored backup) instead of a fresh one. */
  dataDir?: string;
}

/** Starts a real Reef server (production mode, no Vite) on a free port with a fresh database. */
export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const port = await freePort();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "reef-api-"));
  let log = "";
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: CMS_ROOT,
    env: {
      ...process.env,
      // Keep a developer's own mail settings out of the tests.
      SMTP_HOST: "",
      REEF_ALERT_WEBHOOK: "",
      REEF_BACKUP_AT: "",
      REEF_BACKUP_AFTER: "",
      REEF_TRUST_PROXY: "",
      REEF_PUBLIC_URL: `http://127.0.0.1:${port}`,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      REEF_DATA_DIR: dataDir,
      REEF_ADMIN_EMAIL: ADMIN.email,
      REEF_ADMIN_PASSWORD: ADMIN.password,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Server exited during start-up:\n${log}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`Server didn't start within 30s:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url,
    dataDir,
    output: () => log,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => {
          if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          resolve();
        });
        child.kill();
      }),
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A tiny API client that keeps the session cookie and CSRF token like the admin app does. */
export class Client {
  cookie = "";
  csrf = "";
  constructor(private base: string) {}

  async request<T = any>(method: string, url: string, body?: unknown, opts: { csrf?: boolean; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== "GET" && opts.csrf !== false && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    let payload: BodyInit | undefined = opts.raw;
    if (body !== undefined && !opts.raw) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = setCookie.match(/reef_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `reef_session=${m[1]}` : "";
    }
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: data as T, headers: res.headers };
  }

  get = <T = any>(url: string) => this.request<T>("GET", url);
  post = <T = any>(url: string, body: unknown = {}) => this.request<T>("POST", url, body);
  put = <T = any>(url: string, body: unknown = {}) => this.request<T>("PUT", url, body);
  del = <T = any>(url: string) => this.request<T>("DELETE", url);

  async login(email: string, password: string) {
    const r = await this.post("/api/auth/login", { email, password });
    if (r.status !== 200) throw new Error(`Login failed (${r.status}): ${JSON.stringify(r.body)}`);
    const me = await this.get("/api/auth/me");
    this.csrf = me.body.csrf;
    return me.body.user;
  }
}

/** The smallest valid PNG (1×1, transparent). */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
