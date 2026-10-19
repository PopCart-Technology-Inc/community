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


BASE = """# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-15
### Added
- First
"""


def with_unreleased(lines, base=BASE):
    return base.replace('## [Unreleased]\n', '## [Unreleased]\n' + lines, 1)


def release(version, lines, base=BASE, date=' - 2026-11-01'):
    return base.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [%s]%s\n%s' % (version, date, lines), 1)


class CheckTest(unittest.TestCase):
    def test_every_change_adds_an_unreleased_line(self):
        self.assertEqual(changelog.check(BASE, with_unreleased('### Fixed\n- A fix\n')), [])
        self.assertEqual(len(changelog.check(BASE, BASE)), 1)
        self.assertEqual(len(changelog.check(BASE, with_unreleased('### Fixed\n'))), 1)
        old = with_unreleased('### Fixed\n- A fix\n')
        self.assertEqual(len(changelog.check(old, old)), 1, 'a line already there does not count again')

    def test_released_sections_never_change(self):
        edited = with_unreleased('### Fixed\n- A fix\n').replace('- First', '- First, reworded')
        self.assertIn('edited', changelog.check(BASE, edited)[0])
        self.assertIn('removed', changelog.check(BASE, '# Changelog\n\n## [Unreleased]\n- x\n')[0])
        self.assertIn('Unreleased', changelog.check(BASE, '# Changelog\n\n## [0.1.0] - 2026-10-15\n### Added\n- First\n')[0])

    def test_release_bump_matches_its_lines(self):
        ok = [('0.1.1', '### Fixed\n- A fix\n'), ('0.1.1', '### Security\n- Safer\n'),
              ('0.2.0', '### Added\n- New\n'), ('0.2.0', '### Changed\n- Other\n'),
              ('0.2.0', '### Removed\n- Gone\n'), ('0.2.0', '### Fixed\n- BREAKING: old links stop working\n'),
              ('1.0.0', '### Fixed\n- A fix\n')]
        for v, lines in ok:
            with self.subTest(v=v, lines=lines):
                self.assertEqual(changelog.check(BASE, release(v, lines)), [])
        bad = [('0.2.0', '### Fixed\n- A fix\n'), ('0.1.1', '### Added\n- New\n'), ('0.1.2', '### Fixed\n- A fix\n'),
               ('0.3.0', '### Added\n- New\n'), ('0.1.0', '### Fixed\n- A fix\n'), ('0.0.9', '### Fixed\n- A fix\n'),
               ('0.2', '### Added\n- New\n'), ('0.2.0-beta', '### Added\n- New\n')]
        for v, lines in bad:
            with self.subTest(v=v, lines=lines):
                self.assertNotEqual(changelog.check(BASE, release(v, lines)), [])

    def test_stable_versions_bump_major_for_breaking(self):
        stable = BASE.replace('0.1.0', '1.4.2')
        self.assertEqual(changelog.check(stable, release('2.0.0', '### Removed\n- Gone\n', stable)), [])
        self.assertNotEqual(changelog.check(stable, release('1.5.0', '### Removed\n- Gone\n', stable)), [])
        self.assertEqual(changelog.check(stable, release('1.5.0', '### Added\n- New\n', stable)), [])
        self.assertEqual(changelog.check(stable, release('1.4.3', '### Fixed\n- Fix\n', stable)), [])

    def test_release_rules(self):
        self.assertIn('no date', ' '.join(changelog.check(BASE, release('0.1.1', '### Fixed\n- A fix\n', date=''))))
        self.assertIn('no lines', ' '.join(changelog.check(BASE, release('0.1.1', '### Fixed\n'))))
        left = release('0.1.1', '### Fixed\n- A fix\n').replace('## [Unreleased]\n', '## [Unreleased]\n- Leftover\n', 1)
        self.assertIn('Unreleased must be empty', ' '.join(changelog.check(BASE, left)))
        two = release('0.2.0', '### Added\n- New\n', release('0.1.1', '### Fixed\n- A fix\n'))
        self.assertIn('one release at a time', changelog.check(BASE, two)[0])

    def test_tags_only_move_forward(self):
        changelog.tag_order('v0.2.0', ['v0.1.0', 'v0.1.1', 'v0.2.0'])
        for tag, tags in [('v0.1.1', ['v0.2.0']), ('v0.2.0', ['v0.2.0', 'v1.0.0']), ('v0.2', []), ('0.2.0', [])]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                changelog.tag_order(tag, tags)

    def test_against_a_real_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            g = lambda *a: subprocess.run(['git', *a], cwd=tmp, check=True, capture_output=True, text=True).stdout.strip()

            def write(name, text):
                with open(os.path.join(tmp, name), 'w', encoding='utf8') as f:
                    f.write(text)

            g('init', '-q', '-b', 'main')
            g('config', 'user.name', 'Ana')
            g('config', 'user.email', 'ana@example.com')
            g('config', 'commit.gpgsign', 'false')
            write('CHANGELOG.md', BASE)
            g('add', '.')
            g('commit', '-q', '-m', 'base')
            base = g('rev-parse', 'HEAD')
            cli = lambda *a: subprocess.run([sys.executable, os.path.join(HERE, 'changelog.py'), *a], cwd=tmp, capture_output=True, text=True)
            self.assertEqual(cli('check', base, 'HEAD').returncode, 0, 'no new commits: nothing to check')
            write('app.txt', 'x')
            g('add', '.')
            g('commit', '-q', '-m', 'change without a line')
            self.assertEqual(cli('check', base, 'HEAD').returncode, 1)
            write('CHANGELOG.md', with_unreleased('### Added\n- Something\n'))
            g('commit', '-q', '-am', 'add the line')
            r = cli('check', base, 'HEAD')
            self.assertEqual(r.returncode, 0, r.stderr)
            g('tag', 'v0.1.0', base)
            self.assertEqual(cli('tag', 'v0.2.0').returncode, 0)
            self.assertEqual(cli('tag', 'v0.0.1').returncode, 1)


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
