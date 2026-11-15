/**
 * Spreads a long test file over several workers in a full run. Each part file calls `startPart`, imports the long
 * file, then calls `runPart`, which registers that part's contiguous share of its tests in the file's order. The long
 * file wraps its `it` in `partedIt`. Run on its own, it registers every test as it goes.
 *
 * The long file stays the one place its tests are written, and the package's Vitest config runs it whole only when
 * it is named on the command line.
 */
type Register = () => void;
type Part = { index: number; count: number; tests: Register[] };
const current = () => (globalThis as { __testPart?: Part }).__testPart;

function add(register: Register) {
  const part = current();
  if (part) part.tests.push(register);
  else register();
}

type Fn = (...args: unknown[]) => unknown;

/** Modifiers that take an argument first and return the registering function: `it.each(table)(name, fn)`. */
const CURRIED = new Set(["each", "for", "skipIf", "runIf"]);

/**
 * The long file's `it`: the caller's own, so this module needs no Vitest of its own. Every form waits for its part:
 * `it(...)`, `it.skip(...)` and the like, and `it.each(...)(...)`, `it.skipIf(...)(...)` and the like.
 */
export function partedIt<T extends object>(it: T): T {
  const run = it as unknown as Fn & Record<string, Fn>;
  const call = (...args: unknown[]) => add(() => run(...args));
  return new Proxy(call, {
    get: (_, key: string) => CURRIED.has(key)
      ? (...first: unknown[]) => (...args: unknown[]) => add(() => (run[key]!(...first) as Fn)(...args))
      : (...args: unknown[]) => add(() => run[key]!(...args)),
  }) as unknown as T;
}

/** In a part file, before importing the long file. */
export function startPart(index: number, count: number) {
  (globalThis as { __testPart?: Part }).__testPart = { index, count, tests: [] };
}

/** In a part file, after importing the long file. */
export function runPart() {
  const { index, count, tests } = current()!;
  const size = Math.ceil(tests.length / count);
  for (const register of tests.slice(index * size, (index + 1) * size)) register();
}
