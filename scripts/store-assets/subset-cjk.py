#!/usr/bin/env python3
"""Cut the Japanese and Chinese caption fonts for the store art down to the glyphs the captions use.

    python3 scripts/store-assets/subset-cjk.py          (needs: pip install fonttools brotli)

Noto Sans JP / SC (SIL OFL 1.1, store/fonts/OFL-NotoSans.txt) are 9 and 17 MB as variable fonts. The store
templates only ever show the captions in i18n/store/{ja,zh-Hans}.json, so this pins the weight to 500 and keeps
only the non-ASCII characters those captions use (ASCII is drawn by Geist). Output, committed:

    store/fonts/NotoSansJP-Store.woff2, store/fonts/NotoSansSC-Store.woff2
    store/fonts/cjk-coverage.json   the characters each file holds; `node scripts/i18n-store.mjs check` fails when
                                    a caption uses one that is missing, and says to run this script again.

The sources are downloaded once to ~/.cache/flagship-store-fonts and checked against the pinned SHA-256 below.
"""
import hashlib, json, os, sys, urllib.request
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    from fontTools import subset
except ImportError:
    sys.exit("fonttools is missing: python3 -m venv /tmp/fv && /tmp/fv/bin/pip install fonttools brotli && /tmp/fv/bin/python3 " + " ".join(sys.argv))

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get("FLAGSHIP_FONT_CACHE", Path.home() / ".cache/flagship-store-fonts"))
SOURCES = {
    "ja": ("NotoSansJP", "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf",
           "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f"),
    "zh-Hans": ("NotoSansSC", "https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
                "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"),
}
# Always kept, so a small caption edit rarely needs a new cut: CJK punctuation and the full-width forms.
EXTRA = "、。，．：；！？「」『』（）〜・ー—…％"


def source(lang):
    name, url, sha = SOURCES[lang]
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}-{sha[:12]}.ttf"
    if not f.exists():
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, f)
    got = hashlib.sha256(f.read_bytes()).hexdigest()
    if got != sha:
        f.unlink()
        sys.exit(f"{url}: sha256 {got} is not the pinned {sha}; check the new release and update SOURCES")
    return name, f


def chars_of(lang):
    tr = json.loads((ROOT / f"i18n/store/{lang}.json").read_text("utf8"))
    text = "".join(v for v in tr.values() if isinstance(v, str)) + EXTRA
    return "".join(sorted({c for c in text if ord(c) > 0x7F and not c.isspace()}))


def main():
    coverage = {}
    for lang in SOURCES:
        name, src = source(lang)
        chars = chars_of(lang)
        font = TTFont(src)
        instantiateVariableFont(font, {"wght": 500}, inplace=True)
        cmap = font.getBestCmap()
        missing = [c for c in chars if ord(c) not in cmap]
        if missing:
            sys.exit(f"{name} has no glyph for {''.join(missing)}")
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(text=chars)
        sub.subset(font)
        out = ROOT / f"store/fonts/{name}-Store.woff2"
        font.flavor = "woff2"
        font.save(out)
        coverage[lang] = {"file": out.name, "weight": 500, "source": SOURCES[lang][1], "sha256": SOURCES[lang][2], "chars": chars}
        print(f"{out.relative_to(ROOT)}: {len(chars)} characters, {out.stat().st_size} bytes")
    (ROOT / "store/fonts/cjk-coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n", "utf8")


main()
