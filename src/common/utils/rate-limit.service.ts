import { Injectable } from '@nestjs/common';

/**
 * Anti-bruteforce minimaliste (en mémoire) pour les connexions.
 * Port direct de backend/services/rate_limit.py — même algorithme, mêmes seuils.
 *
 * Note : en mémoire = par process (réinitialisé au redémarrage). Suffisant pour ralentir
 * le bruteforce ; pour du multi-instance fort, basculer sur Redis plus tard.
 */
interface Bucket {
  fails: number;
  first: number; // epoch seconds
  lockedUntil: number; // epoch seconds
}

@Injectable()
export class RateLimitService {
  private buckets = new Map<string, Bucket>();

  private now(): number {
    return Date.now() / 1000;
  }

  /** Secondes restantes de verrouillage (0 si non verrouillé). */
  lockedFor(key: string): number {
    const b = this.buckets.get(key);
    if (b && b.lockedUntil > this.now()) {
      return Math.floor(b.lockedUntil - this.now());
    }
    return 0;
  }

  /** Enregistre un échec ; verrouille pour `lock` s. après `maxFails` échecs dans `window` s. */
  fail(key: string, maxFails: number, window: number, lock: number): void {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b || now - b.first > window) {
      b = { fails: 0, first: now, lockedUntil: 0 };
    }
    b.fails += 1;
    if (b.fails >= maxFails) {
      b.lockedUntil = now + lock;
    }
    this.buckets.set(key, b);
  }

  /** Réinitialise le compteur (connexion réussie). */
  clear(key: string): void {
    this.buckets.delete(key);
  }
}
