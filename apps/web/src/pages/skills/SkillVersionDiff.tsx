import { Fragment } from "react";
import type { SkillVersion } from "@scarlet/shared";
import { clockTime, dayName } from "../../lib/format";
import type { DiffLine } from "../../lib/textDiff";
import { markSkillMatches, type SkillFindState } from "../../components/agent/SkillFind";

/** How many versions the history lists before "Show N older versions". */
export const LATEST_VERSIONS = 8;

/** Who saved a version: "You", a teammate by name, or Scarlet, with what asked it to when Scarlet wrote it. */
export function savedBy(v: SkillVersion, me?: string): string {
  if (!v.author) return "";
  if (v.author.type === "human") return v.author.id === me ? "You" : v.author.name;
  return v.from === "request" ? "Scarlet, from your request" : v.from === "learning" ? "Scarlet, from Learnings" : "Scarlet";
}

/** The line over a picked version: whose change it is, and when. */
export function changedIn(v: SkillVersion, me?: string): string {
  const who = savedBy(v, me);
  const [name, from] = who.startsWith("Scarlet, ") ? ["Scarlet", who.slice("Scarlet, ".length)] : [who === "You" ? "you" : who, ""];
  const when = v.createdAt ? ` · ${dayName(v.createdAt)}, ${clockTime(v.createdAt)}` : "";
  if (v.version === 1) return `v1, the first version${when}`;
  return `What ${name || "was"} changed in v${v.version}${from ? `, ${from}` : ""}${when}`;
}

/** Text with what changed marked in it: a bar beside each changed line, taken-out words struck, added ones tinted. */
export function ChangedText({ lines, find }: { lines: DiffLine[]; find?: SkillFindState }) {
  let offset = 0;
  return <>{lines.map((line, i) => {
    const pieces = line.pieces.map((piece, k) => {
      if (piece.kind === "del") return <del key={k}>{piece.text}</del>;
      const marked = markSkillMatches(piece.text, offset, find);
      offset += piece.text.length;
      return piece.kind === "add" ? <ins key={k}>{marked}</ins> : <Fragment key={k}>{marked}</Fragment>;
    });
    if (line.pieces.some(piece => piece.kind !== "del")) offset++;
    return <div key={i} data-changed={line.changed ? "" : undefined}>
      {pieces}
      {/* An empty line keeps its height. */}
      {!line.pieces.some(piece => piece.text) && "\u200b"}
    </div>;
  })}</>;
}
