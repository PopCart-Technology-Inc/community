#!/usr/bin/env python3
"""Release notes from CHANGELOG.md (Keep a Changelog format). Standard library only.

    python tools/ci/changelog.py notes v0.1.0     # print that version's section; fail if it is missing

The release workflow runs this on every pushed tag, so a tag can only be released when the version
is written up in CHANGELOG.md, with a date, on main.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TAG = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$')
HEAD = re.compile(r'^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$')


def sections(text):
    """Return {version: (date, body)} for every `## [x]` heading."""
    out, cur, date, body = {}, None, None, []
    for line in text.splitlines():
        m = HEAD.match(line)
        if m:
            if cur:
                out[cur] = (date, '\n'.join(body).strip())
            cur, date, body = m.group(1), m.group(2), []
        elif line.startswith('[') and ']: ' in line:
            continue  # link references at the bottom
        elif cur:
            body.append(line)
    if cur:
        out[cur] = (date, '\n'.join(body).strip())
    return out


def notes(text, tag):
    if not TAG.match(tag):
        raise ValueError('tag %r is not vMAJOR.MINOR.PATCH (Semantic Versioning)' % tag)
    found = sections(text).get(tag[1:])
    if not found:
        raise ValueError('CHANGELOG.md has no "## [%s] - YYYY-MM-DD" section' % tag[1:])
    date, body = found
    if not date:
        raise ValueError('the %s section has no release date' % tag[1:])
    if not body:
        raise ValueError('the %s section is empty' % tag[1:])
    return body


def main(argv):
    if len(argv) != 3 or argv[1] != 'notes':
        raise SystemExit(__doc__)
    with open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf8') as f:
        text = f.read()
    try:
        print(notes(text, argv[2]))
    except ValueError as e:
        print('changelog: BLOCKED. ' + str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
