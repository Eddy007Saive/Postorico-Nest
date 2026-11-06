import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION_API = '2021-07-28';
const DELAI_MS = 15_000;
/** Attentes avant chaque nouvel essai (3 essais au total). */
const REESSAIS_MS = [2_000, 10_000];

export interface ContactGhl {
  email: string;
  prenom?: string | null;
  nom?: string | null;
  telephone?: string | null;
}

/** Tags posés par Postorico sur les contacts GHL (brief « relier les paiements à GHL »). */
export const TAGS_GHL = {
  actif: 'abonnement-actif',
  resilie: 'abonnement-resilie',
  echec: 'paiement-echoue',
} as const;

/** Sépare « Jean Dupont » en prénom et nom (le reste du nom complet va dans le nom). */
export function decouperNom(complet: string | null | undefined): { prenom: string | null; nom: string | null } {
  const mots = (complet || '').trim().split(/\s+/).filter(Boolean);
  if (!mots.length) return { prenom: null, nom: null };
  return { prenom: mots[0], nom: mots.slice(1).join(' ') || null };
}

/**
 * GoHighLevel (API v2) : retrouve ou crée le contact par email, puis pose ou retire des tags.
 * Les workflows GHL (accueil, Club Rico, relances d'impayé) se déclenchent sur ces tags.
 *
 * Jamais bloquant : `taguer` rend la main tout de suite, le travail part en arrière-plan avec
 * 3 essais ; un échec est seulement journalisé. Sans GHL_TOKEN, rien n'est envoyé.
 */
@Injectable()
export class GhlService {
  private readonly logger = new Logger(GhlService.name);
  private readonly jeton: string;
  private readonly locationId: string;

  constructor(config: ConfigService) {
    this.jeton = config.get<string>('app.ghlToken') || '';
    this.locationId = config.get<string>('app.ghlLocationId') || '';
  }

  actif(): boolean {
    return Boolean(this.jeton && this.locationId);
  }

  /** Pose `ajouter` et retire `retirer` sur le contact, en arrière-plan. */
  taguer(contact: ContactGhl, ajouter: string[], retirer: string[], origine: string): void {
    if (!this.actif()) return;
    const email = (contact.email || '').trim().toLowerCase();
    if (!email) {
      this.logger.warn(`ghl ${origine} : pas d'email, contact ignoré`);
      return;
    }
    void this.avecEssais(() => this.appliquer({ ...contact, email }, ajouter, retirer), `${origine} ${email}`);
  }

  /** Version attendue (tests) : même travail, mais on attend la fin. */
  async appliquer(contact: ContactGhl, ajouter: string[], retirer: string[]): Promise<string> {
    const r = (await this.appel('POST', '/contacts/upsert', {
      locationId: this.locationId,
      email: contact.email,
      ...(contact.prenom ? { firstName: contact.prenom } : {}),
      ...(contact.nom ? { lastName: contact.nom } : {}),
      ...(contact.telephone ? { phone: contact.telephone } : {}),
    })) as { contact?: { id?: string } };
    const id = r?.contact?.id;
    if (!id) throw new Error('réponse sans contact.id');
    if (ajouter.length) await this.appel('POST', `/contacts/${encodeURIComponent(id)}/tags`, { tags: ajouter });
    if (retirer.length) await this.appel('DELETE', `/contacts/${encodeURIComponent(id)}/tags`, { tags: retirer });
    return id;
  }

  private async avecEssais(travail: () => Promise<string>, quoi: string): Promise<void> {
    for (let essai = 0; essai <= REESSAIS_MS.length; essai++) {
      try {
        const id = await travail();
        this.logger.log(`ghl ${quoi} : contact ${id} à jour`);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (essai === REESSAIS_MS.length) {
          this.logger.error(`ghl ${quoi} : abandon après ${essai + 1} essais (${msg})`);
          return;
        }
        this.logger.warn(`ghl ${quoi} : essai ${essai + 1} échoué (${msg}), nouvel essai`);
        await new Promise((r) => setTimeout(r, REESSAIS_MS[essai]));
      }
    }
  }

  private async appel(methode: 'POST' | 'DELETE', chemin: string, corps: unknown): Promise<unknown> {
    const r = await fetch(BASE + chemin, {
      method: methode,
      headers: {
        Authorization: `Bearer ${this.jeton}`,
        Version: VERSION_API,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const texte = await r.text();
    if (!r.ok) throw new Error(`${methode} ${chemin.replace(/contacts\/[^/]+\//, 'contacts/…/')} ${r.status} ${texte.slice(0, 160)}`);
    try {
      return texte ? JSON.parse(texte) : null;
    } catch {
      return null;
    }
  }
}
