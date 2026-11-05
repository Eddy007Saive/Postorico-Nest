import * as crypto from 'crypto';

/** Outils longs (remplir le mois, carrousel…) : au-delà de DELAI_REPONSE_MS, le connecteur
 * répond « en cours » et le travail continue ; le résultat est gardé une heure, lisible avec
 * get_task_status. Les clients MCP coupent souvent l'attente vers 30 à 60 s.
 * Mémoire du processus : une seule instance aujourd'hui (voir Redis avant 2+ réplicas). */

export const DELAI_REPONSE_MS = 20_000;
const CONSERVATION_MS = 3600_000;

interface Tache {
  telegramId: string;
  outil: string;
  debut: number;
  fin?: number;
  resultat?: unknown;
  erreur?: string;
}

export const OUTIL_SUIVI = {
  name: 'get_task_status',
  title: "Suivre une tâche en cours",
  description:
    "Résultat d'un outil long (remplir le mois, carrousel, image…) qui a répondu « en cours » avec un tache_id. Si la tâche n'est pas finie, réessaie dans 20 à 30 secondes ; les contenus créés apparaissent aussi au fur et à mesure dans get_pending_approvals.",
  inputSchema: { type: 'object', properties: { tache_id: { type: 'string' } }, required: ['tache_id'] },
  annotations: { readOnlyHint: true },
};

export class TachesMcp {
  private readonly taches = new Map<string, Tache>();

  /** Attend la fin au plus DELAI_REPONSE_MS ; sinon renvoie l'id d'une tâche qui continue. */
  async lancer<T>(telegramId: string, outil: string, travail: Promise<T>, delaiMs = DELAI_REPONSE_MS): Promise<{ fini: true; resultat: T } | { fini: false; tacheId: string }> {
    let minuteur: NodeJS.Timeout | undefined;
    const delai = new Promise<'delai'>((r) => (minuteur = setTimeout(() => r('delai'), delaiMs)));
    // Aucune promesse dérivée ne doit pouvoir être rejetée sans traitement (arrêt du serveur)
    const issue = await Promise.race([travail.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })), delai]);
    clearTimeout(minuteur);
    if (issue !== 'delai') {
      if (!issue.ok) throw issue.e;
      return { fini: true, resultat: issue.r };
    }
    this.nettoyer();
    const tacheId = crypto.randomUUID();
    const tache: Tache = { telegramId, outil, debut: Date.now() };
    this.taches.set(tacheId, tache);
    travail.then(
      (r) => Object.assign(tache, { fin: Date.now(), resultat: r }),
      (e) => Object.assign(tache, { fin: Date.now(), erreur: e instanceof Error ? e.message : String(e) }),
    );
    return { fini: false, tacheId };
  }

  /** Une tâche n'est lisible que par son propriétaire. */
  etat(telegramId: string, tacheId: string) {
    const t = this.taches.get(tacheId);
    if (!t || t.telegramId !== telegramId) return null;
    const secondes = Math.round(((t.fin ?? Date.now()) - t.debut) / 1000);
    if (!t.fin) return { tache_id: tacheId, outil: t.outil, statut: 'en_cours', depuis_secondes: secondes };
    if (t.erreur) return { tache_id: tacheId, outil: t.outil, statut: 'echec', erreur: t.erreur, duree_secondes: secondes };
    return { tache_id: tacheId, outil: t.outil, statut: 'terminee', duree_secondes: secondes, resultat: t.resultat };
  }

  private nettoyer() {
    const limite = Date.now() - CONSERVATION_MS;
    for (const [id, t] of this.taches) if ((t.fin ?? t.debut) < limite) this.taches.delete(id);
  }
}
