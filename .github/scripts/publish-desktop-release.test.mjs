import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishDesktopRelease } from "./publish-desktop-release.mjs";

const sha = "f2e8c84ce4d58ee9d8ee1f1d21b2c46ebee30d82";
const otherSha = "2".repeat(40);
const version = "0.1.20";
const tag = "v" + version;
const unsigned = { unsignedOnce: true, runId: "1234" };
const names = ["macOS-Apple-Silicon.dmg", "macOS-Intel.dmg", "Windows-x64-Setup.exe", "Windows-x64.msi"]
  .map(suffix => `Scarlet-${version}-${suffix}`);
const content = name => Buffer.from("fixture-" + name);
const asset = name => ({ name, id: names.indexOf(name) + 1, state: "uploaded", size: content(name).length,
  digest: "sha256:" + createHash("sha256").update(content(name)).digest("hex") });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "scarlet-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) await writeFile(path.join(directory, name), content(name));
  const state = {
    ref: null, release: null, assets: [], writes: [], rejectUpload: null, corruptDigest: false,
    draft: { id: 17, tag_name: tag, target_commitish: sha, draft: true, prerelease: false,
      html_url: "https://github.com/Forward-Future/scarlet/releases/tag/" + tag },
  };
  const fetchImpl = async (url, { method, body }) => {
    const endpoint = new URL(url);
    const route = endpoint.pathname.replace("/repos/Forward-Future/scarlet", "");
    const reply = data => Response.json(data);
    if (method !== "GET") state.writes.push(method + " " + route);
    if (method === "GET" && route === "/git/ref/tags/" + tag) {
      return state.ref ? reply({ object: state.ref }) : new Response(null, { status: 404 });
    }
    if (method === "GET" && route === "/git/tags/" + otherSha) return reply({ object: { sha, type: "commit" } });
    if (method === "GET" && route === "/releases") return reply(state.release ? [state.release] : []);
    if (method === "POST" && route === "/git/refs") {
      assert.deepEqual(JSON.parse(body), { ref: "refs/tags/" + tag, sha });
      if (state.rejectTag) return new Response("temporarily unavailable", { status: 503 });
      state.ref = { type: "commit", sha };
      return reply({ object: state.ref });
    }
    if (method === "POST" && route === "/releases") {
      const data = JSON.parse(body);
      assert.equal(data.target_commitish, sha);
      assert.equal(data.tag_name, tag);
      assert.equal(data.draft, true);
      assert.equal(data.prerelease, false);
      state.release = { ...state.draft, ...data };
      return reply(state.release);
    }
    if (method === "GET" && route === "/releases/17/assets") return reply(state.assets);
    if (method === "POST" && route === "/releases/17/assets") {
      const name = endpoint.searchParams.get("name");
      assert.equal(endpoint.hostname, "uploads.github.com");
      if (name === state.rejectUpload) return new Response("upstream", { status: 502 });
      assert.deepEqual(Buffer.from(await body.arrayBuffer()), content(name));
      assert.ok(!state.assets.some(file => file.name === name));
      const file = asset(name);
      if (state.corruptDigest) file.digest = "sha256:" + "0".repeat(64);
      if (name === state.retargetAfterUpload) state.ref = { type: "commit", sha: otherSha };
      if (name === state.editNotesAfterUpload) state.release.body = "Missing signing disclosure";
      state.assets.push(file);
      return reply(file);
    }
    if (method === "DELETE" && route.startsWith("/releases/assets/")) {
      const index = state.assets.findIndex(file => file.id === Number(route.split("/").pop()));
      assert.ok(index >= 0);
      state.assets.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && route === "/releases/17") {
      assert.deepEqual(JSON.parse(body), { draft: false, make_latest: "legacy" });
      assert.deepEqual(state.assets.map(file => file.name).sort(), names.slice().sort());
      state.release.draft = false;
      return reply(state.release);
    }
    throw new Error("Unexpected API request: " + method + " " + route);
  };
  return Object.assign(state, { directory, publish: (options = {}) => publishDesktopRelease({ version, directory,
    repository: "Forward-Future/scarlet", sha, token: "fixture-token", fetchImpl, ...options }) });
}

