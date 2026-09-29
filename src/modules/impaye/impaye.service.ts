import { BadRequestException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../config/prisma.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { QuotaService } from '../quota/quota.service';
import { SocialService } from '../social/social.service';
import { ZernioClientService } from '../zernio/zernio-client.service';

/**
 * Gestion des impayés : on coupe les coûts variables dans l'ordre inverse de leur
 * réversibilité, sans perdre le client — port direct de backend/services/impaye_service.py.
 *
 *   actif (active/trialing) ──(invoice.payment_failed)──> grâce (past_due)
 *   grâce ──(invoice.paid)────────────────────────────────> actif
 *   grâce ──(J+10, cron)──────────────────────────────────> suspendu (suspended)
 *   suspendu ──(invoice.paid)─────────────────────────────> actif + reconnexion guidée
 *   suspendu ──(J+30, cron)───────────────────────────────> résilié (canceled)
 *
 * - Cran 1, immédiat : la génération IA est bloquée (QuotaService.consume refuse « impaye »).
 * - Cran 2, J+10 : sauvegarde des réseaux, annulation des publications programmées,
 *   déconnexion Zernio.
 * - Cran 3, J+30 : résiliation de l'abonnement Stripe.
 *
 * L'état vit dans `subscriptions.status` ; les crans sont pilotés par NOTRE colonne
 * `impaye_depuis`, jamais par le statut Stripe. Règle absolue : on ne revient à « actif »
 * que sur un encaissement (invoice.paid), jamais sur une date ou un cron.
 *
 * Exception : le plan « Boss » (comptes internes) est hors de tout ce mécanisme.
 */

const STATUTS_VIVANTS = ['trialing', 'active', 'past_due', 'suspended'];
const J_AVERTISSEMENT = 9; // mail 2 : la veille de la coupure
const J_SUSPENSION = 10; // cran 2
const J_DERNIER_AVIS = 29; // mail 4
const J_RESILIATION = 30; // cran 3

const RAISON_SUSPENSION =
  "Paiement en attente : tes réseaux ont été déconnectés, la publication a été annulée. Régularise ton paiement, reconnecte tes réseaux puis clique « Réessayer » pour la reprogrammer.";

interface SubRow {
  id: string;
  user_id: string;
  status: string;
  impaye_depuis: Date | null;
  suspendu_le: Date | null;
  impaye_mail2_le: Date | null;
  impaye_mail4_le: Date | null;
  stripe_subscription_id: string | null;
}

@Injectable()
export class ImpayeService {
  private readonly logger = new Logger(ImpayeService.name);
  private readonly stripe: Stripe | null;
  private readonly lateApiKey: string;
  private readonly frontendUrl: string;
  private readonly adminNotifEmail: string;
  readonly lienAbonnement: string;
  private readonly lienReseaux: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotaService: QuotaService,
    private readonly socialService: SocialService,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => DemarrageService))
    private readonly demarrageService: DemarrageService,
    private readonly notificationService: NotificationService,
    private readonly zernio: ZernioClientService,
    config: ConfigService,
  ) {
    const secretKey = config.get<string>('app.stripeSecretKey') || '';
    this.stripe = secretKey ? new Stripe(secretKey) : null;
    this.lateApiKey = config.get<string>('app.lateApiKey') || '';
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
    this.adminNotifEmail = config.get<string>('app.adminNotifEmail') || '';
    this.lienAbonnement = `${this.frontendUrl}/dashboard/parametres?s=abonnement`;
    this.lienReseaux = `${this.frontendUrl}/dashboard/parametres?s=connections`;
  }

  private now(): Date {
    return new Date();
  }

  private async sub(telegramId: string): Promise<SubRow | null> {
    const row = await this.prisma.subscriptions.findFirst({
      where: { user_id: telegramId, status: { in: STATUTS_VIVANTS } },
      orderBy: { created_at: 'desc' },
    });
    return row as SubRow | null;
  }

  private async client(telegramId: string): Promise<{ nom?: string | null; email?: string | null }> {
    try {
      const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { nom: true, email: true } });
      return u ?? {};
    } catch {
      return {};
    }
  }

  private async oublierDemarrage(telegramId: string): Promise<void> {
    try {
      await this.demarrageService.oublier(telegramId);
    } catch {
      // silencieux, comme côté Python
    }
  }

  /** actif / grace / suspendu / resilie / aucun, dérivé de subscriptions.status. */
  async etatFacturation(telegramId: string): Promise<'actif' | 'grace' | 'suspendu' | 'resilie' | 'aucun'> {
    const s = await this.sub(telegramId);
    if (s && (await this.quotaService.estBoss(telegramId))) return 'actif';
    if (!s) {
      // Plus d'abonnement vivant : résilié (il en a eu un) ou jamais abonné.
      const any = await this.prisma.subscriptions.findFirst({ where: { user_id: telegramId }, select: { id: true } });
      return any ? 'resilie' : 'aucun';
    }
    const map: Record<string, 'actif' | 'grace' | 'suspendu'> = { active: 'actif', trialing: 'actif', past_due: 'grace', suspended: 'suspendu' };
    return map[s.status] || 'resilie';
  }

  // ------------------------------------------------------------------ cran 1

  /** invoice.payment_failed : premier échec -> impaye_depuis = maintenant ; les échecs
   * suivants (relances Stripe) ne le réinitialisent pas. Un compte déjà suspendu le reste. */
  async marquerEchec(telegramId: string): Promise<{ premier_echec: boolean; statut: string | null; boss?: boolean }> {
    const s = await this.sub(telegramId);
    if (!s) return { premier_echec: false, statut: null };
    if (await this.quotaService.estBoss(telegramId)) {
      this.logger.log(`impayé: ${telegramId} est Boss, échec Stripe ignoré`);
      return { premier_echec: false, statut: s.status, boss: true };
    }
    const premier = !s.impaye_depuis;
    const row: Record<string, unknown> = {};
    if (['active', 'trialing'].includes(s.status)) row.status = 'past_due';
    if (premier) row.impaye_depuis = this.now();
    if (Object.keys(row).length) {
      await this.prisma.subscriptions.update({ where: { id: s.id }, data: row });
      await this.oublierDemarrage(telegramId);
    }
    this.logger.log(`impayé: ${telegramId} -> grâce (premier échec: ${premier})`);
    return { premier_echec: premier, statut: (row.status as string) || s.status };
  }

  /** invoice.paid : le SEUL chemin vers « actif ». Efface l'épisode d'impayé. Si le
   * compte était suspendu, ses réseaux sauvegardés attendent la reconnexion guidée. */
  async regulariser(telegramId: string): Promise<{ changement: boolean; etait_suspendu?: boolean; reconnexion?: string[] }> {
    const s = await this.sub(telegramId);
    if (!s || (['active', 'trialing'].includes(s.status) && !s.impaye_depuis)) return { changement: false };
    const etaitSuspendu = s.status === 'suspended';
    const row: Record<string, unknown> = { impaye_depuis: null, suspendu_le: null, impaye_mail2_le: null, impaye_mail4_le: null };
    if (['past_due', 'suspended'].includes(s.status)) row.status = 'active';
    await this.prisma.subscriptions.update({ where: { id: s.id }, data: row });
    await this.oublierDemarrage(telegramId);
    this.logger.log(`impayé: ${telegramId} régularisé (était suspendu: ${etaitSuspendu})`);
    const attente = await this.sauvegardesEnAttente(telegramId);
    return { changement: true, etait_suspendu: etaitSuspendu, reconnexion: attente.map((r) => r.plateforme) };
  }

  // ------------------------------------------------------------------ cran 2

  async sauvegardesEnAttente(telegramId: string): Promise<Array<{ id: string; plateforme: string; late_account_id: string | null; nom_affiche: string | null; deconnecte_le: Date }>> {
    try {
      return await this.prisma.reseaux_sauvegardes.findMany({
        where: { telegram_id: telegramId, retabli_le: null },
        select: { id: true, plateforme: true, late_account_id: true, nom_affiche: true, deconnecte_le: true },
        orderBy: { deconnecte_le: 'asc' },
      });
    } catch (e) {
      this.logger.warn(`sauvegardes_en_attente ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Cran 2. Ordre imposé : sauvegarder, annuler les publications, revérifier l'état (un
   * paiement peut arriver pendant le cron), déconnecter, puis seulement marquer suspendu.
   * Un réseau qui refuse de se déconnecter laisse le compte en grâce (on réessaie au
   * prochain cron) et remonte une alerte. */
  async suspendre(telegramId: string): Promise<{ ok: boolean; raison?: string; statut?: string | null; reseaux?: string[]; echecs?: string[] }> {
    const s = await this.sub(telegramId);
    if (!s || s.status !== 'past_due') return { ok: false, raison: 'etat', statut: s?.status ?? null };

    const comptes = await this.socialService.comptes(telegramId); // {plateforme: late_account_id}
    const deja = new Set((await this.sauvegardesEnAttente(telegramId)).map((r) => r.plateforme));
    for (const [plateforme, accountId] of Object.entries(comptes)) {
      if (deja.has(plateforme)) continue;
      // Écrit et committé AVANT toute déconnexion : si le process plante après, on sait
      // encore ce que le client avait.
      await this.prisma.reseaux_sauvegardes.create({ data: { telegram_id: telegramId, plateforme, late_account_id: accountId } });
    }

    try {
      await this.socialService.annulerProgrammations(telegramId, RAISON_SUSPENSION, 'Paiement en attente');
    } catch (e) {
      this.logger.error(`suspendre ${telegramId}: annulation des programmations: ${e instanceof Error ? e.message : e}`);
    }

    // Paiement arrivé entre-temps ? On ne déconnecte pas, et on efface les sauvegardes
    // posées à l'instant (les réseaux sont toujours là).
    const s2 = await this.sub(telegramId);
    if (!s2 || s2.status !== 'past_due') {
      try {
        await this.prisma.reseaux_sauvegardes.deleteMany({ where: { telegram_id: telegramId, retabli_le: null } });
      } catch {
        // silencieux, comme côté Python
      }
      return { ok: false, raison: 'regularise_entre_temps' };
    }

    const echecs: string[] = [];
    for (const [plateforme, accountId] of Object.entries(comptes)) {
      if (accountId && this.lateApiKey) {
        try {
          await this.zernio.deleteAccount(accountId);
        } catch (e) {
          this.logger.warn(`suspendre ${telegramId}/${plateforme} (${accountId}) : Late a refusé : ${e instanceof Error ? e.message : e}`);
          echecs.push(plateforme);
          continue;
        }
      }
      await this.socialService.supprimerCompte(telegramId, plateforme);
    }

    if (echecs.length) {
      await this.alerteAdmin(
        'Suspension incomplète',
        telegramId,
        `Réseau(x) non déconnecté(s) côté Zernio : ${echecs.join(', ')}. Le compte reste en grâce, nouvel essai au prochain cron.`,
      );
      return { ok: false, raison: 'late', echecs };
    }

    await this.prisma.subscriptions.update({ where: { id: s.id }, data: { status: 'suspended', suspendu_le: this.now() } });
    await this.oublierDemarrage(telegramId);

    const c = await this.client(telegramId);
    const reseaux = Object.keys(comptes).sort();
    try {
      await this.notificationService.notifier(
        telegramId,
        null,
        null,
        'billing.suspended',
        'Réseaux déconnectés',
        "Ton paiement n'a pas été régularisé : tes réseaux ont été déconnectés. Mets à jour ta carte, puis reconnecte-les en trois clics.",
        'facturation',
      );
    } catch (e) {
      this.logger.warn(`suspendre notification ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    if (c.email) {
      try {
        const { subject, html } = this.mailService.impayeSuspensionHtml(c.nom ?? null, this.lienAbonnement, reseaux);
        await this.mailService.sendEmail(c.email, subject, html);
      } catch (e) {
        this.logger.error(`suspendre mail 3 ${telegramId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`impayé: ${telegramId} suspendu (${reseaux.length} réseau(x) déconnecté(s))`);
    return { ok: true, reseaux };
  }

  // ------------------------------------------------------------------ cran 3

  /** Cran 3 : résiliation immédiate côté Stripe. Le webhook customer.subscription.deleted
   * fera le reste (statut canceled, email admin). */
  async resilier(telegramId: string): Promise<{ ok: boolean; raison?: string; erreur?: string }> {
    const s = await this.sub(telegramId);
    if (!s || s.status !== 'suspended') return { ok: false, raison: 'etat' };
    if (s.stripe_subscription_id && this.stripe) {
      try {
        await this.stripe.subscriptions.cancel(s.stripe_subscription_id);
      } catch (e) {
        this.logger.error(`resilier ${telegramId}: Stripe a refusé : ${e instanceof Error ? e.message : e}`);
        return { ok: false, raison: 'stripe', erreur: e instanceof Error ? e.message : String(e) };
      }
    }
    await this.prisma.subscriptions.update({ where: { id: s.id }, data: { status: 'canceled' } });
    await this.oublierDemarrage(telegramId);
    this.logger.log(`impayé: ${telegramId} résilié (J+${J_RESILIATION})`);
    return { ok: true };
  }

  // ------------------------------------------------------------------ cron

  /** Une fois par jour : lit impaye_depuis et applique les crans. */
  async traiterQuotidien(): Promise<{ comptes: number; mail2: number; suspendus: number; mail4: number; resilies: number; echecs: number } | { erreur: string }> {
    let rows: SubRow[];
    try {
      rows = (await this.prisma.subscriptions.findMany({
        where: { impaye_depuis: { not: null }, status: { in: ['past_due', 'suspended'] } },
        select: { id: true, user_id: true, status: true, impaye_depuis: true, impaye_mail2_le: true, impaye_mail4_le: true, suspendu_le: true, stripe_subscription_id: true },
      })) as SubRow[];
    } catch (e) {
      this.logger.error(`impayés cron: lecture impossible: ${e instanceof Error ? e.message : e}`);
      return { erreur: e instanceof Error ? e.message : String(e) };
    }
    const bilan = { comptes: 0, mail2: 0, suspendus: 0, mail4: 0, resilies: 0, echecs: 0 };
    const now = this.now();
    for (const s of rows) {
      const uid = s.user_id;
      if (await this.quotaService.estBoss(uid)) continue;
      bilan.comptes += 1;
      try {
        const depuis = s.impaye_depuis!;
        const jours = Math.floor((now.getTime() - depuis.getTime()) / (24 * 60 * 60 * 1000));
        const c = await this.client(uid);
        if (s.status === 'past_due') {
          if (jours >= J_AVERTISSEMENT && !s.impaye_mail2_le) {
            if (c.email) {
              const { subject, html } = this.mailService.impayeAvertissementHtml(c.nom ?? null, this.lienAbonnement);
              await this.mailService.sendEmail(c.email, subject, html);
            }
            await this.prisma.subscriptions.update({ where: { id: s.id }, data: { impaye_mail2_le: now } });
            bilan.mail2 += 1;
          }
          if (jours >= J_SUSPENSION) {
            const res = await this.suspendre(uid);
            if (res.ok) bilan.suspendus += 1;
            else bilan.echecs += 1;
          }
        } else if (s.status === 'suspended') {
          if (jours >= J_DERNIER_AVIS && !s.impaye_mail4_le) {
            if (c.email) {
              const { subject, html } = this.mailService.impayeDernierAvisHtml(c.nom ?? null, this.lienAbonnement);
              await this.mailService.sendEmail(c.email, subject, html);
            }
            await this.prisma.subscriptions.update({ where: { id: s.id }, data: { impaye_mail4_le: now } });
            bilan.mail4 += 1;
          }
          if (jours >= J_RESILIATION) {
            const res = await this.resilier(uid);
            if (res.ok) bilan.resilies += 1;
            else bilan.echecs += 1;
          }
        }
      } catch (e) {
        bilan.echecs += 1;
        this.logger.error(`impayés cron ${uid}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`impayés cron: ${JSON.stringify(bilan)}`);
    return bilan;
  }

  // ------------------------------------------------------------------ reprise

  /** Pour l'écran de reconnexion guidée : ce que le client avait, pas encore reconnecté.
   * `a_afficher` seulement une fois le paiement régularisé. */
  async reconnexion(telegramId: string): Promise<{ etat: string; reseaux: Awaited<ReturnType<ImpayeService['sauvegardesEnAttente']>>; a_afficher: boolean }> {
    const etat = await this.etatFacturation(telegramId);
    const enAttente = await this.sauvegardesEnAttente(telegramId);
    return { etat, reseaux: enAttente, a_afficher: etat === 'actif' && enAttente.length > 0 };
  }

  /** Le réseau vient d'être reconnecté (ou ignoré par le client). */
  async marquerRetabli(telegramId: string, plateforme: string, abandonne = false): Promise<void> {
    try {
      await this.prisma.reseaux_sauvegardes.updateMany({
        where: { telegram_id: telegramId, plateforme, retabli_le: null },
        data: { retabli_le: this.now(), abandonne },
      });
    } catch (e) {
      this.logger.warn(`marquer_retabli ${telegramId}/${plateforme}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Garde des routes de génération : après une suspension régularisée, pas de génération
   * tant qu'aucun réseau n'est reconnecté (sinon on produit des contenus que rien ne peut
   * publier). */
  async exigerReconnexion(telegramId: string): Promise<void> {
    try {
      if ((await this.etatFacturation(telegramId)) !== 'actif') return;
      const enAttente = await this.sauvegardesEnAttente(telegramId);
      if (!enAttente.length) return;
      if (Object.keys(await this.socialService.comptes(telegramId)).length) return;
      throw new BadRequestException({
        raison: 'reconnexion_requise',
        message: 'Reconnecte au moins un réseau avant de générer : rien ne pourrait être publié sinon.',
        reseaux: enAttente.map((r) => r.plateforme),
      });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`exiger_reconnexion ${telegramId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async alerteAdmin(titre: string, telegramId: string, detail: string): Promise<void> {
    const c = await this.client(telegramId);
    try {
      const { subject, html } = this.mailService.adminPaymentHtml('payment_failed', c.nom ?? null, c.email ?? null, `${titre} : ${detail}`);
      await this.mailService.sendEmail(this.adminNotifEmail, `🚨 ${titre} : ${c.nom || telegramId}`, html);
    } catch (e) {
      this.logger.error(`alerte admin impayés: ${e instanceof Error ? e.message : e}`);
    }
  }
}
