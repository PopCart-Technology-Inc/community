#!/usr/bin/env python3
"""Leak check for a PUBLIC repository. Standard library only.

Anything pushed here is public forever, so this runs before every commit, before every push and in
CI, and it fails closed: if it cannot read something, it blocks.

    python tools/leakcheck/leakcheck.py --staged          # pre-commit: what is about to be committed
    python tools/leakcheck/leakcheck.py --pre-push        # pre-push: every commit about to leave (refs on stdin)
    python tools/leakcheck/leakcheck.py --range A..B      # every commit in a range
    python tools/leakcheck/leakcheck.py --history         # every commit ever (CI)
    python tools/leakcheck/leakcheck.py --tree            # every file at HEAD

It checks file contents, file names, file sizes and commit messages against:
  1. secrets (keys, tokens, private keys, passwords, credentials in URLs): never allowable;
  2. personal data (email addresses outside the allow-list, phone numbers);
  3. internal details (private IP addresses, local machine paths);
  4. a PRIVATE list of internal names (servers, hosts, closed repos, people) kept OUTSIDE this repo,
     because committing that list would publish it. Read from the file named by
     LEAKCHECK_PRIVATE_FILE (default ~/.config/popcart/leakcheck-private.txt) and from the
     LEAKCHECK_PRIVATE environment variable (CI secret), one term per line, case-insensitive.

A false positive in groups 2-3 can be allowed by putting `leakcheck: allow` on that line, and a
reviewer sees it. Secrets can never be allowed: remove them and rotate them.
"""
import os
import re
import subprocess
import sys

MAX_BYTES = 1_000_000

