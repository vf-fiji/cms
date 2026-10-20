import { useState } from "react";
import { ALL_PERMISSIONS, type Permission, type Role, type User } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { initials, timeAgo } from "../lib/format";
import { Button, confirmDialog, ErrorState, Field, Menu, Modal, SkeletonRows, toast, useLoad } from "../components/ui";

export function Users() {
  const { user: me } = useAuth();
  const [tab, setTab] = useState<"users" | "roles">("users");
  const users = useLoad(() => api.get<User[]>("/users"));
  const roles = useLoad(() => api.get<Role[]>("/roles"));
  const [inviting, setInviting] = useState(false);
  const [editingRole, setEditingRole] = useState<Partial<Role> | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  const update = (u: User, patch: Partial<User>) => api.put(`/users/${u.id}`, { ...u, ...patch }).then(() => (toast.success("Updated"), users.reload())).catch(toast.error);
  const reset = async (u: User) => {
    if (!(await confirmDialog({ title: `Reset ${u.name}'s password?`, message: "They'll be signed out everywhere and need the new temporary password.", confirmLabel: "Reset password" }))) return;
    try {
      const r = await api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`);
      setSecret({ email: u.email, password: r.temporaryPassword });
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (u: User) => {
    if (!(await confirmDialog({ title: `Delete ${u.name}?`, message: "Their content stays; it just won't show them as the author.", confirmLabel: "Delete user", danger: true }))) return;
    api.del(`/users/${u.id}`).then(() => (toast.success("User deleted"), users.reload())).catch(toast.error);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users & roles</h1>
          <div className="page-sub">Invite your team and decide exactly what each role can do.</div>
        </div>
        {tab === "users" ? (
          <Button variant="primary" icon="Plus" onClick={() => setInviting(true)}>Add user</Button>
        ) : (
          <Button variant="primary" icon="Plus" onClick={() => setEditingRole({ name: "", description: "", permissions: [] })}>New role</Button>
        )}
      </div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}><Icon name="Users" size={14} /> Users <span className="count">{users.data?.length ?? ""}</span></button>
        <button className={`tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}><Icon name="ShieldCheck" size={14} /> Roles <span className="count">{roles.data?.length ?? ""}</span></button>
      </div>

      {tab === "users" && (
        <div className="card" style={{ overflow: "hidden" }}>
          {users.error ? (
            <ErrorState message={users.error} onRetry={users.reload} />
          ) : !users.data ? (
            <SkeletonRows />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="row" style={{ gap: 12 }}>
                        <span className="avatar">{initials(u.name)}</span>
                        <div>
                          <div className="cell-title">
                            {u.name} {u.id === me?.id && <span className="badge badge-accent no-dot">You</span>}{" "}
                            {u.twoFactorEnabled ? (
                              <span className="badge badge-success no-dot" title="Two-factor sign-in is on"><Icon name="ShieldCheck" size={11} /> 2FA</span>
                            ) : (
                              <span className="badge no-dot" title="Two-factor sign-in is off">No 2FA</span>
                            )}
                          </div>
                          <div className="subtle" style={{ fontSize: 12.5 }}>{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select className="select input-sm" style={{ width: 160 }} value={u.roleId} disabled={u.id === me?.id} onChange={(e) => update(u, { roleId: Number(e.target.value) })} aria-label="Role">
                        {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </td>
                    <td>{u.active ? <span className="badge badge-success">Active</span> : <span className="badge">Deactivated</span>}</td>
                    <td className="subtle">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}</td>
                    <td className="cell-actions">
                      {u.id !== me?.id && (
                        <Menu
                          trigger={(o) => <Button size="sm" variant="ghost" iconOnly icon="MoreHorizontal" onClick={o} aria-label="Actions" />}
                          items={[
                            { label: "Reset password", icon: "KeyRound", onClick: () => reset(u) },
                            {
                              label: "Reset two-factor sign-in",
                              icon: "ShieldCheck",
                              hidden: !u.twoFactorEnabled,
                              onClick: async () => {
                                if (!(await confirmDialog({ title: `Reset ${u.name}'s two-factor sign-in?`, message: "Use this if they lost their phone. They'll be signed out and can set it up again.", confirmLabel: "Reset 2FA", danger: true }))) return;
                                api.post(`/users/${u.id}/reset-2fa`).then(() => (toast.success("Two-factor sign-in reset"), users.reload())).catch(toast.error);
                              },
                            },
                            { label: u.active ? "Deactivate" : "Reactivate", icon: u.active ? "Lock" : "Check", onClick: () => update(u, { active: !u.active }) },
                            { separator: true },
                            { label: "Delete", icon: "Trash2", danger: true, onClick: () => remove(u) },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "roles" && (
        <div className="cards-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {roles.data?.map((r) => (
            <div key={r.id} className="card type-card" onClick={() => setEditingRole(r)}>
              <div className="row">
                <span className="list-icon" style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}><Icon name={r.name === "Administrator" ? "Shield" : "ShieldCheck"} size={16} /></span>
                <strong className="grow">{r.name}</strong>
                {r.isSystem && <span className="badge no-dot">Built-in</span>}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>{r.description}</div>
              <div className="row subtle" style={{ fontSize: 12.5 }}>
                <span>{r.permissions.length} of {ALL_PERMISSIONS.length} permissions</span>
                <span>·</span>
                <span>{r.userCount} user{r.userCount === 1 ? "" : "s"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {inviting && roles.data && (
        <InviteModal
          roles={roles.data}
          onClose={() => setInviting(false)}
          onDone={(email, password) => {
            setInviting(false);
            setSecret({ email, password });
            users.reload();
          }}
        />
      )}
      {editingRole && <RoleModal role={editingRole} onClose={() => setEditingRole(null)} onSaved={() => (setEditingRole(null), roles.reload())} />}
      {secret && (
        <Modal title="Share these sign-in details" description="This password is shown once. Send it privately; they can change it under Account after signing in." onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
          <Field label="Email"><input className="input" readOnly value={secret.email} /></Field>
          <Field label="Temporary password">
            <div className="input-group">
              <input className="input mono" readOnly value={secret.password} onFocus={(e) => e.target.select()} />
              <Button icon="Copy" onClick={() => navigator.clipboard.writeText(secret.password).then(() => toast.success("Copied"))}>Copy</Button>
            </div>
          </Field>
          <Field label="Sign-in page"><input className="input" readOnly value={`${location.origin}/admin/login`} /></Field>
        </Modal>
      )}
    </div>
  );
}

function InviteModal({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: (email: string, password: string) => void }) {
  const [form, setForm] = useState({ name: "", email: "", roleId: roles.find((r) => r.name === "Editor")?.id ?? roles[0].id });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ temporaryPassword: string }>("/users", form);
      onDone(form.email, r.temporaryPassword);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add a user" description="We'll generate a temporary password for you to share." onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Add user</Button></>}>
      <Field label="Full name" required><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Email" required><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Role" help={roles.find((r) => r.id === form.roleId)?.description}>
        <select className="select" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: Number(e.target.value) })}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

function RoleModal({ role, onClose, onSaved }: { role: Partial<Role>; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState(role);
  const [busy, setBusy] = useState(false);
  const locked = r.isSystem && r.name === "Administrator";
  const toggle = (p: Permission) => setR({ ...r, permissions: r.permissions?.includes(p) ? r.permissions.filter((x) => x !== p) : [...(r.permissions ?? []), p] });
  const save = async () => {
    setBusy(true);
    try {
      if (r.id) await api.put(`/roles/${r.id}`, r);
      else await api.post("/roles", r);
      toast.success("Role saved");
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete the ${r.name} role?`, confirmLabel: "Delete", danger: true }))) return;
    api.del(`/roles/${r.id}`).then(() => (toast.success("Role deleted"), onSaved())).catch(toast.error);
  };
  const groups = [...new Set(ALL_PERMISSIONS.map((p) => p.group))];
  return (
    <Modal
      title={r.id ? `Edit ${role.name}` : "New role"}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {r.id && !r.isSystem && <Button variant="danger" icon="Trash2" onClick={remove}>Delete role</Button>}
          <div className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>Save role</Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name"><input className="input" value={r.name ?? ""} disabled={r.isSystem} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="Description"><input className="input" value={r.description ?? ""} onChange={(e) => setR({ ...r, description: e.target.value })} /></Field>
      </div>
      {locked && <div className="alert alert-info" style={{ marginBottom: 12 }}><Icon name="Lock" size={15} /> Administrators always have every permission, so nobody gets locked out.</div>}
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 14 }}>
          <div className="section-title" style={{ marginBottom: 6 }}>{g}</div>
          <div className="col" style={{ gap: 6 }}>
            {ALL_PERMISSIONS.filter((p) => p.group === g).map((p) => (
              <label key={p.key} className="checkbox">
                <input type="checkbox" disabled={locked} checked={locked || !!r.permissions?.includes(p.key)} onChange={() => toggle(p.key)} />
                {p.label}
              </label>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}
