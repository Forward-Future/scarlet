"""Install Scarlet's local transcription runtime and a user-supplied CrisperWhisper checkpoint."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import venv


HERE = Path(__file__).resolve().parent


def default_data_dir():
    if sys.platform == "darwin":
        parent = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        parent = Path(os.environ["APPDATA"])
    elif sys.platform == "linux":
        xdg_data = Path(os.environ.get("XDG_DATA_HOME", ""))
        parent = xdg_data if xdg_data.is_absolute() else Path.home() / ".local" / "share"
    else:
        raise ValueError("Supply --data-dir to select the Scarlet library on this platform.")
    return parent / "com.forwardfuture.scarlet" / "data"


def python_in(env):
    return env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def verify_checkpoint(directory, hashes):
    for name, expected in hashes.items():
        with (directory / name).open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != expected:
            raise ValueError(f"Checkpoint file has an unexpected SHA-256: {directory / name}")


@contextmanager
def install_lock(path):
    # OS locks are released if the installer exits or is killed.
    with path.open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as err:
            raise RuntimeError("Another CrisperWhisper setup is running for this library. Retry when it finishes.") from err
        yield


def runtime_ready(env):
    python = python_in(env)
    if not python.is_file() or not (env / "pyvenv.cfg").is_file():
        return False
    probe = """from importlib.metadata import version
import sys
from pathlib import Path
assert Path(sys.prefix).resolve() == Path(sys.argv[1]).resolve()
for pin in Path(sys.argv[2]).read_text().splitlines():
    name, expected = pin.split('==')
    assert version(name).split('+')[0] == expected, pin
import torch
from transformers import AutoProcessor, AutoModelForSpeechSeq2Seq
from crisperwhisper import CrisperWhisperModel
from crisperwhisper.audio import load_audio
"""
    return subprocess.run([str(python), "-I", "-B", "-c", probe, str(env), str(HERE / "requirements.txt")],
                          stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL).returncode == 0


def prepare_runtime(env):
    venv.EnvBuilder(with_pip=True, symlinks=os.name != "nt").create(env)
    python = str(python_in(env))
    pip = [python, "-I", "-m", "pip", "--disable-pip-version-check", "install", "--only-binary=:all:"]
    if os.name == "nt":
        # Install the CPU wheel before resolving the remaining dependencies from PyPI.
        pins = (HERE / "requirements.txt").read_text().splitlines()
        torch = next(pin for pin in pins if pin.startswith("torch=="))
        subprocess.run([*pip, "--index-url", "https://download.pytorch.org/whl/cpu", "--no-deps", torch + "+cpu"], check=True)
    subprocess.run([*pip, "-r", str(HERE / "requirements.txt")], check=True)
    if not runtime_ready(env):
        raise RuntimeError("The installed Python runtime could not import the pinned transcription libraries.")


def ensure_runtime(env):
    # Create the venv at its permanent path. pip-generated console scripts embed it.
    backup = env.with_name(".previous-venv")
    building = env.with_name(".building-venv")
    if backup.exists() and not building.exists():
        if env.exists():
            raise ValueError(f"An unexpected runtime backup is present at {backup}.")
        backup.rename(env)
    if not runtime_ready(env):
        if env.exists() and not building.exists():
            if env.is_symlink() or not (env / "pyvenv.cfg").is_file():
                raise ValueError(f"Refusing to replace an unrelated directory at {env}.")
            env.rename(backup)
        building.touch()
        try:
            if env.exists():  # Interrupted installation still owned by this setup.
                shutil.rmtree(env)
            print("Installing the pinned transcription libraries…", flush=True)
            prepare_runtime(env)
        except BaseException:
            if env.exists():
                shutil.rmtree(env)
            if backup.exists():
                backup.rename(env)
            building.unlink()
            raise
    if backup.exists():
        shutil.rmtree(backup)
    building.unlink(missing_ok=True)


def install(source, data_root):
    manifest = json.loads((HERE / "checkpoint.json").read_text())
    root = data_root / "models" / "crisperwhisper"
    root.mkdir(parents=True, exist_ok=True)
    model = root / "model"
    env = root / "venv"
    with install_lock(root / ".setup.lock"):
        with tempfile.TemporaryDirectory(prefix=".setup-", dir=root) as work:
            work = Path(work)
            hashes = manifest["sha256"]
            if model.exists():
                verify_checkpoint(source, hashes)
                if not source.samefile(model):
                    verify_checkpoint(model, hashes)
            else:
                candidate = work / "model"
                candidate.mkdir()
                for name in hashes:
                    shutil.copyfile(source / name, candidate / name)
                verify_checkpoint(candidate, hashes)

            ensure_runtime(env)
            if not model.exists():
                (work / "model").rename(model)
            shutil.copyfile(HERE / "crisper_cli.py", work / "crisper_cli.py")
            os.replace(work / "crisper_cli.py", root / "crisper_cli.py")
    print(f"CrisperWhisper is ready in {root}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="Local official model snapshot directory.")
    parser.add_argument("--data-dir", type=Path, help="Scarlet data root containing models/.")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        parser.error("Use 64-bit CPython 3.12 to install the pinned runtime.")
    try:
        install(args.model.expanduser().resolve(), (args.data_dir or default_data_dir()).expanduser().resolve())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as err:
        parser.exit(1, f"Setup failed: {err}\n")


if __name__ == "__main__":
    main()
