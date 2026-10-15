import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { Langue, langueCode } from '../../common/utils/textes-fixes.util';
import { MAIL } from './mail-textes';

/**
 * Envoi d'emails via Resend — port direct de backend/services/mail_service.py.
 *
 * Le gabarit : un email n'est pas une page web (moteur de rendu Outlook = celui de Word,
 * ni flexbox ni grille ni CSS externe), donc tout est en tableaux avec le style sur chaque
 * balise. Fond CLAIR + `color-scheme: light` déclaré (un email sombre s'imprime mal et
 * arrive illisible une fois transféré). Voir le fichier Python d'origine pour le détail
 * de chaque choix — repris ici sans les réexpliquer un par un.
 *
 * Seul `code_connexion_html` est porté pour l'instant (c'est ce qu'attend le MFA) ; les
 * autres gabarits (reset_email_html, facture_html, admin_payment_html...) restent à faire
 * quand ces flux-là seront portés à leur tour.
 */

const POLICE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const TEINTES: Record<string, [string, string]> = {
  marque: ['#6A5CFF', 'linear-gradient(90deg,#5B6CFF,#8A6CFF)'],
  succes: ['#3AFFA3', 'linear-gradient(90deg,#3AFFA3,#7fd7d0)'],
  alerte: ['#f59e0b', 'linear-gradient(90deg,#f59e0b,#fbbf24)'],
  erreur: ['#ef4444', 'linear-gradient(90deg,#ef4444,#f87171)'],
};
const VERT_TEXTE = '#0b7a53';
const LOGO_URL = 'https://res.cloudinary.com/dy9gp5pim/image/upload/brand/postorico-logo.png';
const RICO_URL =
  'https://res.cloudinary.com/dy9gp5pim/image/upload/w_180,q_auto,f_png/brand/rico-v4/pouce-leve.png';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Échappe le HTML puis convertit les sauts de ligne en <br>. */
function nl2br(text: string): string {
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}

/** Ex. `279:00` -> "279" ; `140.5` -> "140,50" — équivalent de
 * `f"{montant:.2f}".replace(".", ",").removesuffix(",00")`. */
function formatMontant(montant: number): string {
  const s = montant.toFixed(2).replace('.', ',');
  return s.endsWith(',00') ? s.slice(0, -3) : s;
}

