#!/usr/bin/env python3
"""Claude Code PreToolUse guard for this PUBLIC repo (wired in .claude/settings.json).

Blocks (exit 2, reason on stderr) any shell command that would skip or weaken the leak checks:
  - --no-verify / -n on commit or push, or editing core.hooksPath;
  - force pushes (they can rewrite history someone already reviewed);
  - a push or commit while this clone's hooks are not switched on (core.hooksPath != .githooks);
  - a push when the full-tree leak check fails.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def block(why):
    print('PUBLIC REPO GUARD: ' + why + '\nSecurity and leaks come first here. See AGENTS.md.', file=sys.stderr)
    sys.exit(2)


def main():
    try:
        cmd = json.load(sys.stdin).get('tool_input', {}).get('command', '') or ''
    except Exception:
        block('could not read the command (failing closed)')
    if not re.search(r'\bgit\b', cmd):
        return
    if re.search(r'--no-verify\b', cmd) or re.search(r'\bgit\b[^;&|]*\b(commit|push)\b[^;&|]*\s-[a-zA-Z]*n\b', cmd):
        block('--no-verify is not allowed: the leak hooks must run.')
    if re.search(r'core\.hookspath', cmd, re.I) and not re.search(r'core\.hooksPath\s+\.githooks\s*($|[;&|])', cmd):
        block('changing core.hooksPath away from .githooks is not allowed.')
    if re.search(r'\bpush\b[^;&|]*(--force|--force-with-lease|\s-f\b|\s\+\S)', cmd):
        block('force push is not allowed on a public repo.')
    if re.search(r'\bgit\b[^;&|]*\b(commit|push)\b', cmd):
        hp = subprocess.run(['git', '-C', ROOT, 'config', '--get', 'core.hooksPath'], capture_output=True, text=True).stdout.strip()
        if hp != '.githooks':
            block('leak hooks are off in this clone. Run: git config core.hooksPath .githooks')
    if re.search(r'\bgit\b[^;&|]*\bpush\b', cmd):
        r = subprocess.run([sys.executable, os.path.join(HERE, 'leakcheck.py'), '--tree'], cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            block('leak check failed on the current tree:\n' + r.stderr)


if __name__ == '__main__':
    main()
