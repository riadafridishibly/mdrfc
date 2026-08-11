/**
 * The slice of the `expect` API these tests use, over `node:test`.
 * Node's runner ships hooks and a reporter but no matchers, and the assertions
 * here read better as expectations than as `assert.strictEqual` calls.
 */
import { AssertionError, deepStrictEqual } from "node:assert";
import { inspect } from "node:util";

export {
  after as afterAll,
  afterEach,
  before as beforeAll,
  beforeEach,
  describe,
  it,
  test,
} from "node:test";

function show(v: unknown): string {
  return inspect(v, { depth: 4, breakLength: 100 });
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

export interface Matchers {
  readonly not: Matchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toStartWith(expected: string): void;
  toHaveLength(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toThrow(): void;
}

function matchers(actual: unknown, negated: boolean): Matchers {
  const check = (pass: boolean, what: string, expected?: unknown): void => {
    if (pass !== negated) return;
    throw new AssertionError({
      message: `expected ${show(actual)}${negated ? " not" : ""} ${what}`,
      actual,
      expected,
      operator: what,
      stackStartFn: check,
    });
  };
  const num = (): number => {
    if (typeof actual !== "number") throw new TypeError(`${show(actual)} is not a number`);
    return actual;
  };
  const len = (): number => (actual as { length?: number })?.length ?? NaN;

  return {
    get not() {
      return matchers(actual, !negated);
    },
    toBe: (e) => check(Object.is(actual, e), `to be ${show(e)}`, e),
    toEqual: (e) => check(deepEqual(actual, e), `to equal ${show(e)}`, e),
    toContain: (e) =>
      check(
        typeof actual === "string"
          ? actual.includes(String(e))
          : Array.isArray(actual) && actual.some((v) => deepEqual(v, e)),
        `to contain ${show(e)}`,
        e
      ),
    toMatch: (e) =>
      check(
        typeof e === "string" ? String(actual).includes(e) : e.test(String(actual)),
        `to match ${show(e)}`,
        e
      ),
    toStartWith: (e) => check(String(actual).startsWith(e), `to start with ${show(e)}`, e),
    toHaveLength: (e) => check(len() === e, `to have length ${e}`, e),
    toBeGreaterThan: (e) => check(num() > e, `to be greater than ${e}`, e),
    toBeGreaterThanOrEqual: (e) => check(num() >= e, `to be at least ${e}`, e),
    toBeLessThan: (e) => check(num() < e, `to be less than ${e}`, e),
    toBeNull: () => check(actual === null, "to be null", null),
    toBeUndefined: () => check(actual === undefined, "to be undefined", undefined),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeTruthy: () => check(Boolean(actual), "to be truthy"),
    toBeFalsy: () => check(!actual, "to be falsy"),
    toThrow: () => {
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch {
        threw = true;
      }
      check(threw, "to throw");
    },
  };
}

export function expect(actual: unknown): Matchers {
  return matchers(actual, false);
}
