import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { LINGER_FADE_MS } from "../../lib/reviewTabs";

/** How long a low risk row takes to open into For you's list, or to close out of it. */
export const FOLD_MS = 220;
const EASE = "cubic-bezier(.2, 0, 0, 1)";

/** The rows that are in For you's list only while low risk edits are included. */
const LOW_ROWS = "li[data-low-risk]";

const canMove = () => typeof window !== "undefined" && typeof Element !== "undefined" && typeof Element.prototype.animate === "function"
  && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A row the editor is looking at, and where it sits in its list's own scrolling box. */
type Held = { row: HTMLElement; list: HTMLElement; top: number };

const topIn = (row: HTMLElement, list: HTMLElement) => row.getBoundingClientRect().top - list.getBoundingClientRect().top;

/**
 * The row to keep still while the others open or close round it: the one that's open on the card when it is in view,
 * else the first one in view. Only a list that scrolls by itself has one: in the conversation the rows open downward
 * and nothing over them moves.
 */
function hold(host: HTMLElement | null): Held | undefined {
  const list = host?.querySelector<HTMLElement>(".simple-pass-list:not(.is-moment), .simple-edits");
  if (!list || typeof getComputedStyle !== "function" || !/auto|scroll/.test(getComputedStyle(list).overflowY)) return undefined;
  const box = list.getBoundingClientRect();
  const inView = (row: HTMLElement) => { const r = row.getBoundingClientRect(); return r.bottom > box.top + 1 && r.top < box.bottom - 1; };
  const rows = [...list.querySelectorAll<HTMLElement>(`:scope > li:not([data-low-risk]) > button`)];
  const open = rows.find(row => row.getAttribute("aria-current") === "true");
  const row = open && inView(open) ? open : rows.find(inView);
  return row && { row, list, top: topIn(row, list) };
}

/** How a low risk row opens: its room grows, then its words rise into it and settle, a few rows after one another. */
const OPEN = { room: 340, words: 280, after: 70 };
/** How it closes, quicker: its words fade and lift first, then its room folds away. */
const CLOSE = { room: 280, words: 150, after: 60 };
/** The rows in view go one after another, this far apart, up to `STAGGER_MAX` in all; the rest go together. */
const STAGGER = 24, STAGGER_MAX = 200;
/** Its room grows and folds smoothly at both ends. */
const ROOM_EASE = "cubic-bezier(.45, 0, .2, 1)";

/**
 * Open or close the low risk rows, with the held row kept where it was. Opening, each row's room grows from nothing,
 * then its words rise a few pixels into it as they fade in, with a faint wash over the row that fades after, so the
 * editor sees which rows arrived; the rows in view do it one after another, top to bottom. Closing, the words fade and
 * lift first and the room folds after them. Returns what stops it.
 */
function fold(host: HTMLElement | null, way: "in" | "out", held: Held | undefined, done?: () => void): (() => void) | undefined {
  const rows = host ? [...host.querySelectorAll<HTMLElement>(LOW_ROWS)] : [];
  if (!rows.length || !canMove()) { done?.(); return undefined; }
  const heights = rows.map(row => row.getBoundingClientRect().height);
  const view = { top: 0, bottom: typeof window !== "undefined" ? window.innerHeight : 0 };
  let seen = 0;
  const moving = rows.flatMap((row, i) => {
    const full = `${heights[i]}px`;
    const box = row.getBoundingClientRect();
    // Only the rows in view are staggered: the ones out of sight open with the first, so a long list doesn't drag on.
    const delay = way === "in" && box.bottom > view.top && box.top < view.bottom ? Math.min(STAGGER * seen++, STAGGER_MAX) : 0;
    row.style.overflowY = "clip";
    const words = row.firstElementChild as HTMLElement | null;
    if (way === "in") {
      const all = [row.animate([{ height: "0px" }, { height: full }], { duration: OPEN.room, delay, easing: ROOM_EASE, fill: "backwards" })];
      if (words) {
        all.push(words.animate([{ opacity: 0, transform: "translateY(-5px)" }, { opacity: 1, transform: "none" }],
          { duration: OPEN.words, delay: delay + OPEN.after, easing: EASE, fill: "backwards" }));
        all.push(words.animate([{ backgroundColor: "rgba(255, 255, 255, .06)" }, { backgroundColor: "rgba(255, 255, 255, 0)" }],
          { duration: 900, delay: delay + OPEN.after + OPEN.words, easing: "ease-out" }));
      }
      return all;
    }
    const all = [row.animate([{ height: full }, { height: "0px" }], { duration: CLOSE.room, delay: CLOSE.after, easing: ROOM_EASE, fill: "both" })];
    if (words) all.push(words.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }],
      { duration: CLOSE.words, easing: EASE, fill: "forwards" }));
    return all;
  });
  let frame = 0, over = false;
  const settle = () => {
    if (!held?.row.isConnected) return;
    const moved = topIn(held.row, held.list) - held.top;
    if (Math.abs(moved) > .5) held.list.scrollTop += moved;
  };
  const follow = () => { settle(); if (!over) frame = requestAnimationFrame(follow); };
  follow();
  const stop = () => {
    over = true;
    cancelAnimationFrame(frame);
    // Rows that closed stay shut until they leave the list; rows that opened are their own height again.
    if (way === "in") for (const row of rows) row.style.overflowY = "";
  };
  void Promise.all(moving.map(a => a.finished)).then(() => { if (over) return; settle(); stop(); done?.(); }, () => {});
  return () => {
    if (over) return;
    stop();
    for (const a of moving) a.cancel();
    for (const row of rows) row.style.overflowY = "";
  };
}

