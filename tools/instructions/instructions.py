#!/usr/bin/env python3
"""Agent instructions are contracts: every one carries a semantic version (owner golden rule, 2026-10-19).

Canonical copy: popcart-technologies-inc tools/instructions/instructions.py. Other repos vendor this file
byte-identical; change it there first, then copy. Standard library only, Python 3.8+.

An agent instruction is anything an AI agent reads as instructions: CLAUDE.md, AGENTS.md, Claude Code
agents, commands, skills and hooks, loop prompts, prompt modules in code. Changing one changes how agents
behave, so each is a versioned unit, listed in `agent-instructions.json` at the repository root:

    {
      "schema": 1,
      "include": ["CLAUDE.md", "AGENTS.md", ".claude/agents/**/*.md", ...],
      "exclude": [],
      "instructions": { "CLAUDE.md": { "version": "1.0.0", "sha256": "<hex>" } }
    }

`sha256` is over the file with CRLF turned into LF. Bumps: PATCH = wording that doesn't change behaviour,
MINOR = new or changed behaviour that old callers still accept, MAJOR = removed or contradicting behaviour.

    instructions.py check [--base REV]   # the gate (hooks and CI); --base defaults to HEAD
    instructions.py bump PATH patch|minor|major
    instructions.py adopt [--version 1.0.0]   # add every unlisted matching file
    instructions.py snapshot             # JSON of {path: version} for run logs
    instructions.py pin PATH             # PATH@VERSION#SHA12, the reference a run log records
"""
import hashlib
import json
import os
import re
import subprocess
import sys

MANIFEST = 'agent-instructions.json'
SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
LEVELS = ('patch', 'minor', 'major')


def root():
    out = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else os.getcwd()


def digest(data):
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()


def semver(v):
    m = SEMVER.match(v or '')
    return tuple(int(x) for x in m.groups()) if m else None


def bump(v, level):
    major, minor, patch = semver(v)
    if level == 'major':
        return '%d.0.0' % (major + 1)
    if level == 'minor':
        return '%d.%d.0' % (major, minor + 1)
    return '%d.%d.%d' % (major, minor, patch + 1)


def glob_re(pattern):
    """`**` = any folders (including none), `*` = within one folder, `?` = one character."""
    out, i = '', 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith('**/', i):
            out, i = out + '(?:.*/)?', i + 3
        elif pattern.startswith('**', i):
            out, i = out + '.*', i + 2
        elif c == '*':
            out, i = out + '[^/]*', i + 1
        elif c == '?':
            out, i = out + '[^/]', i + 1
        else:
            out, i = out + re.escape(c), i + 1
    return re.compile('^' + out + '$')


def repo_files(top):
    """Tracked and untracked (not ignored) files; outside git (a deployed export), every file on disk."""
    out = subprocess.run(['git', '-C', top, 'ls-files', '-co', '--exclude-standard'], capture_output=True, text=True)
    if out.returncode == 0:
        return sorted({l.strip() for l in out.stdout.splitlines() if l.strip()})
    found = set()
    for d, dirs, files in os.walk(top):
        dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules')]
        for f in files:
            found.add(os.path.relpath(os.path.join(d, f), top).replace(os.sep, '/'))
    return sorted(found)


def matching(top, manifest):
    inc = [glob_re(p) for p in manifest.get('include', [])]
    exc = [glob_re(p) for p in manifest.get('exclude', [])]
    return [f for f in repo_files(top)
            if os.path.isfile(os.path.join(top, f)) and any(r.match(f) for r in inc) and not any(r.match(f) for r in exc)]


def load(top):
    with open(os.path.join(top, MANIFEST), encoding='utf-8') as fh:
        return json.load(fh)


def save(top, manifest):
    manifest['instructions'] = dict(sorted(manifest.get('instructions', {}).items()))
    with open(os.path.join(top, MANIFEST), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write('\n')


def manifest_at(top, rev):
    out = subprocess.run(['git', '-C', top, 'show', '%s:%s' % (rev, MANIFEST)], capture_output=True)
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout.decode('utf-8'))
    except ValueError:
        return None


def file_digest(top, path):
    with open(os.path.join(top, path), 'rb') as fh:
        return digest(fh.read())


def check(top, base='HEAD'):
    """Return a list of problems (empty = pass)."""
    problems = []
    try:
        m = load(top)
    except (OSError, ValueError) as e:
        return ['%s: unreadable (%s)' % (MANIFEST, e)]
    if m.get('schema') != 1:
        problems.append('%s: schema must be 1' % MANIFEST)
    listed = m.get('instructions', {})
    found = set(matching(top, m))
    for path in sorted(found - set(listed)):
        problems.append('%s: an agent instruction with no version. Run: instructions.py adopt' % path)
    old = (manifest_at(top, base) or {}).get('instructions', {}) if base else {}
    for path, e in sorted(listed.items()):
        v = e.get('version')
        if not semver(v):
            problems.append('%s: version %r is not MAJOR.MINOR.PATCH' % (path, v))
            continue
        if not os.path.isfile(os.path.join(top, path)):
            problems.append('%s: listed in %s but missing; remove the entry' % (path, MANIFEST))
            continue
        if path not in found:
            problems.append('%s: listed but not matched by include/exclude' % path)
        if file_digest(top, path) != e.get('sha256'):
            problems.append('%s: changed but %s still has %s. Run: instructions.py bump %s patch|minor|major'
                            % (path, MANIFEST, v, path))
            continue
        was = old.get(path)
        if was and was.get('sha256') != e.get('sha256') and semver(was.get('version')) and semver(v) <= semver(was['version']):
            problems.append('%s: changed since %s but still %s (was %s). Raise the version.' % (path, base, v, was['version']))
    return problems


def main(argv):
    top = root()
    cmd = argv[0] if argv else 'check'
    if cmd == 'check':
        base = argv[argv.index('--base') + 1] if '--base' in argv else 'HEAD'
        problems = check(top, base)
        for p in problems:
            print('instructions: ' + p, file=sys.stderr)
        if problems:
            print('instructions: every agent instruction carries a semantic version (owner golden rule).', file=sys.stderr)
            return 1
        print('instructions: %d versioned, ok' % len(load(top).get('instructions', {})))
        return 0
    m = load(top)
    items = m.setdefault('instructions', {})
    if cmd == 'bump':
        path, level = argv[1].replace('\\', '/'), argv[2]
        if level not in LEVELS or path not in items:
            print('usage: instructions.py bump <listed path> patch|minor|major', file=sys.stderr)
            return 2
        items[path] = {'version': bump(items[path]['version'], level), 'sha256': file_digest(top, path)}
        save(top, m)
        print('%s %s' % (path, items[path]['version']))
        return 0
    if cmd == 'adopt':
        version = argv[argv.index('--version') + 1] if '--version' in argv else '1.0.0'
        for path in matching(top, m):
            if path not in items:
                items[path] = {'version': version, 'sha256': file_digest(top, path)}
                print('%s %s' % (path, version))
        save(top, m)
        return 0
    if cmd == 'snapshot':
        print(json.dumps({p: e['version'] for p, e in sorted(items.items())}, indent=2))
        return 0
    if cmd == 'pin':
        path = argv[1].replace('\\', '/')
        print('%s@%s#%s' % (path, items[path]['version'], items[path]['sha256'][:12]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
