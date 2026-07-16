import { google } from 'googleapis';
import { getAuthorizedClient } from './auth';
import { stripDashes } from '../textStyle';

export interface FetchedEmail {
  gmail_id: string;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  snippet: string;
  received_at: string;
  is_unread: boolean;
}

function header(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  const h = (headers || []).find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/** List recent inbox messages for a mailbox, with light metadata. */
export async function listRecentEmails(email: string, query: string, maxResults: number): Promise<FetchedEmail[]> {
  const auth = getAuthorizedClient(email);
  if (!auth) return [];
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);

  const out: FetchedEmail[] = [];
  for (const id of ids) {
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const h = msg.data.payload?.headers || [];
      const internal = msg.data.internalDate ? new Date(Number(msg.data.internalDate)).toISOString() : '';
      out.push({
        gmail_id: id,
        thread_id: msg.data.threadId || id,
        from_addr: header(h, 'From'),
        to_addr: header(h, 'To') || email,
        subject: header(h, 'Subject'),
        snippet: msg.data.snippet || '',
        received_at: internal || header(h, 'Date'),
        is_unread: (msg.data.labelIds || []).includes('UNREAD'),
      });
    } catch {
      /* skip a message that fails to fetch */
    }
  }
  return out;
}

/** Full plain-text body of a message (best-effort) for drafting a good reply. */
export async function getEmailBody(email: string, gmailId: string): Promise<string> {
  const auth = getAuthorizedClient(email);
  if (!auth) return '';
  const gmail = google.gmail({ version: 'v1', auth });
  const msg = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });

  const parts = msg.data.payload?.parts || [];
  const findText = (): string => {
    const direct = msg.data.payload?.body?.data;
    if (direct) return Buffer.from(direct, 'base64').toString('utf8');
    for (const p of parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        return Buffer.from(p.body.data, 'base64').toString('utf8');
      }
    }
    for (const p of parts) {
      if (p.mimeType === 'text/html' && p.body?.data) {
        return Buffer.from(p.body.data, 'base64').toString('utf8').replace(/<[^>]+>/g, ' ');
      }
    }
    return msg.data.snippet || '';
  };
  return findText().slice(0, 6000);
}

function encodeRaw(mime: string): string {
  return Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Send a reply in-thread. Only ever called after Arthur approves the draft. */
export async function sendEmailReply(email: string, opts: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}): Promise<{ id: string; threadId: string }> {
  const auth = getAuthorizedClient(email);
  if (!auth) throw new Error(`Account ${email} is not connected`);
  const gmail = google.gmail({ version: 'v1', auth });

  opts = { ...opts, subject: stripDashes(opts.subject), body: stripDashes(opts.body) };
  const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  const lines = [
    `From: ${email}`,
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (opts.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  lines.push('', opts.body);

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodeRaw(lines.join('\r\n')), threadId: opts.threadId },
  });
  return { id: res.data.id || '', threadId: res.data.threadId || opts.threadId || '' };
}

/** Send a brand-new email (compose) from a mailbox. Explicit user action. */
export async function sendNewEmail(email: string, opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<{ id: string }> {
  const auth = getAuthorizedClient(email);
  if (!auth) throw new Error(`Account ${email} is not connected`);
  opts = { ...opts, subject: stripDashes(opts.subject), body: stripDashes(opts.body) };
  const gmail = google.gmail({ version: 'v1', auth });
  const mime = [
    `From: ${email}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    opts.body,
  ].join('\r\n');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeRaw(mime) } });
  return { id: res.data.id || '' };
}

export async function markEmailRead(email: string, gmailId: string): Promise<void> {
  const auth = getAuthorizedClient(email);
  if (!auth) return;
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({ userId: 'me', id: gmailId, requestBody: { removeLabelIds: ['UNREAD'] } });
}
