import { BadRequestException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { BillingService } from '../billing/billing.service';
import { ImpayeService } from '../impaye/impaye.service';
import { STATUTS_INDEXES } from '../memoire/memoire.service';
import { MarqueService } from '../marque/marque.service';
import { QuotaService } from '../quota/quota.service';
import { SocialService } from '../social/social.service';

/**
 * Démarrage guidé : où en est un compte dans ses premiers pas, calculé depuis les données
 * (jamais une case cochée) — port de backend/services/demarrage_service.py.
 *
 *   profil      : secteur, voix_marque, audience, piliers renseignés (table marques)   BLOQUANT
 *   reseau      : au moins un réseau connecté (comptes_sociaux)                        BLOQUANT
 *   carte       : un abonnement (essai / actif / past_due)                             BLOQUANT
 *   sujets      : au moins un sujet généré (brouillons)
 *   post        : au moins un contenu rédigé (contenu)
 *   validation  : au moins un contenu validé / planifié / publié
 *
 * Portée réduite : `exiger_profil` enchaînait aussi côté Python
 * `impaye_service.exiger_reconnexion` (reconnexion d'au moins un réseau après une
 * suspension pour impayé régularisée) — TODO une fois impaye_service porté.
 */
const CHAMPS_MINIMUM = ['secteur', 'voix_marque', 'audience', 'piliers'] as const;
const ORDRE = ['profil', 'reseau', 'carte', 'sujets', 'post', 'validation'] as const;
const BLOQUANTES = new Set(['profil', 'reseau', 'carte']);
const TTL_MS = 20_000;

function rempli(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => String(x ?? '').trim());
  return Boolean(String(v ?? '').trim());
}

interface Etape {
  id: (typeof ORDRE)[number];
  fait: boolean | null;
  manquants?: string[];
  n?: number;
  ancien_abonne?: boolean;
  date_premiere_publication?: Date | null;
}

export interface EtatDemarrage {
  etapes: Etape[];
  courante: string | null;
  bloquant: boolean;
  termine: boolean;
}

@Injectable()
export class DemarrageService {
  private readonly logger = new Logger(DemarrageService.name);
  private readonly cache = new Map<string, { at: number; etat: EtatDemarrage }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly marqueService: MarqueService,
    private readonly socialService: SocialService,
    private readonly quotaService: QuotaService,
    private readonly billingService: BillingService,
    @Inject(forwardRef(() => ImpayeService))
    private readonly impayeService: ImpayeService,
  ) {}

  private async etapeProfil(tid: string): Promise<Etape> {
    const fiche = await this.marqueService.fiche(tid); // lève en cas d'erreur de lecture (voulu)
    const manquants = CHAMPS_MINIMUM.filter((c) => !rempli(fiche[c]));
    return { id: 'profil', fait: manquants.length === 0, manquants };
  }

  private async etapeReseau(tid: string): Promise<Etape> {
    const comptes = await this.socialService.comptes(tid);
    return { id: 'reseau', fait: Object.keys(comptes).length > 0 };
  }

  private async etapeCarte(tid: string): Promise<Etape> {
    const fait = (await this.quotaService.statutAbonnement(tid)) !== null;
    const out: Etape = { id: 'carte', fait };
    if (!fait) {
      // Un ex-abonné (résilié, impayé) n'a plus droit à l'essai : la visite doit ouvrir le
      // mur « retour » (reprendre l'abonnement), pas « 14 jours gratuits ».
      try {
        out.ancien_abonne = await this.billingService.aDejaEuUnAbonnement(tid);
      } catch {
        out.ancien_abonne = false;
      }
    }
    return out;
  }

  private async compter(table: 'brouillons' | 'contenu', tid: string, statuts?: readonly string[]): Promise<number> {
    if (table === 'brouillons') {
      return this.prisma.brouillons.count({ where: { telegram_id: tid } });
    }
    return this.prisma.contenu.count({ where: { telegram_id: tid, ...(statuts ? { statut: { in: [...statuts] as never } } : {}) } });
  }

  private async etapeSujets(tid: string): Promise<Etape> {
    const n = await this.compter('brouillons', tid);
    return { id: 'sujets', fait: n > 0, n };
  }

  private async etapePost(tid: string): Promise<Etape> {
    const n = await this.compter('contenu', tid);
    return { id: 'post', fait: n > 0, n };
  }

  private async etapeValidation(tid: string): Promise<Etape> {
    const n = await this.compter('contenu', tid, STATUTS_INDEXES);
    const e: Etape = { id: 'validation', fait: n > 0, n };
    if (n) {
      try {
        const row = await this.prisma.contenu.findFirst({
          where: { telegram_id: tid, statut: { in: [...STATUTS_INDEXES] as never }, date_publication: { not: null } },
          orderBy: { date_publication: 'asc' },
          select: { date_publication: true },
        });
        if (row) e.date_premiere_publication = row.date_publication;
      } catch {
        // best-effort, comme le Python
      }
    }
    return e;
  }

  /** L'état des six étapes + l'étape courante. Mis en cache TTL_MS ms : le front l'appelle
   * souvent (changement de page, focus, poll). */
  async etat(telegramId: string, force = false): Promise<EtatDemarrage> {
    const now = Date.now();
    if (!force) {
      const c = this.cache.get(telegramId);
      if (c && now - c.at < TTL_MS) return c.etat;
    }
    const fns: Record<(typeof ORDRE)[number], (tid: string) => Promise<Etape>> = {
      profil: (tid) => this.etapeProfil(tid),
      reseau: (tid) => this.etapeReseau(tid),
      carte: (tid) => this.etapeCarte(tid),
      sujets: (tid) => this.etapeSujets(tid),
      post: (tid) => this.etapePost(tid),
      validation: (tid) => this.etapeValidation(tid),
    };
    const etapes: Etape[] = [];
    for (const nom of ORDRE) {
      try {
        etapes.push(await fns[nom](telegramId));
      } catch (e) {
        this.logger.warn(`démarrage ${nom} ${telegramId}: ${e instanceof Error ? e.message : e}`);
        etapes.push({ id: nom, fait: null });
      }
    }
    const courante = etapes.find((e) => e.fait === false)?.id ?? null;
    const out: EtatDemarrage = {
      etapes,
      courante,
      bloquant: courante !== null && BLOQUANTES.has(courante),
      termine: etapes.every((e) => e.fait === true),
    };
    this.cache.set(telegramId, { at: now, etat: out });
    return out;
  }

  /** À appeler quand une étape peut avoir changé (profil enregistré, réseau connecté,
   * abonnement) : le prochain `etat` relit la base. */
  oublier(telegramId: string): void {
    this.cache.delete(telegramId);
  }

  async exigerProfil(telegramId: string): Promise<void> {
    // Après une suspension pour impayé régularisée : au moins un réseau reconnecté avant
    // de générer (lève 400 reconnexion_requise, même forme d'objet que le mur de paiement).
    await this.impayeService.exigerReconnexion(telegramId);
    let manquants: string[];
    try {
      const marque = await this.prisma.marques.findUnique({ where: { telegram_id: telegramId } });
      manquants = CHAMPS_MINIMUM.filter((c) => !rempli(marque?.[c]));
    } catch (e) {
      // Une erreur de lecture laisse passer (même filet que le Python) : le filet
      // "profil_incomplet" d'agent_service reste derrière.
      this.logger.warn(`exigerProfil ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (manquants.length > 0) {
      throw new BadRequestException({
        raison: 'profil_incomplet',
        message: 'Complète ton profil de marque (secteur, voix, audience, piliers) avant de générer.',
        manquants,
      });
    }
  }
}