test("publishes one verified stable release and leaves a subsequent rerun read-only", async t => {
  const remote = await fixture(t);
  assert.equal(await remote.publish(), remote.draft.html_url);
  assert.equal(remote.release.draft, false);
  assert.equal(remote.writes.filter(write => write === "POST /releases/17/assets").length, 4);
  assert.doesNotMatch(remote.release.body, /are unsigned|ad hoc signed/);
  remote.writes.length = 0;
  await remote.publish();
  assert.deepEqual(remote.writes, []);
});

test("resumes a partial draft and recovers an empty interrupted upload", async t => {
  const remote = await fixture(t);
  remote.rejectUpload = names[1];
  await assert.rejects(remote.publish, /502/);
  assert.equal(remote.release.draft, true);
  assert.deepEqual(remote.assets.map(file => file.name), [names[0]]);
  remote.assets.push({ name: names[1], id: 42, state: "starter", size: 0 });
  remote.writes.length = 0;
  remote.rejectUpload = null;
  await remote.publish();
  assert.ok(remote.writes.includes("DELETE /releases/assets/42"));
  assert.equal(remote.writes.filter(write => write === "POST /releases/17/assets").length, 3);
});

test("accepts a preexisting annotated tag for the exact release revision", async t => {
  const remote = await fixture(t);
  remote.ref = { type: "tag", sha: otherSha };
  await remote.publish();
  assert.ok(!remote.writes.includes("POST /git/refs"));
});

test("rejects a tag for another commit or a draft for another build without changing it", async t => {
  const remote = await fixture(t);
  remote.ref = { type: "commit", sha: otherSha };
  await assert.rejects(remote.publish, /points to/);
  remote.ref = null;
  remote.release = { ...remote.draft, target_commitish: otherSha };
  await assert.rejects(remote.publish, /does not belong/);
  remote.release = { ...remote.draft, prerelease: true };
  await assert.rejects(remote.publish, /does not belong/);
  assert.deepEqual(remote.writes, []);
});

test("rejects unexpected or missing local files before modifying any tags or releases", async t => {
  const remote = await fixture(t);
  await rm(path.join(remote.directory, names[3]));
  await writeFile(path.join(remote.directory, "different.msi"), "wrong asset");
  await assert.rejects(remote.publish, /exactly these four/);
  await rm(path.join(remote.directory, "different.msi"));
  await assert.rejects(remote.publish, /exactly these four/);
  await writeFile(path.join(remote.directory, names[3]), "");
  await assert.rejects(remote.publish, /Empty installer/);
  assert.deepEqual(remote.writes, []);
});

test("refuses changed or extra remote assets and never repairs a published release", async t => {
  const remote = await fixture(t);
  remote.ref = { type: "commit", sha };
  remote.release = { ...remote.draft, draft: false };
  remote.assets = names.slice(1).map(asset);
  await assert.rejects(remote.publish, /is missing/);
  remote.assets.push({ ...asset(names[0]), digest: "sha256:wrong" });
  await assert.rejects(remote.publish, /does not match/);
  remote.assets = [...names.map(asset), { ...asset(names[0]), name: "extra.dmg" }];
  await assert.rejects(remote.publish, /Unexpected or duplicate/);
  assert.deepEqual(remote.writes, []);
});

test("a server-side upload digest mismatch keeps the release in draft", async t => {
  const remote = await fixture(t);
  remote.corruptDigest = true;
  await assert.rejects(remote.publish, /does not match/);
  assert.equal(remote.release.draft, true);
  assert.ok(!remote.writes.some(write => write.startsWith("PATCH")));
});

test("a concurrent tag change blocks publication after all the uploads", async t => {
  const remote = await fixture(t);
  remote.retargetAfterUpload = names.at(-1);
  await assert.rejects(remote.publish, /changed during upload/);
  assert.equal(remote.release.draft, true);
  assert.ok(!remote.writes.some(write => write.startsWith("PATCH")));
});

