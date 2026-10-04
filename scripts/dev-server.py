"""Local preview server for Flight Control V2 (development only).

Same as `python3 -m http.server`, but every response carries `Cache-Control: no-cache`, so the
browser revalidates on each load and never runs stale ES modules after a change, and private
folders (reference/, .git/, .foreman/, .claude/, .env*) are never served.
Standard library only. Usage: python3 scripts/dev-server.py [port]  (default 8080, localhost only)
"""
import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


PRIVATE_TOP_LEVEL = {"reference", ".git", ".foreman", ".claude"}


def is_private(fs_path):
    """True for anything under a private top-level folder or any .env* file (checked on the
    resolved filesystem path, so URL-encoding or ../ tricks cannot bypass it)."""
    try:
        rel = Path(fs_path).resolve().relative_to(ROOT)
    except ValueError:
        return True  # outside the repo
    parts = rel.parts
    return bool(parts) and (parts[0] in PRIVATE_TOP_LEVEL or any(part.startswith(".env") for part in parts))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        if is_private(self.translate_path(self.path)):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Flight Control preview: http://localhost:{port}  (Ctrl+C to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
