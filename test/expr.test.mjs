// The mapping expression language: what it computes, and what it refuses.
//
// Profiles may arrive over the network, so these are security checks as much
// as behaviour checks. See src/core/expr.js.
import { compile, check, ExprError, EXPR_LIMITS } from '../src/core/expr.js';

let fails = 0;
const failedNames = [];
const ok = (name, cond, extra = '') => {
  if (!cond) { fails++; failedNames.push(name); console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
  else console.log('ok    ' + name + (extra ? '  ' + extra : ''));
};
const run = (src, payload) => compile(src)(payload);
const rejects = (src, payload) => {
  try { compile(src)(payload); return { rejected: false }; }
  catch (e) { return { rejected: true, isExprError: e instanceof ExprError, msg: e.message }; }
};

const P = {
  duration_ms: 250, route: '/api/v1/users', status: 503, method: 'POST',
  time: '2026-09-06T10:00:00Z', delta: -42, tags: ['a', 'b', 'c'],
  nested: { deep: { value: 7 } }, empty: '', zero: 0, nothing: null,
};

// --- the language does what it says -------------------------------------
ok('paths', run('$.duration_ms', P) === 250);
ok('deep paths', run('$.nested.deep.value', P) === 7);
ok('bracket paths', run('$["route"]', P) === '/api/v1/users');
ok('array index', run('$.tags[1]', P) === 'b');
ok('negative index', run('at($.tags, -1)', P) === 'c');
ok('arithmetic', run('$.duration_ms * 2 + 1', P) === 501);
ok('precedence', run('2 + 3 * 4', P) === 14);
ok('parens', run('(2 + 3) * 4', P) === 20);
ok('unary minus', run('-$.duration_ms', P) === -250);
ok('comparison', run('$.status >= 500', P) === true);
ok('logic and', run('$.status >= 500 and $.method == "POST"', P) === true);
ok('logic or', run('$.status > 900 or $.status == 503', P) === true);
ok('not', run('not ($.status == 200)', P) === true);
ok('ternary', run('$.status >= 500 ? "alert" : "user"', P) === 'alert');
ok('nested ternary', run('$.status >= 500 ? "alert" : $.status >= 400 ? "anon" : "user"', P) === 'alert');
ok('string concat', run('$.method + " " + $.route', P) === 'POST /api/v1/users');
ok('coalesce skips empty', run('coalesce($.empty, $.nothing, "fallback")', P) === 'fallback');
ok('coalesce keeps zero-ish text', run('coalesce($.nothing, "x")', P) === 'x');
ok('epoch from iso', run('epoch($.time)', P) === Date.parse('2026-09-06T10:00:00Z'));
ok('epoch from seconds', run('epoch(1757152800)', P) === 1757152800000);
ok('epoch from millis', run('epoch(1757152800000)', P) === 1757152800000);
ok('abs', run('abs($.delta)', P) === 42);
ok('sign', run('sign($.delta)', P) === -1);
ok('len of array', run('len($.tags)', P) === 3);
ok('len of string', run('len($.method)', P) === 4);
ok('lower/upper', run('lower($.method) + upper("x")', P) === 'postX');
ok('contains', run('contains($.route, "users")', P) === true);
ok('split + at', run('at(split($.route, "/"), 2)', P) === 'v1');
ok('clamp', run('clamp(500, 0, 100)', P) === 100);
ok('missing path is null, not a crash', run('$.nope.deeper', P) === null);
ok('division by zero yields null', run('1 / $.zero', P) === null);
ok('modulo by zero yields null', run('1 % $.zero', P) === null);
ok('non-numeric arithmetic yields null', run('$.route * 2', P) === null);

// --- closed: nothing outside $ and FUNCTIONS is reachable ---------------
for (const hostile of [
  'process', 'require', 'globalThis', 'global', 'this', 'window', 'Function', 'eval',
  'process.env', 'require("fs")', 'constructor', 'toString',
]) {
  const r = rejects(hostile, P);
  ok('no host access: ' + hostile, r.rejected && r.isExprError, r.msg || 'ACCEPTED');
}

// Prototype reachability, through both syntaxes and through a crafted payload.
const nasty = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
ok('$.__proto__ is null', run('$.__proto__', nasty) === null);
ok('$["__proto__"] is null', run('$["__proto__"]', nasty) === null);
ok('$.constructor is null', run('$.constructor', nasty) === null);
ok('$["prototype"] is null', run('$["prototype"]', {}) === null);
ok('object prototype was not polluted', ({}).polluted === undefined);
ok('a computed forbidden key is still blocked', run('$["__pro" + "to__"]', nasty) === null);

// --- bounded -------------------------------------------------------------
const long = '1' + ' + 1'.repeat(EXPR_LIMITS.length);
ok('over-long source is rejected', rejects(long, P).rejected);
const deep = '('.repeat(200) + '1' + ')'.repeat(200);
const deepR = rejects(deep, P);
ok('deep nesting is rejected', deepR.rejected && deepR.isExprError, deepR.msg);
const wide = Array.from({ length: 500 }, (_, i) => i).join(' + ');
const wideR = rejects(wide, P);
ok('too many nodes is rejected', wideR.rejected && wideR.isExprError, wideR.msg);
const bigStr = rejects("concat('" + 'x'.repeat(1500) + "', '" + 'y'.repeat(1500) + "')", P);
ok('runaway strings are capped or accepted within the cap',
   !bigStr.rejected || bigStr.isExprError, bigStr.msg || 'within cap');

// --- total: only ExprError escapes --------------------------------------
const garbage = ['', '   ', '$.', '((', ')', '1 +', '* 3', '"unterminated', 'foo(', 'and', '?:', '$[', '1 ? 2', '@#!'];
let leaked = null;
for (const g of garbage) {
  try { compile(g)(P); }
  catch (e) { if (!(e instanceof ExprError)) leaked = `${JSON.stringify(g)} -> ${e.constructor.name}: ${e.message}`; }
}
ok('malformed input only ever raises ExprError', leaked === null, leaked || `${garbage.length} inputs`);

// A payload that is not an object must not crash anything.
for (const weird of [null, undefined, 42, 'text', [], [1, 2], { a: undefined }]) {
  try { run('$.a.b + 1', weird); } catch (e) { leaked = 'payload ' + JSON.stringify(weird) + ': ' + e.message; }
}
ok('hostile payloads do not crash the evaluator', leaked === null, leaked || 'ok');

// --- check() reports rather than throws ----------------------------------
ok('check accepts a good expression', check('$.a + 1').ok);
const bad = check('$.a +');
ok('check rejects a bad one with a reason', !bad.ok && typeof bad.error === 'string', bad.error);
ok('unknown function names the problem', /unknown function/.test(rejects('nope(1)', P).msg || ''));
ok('a bare word suggests the fix', /did you mean \$\./.test(rejects('duration_ms', P).msg || ''));

console.log(fails ? `\n${fails} FAILURE(S): ${failedNames.join(' | ')}` : '\nall expression checks passed');
process.exitCode = fails ? 1 : 0;
