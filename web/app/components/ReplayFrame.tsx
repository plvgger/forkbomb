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
  title = `forkbomb replay · run ${RUN.id}`,
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
          title="Replay of a real Forkbomb run: four forks race, three are killed, one exits 0"
          loading={eager ? "eager" : "lazy"}
          referrerPolicy="no-referrer"
          // Embed mode hides everything focusable inside, so the frame would be an invisible Tab stop.
          // "Open full replay" above is the keyboard way in.
          tabIndex={src === REPLAY_EMBED_URL ? -1 : undefined}
        />
      </div>
      <ReplayReady />
    </figure>
  );
}
