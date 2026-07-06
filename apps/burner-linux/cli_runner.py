"""Spawn the @flagship/burner Node CLI, stream stdout/stderr.

Mirrors apps/burner-mac/Sources/FlagshipBurnerCore/CLIRunner.swift +
CLILocator.swift. Resolution order for Node + the CLI entry is the same
shape but with Linux paths (no /opt/homebrew/bin).
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional


@dataclass(frozen=True)
class Resolved:
    node_path: str
    entry_path: str


class CLILocateError(Exception):
    """Raised when we cannot find Node or the CLI entry."""


def find_node(
    fileexists: Callable[[str], bool] = lambda p: os.access(p, os.X_OK),
    environ: Optional[dict[str, str]] = None,
) -> str:
    env = environ if environ is not None else os.environ
    override = env.get("FLAGSHIP_NODE_PATH")
    if override and fileexists(override):
        return override
    candidates = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        # snap-based Node installs (Ubuntu)
        "/snap/bin/node",
        # nvm default location prefix; we try `~/.nvm/versions/node/*/bin/node`
        # only via PATH lookup below
    ]
    for c in candidates:
        if fileexists(c):
            return c
    # PATH lookup
    found = shutil.which("node")
    if found:
        return found
    raise CLILocateError(f"node not found; searched: {candidates} + PATH")


def find_entry(
    executable_dir: Optional[Path] = None,
    fileexists: Callable[[str], bool] = lambda p: Path(p).exists(),
    environ: Optional[dict[str, str]] = None,
) -> str:
    """Find the flagship-burn CLI entry. Searches:
      1. $FLAGSHIP_BURN_ENTRY
      2. ../../packages/flagship-burner/dist/cli.js from this file (the tsc
         build — plain `node` runs it; node 20 can NOT execute the .ts)
      3. ../../packages/flagship-burner/src/cli.ts (last-resort: only works
         under a TS-capable runtime)
      4. /usr/share/flagship-burner/cli.js (system-installed AppImage extract)
      5. /usr/share/flagship-burner/cli.ts
    """
    env = environ if environ is not None else os.environ
    override = env.get("FLAGSHIP_BURN_ENTRY")
    if override and fileexists(override):
        return override
    base = executable_dir if executable_dir is not None else Path(__file__).resolve().parent
    # apps/burner-linux/ → walk up to flagship/, then over to
    # packages/flagship-burner/. dist BEFORE src: the runner is plain `node`,
    # which throws ERR_UNKNOWN_FILE_EXTENSION on the .ts — a checkout that ran
    # `npx tsc -b` must Just Work.
    candidates = [
        base.parent.parent / "packages" / "flagship-burner" / "dist" / "cli.js",
        base.parent.parent / "packages" / "flagship-burner" / "src" / "cli.ts",
        Path("/usr/share/flagship-burner/cli.js"),
        Path("/usr/share/flagship-burner/cli.ts"),
        Path("/usr/share/flagship-burner/dist/cli.js"),
        Path("/usr/share/flagship-burner/src/cli.ts"),
    ]
    for c in candidates:
        if fileexists(str(c)):
            return str(c)
    raise CLILocateError(
        f"flagship-burn entry not found; searched: {[str(c) for c in candidates]}"
    )


def locate(
    environ: Optional[dict[str, str]] = None,
    fileexists: Optional[Callable[[str], bool]] = None,
) -> Resolved:
    env = environ if environ is not None else os.environ
    exists = fileexists if fileexists is not None else (lambda p: Path(p).exists())
    is_exec = lambda p: os.access(p, os.X_OK)
    return Resolved(
        node_path=find_node(fileexists=is_exec, environ=env),
        entry_path=find_entry(fileexists=exists, environ=env),
    )


# ---- argument-vector builders (mirror CLIArgs.swift) ----


def args_verify(entry_path: str, recipe_path: str) -> list[str]:
    return [entry_path, "verify", recipe_path]


def args_user_data(entry_path: str, recipe_path: str, out_path: str, keep_recipe: bool) -> list[str]:
    a = [entry_path, "user-data", recipe_path, out_path]
    if keep_recipe:
        a.append("--keep-recipe")
    return a


def args_prepare(
    entry_path: str,
    recipe_path: str,
    iso_path: str,
    out_iso_path: str,
    keep_recipe: bool,
) -> list[str]:
    a = [entry_path, "prepare", recipe_path, iso_path, out_iso_path]
    if keep_recipe:
        a.append("--keep-recipe")
    return a


def args_write(
    entry_path: str,
    recipe_path: str,
    iso_path: str,
    device: Optional[str],
    yes: bool,
    keep_recipe: bool,
) -> list[str]:
    a = [entry_path, "write", recipe_path, iso_path]
    if device:
        a.extend(["--device", device])
    if yes:
        a.append("--yes")
    if keep_recipe:
        a.append("--keep-recipe")
    return a


def args_pair(entry_path: str, out_path: str, debug: bool) -> list[str]:
    """`pair --out <recipe.json> --emit-events [--debug]` — the phone-pairing
    relay session (shared TS implementation), with machine-readable milestones
    the GTK cover renders. Mirrors CliArgs.Pair (Windows) / the CLI's cmdPair."""
    a = [entry_path, "pair", "--out", out_path, "--emit-events"]
    if debug:
        a.append("--debug")
    return a


