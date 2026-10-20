import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { initials } from "../lib/format";
import { Button, Field, Modal, promptDialog, Switch, toast } from "../components/ui";
import { Icon } from "../lib/icons";
import { RecoveryCodes, TwoFactorSetup } from "../components/TwoFactor";

export function Account() {
  const { user, refresh } = useAuth();
  const { theme, toggle } = useTheme();
  const [name, setName] = useState(user?.name ?? "");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState("");
  const saveProfile = async () => {
    setBusy("profile");
    try {
      await api.put("/auth/profile", { name });
      await refresh();
      toast.success("Profile updated");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  const changePw = async () => {
    if (pw.next !== pw.confirm) return toast.error("The new passwords don't match.");
    setBusy("pw");
    try {
      await api.post("/auth/password", { current: pw.current, next: pw.next });
      setPw({ current: "", next: "", confirm: "" });
      toast.success("Password changed");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar" style={{ width: 52, height: 52, fontSize: 18 }}>{initials(user?.name ?? "?")}</span>
          <div>
            <h1 className="page-title">{user?.name}</h1>
            <div className="page-sub">{user?.email} · {user?.roleName}</div>
          </div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><div className="card-title">Profile</div></div>
        <div className="card-body">
          <Field label="Display name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Appearance"><Switch checked={theme === "dark"} onChange={toggle} label="Dark mode" /></Field>
        </div>
        <div className="card-footer"><Button variant="primary" loading={busy === "profile"} disabled={name === user?.name} onClick={saveProfile}>Save profile</Button></div>
      </div>
      <div className="card">
        <div className="card-header"><div className="card-title">Change password</div></div>
        <div className="card-body">
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="New password" help="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          </div>
        </div>
        <div className="card-footer"><Button variant="primary" loading={busy === "pw"} disabled={!pw.current || pw.next.length < 10} onClick={changePw}>Update password</Button></div>
      </div>
      <TwoFactorCard />
    </div>
  );
}

function TwoFactorCard() {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number; required: boolean } | null>(null);
  const [setting, setSetting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const load = () => api.get<{ enabled: boolean; recoveryCodesLeft: number; required: boolean }>("/auth/2fa/status").then(setStatus).catch(toast.error);
  useEffect(() => {
    load();
  }, []);
  const withPassword = async (title: string, confirmLabel: string) =>
    promptDialog({ title, label: "Your password", confirmLabel, message: "Confirm it's you before changing two-factor sign-in.", placeholder: "Password", inputType: "password" });
  const disable = async () => {
    const password = await withPassword("Turn off two-factor sign-in?", "Turn off");
    if (!password) return;
    try {
      await api.post("/auth/2fa/disable", { password });
      toast.success("Two-factor sign-in is off");
      await refresh();
      load();
    } catch (e) {
      toast.error(e);
    }
  };
  const regenerate = async () => {
    const password = await withPassword("Make new recovery codes?", "Make new codes");
    if (!password) return;
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password });
      setCodes(r.recoveryCodes);
      load();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <div className="card-title row" style={{ gap: 8 }}><Icon name="ShieldCheck" size={16} /> Two-factor sign-in</div>
        {status && (status.enabled ? <span className="badge badge-success">On</span> : <span className="badge">Off</span>)}
      </div>
      <div className="card-body">
        {!status ? (
          <div className="skeleton" style={{ height: 40 }} />
        ) : status.enabled ? (
          <div className="col" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>
              Signing in needs your password and a code from your authenticator app. You have <strong>{status.recoveryCodesLeft}</strong> recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
            </p>
            <div className="row row-wrap">
              <Button icon="KeyRound" onClick={regenerate}>Make new recovery codes</Button>
              {!status.required && <Button variant="danger" onClick={disable}>Turn off</Button>}
            </div>
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>Protect your account with a code from your phone as well as your password. Even if someone learns your password, they can't sign in.</p>
            <div><Button variant="primary" icon="ShieldCheck" onClick={() => setSetting(true)}>Set up two-factor sign-in</Button></div>
          </div>
        )}
      </div>
      {setting && (
        <Modal title="Set up two-factor sign-in" onClose={() => setSetting(false)} size="lg">
          <TwoFactorSetup
            onCancel={() => setSetting(false)}
            onDone={async () => {
              setSetting(false);
              toast.success("Two-factor sign-in is on");
              await refresh();
              load();
            }}
          />
        </Modal>
      )}
      {codes && (
        <Modal title="Your new recovery codes" description="Your old codes no longer work." onClose={() => setCodes(null)}>
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        </Modal>
      )}
    </div>
  );
}