const ADMIN_PAYMENT_CFG: Record<string, { emoji: string; teinte: string; titre: string }> = {
  new_sub: { emoji: '💳 Nouvel abonnement', teinte: 'succes', titre: 'Nouvel abonnement Pro' },
  canceling: { emoji: '⏳ Résiliation programmée', teinte: 'alerte', titre: 'Résiliation programmée' },
  pack: { emoji: '🧩 Pack acheté', teinte: 'marque', titre: 'Achat de pack' },
  canceled: { emoji: '❌ Résiliation', teinte: 'erreur', titre: 'Abonnement terminé' },
  payment_failed: { emoji: '⚠️ Paiement échoué', teinte: 'alerte', titre: 'Échec de paiement' },
};
const ADMIN_PAYMENT_NOTES: Record<string, string> = {
  new_sub:
    "Un nouvel abonnement Pro vient d'être activé. Le compte a accès à toutes les fonctionnalités et sera renouvelé automatiquement chaque mois.",
  canceling:
    "L'abonné a demandé la résiliation. Il conserve l'accès Pro jusqu'à la date d'échéance ci-dessous, puis son compte repassera automatiquement en offre gratuite.",
  pack: 'Un pack de résultats supplémentaires vient d\'être acheté. Le quota correspondant a été crédité automatiquement sur le compte.',
  canceled:
    "L'abonnement est arrivé à échéance et a pris fin. Le compte est repassé en offre gratuite ; l'abonné peut se réabonner à tout moment.",
  payment_failed:
    'Le dernier prélèvement a échoué. Stripe va effectuer de nouvelles tentatives ; sans succès, l\'abonnement finira par être suspendu.',
};

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  private readonly domain: string;
  private readonly replyTo: string;
  private readonly unsubscribeMailto: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('app.resendApiKey');
    this.from = this.config.get<string>('app.resendFrom')!;
    this.resend = apiKey ? new Resend(apiKey) : null;
    const domainMatch = /@([^\s>]+)/.exec(this.from);
    this.domain = domainMatch ? domainMatch[1] : 'postorico.com';
    this.replyTo = `contact@${this.domain}`;
    this.unsubscribeMailto = `mailto:unsubscribe@${this.domain}?subject=unsubscribe`;
  }

  // ---------------------------------------------------------------- Briques du gabarit
  private preheader(texte: string): string {
    const bourrage = '&#847;&zwnj;&nbsp;'.repeat(60);
    return (
      `<div class="apercu" style="display:none;max-height:0;overflow:hidden;` +
      `mso-hide:all;font-size:1px;line-height:1px;color:#f4f6fb;opacity:0;">` +
      `${escapeHtml(texte)}${bourrage}</div>`
    );
  }

  /** Le bouton d'action. `bgcolor` en attribut plutôt qu'en style : c'est ce que lit Outlook. */
  private bouton(url: string, libelle: string): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>
        <td align="center" bgcolor="#6A5CFF" style="border-radius:10px;background-color:#6A5CFF;background-image:linear-gradient(135deg,#5B6CFF,#8A6CFF);mso-padding-alt:14px 30px;">
          <a href="${url}" target="_blank" style="display:inline-block;padding:14px 30px;border-radius:10px;color:#ffffff;font-family:${POLICE};font-size:14.5px;font-weight:bold;text-decoration:none;">${libelle}</a>
        </td>
      </tr></table>`;
  }

  /** Le lien en toutes lettres, pour le client qui n'affiche pas les boutons. */
  private lienSecours(url: string, l: Langue = 'fr'): string {
    return `<p style="color:#6b7688;font-size:12px;line-height:1.6;margin:0 0 4px;">${MAIL[l].lienSecours}</p>
      <p style="margin:0 0 22px;"><a href="${url}" target="_blank" style="color:#6d4fe0;font-size:12px;word-break:break-all;">${url}</a></p>`;
  }

  private encadre(surtitre: string, titre: string, valeur = '', couleur = VERT_TEXTE): string {
    const val = valeur
      ? `<p style="color:${couleur};font-size:24px;font-weight:bold;margin:0;font-family:${POLICE};">${valeur}</p>`
      : '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f8fc;border:1px solid #e6e9f2;border-radius:12px;margin:0 0 24px;">
        <tr><td style="padding:18px 22px;">
          <p style="color:#5b6a82;font-size:11px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.09em;">${surtitre}</p>
          <p style="color:#0f172a;font-size:15px;font-weight:bold;margin:0 0 ${valeur ? '8px' : '0'};">${titre}</p>
          ${val}
        </td></tr>
      </table>`;
  }

  /** La signature de fin, avec la mascotte — décorative, le texte se suffit à lui-même
   * (la moitié des clients bloquent les images par défaut). */
  private signature(l: Langue = 'fr'): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;border-top:1px solid #e9ecf4;width:100%;">
        <tr>
          <td width="64" style="padding:16px 13px 0 0;vertical-align:middle;">
            <img src="${RICO_URL}" width="64" alt="" style="display:block;width:64px;height:auto;border:0;">
          </td>
          <td style="padding:18px 0 0;vertical-align:middle;color:#6b7688;font-size:12.5px;line-height:1.6;">
            ${MAIL[l].signature}<br>
            <span style="color:#6b7688;">${MAIL[l].signatureQuestion}</span>
          </td>
        </tr>
      </table>`;
  }

  private header(teinte = 'marque', l: Langue = 'fr'): string {
    const [plein, degrade] = TEINTES[teinte] ?? TEINTES.marque;
    return `<tr><td bgcolor="${plein}" height="4" style="height:4px;line-height:4px;font-size:0;background-color:${plein};background-image:${degrade};">&nbsp;</td></tr>
    <tr><td style="padding:26px 32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="line-height:0;">
          <img src="${LOGO_URL}" width="34" height="34" alt="Postorico" style="display:block;width:34px;height:34px;border:0;">
        </td>
        <td style="padding-left:11px;font-family:${POLICE};">
          <span style="display:block;color:#0f172a;font-size:17px;font-weight:bold;letter-spacing:-.01em;line-height:1.2;">Postorico</span>
          <span style="display:block;color:#6b7688;font-size:11.5px;line-height:1.4;">${MAIL[l].slogan}</span>
        </td>
      </tr></table>
    </td></tr>`;
  }

  private footer(internal = false, l: Langue = 'fr'): string {
    if (internal) {
      return `<tr><td style="padding:18px 32px;border-top:1px solid #e9ecf4;color:#6b7688;font-size:11px;">
          © 2026 Postorico, notification interne automatique
        </td></tr>`;
    }
    return `<tr><td style="padding:20px 32px;border-top:1px solid #e9ecf4;">
      <p style="margin:0;color:#6b7688;font-size:11px;line-height:1.7;">
        © 2026 Postorico ·
        <a href="mailto:${this.replyTo}" style="color:#6b7688;text-decoration:none;">${this.replyTo}</a> ·
        <a href="${this.unsubscribeMailto}" style="color:#6b7688;text-decoration:underline;">${MAIL[l].seDesinscrire}</a>
      </p>
    </td></tr>`;
  }

  private shell(inner: string, width = 520, internal = false, apercu = '', teinte = 'marque', l: Langue = 'fr'): string {
    return `<!DOCTYPE html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  @media only screen and (max-width:600px) {
    .carte { width:100% !important; border-radius:0 !important; }
    .marge { padding-left:22px !important; padding-right:22px !important; }
    .titre { font-size:19px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:${POLICE};-webkit-font-smoothing:antialiased;">
  ${apercu ? this.preheader(apercu) : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" class="carte" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${width}px;background:#ffffff;border:1px solid #e6e9f2;border-radius:16px;overflow:hidden;">
        ${this.header(teinte, l)}
        ${inner}
        ${this.footer(internal, l)}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private htmlToText(html: string): string {
    let t = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<div[^>]+class="apercu"[\s\S]*?<\/div>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/\n\s*\n\s*\n+/g, '\n\n');
    return t.trim();
  }

  // ---------------------------------------------------------------- Gabarits
  // Les emails CLIENTS prennent la langue du compte en dernier paramètre (users.langue) ; leurs
  // textes sont dans mail-textes.ts. Les emails internes (admin) restent en français.

  private bonjour(nom: string | null, l: Langue): string {
    return MAIL[l].bonjour(nom ? escapeHtml(nom) : '');
  }

  /** Code de connexion à 6 chiffres (appareil inconnu ou administrateur). */
  codeConnexionHtml(nom: string | null, code: string, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].code;
    const codeAff = `${code.slice(0, 3)}&nbsp;${code.slice(3)}`;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 20px;">
        ${t.texte}
      </p>
      ${this.encadre(t.encadreSur, t.encadreTitre, codeAff, '#0f172a')}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.pasToi}
      </p>
    </td></tr>`;
    return { subject: t.sujet(code), html: this.shell(inner, 480, false, t.apercu(code), 'marque', l) };
  }

  /** Sujet de l'email de réinitialisation du mot de passe. */
  resetSujet(langue?: unknown): string {
    return MAIL[langueCode(langue)].reset.sujet;
  }

  /** Email de réinitialisation du mot de passe. */
  resetEmailHtml(nom: string | null, link: string, langue?: unknown): string {
    const l = langueCode(langue);
    const t = MAIL[l].reset;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 24px;">
        ${t.texte}
      </p>
      ${this.bouton(link, t.bouton)}
      ${this.lienSecours(link, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.pasToi}
      </p>
    </td></tr>`;
    return this.shell(inner, 480, false, t.apercu, 'marque', l);
  }

  /** Sujet de l'alerte « réseau déconnecté ». */
  deconnexionSujet(reseau: string, langue?: unknown): string {
    const r = (reseau || '').charAt(0).toUpperCase() + (reseau || '').slice(1);
    return MAIL[langueCode(langue)].deconnexion.sujet(r);
  }

  /** Alerte : un réseau social s'est déconnecté — CTA de reconnexion en un clic. Envoyé dès
   * réception du webhook account.disconnected (sinon les publications échouent en silence
   * jusqu'à ce que le client ouvre l'app). */
  accountDisconnectedHtml(nom: string | null, reseau: string, link: string, langue?: unknown): string {
    const l = langueCode(langue);
    const t = MAIL[l].deconnexion;
    const reseauCap = escapeHtml((reseau || '').charAt(0).toUpperCase() + (reseau || '').slice(1));
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre(reseauCap)}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.texte(reseauCap)}
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fff8ec;border:1px solid #f6d9a6;border-radius:10px;margin:0 0 24px;">
        <tr><td style="padding:14px 18px;color:#8a5a00;font-size:13.5px;line-height:1.6;">
          ${t.pause(reseauCap)}
        </td></tr>
      </table>
      ${this.bouton(link, t.bouton)}
      ${this.lienSecours(link, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
    </td></tr>`;
    return this.shell(inner, 480, false, t.apercu(reseauCap), 'alerte', l);
  }

  /** Notifie l'admin (email interne) d'un événement de facturation Stripe. */
  adminPaymentHtml(kind: string, nom: string | null, email: string | null, detail = ''): { subject: string; html: string } {
    const c = ADMIN_PAYMENT_CFG[kind] ?? { emoji: '💳 Paiement', teinte: 'marque', titre: 'Événement de facturation' };
    const note = ADMIN_PAYMENT_NOTES[kind] ?? "Un événement de facturation vient d'être enregistré sur ce compte.";
    const [plein] = TEINTES[c.teinte] ?? TEINTES.marque;
    const who = escapeHtml(nom || 'Client');
    const mail = escapeHtml(email || '(sans email)');
    const extra = detail ? `<p style="margin:10px 0 0;color:#1f2937;font-size:14px;line-height:1.6;">${escapeHtml(detail)}</p>` : '';
    const subject = `${c.emoji} : ${who}`;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <div style="border-left:3px solid ${plein};padding:2px 0 2px 16px;">
        <h1 class="titre" style="margin:0 0 8px;font-size:19px;color:#0f172a;font-weight:bold;">${c.titre}</h1>
        <p style="margin:0;color:#334155;font-size:15px;"><b style="color:#0f172a;">${who}</b> &lt;${mail}&gt;</p>
        ${extra}
      </div>
      <p style="margin:18px 0 0;color:#5b6a82;font-size:13.5px;line-height:1.7;">${note}</p>
      <p style="margin:14px 0 0;color:#6b7688;font-size:12.5px;line-height:1.6;">
        Le détail complet (montant, dates, historique des paiements) est dans le tableau de bord administrateur, section Facturation.
      </p>
    </td></tr>`;
    return { subject, html: this.shell(inner, 520, true, `${c.titre} · ${who}`, c.teinte) };
  }

  /** Email FACTURE au client après un paiement réussi (abonnement ou pack). */
  factureHtml(
    nom: string | null,
    montant: number,
    devise: string,
    libelle: string,
    numero?: string,
    url?: string,
    pdf?: string,
    langue?: unknown,
  ): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].facture;
    const deviseSym = devise === 'EUR' ? '€' : devise;
    const montantTxt = formatMontant(montant);
    const num = numero ? t.num(escapeHtml(numero)) : '';
    const subject = t.sujet(num, `${montantTxt} ${deviseSym}`);
    const bouton = url ? this.bouton(url, t.bouton) : '';
    const lienPdf = pdf
      ? `<p style="margin:0 0 22px;"><a href="${pdf}" target="_blank" style="color:#6d4fe0;font-size:13px;">${t.pdf}</a></p>`
      : '';
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 22px;">${this.bonjour(nom, l)}</p>
      ${this.encadre(t.encadre(num), escapeHtml(libelle), `${montantTxt} ${deviseSym}`)}
      ${bouton}
      ${lienPdf}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
      ${this.signature(l)}
    </td></tr>`;
    return { subject, html: this.shell(inner, 480, false, `${libelle} · ${montantTxt} ${deviseSym}`, 'succes', l) };
  }

  /** Rappel J-3 avant le premier prélèvement (fin d'essai, ou fin du délai après le Pack
   * Fondations — deux situations, même montant/date/résiliation à donner en clair). */
  rappelPrelevementHtml(
    nom: string | null,
    montant: number,
    devise: string,
    date: string,
    lien: string,
    apresPack = false,
    langue?: unknown,
  ): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].rappel;
    const deviseSym = (devise || 'EUR').toUpperCase() === 'EUR' ? '€' : devise.toUpperCase();
    const montantTxt = formatMontant(montant);
    const jour = escapeHtml(date);
    const subject = apresPack ? t.sujetPack(date) : t.sujetEssai(date);
    const titre = apresPack ? t.titrePack : t.titreEssai;
    const contexte = apresPack ? t.contextePack : t.contexteEssai;

    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 22px;">${contexte}</p>
      ${this.encadre(t.encadreSur, t.encadreTitre(jour), `${montantTxt} ${deviseSym}`)}
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 20px;">
        ${t.ensuite(`${montantTxt}&nbsp;${deviseSym}`)}
      </p>
      ${this.bouton(lien, t.bouton)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin(jour)}
      </p>
      ${this.signature(l)}
    </td></tr>`;
    return {
      subject,
      html: this.shell(inner, 480, false, t.apercu(`${montantTxt} ${deviseSym}`, date), 'alerte', l),
    };
  }

  /** Confirmation de résiliation : jusqu'à quand l'accès reste ouvert, et comment revenir —
   * sans tentative de rattrapage (la personne vient de dire non). */
  resiliationHtml(nom: string | null, fin: string | null, lien: string, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].resiliation;
    let jour = '';
    if (fin) {
      const d = new Date(String(fin));
      jour = Number.isNaN(d.getTime())
        ? String(fin).slice(0, 10)
        : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
    }
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 22px;">
        ${t.texte(t.quand(jour))}
      </p>
      ${this.encadre(t.encadreSur, jour || t.finPeriode)}
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 20px;">
        ${t.garde}
      </p>
      ${this.bouton(lien, t.bouton)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.merci}
      </p>
      ${this.signature(l)}
    </td></tr>`;
    return { subject: t.sujet(jour), html: this.shell(inner, 480, false, t.apercu(jour), 'marque', l) };
  }

  /** Mail 1 impayé : le prélèvement a échoué. Ton neutre (carte expirée, la plupart du
   * temps), lien direct de régularisation. */
  impayeEchecHtml(nom: string | null, lien: string, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].impayeEchec;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.texte}
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fff8ec;border:1px solid #f6d9a6;border-radius:10px;margin:0 0 24px;">
        <tr><td style="padding:14px 18px;color:#8a5a00;font-size:13.5px;line-height:1.6;">
          ${t.pause}
        </td></tr>
      </table>
      ${this.bouton(lien, t.bouton)}
      ${this.lienSecours(lien, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
    </td></tr>`;
    return { subject: t.sujet, html: this.shell(inner, 480, false, t.apercu, 'alerte', l) };
  }

  private impayeListeReseaux(reseaux?: string[] | null): string {
    if (!reseaux || !reseaux.length) return '';
    const items = reseaux.map((r) => `<li style="margin:0 0 4px;">${escapeHtml(String(r).charAt(0).toUpperCase() + String(r).slice(1))}</li>`).join('');
    return `<ul style="margin:0 0 18px;padding-left:20px;color:#334155;font-size:14px;line-height:1.6;">${items}</ul>`;
  }

  /** Mail 2 impayé, J+9 : demain, les réseaux seront déconnectés. */
  impayeAvertissementHtml(nom: string | null, lien: string, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].impayeAvertissement;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.texte}
      </p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.deuxMinutes}
      </p>
      ${this.bouton(lien, t.bouton)}
      ${this.lienSecours(lien, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
    </td></tr>`;
    return { subject: t.sujet, html: this.shell(inner, 480, false, t.apercu, 'alerte', l) };
  }

  /** Mail 3 impayé, J+10 : confirmation de la suspension, liste des réseaux déconnectés. */
  impayeSuspensionHtml(nom: string | null, lien: string, reseaux?: string[] | null, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].impayeSuspension;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 14px;">
        ${t.texte}
      </p>
      ${this.impayeListeReseaux(reseaux)}
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.reprise}
      </p>
      ${this.bouton(lien, t.bouton)}
      ${this.lienSecours(lien, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
    </td></tr>`;
    return { subject: t.sujet, html: this.shell(inner, 480, false, t.apercu, 'erreur', l) };
  }

  /** Mail 4 impayé, J+29 : dernier avis avant résiliation. */
  impayeDernierAvisHtml(nom: string | null, lien: string, langue?: unknown): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].impayeDernierAvis;
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 10px;">${this.bonjour(nom, l)}</p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.texte}
      </p>
      <p style="color:#5b6a82;font-size:14.5px;line-height:1.65;margin:0 0 18px;">
        ${t.regulariser}
      </p>
      ${this.bouton(lien, t.bouton)}
      ${this.lienSecours(lien, l)}
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
    </td></tr>`;
    return { subject: t.sujet, html: this.shell(inner, 480, false, t.apercu, 'erreur', l) };
  }

  /** Relevé mensuel envoyé à l'apporteur d'affaires : c'est son signal pour nous envoyer sa
   * facture. Le virement se fait ensuite hors plateforme. */
  releveAffilieHtml(
    nom: string | null,
    periode: string,
    montant: number,
    devise: string,
    nb: number,
    langue?: unknown,
  ): { subject: string; html: string } {
    const l = langueCode(langue);
    const t = MAIL[l].releve;
    const deviseSym = (devise || 'EUR').toUpperCase() === 'EUR' ? '€' : devise;
    const montantTxt = montant.toFixed(2).replace('.', ',').replace(/,00$/, '');
    const mois = escapeHtml(periode);
    const ventes = t.ventes(nb);
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <h1 class="titre" style="color:#0f172a;font-size:21px;font-weight:bold;margin:0 0 14px;line-height:1.25;">${t.titre}</h1>
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 22px;">${this.bonjour(nom, l)}</p>
      ${this.encadre(t.encadreSur(mois), ventes, `${montantTxt} ${deviseSym}`)}
      <p style="color:#334155;font-size:14.5px;line-height:1.65;margin:0 0 20px;">
        ${t.facture}
      </p>
      <p style="color:#6b7688;font-size:12.5px;line-height:1.65;margin:0;border-top:1px solid #e9ecf4;padding-top:16px;">
        ${t.fin}
      </p>
      ${this.signature(l)}
    </td></tr>`;
    return {
      subject: t.sujet(mois, `${montantTxt} ${deviseSym}`),
      html: this.shell(inner, 480, false, t.apercu(ventes, `${montantTxt} ${deviseSym}`), 'succes', l),
    };
  }

  /** Notification interne : un nouvel audit de marque vient d'arriver (onboarding public). */
  auditNotificationHtml(marque: string | null, email: string | null, recap: string, adminUrl: string): string {
    const marqueTxt = escapeHtml(marque || 'Sans nom');
    const emailTxt = escapeHtml(email || '(sans email)');
    const recapHtml = nl2br(recap);
    const inner = `<tr><td class="marge" style="padding:12px 32px 26px;">
      <span style="display:inline-block;background:#e7faf1;color:#0b7a53;font-size:11px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:99px;">Nouveau lead</span>
      <h1 class="titre" style="color:#0f172a;font-size:20px;font-weight:bold;margin:14px 0 6px;">Nouvel audit de marque reçu</h1>
      <p style="color:#5b6a82;font-size:14px;line-height:1.7;margin:0 0 20px;">
        <strong style="color:#1f2937;">Marque :</strong> ${marqueTxt}<br>
        <strong style="color:#1f2937;">Email :</strong> <a href="mailto:${emailTxt}" style="color:#6d4fe0;">${emailTxt}</a>
      </p>
      ${this.bouton(adminUrl, "Ouvrir dans l'admin")}
      <div style="background:#f7f8fc;border:1px solid #e6e9f2;border-radius:12px;padding:16px 18px;color:#334155;font-size:12.5px;line-height:1.75;font-family:ui-monospace,Menlo,Consolas,monospace;">
        ${recapHtml}
      </div>
    </td></tr>`;
    return this.shell(inner, 600, true, `${marqueTxt}, ${emailTxt}`, 'succes');
  }

  /** Réponse envoyée au prospect depuis l'admin (pas de compte : on le vouvoie, comme sur le site). */
  auditReplyHtml(marque: string | null, message: string): string {
    const salutation = marque ? `Bonjour ${escapeHtml(marque)},` : 'Bonjour,';
    const bodyHtml = nl2br(message);
    const debut = (message || '').replace(/\s+/g, ' ').trim().slice(0, 110);
    const inner = `<tr><td class="marge" style="padding:14px 32px 26px;">
      <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 16px;">${salutation}</p>
      <div style="color:#1f2937;font-size:15px;line-height:1.75;">${bodyHtml}</div>
      ${this.signature()}
    </td></tr>`;
    return this.shell(inner, 520, false, debut);
  }

  // ---------------------------------------------------------------- Envoi
  /** `unsubscribeUrl` (newsletter) : ajoute un lien https en tête de List-Unsubscribe et
   * List-Unsubscribe-Post -> désinscription One-Click, bon signal de délivrabilité.
   * Sans URL, on retombe sur le mailto seul (pas de One-Click). */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
    unsubscribeUrl?: string,
  ): Promise<{ id?: string; error?: string }> {
    if (!this.resend) {
      this.logger.error('RESEND_API_KEY manquante — email non envoyé');
      return { error: 'no_resend_key' };
    }
    try {
      const headers: Record<string, string> = unsubscribeUrl
        ? {
            'List-Unsubscribe': `<${unsubscribeUrl}>, <${this.unsubscribeMailto}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }
        : { 'List-Unsubscribe': `<${this.unsubscribeMailto}>` };
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: [to],
        replyTo: this.replyTo,
        subject,
        html,
        text: text ?? this.htmlToText(html),
        headers,
      });
      if (error) {
        this.logger.error(`Resend error: ${error.message}`);
        return { error: `resend_${error.name}` };
      }
      return { id: data?.id };
    } catch (e: unknown) {
      this.logger.error(`Resend request error: ${e instanceof Error ? e.message : e}`);
      return { error: 'resend_request_failed' };
    }
  }
}
