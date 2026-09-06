// A tiny, total expression language for mapping arbitrary data onto events.
//
// Profiles may be sent over the network, so an expression is untrusted input.
// That rules out `eval` and `new Function` completely: both would hand a
// stranger the whole runtime. What follows is a real tokenizer, parser and
// interpreter over a closed set of operations, with no I/O, no assignment, no
// loops, no user-defined functions, and no way to reach a host object.
//
// Three properties are load-bearing, and each is tested:
//
//   Closed    The only things an expression can name are the payload (`$`) and
//             the functions in FUNCTIONS. There is no global scope to reach.
//   Bounded   Length, node count, nesting depth and evaluation steps are all
//             capped, so a hostile expression cannot hang the server.
//   Total     Every failure is an ExprError. Nothing throws past the caller,
//             and no operation can produce a value that is not a number,
//             string, boolean, null, array or plain object.
//
// The language is deliberately small:
//
//   $.a.b   $["a b"]   $.items[0]        paths into the payload
//   + - * / %                            arithmetic
//   == != < <= > >=                      comparison
//   and or not                           logic
//   cond ? a : b                         conditional
//   abs(x)  round(x)  coalesce(a, b)     functions, see FUNCTIONS
//   'text'  12.5  true  false  null      literals

export class ExprError extends Error {}

const LIMITS = {
  length: 2000, // characters in the source
  nodes: 400, // AST nodes
  depth: 32, // nesting
  steps: 20000, // evaluation steps
  string: 8192, // characters in any produced string
};

// Keys that must never be reachable, whatever the payload contains. A payload
// is JSON, so it cannot itself hold a real prototype -- but a crafted key
// called "__proto__" would otherwise let an expression read one.
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

// --- tokenizer ------------------------------------------------------------

const PUNCT = ['<=', '>=', '==', '!=', '(', ')', '[', ']', '.', ',', '?', ':', '+', '-', '*', '/', '%', '<', '>'];

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '$') {
      out.push({ t: 'root' });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let s = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          s += src[i++];
        }
      }
      if (i >= src.length) throw new ExprError('unterminated string');
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && /[0-9._eE+-]/.test(src[j])) {
        // Stop before a `+`/`-` that is not part of an exponent.
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      const text = src.slice(i, j);
      const n = Number(text);
      if (!Number.isFinite(n)) throw new ExprError('bad number: ' + text);
      out.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new ExprError('unexpected character: ' + c);
    out.push({ t: p });
    i += p.length;
  }
  out.push({ t: 'end' });
  return out;
}

// --- parser ---------------------------------------------------------------

