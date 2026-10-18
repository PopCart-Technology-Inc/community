#!/usr/bin/env python3
"""CHANGELOG.md (Keep a Changelog format) and version checks. Standard library only.

    python tools/ci/changelog.py notes v0.1.0     # print that version's section; fail if it is missing
    python tools/ci/changelog.py check BASE HEAD  # every change has a CHANGELOG line, every release a right version
    python tools/ci/changelog.py tag v0.2.0       # the tag is higher than every earlier v* tag

Semantic Versioning is applied to every change, with no exceptions:
- a pull request that is not a release adds at least one line under `## [Unreleased]`;
- a release moves those lines into one new `## [X.Y.Z] - YYYY-MM-DD` section whose version is the
  last release bumped by what the lines say (docs/RELEASING.md, "Versions");
- released sections are never edited; a mistake is fixed by a new PATCH release.
The release workflow runs `notes` and `tag` on every pushed tag, so a tag can only be released when
the version is written up in CHANGELOG.md, with a date, on main, and is the newest version.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TAG = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$')
PLAIN = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
HEAD = re.compile(r'^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$')
SUB = re.compile(r'^### (.+?)\s*$')


def ordered(text):
    """Return [(version, date, body)] for every `## [x]` heading, top to bottom."""
    out, cur, date, body = [], None, None, []
    for line in text.splitlines():
        m = HEAD.match(line)
        if m:
            if cur:
                out.append((cur, date, '\n'.join(body).strip()))
            cur, date, body = m.group(1), m.group(2), []
        elif line.startswith('[') and ']: ' in line:
            continue  # link references at the bottom
        elif cur:
            body.append(line)
    if cur:
        out.append((cur, date, '\n'.join(body).strip()))
    return out


def sections(text):
    """Return {version: (date, body)} for every `## [x]` heading."""
    return {v: (d, b) for v, d, b in ordered(text)}


def bullets(body):
    return [line.strip() for line in body.splitlines() if line.strip().startswith('- ')]


def parse(version):
    m = PLAIN.match(version or '')
    return tuple(int(x) for x in m.groups()) if m else None


def next_version(v, level):
    if level == 'major':
        return (v[0] + 1, 0, 0)
    if level == 'minor':
        return (v[0], v[1] + 1, 0)
    return (v[0], v[1], v[2] + 1)


def required_bump(body, prev):
    """'major' | 'minor' | 'patch': what a release section's lines call for after version `prev`.

    Removed, or any line saying BREAKING, breaks things: MAJOR from 1.0.0, MINOR before it.
    Added, Changed or Deprecated: MINOR. Only Fixed or Security: PATCH.
    """
    heads, sub, breaking = set(), None, False
    for line in body.splitlines():
        m = SUB.match(line)
        if m:
            sub = m.group(1).strip().lower()
        elif line.strip().startswith('- ') and sub:
            heads.add(sub)
            breaking = breaking or 'breaking' in line.lower()
    if breaking or 'removed' in heads:
        return 'major' if prev[0] >= 1 else 'minor'
    return 'minor' if heads & {'added', 'changed', 'deprecated'} else 'patch'


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


def tag_order(tag, tags):
    """Raise unless `tag` is plain vMAJOR.MINOR.PATCH and higher than every other v* tag in `tags`."""
    me = parse(tag[1:]) if tag.startswith('v') else None
    if not me:
        raise ValueError('tag %r is not plain vMAJOR.MINOR.PATCH' % tag)
    for t in tags:
        other = parse(t[1:]) if t.startswith('v') else None
        if t != tag and other and other >= me:
            raise ValueError('%s is not higher than the earlier tag %s; releases only move forward' % (tag, t))


def check(old_text, new_text):
    """Problems with changing CHANGELOG.md from `old_text` to `new_text`; [] means it may merge."""
    old, new = ordered(old_text), ordered(new_text)
    if not new or new[0][0] != 'Unreleased':
        return ['CHANGELOG.md must start with a "## [Unreleased]" section']
    new_map = sections(new_text)
    old_rel = [(v, d, b) for v, d, b in old if v != 'Unreleased']
    for v, d, b in old_rel:
        if v not in new_map:
            return ['the released section [%s] was removed; released versions never change' % v]
        if new_map[v] != (d, b):
            return ['the released section [%s] was edited; fix it in a new PATCH release instead' % v]

    added = [(v, d, b) for v, d, b in new if v != 'Unreleased' and v not in sections(old_text)]
    unreleased = new_map['Unreleased'][1]
    if not added:
        before = set(bullets(sections(old_text).get('Unreleased', (None, ''))[1]))
        if not [x for x in bullets(unreleased) if x not in before]:
            return ['add a line under "## [Unreleased]" in CHANGELOG.md (### Added, Changed, Fixed, '
                    'Removed or Security): every change is versioned']
        return []

    if len(added) > 1:
        return ['one release at a time: this adds %s' % ', '.join(v for v, _, _ in added)]
    version, date, body = added[0]
    me = parse(version)
    if not me:
        return ['release [%s] is not plain MAJOR.MINOR.PATCH' % version]
    problems = []
    if not date:
        problems.append('release [%s] has no date ("## [%s] - YYYY-MM-DD")' % (version, version))
    if not bullets(body):
        problems.append('release [%s] has no lines' % version)
    if bullets(unreleased):
        problems.append('a release moves every "Unreleased" line into its section; Unreleased must be empty')
    if new[1][0] != version:
        problems.append('release [%s] must come right after "## [Unreleased]"' % version)
    prev = max((p for p in (parse(v) for v, _, _ in old_rel) if p), default=None)
    if prev and me <= prev:
        problems.append('release %s is not higher than the last release %s' % (version, '.'.join(map(str, prev))))
    elif prev and not (prev[0] == 0 and me == (1, 0, 0)):  # 1.0.0 (declaring it stable) is the maintainers' call
        wanted = required_bump(body, prev)
        if me != next_version(prev, wanted):
            problems.append('release %s: its lines call for a %s bump, so the version is %s (docs/RELEASING.md)'
                            % (version, wanted.upper(), '.'.join(map(str, next_version(prev, wanted)))))
    return problems


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def show(rev, path='CHANGELOG.md'):
    try:
        return git('show', '%s:%s' % (rev, path))
    except subprocess.CalledProcessError:
        return ''


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'notes':
            with open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf8') as f:
                print(notes(f.read(), argv[2]))
            return 0
        if len(argv) == 3 and argv[1] == 'tag':
            tag_order(argv[2], git('tag', '--list', 'v*').split())
            return 0
        if len(argv) == 4 and argv[1] == 'check':
            base, head = argv[2], argv[3]
            if git('rev-parse', base).strip() == git('rev-parse', head).strip():
                return 0  # nothing new to check
            problems = check(show(base), show(head))
            for p in problems:
                print('changelog: BLOCKED. ' + p, file=sys.stderr)
            return 1 if problems else 0
    except ValueError as e:
        print('changelog: BLOCKED. ' + str(e), file=sys.stderr)
        return 1
    raise SystemExit(__doc__)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
