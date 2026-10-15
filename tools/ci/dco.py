#!/usr/bin/env python3
"""DCO check for pull requests. Standard library only.

Every commit in a pull request must carry a `Signed-off-by: Name <email>` line whose email matches
the commit author (see CONTRIBUTING.md). Merge commits are skipped. Bot accounts (Dependabot and
other GitHub Apps, author name ending in "[bot]") are exempt, as with the usual DCO apps.

    python tools/ci/dco.py BASE_SHA HEAD_SHA
"""
import re
import subprocess
import sys

SIGN_OFF = re.compile(r'(?im)^\s*signed-off-by:\s*.+?<([^<>\s]+)>\s*$')
SEP = '\x1e'


def problems(commits):
    """commits: list of (sha, author_name, author_email, message). Returns a list of problems."""
    out = []
    for sha, name, email, message in commits:
        if name.endswith('[bot]'):
            continue
        signed = [e.lower() for e in SIGN_OFF.findall(message)]
        if not signed:
            out.append('%s has no Signed-off-by line' % sha[:9])
        elif email.lower() not in signed:
            out.append('%s is signed off, but not by its author (use the same email as the commit)' % sha[:9])
    return out


def read(base, head):
    fmt = SEP.join(['%H', '%an', '%ae', '%B']) + '\x1f'
    r = subprocess.run(['git', 'log', '--no-merges', '--format=' + fmt, '%s..%s' % (base, head)], capture_output=True)
    if r.returncode != 0:
        raise SystemExit('dco: git log failed (blocking): ' + r.stderr.decode('utf8', 'replace').strip())
    rows = []
    for chunk in r.stdout.decode('utf8', 'replace').split('\x1f'):
        chunk = chunk.strip('\n')
        if chunk:
            rows.append(tuple(chunk.split(SEP, 3)))
    return rows


def main(argv):
    if len(argv) != 3:
        raise SystemExit(__doc__)
    commits = read(argv[1], argv[2])
    bad = problems(commits)
    if bad:
        print('dco: BLOCKED. Every commit needs a sign-off (git commit -s):\n', file=sys.stderr)
        for b in bad:
            print('  ' + b, file=sys.stderr)
        print('\nFix: git rebase --signoff %s, then push your branch again.' % argv[1][:9], file=sys.stderr)
        return 1
    print('dco: %d commit(s) signed off' % len(commits))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
