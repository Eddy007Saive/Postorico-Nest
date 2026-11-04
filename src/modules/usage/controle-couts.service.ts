import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { MailService } from '../mail/mail.service';

/** Écart au-delà duquel l'admin est prévenu, et facture minimale pour en juger. */
const SEUIL_ECART_PCT = 10;
const FACTURE_MIN_USD = 0.5;
const HEURE_MS = 3600 * 1000;

const jourUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Contrôle quotidien du suivi des coûts IA : ce que chaque fournisseur a facturé la veille
 * contre ce que appels_ia a enregistré. Un écart signale un appel qui échappe au suivi ou un
 * tarif faux. Une ligne par jour et par fournisseur (la clé primaire empêche deux instances
 * de faire le même contrôle). */
@Injectable()
export class ControleCoutsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ControleCoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('app.controleCoutsActif')) return;
    setTimeout(() => void this.controler(), 5 * 60 * 1000);
    setInterval(() => void this.controler(), HEURE_MS);
  }

  async controler(): Promise<void> {
    // Laisser le temps aux fournisseurs de clore la journée (07:00 UTC)
    if (new Date().getUTCHours() < 7) return;
    await this.anthropic().catch((e) => this.logger.warn(`contrôle Anthropic : ${e instanceof Error ? e.message : e}`));
    await this.openrouter().catch((e) => this.logger.warn(`contrôle OpenRouter : ${e instanceof Error ? e.message : e}`));
  }

  /** Veille complète (UTC) : facture du rapport de coûts Anthropic, en centimes. */
  private async anthropic(): Promise<void> {
    const cle = this.config.get<string>('app.anthropicAdminKey');
    if (!cle) return;
    const fin = jourUtc(new Date());
    const debut = new Date(fin.getTime() - 24 * HEURE_MS);
    if (await this.dejaFait(debut, 'anthropic')) return;

    const params = new URLSearchParams({ starting_at: debut.toISOString(), ending_at: fin.toISOString(), bucket_width: '1d', limit: '1' });
    const r = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
      headers: { 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { data?: Array<{ results?: Array<{ amount?: string | number }> }> };
    let centimes = 0;
    for (const b of data.data || []) for (const x of b.results || []) centimes += Number(x.amount) || 0;
    const facture = centimes / 100;
    const suivi = await this.totalSuivi('anthropic', debut, fin);
    await this.enregistrer(debut, 'anthropic', facture, suivi, { centimes });
  }

  /** OpenRouter ne donne qu'un cumul par clé : la facture du jour est la différence entre
   * deux relevés, comparée au suivi sur la même fenêtre. */
  private async openrouter(): Promise<void> {
    const cle = this.config.get<string>('app.openrouterApiKey');
    if (!cle) return;
    const maintenant = new Date();
    const jour = new Date(jourUtc(maintenant).getTime() - 24 * HEURE_MS);
    if (await this.dejaFait(jour, 'openrouter')) return;

    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${cle}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(((await r.json()) as { data?: { usage?: number } }).data?.usage);
    if (!Number.isFinite(total)) throw new Error('cumul absent');

    const precedent = await this.prisma.controle_couts_ia.findFirst({
      where: { fournisseur: 'openrouter', jour: { lt: jour } },
      orderBy: { jour: 'desc' },
    });
    const avant = precedent?.releve as { cumul_usd?: number; pris_le?: string } | null;
    const releve = { cumul_usd: total, pris_le: maintenant.toISOString() };
    if (!avant?.cumul_usd || !avant.pris_le) {
      // Premier relevé : sert de point de départ au contrôle de demain
      await this.enregistrer(jour, 'openrouter', null, null, releve);
      return;
    }
    const facture = total - avant.cumul_usd;
    const suivi = await this.totalSuivi('openrouter', new Date(avant.pris_le), maintenant);
    await this.enregistrer(jour, 'openrouter', facture, suivi, releve);
  }

  private async dejaFait(jour: Date, fournisseur: string): Promise<boolean> {
    return Boolean(await this.prisma.controle_couts_ia.findUnique({ where: { jour_fournisseur: { jour, fournisseur } } }));
  }

  /** Total suivi sur la fenêtre, ou null si le suivi n'existait pas encore à son début
   * (premiers jours après la mise en service : pas de fausse alerte à -100 %). */
  private async totalSuivi(fournisseur: string, debut: Date, fin: Date): Promise<number | null> {
    const premier = await this.prisma.appels_ia.findFirst({ where: { fournisseur }, orderBy: { created_at: 'asc' }, select: { created_at: true } });
    if (!premier || premier.created_at > debut) return null;
    const r = await this.prisma.appels_ia.aggregate({
      where: { fournisseur, created_at: { gte: debut, lt: fin } },
      _sum: { cout_usd: true },
    });
    return Number(r._sum.cout_usd ?? 0);
  }

  private async enregistrer(jour: Date, fournisseur: string, facture: number | null, suivi: number | null, releve: Record<string, unknown>): Promise<void> {
    const ecart = facture !== null && suivi !== null && facture > 0 ? ((suivi - facture) / facture) * 100 : null;
    try {
      await this.prisma.controle_couts_ia.create({
        data: {
          jour,
          fournisseur,
          facture_usd: facture,
          suivi_usd: suivi,
          ecart_pct: ecart === null ? null : Math.round(ecart * 100) / 100,
          releve: releve as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      // Une autre instance a fait ce contrôle entre-temps
      if ((e as { code?: string }).code === 'P2002') return;
      throw e;
    }
    const jourTxt = jour.toISOString().slice(0, 10);
    this.logger.log(`contrôle ${fournisseur} ${jourTxt} : facturé ${facture?.toFixed(4) ?? '—'} $, suivi ${suivi?.toFixed(4) ?? '—'} $`);
    if (ecart !== null && facture !== null && facture >= FACTURE_MIN_USD && Math.abs(ecart) > SEUIL_ECART_PCT) {
      await this.alerter(fournisseur, jourTxt, facture, suivi ?? 0, ecart);
    }
  }

  private async alerter(fournisseur: string, jour: string, facture: number, suivi: number, ecart: number): Promise<void> {
    const dest = this.config.get<string>('app.adminNotifEmail');
    if (!dest) return;
    const nom = fournisseur === 'anthropic' ? 'Anthropic' : 'OpenRouter';
    const sens = ecart < 0 ? 'des appels facturés ne sont pas suivis (un appel échappe au suivi, ou un autre outil utilise la même clé)' : 'le suivi compte plus que la facture (tarif à vérifier)';
    const html =
      `<p><strong>Coûts IA ${nom}, ${jour} : écart de ${ecart.toFixed(1)} %.</strong></p>` +
      `<p>Facturé par ${nom} : ${facture.toFixed(2)} $. Suivi par Postorico : ${suivi.toFixed(2)} $.</p>` +
      `<p>Ce sens d'écart veut dire que ${sens}.</p>` +
      `<p style="color:#64748b;font-size:13px">Détail par client et par action : Administration › Coûts IA.</p>`;
    await this.mail.sendEmail(dest, `⚠️ Postorico : coûts IA ${nom} en écart de ${Math.round(ecart)} %`, html);
  }
}
