import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Field } from "../components/ui";
import { Icon } from "../lib/icons";

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { email, password });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-art">
        <div className="row" style={{ gap: 10 }}>
          <div className="brand-mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M3 16c3-7 6.5-10 9-10s3.5 5 9 5" />
            </svg>
          </div>
          <strong style={{ fontSize: 17 }}>Reef CMS</strong>
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
      <div className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <h1>Welcome back</h1>
          <p className="muted" style={{ marginBottom: 26 }}>
            Sign in to manage your website.
          </p>
          {error && (
            <div className="alert alert-danger" style={{ marginBottom: 16 }} role="alert">
              <Icon name="CircleAlert" size={16} />
              {error}
            </div>
          )}
          <Field label="Email" htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password" htmlFor="password">
            <div className="input-group">
              <input id="password" className="input" type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <Button iconOnly icon={show ? "EyeOff" : "Eye"} onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} />
            </div>
          </Field>
          <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} style={{ marginTop: 8 }}>
            Sign in
          </Button>
          <p className="subtle" style={{ fontSize: 12.5, marginTop: 18 }}>
            First time? Your initial credentials are in <code>data/admin-credentials.txt</code> on the server.
          </p>
        </form>
      </div>
    </div>
  );
}
