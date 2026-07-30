/**
 * Symmetric encryption for stored credentials (mailbox app passwords, OAuth
 * refresh tokens) — design §4.2. AES-256-GCM, random IV per call, IV and
 * auth tag packed alongside the ciphertext so one Buffer round-trips whole.
 *
 * This is the v1 simplification the design doc names as acceptable for a
 * single-key deployment (§13 open decision 3: "for a single-user
 * self-hosted deployment, an env-var key is defensible; it should be stated
 * as a limitation, not hidden"). It does NOT implement the full envelope
 * scheme from §4.2 — a per-user DEK wrapped by a KMS-held KEK, with
 * rotation that rewraps DEKs without touching ciphertext. Today there is
 * one static key, read from the environment by each caller and passed in
 * here; this module never reads the environment itself, which keeps it
 * pure and testable.
 *
 * I13 in this codebase currently holds as a *convention*, not a proof: only
 * @job-digest/app imports encryptSecret (it receives tokens during OAuth and
 * writes them, never needs them back), and only @job-digest/worker imports
 * decryptSecret. Both processes have access to the same key material via
 * their own environment, so the boundary is not yet cryptographically
 * enforced the way the KMS envelope would enforce it. Closing that gap is
 * exactly the §4.2 work item this simplification stands in for.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (AES-256)');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptSecret(sealed: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (AES-256)');
  const iv = sealed.subarray(0, IV_LENGTH);
  const tag = sealed.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = sealed.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
