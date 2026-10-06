// A small arithmetic evaluator: + - * / ^, parentheses, unary minus, decimals.
// evaluate("2 + 3 * 4") === 14

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "num", value: parseFloat(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if ("+-*/^()".includes(c)) {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    throw new Error("bad character " + c);
  }
  return tokens;
}

export function evaluate(src) {
  const tokens = tokenize(src);
  let pos = 0;

  function primary() {
    const t = tokens[pos++];
    if (t.type === "num") return t.value;
    if (t.value === "(") {
      const v = expr();
      pos++;
      return v;
    }
    throw new Error("unexpected " + t.value);
  }

  function expr() {
    let v = primary();
    while (pos < tokens.length && tokens[pos].value !== ")") {
      const op = tokens[pos++].value;
      const r = primary();
      if (op === "+") v += r;
      else if (op === "-") v -= r;
      else if (op === "*") v *= r;
      else if (op === "/") v /= r;
      else if (op === "^") v = v ** r;
    }
    return v;
  }

  return expr();
}
