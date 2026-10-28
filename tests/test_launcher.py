#!/usr/bin/env python3
"""Checks for the pull-and-run launcher, without touching git or the network."""
import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(tempfile.mkdtemp(prefix="kizzey-launcher-test-"))

checks = []


def check(condition, label, extra=""):
    checks.append(bool(condition))
    if condition:
        print(f"ok: {label}")
    else:
        print(f"FAIL: {label}" + (f" — {extra}" if extra else ""))


spec = importlib.util.spec_from_file_location("script_pull", ROOT / "script_pull.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def run(argv):
    execs = []
    chdirs = []
    original_execv = launcher.os.execv
    original_chdir = launcher.os.chdir
    original_argv = sys.argv
    launcher.os.execv = lambda path, args: execs.append((path, list(args)))
    launcher.os.chdir = lambda path: chdirs.append(str(path))
    sys.argv = ["script_pull.py", *argv]
    try:
        code = launcher.main()
    finally:
        launcher.os.execv = original_execv
        launcher.os.chdir = original_chdir
        sys.argv = original_argv
    return code, execs, chdirs


def main():
    try:
        target = WORK / "checkout"
        target.mkdir(parents=True, exist_ok=True)
        (target / "server.py").write_text("# stub\n")
        (target / "data").mkdir()

        code, execs, chdirs = run(
            ["--no-pull", "--dir", str(target), "--port", "9123", "--host", "127.0.0.1"]
        )
        check(code == 0, "a local checkout starts", str(code))
        check(len(execs) == 1, "the server replaces the launcher process")
        command = execs[0][1] if execs else []
        check(command[:2] == [sys.executable, str(target / "server.py")], "the command runs the checkout's server", str(command))
        check(command[2:] == ["--port", "9123", "--host", "127.0.0.1"], "server flags are forwarded in order", str(command))
        check(chdirs == [str(target)], "the server runs from the checkout directory", str(chdirs))

        code, execs, _ = run(["--no-pull", "--update-only", "--dir", str(target)])
        check(code == 0 and not execs, "--update-only stops before starting")

        empty = WORK / "empty"
        empty.mkdir()
        code, execs, _ = run(["--no-pull", "--dir", str(empty)])
        check(code == 1 and not execs, "a missing server.py fails clearly", str(code))

        missing = WORK / "not-cloned"
        code, execs, _ = run(["--no-pull", "--dir", str(missing)])
        check(code == 1 and not execs, "an absent checkout is reported", str(code))

        text = (ROOT / "script_pull.py").read_text()
        check("--ff-only" in text, "updates never force a merge")
        check("--update-only" in text and "--no-pull" in text, "launcher exposes both escape hatches")

        readme = (ROOT / "README.md").read_text()
        check("script_pull.py" in readme, "README documents the launcher")

        print(f"\n{sum(checks)}/{len(checks)} launcher checks passed")
        return 0 if all(checks) else 1
    finally:
        shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
