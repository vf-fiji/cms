import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { Button, Field, toast } from "./ui";

/** Shows recovery codes once, with copy and download. */
export function RecoveryCodes({ codes, onDone, doneLabel = "I've saved these codes" }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const text = codes.join("\n");
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`Reef CMS recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    a.download = "reef-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="alert alert-warn">
        <Icon name="KeyRound" size={16} />
        <span>Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They won't be shown again.</span>
      </div>
      <div className="recovery-grid mono">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="row row-wrap">
        <Button icon="Copy" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Codes copied"))}>Copy</Button>
        <Button icon="Download" onClick={download}>Download</Button>
        <div className="spacer" />
        <Button variant="primary" icon="Check" onClick={onDone}>{doneLabel}</Button>
      </div>
    </div>
  );
}

/** QR code → confirm code → recovery codes. */
export function TwoFactorSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => {
    api.post<{ secret: string; qr: string; otpauthUrl: string }>("/auth/2fa/setup").then(setSetup).catch((e) => setError(e.message));
  }, []);
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code });
      setCodes(r.recoveryCodes);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  return (
    <form onSubmit={confirm} className="col" style={{ gap: 16 }}>
      <ol className="twofa-steps">
        <li>Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password.</li>
        <li>Scan this QR code, or type the key into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="twofa-qr">
        {setup ? <img src={setup.qr} alt="QR code to add Reef to your authenticator app" width={180} height={180} /> : <div className="skeleton" style={{ width: 180, height: 180 }} />}
        <div className="col" style={{ gap: 6, minWidth: 0 }}>
          <span className="subtle" style={{ fontSize: 12.5 }}>Can't scan? Enter this key:</span>
          <code className="mono twofa-key">{setup?.secret.replace(/(.{4})/g, "$1 ").trim() ?? "…"}</code>
        </div>
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          <Icon name="CircleAlert" size={16} />
          <span>{error}</span>
        </div>
      )}
      <Field label="6-digit code" htmlFor="twofa-code">
        <input id="twofa-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} placeholder="123 456" style={{ fontSize: 18, letterSpacing: ".12em", maxWidth: 200 }} autoFocus />
      </Field>
      <div className="row">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <div className="spacer" />
        <Button type="submit" variant="primary" loading={busy} disabled={code.replace(/\s/g, "").length !== 6 || !setup}>Turn on two-factor sign-in</Button>
      </div>
    </form>
  );
}

/** Full-screen gate shown when Settings require two-factor sign-in. */
export function TwoFactorRequired({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  return (
    <div className="center-fill" style={{ minHeight: "100vh", padding: 20 }}>
      <div className="card card-pad" style={{ maxWidth: 560, width: "100%" }}>
        <div className="row" style={{ gap: 12, marginBottom: 16 }}>
          <span className="empty-icon" style={{ margin: 0, width: 44, height: 44 }}>
            <Icon name="ShieldCheck" size={20} />
          </span>
          <div>
            <h1 className="page-title" style={{ fontSize: 22 }}>Set up two-factor sign-in</h1>
            <div className="page-sub">Your administrator requires it for everyone. It takes about a minute.</div>
          </div>
        </div>
        <TwoFactorSetup onDone={onDone} />
        <div style={{ marginTop: 18, textAlign: "center" }}>
          <button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