# ---- runner ----


@dataclass
class LogLine:
    stream: str  # "stdout" | "stderr"
    text: str


LogCallback = Callable[[LogLine], None]


def parse_verify_json(stdout_text: str) -> Optional[dict]:
    """Mirror of VerifyResult.parse — scan for the first '{' and try to
    decode from there. Robust to noise before the JSON."""
    i = stdout_text.find("{")
    if i < 0:
        return None
    try:
        # Find a JSON object via simple brace-balance scan.
        depth = 0
        end = -1
        for j in range(i, len(stdout_text)):
            ch = stdout_text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if end < 0:
            return None
        return json.loads(stdout_text[i:end])
    except (ValueError, json.JSONDecodeError):
        return None


class CLIRunner:
    """Spawn a Node CLI invocation and stream lines via callback.

    `start()` is non-blocking — returns immediately, fires the callback
    on a background thread per line. `wait()` blocks until exit. Use
    `terminate()` to cancel.

    When `use_pkexec` is True, the command is wrapped in
    `pkexec` (PolicyKit) which prompts the user via the standard
    Linux admin-auth dialog before granting root. Required for the
    `write` subcommand."""

    def __init__(
        self,
        node_path: str,
        arguments: list[str],
        cwd: Optional[str] = None,
        use_pkexec: bool = False,
        elevation_prefix: Optional[list[str]] = None,
    ) -> None:
        self.node_path = node_path
        self.arguments = arguments
        self.cwd = cwd
        self.use_pkexec = use_pkexec
        # How to elevate when use_pkexec is True. Default stays ["pkexec"];
        # the wizard passes ["sudo", "-n"] where pkexec can't work (ChromeOS's
        # container — see elevation.probe).
        self.elevation_prefix = elevation_prefix
        self._proc: Optional[subprocess.Popen] = None
        self._threads: list[threading.Thread] = []
        self._stdout_lines: list[str] = []
        self._stderr_lines: list[str] = []
        self._lock = threading.Lock()

    @property
    def command_vector(self) -> list[str]:
        base = [self.node_path, *self.arguments]
        if self.use_pkexec:
            # pkexec requires absolute paths; node_path already absolute.
            return [*(self.elevation_prefix or ["pkexec"]), *base]
        return base

    @property
    def command_string(self) -> str:
        return " ".join(shlex.quote(a) for a in self.command_vector)

    def start(self, on_line: LogCallback) -> None:
        if self._proc is not None:
            raise RuntimeError("CLIRunner already started")
        try:
            self._proc = subprocess.Popen(
                self.command_vector,
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # line-buffered
            )
        except FileNotFoundError as e:
            on_line(LogLine(stream="stderr", text=f"spawn failed: {e}"))
            raise
        t_out = threading.Thread(
            target=self._tail,
            args=(self._proc.stdout, "stdout", on_line, self._stdout_lines),
            daemon=True,
        )
        t_err = threading.Thread(
            target=self._tail,
            args=(self._proc.stderr, "stderr", on_line, self._stderr_lines),
            daemon=True,
        )
        t_out.start()
        t_err.start()
        self._threads = [t_out, t_err]

    def _tail(
        self,
        stream: Iterable[str],
        label: str,
        on_line: LogCallback,
        buffer: list[str],
    ) -> None:
        for raw in stream:
            line = raw.rstrip("\n").rstrip("\r")
            with self._lock:
                buffer.append(line)
            on_line(LogLine(stream=label, text=line))

    def wait(self) -> int:
        if self._proc is None:
            raise RuntimeError("CLIRunner not started")
        for t in self._threads:
            t.join()
        return self._proc.wait()

    def terminate(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()

    @property
    def stdout_text(self) -> str:
        with self._lock:
            return "\n".join(self._stdout_lines)

    @property
    def stderr_text(self) -> str:
        with self._lock:
            return "\n".join(self._stderr_lines)
