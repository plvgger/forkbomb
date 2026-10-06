// Hydra landing: copy buttons, scroll reveal, the real diff + a replay of the real terminal log.
(function () {
  "use strict";
  window.copy = function (id) {
    var el = document.getElementById(id);
    var text = (el.textContent || "").replace(/^\$\s*/, "");
    navigator.clipboard && navigator.clipboard.writeText(text).then(function () {
      var t = document.getElementById("toast");
      t.classList.add("show");
      setTimeout(function () { t.classList.remove("show"); }, 1400);
    });
  };

  // Real winning patch (first lines), server-rendered once.
  document.getElementById("diff").innerHTML = `<span class="fl">diff --git a/calc.js b/calc.js</span>
<span class="fl">index 4e2ff7c..c666268 100644</span>
--- a/calc.js
+++ b/calc.js
<span class="hnk">@@ -1,19 +1,25 @@</span>
 // A small arithmetic evaluator: + - * / ^, parentheses, unary minus, decimals.
 // evaluate(&quot;2 + 3 * 4&quot;) === 14
<span class="add">+//</span>
<span class="add">+// Precedence (lowest to highest): + -  &lt;  * /  &lt;  unary -  &lt;  ^ (right-assoc).</span>
 
 export function tokenize(src) {
   const tokens = [];
   let i = 0;
   while (i &lt; src.length) {
     const c = src[i];
<span class="del">-    if (c === &quot; &quot;) {</span>
<span class="add">+    if (/\\s/.test(c)) {</span>
       i++;
       continue;
     }
<span class="del">-    if (/[0-9]/.test(c)) {</span>
<span class="add">+    if (/[0-9.]/.test(c)) {</span>
       let j = i;
       while (j &lt; src.length &amp;&amp; /[0-9.]/.test(src[j])) j++;
<span class="del">-      tokens.push({ type: &quot;num&quot;, value: parseFloat(src.slice(i, j)), pos: i });</span>
<span class="add">+      const text = src.slice(i, j);</span>`;

  // A trimmed, honest transcript of the recorded run.
  var term = [
    ['d', '$ hydra run ./calc --task "fix the failing tests" --test "node --test" --heads 4'],
    ['', '  run · 4 heads × 2 rounds · claude-code · race · sandbox on'],
    ['y', '  baseline: 4 passing, 10 failing'],
    ['g', '  fork  4 heads in 1.13 ms each · 0 B extra disk'],
    ['', '  1.01 surgeon   1.02 root-cause   1.03 test-driven   1.04 rewriter'],
    ['d', '  1.04 ✎ rewrote calc.js  ·  $ node --test'],
    ['g', '  1.04 PASS 14/14'],
    ['r', '  1.01 severed   1.02 severed   1.03 severed  (1.04 passed first)'],
    ['g', '  SURVIVOR 1.04 · 94 lines in 1 file · 38.7s'],
  ];
  var el = document.getElementById("term");
  var i = 0;
  function line() {
    if (i >= term.length) { setTimeout(function () { el.innerHTML = ""; i = 0; line(); }, 3500); return; }
    var row = document.createElement("div");
    row.className = term[i][0];
    row.textContent = term[i][1];
    el.appendChild(row);
    i++;
    setTimeout(line, 650);
  }
  var started = false;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        if (e.target.id === "term" && !started) { started = true; line(); }
      }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll(".reveal, #term").forEach(function (n) { io.observe(n); });
})();
