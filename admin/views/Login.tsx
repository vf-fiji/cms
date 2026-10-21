import { useEffect, useState, type ReactNode } from "react";
import { BrandMark, PRODUCT_NAME, PRODUCT_TAGLINE } from "../components/BrandMark";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Field } from "../components/ui";
import { Icon } from "../lib/icons";

const MIN_PASSWORD = 10;

/** The two-panel sign-in layout shared by sign-in, forgot and reset screens. */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="login">
      <div className="login-art">
        <div className="row" style={{ gap: 12 }}>
          <BrandMark size={46} />
          <div>
            <strong style={{ fontSize: 17, display: "block" }}>{PRODUCT_NAME}</strong>
            <span className="login-tagline">{PRODUCT_TAGLINE}</span>
          </div>
        </div>
        <div>
          <h2>Build beautiful websites without fighting your CMS.</h2>
          <p>Visual pages, structured content and a full code studio — in one calm, fast workspace.</p>
        </div>
        <div className="row" style={{ gap: 18, color: "rgb(255 255 255 / .6)", fontSize: 13 }}>
          <span className="row" style={{ gap: 6 }}>
            <Icon name="MousePointerClick" size={15} /> Drag-and-drop pages
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Icon name="CodeXml" size={15} /> Live code editing
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Icon name="History" size={15} /> Every change versioned
          </span>
        </div>
      </div>
      <div className="login-panel">{children}</div>
    </div>
  );
}

function Alert({ tone, children }: { tone: "danger" | "success" | "info"; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} style={{ marginBottom: 16 }} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "danger" ? "CircleAlert" : tone === "success" ? "CircleCheck" : "Mail"} size={16} />
      <span>{children}</span>
    </div>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-group">
      <input id={id} className="input" type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} required autoFocus={autoFocus} />
      <Button iconOnly icon={show ? "EyeOff" : "Eye"} onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} />
    </div>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const loc = useLocation();
  const justReset = new URLSearchParams(loc.search).get("reset") === "1";
  const [email, setEmail] = useState<string>((loc.state as { email?: string } | null)?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok?: boolean; twoFactor?: boolean; ticket?: string }>("/auth/login", { email, password });
      if (r.twoFactor && r.ticket) {
        setTicket(r.ticket);
        return;
      }
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ recoveryCodesLeft: number | null }>("/auth/login/2fa", { ticket, code });
      if (r.recoveryCodesLeft !== null && r.recoveryCodesLeft <= 3) {
        try {
          sessionStorage.setItem("reef-recovery-warning", String(r.recoveryCodesLeft));
        } catch {
          /* ignore */
        }
      }
      await refresh();
    } catch (err: any) {
      setError(err.message);
      if (/again\.$/.test(err.message) && /password/.test(err.message)) {
        setTicket(null);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  };
  if (ticket) {
    return (
      <AuthLayout>
        <form className="login-form" onSubmit={submitCode}>
          <h1>Two-factor sign-in</h1>
          <p className="muted" style={{ marginBottom: 26 }}>
            {useRecovery ? "Enter one of the recovery codes you saved when you set up two-factor sign-in." : "Open your authenticator app and enter the 6-digit code for VodaForge."}
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={useRecovery ? "Recovery code" : "6-digit code"} htmlFor="code">
            <input
              id="code"
              className="input mono"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useRecovery ? "abcd-efgh" : "123 456"}
              style={{ fontSize: 18, letterSpacing: ".12em" }}
              required
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} style={{ marginTop: 8 }}>
            Verify and sign in
          </Button>
          <p style={{ fontSize: 13, marginTop: 18 }} className="row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setUseRecovery((v) => !v), setCode(""), setError(null))}>
              {useRecovery ? "Use my authenticator app" : "Use a recovery code"}
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTicket(null), setCode(""), setError(null))}>
              Back
            </button>
          </p>
        </form>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <form className="login-form" onSubmit={submit}>
        <h1>Welcome back</h1>
        <p className="muted" style={{ marginBottom: 26 }}>
          Sign in to manage your website.
        </p>
        {justReset && !error && <Alert tone="success">Your password was changed. Sign in with your new password.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email" htmlFor="email">
          <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!email} />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          action={
            <Link to="/forgot-password" state={{ email }} style={{ fontSize: 12.5 }}>
              Forgot password?
            </Link>
          }
        >
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus={!!email} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} style={{ marginTop: 8 }}>
          Sign in
        </Button>
        <p className="subtle" style={{ fontSize: 12.5, marginTop: 18 }}>
          First time? Your initial credentials are in <code>data/admin-credentials.txt</code> on the server.
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const loc = useLocation();
  const [email, setEmail] = useState<string>((loc.state as { email?: string } | null)?.email ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>("/auth/forgot", { email });
      setSent(r.message);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <form className="login-form" onSubmit={submit}>
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <p className="muted" style={{ marginBottom: 22 }}>
              We'll email <strong>{email}</strong> a link to choose a new password.
            </p>
            <Alert tone="info">{sent}</Alert>
            <p className="subtle" style={{ fontSize: 12.5, marginBottom: 18 }}>
              The link works once and expires after an hour. No email? Ask an administrator to reset your password from Users.
            </p>
            <Link to="/login" state={{ email }} className="btn btn-block">
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 26 }}>
              Enter the email you sign in with and we'll send you a reset link.
            </p>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Email" htmlFor="email">
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} style={{ marginTop: 8 }}>
              Send reset link
            </Button>
            <p style={{ fontSize: 13, marginTop: 18 }}>
              <Link to="/login" state={{ email }}>
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </form>
    </AuthLayout>
  );
}

export function ResetPassword() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  // The token arrives in the URL fragment (#token=…) so it never reaches server logs or Referer headers.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [state, setState] = useState<{ status: "checking" | "invalid" } | { status: "valid"; email: string }>({ status: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (window.location.hash) history.replaceState(history.state, "", window.location.pathname + window.location.search);
    if (!token) return setState({ status: "invalid" });
    let live = true;
    api
      .post<{ valid: boolean; email?: string }>("/auth/reset/check", { token })
      .then((r) => live && setState(r.valid ? { status: "valid", email: r.email ?? "" } : { status: "invalid" }))
      .catch((err) => {
        if (!live) return;
        setState({ status: "invalid" });
        setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`Choose a password with at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ email: string }>("/auth/reset", { token, password });
      await refresh(); // a reset signs the account out everywhere, including here
      navigate("/login?reset=1", { replace: true, state: { email: r.email } });
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form className="login-form" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {state.status === "checking" && <p className="muted">Checking your reset link…</p>}
        {state.status === "invalid" && (
          <>
            <p className="muted" style={{ marginBottom: 22 }}>
              This reset link has expired or was already used.
            </p>
            {error && <Alert tone="danger">{error}</Alert>}
            <Link to="/forgot-password" className="btn btn-primary btn-lg btn-block">
              Request a new link
            </Link>
            <p style={{ fontSize: 13, marginTop: 18 }}>
              <Link to="/login">Back to sign in</Link>
            </p>
          </>
        )}
        {state.status === "valid" && (
          <>
            <p className="muted" style={{ marginBottom: 26 }}>
              For <strong>{state.email}</strong>. You'll be signed out on every device.
            </p>
            {error && <Alert tone="danger">{error}</Alert>}
            <input type="email" autoComplete="username" value={state.email} readOnly hidden />
            <Field label="New password" htmlFor="new-password" help={`At least ${MIN_PASSWORD} characters.`}>
              <PasswordInput id="new-password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm-password">
              <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            </Field>
            <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} style={{ marginTop: 8 }}>
              Change password
            </Button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
