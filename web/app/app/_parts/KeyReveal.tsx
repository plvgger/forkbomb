"use client";

import { useState } from "react";
import { Button } from "@/app/components/Button";
import { CopyButton } from "@/app/components/CopyButton";
import { Badge, Callout } from "@/app/components/Primitives";
import { CrtPanel } from "@/app/components/Retro";
import { type Created, getMe, type Me } from "../_lib/api";
import s from "../app.module.css";
import { RememberToggle } from "./Onboard";

/** The one time the API key is visible. The user must confirm they saved it before moving on. */
export function KeyReveal({ created, onDone }: { created: Created; onDone: (remember: boolean, me: Me) => void }) {
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function done() {
    setBusy(true);
    setError(null);
    try {
      onDone(remember, await getMe(created.apiKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the dashboard. Retry.");
      setBusy(false);
    }
  }

  return (
    <CrtPanel
      as="section"
      title="workspace created"
      status={
        <Badge tone="ok" dot>
          exit 0
        </Badge>
      }
      labelledBy="reveal-h"
    >
      <div className="stack stack-lg">
        <h2 id="reveal-h" className={s.panelTitle}>
          Save your API key now
        </h2>
        <Callout tone="warn" title="Shown once.">
          We store only a hash of this key. If you lose it, the workspace and its credit can&apos;t be recovered.
          Put it in a password manager or your shell profile before you continue.
        </Callout>

        <dl className={s.secretList}>
          <div>
            <dt>API key</dt>
            <dd>
              <code className={s.secret}>{created.apiKey}</code>
              <CopyButton text={created.apiKey} label="Copy key" />
            </dd>
          </div>
          <div>
            <dt>Workspace ID</dt>
            <dd>
              <code className={s.secret}>{created.workspace.id}</code>
              <CopyButton text={created.workspace.id} label="Copy ID" />
            </dd>
          </div>
          <div>
            <dt>Burn memo</dt>
            <dd>
              <code className={s.secret}>{created.burnMemo}</code>
              <CopyButton text={created.burnMemo} label="Copy memo" />
            </dd>
          </div>
        </dl>
        <p className={s.muted}>
          The burn memo is public and safe to share. It tells the verifier which workspace a burn credits. The app adds
          it for you when you burn from here.
        </p>

        <RememberToggle checked={remember} onChange={setRemember} />
        <label className={s.check}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>
            <strong>I saved the key somewhere safe.</strong>
          </span>
        </label>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div>
          <Button variant="primary" iconRight="arrowRight" disabled={!saved || busy} onClick={() => void done()}>
            {busy ? "Opening…" : "Open dashboard"}
          </Button>
        </div>
      </div>
    </CrtPanel>
  );
}
