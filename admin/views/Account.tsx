import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { initials } from "../lib/format";
import { Button, Field, Switch, toast } from "../components/ui";

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
    </div>
  );
}
