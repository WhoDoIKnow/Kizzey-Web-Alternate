#!/usr/bin/env python3
"""Checks for the pull-and-run launcher, without touching git or the network."""
import importlib.util
import json
import os
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
        check("ls-remote" in text, "the launcher checks the remote tip before pulling")

        # Incremental pull: an unchanged checkout skips the fetch entirely.
        repo_dir = WORK / "repo"
        (repo_dir / ".git").mkdir(parents=True)
        git_calls = []

        def stub_git(replies):
            def fake(args, cwd=None):
                git_calls.append(list(args))
                key = " ".join(args)
                for prefix, reply in replies.items():
                    if key.startswith(prefix):
                        return launcher.subprocess.CompletedProcess(["git", *args], reply[0], reply[1])
                return launcher.subprocess.CompletedProcess(["git", *args], 1, "")
            return fake

        real_run_git = launcher.run_git
        try:
            launcher.run_git = stub_git({
                "rev-parse HEAD": (0, "cafe1234\n"),
                f"ls-remote {launcher.DEFAULT_REPO}": (0, "cafe1234\trefs/heads/main\n"),
            })
            code = launcher.pull(repo_dir, launcher.DEFAULT_REPO, "main")
            check(code == 0, "an up-to-date checkout pulls cleanly", str(code))
            check(not any(call[0] == "fetch" for call in git_calls), "an up-to-date checkout skips the fetch")
            check(not any(call[0] == "pull" for call in git_calls), "an up-to-date checkout skips the pull")

            git_calls.clear()
            launcher.run_git = stub_git({
                "rev-parse HEAD": (0, "cafe1234\n"),
                f"ls-remote {launcher.DEFAULT_REPO}": (0, "beef5678\trefs/heads/main\n"),
                "fetch": (0, ""),
                "pull": (0, "Fast-forward\n"),
            })
            code = launcher.pull(repo_dir, launcher.DEFAULT_REPO, "main")
            check(code == 0, "a stale checkout pulls cleanly", str(code))
            check(any(call[0] == "fetch" for call in git_calls), "a stale checkout fetches first")
            check(any(call[:2] == ["pull", "--ff-only"] for call in git_calls), "a stale checkout fast-forwards")

            git_calls.clear()
            launcher.run_git = stub_git({
                "rev-parse HEAD": (0, "cafe1234\n"),
                f"ls-remote {launcher.DEFAULT_REPO}": (1, ""),
                "rev-parse origin/main": (0, "cafe1234\n"),
                "fetch": (0, ""),
            })
            code = launcher.pull(repo_dir, launcher.DEFAULT_REPO, "main")
            check(code == 0, "a blocked ls-remote falls back to the fetched tip", str(code))
            check(not any(call[0] == "pull" for call in git_calls), "the fetched-tip comparison skips the pull")
        finally:
            launcher.run_git = real_run_git

        readme = (ROOT / "README.md").read_text()
        check("script_pull.py" in readme, "README documents the launcher")

        # -- voice companion selection -----------------------------------------
        class VoiceArgs:
            def __init__(self, **kw):
                self.no_voice = False
                self.voice = False
                self.voice_required = False
                self.voice_install = False
                self.voice_host = "127.0.0.1"
                self.voice_port = 8421
                self.voice_token = ""
                self.discord_token = ""
                for key, value in kw.items():
                    setattr(self, key, value)

        class FakeProc:
            returncode = None

            def poll(self):
                return None

        voice_dir = WORK / "voice-checkout"
        (voice_dir / "voice_service").mkdir(parents=True)
        (voice_dir / "server.py").write_text("# stub\n")
        (voice_dir / "voice_service" / "voice_service.py").write_text("# stub\n")

        real_check = launcher.check_voice_dependencies
        real_start = launcher.start_voice_service
        real_probe = launcher.probe_voice_health
        real_companion = launcher.start_voice_companion
        real_supervisor = launcher.run_supervisor
        pushed_url = os.environ.pop("KIZZEY_VOICE_URL", None)
        try:
            launcher.check_voice_dependencies = lambda python, target: (
                False,
                "the Discord voice packages are not installed.",
            )
            launcher.start_voice_service = lambda *a, **k: (_ for _ in ()).throw(
                AssertionError("the companion should not start")
            )
            process, env = launcher.start_voice_companion(VoiceArgs(), voice_dir)
            check(process is None and not env, "auto mode skips the companion when dependencies are missing")

            process, env = launcher.start_voice_companion(VoiceArgs(no_voice=True), voice_dir)
            check(process is None and not env, "--no-voice never starts the companion")

            process, env = launcher.start_voice_companion(VoiceArgs(voice=True), voice_dir)
            check(process is None and env.get("error"), "--voice fails clearly when the companion cannot start")

            launcher.check_voice_dependencies = lambda python, target: (True, "")
            started = {}

            def fake_start(python, target, host, port, token, discord_token):
                started.update(host=host, port=port, token=token, discord_token=discord_token)
                return FakeProc()

            launcher.start_voice_service = fake_start
            launcher.probe_voice_health = lambda host, port, process=None: True
            process, env = launcher.start_voice_companion(
                VoiceArgs(voice=True, voice_port=8500, voice_token="s3cret", discord_token="bot-token"),
                voice_dir,
            )
            check(process is not None, "--voice starts the companion when ready")
            check(
                env.get("KIZZEY_VOICE_URL") == "http://127.0.0.1:8500",
                "a healthy companion points Kizzey at it",
                str(env),
            )
            check(env.get("KIZZEY_VOICE_TOKEN") == "s3cret", "the voice token reaches Kizzey through the environment")
            check(started.get("token") == "s3cret", "the voice token reaches the companion")
            check(started.get("discord_token") == "bot-token", "the Discord token reaches the companion")

            # With nothing configured, both tokens fall back to the saved RPC token.
            (voice_dir / "data").mkdir(exist_ok=True)
            (voice_dir / "data" / "secret.json").write_text(
                json.dumps({"token": "rpc-token-123", "accounts": [{"token": "other"}]})
            )
            started.clear()
            process, env = launcher.start_voice_companion(VoiceArgs(voice=True), voice_dir)
            check(started.get("token") == "rpc-token-123", "the saved RPC token becomes the voice token", str(started))
            check(
                started.get("discord_token") == "rpc-token-123",
                "the saved RPC token is the companion Discord login",
                str(started),
            )
            check(
                env.get("KIZZEY_VOICE_TOKEN") == "rpc-token-123",
                "the RPC token is handed to Kizzey",
                str(env),
            )
            check(launcher.rpc_token(voice_dir) == "rpc-token-123", "rpc_token reads the active account")

            (voice_dir / "data" / "secret.json").write_text(json.dumps({"token": "", "accounts": [{"token": "acct"}]}))
            check(launcher.rpc_token(voice_dir) == "acct", "rpc_token falls back to the first account")
            (voice_dir / "data" / "secret.json").write_text("{not json")
            check(launcher.rpc_token(voice_dir) == "", "rpc_token tolerates a broken file")
            (voice_dir / "data" / "secret.json").unlink()
            check(launcher.rpc_token(voice_dir) == "", "rpc_token is empty before sign-in")

            os.environ["KIZZEY_VOICE_URL"] = "http://voice.example:9000"
            process, env = launcher.start_voice_companion(VoiceArgs(), voice_dir)
            check(process is None and not env, "auto mode respects an externally configured voice URL")

            # main() supervises both processes instead of replacing itself.
            launcher.start_voice_companion = lambda known, target: (
                FakeProc(),
                {"KIZZEY_VOICE_URL": "http://127.0.0.1:8421"},
            )
            supervised = {}
            launcher.run_supervisor = lambda python, target, server_py, forwarded, extra_env, voice: (
                supervised.update(forwarded=list(forwarded), extra_env=dict(extra_env), voice=voice) or 0
            )
            code, execs, _ = run(["--no-pull", "--dir", str(target), "--port", "9123"])
            check(code == 0, "a supervised run exits cleanly", str(code))
            check(not execs, "a supervised run does not replace the launcher process")
            check(supervised.get("forwarded") == ["--port", "9123"], "a supervised run forwards server flags", str(supervised))
            check(supervised.get("voice") is not None, "a supervised run hands the companion to the supervisor")
        finally:
            if pushed_url is not None:
                os.environ["KIZZEY_VOICE_URL"] = pushed_url
            else:
                os.environ.pop("KIZZEY_VOICE_URL", None)
            launcher.check_voice_dependencies = real_check
            launcher.start_voice_service = real_start
            launcher.probe_voice_health = real_probe
            launcher.start_voice_companion = real_companion
            launcher.run_supervisor = real_supervisor

        text = (ROOT / "script_pull.py").read_text()
        check("--voice" in text and "--no-voice" in text, "the launcher exposes voice toggles")
        check("--voice-install" in text, "the launcher can install the voice requirements")
        check("KIZZEY_VOICE_URL" in text, "the launcher wires Kizzey to the companion")

        print(f"\n{sum(checks)}/{len(checks)} launcher checks passed")
        return 0 if all(checks) else 1
    finally:
        shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
