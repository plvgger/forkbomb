"use client";

import { useCallback, useEffect, useState } from "react";
import { StateBlock } from "@/app/components/Retro";
import { ApiFailure, type Created, getMe, getToken, type Me, type TokenInfo } from "../_lib/api";
import { forgetKey, loadKey, saveKey } from "../_lib/session";
import { Dashboard } from "./Dashboard";
import { KeyReveal } from "./KeyReveal";
import { Onboard } from "./Onboard";

type Phase =
  | { kind: "boot" }
  | { kind: "onboard"; notice?: string }
  | { kind: "reveal"; created: Created }
  | { kind: "dashboard"; key: string; remembered: boolean; me: Me };

/** Top of the /app client: restores a saved key, or walks through create / paste, then shows the dashboard. */
export function Dapp() {
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState(false);

  useEffect(() => {
    getToken().then(setToken, () => setTokenError(true));
    const saved = loadKey();
    if (!saved) {
      setPhase({ kind: "onboard" });
      return;
    }
    getMe(saved.key).then(
      (me) => setPhase({ kind: "dashboard", key: saved.key, remembered: saved.remembered, me }),
      (err: unknown) => {
        if (err instanceof ApiFailure && err.status === 401) {
          forgetKey();
          setPhase({ kind: "onboard", notice: "The saved key no longer matches a workspace, so it was removed from this browser." });
        } else {
          setPhase({
            kind: "onboard",
            notice: `Couldn't check your saved key: ${err instanceof Error ? err.message : "unknown error"} Paste it again to retry.`,
          });
        }
      },
    );
  }, []);

  const enter = useCallback((key: string, remember: boolean, me: Me) => {
    saveKey(key, remember);
    setPhase({ kind: "dashboard", key, remembered: remember, me });
  }, []);

  const signOut = useCallback(() => {
    forgetKey();
    setPhase({ kind: "onboard", notice: "Key removed from this browser. The workspace and its credit are untouched." });
  }, []);

  if (phase.kind === "boot") {
    return (
      <StateBlock kind="loading" glyph="…" title="Loading…">
        Checking this browser for a saved key.
      </StateBlock>
    );
  }
  if (phase.kind === "onboard") {
    return (
      <Onboard
        notice={phase.notice}
        onCreated={(created) => {
          saveKey(created.apiKey, false); // this tab only, so a reload during the reveal doesn't lose it
          setPhase({ kind: "reveal", created });
        }}
        onKey={(key, remember, me) => enter(key, remember, me)}
      />
    );
  }
  if (phase.kind === "reveal") {
    return <KeyReveal created={phase.created} onDone={(remember, me) => enter(phase.created.apiKey, remember, me)} />;
  }
  return (
    <Dashboard
      apiKey={phase.key}
      remembered={phase.remembered}
      initialMe={phase.me}
      token={token}
      tokenError={tokenError}
      onRemember={(remember) => {
        saveKey(phase.key, remember);
        setPhase({ ...phase, remembered: remember });
      }}
      onSignOut={signOut}
    />
  );
}
