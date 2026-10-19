// The emails Community sends, in the design from design.ts. Voice: plain words, one idea per line,
// at most one wink. No tracking, and no links that carry anything about the person.
import type { Config } from '../config.ts';
import { button, codeChip, fine, headline, kicker, lead, note, para, picture, sections, shell, steps, type Block, type Email } from './design.ts';

const day = (iso: string) => new Date(iso).toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Manila' });

/** The invite. The link carries no code: joining needs this address and the code sent to it. */
export function inviteEmail(config: Config, m: { expiresAt: string; staff?: boolean }): Email {
  const until = day(m.expiresAt);
  return shell(config, {
    subject: `You're invited to ${config.rpName}`,
    preheader: `Join with this email address before ${until}.`,
    blocks: [
      kicker(m.staff ? 'Invite · Staff' : 'Invite'),
      headline('Come on in.'),
      lead(`You're invited to ${config.rpName}, the network for people who work: show your work, find your crew, get hired.`),
      steps([
        'Open the join page.',
        'Type this email address.',
        'Enter the 6-digit code we send you, then make your passkey. No password.',
      ]),
      button('Join Community', config.origin + '/join'),
      note(`This invite works only with this email address, until ${until}. Forwarding this email does not let anyone else in.`),
      fine('Not expecting this? Ignore it. Nothing happens unless you join.'),
    ],
    why: 'You got this email because a Community staff member invited this address.',
  });
}

/** The one-time code for joining. */
export function joinCodeEmail(config: Config, m: { code: string }): Email {
  return shell(config, {
    subject: `Your Community code: ${m.code}`,
    preheader: 'Type it on the join page. It works for 10 minutes.',
    blocks: [
      kicker('Join code'),
      headline("Here's your code."),
      codeChip(m.code),
      lead('Type it on the join page. It works for 10 minutes, once.'),
      fine("Didn't ask for it? Ignore this email. Nobody can join with your address without this code."),
    ],
    why: 'You got this email because someone typed this address on the Community join page.',
  });
}

/**
 * An announcement (a release, an event, an invite wave): the campaign layout. Content comes from the
 * person sending it; nothing here is filled in for them.
 */
export interface Campaign {
  subject: string;
  preheader: string;
  kicker: string;
  headline: string;
  lead: string;
  picture?: { src: string; alt: string; width: number; height: number };
  sections?: { title: string; text: string }[];
  body?: string[];
  cta?: { label: string; url: string };
  note?: string;
  why: string;
}

export function campaignEmail(config: Config, c: Campaign): Email {
  const blocks: Block[] = [kicker(c.kicker), headline(c.headline), lead(c.lead)];
  if (c.picture) blocks.push(picture(c.picture.src, c.picture.alt, c.picture.width, c.picture.height));
  if (c.sections?.length) blocks.push(sections(c.sections));
  for (const p of c.body || []) blocks.push(para(p));
  if (c.cta) blocks.push(button(c.cta.label, c.cta.url));
  if (c.note) blocks.push(note(c.note, 'cream'));
  return shell(config, { subject: c.subject, preheader: c.preheader, blocks, why: c.why });
}
