import type { ReactNode } from "react";
import { REPLAY_EMBED_URL, REPLAY_URL, RUN } from "../config";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { ReplayReady } from "./ReplayReady";
import { RunTree } from "./RunTree";

/**
 * Window chrome around the chromeless replay (the real recorded run).
 * 16:9 on desktop, 4:5 under 768px. The tree scales itself to fit the frame.
 * A server-rendered end state sits underneath: it is what you see without JS,
 * and until the replay reports that it is ready.
 */
export function ReplayFrame({
  title = `hydra replay · run ${RUN.id}`,
  status,
  src = REPLAY_EMBED_URL,
  eager = false,
  className,
}: {
  title?: string;
  status?: ReactNode;
  src?: string;
  /** Load immediately. Default lazy. */
  eager?: boolean;
  className?: string;
}) {
  return (
    <figure className={cx("replay-frame", className)}>
      <figcaption className="replay-frame__bar">
        <span className="terminal__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="replay-frame__title">{title}</span>
        <span className="replay-frame__actions">
          {status}
          <a className="copy-btn" href={REPLAY_URL} target="_blank" rel="noopener">
            <span>Open full replay</span>
            <Icon name="arrowUpRight" />
          </a>
        </span>
      </figcaption>
      <div className="replay-frame__viewport">
        <div className="replay-frame__poster">
          <RunTree />
        </div>
        <iframe
          src={src}
          title="Replay of a real Hydra run: four heads race, one survives"
          loading={eager ? "eager" : "lazy"}
          referrerPolicy="no-referrer"
        />
      </div>
      <ReplayReady />
    </figure>
  );
}
