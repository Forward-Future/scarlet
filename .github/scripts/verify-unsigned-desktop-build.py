"""Recover this release's four installers from the successful main-push Desktop workflow."""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
from zipfile import ZipFile

REPOSITORY = "Forward-Future/scarlet"
WORKFLOW = ".github/workflows/desktop.yml"
PACKAGES = {
    "aarch64-apple-darwin": ("macOS-Apple-Silicon.dmg",),
    "x86_64-apple-darwin": ("macOS-Intel.dmg",),
    "x86_64-pc-windows-msvc": ("Windows-x64-Setup.exe", "Windows-x64.msi"),
}
CI_JOBS = {"ci / Build and test (Linux)", "ci / Build and test (macOS)", "ci / Build and test (Windows)"}
NATIVE_JOBS = {"build / macOS Apple Silicon", "build / macOS Intel", "build / Windows x64"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/{path}"]))


def verify_run(run, sha, workflow_id):
    require(run["event"] == "push" and run["head_branch"] == "main" and run["head_sha"] == sha
            and run["path"] == WORKFLOW and run["workflow_id"] == workflow_id
            and run["repository"]["full_name"] == REPOSITORY and run["head_repository"]["full_name"] == REPOSITORY,
            "Expected the official Desktop workflow on the pinned main commit.")
    require(run["status"] == "completed" and run["conclusion"] == "success",
            f"Desktop run {run['id']} must finish successfully before publication.")


def verify_jobs(jobs):
    by_name = {job["name"]: job for job in jobs}
    require(len(by_name) == len(jobs), "Ambiguous duplicate job names.")
    for name in {"version"} | CI_JOBS | NATIVE_JOBS:
        require(name in by_name and by_name[name]["conclusion"] == "success", f"Missing successful {name}.")
    require(by_name.get("publish", {}).get("conclusion") == "skipped", "The ordinary publisher must have been skipped.")
    for name in NATIVE_JOBS:
        steps = {step["name"]: step["conclusion"] for step in by_name[name]["steps"]}
        platform = "Windows" if name == "build / Windows x64" else "Mac"
        for step in ("Rust tests", "Verify packaged versions and stage installers", "Upload verified installers",
                     "Inspect the staged public installers and smoke test their engine with external media tools",
                     f"Smoke test the bundled {platform} engine (ingest, render with captions, MCP)"):
            require(steps.get(step) == "success", f"{name} did not complete {step}.")
        for step in ("Sign and notarize the Mac release", "Sign the Windows application and installers"):
            require(steps.get(step) == "skipped", f"Unexpected signing state in {name}.")


def verify_artifacts(artifacts, run):
    expected = {"scarlet-desktop-" + target for target in PACKAGES}
    require(len(artifacts) == len(expected) and {item["name"] for item in artifacts} == expected,
            "Expected exactly one installer archive per desktop target.")
    for item in artifacts:
        source = item["workflow_run"]
        require(not item["expired"] and item["size_in_bytes"] > 0 and isinstance(item["id"], int) and item["id"] > 0
                and re.fullmatch(r"sha256:[0-9a-f]{64}", item["digest"])
                and source["id"] == run["id"] and source["head_sha"] == run["head_sha"]
                and source["head_branch"] == "main" and source["repository_id"] == run["repository"]["id"]
                and source["head_repository_id"] == run["repository"]["id"], "Unexpected or expired native archive.")


def extract_artifact(archive, item, version, destination):
    with archive.open("rb") as stream:
        digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    require(hmac.compare_digest(item["digest"], digest), f"Invalid archive digest for {item['name']}.")
    target = item["name"].removeprefix("scarlet-desktop-")
    expected = {f"Scarlet-{version}-{suffix}" for suffix in PACKAGES[target]}
    with ZipFile(archive) as package:
        entries = package.infolist()
        require(len(entries) == len(expected) and {f.filename for f in entries} == expected,
                f"Unexpected installer names in {item['name']}.")
        for entry in entries:
            require(entry.file_size > 0 and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG),
                    f"Not a regular installer: {entry.filename}")
            with package.open(entry) as src, (destination / entry.filename).open("xb") as out:
                shutil.copyfileobj(src, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    options = parser.parse_args()
    sha = os.environ["RELEASE_SOURCE_SHA"]
    version = os.environ["RELEASE_VERSION"]
    require(re.fullmatch(r"[0-9a-f]{40}", sha) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version),
            "Missing source pin or numeric version.")
    workflow_id = api("actions/workflows/desktop.yml")["id"]
    results = api(f"actions/workflows/{workflow_id}/runs?branch=main&event=push&head_sha={sha}&per_page=100")
    require(results["total_count"] == 1 and len(results["workflow_runs"]) == 1, "Expected exactly one official main run.")
    run = results["workflow_runs"][0]
    verify_run(run, sha, workflow_id)
    runs = f"actions/runs/{run['id']}"
    jobs = api(f"{runs}/jobs?filter=latest&per_page=100")
    require(jobs["total_count"] == len(jobs["jobs"]), "Incomplete Desktop jobs response.")
    verify_jobs(jobs["jobs"])
    artifacts = api(f"{runs}/artifacts?per_page=100")
    require(artifacts["total_count"] == len(artifacts["artifacts"]), "Incomplete Desktop artifacts response.")
    verify_artifacts(artifacts["artifacts"], run)
    options.destination.mkdir()
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "platform.zip"
        for item in artifacts["artifacts"]:
            with archive.open("wb") as stream:
                subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{item['id']}/zip"], stdout=stream, check=True)
            extract_artifact(archive, item, version, options.destination)
            print(f"Verified {item['name']}: {item['digest']}")
    print(f"Verified four installers from {run['html_url']} at {sha}.")


if __name__ == "__main__":
    main()
