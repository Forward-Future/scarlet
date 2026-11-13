import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderNotices, targetCrates } from "./collect-public-notices.mjs";

test("lists the selected target's runtime crates, including transitives, without host build tools", () => {
  const names = ["app", "runtime", "nested", "derive", "dev", "build"];
  const packages = names.map(id => ({ id, source: id === "app" ? null : "registry", targets: [{ kind: [id === "derive" ? "proc-macro" : "lib"] }] }));
  const dep = (pkg, kind = null) => ({ pkg, dep_kinds: [{ kind }] });
  const deps = { app: [dep("runtime"), dep("derive"), dep("dev", "dev"), dep("build", "build")], runtime: [dep("nested")] };
  const nodes = names.map(id => ({ id, deps: deps[id] || [] }));
  assert.deepEqual(targetCrates({ packages, resolve: { root: "app", nodes } }).map(p => p.id).sort(), ["nested", "runtime"]);
});

test("keeps every package's copyright and points identical notices at the same full text", t => {
  const dir = mkdtempSync(join(tmpdir(), "scarlet-notices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, "LICENSE"), b = join(dir, "NOTICE");
  writeFileSync(a, "Permission text\r\nCopyright Example A\r\n");
  writeFileSync(b, "Copyright Example B\n");
  const record = (name, files) => ({ name, source: `https://example.org/${name}`, license: "MIT", files });
  const text = renderNotices([record("second", [a]), record("first", [b, a, a])]);
  assert.ok(text.indexOf("first") < text.indexOf("second"));
  assert.equal(text.match(/Permission text/g)?.length, 1);
  assert.match(text, /first \(MIT\)[\s\S]*?Notice 1, 2/);
  assert.match(text, /second \(MIT\)[\s\S]*?Notice 1\n/);
  assert.match(text, /Copyright Example A/);
  assert.match(text, /Copyright Example B/);
  assert.throws(() => renderNotices([record("missing", [])]), /Missing distributed license text for missing/);
});
