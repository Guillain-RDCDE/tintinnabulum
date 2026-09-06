// A profile: how one kind of data becomes events.
//
// This is the part that makes the engine a standard rather than a library with
// a convention. A profile is a document, not code -- it can be committed,
// reviewed, versioned, diffed and shared, and a producer adopting Tintinnabulum
// writes one instead of writing a transformer.
//
//   {
//     "profile": "tintinnabulum.mapping/1",
//     "name": "http-access-log",
//     "where": "$.status != null",
//     "map": {
//       "magnitude": "$.duration_ms",
//       "id":        "$.route",
//       "category":  "$.status >= 500 ? 'alert' : $.status >= 400 ? 'anon' : 'user'",
//       "ts":        "epoch($.time)",
//       "label":     "$.method + ' ' + $.route"
//     }
//   }
//
// Every value is an expression in the language defined by expr.js: closed,
// bounded and total. A profile arriving over the network therefore cannot do
// anything but compute a value from the payload it was handed.

import { compile, check, ExprError } from './expr.js';
import { normalize } from './event.js';

export const MAPPING_VERSION = 'tintinnabulum.mapping/1';
export const EVENT_VERSION = 'tintinnabulum.event/1';

/** The target fields a profile may write. Anything else is a mistake. */
export const TARGET_FIELDS = [
  'magnitude', 'polarity', 'id', 'category', 'accent', 'label', 'url', 'ts', 'source',
];

export class ProfileError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

/**
 * Validate a profile document without compiling it.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateProfile(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, problems: ['a profile must be a JSON object'] };
  }
  if (doc.profile != null && doc.profile !== MAPPING_VERSION) {
    problems.push(`unknown profile version "${doc.profile}", expected "${MAPPING_VERSION}"`);
  }
  if (doc.name != null && typeof doc.name !== 'string') problems.push('"name" must be a string');

  if (doc.tables != null) {
    if (typeof doc.tables !== 'object' || Array.isArray(doc.tables)) {
      problems.push('"tables" must be an object of name -> {key: value}');
    } else {
      for (const [t, table] of Object.entries(doc.tables)) {
        if (!table || typeof table !== 'object' || Array.isArray(table)) {
          problems.push(`"tables.${t}" must be an object of key -> value`);
        }
      }
    }
  }

  const map = doc.map;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push('"map" must be an object of target field -> expression');
    return { ok: false, problems };
  }
  if (!Object.prototype.hasOwnProperty.call(map, 'magnitude')) {
    problems.push('"map.magnitude" is required: it is the only field the engine cannot invent');
  }

  for (const [field, spec] of Object.entries(map)) {
    if (!TARGET_FIELDS.includes(field)) {
      problems.push(`unknown target field "${field}" -- expected one of ${TARGET_FIELDS.join(', ')}`);
      continue;
    }
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      if (!Object.prototype.hasOwnProperty.call(spec, 'const')) {
        problems.push(`"map.${field}" must be an expression string or {"const": value}`);
      }
      continue;
    }
    if (typeof spec !== 'string') {
      problems.push(`"map.${field}" must be an expression string or {"const": value}`);
      continue;
    }
    const r = check(spec);
    if (!r.ok) problems.push(`"map.${field}": ${r.error}`);
  }

  if (doc.where != null) {
    if (typeof doc.where !== 'string') problems.push('"where" must be an expression string');
    else {
      const r = check(doc.where);
      if (!r.ok) problems.push(`"where": ${r.error}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Compile a profile into something that can be applied to payloads.
 *
 * @param {object} doc
 * @returns {{name: string, apply: (payload: any) => object}}
 */
export function compileProfile(doc) {
  const { ok, problems } = validateProfile(doc);
  if (!ok) throw new ProfileError('invalid profile', problems);

  const name = doc.name || 'anonymous';
  // Tables are copied without a prototype, so a table called "__proto__" or a
  // key of that name cannot reach one through lookup().
  const tables = Object.assign(Object.create(null), doc.tables || {});
  for (const [k, v] of Object.entries(tables)) {
    tables[k] = Object.assign(Object.create(null), v);
  }
  const ctx = { tables };

  const where = doc.where ? compile(doc.where, ctx) : null;
  const fields = Object.entries(doc.map).map(([field, spec]) =>
    typeof spec === 'string'
      ? { field, source: spec, run: compile(spec, ctx) }
      : { field, source: JSON.stringify(spec.const), run: () => spec.const }
  );

  /**
   * Apply the profile to one payload.
   *
   * Returns the whole story rather than just the event, because a mapping is
   * something you have to get working: `trace` is what /explain shows, and it
   * is the difference between "rejected" and knowing which field went wrong.
   */
  function apply(payload) {
    const trace = [];
    const raw = {};
    const errors = [];

    if (where) {
      let keep;
      try {
        keep = where(payload);
      } catch (e) {
        return { event: null, raw: null, trace, skipped: false,
                 errors: [`where: ${e instanceof ExprError ? e.message : String(e)}`] };
      }
      const truthy = keep != null && keep !== false && keep !== 0 && keep !== '';
      if (!truthy) {
        return { event: null, raw: null, trace, skipped: true, errors: [] };
      }
    }

    for (const f of fields) {
      let value = null;
      let error = null;
      try {
        value = f.run(payload);
      } catch (e) {
        error = e instanceof ExprError ? e.message : String(e);
        errors.push(`${f.field}: ${error}`);
      }
      trace.push({ field: f.field, expression: f.source, value, error });
      if (error === null && value !== null) raw[f.field] = value;
    }

    // The payload is kept whole, so nothing is lost by mapping.
    if (payload && typeof payload === 'object') raw.data = payload;

    const event = normalize(raw);
    if (!event) {
      const m = trace.find((t) => t.field === 'magnitude');
      errors.push(
        m == null
          ? 'no magnitude was produced'
          : `magnitude expression "${m.expression}" produced ${JSON.stringify(m.value)}, which is not a finite number`
      );
    }
    return { event, raw, trace, skipped: false, errors };
  }

  return { name, version: MAPPING_VERSION, apply, fields: fields.map((f) => f.field) };
}

/**
 * The shorthand the ingest server has always accepted, expressed as a profile.
 *
 * `?magnitude=$.duration_ms&id=$.service` predates this and remains valid: a
 * value starting with `$` is a path, anything else is a literal. Turning it
 * into a profile means there is now one code path, not two.
 */
export function profileFromQuery(params) {
  const map = {};
  for (const field of TARGET_FIELDS) {
    const spec = params.get ? params.get(field) : params[field];
    if (spec == null) continue;
    map[field] = spec.startsWith('$') ? spec : { const: spec };
  }
  return Object.keys(map).length ? { profile: MAPPING_VERSION, name: 'query', map } : null;
}
