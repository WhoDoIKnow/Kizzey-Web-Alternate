#!/usr/bin/env python3
"""
Kizzey Web launcher
===================
Pulls the latest Kizzey Web sources and starts the server in one step.

    python3 script_pull.py
    python3 script_pull.py --host 0.0.0.0 --port 8420
    python3 script_pull.py --dir ~/kizzey --branch main
    python3 script_pull.py --update-only

Everything after the launcher's own flags is forwarded to server.py. When the
checkout already matches the tracked branch tip, the launcher says so and skips
the download instead of fetching on every start. Local runtime data (``data/``,
uploads, logs) is never touched: it is git-ignored and lives beside the sources.

The launcher also starts the optional Discord voice companion. By default it
looks for ``voice_service/voice_service.py`` plus the ``discord`` package and
``ffmpeg``; when they are present it runs the companion, points Kizzey at it and
supervises both processes, otherwise it starts Kizzey alone:

    python3 script_pull.py --voice            # require the companion
    python3 script_pull.py --no-voice         # skip it
    python3 script_pull.py --voice-install    # pip install it first

Only the Python standard library and a ``git`` binary are required for the
launcher itself; the voice companion has its own requirements file.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_REPO = "https://github.com/WhoDoIKnow/Kizzey-Web-Alternate"
DEFAULT_BRANCH = "main"
DEFAULT_VOICE_PORT = 8421
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def fail(message: str) -> int:
    print(f"  {message}", file=sys.stderr)
    return 1


def note(message: str) -> None:
    print(f"  {message}")


def run_git(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def default_dir(script_dir: Path) -> Path:
    """Prefer the checkout this script already lives in."""
    if (script_dir / "server.py").exists():
        return script_dir
    return Path.cwd() / "kizzey-web"


def local_head(target: Path) -> str:
    """The commit this checkout is sitting on, or "" when it cannot be read."""
    rev = run_git(["rev-parse", "HEAD"], cwd=target)
    return rev.stdout.strip() if rev.returncode == 0 else ""


def remote_head(target: Path, repo: str, branch: str) -> str:
    """Ask the remote for the branch tip without touching the working tree."""
    listed = run_git(["ls-remote", repo, f"refs/heads/{branch}"], cwd=target)
    if listed.returncode != 0:
        return ""
    for line in listed.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == f"refs/heads/{branch}":
            return parts[0].strip()
    return ""


def pull(target: Path, repo: str, branch: str) -> int:
    if (target / ".git").exists():
        print(f"  Checking {target}")

        # Cheap path: compare the local commit with the remote tip. When they
        # already match there is nothing to download, so skip the fetch and the
        # network round trip entirely.
        local = local_head(target)
        ahead = remote_head(target, repo, branch)
        if ahead and local and ahead == local:
            print("  Already up to date; nothing to pull.")
            return 0

        fetched = run_git(["fetch", "--prune", "origin", branch], cwd=target)
        if fetched.returncode != 0:
            print(fetched.stdout.rstrip())
            return fail("Could not fetch from origin. Check your network and repository access.")

        # ls-remote can be blocked or unavailable; fall back to the tip the
        # fetch just recorded before deciding whether a merge is needed.
        if not ahead:
            tracked = run_git(["rev-parse", f"origin/{branch}"], cwd=target)
            ahead = tracked.stdout.strip() if tracked.returncode == 0 else ""
        local = local_head(target)
        if ahead and local and ahead == local:
            print("  Already up to date; nothing to pull.")
            return 0

        pulled = run_git(["pull", "--ff-only", "origin", branch], cwd=target)
        print(pulled.stdout.rstrip())
        if pulled.returncode != 0:
            return fail(
                "Could not fast-forward. Commit or stash your local changes, "
                "or run with --no-pull to start the current checkout."
            )
        return 0

    if target.exists() and any(target.iterdir()):
        if (target / "server.py").exists():
            print(f"  {target} is not a git checkout; starting it as-is.")
            return 0
        return fail(f"{target} exists and is not empty. Choose another --dir.")

    if not shutil.which("git"):
        return fail("git is not installed. Install git, or clone the repository yourself.")

    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  Cloning {repo} ({branch}) into {target}")
    cloned = subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", branch, repo, str(target)],
        text=True,
    )
    if cloned.returncode != 0:
        return fail(
            "Clone failed. For a private repository, sign in first "
            "(gh auth login, or a git credential helper) and try again."
        )
    return 0


# -- voice companion ----------------------------------------------------------

def voice_service_script(target: Path) -> Path:
    return target / "voice_service" / "voice_service.py"


def voice_requirements(target: Path) -> Path:
    return target / "voice_service" / "requirements.txt"


def rpc_token(target: Path) -> str:
    """The Discord token Kizzey already uses for RPC, or "" when not signed in.

    RPC, the gateway and the voice companion all use the same account token.
    Reading it here means the launcher can wire voice without a second secret;
    the file lives in the git-ignored data directory and is never logged.
    """
    secret_path = target / "data" / "secret.json"
    try:
        data = json.loads(secret_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    token = str(data.get("token") or "").strip()
    if token:
        return token
    for account in data.get("accounts") or []:
        if not isinstance(account, dict):
            continue
        candidate = str(account.get("token") or "").strip()
        if candidate:
            return candidate
    return ""


def check_voice_dependencies(python: str, target: Path) -> tuple[bool, str]:
    """Return (ready, reason) for running the voice companion in this checkout."""
    script = voice_service_script(target)
    if not script.exists():
        return False, f"{script} was not found in this checkout."
    if not shutil.which("ffmpeg"):
        return False, "ffmpeg is not on PATH."
    probe = subprocess.run(
        [python, "-c", "import discord"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if probe.returncode != 0:
        return False, "the Discord voice packages are not installed."
    return True, ""


def install_voice_requirements(python: str, target: Path) -> bool:
    requirements = voice_requirements(target)
    if not requirements.exists():
        return False
    note(f"Installing voice dependencies: {python} -m pip install -r {requirements}")
    installed = subprocess.run([python, "-m", "pip", "install", "-r", str(requirements)])
    return installed.returncode == 0


def probe_voice_health(host: str, port: int, process: subprocess.Popen | None = None, timeout: float = 8.0) -> bool:
    """Poll the unauthenticated /health endpoint until the companion answers."""
    probe_host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    url = f"http://{probe_host}:{port}/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return process is None or process.poll() is None


def start_voice_service(
    python: str,
    target: Path,
    host: str,
    port: int,
    token: str,
    discord_token: str,
) -> subprocess.Popen:
    """Launch the companion with secrets passed only through the environment."""
    env = dict(os.environ)
    env["VOICE_HOST"] = host
    env["VOICE_PORT"] = str(port)
    env["VOICE_RECORDINGS_DIR"] = env.get("VOICE_RECORDINGS_DIR") or str(target / "data" / "voice_recordings")
    if token:
        env["VOICE_TOKEN"] = token
    if discord_token:
        env["DISCORD_TOKEN"] = discord_token
    script = voice_service_script(target)
    note(f"Starting voice service: {python} {script} --host {host} --port {port}")
    return subprocess.Popen(
        [python, str(script), "--host", host, "--port", str(port)],
        cwd=str(target),
        env=env,
    )


def run_supervisor(
    python: str,
    target: Path,
    server_py: Path,
    forwarded: list[str],
    extra_env: dict,
    voice_process: subprocess.Popen,
) -> int:
    """Run Kizzey and the companion together and stop both when either ends."""
    env = dict(os.environ)
    env.update(extra_env)
    command = [python, str(server_py), *forwarded]
    print(f"  Starting: {' '.join(command)}")
    print()
    server = subprocess.Popen(command, cwd=str(target), env=env)

    state = {"stopping": False}

    def stop_children(signum=None, frame=None):
        if state["stopping"]:
            return
        state["stopping"] = True
        for process in (voice_process, server):
            if process.poll() is None:
                try:
                    process.terminate()
                except Exception:
                    pass

    previous: dict[int, object] = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[sig] = signal.signal(sig, stop_children)
        except (ValueError, OSError):
            pass

    try:
        code = server.wait()
    finally:
        stop_children()
        try:
            voice_process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            voice_process.kill()
        for sig, handler in previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
    return code


def start_voice_companion(known, target: Path) -> tuple[subprocess.Popen | None, dict]:
    """Decide whether to run the companion and prepare the Kizzey environment."""
    if known.no_voice:
        return None, {}
    if not (known.voice or known.voice_required):
        configured = str(os.environ.get("KIZZEY_VOICE_URL") or "").strip()
        if configured:
            note(f"KIZZEY_VOICE_URL is set to {configured}; not starting a local voice service.")
            return None, {}

    ready, reason = check_voice_dependencies(sys.executable, target)
    if not ready and known.voice_install:
        if install_voice_requirements(sys.executable, target):
            ready, reason = check_voice_dependencies(sys.executable, target)
    if not ready:
        if known.voice or known.voice_required:
            return None, {"error": f"Cannot start the voice service: {reason}"}
        note(f"Voice service not started: {reason} Run with --voice-install to set it up.")
        return None, {}

    # RPC, the gateway and the voice companion all use one Discord account
    # token. When nothing was configured explicitly, reuse the token already in
    # data/secret.json instead of asking for a second secret.
    account_token = rpc_token(target)
    voice_token = known.voice_token or account_token
    discord_token = known.discord_token or account_token
    if account_token and not known.discord_token:
        note("Using the Discord account token already saved for RPC.")

    process = start_voice_service(
        sys.executable,
        target,
        known.voice_host,
        known.voice_port,
        voice_token,
        discord_token,
    )
    if not probe_voice_health(known.voice_host, known.voice_port, process=process):
        if process.poll() is not None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            if known.voice or known.voice_required:
                return None, {"error": "The voice service exited during startup."}
            note("Voice service exited during startup; continuing without it.")
            return None, {}
        note("Voice service did not answer /health yet; continuing anyway.")

    extra_env = {"KIZZEY_VOICE_URL": f"http://127.0.0.1:{known.voice_port}"}
    if voice_token:
        extra_env["KIZZEY_VOICE_TOKEN"] = voice_token
    if known.voice_host not in LOOPBACK and not voice_token:
        note("Voice host is not loopback and no token was set; non-local requests will be rejected.")
    return process, extra_env


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Pull Kizzey Web and start the server",
        add_help=True,
    )
    parser.add_argument("--dir", default="", help="Checkout directory (default: this checkout)")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"Git remote (default: {DEFAULT_REPO})")
    parser.add_argument("--branch", default=DEFAULT_BRANCH, help=f"Branch to track (default: {DEFAULT_BRANCH})")
    parser.add_argument("--no-pull", action="store_true", help="Start the current checkout without updating")
    parser.add_argument("--update-only", action="store_true", help="Pull, then exit without starting the server")
    parser.add_argument("--voice", action="store_true", help="Start the Discord voice companion (default: auto)")
    parser.add_argument("--no-voice", action="store_true", help="Do not start the Discord voice companion")
    parser.add_argument("--voice-required", action="store_true", help="Fail if the voice companion cannot start")
    parser.add_argument("--voice-install", action="store_true", help="Install voice_service/requirements.txt, then start it")
    parser.add_argument("--voice-host", default=os.environ.get("VOICE_HOST", "127.0.0.1"), help="Voice bind address (default 127.0.0.1)")
    parser.add_argument(
        "--voice-port",
        type=int,
        default=int(os.environ.get("VOICE_PORT", str(DEFAULT_VOICE_PORT))),
        help=f"Voice port (default {DEFAULT_VOICE_PORT})",
    )
    parser.add_argument(
        "--voice-token",
        default=os.environ.get("VOICE_TOKEN") or os.environ.get("KIZZEY_VOICE_TOKEN") or "",
        help="Shared voice token (default: $VOICE_TOKEN, else the saved RPC token)",
    )
    parser.add_argument(
        "--discord-token",
        default=os.environ.get("DISCORD_TOKEN", ""),
        help="Discord token for the companion (default: $DISCORD_TOKEN, else the saved RPC token)",
    )
    known, forwarded = parser.parse_known_args()

    target = Path(known.dir).expanduser().resolve() if known.dir else default_dir(script_dir)

    if not known.no_pull:
        if not shutil.which("git"):
            print("  git is not installed; starting the current checkout.", file=sys.stderr)
        else:
            code = pull(target, known.repo, known.branch)
            if code:
                return code
    else:
        print(f"  Using {target} without pulling.")

    server_py = target / "server.py"
    if not server_py.exists():
        return fail(f"{server_py} was not found. Check --dir or the --branch name.")

    if known.update_only:
        print(f"  Sources are ready in {target}")
        return 0

    data_dir = target / "data"
    if not data_dir.exists():
        print(f"  First run: {data_dir} will be created with fresh settings.")

    voice_process, extra_env = start_voice_companion(known, target)
    if extra_env.get("error"):
        return fail(extra_env["error"])
    if voice_process is not None:
        return run_supervisor(sys.executable, target, server_py, forwarded, extra_env, voice_process)

    command = [sys.executable, str(server_py), *forwarded]
    print(f"  Starting: {' '.join(command)}")
    print()
    if extra_env:
        os.environ.update(extra_env)
    try:
        os.chdir(target)
        os.execv(sys.executable, command)
    except OSError as exc:
        return fail(f"Could not start the server: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
