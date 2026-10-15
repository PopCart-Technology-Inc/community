"""Tests for the pull request and release checks. Run: python -m unittest discover -s tools/ci"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import changelog  # noqa: E402
import dco  # noqa: E402

LOG = """# Changelog

## [Unreleased]
### Added
- Something new

## [0.2.0] - 2026-11-01
### Fixed
- A fix

## [0.1.0] - 2026-10-15
### Added
- First

## [0.0.9]

[Unreleased]: https://example.com/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
"""


class ChangelogTest(unittest.TestCase):
    def test_notes_for_a_released_version(self):
        self.assertEqual(changelog.notes(LOG, 'v0.2.0'), '### Fixed\n- A fix')
        self.assertEqual(changelog.notes(LOG, 'v0.1.0'), '### Added\n- First')

    def test_blocks_bad_or_missing_versions(self):
        for tag in ['0.1.0', 'v1.0', 'v01.0.0', 'v0.3.0', 'vUnreleased', 'v0.0.9']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                changelog.notes(LOG, tag)


class DcoTest(unittest.TestCase):
    def test_rules(self):
        ok = ('a' * 40, 'Ana', 'ana@example.com', 'Fix\n\nSigned-off-by: Ana <ana@example.com>\n')
        caps = ('b' * 40, 'Ana', 'Ana@Example.com', 'Fix\n\nSigned-off-by: Ana <ana@example.com>')
        none = ('c' * 40, 'Ben', 'ben@example.com', 'Fix')
        other = ('d' * 40, 'Ben', 'ben@example.com', 'Fix\n\nSigned-off-by: Ana <ana@example.com>')
        bot = ('e' * 40, 'dependabot[bot]', '1+dependabot[bot]@users.noreply.github.com', 'Bump')
        self.assertEqual(dco.problems([ok, caps, bot]), [])
        self.assertEqual(len(dco.problems([none, other])), 2)

    def test_against_a_real_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            g = lambda *a: subprocess.run(['git', *a], cwd=tmp, check=True, capture_output=True, text=True).stdout.strip()
            g('init', '-q', '-b', 'main')
            g('config', 'user.name', 'Ana')
            g('config', 'user.email', 'ana@example.com')
            g('config', 'commit.gpgsign', 'false')
            g('commit', '-q', '--allow-empty', '-m', 'base')
            base = g('rev-parse', 'HEAD')
            g('commit', '-q', '--allow-empty', '-s', '-m', 'signed')
            run = lambda: subprocess.run([sys.executable, os.path.join(HERE, 'dco.py'), base, 'HEAD'], cwd=tmp, capture_output=True, text=True)
            self.assertEqual(run().returncode, 0, run().stderr)
            g('commit', '-q', '--allow-empty', '-m', 'unsigned')
            self.assertEqual(run().returncode, 1)


if __name__ == '__main__':
    unittest.main()