test("the unsigned exception uploads exactly four verified installers and discloses their signing and media setup", async t => {
  const remote = await fixture(t);
  await remote.publish(unsigned);
  assert.equal(remote.release.draft, false);
  assert.deepEqual(remote.assets.map(file => file.name), names);
  assert.match(remote.release.body, /macOS apps are ad hoc signed and have not been notarized by Apple/);
  assert.match(remote.release.body, /Both Windows installers are unsigned/);
  assert.ok(remote.release.body.includes(`https://raw.githubusercontent.com/Forward-Future/scarlet/${sha}/apps/desktop/scripts/Install-Scarlet-FFmpeg-macOS.sh`));
  assert.match(remote.release.body, /winget install --id Gyan\.FFmpeg\.Essentials --exact/);
  for (const file of remote.assets) assert.ok(remote.release.body.includes(`${file.digest.slice(7)}  ${file.name}`));
  remote.writes.length = 0;
  assert.equal(await remote.publish(unsigned), remote.draft.html_url);
  assert.deepEqual(remote.writes, []);
});

test("the unsigned exception rejects another version, another revision, an existing draft, or a preexisting exact tag", async t => {
  const remote = await fixture(t);
  for (const override of [{ repository: "another/scarlet" }, { version: "9.9.9" }, { sha: otherSha }]) {
    await assert.rejects(remote.publish({ ...unsigned, ...override }), /does not authorize/);
  }
  remote.release = remote.draft;
  await assert.rejects(remote.publish(unsigned), /does not match the notes/);
  remote.release = null;
  remote.ref = { type: "commit", sha };
  await assert.rejects(remote.publish(unsigned), /already exists/);
  assert.deepEqual(remote.writes, []);
});

test("only the original run resumes its partial unsigned draft and its empty interrupted upload", async t => {
  const remote = await fixture(t);
  remote.rejectUpload = names[2];
  await assert.rejects(remote.publish(unsigned), /502/);
  assert.equal(remote.release.draft, true);
  remote.writes.length = 0;
  remote.rejectUpload = null;
  await assert.rejects(remote.publish({ ...unsigned, runId: "5678" }), /does not match the notes/);
  await assert.rejects(remote.publish(), /Only the original unsigned workflow/);
  assert.deepEqual(remote.writes, []);
  remote.assets.push({ name: names[2], id: 42, state: "starter", size: 0 });
  assert.equal(await remote.publish(unsigned), remote.draft.html_url);
  assert.deepEqual(remote.writes, ["DELETE /releases/assets/42", "POST /releases/17/assets", "POST /releases/17/assets", "PATCH /releases/17"]);
});

test("an unsigned draft whose release notes change during upload stays private", async t => {
  const remote = await fixture(t);
  remote.editNotesAfterUpload = names.at(-1);
  await assert.rejects(remote.publish(unsigned), /changed during upload/);
  assert.equal(remote.release.draft, true);
  assert.ok(!remote.writes.some(write => write.startsWith("PATCH")));
});

test("a failure to create its tag leaves a marked unsigned draft that the same run can resume", async t => {
  const remote = await fixture(t);
  remote.rejectTag = true;
  await assert.rejects(remote.publish(unsigned), /503/);
  assert.equal(remote.ref, null);
  assert.equal(remote.release.draft, true);
  assert.match(remote.release.body, /<!-- scarlet-unsigned-release-run: 1234 -->/);
  assert.deepEqual(remote.writes, ["POST /releases", "POST /git/refs"]);
  remote.writes.length = 0;
  remote.rejectTag = false;
  assert.equal(await remote.publish(unsigned), remote.draft.html_url);
  assert.equal(remote.writes[0], "POST /git/refs");
  assert.ok(!remote.writes.includes("POST /releases"));
});

test("the same unsigned run refuses changed existing bytes, notes and tags without writing", async t => {
  const remote = await fixture(t);
  remote.rejectUpload = names[1];
  await assert.rejects(remote.publish(unsigned), /502/);
  remote.writes.length = 0;
  remote.assets[0].digest = "sha256:wrong";
  await assert.rejects(remote.publish(unsigned), /does not match this build/);
  remote.assets[0] = asset(names[0]);
  const expectedNotes = remote.release.body;
  remote.release.body += " altered";
  await assert.rejects(remote.publish(unsigned), /does not match the notes/);
  remote.release.body = expectedNotes;
  remote.ref = { type: "commit", sha: otherSha };
  await assert.rejects(remote.publish(unsigned), /points to/);
  assert.deepEqual(remote.writes, []);
});
