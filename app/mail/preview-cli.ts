// npm run mail:preview -- <out dir>
// Writes every email the app sends, as the HTML and text parts it would send, so the design can be
// checked in a browser and in email clients. Uses COMMUNITY_ORIGIN and BRAND_DIR like the server.
// The announcement is the campaign layout filled with this release's real notes, marked EXAMPLE.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { campaignEmail, inviteEmail, joinCodeEmail } from './messages.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: npm run mail:preview -- <out dir>');
mkdirSync(out, { recursive: true });
const config = loadConfig();
const inAWeek = new Date(Date.now() + 7 * 86400_000).toISOString();
const mails = {
  invite: inviteEmail(config, { expiresAt: inAWeek }),
  'invite-staff': inviteEmail(config, { expiresAt: inAWeek, staff: true }),
  code: joinCodeEmail(config, { code: '000000' }),
  announcement: campaignEmail(config, {
    subject: 'EXAMPLE · Community 0.6.0: invites by email',
    preheader: 'Invites now go to an email address, so they cannot be passed on.',
    kicker: 'Example · Release',
    headline: 'Invites now come by email.',
    lead: 'An invite works only with the address it was sent to. Forwarding it does not let anyone else in.',
    sections: [
      { title: 'Join with your email', text: 'Type the address your invite went to, then the 6-digit code we send it. Then make your passkey.' },
      { title: 'Your address is not stored', text: 'Community uses it only to send the invite and the code. A keyed hash matches it, and that is cleared when you join.' },
      { title: 'Staff invite from Settings', text: 'Settings, Invite by email. Inviting the same address again renews it for 7 days.' },
    ],
    cta: { label: 'Open Community', url: config.origin },
    note: 'This is the announcement layout, filled with the 0.6.0 notes to show it. Sending announcements to members needs a decision and an opt-in first.',
    why: 'EXAMPLE: this layout is for announcements to people who chose to get them.',
  }),
};
for (const [name, m] of Object.entries(mails)) {
  writeFileSync(join(out, `${name}.html`), m.html);
  writeFileSync(join(out, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}\n`);
}
console.log(`wrote ${Object.keys(mails).length} emails to ${out}`);
