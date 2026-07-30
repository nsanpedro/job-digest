import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/credentials';

describe('encryptSecret / decryptSecret', () => {
  const key = randomBytes(32);

  it('round-trips a plaintext secret', () => {
    const sealed = encryptSecret('ya29.a0Ael9...refresh-token', key);
    expect(decryptSecret(sealed, key)).toBe('ya29.a0Ael9...refresh-token');
  });

  it('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    const a = encryptSecret('same-secret', key);
    const b = encryptSecret('same-secret', key);
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it('rejects tampering — the auth tag catches it', () => {
    const sealed = encryptSecret('secret', key);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0xff;
    expect(() => decryptSecret(sealed, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const sealed = encryptSecret('secret', key);
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptSecret('secret', randomBytes(16))).toThrow(/32 bytes/);
  });
});
