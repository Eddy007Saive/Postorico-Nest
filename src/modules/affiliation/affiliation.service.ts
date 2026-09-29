import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { Fernet } from '../../common/utils/fernet.util';

/**
 * Programme d'affiliation — port direct de backend/services/affiliation_service.py.
 *
 * Deux commissions, toutes deux déclenchées par un paiement Stripe réel :
 *   - « setup »     : 25 % une seule fois, sur le Pack Fondations ;
 *   - « recurrent » : 10 % sur chaque facture d'abonnement, tant que le client reste.
 *
 * On ne stocke que des TAUX. Le montant se calcule sur ce que Stripe a encaissé et
 * hérite de la devise de la facture.
 */

const FENETRE_JOURS = 30; // délai pendant lequel un clic reste attribuable
export const TAUX_SETUP_DEFAUT = 25.0;
export const TAUX_RECURRENT_DEFAUT = 10.0;

export interface Affiliate {
  id: string;
  telegram_id: string | null;
  code: string;
  nom: string;
  email: string;
  statut: string;
  taux_setup: unknown;
  taux_recurrent: unknown;
  iban_chiffre: string | null;
  audience: string | null;
  motif: string | null;
  created_at: Date;
  approuve_le: Date | null;
  approuve_par: string | null;
}

@Injectable()
export class AffiliationService {
  private readonly logger = new Logger(AffiliationService.name);
  private readonly fernet: Fernet;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.fernet = new Fernet(config.get<string>('app.jwtSecret') || 'postorico');
  }

  // --- IBAN chiffré ------------------------------------------------------------
  // Clé dérivée de JWT_SECRET : pas de variable d'environnement supplémentaire à
  // déployer. Rotation de JWT_SECRET = IBAN illisibles, à resaisir.

  chiffrerIban(iban: string | null | undefined): string | null {
    const clean = (iban || '').replace(/\s+/g, '').toUpperCase();
    if (!clean) return null;
    return 'enc:v1:' + this.fernet.encrypt(clean);
  }

  dechiffrerIban(valeur: string | null | undefined): string | null {
    if (!valeur || !valeur.startsWith('enc:v1:')) return null;
    return this.fernet.decrypt(valeur.slice(7));
  }

  /** Ce que voit l'affilié : FR76 **** **** 1234. */
  masquerIban(valeur: string | null | undefined): string | null {
    const clair = this.dechiffrerIban(valeur);
    if (!clair) return null;
    return clair.length > 8 ? `${clair.slice(0, 4)} **** **** ${clair.slice(-4)}` : '****';
  }

  // --- Code d'affiliation --------------------------------------------------------

  private async codeUnique(nom: string): Promise<string> {
    const base = (nom || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'PSTO';
    for (let i = 0; i < 12; i++) {
      const code = base + String(Math.floor(Math.random() * 9000) + 1000);
      const existe = await this.prisma.affiliates.findFirst({ where: { code }, select: { id: true } });
      if (!existe) return code;
    }
    return base + crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  // --- Demandes ------------------------------------------------------------------

  /** Dépose une demande d'affiliation. Elle attend la validation d'un admin.
   * telegramId absent = affilié externe (influenceur, blogueur). */
  async demander(nom: string | undefined, emailIn: string | undefined, iban?: string | null, telegramId?: string | null, audience?: string | null): Promise<Affiliate> {
    const email = (emailIn || '').trim().toLowerCase();
    if (!nom || !email) throw new Error('nom et email requis');

    const existant = telegramId
      ? await this.prisma.affiliates.findFirst({ where: { telegram_id: telegramId } })
      : await this.prisma.affiliates.findFirst({ where: { email } });
    if (existant) return existant as Affiliate;

    const row = {
      telegram_id: telegramId || null,
      code: await this.codeUnique(nom),
      nom: nom.trim(),
      email,
      statut: 'en_attente',
      taux_setup: TAUX_SETUP_DEFAUT,
      taux_recurrent: TAUX_RECURRENT_DEFAUT,
      iban_chiffre: this.chiffrerIban(iban),
      audience: audience || null,
    };
    return (await this.prisma.affiliates.create({ data: row })) as Affiliate;
  }

  async parTelegram(telegramId: string): Promise<Affiliate | null> {
    return (await this.prisma.affiliates.findFirst({ where: { telegram_id: telegramId } })) as Affiliate | null;
  }

  /** Silencieux en cas de panne : un lien d'affiliation cassé doit rediriger vers le
   * site, pas renvoyer une erreur au visiteur. */
  async parCode(code: string | null | undefined, actifSeulement = true): Promise<Affiliate | null> {
    if (!code) return null;
    try {
      return (await this.prisma.affiliates.findFirst({
        where: { code: code.trim().toUpperCase(), ...(actifSeulement ? { statut: 'actif' } : {}) },
      })) as Affiliate | null;
    } catch (e) {
      this.logger.warn(`lecture affilié ${code} impossible: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // --- Clics -----------------------------------------------------------------

  /** Trace le clic et renvoie l'affilié si le code est valide et actif. */
  async enregistrerClic(code: string, ip?: string | null, userAgent?: string | null, referer?: string | null): Promise<Affiliate | null> {
    const aff = await this.parCode(code);
    if (!aff) return null;
    try {
      await this.prisma.affiliate_clicks.create({
        data: { affiliate_id: aff.id, ip: ip || null, user_agent: (userAgent || '').slice(0, 400), referer: (referer || '').slice(0, 400) },
      });
    } catch (e) {
      this.logger.warn(`clic affiliation non enregistré: ${e instanceof Error ? e.message : e}`);
    }
    return aff;
  }

  // --- Attribution -------------------------------------------------------------

  /** Signal de fraude : la même IP a déjà parrainé plusieurs filleuls du même affilié. */
  private async ipPartagee(affiliateId: string, ip: string | null | undefined): Promise<boolean> {
    if (!ip) return false;
    const autres = await this.prisma.affiliate_referrals.findMany({ where: { affiliate_id: affiliateId, ip }, select: { id: true } });
    return autres.length >= 2;
  }

  /** Rattache un nouveau client à un affilié. Appelé à l'inscription. Renvoie null si le
   * code est inconnu/inactif, s'il s'agit d'un auto-parrainage, ou si le client a déjà un
   * parrain (la première attribution gagne). */
  async attribuer(code: string, telegramId?: string | null, emailIn?: string | null, ip?: string | null): Promise<unknown> {
    const aff = await this.parCode(code);
    if (!aff) return null;

    const email = (emailIn || '').trim().toLowerCase() || null;
    if (email && email === (aff.email || '').toLowerCase()) {
      this.logger.log(`affiliation: auto-parrainage refusé pour ${aff.code}`);
      return null;
    }
    if (telegramId && String(telegramId) === String(aff.telegram_id || '')) return null;

    if (telegramId) {
      const deja = await this.prisma.affiliate_referrals.findFirst({ where: { telegram_id: telegramId }, select: { id: true } });
      if (deja) return null;
    }

    const row = {
      affiliate_id: aff.id,
      telegram_id: telegramId || null,
      email,
      statut: 'active',
      ip: ip || null,
      expire_le: new Date(Date.now() + FENETRE_JOURS * 24 * 60 * 60 * 1000),
    };
    try {
      return await this.prisma.affiliate_referrals.create({ data: row });
    } catch (e) {
      this.logger.warn(`attribution affiliation échouée: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Retrouve l'attribution encore valable d'un client. On tente d'abord par compte, puis
   * par email : un Pack Fondations peut être payé avant même que le client ait créé son
   * compte. */
  private async parrainDe(telegramId?: string | null, email?: string | null): Promise<{ referral: { id: string; statut: string; expire_le: Date | null }; affiliate: Affiliate } | null> {
    let ligne: { id: string; statut: string; expire_le: Date | null; affiliate_id: string } | null = null;
    if (telegramId) {
      ligne = await this.prisma.affiliate_referrals.findFirst({ where: { telegram_id: telegramId } });
    }
    if (!ligne && email) {
      ligne = await this.prisma.affiliate_referrals.findFirst({ where: { email: email.trim().toLowerCase() } });
    }
    if (!ligne) return null;

    if (ligne.statut === 'expiree') return null;
    if (ligne.statut === 'active' && ligne.expire_le) {
      if (ligne.expire_le < new Date()) {
        await this.prisma.affiliate_referrals.update({ where: { id: ligne.id }, data: { statut: 'expiree' } });
        return null;
      }
    }

    const aff = await this.prisma.affiliates.findUnique({ where: { id: ligne.affiliate_id } });
    if (!aff || aff.statut !== 'actif') return null;
    return { referral: ligne, affiliate: aff as Affiliate };
  }

  /** Premier paiement : l'attribution ne peut plus expirer ni changer. */
  private async verrouiller(referral: { id: string; statut: string }): Promise<void> {
    if (referral.statut !== 'verrouillee') {
      await this.prisma.affiliate_referrals.update({ where: { id: referral.id }, data: { statut: 'verrouillee', verrouille_le: new Date() } });
    }
  }

  // --- Commissions ---------------------------------------------------------------

  /** Crée la commission d'une facture payée. Idempotent : rejouer le webhook ne duplique
   * rien (stripe_invoice_id est unique en base). `codeForce` sert au lien de paiement du
   * Pack Fondations, où l'admin dépose le code de l'affilié dans la metadata. */
  async creerCommission(
    type: 'setup' | 'recurrent',
    stripeInvoiceId: string | null | undefined,
    baseCents: number | null | undefined,
    devise: string | null | undefined,
    telegramId?: string | null,
    email?: string | null,
    libelle?: string | null,
    codeForce?: string | null,
  ): Promise<unknown> {
    if (!stripeInvoiceId || !baseCents || baseCents <= 0) return null;

    const dejaExiste = await this.prisma.affiliate_commissions.findFirst({ where: { stripe_invoice_id: stripeInvoiceId }, select: { id: true } });
    if (dejaExiste) return null;

    let trouve: { affiliate: Affiliate; referral: { id: string; statut: string } | null } | null = null;
    if (codeForce) {
      const aff = await this.parCode(codeForce);
      if (aff) trouve = { affiliate: aff, referral: null };
    }
    if (!trouve) trouve = await this.parrainDe(telegramId, email);
    if (!trouve) return null;

    const { affiliate: aff, referral: ref } = trouve;
    const tauxBrut = type === 'setup' ? aff.taux_setup : aff.taux_recurrent;
    const taux = Number(tauxBrut) || (type === 'setup' ? TAUX_SETUP_DEFAUT : TAUX_RECURRENT_DEFAUT);
    const montant = Math.round((baseCents * taux) / 100);

    const fraude = Boolean(ref && (await this.ipPartagee(aff.id, (ref as { ip?: string }).ip)));
    const aujourdhui = new Date();
    const periode = new Date(Date.UTC(aujourdhui.getUTCFullYear(), aujourdhui.getUTCMonth(), 1));
    const row = {
      affiliate_id: aff.id,
      telegram_id: telegramId || null,
      filleul_email: (email || '').trim().toLowerCase() || null,
      type,
      stripe_invoice_id: stripeInvoiceId,
      libelle: libelle || null,
      base_cents: Math.trunc(baseCents),
      devise: (devise || 'eur').toUpperCase(),
      taux,
      montant_cents: montant,
      statut: 'en_attente',
      fraude,
      periode,
    };
    let cree: { id: string } | null;
    try {
      cree = await this.prisma.affiliate_commissions.create({ data: row });
    } catch (e) {
      this.logger.warn(`commission affiliation non créée (${stripeInvoiceId}): ${e instanceof Error ? e.message : e}`);
      return null;
    }

    if (ref) await this.verrouiller(ref);
    this.logger.log(`commission ${type} ${(montant / 100).toFixed(2)} ${row.devise} -> ${aff.code}`);
    return cree;
  }

  // --- Vue affilié -----------------------------------------------------------

  private sommeParDevise(lignes: Array<{ devise: string; montant_cents: number | null }>, filtre?: (c: { statut: string }) => boolean): Record<string, number> {
    const total: Record<string, number> = {};
    for (const c of lignes as Array<{ devise: string; montant_cents: number | null; statut: string }>) {
      if (filtre && !filtre(c)) continue;
      total[c.devise] = (total[c.devise] || 0) + (c.montant_cents || 0);
    }
    return Object.fromEntries(Object.entries(total).map(([d, m]) => [d, m / 100]));
  }

  async tableauDeBord(affiliateId: string) {
    const coms = await this.prisma.affiliate_commissions.findMany({ where: { affiliate_id: affiliateId }, orderBy: { created_at: 'desc' } });
    const clics = await this.prisma.affiliate_clicks.count({ where: { affiliate_id: affiliateId } });
    const filleuls = await this.prisma.affiliate_referrals.count({ where: { affiliate_id: affiliateId } });
    return {
      clics,
      filleuls,
      gains_payes: this.sommeParDevise(coms, (c) => c.statut === 'payee'),
      gains_en_attente: this.sommeParDevise(coms, (c) => ['en_attente', 'validee', 'a_facturer'].includes(c.statut)),
      commissions: coms.slice(0, 200),
    };
  }

  async releves(affiliateId: string) {
    return this.prisma.affiliate_statements.findMany({ where: { affiliate_id: affiliateId }, orderBy: { periode: 'desc' } });
  }

  // --- Vue admin ---------------------------------------------------------------

  async listeAffilies(statut?: string | null) {
    const lignes = await this.prisma.affiliates.findMany({ where: statut ? { statut } : undefined, orderBy: { created_at: 'desc' } });
    return lignes.map((a) => {
      const { iban_chiffre, ...rest } = a;
      return { ...rest, iban: this.masquerIban(iban_chiffre) };
    });
  }

  async decider(affiliateId: string, statut: string, adminId?: string | null, motif?: string | null) {
    if (!['actif', 'refuse', 'suspendu'].includes(statut)) throw new Error('statut invalide');
    const upd: Record<string, unknown> = { statut, motif: motif ?? null };
    if (statut === 'actif') {
      upd.approuve_le = new Date();
      upd.approuve_par = adminId || null;
    }
    return this.prisma.affiliates.update({ where: { id: affiliateId }, data: upd });
  }

  /** Un taux négocié ne réécrit jamais l'historique : chaque commission garde le taux
   * appliqué le jour où elle a été créée. */
  async majTaux(affiliateId: string, tauxSetup?: number | null, tauxRecurrent?: number | null) {
    const upd: Record<string, unknown> = {};
    if (tauxSetup !== undefined && tauxSetup !== null) upd.taux_setup = Number(tauxSetup);
    if (tauxRecurrent !== undefined && tauxRecurrent !== null) upd.taux_recurrent = Number(tauxRecurrent);
    if (!Object.keys(upd).length) return {};
    return this.prisma.affiliates.update({ where: { id: affiliateId }, data: upd });
  }

  /** Lecture du RIB complet, pour le virement. À tracer côté route. */
  async ibanClair(affiliateId: string): Promise<string | null> {
    const row = await this.prisma.affiliates.findUnique({ where: { id: affiliateId }, select: { iban_chiffre: true } });
    return row ? this.dechiffrerIban(row.iban_chiffre) : null;
  }

  /** periode = 'AAAA-MM' : c'est le filtre mois par mois du back-office. */
  async commissions(periode?: string | null, statut?: string | null, affiliateId?: string | null) {
    const where: Record<string, unknown> = {};
    if (statut) where.statut = statut;
    if (affiliateId) where.affiliate_id = affiliateId;
    if (periode) where.periode = new Date(`${periode}-01T00:00:00.000Z`);
    const lignes = await this.prisma.affiliate_commissions.findMany({ where, orderBy: { created_at: 'desc' } });
    const affs = await this.prisma.affiliates.findMany({ select: { id: true, code: true, nom: true, email: true } });
    const noms = new Map(affs.map((a) => [a.id, a]));
    return lignes.map((c) => {
      const a = noms.get(c.affiliate_id);
      return { ...c, affilie_code: a?.code ?? null, affilie_nom: a?.nom ?? null };
    });
  }

  /** Qui a vendu ce mois-là, et pour combien. Une ligne par affilié et devise. */
  async resumeMois(periode: string) {
    const lignes = await this.commissions(periode);
    const par = new Map<string, { affilie_code: string | null; affilie_nom: string | null; devise: string; nb: number; montant: number; ca: number; setup: number; recurrent: number }>();
    for (const c of lignes as Array<Record<string, unknown>>) {
      if (c.statut === 'annulee') continue;
      const cle = `${c.affiliate_id}|${c.devise}`;
      let e = par.get(cle);
      if (!e) {
        e = { affilie_code: (c.affilie_code as string) ?? null, affilie_nom: (c.affilie_nom as string) ?? null, devise: c.devise as string, nb: 0, montant: 0, ca: 0, setup: 0, recurrent: 0 };
        par.set(cle, e);
      }
      e.nb += 1;
      e.montant += Number(c.montant_cents || 0) / 100;
      e.ca += Number(c.base_cents || 0) / 100;
      const type = c.type as 'setup' | 'recurrent';
      e[type] = (e[type] || 0) + 1;
    }
    return [...par.values()].sort((a, b) => b.montant - a.montant);
  }

  async valider(commissionId: string) {
    const res = await this.prisma.affiliate_commissions.updateMany({ where: { id: commissionId, statut: 'en_attente' }, data: { statut: 'validee', validee_le: new Date() } });
    if (!res.count) return {};
    return this.prisma.affiliate_commissions.findUnique({ where: { id: commissionId } });
  }

  async annuler(commissionId: string) {
    await this.prisma.affiliate_commissions.updateMany({ where: { id: commissionId }, data: { statut: 'annulee' } });
    return this.prisma.affiliate_commissions.findUnique({ where: { id: commissionId } });
  }

  /** Regroupe les commissions validées du mois par affilié ET par devise, crée un
   * relevé, et renvoie de quoi envoyer les emails (le contrôleur s'en charge).
   * L'affilié envoie ensuite sa facture ; le virement se fait hors plateforme. */
  async traitementMensuel(periode: string): Promise<Array<{ email: string | null; nom: string | null; periode: string; montant: number; devise: string; nb: number }>> {
    const lignes = (await this.commissions(periode, 'validee')) as Array<Record<string, unknown>>;
    if (!lignes.length) return [];

    const affs = await this.prisma.affiliates.findMany();
    const affilies = new Map(affs.map((a) => [a.id, a]));
    const groupes = new Map<string, Array<Record<string, unknown>>>();
    for (const c of lignes) {
      const cle = `${c.affiliate_id}|${c.devise}`;
      const arr = groupes.get(cle) || [];
      arr.push(c);
      groupes.set(cle, arr);
    }

    const envois: Array<{ email: string | null; nom: string | null; periode: string; montant: number; devise: string; nb: number }> = [];
    for (const [cle, coms] of groupes) {
      const [aid, devise] = cle.split('|');
      const total = coms.reduce((s, c) => s + Number(c.montant_cents || 0), 0);
      const releve = await this.prisma.affiliate_statements.upsert({
        where: { affiliate_id_periode_devise: { affiliate_id: aid, periode: new Date(`${periode}-01T00:00:00.000Z`), devise } },
        create: { affiliate_id: aid, periode: new Date(`${periode}-01T00:00:00.000Z`), devise, montant_cents: total, nb: coms.length, statut: 'a_facturer' },
        update: { montant_cents: total, nb: coms.length, statut: 'a_facturer' },
      });

      for (const c of coms) {
        await this.prisma.affiliate_commissions.update({ where: { id: c.id as string }, data: { statut: 'a_facturer', releve_id: releve.id } });
      }

      const a = affilies.get(aid);
      envois.push({ email: a?.email ?? null, nom: a?.nom ?? null, periode, montant: total / 100, devise, nb: coms.length });
    }
    return envois;
  }

  /** Virement effectué : le relevé et toutes ses commissions passent à payée. */
  async marquerPaye(releveId: string) {
    const maintenant = new Date();
    await this.prisma.affiliate_commissions.updateMany({ where: { releve_id: releveId }, data: { statut: 'payee', payee_le: maintenant } });
    return this.prisma.affiliate_statements.update({ where: { id: releveId }, data: { statut: 'payee', payee_le: maintenant } });
  }

  async tousReleves(periode?: string | null) {
    const lignes = await this.prisma.affiliate_statements.findMany({
      where: periode ? { periode: new Date(`${periode}-01T00:00:00.000Z`) } : undefined,
      orderBy: { periode: 'desc' },
    });
    const affs = await this.prisma.affiliates.findMany({ select: { id: true, code: true, nom: true, email: true } });
    const noms = new Map(affs.map((a) => [a.id, a]));
    return lignes.map((r) => {
      const a = noms.get(r.affiliate_id);
      return { ...r, affilie_code: a?.code ?? null, affilie_nom: a?.nom ?? null, affilie_email: a?.email ?? null };
    });
  }
}
