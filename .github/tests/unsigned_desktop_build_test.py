import hashlib
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

spec = spec_from_file_location("verify_build", Path(__file__).resolve().parents[1] / "scripts/verify-unsigned-desktop-build.py")
build = module_from_spec(spec)
spec.loader.exec_module(build)


class UnsignedBuildTest(unittest.TestCase):
    def setUp(self):
        self.sha = "1" * 40
        repo = {"id": 7, "full_name": build.REPOSITORY}
        self.run = {"id": 304, "event": "push", "head_branch": "main", "head_sha": self.sha,
                    "path": build.WORKFLOW, "workflow_id": 3, "repository": repo, "head_repository": repo,
                    "status": "completed", "conclusion": "success"}
        self.artifacts = [
            {"id": 41 + i, "name": "scarlet-desktop-" + target, "digest": "sha256:" + "a"*64,
             "size_in_bytes": 280, "expired": False, "workflow_run": {"head_branch": "main", "head_sha": self.sha,
             "id": 304, "head_repository_id": 7, "repository_id": 7}}
            for i, target in enumerate(build.PACKAGES)
        ]

    def test_only_completed_official_runs_on_the_pinned_sha(self):
        build.verify_run(self.run, self.sha, 3)
        for fields in [{"event": "pull_request"}, {"head_branch": "other"}, {"head_sha": "2"*40},
                       {"path": ".github/workflows/other.yml"}, {"workflow_id": 4},
                       {"head_repository": {"full_name": "other/fork"}}, {"status": "in_progress"},
                       {"conclusion": "failure"}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                build.verify_run({**self.run, **fields}, self.sha, 3)

    def test_all_protected_jobs_and_final_archive_tests_pass(self):
        jobs = [{"name": name, "conclusion": "success"} for name in {"version"} | build.CI_JOBS]
        for name in build.NATIVE_JOBS:
            if name.endswith("Windows x64"):
                platform_checks = ("Verify Windows library permissions", "Check Windows engine startup before building native dependencies")
            else:
                platform_checks = ("Check binary architectures", "Test local main updater", "Check the Mac app's code signature")
            steps = [{"name": n, "conclusion": "success"} for n in (
                "Rust tests", "Verify packaged versions and stage installers", "Upload verified installers",
                "Inspect the staged public installers and smoke test their engine with external media tools",
                "Build installers", *platform_checks)]
            steps.extend({"name": n, "conclusion": "skipped"} for n in (
                "Sign and notarize the Mac release", "Sign the Windows application and installers",
                "Smoke test the bundled Mac engine (ingest, render with captions, MCP)",
                "Smoke test the bundled Windows engine (ingest, render with captions, MCP)"))
            jobs.append({"name": name, "conclusion": "success", "steps": steps})
        jobs.append({"name": "publish", "conclusion": "skipped"})
        build.verify_jobs(jobs)
        with self.assertRaises(ValueError):
            build.verify_jobs(jobs[1:])
        with self.assertRaises(ValueError):
            build.verify_jobs(jobs + [jobs[0]])
        for native in (job for job in jobs if job["name"] in build.NATIVE_JOBS):
            for step in native["steps"]:
                before = step["conclusion"]
                step["conclusion"] = "skipped" if before == "success" else "success"
                with self.subTest(job=native["name"], step=step["name"]), self.assertRaises(ValueError):
                    build.verify_jobs(jobs)
                step["conclusion"] = before

    def test_three_native_archives_share_main_run_provenance(self):
        build.verify_artifacts(self.artifacts, self.run)
        for removed_or_duplicate in [self.artifacts[:-1], self.artifacts + [self.artifacts[0]]]:
            with self.assertRaises(ValueError):
                build.verify_artifacts(removed_or_duplicate, self.run)
        first, *other = self.artifacts
        for changed in [{"expired": True}, {"digest": ""}, {"workflow_run": {**first["workflow_run"], "id": 309}},
                        {"workflow_run": {**first["workflow_run"], "head_repository_id": 9}}]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                build.verify_artifacts([{**first, **changed}, *other], self.run)

    def test_archive_digest_and_exact_platform_filenames(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            archive = root / "windows.zip"
            item = dict(self.artifacts[2])
            names = ["Scarlet-0.1.10-Windows-x64-Setup.exe", "Scarlet-0.1.10-Windows-x64.msi"]
            for names_in_archive in [names, names[:1], names + ["extra"], ["../" + names[0], names[1]],
                                     ["Scarlet-0.1.11-Windows-x64-Setup.exe", names[1]]]:
                with ZipFile(archive, "w") as out:
                    for name in names_in_archive:
                        out.writestr(name, b"fixture")
                with self.assertRaises(ValueError):
                    build.extract_artifact(archive, {**item, "digest": "sha256:" + "0"*64}, "0.1.10", root)
                item["digest"] = "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest()
                if names_in_archive == names:
                    build.extract_artifact(archive, item, "0.1.10", root)
                    for name in names:
                        self.assertEqual((root / name).read_bytes(), b"fixture")
                        (root / name).unlink()
                else:
                    with self.assertRaises(ValueError):
                        build.extract_artifact(archive, item, "0.1.10", root)


if __name__ == "__main__":
    unittest.main()
