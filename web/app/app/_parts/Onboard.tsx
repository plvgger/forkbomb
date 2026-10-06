"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/app/components/Button";
import { Callout } from "@/app/components/Primitives";
import { CrtPanel } from "@/app/components/Retro";
import { ApiFailure, type Created, createWorkspace, getMe, looksLikeKey, type Me } from "../_lib/api";
import s from "../app.module.css";

export function Onboard({
  notice,
  onCreated,
  onKey,
}: {
  notice?: string;
  onCreated: (created: Created) => void;
  onKey: (key: string, remember: boolean, me: Me) => void;
}) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(false);
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      onCreated(await createWorkspace(label.trim()));
    } catch (err) {
      setCreateError(
        err instanceof ApiFailure && err.code === "rate_limited"
          ? `Too many workspaces from this network. ${err.message}`
          : err instanceof Error
            ? err.message
            : "Couldn't create the workspace.",
      );
      setCreating(false);
    }
  }

  async function useKey(e: FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!looksLikeKey(k)) {
      setKeyError("That doesn't look like an API key. Keys look like forkbomb_sk_ followed by 32 letters and digits.");
      return;
    }
    setChecking(true);
    setKeyError(null);
    try {
      onKey(k, remember, await getMe(k));
    } catch (err) {
      setKeyError(
        err instanceof ApiFailure && err.status === 401
          ? "That key doesn't match any workspace. Check for a missing character."
          : err instanceof Error
            ? err.message
            : "Couldn't check the key.",
      );
      setChecking(false);
    }
  }

  return (
    <div className="stack stack-lg">
      {notice && <Callout tone="warn">{notice}</Callout>}
      <div className={s.split}>
        <CrtPanel as="section" title="new workspace" labelledBy="create-h">
          <form className="stack" onSubmit={create}>
            <h2 id="create-h" className={s.panelTitle}>
              Create a workspace
            </h2>
            <p className={s.muted}>
              You get a workspace ID and an API key. The key is shown once. We keep only a hash of it, so nobody can
              show it to you again.
            </p>
            <label className={s.field}>
              <span className={s.fieldLabel}>Label (optional)</span>
              <input
                className={s.input}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
                placeholder="e.g. work laptop"
                autoComplete="off"
              />
            </label>
            {createError && (
              <p className={s.error} role="alert">
                {createError}
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" icon="key" disabled={creating}>
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </div>
          </form>
        </CrtPanel>

        <CrtPanel as="section" title="existing workspace" labelledBy="key-h">
          <form className="stack" onSubmit={useKey}>
            <h2 id="key-h" className={s.panelTitle}>
              Use an existing key
            </h2>
            <p className={s.muted}>Paste the API key you saved. It is sent only to this site, as a Bearer header.</p>
            <label className={s.field}>
              <span className={s.fieldLabel}>API key</span>
              <span className={s.inputRow}>
                <input
                  className={s.input}
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="forkbomb_sk_…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="ghost" size="sm" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                  {showKey ? "Hide" : "Show"}
                </Button>
              </span>
            </label>
            <RememberToggle checked={remember} onChange={setRemember} />
            {keyError && (
              <p className={s.error} role="alert">
                {keyError}
              </p>
            )}
            <div>
              <Button type="submit" variant="outline" iconRight="arrowRight" disabled={checking || !key.trim()}>
                {checking ? "Checking…" : "Open dashboard"}
              </Button>
            </div>
          </form>
        </CrtPanel>
      </div>
    </div>
  );
}

export function RememberToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Remember on this device.</strong>{" "}
        <span className={s.muted}>
          Saves the key in this browser&apos;s local storage until you remove it. Anyone with access to this browser
          profile can read it. Off: the key is forgotten when this tab closes.
        </span>
      </span>
    </label>
  );
}
