"""Build the hand-out package dist/just.MD/ and dist/just.MD.zip from this repo.

The package is for people without git: a folder or zip they copy, and their AI coding agent
(Claude Code or similar) installs it by following INSTALL-FOR-CLAUDE.md. It needs no Python:
serve.ps1 is a small PowerShell server for localhost.

Sources: the app files at the repo root, plus the hand-written docs in package/.
dist/ is build output and is not committed; attach the zip to a release instead.

  python tools/make_dist.py           build dist/just.MD and dist/just.MD.zip
  python tools/make_dist.py --check   build into memory only and verify the zip; exit 1 on a problem
"""
import io
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "package"
DIST = ROOT / "dist"
PKG = DIST / "just.MD"
ZIP = DIST / "just.MD.zip"
APP_FILES = ["index.html", "style.css", "engine.js", "app.js", "sw.js", "manifest.webmanifest"]
APP_DIRS = ["icons", "vendor"]
PACKAGE_DOCS = ["README-FIRST.txt", "INSTALL-FOR-CLAUDE.md", "serve.ps1"]   # from package/
LEGAL = ["LICENSE", "THIRD_PARTY_NOTICES.md"]   # from the repo root; vendor/LICENSES/ ships inside app/vendor
TEXT = {".html", ".css", ".js", ".webmanifest", ".md", ".txt", ".ps1", ".svg"}
ZIP_TIME = (2026, 1, 1, 0, 0, 0)   # fixed timestamps, so the zip only changes when its content does


def entries():
    """(path inside the package, source file), sorted."""
    out = [(doc, DOCS / doc) for doc in PACKAGE_DOCS] + [(doc, ROOT / doc) for doc in LEGAL]
    out += [(f"app/{name}", ROOT / name) for name in APP_FILES]
    for d in APP_DIRS:
        out += [(f"app/{f.relative_to(ROOT).as_posix()}", f) for f in sorted((ROOT / d).rglob("*")) if f.is_file()]
    return sorted(out)


def problems():
    """Every source the package needs but cannot find, plus service-worker files that would not ship."""
    found = [f"missing source: {src.relative_to(ROOT)}" for _, src in entries() if not src.is_file()]
    shipped = {rel for rel, _ in entries()}
    sw = (ROOT / "sw.js").read_text(encoding="utf-8")
    shell = sw.split("const SHELL = [", 1)[1].split("];", 1)[0]
    for name in [s.strip().strip('",') for s in shell.splitlines()]:
        if name and name != "./" and f"app/{name}" not in shipped:
            found.append(f"sw.js caches {name}, but the package does not include it")
    return found


def zip_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, src in entries():
            info = zipfile.ZipInfo(f"just.MD/{rel}", ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            data = src.read_bytes()
            if src.suffix in TEXT:   # LF inside the zip, whatever line endings this checkout has
                data = data.replace(b"\r\n", b"\n")
            z.writestr(info, data)
    return buf.getvalue()


def build():
    issues = problems()
    if issues:
        raise SystemExit("[ERROR] " + "; ".join(issues))
    if PKG.exists():
        shutil.rmtree(PKG)   # only the generated package folder
    for rel, src in entries():
        dst = PKG / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    ZIP.write_bytes(zip_bytes())
    print(f"[OK] built {PKG.relative_to(ROOT)} ({len(entries())} files) and {ZIP.relative_to(ROOT)}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        issues = problems()
        if not issues:
            names = zipfile.ZipFile(io.BytesIO(zip_bytes())).namelist()
            if len(names) != len(entries()):
                issues.append(f"zip holds {len(names)} files, expected {len(entries())}")
        for i in issues:
            print(f"[FAIL] {i}")
        if not issues:
            print("[OK] the package builds")
        sys.exit(1 if issues else 0)
    if sys.argv[1:]:
        raise SystemExit(__doc__)
    build()