// Binary precedence, low binds loosest.
const BINARY = {
  or: 1, and: 2,
  '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

function parse(src) {
  if (typeof src !== 'string') throw new ExprError('expression must be a string');
  if (src.length > LIMITS.length) throw new ExprError('expression too long');

  const tok = tokenize(src);
  let pos = 0;
  let nodes = 0;

  const peek = () => tok[pos];
  const next = () => tok[pos++];
  const node = (n) => {
    if (++nodes > LIMITS.nodes) throw new ExprError('expression too complex');
    return n;
  };

  function expect(t) {
    if (tok[pos].t !== t) throw new ExprError(`expected ${t}`);
    return tok[pos++];
  }

  function parseExpr(minPrec, depth) {
    if (depth > LIMITS.depth) throw new ExprError('expression nested too deeply');
    let left = parseUnary(depth);

    for (;;) {
      const t = peek();
      const op = t.t === 'name' && (t.v === 'and' || t.v === 'or') ? t.v : t.t;
      const prec = BINARY[op];
      if (prec == null || prec < minPrec) break;
      next();
      const right = parseExpr(prec + 1, depth + 1);
      left = node({ k: 'bin', op, left, right });
    }

    // Ternary binds loosest of all, and associates to the right.
    if (minPrec <= 1 && peek().t === '?') {
      next();
      const then = parseExpr(0, depth + 1);
      expect(':');
      const other = parseExpr(0, depth + 1);
      left = node({ k: 'cond', test: left, then, other });
    }
    return left;
  }

  function parseUnary(depth) {
    const t = peek();
    if (t.t === '-') {
      next();
      return node({ k: 'neg', v: parseUnary(depth + 1) });
    }
    if (t.t === 'name' && t.v === 'not') {
      next();
      return node({ k: 'not', v: parseUnary(depth + 1) });
    }
    return parsePostfix(parsePrimary(depth), depth);
  }

  function parsePostfix(base, depth) {
    for (;;) {
      const t = peek();
      if (t.t === '.') {
        next();
        const name = expect('name');
        base = node({ k: 'member', obj: base, key: { k: 'lit', v: name.v } });
      } else if (t.t === '[') {
        next();
        const key = parseExpr(0, depth + 1);
        expect(']');
        base = node({ k: 'member', obj: base, key });
      } else {
        return base;
      }
    }
  }

  function parsePrimary(depth) {
    const t = next();
    if (t.t === 'num' || t.t === 'str') return node({ k: 'lit', v: t.v });
    if (t.t === 'root') return node({ k: 'root' });
    if (t.t === '(') {
      const e = parseExpr(0, depth + 1);
      expect(')');
      return e;
    }
    if (t.t === 'name') {
      if (t.v === 'true') return node({ k: 'lit', v: true });
      if (t.v === 'false') return node({ k: 'lit', v: false });
      if (t.v === 'null') return node({ k: 'lit', v: null });
      if (peek().t === '(') {
        next();
        const args = [];
        if (peek().t !== ')') {
          for (;;) {
            args.push(parseExpr(0, depth + 1));
            if (peek().t !== ',') break;
            next();
          }
        }
        expect(')');
        if (!isFunction(t.v)) throw new ExprError('unknown function: ' + t.v);
        return node({ k: 'call', name: t.v, args });
      }
      // A bare name is not a variable: there are no variables. Saying so is
      // more useful than "unexpected token".
      throw new ExprError(
        `unknown name "${t.v}" -- only $ and functions exist; did you mean $.${t.v}?`
      );
    }
    throw new ExprError('unexpected ' + t.t);
  }

  const ast = parseExpr(0, 0);
  if (peek().t !== 'end') throw new ExprError('trailing input');
  return ast;
}

// --- functions ------------------------------------------------------------

const num = (v) => {
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The complete vocabulary. Adding to this list is how the language grows;
 * there is no other way in, which is the point.
 */
export const FUNCTIONS = {
  abs: (a) => (num(a) == null ? null : Math.abs(num(a))),
  sign: (a) => (num(a) == null ? null : Math.sign(num(a))),
  round: (a) => (num(a) == null ? null : Math.round(num(a))),
  floor: (a) => (num(a) == null ? null : Math.floor(num(a))),
  ceil: (a) => (num(a) == null ? null : Math.ceil(num(a))),
  min: (...a) => { const n = a.map(num).filter((x) => x != null); return n.length ? Math.min(...n) : null; },
  max: (...a) => { const n = a.map(num).filter((x) => x != null); return n.length ? Math.max(...n) : null; },
  clamp: (v, lo, hi) => { const n = num(v); return n == null ? null : Math.max(num(lo) ?? n, Math.min(num(hi) ?? n, n)); },
  log: (a) => { const n = num(a); return n == null || n <= 0 ? null : Math.log(n); },
  num: (a) => num(a),
  str: (a) => str(a),
  len: (a) => (a == null ? 0 : Array.isArray(a) ? a.length : typeof a === 'object' ? Object.keys(a).length : str(a).length),
  lower: (a) => str(a).toLowerCase(),
  upper: (a) => str(a).toUpperCase(),
  trim: (a) => str(a).trim(),
  concat: (...a) => a.map(str).join(''),
  // The workhorse: the first argument that is neither null nor undefined nor ''.
  coalesce: (...a) => a.find((x) => x != null && x !== '') ?? null,
  contains: (h, n) => str(h).includes(str(n)),
  startswith: (h, n) => str(h).startsWith(str(n)),
  endswith: (h, n) => str(h).endsWith(str(n)),
  replace: (h, a, b) => str(h).split(str(a)).join(str(b)),
  split: (h, sep) => str(h).split(str(sep)),
  at: (a, i) => {
    const k = num(i);
    if (k == null) return null;
    if (Array.isArray(a)) return a[k < 0 ? a.length + k : k] ?? null;
    const s = str(a);
    return s[k < 0 ? s.length + k : k] ?? null;
  },
  // Timestamps. `epoch` accepts ISO text, seconds or milliseconds and returns
  // milliseconds, which is what the event contract wants.
  epoch: (a) => {
    if (a == null) return null;
    const n = Number(a);
    if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
    const t = Date.parse(String(a));
    return Number.isFinite(t) ? t : null;
  },
  now: () => Date.now(),

  /**
   * sumof($.outputs, 'value') -- add one numeric field across a list.
   *
   * Aggregating over a list is the one thing real payloads need that paths
   * cannot express: a Bitcoin transaction's value is the sum of its outputs,
   * and without this it cannot be described at all. A named field rather than
   * an expression keeps the language free of lambdas, which is what keeps it
   * small enough to reason about.
   */
  sumof: (arr, field) => {
    if (!Array.isArray(arr)) return null;
    let total = 0;
    let seen = 0;
    const key = field == null ? null : String(field);
    if (key !== null && FORBIDDEN.has(key)) return null;
    for (const item of arr) {
      const v = key === null ? item
        : item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, key)
          ? item[key] : null;
      const n = num(v);
      if (n != null) { total += n; seen++; }
    }
    return seen ? total : null;
  },

  /** The largest value of one field across a list, or null if there is none. */
  maxof: (arr, field) => {
    if (!Array.isArray(arr)) return null;
    let best = null;
    const key = field == null ? null : String(field);
    if (key !== null && FORBIDDEN.has(key)) return null;
    for (const item of arr) {
      const v = key === null ? item
        : item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, key)
          ? item[key] : null;
      const n = num(v);
      if (n != null && (best === null || n > best)) best = n;
    }
    return best;
  },
};

