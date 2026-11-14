// The old and new installed engines run separately, with the same disposable profile.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { smokeEnvironment, startSmokeEngine } from "./smoke-engine-startup.mjs";
import { earlyAccessId } from "./early-access-product.mjs";

const [mode, engine, expectedFile, installedVersion] = process.argv.slice(2);
assert.ok(["seed", "verify"].includes(mode) && engine && expectedFile);
const appData = process.platform === "win32" ? process.env.APPDATA : join(process.env.HOME, "Library", "Application Support");
const library = join(appData, earlyAccessId);
const env = smokeEnvironment(library);
if (process.platform === "win32") {
  // The old engine uses Windows PowerShell's built-in New-Object cmdlet.
  env.PSModulePath = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
}
// The released 0.1.3 Windows engine starts several Windows PowerShell processes for ACLs
// in a fresh profile. Allow that historical build to prepare the fixture for the upgrade.
const historicalWindows = process.platform === "win32" && installedVersion === "0.1.3";
const started = Date.now();
const { child, ready, exited } = await startSmokeEngine(resolve(engine), library, env, historicalWindows ? 240_000 : undefined);
console.log(`Installed engine ready after ${((Date.now() - started) / 1000).toFixed(1)} seconds.`);

async function api(method, path, body) {
  const response = await fetch(ready.url + "/api" + path, {
    method,
    headers: { authorization: "Bearer " + ready.token, "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(method + " " + path + " returned " + response.status + ": " + await response.text());
  return response.json();
}

try {
  assert.equal(realpathSync(ready.dataDir), realpathSync(join(library, "data")));
  if (mode === "seed") {
    const { project } = await api("POST", "/projects", { name: "Early Access upgrade fixture", settings: { fps: 25 } });
    const { skill } = await api("POST", "/skills", { name: "upgrade-fixture", content: "Original editor guide." });
    await api("PUT", "/skills/" + skill.id, { content: "Updated editor guide." });
    await api("PATCH", "/settings", { transcription: { provider: "openai" } });
    const { change } = await api("POST", "/projects/" + project.id + "/changes", {
      description: "Add a caption",
      ops: [
        { op: "addTrack", track: { id: "captions", kind: "caption", name: "Captions", clips: [] } },
        { op: "addClip", trackId: "captions", clip: { id: "upgrade-caption", kind: "caption", timelineIn: 0, timelineOut: 2, text: "Saved before upgrade" } },
      ],
    });
    await api("POST", "/changes/" + change.id + "/approve", {});
    const { timeline } = await api("GET", "/projects/" + project.id);
    const { versions } = await api("GET", "/skills/" + skill.id);
    assert.equal(versions.length, 2);
    assert.ok(change.toVersion && timeline);
    writeFileSync(expectedFile, JSON.stringify({ project: project.id, head: change.toVersion, timeline, skill: skill.id, versions, user: ready.userId }), { flag: "wx" });
  }
  const expected = JSON.parse(readFileSync(expectedFile, "utf8"));
  const saved = await api("GET", "/projects/" + expected.project);
  assert.equal(saved.project.name, "Early Access upgrade fixture");
  assert.equal(saved.project.head, expected.head);
  assert.deepEqual(saved.timeline, expected.timeline);
  assert.ok((await api("GET", "/projects")).projects.some(project => project.id === expected.project));
  const { skill, versions } = await api("GET", "/skills/" + expected.skill);
  assert.equal(skill.content, "Updated editor guide.");
  assert.deepEqual(versions, expected.versions);
  assert.equal((await api("GET", "/settings")).settings.transcription.provider, "openai");
  assert.equal(ready.userId, expected.user);
  console.log(mode + " passed for the saved project, approved timeline, skill history, preference and local user.");
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 15_000);
  try { assert.equal((await exited).code, 0, "The engine must close the library cleanly"); }
  finally { clearTimeout(timer); }
}
