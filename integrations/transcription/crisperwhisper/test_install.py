import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from install import ensure_runtime, verify_checkpoint


class SetupTest(unittest.TestCase):
    def test_checks_local_checkpoint_content(self):
        with TemporaryDirectory() as directory:
            model = Path(directory)
            (model / "sample").write_bytes(b"example")
            expected = {"sample": hashlib.sha256(b"example").hexdigest()}
            verify_checkpoint(model, expected)
            (model / "sample").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                verify_checkpoint(model, expected)

    def test_restores_an_existing_environment_after_failed_repair(self):
        with TemporaryDirectory() as directory:
            env = Path(directory) / "venv"
            env.mkdir()
            (env / "pyvenv.cfg").write_text("old")
            with patch("install.runtime_ready", return_value=False), \
                    patch("install.prepare_runtime", side_effect=RuntimeError("test failure")):
                with self.assertRaisesRegex(RuntimeError, "test failure"):
                    ensure_runtime(env)
            self.assertEqual((env / "pyvenv.cfg").read_text(), "old")
            self.assertEqual(list(env.parent.iterdir()), [env])

    def test_leaves_an_unrelated_directory_in_place(self):
        with TemporaryDirectory() as directory:
            env = Path(directory) / "venv"
            env.mkdir()
            with self.assertRaisesRegex(ValueError, "unrelated"):
                ensure_runtime(env)
            self.assertTrue(env.is_dir())


if __name__ == "__main__":
    unittest.main()
