// Time the public interchange functions with and without Scarlet metadata.
import assert from "node:assert/strict";
import { createProject, timelineFromKeepRanges, toOtio, fromOtio } from "../dist/index.js";

const count = Number(process.argv[2] ?? 2400);
const sources = Number(process.argv[3] ?? 1);
assert([count, sources].every(n => Number.isSafeInteger(n) && n > 0));
const project = createProject("Interview");
project.media = Array.from({ length: sources }, (_, i) => ({ id: "cam" + i, kind: "video",
  name: "Recording" + i + ".mp4", path: "recording" + i + ".mp4", duration: count * 5 }));
const tl = timelineFromKeepRanges(project.id, "cam0", Array.from({ length: count }, (_, i) => ({ start: i * 5, end: i * 5 + 4 })));
tl.tracks[0].clips.forEach((c, i) => { c.mediaId = project.media[i % sources].id; });
function measure(label, run) {
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    const result = run();
    if (i > 1) samples.push(performance.now() - start);
    assert(result);
  }
  console.log(label, samples.sort((a, b) => a - b)[3].toFixed(2), "ms");
}
measure("OTIO export", () => toOtio(project, tl));
const doc = toOtio(project, tl);
function check() {
  const clips = fromOtio(doc, project, tl).tracks[0].clips;
  assert.equal(clips.length, count);
  assert.equal(clips.at(-1).id, tl.tracks[0].clips.at(-1).id);
  return clips;
}
measure("OTIO import with metadata", check);
for (const track of doc.tracks.children) for (const item of track.children) {
  delete item.metadata?.scarlet;
  const ref = item.media_references?.DEFAULT_MEDIA;
  if (ref?.metadata) delete ref.metadata.scarlet;
}
measure("OTIO import with clip names", check);
const linked = structuredClone(doc.tracks.children[0]);
linked.kind = "Audio";
delete linked.metadata?.scarlet;
doc.tracks.children.push(linked);
measure("OTIO import with linked camera audio", check);
