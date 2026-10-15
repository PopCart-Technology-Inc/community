"""Tests for leakcheck. Run: python -m unittest discover -s tools/leakcheck

Fake secrets are assembled at run time so no scanner (ours, gitleaks, GitHub push protection) ever
sees a literal token in this file.
"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'leakcheck.py')

J = ''.join
FAKE = {
    'github': J(['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8']),
    'aws': J(['AK', 'IA', 'ABCDEFGHIJKLMNOP']),
    'pkey': J(['-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----']),
    'jwt': J(['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0']),
    'assign': J(['password', ' = "', 'hunter2hunter2', '"']),
    'url': J(['postgres://', 'admin', ':', 's3cretpw', '@', 'db.internal', '/app']),
}


def run(cwd, *args, env=None, stdin=''):
    e = dict(os.environ, LEAKCHECK_PRIVATE_FILE=os.path.join(cwd, '..', 'none.txt'), LEAKCHECK_PRIVATE='')
    e.update(env or {})
    return subprocess.run([sys.executable, SCRIPT, *args], cwd=cwd, env=e, input=stdin, capture_output=True, text=True)


class LeakcheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, 'r')
        os.mkdir(self.repo)
        g = lambda *a: subprocess.run(['git', *a], cwd=self.repo, check=True, capture_output=True)
        g('init', '-q', '-b', 'main')
        g('config', 'user.name', 'Test')
        g('config', 'user.email', '1+test@users.noreply.github.com')
        g('config', 'commit.gpgsign', 'false')
        self.git = g

    def tearDown(self):
        self.tmp.cleanup()

    def stage(self, name, content):
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(content if isinstance(content, bytes) else content.encode('utf8'))
        self.git('add', name)

    def test_clean_file_passes(self):
        self.stage('README.md', 'Contact support.popcart@gmail.com. Open source.\n')
        r = run(self.repo, '--staged')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_every_secret_kind_blocks(self):
        for kind, value in FAKE.items():
            with self.subTest(kind=kind):
                self.stage('notes.md', 'x %s y\n' % value)
                r = run(self.repo, '--staged')
                self.assertEqual(r.returncode, 1, kind)
                self.assertIn('SECRET', r.stderr)
                self.assertNotIn(value, r.stderr, 'the secret itself is never printed')

    def test_secret_cannot_be_allowed(self):
        self.stage('a.md', '%s  leakcheck: allow\n' % FAKE['github'])
        self.assertEqual(run(self.repo, '--staged').returncode, 1)

    def test_personal_and_internal_details_block_but_can_be_allowed(self):
        for line in ['mail me at juan.delacruz@yahoo.com', 'call 0917 123 4567', 'server 192.168.1.20', r'see C:\Users\juan\notes']:
            with self.subTest(line=line):
                self.stage('a.md', line + '\n')
                self.assertEqual(run(self.repo, '--staged').returncode, 1, line)
                self.stage('a.md', line + '  <!-- leakcheck: allow -->\n')
                self.assertEqual(run(self.repo, '--staged').returncode, 0, line)

    def test_private_names_come_from_outside_the_repo(self):
        self.stage('a.md', 'deployed on the hidden-box server\n')
        self.assertEqual(run(self.repo, '--staged').returncode, 0)
        self.assertEqual(run(self.repo, '--staged', env={'LEAKCHECK_PRIVATE': 'Hidden-Box'}).returncode, 1)
        pf = os.path.join(self.tmp.name, 'private.txt')
        with open(pf, 'w') as f:
            f.write('# comment\nhidden-box\n')
        self.assertEqual(run(self.repo, '--staged', env={'LEAKCHECK_PRIVATE_FILE': pf}).returncode, 1)

    def test_private_name_is_never_printed(self):
        self.stage('a.md', 'deployed on the hidden-box server\n')
        r = run(self.repo, '--staged', env={'LEAKCHECK_PRIVATE': 'box'})
        self.assertEqual(r.returncode, 1)
        self.assertNotIn('box', r.stderr.lower().replace('hidden', ''), 'CI logs are public')

    def test_sign_off_email_allowed_only_in_trailer(self):
        self.stage('a.md', 'hello\n')
        self.git('commit', '-q', '-m', 'Add a\n\nSigned-off-by: Ana Cruz <ana.cruz@yahoo.com>')
        r = run(self.repo, '--history')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.stage('b.md', 'hello\n')
        self.git('commit', '-q', '-m', 'Mail ana.cruz@yahoo.com\n\nSigned-off-by: Ana Cruz <ana.cruz@yahoo.com>')
        self.assertEqual(run(self.repo, '--history').returncode, 1, 'outside the trailer it still blocks')
        r = run(self.repo, '--range', 'HEAD~1', env={'LEAKCHECK_PRIVATE': 'ana.cruz'})
        self.assertEqual(r.returncode, 1, 'private names are still checked in trailers')

    def test_forbidden_files_and_sizes(self):
        for name in ['.env', 'config/.env.production', 'deploy/server.pem', 'id_ed25519', 'gcp-service-account.json', 'dump.sqlite', 'app.apk']:
            with self.subTest(name=name):
                self.git('reset', '-q')
                self.stage(name, 'x\n')
                self.assertEqual(run(self.repo, '--staged').returncode, 1, name)
        self.git('reset', '-q')
        self.stage('.env.example', 'API_KEY=\n')
        self.assertEqual(run(self.repo, '--staged').returncode, 0)
        self.stage('big.txt', 'a' * 1_000_001)
        self.assertEqual(run(self.repo, '--staged').returncode, 1)

    def test_pre_push_checks_every_commit_and_message(self):
        self.stage('a.md', 'fine\n')
        self.git('commit', '-q', '-m', 'one')
        self.stage('a.md', 'still fine\n')
        self.git('commit', '-q', '-m', 'token ' + FAKE['aws'])
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, capture_output=True, text=True).stdout.strip()
        r = run(self.repo, '--pre-push', stdin='refs/heads/main %s refs/heads/main %s\n' % (head, '0' * 40))
        self.assertEqual(r.returncode, 1)
        self.assertIn('(message)', r.stderr)

    def test_secret_removed_later_still_blocks_history(self):
        self.stage('a.md', FAKE['jwt'] + '\n')
        self.git('commit', '-q', '-m', 'oops')
        self.stage('a.md', 'clean\n')
        self.git('commit', '-q', '-m', 'remove')
        self.assertEqual(run(self.repo, '--tree').returncode, 0)
        self.assertEqual(run(self.repo, '--history').returncode, 1, 'history still holds it')


if __name__ == '__main__':
    unittest.main()
