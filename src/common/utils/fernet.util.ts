import * as crypto from 'crypto';

/**
 * Implémentation minimale du format Fernet (https://github.com/fernet/spec), pour rester
 * bit-à-bit compatible avec `cryptography.fernet.Fernet` côté Python (port de
 * backend/services/affiliation_service.py::chiffrer_iban/dechiffrer_iban — IBAN des
 * affiliés). Aucune dépendance ajoutée : le format est figé (AES-128-CBC + HMAC-SHA256,
 * PKCS7), entièrement couvert par le module `crypto` intégré à Node.
 *
 * Format du jeton : version(1o, 0x80) || horodatage(8o, BE) || IV(16o) ||
 * chiffré(PKCS7, AES-128-CBC) || HMAC-SHA256(32o), le tout encodé en base64 URL-safe.
 * Clé Fernet : 32 octets bruts, moitié signature (HMAC) / moitié chiffrement (AES) —
 * dérivée ici de JWT_SECRET par SHA-256, exactement comme côté Python.
 */

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

export class Fernet {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;

  /** `keySecret` : le texte source (ex. JWT_SECRET) — dérivé en clé Fernet 32 octets par
   * SHA-256, comme `_fernet()` côté Python. */
  constructor(keySecret: string) {
    const raw = crypto.createHash('sha256').update(keySecret, 'utf-8').digest(); // 32 octets
    this.signingKey = raw.subarray(0, 16);
    this.encryptionKey = raw.subarray(16, 32);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.encryptionKey, iv); // PKCS7 auto
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    const payload = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
    const hmac = crypto.createHmac('sha256', this.signingKey).update(payload).digest();
    return b64urlEncode(Buffer.concat([payload, hmac]));
  }

  /** Retourne null si le jeton est invalide, mal signé, ou n'est pas un Fernet valide
   * (jamais une exception : même politique que `InvalidToken` côté Python). */
  decrypt(token: string): string | null {
    try {
      const raw = b64urlDecode(token);
      if (raw.length < 1 + 8 + 16 + 32) return null;
      const version = raw[0];
      if (version !== 0x80) return null;
      const payload = raw.subarray(0, raw.length - 32);
      const hmacRecu = raw.subarray(raw.length - 32);
      const hmacAttendu = crypto.createHmac('sha256', this.signingKey).update(payload).digest();
      if (hmacRecu.length !== hmacAttendu.length || !crypto.timingSafeEqual(hmacRecu, hmacAttendu)) return null;
      const iv = payload.subarray(9, 25);
      const ciphertext = payload.subarray(25);
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.encryptionKey, iv);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf-8');
    } catch {
      return null;
    }
  }
}
