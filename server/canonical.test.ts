// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalize,
  canonicallyEqual,
  isPlainObject,
  optional,
} from './canonical.js';

describe('canonicalize', () => {
  it('sorts object keys recursively so equality is a string comparison', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order, which carries meaning for targets and sets', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops a property whose value is undefined rather than emitting null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses undefined inside an array instead of letting it become null', () => {
    // JSON.stringify([undefined]) is "[null]" — a hole silently becoming a value.
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(JSON.stringify([undefined])).toBe('[null]');
  });

  it('rejects non-finite numbers, which JSON.stringify would turn into null', () => {
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(/not a finite number/);
    expect(() => canonicalJson({ v: Number.POSITIVE_INFINITY })).toThrow(/not a finite number/);
    expect(JSON.stringify({ v: Number.NaN })).toBe('{"v":null}');
  });

  it('rejects values that only look like data', () => {
    expect(() => canonicalJson({ at: new Date() })).toThrow(/Date/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(/symbol/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/Map/);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ sets: [{ actual: Number.NaN }] })).toThrow(
      '$.sets[0].actual: NaN is not a finite number',
    );
  });

  it('normalises -0 to 0, because they are indistinguishable once stored', () => {
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}');
    expect(JSON.stringify({ v: -0 })).toBe('{"v":0}');
  });

  it('keeps an own __proto__ key, which plain assignment would silently swallow', () => {
    // JSON.parse is the one place `__proto__` becomes a real own property. `out[key] = value`
    // would invoke the Object.prototype setter instead and drop it — inside patternParams or
    // measured, that is stored data quietly disappearing.
    const parsed: unknown = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2, "a": 3}');
    expect(Object.keys(parsed as object).sort()).toEqual(['__proto__', 'a', 'constructor']);

    const out = canonicalize(parsed) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'a', 'constructor']);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['constructor']).toBe(2);
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"x":1},"a":3,"constructor":2}');
    // and the prototype chain is untouched
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('keeps null, which is a value rather than an absence', () => {
    expect(canonicalJson({ v: null })).toBe('{"v":null}');
  });

  it('returns a copy, not the input', () => {
    const input = { a: { b: 1 } };
    const output = canonicalize(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });
});

describe('canonicallyEqual', () => {
  it('ignores key order and absent-versus-undefined', () => {
    expect(canonicallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonicallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(canonicallyEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
  });
});

describe('isPlainObject', () => {
  it('accepts object literals and null-prototype objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null) as object)).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe('optional', () => {
  it('adds nothing for null or undefined', () => {
    expect(Object.keys({ ...optional('week', null) })).toEqual([]);
    expect(Object.keys({ ...optional('week', undefined) })).toEqual([]);
  });

  it('adds the key for any real value, including 0 and empty string', () => {
    expect({ ...optional('week', 0) }).toEqual({ week: 0 });
    expect({ ...optional('note', '') }).toEqual({ note: '' });
  });

  it('never produces an own property holding undefined', () => {
    const built = { id: 'x', ...optional('note', null) };
    expect('note' in built).toBe(false);
    expect(Object.keys(built)).toEqual(['id']);
  });
});
