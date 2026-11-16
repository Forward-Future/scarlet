/** Exact times as fractions of a second, for timeline files that count in whole frames. */
import type { ExactRate } from "./handoff.js";

export type Q = { n: number; d: number };

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
export function q(n: number, d = 1): Q {
  if (d < 0) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1;
  return { n: n / g, d: d / g };
}
export const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
export const seconds = (t: Q) => t.n / t.d;
/** `count` frames at `rate`, rounded to a whole frame. */
export const frames = (count: number, rate: ExactRate) => q(Math.round(count) * rate.den, rate.num);
/** The whole frame at `rate` nearest `seconds`. */
export const secondsQ = (s: number, rate: ExactRate) => frames(s * rate.num / rate.den, rate);
/** The whole frame at `rate` nearest an exact time. */
export const snapQ = (t: Q, rate: ExactRate) => frames(t.n * rate.num / (t.d * rate.den), rate);

/** The fraction nearest `x` with a denominator of at most `maxDen` (continued fractions). */
export function fraction(x: number, maxDen = 10_000): Q {
  if (Number.isInteger(x)) return q(x);
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(v);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(v - a) < 1e-12) break;
    v = 1 / (v - a);
  }
  return q(h1, k1);
}
