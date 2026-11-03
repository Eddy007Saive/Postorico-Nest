import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { ErreurCompte } from '../../common/utils/erreur-compte.util';

/** Un email à l'admin par problème et par fournisseur toutes les 6 h au plus : une panne de
 * crédits échoue sur chaque génération de chaque client, un email par échec noierait la boîte. */
const INTERVALLE_MS = 6 * 3600 * 1000;

const RAISONS: Record<ErreurCompte, { titre: string; action: string }> = {
  credits: {
    titre: 'crédits épuisés',
    action: 'Recharge les crédits du compte (Plans & Billing) : tant que ce n’est pas fait, les générations échouent pour tous les clients.',
  },
  cle: {
    titre: 'clé API refusée',
    action: 'Vérifie la clé API dans les variables Railway : elle a peut-être été révoquée ou remplacée.',
  },
};

function echapper(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Prévient l'admin par email d'une panne qu'il est seul à pouvoir régler. */
@Injectable()
export class AlerteAdminService {
  private readonly logger = new Logger(AlerteAdminService.name);
  private readonly dernierEnvoi = new Map<string, number>();

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Ne lève jamais : une alerte ratée ne doit pas masquer l'erreur d'origine. */
  async fournisseur(nom: string, raison: ErreurCompte, detail: string): Promise<void> {
    const cle = `${nom}:${raison}`;
    const maintenant = Date.now();
    if (maintenant - (this.dernierEnvoi.get(cle) ?? 0) < INTERVALLE_MS) return;
    this.dernierEnvoi.set(cle, maintenant);
    const dest = this.config.get<string>('app.adminNotifEmail');
    if (!dest) return;
    const { titre, action } = RAISONS[raison];
    const html =
      `<p><strong>${echapper(nom)} : ${titre}.</strong></p>` +
      `<p>${action}</p>` +
      `<p style="color:#64748b;font-size:13px">Détail renvoyé par ${echapper(nom)} :<br><code>${echapper(detail.slice(0, 500))}</code></p>` +
      `<p style="color:#64748b;font-size:13px">Prochain rappel dans 6 h au plus tôt si le problème continue.</p>`;
    try {
      await this.mail.sendEmail(dest, `🚨 Postorico : ${nom}, ${titre}`, html);
      this.logger.warn(`Alerte admin envoyée : ${nom} ${raison}`);
    } catch (e) {
      this.logger.error(`Alerte admin non envoyée (${nom} ${raison}) : ${e instanceof Error ? e.message : e}`);
    }
  }
}
