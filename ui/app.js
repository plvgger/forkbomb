// Forkbomb process tree. One code path for live runs (SSE) and recorded runs (replay).
// Event types and fields keep their pre-rename names (head, sever, winner, "body") so
// old runs still replay; only the words on screen changed: fork, killed, exit 0, pid 1.
(() => {
  "use strict";

  const CARD_W = 248;
  const CARD_H = 104;
  const COL_GAP = 96;
  const ROW_GAP = 14;
  const PAD = 28;
  const MAX_LOG = 500;

  const $ = (id) => document.getElementById(id);
  const tree = $("tree");
  const wires = $("wires");
  const SVG = "http://www.w3.org/2000/svg";

  let S;
  function reset() {
    S = { nodes: new Map(), cols: [[]], t: 0, lastWall: performance.now(), running: false, cost: 0, events: 0, winner: null };
    for (const el of [...tree.querySelectorAll(".card")]) el.remove();
    wires.innerHTML = "";
    $("log").innerHTML = "";
    $("winnerPanel").hidden = true;
    for (const id of ["tFork", "tLogical", "tPhysical", "tSandbox"]) $(id).textContent = "—";
    $("tFork").classList.remove("hot");
    $("tPhysical").classList.remove("hot");
    setStatus("WAITING", "idle");
    $("elapsed").textContent = "0.0s";
    $("cost").textContent = "$0.00";
    $("evCount").textContent = "";
  }

  // ---------- formatting ----------
  function fmtBytes(n) {
    if (n == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = Math.abs(n), i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
  }
  function fmtMs(ms) {
    if (ms < 1) return `${ms.toFixed(2)} ms`;
    if (ms < 100) return `${ms.toFixed(1)} ms`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }
  function fmtT(ms) {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  const short = (s) => String(s || "").replaceAll("/workspace/", "");
  const pid = (id) => (id === "body" ? "pid 1" : id);

  function setStatus(text, cls) {
    const el = $("status");
    el.textContent = text;
    el.className = `pill ${cls}`;
  }

  // ---------- log ----------
  function log(t, head, msg, cls = "") {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    li.innerHTML = `<span class="t">${fmtT(t)}</span><span class="h">${esc(head || "")}</span><span class="m" title="${esc(msg)}">${esc(msg)}</span>`;
    const ol = $("log");
    const stick = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 30;
    ol.appendChild(li);
    while (ol.children.length > MAX_LOG) ol.firstChild.remove();
    if (stick) ol.scrollTop = ol.scrollHeight;
  }

  // ---------- nodes ----------
  function makeNode(id, col, parent, opts = {}) {
    const el = document.createElement("div");
    el.className = `card ${opts.body ? "body" : "running"}`;
    el.innerHTML = `
      <div class="row"><span class="id">${esc(opts.body ? "PID 1" : id)}</span><span class="strat"></span><span class="chip">${opts.body ? "SOURCE" : "FORKED"}</span></div>
      <div class="tick"></div>
      <div class="foot"><span class="turns"></span><span class="bar"><i></i></span><span class="score"></span></div>`;
    el.style.animationDelay = `${(opts.stagger || 0) * 35}ms`;
    tree.appendChild(el);
    let wire = null;
    if (parent) {
      wire = document.createElementNS(SVG, "path");
      wire.setAttribute("class", "wire live");
      wire.style.animationDelay = `${(opts.stagger || 0) * 35}ms`;
      wires.appendChild(wire);
    }
    const node = { id, col, parent, el, wire, cut: null, status: opts.body ? "body" : "running", tools: 0, turns: 0 };
    S.nodes.set(id, node);
    (S.cols[col] ||= []).push(id);
    return node;
  }

  const q = (node, sel) => node.el.querySelector(sel);
  function setChip(node, text) { q(node, ".chip").textContent = text; }
  function setTick(node, text, note = false) {
    const t = q(node, ".tick");
    t.textContent = text;
    t.title = text;
    t.classList.toggle("note", note);
    t.classList.remove("flash");
    void t.offsetWidth;
    t.classList.add("flash");
  }
  function setState(node, status) {
    node.status = status;
    node.el.classList.remove("running", "judging", "passed", "failed", "severed", "won");
    node.el.classList.add(status);
    if (node.wire) {
      node.wire.classList.remove("live", "judging", "dead", "done", "won");
      node.wire.classList.add({ running: "live", judging: "judging", severed: "dead", won: "won" }[status] || "done");
    }
  }

  function layout() {
    const cols = S.cols.filter((c) => c && c.length);
    const heights = cols.map((c) => c.length * CARD_H + (c.length - 1) * ROW_GAP);
    const H = Math.max(...heights, CARD_H);
    cols.forEach((ids, ci) => {
      const y0 = PAD + (H - heights[ci]) / 2;
      ids.forEach((id, ri) => {
        const n = S.nodes.get(id);
        n.x = PAD + ci * (CARD_W + COL_GAP);
        n.y = y0 + ri * (CARD_H + ROW_GAP);
        n.el.style.left = `${n.x}px`;
        n.el.style.top = `${n.y}px`;
      });
    });
    const W = PAD * 2 + cols.length * CARD_W + (cols.length - 1) * COL_GAP;
    tree.style.width = `${W}px`;
    tree.style.height = `${H + PAD * 2}px`;
    wires.setAttribute("viewBox", `0 0 ${W} ${H + PAD * 2}`);
    for (const n of S.nodes.values()) {
      if (!n.wire) continue;
      const p = S.nodes.get(n.parent);
      if (!p) continue;
      const x1 = p.x + CARD_W, y1 = p.y + CARD_H / 2, x2 = n.x, y2 = n.y + CARD_H / 2;
      const dx = (x2 - x1) * 0.5;
      n.wire.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      n.wire.style.setProperty("--len", String(Math.ceil(n.wire.getTotalLength())));
      if (n.cut) placeCut(n);
    }
  }

  function placeCut(n) {
    const len = n.wire.getTotalLength();
    const pt = n.wire.getPointAtLength(len * 0.55);
    n.cut.setAttribute("d", `M${pt.x - 6},${pt.y - 6} L${pt.x + 6},${pt.y + 6} M${pt.x + 6},${pt.y - 6} L${pt.x - 6},${pt.y + 6}`);
  }

  function sever(n) {
    setState(n, "severed");
    setChip(n, "KILLED");
    if (n.wire && !n.cut) {
      n.cut = document.createElementNS(SVG, "path");
      n.cut.setAttribute("class", "cut");
      wires.appendChild(n.cut);
      placeCut(n);
    }
  }

  // ---------- diff ----------
  function renderDiff(patch) {
    const out = [];
    for (const line of String(patch || "").split("\n").slice(0, 600)) {
      let cls = "";
      if (line.startsWith("diff --git")) cls = "file";
      else if (line.startsWith("@@")) cls = "hunk";
      else if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
      out.push(cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line));
    }
    return out.join("\n");
  }

  // ---------- events ----------
  function apply(e) {
    S.t = e.t;
    S.lastWall = performance.now();
    S.events++;
    $("evCount").textContent = `${S.events}`;
    const n = e.head ? S.nodes.get(e.head) : null;

    switch (e.type) {
      case "run_start": {
        S.running = true;
        setStatus("LIVE", "live");
        $("task").textContent = e.task;
        $("testCmd").textContent = e.testCmd;
        $("model").textContent = `${e.model} · ${e.effort} · ${e.mode}`;
        S.subscription = e.engine === "claude-code";
        if (S.subscription) {
          $("cost").textContent = "subscription";
          $("cost").title = "Forks run through Claude Code on your Claude plan, so there's no per-token bill.";
        }
        $("tSandbox").textContent = e.sandbox ? "Seatbelt" : "off";
        $("tSandboxS").textContent = e.sandbox ? (e.network ? "writes confined · network on" : "writes confined · network off") : "no sandbox";
        const b = makeNode("body", 0, null, { body: true });
        q(b, ".strat").textContent = e.repo.split("/").slice(-2).join("/");
        setTick(b, "the original repository");
        layout();
        log(e.t, "", `run ${e.runId}: ${e.heads} forks × ${e.rounds} round${e.rounds > 1 ? "s" : ""}`);
        break;
      }
      case "baseline": {
        const total = e.passed != null && e.failed != null ? e.passed + e.failed : null;
        $("baseline").textContent = total != null ? `baseline ${e.passed}/${total} passing` : `baseline exit ${e.exitCode}`;
        const b = S.nodes.get("body");
        if (b && total) {
          q(b, ".bar i").style.width = `${(100 * e.passed) / total}%`;
          q(b, ".score").textContent = `${e.passed}/${total}`;
        }
        log(e.t, pid("body"), total != null ? `baseline: ${e.passed} passing, ${e.failed} failing` : `baseline exit ${e.exitCode}`, "warn");
        break;
      }
      case "fork": {
        e.heads.forEach((id, i) => makeNode(id, e.round, e.parent, { stagger: i }));
        layout();
        const avg = e.msEach.reduce((a, b) => a + b, 0) / Math.max(1, e.msEach.length);
        $("tFork").textContent = fmtMs(avg);
        $("tFork").classList.add("hot");
        $("tForkS").textContent = `per fork · ${e.heads.length} forks · ${e.forker}`;
        $("tLogical").textContent = fmtBytes(e.logicalBytes);
        $("tLogicalS").textContent = `${e.heads.length} × ${fmtBytes(e.workspaceBytes)}`;
        $("tPhysical").textContent = fmtBytes(e.physicalBytes);
        $("tPhysical").classList.add("hot");
        log(e.t, pid(e.parent), `forked ${e.heads.length} copies in ${fmtMs(avg)} each`, "good");
        const twrap = $("treeWrap");
        twrap.scrollTo({ left: twrap.scrollWidth, behavior: "smooth" });
        break;
      }
      case "head_start":
        if (!n) break;
        q(n, ".strat").textContent = e.strategy;
        q(n, ".strat").title = e.brief;
        setChip(n, "RUNNING");
        setTick(n, e.brief, true);
        break;
      case "tool":
        if (!n) break;
        n.tools++;
        setTick(n, e.tool === "bash" ? `$ ${e.summary}` : `✎ ${short(e.summary)}`);
        q(n, ".turns").textContent = `${n.tools} calls`;
        log(e.t, e.head, e.tool === "bash" ? `$ ${e.summary}` : short(e.summary), e.ok ? "" : "warn");
        break;
      case "note":
        if (!n || n.status !== "running") break;
        setTick(n, e.text, true);
        break;
      case "head_done":
        if (!n) break;
        if (e.costUsd != null && !S.subscription) {
          S.cost += e.costUsd;
          $("cost").textContent = `$${S.cost.toFixed(2)}`;
        }
        q(n, ".turns").textContent = `${e.turns} turns`;
        if (e.reason === "severed") break;
        if (e.reason !== "end_turn") setChip(n, { max_turns: "OUT OF TURNS", timeout: "TIMED OUT", refusal: "REFUSED", error: "ERROR" }[e.reason] || e.reason);
        if (e.reason === "error") log(e.t, e.head, `error: ${e.error || ""}`, "bad");
        else log(e.t, e.head, `finished (${e.reason.replace("_", " ")}) after ${e.turns} turns`);
        break;
      case "judging":
        if (!n) break;
        setState(n, "judging");
        setChip(n, "JUDGING");
        setTick(n, "running the test suite…", true);
        break;
      case "judge": {
        if (!n) break;
        const total = e.passed != null && e.failed != null ? e.passed + e.failed : null;
        const pass = e.score === 1;
        setState(n, pass ? "passed" : "failed");
        setChip(n, pass ? "PASSED" : "FAILED");
        q(n, ".bar i").style.width = `${Math.round(e.score * 100)}%`;
        q(n, ".score").textContent = total != null ? `${e.passed}/${total}` : `${Math.round(e.score * 100)}%`;
        setTick(n, e.tampered.length ? `tests edited, reverted: ${e.tampered.join(", ")}` : `${e.diffLines} lines in ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}`);
        if (e.tampered.length) q(n, ".tick").classList.add("tamper");
        log(e.t, e.head, `${total != null ? `${e.passed}/${total} passing` : `score ${Math.round(e.score * 100)}%`} · ${e.diffLines} lines${e.tampered.length ? " · test edits reverted" : ""}`, pass ? "good" : "warn");
        break;
      }
      case "sever":
        if (!n) break;
        sever(n);
        setTick(n, e.why, true);
        log(e.t, e.head, `killed: ${e.why}`, "bad");
        break;
      case "round_end": {
        const best = e.best && S.nodes.get(e.best);
        if (best && e.bestScore < 1) best.el.classList.add("best");
        log(e.t, "", `round ${e.round} over · best ${e.best || "none"} at ${Math.round(e.bestScore * 100)}%`);
        break;
      }
      case "winner": {
        if (!n) break;
        S.winner = e.head;
        setState(n, "won");
        setChip(n, "EXIT 0");
        for (const other of S.nodes.values()) {
          if (other.id !== e.head && other.status === "running") sever(other);
        }
        $("winnerPanel").hidden = false;
        $("winnerId").textContent = `${e.head} · ${e.diffLines} lines`;
        $("winnerSummary").textContent = e.summary || "";
        $("diff").innerHTML = renderDiff(e.patch);
        log(e.t, e.head, `exit 0 · ${e.diffLines} lines in ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}`, "good");
        break;
      }
      case "run_end":
        S.running = false;
        $("elapsed").textContent = fmtT(e.ms);
        if (e.costUsd != null && !S.subscription) $("cost").textContent = `$${e.costUsd.toFixed(2)}`;
        setStatus(e.ok ? "EXIT 0" : "NO FORK PASSED", e.ok ? "won" : "lost");
        log(e.t, "", `done in ${fmtT(e.ms)}${e.costUsd != null ? ` · $${e.costUsd.toFixed(2)}` : ""}${e.applied ? " · patch applied" : ""}`, e.ok ? "good" : "bad");
        break;
      case "log":
        log(e.t, "", e.msg, e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "");
        break;
    }
  }

  // Elapsed clock between events.
  function tickClock() {
    if (S.running) {
      const live = S.t + (replay ? 0 : performance.now() - S.lastWall);
      $("elapsed").textContent = fmtT(live);
    }
    requestAnimationFrame(tickClock);
  }

  // ---------- sources ----------
  let replay = null;
  reset();
  requestAnimationFrame(tickClock);

  if (Array.isArray(window.FORKBOMB_EVENTS)) {
    const events = window.FORKBOMB_EVENTS;
    replay = { i: 0, timer: null, playing: true };
    $("replayBar").hidden = false;
    const speed = () => Number($("speed").value) || 4;
    const step = () => {
      if (!replay.playing || replay.i >= events.length) return;
      const e = events[replay.i++];
      apply(e);
      if (replay.i < events.length) {
        const gap = Math.max(0, events[replay.i].t - e.t);
        replay.timer = setTimeout(step, Math.min(gap, 2500) / speed());
      } else $("btnPlay").textContent = "Done";
    };
    $("btnPlay").onclick = () => {
      if (replay.i >= events.length) return;
      replay.playing = !replay.playing;
      $("btnPlay").textContent = replay.playing ? "Pause" : "Play";
      if (replay.playing) step();
      else clearTimeout(replay.timer);
    };
    $("btnRestart").onclick = () => {
      clearTimeout(replay.timer);
      reset();
      replay.i = 0;
      replay.playing = true;
      $("btnPlay").textContent = "Pause";
      setTimeout(step, 300);
    };
    setTimeout(step, 400);
  } else {
    const es = new EventSource("events");
    es.onmessage = (m) => apply(JSON.parse(m.data));
    es.onerror = () => {
      if (!S.running) es.close();
    };
  }
})();