HARD = [  # secrets: never allowable
    ('private key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('AWS access key', re.compile(r'\b(AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('GitHub token', re.compile(r'\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b')),
    ('Google API key', re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b')),
    ('Slack token', re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}')),
    ('live payment key', re.compile(r'\b[sprk]k_live_[A-Za-z0-9]{10,}')),
    ('OpenAI/Anthropic key', re.compile(r'\bsk-(ant-)?[A-Za-z0-9_-]{20,}')),
    ('JWT or tunnel token', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ('credentials in URL', re.compile(r'[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@[^\s/]+', re.I)),
    ('assigned secret', re.compile(r'''(?i)\b(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|auth)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']''')),
    ('age secret key', re.compile(r'AGE-SECRET-KEY-1[0-9A-Z]{50,}')),
]

SOFT = [  # personal data and internal details: allowable with `leakcheck: allow`
    ('email address', re.compile(r'(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}\b')),
    ('phone number', re.compile(r'(?<![\d.])(\+?63[ -]?9\d{2}|09\d{2})[ -]?\d{3}[ -]?\d{4}(?!\d)')),
    ('private IP address', re.compile(r'\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b')),
    ('local machine path', re.compile(r'(?i)(\b[a-z]:[\\/](users|program files|popcart)|/home/[a-z]|/Users/[a-z]|\\\\wsl)')),
]

EMAIL_OK = re.compile(r'(?i)^(support\.popcart@gmail\.com|noreply@anthropic\.com|[0-9]+\+[^@]+@users\.noreply\.github\.com|[^@]+@example\.(com|org|net))$')

BAD_NAMES = re.compile(r'''(?ix)(^|/)(
    \.env(\..*)? | .*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|sqlite3?|db|dump|bak|apk|aab|ipa|tgz|tar|gz|zip|7z|rar) |
    id_(rsa|dsa|ecdsa|ed25519)(\.pub)? | .*credentials.*\.json | .*service[-_]?account.*\.json | \.npmrc | \.pypirc | \.netrc |
    known_hosts | authorized_keys | .*\.tfstate(\.backup)?
)$''')
ALLOW_EXAMPLE = re.compile(r'(?i)(^|/)\.env\.example$')

SKIP_SOFT = {'LICENSE', 'LICENSE-DOCS', 'tools/leakcheck/leakcheck.py', 'tools/leakcheck/test_leakcheck.py'}
SKIP_HARD = {'tools/leakcheck/leakcheck.py', 'tools/leakcheck/test_leakcheck.py'}  # the patterns themselves


def private_terms():
    terms = []
    path = os.environ.get('LEAKCHECK_PRIVATE_FILE') or os.path.expanduser('~/.config/popcart/leakcheck-private.txt')
    if os.path.isfile(path):
        with open(path, encoding='utf8') as f:
            terms += f.read().splitlines()
    terms += os.environ.get('LEAKCHECK_PRIVATE', '').splitlines()
    return sorted({t.strip().lower() for t in terms if t.strip() and not t.strip().startswith('#')})


def mask(s):
    s = s.strip()
    return s if len(s) <= 8 else s[:4] + '…' + s[-2:]


def git(*args, binary=False):
    r = subprocess.run(['git', *args], capture_output=True)
    if r.returncode != 0:
        raise SystemExit('leakcheck: git %s failed (blocking): %s' % (' '.join(args), r.stderr.decode('utf8', 'replace').strip()))
    return r.stdout if binary else r.stdout.decode('utf8', 'replace')


class Checker:
    def __init__(self):
        self.private = private_terms()
        self.findings = []

    def add(self, where, rule, hit):
        self.findings.append('%s  %s  [%s]' % (where, rule, mask(hit)))

    def text(self, where, path, text):
        for n, line in enumerate(text.splitlines(), 1):
            loc = '%s:%d' % (where, n)
            if path not in SKIP_HARD:
                for rule, rx in HARD:
                    m = rx.search(line)
                    if m:
                        self.add(loc, 'SECRET: ' + rule, m.group(0))
            if 'leakcheck: allow' in line:
                continue
            low = line.lower()
            for t in self.private:
                if t in low:
                    self.add(loc, 'private name', t)
            if path in SKIP_SOFT:
                continue
            for rule, rx in SOFT:
                for m in rx.finditer(line):
                    if rule == 'email address' and EMAIL_OK.match(m.group(0)):
                        continue
                    self.add(loc, rule, m.group(0))

    def name(self, where, path):
        if BAD_NAMES.search(path) and not ALLOW_EXAMPLE.search(path):
            self.add(where, 'forbidden file type', path)
        low = path.lower()
        for t in self.private:
            if t in low:
                self.add(where, 'private name in path', t)

    def blob(self, where, path, data):
        self.name(where, path)
        if len(data) > MAX_BYTES:
            self.add(where, 'file over 1 MB', '%d bytes' % len(data))
            return  # blocked anyway; scanning it would only be slow
        if b'\0' in data[:8000]:
            if not re.search(r'(?i)\.(png|jpe?g|webp|gif|ico|woff2?)$', path):
                self.add(where, 'binary file', path)
            return
        self.text(where, path, data.decode('utf8', 'replace'))

    def commit(self, sha):
        short = sha[:9]
        self.text('%s (message)' % short, '', git('log', '-1', '--format=%B', sha))
        for path in git('diff-tree', '--no-commit-id', '-r', '--root', '--diff-filter=ACMRT', '--name-only', '-z', sha).split('\0'):
            if path:
                self.blob('%s %s' % (short, path), path, git('show', '%s:%s' % (sha, path), binary=True))

    def commits(self, shas):
        for sha in shas:
            self.commit(sha)


ZERO = '0' * 40


def main(argv):
    c = Checker()
    mode = argv[1] if len(argv) > 1 else '--staged'
    if mode == '--staged':
        for path in git('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z').split('\0'):
            if path:
                c.blob(path, path, git('show', ':' + path, binary=True))
    elif mode == '--pre-push':
        for line in sys.stdin.read().splitlines():
            parts = line.split()
            if len(parts) != 4 or parts[1] == ZERO:
                continue  # malformed, or a branch delete (nothing leaves)
            local, remote = parts[1], parts[3]
            spec = [local, '--not', '--remotes'] if remote == ZERO else ['%s..%s' % (remote, local)]
            c.commits(git('rev-list', *spec).split())
    elif mode == '--range':
        c.commits(git('rev-list', argv[2]).split())
    elif mode == '--history':
        c.commits(git('rev-list', '--all').split())
    elif mode == '--tree':
        for path in git('ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0'):
            if path:
                c.blob(path, path, git('show', 'HEAD:' + path, binary=True))
    else:
        raise SystemExit(__doc__)

    if not c.private:
        print('leakcheck: note: no private name list found (see LEAKCHECK_PRIVATE_FILE); internal names are not checked', file=sys.stderr)
    if c.findings:
        print('\nleakcheck: BLOCKED. This repo is PUBLIC. Fix every line below before it leaves this machine:\n', file=sys.stderr)
        for f in c.findings:
            print('  ' + f, file=sys.stderr)
        print('\nSecrets: remove them AND rotate them (assume they are already burned if they were ever pushed).', file=sys.stderr)
        return 1
    print('leakcheck: clean (%s)' % mode)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
