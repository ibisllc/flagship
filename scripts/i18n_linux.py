#!/usr/bin/env python3
"""Move Flagship Studio for Linux's user-facing text behind gettext.

    python3 scripts/i18n_linux.py wrap [--dry]

Reads the Python sources of apps/builder-linux with the `ast` module (so f-strings, implicit string
concatenation and docstrings are understood, not guessed at), wraps every user-facing string in
`tr("...")` and records it in i18n/studio-linux/en.json. An f-string becomes a numbered template:

    f"Ready: {what} -> {disk_node}"   ->   tr("Ready: {0} -> {1}").format(what, disk_node)

The English text itself is the gettext msgid. `scripts/i18n-linux.mjs build` writes the .po files and
compiles the .mo files (see apps/builder-linux/i18n.py for how they are found at run time).
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINUX = ROOT / "apps" / "builder-linux"
OUT = ROOT / "i18n" / "studio-linux" / "en.json"

# Modules that show text to a person. Everything else (CLI plumbing, probes, parsers) keeps its messages.
FILES = ["wizard.py", "tray.py", "pairing_watch.py", "pair_session.py", "disk_enumerator.py", "wifi_store.py",
         "elevation.py", "vm/server_health.py", "vm/qemu_failure.py", "vm/manager.py", "vm/lifecycle.py",
         "vm/resource_plan.py", "vm/server_tier.py", "vm/recipe_info.py", "vm/kvm_probe.py", "vm/host_power.py",
         "vm/host_resources.py", "vm/appliance_cache.py", "vm/control_plane.py", "vm/ssh_launch.py"]

CODE_LIKE = [
    re.compile(r"^[a-z0-9_.\-/:+@#%&=?~*]+$"),
    re.compile(r"^[a-z]+([A-Z][a-z0-9]+)+$"),
    re.compile(r"^[A-Z0-9_]+$"),
    re.compile(r"^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]*$"),
    re.compile(r"^(https?:|/|\.|~)"),
    re.compile(r"[\\^$|]|\(\?|\[\^?[a-z\\]"),  # regular expression
    re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|Bearer|Basic|Authorization|Content-Type|Accept|User-Agent)\b"),
    re.compile(r"^[A-Z][a-z]+(-[A-Z][a-z]+)+$"),
]
BRANDS = re.compile(r"^(Flagship|Flagship Studio|Debian|Ubuntu|Fedora|Linux|GNOME|KDE|OK|QEMU|KVM|SSH|USB|ISO|Wi-Fi)$")
NEVER_CALLS = re.compile(
    r"^(print|open|Path|getattr|setattr|hasattr|isinstance|int|float|str|bytes|len|sorted|"
    r"os\.environ\.get|os\.getenv|os\.path\.\w+|re\.\w+|json\.\w+|subprocess\.\w+|shutil\.\w+|logging\.\w+|"
    r"log\.\w+|logger\.\w+|\w+\.(get|startswith|endswith|split|rsplit|join|replace|encode|decode|strip|"
    r"add_css_class|remove_css_class|set_icon_name|get_property|connect|emit|"
    r"append_path|setdefault|pop|index|count|find|lower|upper|removeprefix|removesuffix))$"
)


def looks_prose(t: str) -> bool:
    return bool(re.match(r"^[A-ZÀ-Þ“‘(\"\u0001]", t)) and (" " in t or re.search(r"[.!?…:]$", t) is not None)


def is_code_like(t: str) -> bool:
    plain = re.sub(r"\{\d+[^}]*\}", "x", t)
    if not re.search(r"[A-Za-zÀ-ɏ぀-ヿ一-鿿]{2}", plain):
        return True
    return any(p.search(plain) for p in CODE_LIKE)


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted(node.value) + "." + node.attr
    return ""


class Collector(ast.NodeVisitor):
    def __init__(self, src: str, rel: str):
        self.src = src
        self.rel = rel
        self.parents: dict[int, ast.AST] = {}
        self.found: list[tuple[ast.AST, str, str]] = []  # node, template, why
        self.docstrings: set[int] = set()
        self.skipped: list[str] = []

    def run(self, tree: ast.AST) -> None:
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                self.parents[id(child)] = parent
            if isinstance(parent, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                body = parent.body
                if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                    self.docstrings.add(id(body[0].value))
        self.visit(tree)

    def parent(self, n: ast.AST) -> ast.AST | None:
        return self.parents.get(id(n))

    def context(self, n: ast.AST) -> tuple[str, str]:
        """(call name, keyword) of the call this string is an argument of, if any."""
        p = self.parent(n)
        if isinstance(p, ast.keyword):
            call = self.parent(p)
            return (dotted(call.func) if isinstance(call, ast.Call) else "", p.arg or "")
        if isinstance(p, ast.Call) and n is not p.func:
            return (dotted(p.func), "")
        return ("", "")

    def accept(self, node: ast.AST, text: str) -> tuple[bool, str]:
        if id(node) in self.docstrings:
            return False, "docstring"
        p = self.parent(node)
        if isinstance(p, (ast.Compare,)) or (isinstance(p, ast.Dict) and node in p.keys) or isinstance(p, ast.Subscript):
            return False, "comparison/key"
        if isinstance(p, ast.JoinedStr):
            return False, "inside f-string"
        if isinstance(p, ast.Assert):
            return False, "assert"
        if is_code_like(text):
            return False, "code-like"
        if BRANDS.match(text):
            return False, "brand"
        call, kw = self.context(node)
        if NEVER_CALLS.match(call):
            return False, f"non-ui call {call}"
        # raise Something("...") carries a developer message unless it reads as a sentence for a person
        q = p
        while q is not None and not isinstance(q, (ast.Raise, ast.stmt)):
            q = self.parent(q)
        if isinstance(q, ast.Raise) and not re.match(r"^[A-Z][\s\S]*[.!?]$", text):
            return False, "developer error"
        if kw in {"label", "title", "text", "tooltip_text", "subtitle", "description", "placeholder_text", "heading", "body", "message", "hint", "caption"} and re.search(r"[A-Za-z]{2}", text):
            return True, f"{kw}="
        if looks_prose(text):
            return True, "prose"
        # a single capitalised word in the window / tray modules is a button or menu label ("Cancel", "Quit")
        if self.rel in ("wizard.py", "tray.py") and re.match(r"^[A-Z][a-z]{2,14}$", text) and text not in {"Gtk", "Adw", "Gio", "GLib", "Gdk", "Pango", "Category", "Title", "Status", "Version", "Layout"}:
            return True, "label"
        if self.rel in ("wizard.py", "tray.py") and re.match(r"^[A-Z][a-z]+ [A-Za-z-]+$", text) and not kw:
            return True, "label"
        return False, "not user-facing"

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str):
            ok, why = self.accept(node, node.value)
            if ok:
                self.found.append((node, node.value, why))
            elif re.match(r"^[A-Z][\s\S]{2,}", node.value) and why not in ("code-like", "brand", "docstring"):
                self.skipped.append(f"{self.rel}:{node.lineno} [{why}] {node.value[:90]!r}")

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        parts: list[str] = []
        exprs: list[ast.expr] = []
        for v in node.values:
            if isinstance(v, ast.Constant):
                parts.append(str(v.value).replace("{", "{{").replace("}", "}}"))
            elif isinstance(v, ast.FormattedValue):
                spec = ""
                if v.format_spec is not None:
                    if not all(isinstance(s, ast.Constant) for s in v.format_spec.values):
                        self.generic_visit(node)
                        return
                    spec = ":" + "".join(str(s.value) for s in v.format_spec.values)
                conv = {115: "!s", 114: "!r", 97: "!a"}.get(v.conversion, "")
                parts.append("{" + str(len(exprs)) + conv + spec + "}")
                exprs.append(v.value)
        template = "".join(parts)
        plain = re.sub(r"\{\d+[^}]*\}", "x", template).replace("{{", "{").replace("}}", "}")
        ok, why = self.accept(node, plain)
        if ok:
            self.found.append((node, template, why))
            return  # nested f-strings inside are part of this one
        self.generic_visit(node)


def offset(line_starts: list[int], line: int, col: int, src_bytes: bytes) -> int:
    return line_starts[line - 1] + col


def main() -> None:
    dry = "--dry" in sys.argv
    entries: dict[str, dict[str, str]] = {}
    all_skipped: list[str] = []
    total = 0
    for rel in FILES:
        path = LINUX / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text)
        c = Collector(text, rel)
        c.run(tree)
        all_skipped += c.skipped
        if not c.found:
            continue
        b = text.encode("utf-8")
        starts = [0]
        for m in re.finditer(b"\n", b):
            starts.append(m.end())
        edits: list[tuple[int, int, str]] = []
        for node, template, why in c.found:
            lo = offset(starts, node.lineno, node.col_offset, b)
            hi = offset(starts, node.end_lineno, node.end_col_offset, b)
            if isinstance(node, ast.JoinedStr):
                exprs = [ast.get_source_segment(text, v.value) for v in node.values if isinstance(v, ast.FormattedValue)]
                new = f"tr({template!r}).format({', '.join(exprs)})" if exprs else f"tr({template!r})"
                key = template
            else:
                orig = b[lo:hi].decode("utf-8")
                new = f"tr({orig})"
                key = template
            entries.setdefault(key, {"en": key, "ctx": f"{rel}:{node.lineno} ({why})"})
            edits.append((lo, hi, new))
            total += 1
        if not dry:
            for lo, hi, new in sorted(edits, key=lambda e: -e[0]):
                b = b[:lo] + new.encode("utf-8") + b[hi:]
            out = b.decode("utf-8")
            # `from i18n import tr` after the __future__ imports (or the module docstring)
            if "from i18n import tr" not in out:
                m = re.search(r"^from __future__ import [^\n]+\n", out, re.M)
                imp = "from i18n import tr\n"  # apps/builder-linux is on sys.path (flagship-builder.py, tests/conftest.py)
                out = out[: m.end()] + "\n" + imp + out[m.end():] if m else imp + out
            path.write_text(out, encoding="utf-8")
    print(f"{total} strings -> {len(entries)} msgids")
    Path("/tmp/i18n-linux-skipped.txt").write_text("\n".join(all_skipped))
    if not dry:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
