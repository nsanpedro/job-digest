/**
 * Account overview for Profile's account section — real columns only.
 * subscriptionStatus reads the actual accounts.subscription_status value
 * (null today, since billing isn't wired up); mailboxes reflects whatever
 * was actually connected via OAuth (design §4.5/§9). Nothing here is
 * invented to fill out a "classic SaaS settings" look.
 */
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { accounts, mailboxes } from '../schema';

type Db = PostgresJsDatabase<Record<string, unknown>>;

export interface AccountOverview {
  email: string;
  subscriptionStatus: string | null;
  createdAt: Date;
  city: string | null;
  remoteOk: boolean;
  mailboxes: Array<{
    id: string;
    provider: string;
    authKind: string;
    emailAddress: string;
    status: string;
    credentialExpiresAt: Date | null;
  }>;
}

export async function getAccountOverview(db: Db, userId: string): Promise<AccountOverview | null> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, userId)).limit(1);
  if (!account) return null;

  const boxes = await db
    .select({
      id: mailboxes.id,
      provider: mailboxes.provider,
      authKind: mailboxes.authKind,
      emailAddress: mailboxes.emailAddress,
      status: mailboxes.status,
      credentialExpiresAt: mailboxes.credentialExpiresAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId))
    .orderBy(desc(mailboxes.createdAt));

  return {
    email: account.email,
    subscriptionStatus: account.subscriptionStatus,
    createdAt: account.createdAt,
    city: account.city,
    remoteOk: account.remoteOk,
    mailboxes: boxes,
  };
}
