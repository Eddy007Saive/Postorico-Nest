import { Injectable, Logger } from '@nestjs/common';
import type { offers as Offer } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

/**
 * Port complet de backend/services/offers_service.py — ce que le client vend
 * (produit / service / offre), pour ancrer la génération de contenu sur des faits
 * RÉELS (prix, bénéfices, caractéristiques) que Claude ne doit jamais inventer.
 */

const TYPES = new Set(['product', 'service', 'offer']);
const CHAMPS = ['name', 'type', 'description', 'price', 'benefits', 'url', 'facts', 'actif'] as const;
type ChampOffre = (typeof CHAMPS)[number];

@Injectable()
export class OffersService {
  private readonly logger = new Logger(OffersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Ne garde que les champs connus ; normalise le type. */
  private clean(body: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const k of CHAMPS as readonly ChampOffre[]) {
      if (k in body) row[k] = body[k];
    }
    if ('type' in row && !TYPES.has(String(row.type))) row.type = 'service';
    if ('name' in row) row.name = String(row.name || '').trim().slice(0, 200);
    return row;
  }

  async lister(telegramId: string, activesSeulement = false): Promise<Offer[]> {
    return this.prisma.offers.findMany({
      where: { telegram_id: telegramId, ...(activesSeulement ? { actif: true } : {}) },
      orderBy: { created_at: 'asc' },
    });
  }

  async creer(telegramId: string, body: Record<string, unknown>): Promise<Offer> {
    const row = this.clean(body);
    if (!row.name) throw new Error('name requis');
    row.telegram_id = telegramId;
    if (!row.type) row.type = 'service';
    return this.prisma.offers.create({ data: row as never });
  }

  async modifier(telegramId: string, offerId: string, body: Record<string, unknown>): Promise<Offer | Record<string, never>> {
    const row = this.clean(body);
    if (!Object.keys(row).length) return {};
    const res = await this.prisma.offers.updateMany({ where: { id: offerId, telegram_id: telegramId }, data: row as never });
    if (!res.count) return {};
    return (await this.prisma.offers.findUnique({ where: { id: offerId } })) as Offer;
  }

  async supprimer(telegramId: string, offerId: string): Promise<void> {
    await this.prisma.offers.deleteMany({ where: { id: offerId, telegram_id: telegramId } });
  }

  private async listerActives(telegramId: string, limite?: number): Promise<Offer[]> {
    try {
      const rows = await this.prisma.offers.findMany({
        where: { telegram_id: telegramId, actif: true },
        orderBy: { created_at: 'asc' },
        ...(limite ? { take: limite } : {}),
      });
      return rows;
    } catch {
      return [];
    }
  }

  /** Noms des offres actives (pour valider une dimension « offre »). */
  async noms(telegramId: string): Promise<string[]> {
    const offres = await this.listerActives(telegramId);
    return offres.map((o) => o.name).filter((n): n is string => Boolean(n));
  }

  /** Liste COURTE (nom + type) des offres actives, pour la génération de sujets. */
  async nomsOffres(telegramId: string, limite = 20): Promise<string> {
    const offres = await this.listerActives(telegramId, limite);
    if (!offres.length) return '';
    return offres.map((o) => `- ${o.name} (${o.type || 'offre'})`).join('\n');
  }

  /** Formate UNE offre en bloc de faits (nom, prix, desc, bénéfices, url). */
  private fmtOffre(o: Offer): string {
    const parts = [`- ${o.name}`];
    if (o.type) parts.push(`(${o.type})`);
    if (o.price) parts.push(`— prix : ${o.price}`);
    const tete = parts.join(' ');
    const details: string[] = [];
    if (o.description) details.push(`  desc : ${o.description}`);
    if (o.benefits) {
      const b = String(o.benefits)
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .join(' / ');
      if (b) details.push(`  bénéfices : ${b}`);
    }
    if (o.facts && typeof o.facts === 'object' && !Array.isArray(o.facts)) {
      const f = Object.entries(o.facts as Record<string, unknown>)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      if (f) details.push(`  faits : ${f}`);
    }
    if (o.url) details.push(`  url : ${o.url}`);
    return details.length ? `${tete}\n${details.join('\n')}` : tete;
  }

  /** Bloc de faits d'UNE offre nommée (envoi ciblé, pas toutes les offres). */
  async faitsOffre(telegramId: string, nom: string): Promise<string> {
    const cherche = (nom ?? '').trim();
    if (!cherche) return '';
    const offres = await this.listerActives(telegramId);
    const o = offres.find((x) => (x.name ?? '').trim() === cherche);
    if (!o) return '';
    return (
      '\n\n## OFFRE CONCERNÉE PAR CE CONTENU (source de vérité)\n' +
      "Mets cette offre en avant. N'invente JAMAIS un prix ou une caractéristique " +
      "qui n'est pas listé ici.\n" +
      this.fmtOffre(o)
    );
  }

  /** Bloc « OFFRES » injecté dans le contexte de marque : la liste des offres actives +
   * leurs faits fiables. Vide si le client n'a renseigné aucune offre. */
  async contexteOffres(telegramId: string, limite = 12): Promise<string> {
    let offres: Offer[];
    try {
      offres = await this.listerActives(telegramId, limite);
    } catch (e) {
      this.logger.warn(`contexteOffres ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return '';
    }
    if (!offres.length) return '';
    const lignes = offres.map((o) => this.fmtOffre(o));
    return (
      '\n\n## OFFRES / PRODUITS DU CLIENT (source de vérité)\n' +
      'Voici ce que le client vend. Sers-t\'en pour ancrer le contenu. ' +
      "N'invente JAMAIS un prix, une caractéristique ou un chiffre qui n'est pas listé ici ; " +
      'si une info manque, reste qualitatif ou laisse un placeholder.\n' +
      lignes.join('\n')
    );
  }
}
