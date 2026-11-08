"""The hand-out package must build from this repo: every source present, every cached file shipped.
Run: python tests/test_dist.py   (build it for real with python tools/make_dist.py)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import make_dist  # noqa: E402

issues = make_dist.problems()
for i in issues:
    print(f"[FAIL] {i}")
legal = {rel for rel, _ in make_dist.entries()}
for need in ("LICENSE", "THIRD_PARTY_NOTICES.md", "app/vendor/LICENSES/marked-LICENSE.txt",
             "app/vendor/LICENSES/DOMPurify-LICENSE.txt", "app/vendor/LICENSES/highlightjs-LICENSE.txt"):
    if need not in legal:
        issues.append(f"the package leaves out {need}")
        print(f"[FAIL] the package leaves out {need}")
if not issues:
    print("[PASS] the hand-out package builds and carries the license files")
sys.exit(1 if issues else 0)
