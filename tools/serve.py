"""Local origin for the installed just.MD app: serves this repo on http://127.0.0.1:8765/.

Modes:
  python tools/serve.py            serve in the foreground
  python tools/serve.py --check    exit 0 = just.MD is being served, 1 = not
  python tools/serve.py --ensure   idempotent start for a start-of-day sequence: if already serving,
                                   say so; otherwise start a detached, windowless server (pythonw)
                                   and verify it answers. Exit 0 only when it is serving afterwards.

Optional: start it at logon with a scheduled task (run this yourself; use the pythonw.exe of your Python):
    schtasks /Create /SC ONLOGON /TN justMD-Server /RL LIMITED /F
             /TR "\"<path to pythonw.exe>\" \"<repo>\\tools\\serve.py\""

The installed app keeps working offline from its service-worker cache when this is not running;
the server is needed for first install and for picking up new versions.
Log: tools/serve.log (starts, errors). Binds to 127.0.0.1 only.
"""
import functools
import http.server
import logging
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
URL = f"http://127.0.0.1:{PORT}/"
LOG = ROOT / "tools" / "serve.log"


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # no per-request logging; errors still go to the log below

    def end_headers(self):
        # Always revalidate, so a new version reaches the service worker promptly.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def check():
    try:
        with urllib.request.urlopen(URL + "manifest.webmanifest", timeout=3) as r:
            ok = r.status == 200 and b"just.MD" in r.read()
    except OSError as err:
        print(f"NOT SERVING: {URL} ({err})")
        return 1
    print(f"{'OK' if ok else 'WRONG APP'}: {URL}")
    return 0 if ok else 1


def ensure():
    if check() == 0:
        return 0
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    exe = str(pythonw if pythonw.exists() else sys.executable)
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen([exe, str(Path(__file__).resolve())], creationflags=flags, close_fds=True,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        time.sleep(0.25)
        if check() == 0:
            print(f"started pid {proc.pid}")
            return 0
    print(f"FAILED to start; see {LOG}")
    return 1


def main():
    if "--check" in sys.argv:
        sys.exit(check())
    if "--ensure" in sys.argv:
        sys.exit(ensure())

    logging.basicConfig(filename=LOG, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    handler = functools.partial(Handler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    except OSError as err:
        logging.error("cannot bind %s: %s", URL, err)
        sys.exit(f"cannot bind {URL}: {err}")
    logging.info("serving %s on %s", ROOT, URL)
    server.serve_forever()


if __name__ == "__main__":
    main()
