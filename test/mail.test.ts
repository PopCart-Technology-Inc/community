import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../app/config.ts';
import { campaignEmail, inviteEmail, joinCodeEmail } from '../app/mail/messages.ts';
import { sendMail } from '../app/mail/send.ts';

const config = loadConfig({ COMMUNITY_ORIGIN: 'https://community.example.org' });

test('emails: no scripts, no web fonts, no tracking, only https links without parameters', () => {
  for (const m of [inviteEmail(config, { expiresAt: '2026-10-27T00:00:00Z' }), joinCodeEmail(config, { code: '042137' })]) {
    assert.doesNotMatch(m.html, /<script|<link|@import|fonts\.googleapis|<style/i);
    assert.doesNotMatch(m.html, /gradient|blur\(|rgba\(/i, 'Bold Pop: flat colours, hard edges');
    for (const [, url] of m.html.matchAll(/href="([^"]+)"/g)) {
      assert.match(url!, /^https:\/\/community\.example\.org(\/join)?$/);
    }
    assert.ok(m.text.length > 50, 'every email has a plain-text part');
  }
  const code = joinCodeEmail(config, { code: '042137' });
  assert.match(code.subject, /042137/);
  assert.match(code.html, />042137</);
  assert.match(code.text, /^042137$/m);
});

test('emails: the wordmark comes from the brand pack, else the plain name', () => {
  const plain = inviteEmail(config, { expiresAt: '2026-10-27T00:00:00Z' });
  assert.doesNotMatch(plain.html, /<img/);
  assert.match(plain.html, />PopCart Community</);
  const dir = mkdtempSync(join(tmpdir(), 'cm-brand-'));
  mkdirSync(join(dir, 'email'));
  writeFileSync(join(dir, 'email', 'wordmark.png'), 'png');
  const branded = inviteEmail({ ...config, brandDir: dir }, { expiresAt: '2026-10-27T00:00:00Z', staff: true });
  assert.match(branded.html, /<img src="https:\/\/community\.example\.org\/brand\/email\/wordmark\.png"[^>]+alt="PopCart"/);
  assert.match(branded.html, /Invite · Staff/);
});

test('campaign layout escapes what it is given and refuses non-web links', () => {
  const m = campaignEmail(config, {
    subject: 'Test <b>', preheader: 'p', kicker: 'k', headline: 'Hello <script>alert(1)</script>', lead: 'l',
    sections: [{ title: 'A & B', text: 'one' }], cta: { label: 'Go', url: 'javascript:alert(1)' }, why: 'test only',
  });
  assert.doesNotMatch(m.html, /<script>|javascript:/);
  assert.match(m.html, /Hello &lt;script&gt;/);
  assert.match(m.html, /A &amp; B/);
  assert.match(m.html, /href="#"/);
});

test('sending: without a key, a public server refuses (503) instead of dropping the email', async () => {
  await assert.rejects(sendMail(config, 'a@example.com', joinCodeEmail(config, { code: '123456' })), (e: { status?: number }) => e.status === 503);
  let body: Record<string, unknown> = {};
  const fake = (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  await sendMail({ ...config, resendKey: 'test-key', mailFrom: 'Community <hello@example.org>' }, 'a@example.com', joinCodeEmail(config, { code: '123456' }), fake);
  assert.deepEqual(body.to, ['a@example.com']);
  assert.equal(body.from, 'Community <hello@example.org>');
  const down = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(sendMail({ ...config, resendKey: 'k', mailFrom: 'x <x@example.org>' }, 'a@example.com', joinCodeEmail(config, { code: '1' }), down), (e: { status?: number }) => e.status === 503);
});
