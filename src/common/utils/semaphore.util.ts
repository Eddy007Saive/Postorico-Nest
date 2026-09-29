/**
 * Sémaphore générique en promesses (borne la concurrence d'un atelier de rendu —
 * Playwright pour les carrousels, Remotion pour les reels/stories animées). `acquire`
 * rejette avec l'erreur fournie par `onTimeout` si personne ne libère de jeton avant
 * `timeoutMs` — l'appelant HTTP doit répondre 503, jamais attendre indéfiniment.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    max: number,
    private readonly onTimeout: () => Error,
  ) {
    this.available = max;
  }

  acquire(timeoutMs: number): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.available--;
          resolve();
        },
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(this.onTimeout());
        }, timeoutMs),
      };
      this.queue.push(entry);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.available++;
  }
}