/**
 * Functions that need the compile-time context rather than only their
 * arguments. They are called with it as a hidden first parameter, so a
 * profile's tables stay out of the expression's reach as data it could walk.
 */
const CONTEXT_FUNCTIONS = {
  /**
   * lookup('severity', $.level, 5) -- a named table from the profile.
   *
   * Real feeds classify things with a vocabulary: NWS severities, syslog
   * levels, HTTP statuses. Writing that as nested conditionals is unreadable
   * and, past a handful of cases, hits the node ceiling. A table is the honest
   * shape for it, and keeping tables in the profile rather than in the
   * expression keeps them diffable.
   */
  lookup: (ctx, table, key, fallback = null) => {
    const t = ctx && ctx.tables ? ctx.tables[String(table)] : null;
    if (!t) return fallback ?? null;
    const k = key == null ? '' : String(key);
    if (FORBIDDEN.has(k)) return fallback ?? null;
    return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : (fallback ?? null);
  },
};

const isFunction = (name) =>
  Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ||
  Object.prototype.hasOwnProperty.call(CONTEXT_FUNCTIONS, name);

export const FUNCTION_NAMES = [
  ...Object.keys(FUNCTIONS),
  ...Object.keys(CONTEXT_FUNCTIONS),
].sort();

// --- evaluator ------------------------------------------------------------

function member(obj, key) {
  if (obj == null) return null;
  const k = typeof key === 'number' ? key : String(key);
  if (typeof k === 'string' && FORBIDDEN.has(k)) return null;
  if (Array.isArray(obj)) {
    const i = Number(k);
    if (!Number.isInteger(i)) return null;
    return obj[i < 0 ? obj.length + i : i] ?? null;
  }
  if (typeof obj !== 'object') return null;
  // Own properties only, so nothing can walk up a prototype chain.
  return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null;
}

const truthy = (v) => v != null && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && !v.length);

function evaluate(ast, root, ctx) {
  let steps = 0;

  const walk = (n) => {
    if (++steps > LIMITS.steps) throw new ExprError('expression did too much work');
    switch (n.k) {
      case 'lit': return n.v;
      case 'root': return root;
      case 'member': return member(walk(n.obj), walk(n.key));
      case 'neg': { const v = num(walk(n.v)); return v == null ? null : -v; }
      case 'not': return !truthy(walk(n.v));
      case 'cond': return truthy(walk(n.test)) ? walk(n.then) : walk(n.other);
      case 'call': {
        const args = n.args.map(walk);
        const out = Object.prototype.hasOwnProperty.call(CONTEXT_FUNCTIONS, n.name)
          ? CONTEXT_FUNCTIONS[n.name](ctx, ...args)
          : FUNCTIONS[n.name](...args);
        if (typeof out === 'string' && out.length > LIMITS.string) {
          throw new ExprError('string result too long');
        }
        return out === undefined ? null : out;
      }
      case 'bin': {
        const op = n.op;
        // Short-circuit, so `$.a != null and $.a.b` is safe to write.
        if (op === 'and') return truthy(walk(n.left)) ? walk(n.right) : false;
        if (op === 'or') { const l = walk(n.left); return truthy(l) ? l : walk(n.right); }
        const a = walk(n.left);
        const b = walk(n.right);
        switch (op) {
          case '==': return a === b || (a == null && b == null) || str(a) === str(b);
          case '!=': return !(a === b || (a == null && b == null) || str(a) === str(b));
          case '+': {
            if (typeof a === 'string' || typeof b === 'string') {
              const s = str(a) + str(b);
              if (s.length > LIMITS.string) throw new ExprError('string result too long');
              return s;
            }
            const x = num(a); const y = num(b);
            return x == null || y == null ? null : x + y;
          }
          case '-': case '*': case '/': case '%': {
            const x = num(a); const y = num(b);
            if (x == null || y == null) return null;
            if ((op === '/' || op === '%') && y === 0) return null;
            const r = op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
            return Number.isFinite(r) ? r : null;
          }
          default: {
            const x = num(a); const y = num(b);
            const [p, q] = x != null && y != null ? [x, y] : [str(a), str(b)];
            return op === '<' ? p < q : op === '<=' ? p <= q : op === '>' ? p > q : p >= q;
          }
        }
      }
      default: throw new ExprError('bad node');
    }
  };

  return walk(ast);
}

/**
 * Compile an expression once and reuse it.
 *
 * Parsing is the expensive half and a profile is applied to every event, so a
 * compiled expression is what a profile actually stores.
 *
 * @param {string} src
 * @param {{tables?: Record<string, Record<string, any>>}} [ctx] named tables for lookup()
 * @returns {(payload: any) => any} throws ExprError, and only ExprError
 */
export function compile(src, ctx = {}) {
  const ast = parse(src);
  return (payload) => evaluate(ast, payload === undefined ? null : payload, ctx);
}

/** Parse without evaluating, to validate a profile before accepting it. */
export function check(src) {
  try {
    parse(src);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof ExprError ? e.message : String(e) };
  }
}

export const EXPR_LIMITS = { ...LIMITS };
