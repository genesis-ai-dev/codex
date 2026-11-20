"""Loopback-only Windows updater staging server. Advance by changing the 'offer' file."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from urllib.parse import urlsplit

root = Path(sys.argv[1]).resolve()
versions = ("1.108.12734", "1.108.13184")

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        feeds = {f"/stable/win32/x64/{scope}/latest.json" for scope in ("user", "system")}
        if path in feeds:
            offer = (root / "offer").read_text(encoding="ascii").strip()
            if offer not in versions:
                self.send_error(503)
                return
            self.log_message("feed %s -> %s", path, offer)
            self.path = f"/{offer}/feed.json"
        elif path not in {f"/{v}/CodexInstall-x64-{v}.exe" for v in versions}:
            self.send_error(404)
            return
        super().do_GET()

ThreadingHTTPServer(("127.0.0.1", 18763), partial(Handler, directory=str(root))).serve_forever()
