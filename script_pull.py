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

Only the Python standard library and a ``git`` binary are required.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_REPO = "https://github.com/WhoDoIKnow/Kizzey-Web-Alternate"
DEFAULT_BRANCH = "main"


def fail(message: str) -> int:
    print(f"  {message}", file=sys.stderr)
    return 1


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

    command = [sys.executable, str(server_py), *forwarded]
    print(f"  Starting: {' '.join(command)}")
    print()
    try:
        os.chdir(target)
        os.execv(sys.executable, command)
    except OSError as exc:
        return fail(f"Could not start the server: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
