/**
 * Canonical JSON.
 *
 * Two jobs, both load-bearing for a migration that must be verifiable rather than merely
 * successful:
 *
 * 1. **Absent is the sole canonical representation of an optional.** JSON has no `undefined`;
 *    SQL adds `NULL` as a second spelling of the same idea. Left alone that is three spellings
 *    of one fact, and a round trip that turns one into another looks like a difference. Here a
 *    property whose value is `undefined` is *dropped*, never emitted as `null`, and never
 *    re-materialised as `{field: undefined}` — which `exactOptionalPropertyTypes` rejects anyway.
 *
 * 2. **A stable byte string for equality.** Object keys are sorted recursively, so "did this
 *    record survive the round trip" and "is this re-import identical to what is already stored"
 *    are both a string comparison rather than a hand-written deep-equal that can forget a field.
 *
 * Anything with no JSON representation — `undefined` inside an array, `NaN`, `Infinity`, a
 * `Date`, a class instance, a function, a `bigint`, a symbol — throws. `JSON.stringify` would
 * quietly turn several of those into `null` or drop them; that quiet is exactly the failure mode
 * this module exists to remove.
 *
 * Pure. No DOM, no storage, no `node:sqlite`.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A `{...}` object, not an array and not an instance of anything. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'bigint') return 'a bigint';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'symbol') return 'a symbol';
  if (value instanceof Date) return 'a Date';
  return `a ${Object.prototype.toString.call(value).slice(8, -1)}`;
}

export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/**
 * Deep-copy into canonical form: keys sorted, `undefined` properties dropped, `-0` normalised
 * to `0` (they are `===` in JavaScript and indistinguishable once stored, so keeping the sign
 * would make an identical value compare unequal on re-import).
 */
export function canonicalize(value: unknown, path = '$'): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(path, `${String(value)} is not a finite number`);
      }
      return value === 0 ? 0 : value;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `${describe(value)} has no JSON representation`);
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => {
      if (item === undefined) {
        // `JSON.stringify([undefined])` is `"[null]"`. A hole silently becoming a null element
        // is precisely the kind of coercion this module refuses to perform.
        throw new CanonicalJsonError(`${path}[${index}]`, 'undefined has no JSON representation');
      }
      return canonicalize(item, `${path}[${index}]`);
    });
  }

  if (!isPlainObject(value)) {
    throw new CanonicalJsonError(path, `${describe(value)} has no JSON representation`);
  }

  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue; // absent is canonical
    defineOwn(out, key, canonicalize(item, `${path}.${key}`));
  }
  return out;
}

/**
 * Set an own property, including one named `__proto__`.
 *
 * `out[key] = value` is not safe for arbitrary keys. `JSON.parse('{"__proto__":{}}')` produces a
 * genuine own `__proto__` property — that is the one place JSON.parse deliberately differs from
 * object-literal syntax — and assigning it back with `out['__proto__'] = …` invokes the setter on
 * `Object.prototype` instead, so the key vanishes from the result. Inside `patternParams`,
 * `restPolicyParams`, `decision`, `patternMetrics` or `evaluation.measured`, all of which hold
 * user- and pattern-supplied keys, that is a silent alteration of stored data by a module whose
 * entire job is to not alter it.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Canonical form as a string. The unit of comparison for round-trip and re-import checks. */
export function canonicalJson(value: unknown, path = '$'): string {
  return JSON.stringify(canonicalize(value, path));
}

/** Equal after canonicalisation — key order and absent-vs-undefined do not count as difference. */
export function canonicallyEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Spread this to add an optional property only when it has a value.
 *
 * `{...optional('week', undefined)}` adds nothing; `{...optional('week', 3)}` adds `week: 3`.
 * The alternative — `{week: row.week ?? undefined}` — produces `{week: undefined}`, an own
 * property that `Object.keys` reports, that `exactOptionalPropertyTypes` rejects, and that makes
 * a decoded record structurally unequal to the one that was encoded.
 */
export function optional<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
