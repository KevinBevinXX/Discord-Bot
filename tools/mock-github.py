#!/usr/bin/env python3
"""
Mock GitHub + dashboard server for the virtual tester.

Serves /docs statically, fakes the Contents API for config.json and
state.json with REAL sha semantics (PUT with a stale sha → 409), and can
inject faults via /debug:
  POST /debug/stale-once   → the next GET of config.json returns the OLD sha
                             (reproducing a racing writer / cached GET)
"""
import base64
import hashlib
import json
import pathlib
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOCS = pathlib.Path(__file__).resolve().parent.parent / 'docs'
REPO = {
    'config.json': json.dumps(json.loads((DOCS.parent / 'config.example.json').read_text()), indent=2) + '\n',
    'state.json': json.dumps({
        'guildId': '1424054439941111860', 'guildName': "KevinBevinX's Community",
        'memberCount': 12, 'botId': '1560471518113435818', 'updatedAt': 'test',
        'channels': [
            {'id': '111111111111111111', 'name': 'general', 'type': 'text', 'category': ''},
            {'id': '222222222222222222', 'name': 'support', 'type': 'text', 'category': ''},
            {'id': '333333333333333333', 'name': 'Tickets', 'type': 'category', 'category': ''},
        ],
        'roles': [
            {'id': '444444444444444444', 'name': 'Member', 'color': '#5865F2', 'managed': False},
            {'id': '555555555555555555', 'name': 'Staff', 'color': '#23c55e', 'managed': False},
        ],
    }, indent=2),
}
stale_once = False
commits = []


def sha_of(text):
    return hashlib.sha1(text.encode()).hexdigest()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global stale_once
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        if self.path == '/debug/stale-once':
            stale_once = True
            return self._json(200, {'ok': True})
        return self._json(404, {'message': 'nope'})

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path == '/debug/commits':
            return self._json(200, commits)
        m = re.fullmatch(r'/repos/[^/]+/[^/]+/contents/(config\.json|state\.json)', path)
        if m:
            file = m.group(1)
            text = REPO[file]
            sha = sha_of(text)
            global stale_once
            if file == 'config.json' and stale_once:
                # pretend the writer raced: hand back the PREVIOUS sha once
                sha = 'stale00000000000000000000000000000000000'
                stale_once = False
            return self._json(200, {
                'type': 'file', 'sha': sha,
                'content': base64.b64encode(text.encode()).decode(),
            })
        # static file from docs/ (query ignored)
        rel = path.lstrip('/') or 'index.html'
        f = DOCS / rel
        if f.is_file() and DOCS.resolve() in f.resolve().parents:
            body = f.read_bytes()
            self.send_response(200)
            ctype = 'text/html' if rel.endswith('html') else 'application/javascript' if rel.endswith('js') else 'text/css'
            self.send_header('Content-Type', ctype + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json(404, {'message': 'not found'})

    def do_PUT(self):
        path, _, _ = self.path.partition('?')
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        m = re.fullmatch(r'/repos/[^/]+/[^/]+/contents/(config\.json|state\.json)', path)
        if not m:
            return self._json(404, {'message': 'nope'})
        file = m.group(1)
        new_text = base64.b64decode(body.get('content', '')).decode()
        given_sha = body.get('sha')
        current_sha = sha_of(REPO[file])
        if given_sha != current_sha:
            return self._json(409, {'message': f'{file} does not match {given_sha}', 'status': '409'})
        REPO[file] = new_text
        commits.append({'file': file, 'message': body.get('message', ''), 'sha': sha_of(new_text)})
        return self._json(200, {'content': {'sha': sha_of(new_text)}})


if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()