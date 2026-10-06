import type { ReactNode } from "react";
import { Icon } from "@/app/components";
import s from "../security.module.css";

/** Set flags, paths and file names in inline mono so they never break mid-token. */
const TOKEN_RE = /(--[a-z][a-z-]*|~\/[\w.<>/-]*|\.git\b|127\.0\.0\.1|events\.jsonl|forkbomb export|forkbomb_sk_|CLAUDE\.md|\.claude\/settings\.json)/g;
export function Fx({ text }: { text: string }) {
  const parts = text.split(TOKEN_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className={s.tok}>
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

/* ---------- Trust boundary ---------- */

function Node({ title, children, mono }: { title: string; children?: ReactNode; mono?: boolean }) {
  return (
    <li className={s.node}>
      <span className={mono ? `${s.nodeTitle} mono` : s.nodeTitle}>{title}</span>
      {children && <span className={s.nodeBody}>{children}</span>}
    </li>
  );
}

export function TrustBoundary() {
  return (
    <figure className={s.boundary} aria-labelledby="boundary-cap">
      <div className={`${s.zone} ${s.zoneHead}`}>
        <p className={s.zoneLabel}>
          <span className={s.zoneKey} aria-hidden="true" />
          Untrusted · inside the sandbox
        </p>
        <ul className={s.nodes}>
          <Node title="Model output">Any instruction it decides to follow.</Node>
          <Node title="Repo content">README, comments, fixtures, issue text, dependency output. Any of it can steer the model.</Node>
          <Node title="Fork" mono>
            bash + editor, working in its own APFS clone
          </Node>
        </ul>
      </div>

      <div className={`${s.conn} ${s.connPatch}`} aria-hidden="true">
        <span className={s.connLine} />
        <span className={s.connGlyph}>
          <Icon name="arrowRight" size={14} />
        </span>
        <span className={s.connLabel}>patch only</span>
      </div>

      <div className={`${s.zone} ${s.zoneForkbomb}`}>
        <p className={s.zoneLabel}>
          <span className={s.zoneKey} aria-hidden="true" />
          Trusted · Forkbomb process
        </p>
        <ul className={s.nodes}>
          <Node title="Orchestrator">Calls fork(), kills the losers, records every event.</Node>
          <Node title="Judge">Applies the patch to a fresh clone and runs your tests there, sandboxed.</Node>
          <Node title="Live UI">Served on 127.0.0.1 only.</Node>
        </ul>
      </div>

      <div className={`${s.conn} ${s.connDeny}`} aria-hidden="true">
        <span className={s.connLine} />
        <span className={s.connGlyph}>
          <Icon name="close" size={12} />
        </span>
        <span className={s.connLabel}>denied</span>
      </div>

      <div className={`${s.zone} ${s.zoneOff}`}>
        <p className={s.zoneLabel}>
          <span className={s.zoneKey} aria-hidden="true" />
          Off limits to forks
        </p>
        <ul className={s.nodes}>
          <Node title="Credentials" mono>
            ~/.ssh ~/.aws ~/.gnupg ~/.config Keychains
          </Node>
          <Node title="Your keys">No API keys or tokens in the fork&apos;s environment.</Node>
          <Node title="The network">Loopback only. No DNS resolver.</Node>
          <Node title="History" mono>
            .git is read-only
          </Node>
        </ul>
      </div>

      <figcaption id="boundary-cap" className={s.figcap}>
        Trust boundary. The only thing that crosses from a fork to Forkbomb is its patch, as text. Everything marked
        off limits is denied by the sandbox, not by asking the model nicely.
      </figcaption>
    </figure>
  );
}

/* ---------- Layer stack (nested walls around a clone) ---------- */

export type Layer = { name: string; detail: ReactNode };

export function LayerStack({
  engine,
  flag,
  summary,
  layers,
  core,
  gate,
}: {
  engine: string;
  flag: string;
  summary: ReactNode;
  layers: Layer[];
  core: string;
  gate?: ReactNode;
}) {
  const nest = (i: number): ReactNode => {
    if (i >= layers.length) {
      return (
        <div className={s.core}>
          <Icon name="fork" size={14} />
          <span className="mono">{core}</span>
        </div>
      );
    }
    const l = layers[i];
    return (
      <div className={s.layer} data-depth={i}>
        <div className={s.layerHead}>
          <span className={s.layerIdx} aria-hidden="true">
            L{i + 1}
          </span>
          <span className={s.layerName}>{l.name}</span>
        </div>
        <p className={s.layerDetail}>{typeof l.detail === "string" ? <Fx text={l.detail} /> : l.detail}</p>
        {nest(i + 1)}
      </div>
    );
  };

  return (
    <article className={s.stack}>
      <header className={s.stackHead}>
        <div>
          <h3 className={s.stackTitle}>{engine}</h3>
          <p className={s.stackSummary}>{summary}</p>
        </div>
        <code className={s.flag}>{flag}</code>
      </header>
      <div className={s.stackBody} role="group" aria-label={`${engine}: isolation layers, outermost first`}>
        {nest(0)}
      </div>
      {gate && <footer className={s.stackFoot}>{gate}</footer>}
    </article>
  );
}

/* ---------- Judge pipeline ---------- */

export type Step = { name: string; body: ReactNode; tone?: "warn" | "accent" };

export function Pipeline({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className={s.pipe} aria-label={label}>
      {steps.map((st, i) => (
        <li key={st.name} className={s.pipeStep} data-tone={st.tone}>
          <div className={s.pipeHead}>
            <span className={s.pipeNum} aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className={s.pipeName}>{st.name}</span>
          </div>
          <p className={s.pipeBody}>{typeof st.body === "string" ? <Fx text={st.body} /> : st.body}</p>
        </li>
      ))}
    </ol>
  );
}
