// Sending email through Resend's REST API (RESEND_API_KEY). Without a key, on http://localhost the
// email is kept in `devOutbox` and printed, so the app can be tried without an email account;
// anywhere else sending fails with 503, so an invite or a code is never silently dropped.
// The address is used to send, and is never logged or stored here. The email service keeps its own
// delivery log (decision 0008 says so).
import type { Config } from '../config.ts';
import { HttpError } from '../http/router.ts';
import type { Email } from './design.ts';

const RESEND_URL = 'https://api.resend.com/emails';

/** Emails "sent" without a key on a local origin (newest last). For trying the app and for tests. */
export const devOutbox: (Email & { to: string })[] = [];

const local = (origin: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

export async function sendMail(config: Config, to: string, email: Email, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.resendKey) {
    if (!local(config.origin)) throw new HttpError(503, 'mail_down', "We can't send email right now. Try again later.");
    devOutbox.push({ to, ...email });
    if (devOutbox.length > 50) devOutbox.shift();
    if (!process.env.NODE_TEST_CONTEXT) console.log(`dev: email to ${to}: ${email.subject}`);
    return;
  }
  let r: Response;
  try {
    r = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject: email.subject, text: email.text, html: email.html }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'mail unreachable', err: (e as Error)?.name || 'error' }));
    throw new HttpError(503, 'mail_down', "We couldn't send the email. Try again in a minute.");
  }
  if (!r.ok) {
    console.error(JSON.stringify({ level: 'error', msg: 'mail refused', status: r.status }));
    throw new HttpError(503, 'mail_down', "We couldn't send the email. Try again in a minute.");
  }
}
