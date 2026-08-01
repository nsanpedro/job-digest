/**
 * .eml → InboundEmail: the shape both acquisition paths converge on (§4.5).
 * The IMAP worker and the forwarding webhook produce exactly this; everything
 * downstream (classify, declare, extract) is shared.
 */
import { simpleParser } from 'mailparser';

export interface MimeParts {
  hasHtml: boolean;
  hasText: boolean;
  /** Content types of attachments — how the image-only email is diagnosed (§6.1). */
  attachmentTypes: string[];
}

export interface InboundEmail {
  messageId: string;
  fromAddr: string;
  subject: string;
  receivedAt: Date;
  bodyText: string | null;
  bodyHtml: string | null;
  mimeParts: MimeParts;
}

export async function parseEml(raw: Buffer): Promise<InboundEmail> {
  const mail = await simpleParser(raw);
  const fromAddr = mail.from?.value[0]?.address ?? '';
  return {
    messageId: mail.messageId ?? `<missing-${Date.now()}@job-digest.local>`,
    fromAddr,
    subject: mail.subject ?? '',
    receivedAt: mail.date ?? new Date(0),
    bodyText: typeof mail.text === 'string' && mail.text.length > 0 ? mail.text : null,
    bodyHtml: typeof mail.html === 'string' && mail.html.length > 0 ? mail.html : null,
    mimeParts: {
      hasHtml: typeof mail.html === 'string' && mail.html.length > 0,
      hasText: typeof mail.text === 'string' && mail.text.length > 0,
      attachmentTypes: mail.attachments.map((a) => a.contentType),
    },
  };
}

/**
 * The raw bytes of an embedded message/rfc822 part, if one exists — how a
 * manual "Forward" is told apart from a header-preserving auto-forward
 * filter (design §4.5). A mail client's "Forward" action typically wraps the
 * original message as an attachment of this content type rather than
 * preserving its headers on the outer message; the forwarding acquisition
 * path (@job-digest/worker's forwarding.ts) falls back to this when the
 * outer message's own From: isn't allowlisted, keeping mailparser fully
 * inside this package rather than duplicated in the worker.
 */
export async function findEmbeddedMessage(raw: Buffer): Promise<Buffer | null> {
  const mail = await simpleParser(raw);
  const embedded = mail.attachments.find((a) => a.contentType === 'message/rfc822');
  if (!embedded) return null;
  return Buffer.isBuffer(embedded.content) ? embedded.content : Buffer.from(embedded.content);
}