/**
 * Low risk edits open into For you's list and close out of it, and nothing else moves: each row grows from nothing in
 * its place, the row the editor was on stays where it was, and unticked the rows close before they leave. `shown` is
 * whether the list still draws them. With motion reduced they are there or gone at once.
 */
export function useLowRiskFold(host: RefObject<HTMLElement | null>, on: boolean, setOn: (on: boolean) => void) {
  const [closing, setClosing] = useState(false);
  const held = useRef<Held>(undefined);
  const was = useRef(on);
  useLayoutEffect(() => {
    const opened = on && !was.current;
    was.current = on;
    if (!opened) return;
    const keep = held.current;
    held.current = undefined;
    return fold(host.current, "in", keep);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!closing) return;
    const keep = held.current;
    held.current = undefined;
    return fold(host.current, "out", keep, () => setClosing(false));
  }, [closing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Included again from somewhere else while they close (an edit opened from the timeline): they stay.
  if (on && closing) setClosing(false);
  // A row on its way out of For you closes as it fades, so the rows under it don't jump up when it goes.
  useLayoutEffect(() => {
    if (!canMove()) return;
    for (const row of host.current?.querySelectorAll<HTMLElement>("li.is-leaving:not([data-closing])") ?? []) {
      row.dataset.closing = "";
      row.style.overflowY = "clip";
      row.animate([{ height: `${row.getBoundingClientRect().height}px` }, { height: "0px" }], { duration: LINGER_FADE_MS - 40, easing: EASE, fill: "forwards" });
    }
  });
  const toggle = () => {
    held.current = hold(host.current);
    if (on && canMove()) setClosing(true);
    setOn(!on);
  };
  return { shown: on || closing, closing, toggle };
}

/**
 * The low risk line goes once there is no such edit left, as once the last of them is kept. It closes rather than vanishing, so the
 * rows under it glide up: `count` is what the line still says while it closes, and `leaving` that it is on its way out.
 * Switching away from For you (`shown = false`) hides the line immediately without animating.
 */
export function useLowRiskLine(host: RefObject<HTMLElement | null>, count: number, shown = true) {
  const [left, setLeft] = useState<number>();
  const was = useRef({ count, shown });
  useLayoutEffect(() => {
    const before = was.current;
    was.current = { count, shown };
    if (!shown || count > 0) setLeft(undefined);
    else if (before.shown && before.count > 0 && canMove()) setLeft(before.count);
  }, [count, shown]);
  useLayoutEffect(() => {
    const line = left === undefined ? null : host.current?.querySelector<HTMLElement>(".simple-low-risk");
    if (!line) return;
    const style = getComputedStyle(line);
    line.style.overflowY = "clip";
    const closing = line.animate([{ height: `${line.getBoundingClientRect().height}px`, marginBottom: style.marginBottom, opacity: 1 }, { height: "0px", marginBottom: "0px", opacity: 0 }],
      { duration: FOLD_MS, easing: EASE, fill: "forwards" });
    void closing.finished.then(() => setLeft(undefined), () => {});
    return () => closing.cancel();
  }, [left]); // eslint-disable-line react-hooks/exhaustive-deps
  return !shown ? undefined : count > 0 ? { count, leaving: false } : left !== undefined ? { count: left, leaving: true } : undefined;
}
