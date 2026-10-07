import { RUN } from "../config";
import { cx } from "./cx";

/**
 * The recorded run's end state as plain, server-rendered HTML: pid 1 (the parent repo copy),
 * three killed forks and the one that exited 0. Same card language as the replay UI. Needs no JS.
 */
export function RunTree({ compact = false, className }: { compact?: boolean; className?: string }) {
  const base = RUN.baseline;
  const basePct = `${((100 * base.passing) / base.total).toFixed(1)}%`;
  return (
    <ol
      className={cx("run-tree", compact && "run-tree--compact", className)}
      aria-label={`End state of run ${RUN.id}: ${RUN.killed} forks killed, fork ${RUN.winner.id} exited 0 with ${RUN.winner.passed} of ${RUN.winner.total} tests passing`}
    >
      <li className="run-tree__item run-tree__item--body">
        <div className="run-tree__card">
          <span className="run-tree__id">PID 1</span>
          <span className="run-tree__name">{RUN.repo}</span>
          <span className="run-tree__chip">PARENT</span>
          {!compact && (
            <span className="run-tree__foot">
              <span className="run-tree__note">baseline</span>
              <span className="run-tree__bar" aria-hidden="true">
                <i style={{ ["--pct" as string]: basePct }} />
              </span>
              <span className="run-tree__score">
                {base.passing}/{base.total}
              </span>
            </span>
          )}
        </div>
      </li>
      {RUN.forks.map((f) => {
        const won = f.id === RUN.winner.id;
        return (
          <li key={f.id} className={cx("run-tree__item run-tree__item--fork", won ? "run-tree__item--won" : "run-tree__item--cut")}>
            <div className="run-tree__card">
              <span className="run-tree__id">{f.id}</span>
              <span className="run-tree__name">{f.strategy}</span>
              <span className="run-tree__chip">{won ? "EXIT 0" : "KILLED"}</span>
              {!compact && (
                <span className="run-tree__foot">
                  <span className="run-tree__note">
                    {won
                      ? `${RUN.patch.lines} lines in ${RUN.patch.files} file`
                      : `SIGKILL · ${RUN.winner.id} passed first`}
                  </span>
                  {won && (
                    <>
                      <span className="run-tree__bar" aria-hidden="true">
                        <i style={{ ["--pct" as string]: "100%" }} />
                      </span>
                      <span className="run-tree__score">
                        {RUN.winner.passed}/{RUN.winner.total}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
