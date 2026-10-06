import { RUN, RUN_END_S, RUN_PS } from "../config";
import { cx } from "./cx";
import { PsAnimator } from "./PsAnimator";

/**
 * The recorded run (2026-10-05) as a `ps` listing. Every value comes from the run's event log.
 * Server-rendered end state; with JS it starts in a "running" phase and resolves when
 * scrolled into view (skipped under reduced motion).
 * "pid 1" is the parent (the original repo copy); forks keep their real IDs (1.01 … 1.04).
 */
export function PsTable({ animate = true, className }: { animate?: boolean; className?: string }) {
  const killed = RUN_PS.filter((p) => p.result === "killed").length;
  return (
    <div className={cx("scroll-x", className)}>
      <table
        className="ps"
        data-phase={animate ? undefined : "done"}
        aria-label={`Process list for run ${RUN.id}: ${RUN_PS.length} forks of pid 1, ${killed} killed, ${RUN.winner.id} exited 0 with ${RUN.winner.passed} of ${RUN.winner.total} tests passing`}
      >
        <caption className="sr-only">
          Recorded run {RUN.id} on {RUN.date}. All forks ended at {RUN_END_S} s.
        </caption>
        <thead>
          <tr>
            <th scope="col">PID</th>
            <th scope="col">PPID</th>
            <th scope="col">CMD</th>
            <th scope="col" className="num">FORK</th>
            <th scope="col" className="num">TURNS</th>
            <th scope="col" className="num">TESTS</th>
            <th scope="col">STAT</th>
          </tr>
        </thead>
        <tbody>
          <tr className="ps__row--parent">
            <td className="ps__id">1</td>
            <td>-</td>
            <td>{RUN.repo}</td>
            <td className="num">-</td>
            <td className="num">-</td>
            <td className="num">
              {RUN.baseline.passing}/{RUN.baseline.total}
            </td>
            <td>
              <span className="ps__stat">parent</span>
            </td>
          </tr>
          {RUN_PS.map((p) => {
            const won = p.result === "exit0";
            return (
              <tr key={p.id} className={won ? "ps__row--exit0" : "ps__row--killed"}>
                <td className="ps__id">{p.id}</td>
                <td>1</td>
                <td>{p.strategy}</td>
                <td className="num">{p.forkMs.toFixed(2)} ms</td>
                <td className="num">{p.turns}</td>
                <td className="num">
                  {won ? (
                    <>
                      <span className="ps__live">…</span>
                      <span className="ps__final">
                        {RUN.winner.passed}/{RUN.winner.total}
                      </span>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td>
                  <span className="ps__stat">
                    <span className="ps__live">R+ running</span>
                    <span className="ps__final">{won ? "exit 0" : "SIGKILL"}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {animate && <PsAnimator />}
    </div>
  );
}
