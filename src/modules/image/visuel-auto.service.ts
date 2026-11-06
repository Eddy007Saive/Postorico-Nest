import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { refusQuota } from '../../common/utils/agent-http-errors';
import { labelStatutContenu } from '../../common/utils/contenu-enum.util';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService, MODELE_REDACTION } from '../claude/claude.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { LateService } from '../late/late.service';
import { MarqueService } from '../marque/marque.service';
import { NotificationService } from '../notifications/notification.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaResult } from '../quota/interfaces/quota-result.interface';
import { imageAction, QuotaService } from '../quota/quota.service';
import { IMAGE_PRICES, UsageService } from '../usage/usage.service';
import { IMAGE_MODELS, ImageService, vignette } from './image.service';
import {
  lireDirection,
  MAX_GABARITS,
  MAX_INSPIRATIONS,
  Direction,
} from './visuel-auto.util';

/** Formats qui reçoivent une image (les carrousels, vidéos et reels ont leur propre rendu). */
const TYPES_IMAGE = new Set(['Post_court', 'Post_moyen', 'Post_long', 'Story']);

const LANGUES: Record<string, string> = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
};

const ROLE_DIRECTION =
  "Tu es le directeur artistique de la marque. Tu prépares le visuel d'un post de réseau social. " +
  "Deux choses à tenir ensemble : la COHÉRENCE de la marque (ses gabarits de publication, chacun " +
  "avec ses règles, et ses images d'inspiration) et la VARIÉTÉ (un feed où chaque visuel montre la " +
  "même photo lasse vite). Tu VOIS ces images : appuie-toi sur ce qu'elles montrent vraiment.\n\n" +
  "1. Choisis le gabarit le plus adapté au post. Commence par l'ANGLE du post (nouveau produit ? " +
  'produit mis en avant avec son prix ? situation du quotidien, moment de vie ? argument ou ' +
  'info pratique ?), puis prends le gabarit dont le nom et les règles décrivent CET usage : ce ' +
  'sont elles qui disent à quoi il sert. Un gabarit aux règles génériques (qui ne disent pas à ' +
  "quoi il sert) ne se choisit que si aucun autre ne correspond à l'angle. Dès que le client a des " +
  'gabarits, choisis-en TOUJOURS un, le plus proche : le visuel garde la mise en page de la marque et ' +
  "change de photo. 0 seulement s'il n'y a aucun gabarit.\n" +
  'Dès que le post parle de quelque chose de CONCRET (un lieu, un métier, un commerce, un produit, une ' +
  'situation), prends un gabarit qui contient une PHOTO, pour montrer ce sujet ; un gabarit purement ' +
  'typographique (sans photo) va aux posts d\'opinion ou aux punchlines sans sujet concret.\n' +
  "2. Choisis jusqu'à 3 inspirations (leurs numéros) : 2 ou 3 images de style qui donnent " +
  "l'UNIVERS de la marque (type de photo, lumière, étalonnage, ambiance), et celles marquées " +
  '« à intégrer » quand elles ont leur place dans la scène.\n' +
  '3. AVEC un gabarit : le gabarit fixe la MISE EN PAGE et la CHARTE (emplacements et hiérarchie des ' +
  'textes, polices, couleurs, bandeaux, logo, éléments graphiques) ; ça ne bouge pas. Ce qui change à ' +
  'chaque post, c\'est la PHOTO (ou l\'illustration) et les textes :\n' +
  '   - "scene" : une scène NEUVE qui montre le sujet CONCRET du post : le lieu, le métier, les objets, ' +
  'les produits, les animaux dont il parle. Exemple : un post sur les avis Google d\'une boucherie se ' +
  "passe DANS une boucherie (l'étal, la vitrine, le boucher au travail), pas devant un téléphone. " +
  "Décris en un paragraphe le sujet, le décor, l'action, le cadrage, l'angle et la lumière, dans " +
  "l'univers des inspirations, sans copier leur contenu. Jamais la photo du gabarit, jamais une scène " +
  'proche des scènes déjà utilisées (liste fournie) : change de lieu, de sujet, d\'angle ou de moment. ' +
  'Des personnes possibles de dos, de profil ou en plan serré sur les mains, pas de visage inventé en gros plan. ' +
  'AUCUN texte dans la photo : ni enseigne, ni étiquette, ni panneau, ni lettrage ; seuls le titre et le ' +
  'sous-titre s\'écrivent.\n' +
  '   - "titre" : le titre affiché à la place de celui du gabarit, court (7 mots au plus), tiré du post.\n' +
  '   - "sous_titre" : la ligne sous le titre, qui complète (14 mots au plus), tirée du post.\n' +
  "   N'invente jamais un prix, une promotion, un horaire ou une info absente du post ou des règles du " +
  'gabarit. "commande" : vide, ou un détail indispensable dicté par les règles du gabarit.\n' +
  "   SANS gabarit : \"commande\" décrit l'image entière (cadrage, sujet, action, décor, lumière) dans " +
  "l'esprit des inspirations, avec AUCUN texte dans l'image et aucun personnage humain inventé ; " +
  'même exigence de variété ; "scene", "titre" et "sous_titre" restent vides.\n' +
  "Le générateur reçoit les images du gabarit choisi sans leur numéro : n'écris jamais « gabarit " +
  "N » ni « inspiration N » dans la commande. Un prix ne s'affiche que s'il figure dans le post. " +
  "Couleurs nommées en mots, jamais de code hexadécimal. Pas d'écran montrant une interface " +
  'inventée.\n\n' +
  'Réponds UNIQUEMENT avec ce JSON : {"gabarit": <numéro ou 0>, "inspirations": [<numéros>], ' +
  '"scene": "<texte>", "titre": "<texte>", "sous_titre": "<texte>", "commande": "<texte>"}';

interface Gabarit {
  id: string;
  nom: string;
  images: string[];
  note: string;
}

/**
 * « Valider et créer le visuel » : le visuel d'un post se crée tout seul, en arrière-plan, en
 * suivant l'identité du client. Claude voit ses gabarits de marque et ses inspirations, choisit le
 * gabarit qui colle au post et écrit la commande ; nano-banana la rend à partir des IMAGES du
 * gabarit. Le client est prévenu par une notification, et tout reste modifiable dans Contenus.
 *
 * L'état « en cours » vit en mémoire : une seule instance tourne aujourd'hui (voir la note Redis
 * avant de passer à plusieurs réplicas). Un redémarrage perd le suivi, pas le quota : il n'est
 * confirmé qu'à la fin.
 */
@Injectable()
export class VisuelAutoService {
  private readonly logger = new Logger(VisuelAutoService.name);
  /** contenuId -> telegramId des visuels en cours de création. */
  private readonly enCours = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly imageService: ImageService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly planningService: PlanningService,
    private readonly lateService: LateService,
    private readonly notificationService: NotificationService,
    private readonly demarrageService: DemarrageService,
  ) {}

  /** Contenus du compte dont le visuel est en cours de création. */
  enCoursPour(telegramId: string): string[] {
    return [...this.enCours]
      .filter(([, t]) => t === telegramId)
      .map(([id]) => id);
  }

  /** Vérifie la demande, réserve le quota et lance la création en arrière-plan. */
  async lancer(
    telegramId: string,
    contenuId: string,
  ): Promise<{ en_cours: true; modele: string }> {
    const c = await this.prisma.contenu.findFirst({
      where: { id: contenuId, telegram_id: telegramId },
      select: { id: true, type: true, contenu: true },
    });
    if (!c) throw new NotFoundException('Contenu introuvable.');
    if (c.type && !TYPES_IMAGE.has(c.type)) {
      throw new BadRequestException(
        'Ce format a son propre rendu : le visuel automatique ne concerne que les posts et les stories.',
      );
    }
    if (!(c.contenu || '').trim())
      throw new BadRequestException('Le post est vide.');
    if (this.enCours.has(contenuId))
      throw new ConflictException(
        'Le visuel de ce post est déjà en cours de création.',
      );
    await this.demarrageService.exigerProfil(telegramId);

    const gabarits = await this.gabarits(telegramId);
    // Avec un gabarit, le visuel porte du texte : le modèle HD est le seul à l'écrire sans faute
    // (même règle que le mode Template du dialogue visuel).
    const modele = gabarits.length ? 'nano3' : 'nano2';
    const q = await this.quotaService.consume(telegramId, imageAction(modele));
    if (!q.ok) throw refusQuota(q);

    this.enCours.set(contenuId, telegramId);
    void this.executer(telegramId, contenuId, modele, q, gabarits).finally(() =>
      this.enCours.delete(contenuId),
    );
    return { en_cours: true, modele };
  }

  /** Pose le visuel sur le contenu, fixe la date si besoin et, si le post est déjà validé, le
   * (re)programme sur Zernio. Partagé avec la génération manuelle (POST /agent/image). */
  async appliquerVisuel(
    telegramId: string,
    contenuId: string,
    lienVisuel: string,
    extra: Record<string, unknown> = {},
  ): Promise<{
    statut: string | null | undefined;
    date_publication: unknown;
    publish_status?: string;
  }> {
    const upd: Record<string, unknown> = { lien_visuel: lienVisuel, ...extra };
    // Le statut ne passe PAS à « Planifié » ici : seul l'event webhook post.scheduled le confirme
    // (source de vérité = Zernio).
    const cur = await this.prisma.contenu.findFirst({
      where: { id: contenuId, telegram_id: telegramId },
      select: {
        statut: true,
        reseau_cible: true,
        date_publication: true,
        type: true,
      },
    });
    // Un contenu « À valider » reste sans date : il prend son créneau à la validation
    const valide = ['Valider', 'Planifie', 'Pret_a_publier'].includes(String(cur?.statut));
    if (!cur?.date_publication && valide) {
      const creneau = await this.planningService.prochainCreneau(
        telegramId,
        cur?.reseau_cible,
        cur?.type,
        { valides: true },
      );
      if (creneau) upd.date_publication = creneau;
    }
    await this.prisma.contenu.updateMany({
      where: { id: contenuId, telegram_id: telegramId },
      data: upd,
    });
    // labelStatutContenu : Prisma renvoie le nom d'enum mappé (ex. "A_valider"), pas le libellé.
    const out: {
      statut: string | null | undefined;
      date_publication: unknown;
      publish_status?: string;
    } = {
      statut: labelStatutContenu(cur?.statut),
      date_publication: upd.date_publication || cur?.date_publication,
    };
    // Un brouillon « A valider » ne part JAMAIS vers Zernio : seul un contenu déjà validé ou déjà
    // planifié (on rafraîchit) est (re)programmé.
    if (
      (cur?.statut === 'Valider' || cur?.statut === 'Planifie') &&
      out.date_publication
    ) {
      try {
        const pub = await this.lateService.programmerContenu(
          telegramId,
          contenuId,
        );
        out.publish_status = pub.ok
          ? 'envoi'
          : pub.skipped
            ? 'ignoré'
            : 'échec';
      } catch (e) {
        this.logger.warn(
          `auto-programmation après visuel ${contenuId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return out;
  }

  private async gabarits(telegramId: string): Promise<Gabarit[]> {
    const rows = await this.prisma.brand_templates.findMany({
      where: { telegram_id: telegramId },
      select: { id: true, nom: true, images: true, note: true },
      orderBy: { created_at: 'desc' },
      take: MAX_GABARITS,
    });
    return rows
      .map((r) => ({
        id: r.id,
        nom: r.nom,
        images: (Array.isArray(r.images) ? r.images : []).filter(
          (u): u is string => typeof u === 'string' && !!u,
        ),
        note: r.note || '',
      }))
      .filter((g) => g.images.length);
  }

  private async executer(
    telegramId: string,
    contenuId: string,
    modele: string,
    q: QuotaResult,
    gabarits: Gabarit[],
  ): Promise<void> {
    let titre = '';
    try {
      const c = await this.prisma.contenu.findFirst({
        where: { id: contenuId, telegram_id: telegramId },
        select: { contenu: true, titre: true, type: true, reseau_cible: true },
      });
      if (!c) throw new Error('contenu supprimé entre-temps');
      titre = (c.titre || '').trim();
      const u = await this.marqueService.chargerMarque(telegramId);
      const inspirations =
        u.use_inspirations !== false
          ? (await this.imageService.inspirationsAvecRoles(telegramId)).slice(
              0,
              MAX_INSPIRATIONS,
            )
          : [];
      const styles = this.imageService.stylesImage();
      let style =
        typeof u.style_image === 'string' && u.style_image
          ? u.style_image
          : 'photo';
      if (style === 'auto')
        style = await this.imageService.choisirStyle(c.contenu || '');
      if (!(style in styles)) style = 'photo';
      const ratio = c.type === 'Story' ? '9:16' : '4:5';
      const recentes = await this.scenesRecentes(telegramId, contenuId);

      const depart = process.hrtime.bigint();
      const d = await this.direction(
        telegramId,
        u,
        c,
        gabarits,
        inspirations,
        styles[style].texte,
        recentes,
      );
      const gabarit = d.gabarit ? gabarits[d.gabarit - 1] : null;
      const choisies = d.inspirations
        .map((i) => inspirations[i - 1])
        .filter(Boolean);
      const modelId = IMAGE_MODELS[modele];

      const res = gabarit
        ? await this.imageService.genererDepuisGabarit(telegramId, {
            gabaritUrls: gabarit.images,
            note: gabarit.note,
            commande: d.scene ? d.commande === d.scene ? '' : d.commande : d.commande,
            scene: d.scene,
            titre: d.titre,
            sousTitre: d.sous_titre,
            integrateUrls: choisies
              .filter((i) => i.role === 'integrate')
              .map((i) => i.url),
            styleUrls: choisies
              .filter((i) => i.role === 'style')
              .map((i) => i.url),
            model: modelId,
            contenuId,
            ratio,
          })
        : await this.imageService.genererImage(
            telegramId,
            d.commande,
            false,
            modelId,
            contenuId,
            choisies.map((i) => i.url),
            null,
            false,
            ratio,
            choisies.filter((i) => i.role === 'integrate').map((i) => i.url),
            undefined,
            false,
            style,
            choisies.filter((i) => i.role === 'ecran').map((i) => i.url),
          );
      if ('error' in res) throw new Error(res.error);
      await this.quotaService.confirm(q);

      // prompt_image = la description de la photo : la scène (avec gabarit) ou la commande (sans).
      // Elle sert aussi de mémoire pour varier les visuels suivants (scenesRecentes).
      await this.appliquerVisuel(
        telegramId,
        contenuId,
        res.lien_visuel,
        gabarit
          ? d.scene
            ? { prompt_image: d.scene }
            : {}
          : { prompt_image: d.commande, style_image: style },
      );
      await this.usageService.log(
        telegramId,
        'image_auto',
        modelId || modele,
        {},
        q.unit_cost ?? 0,
        undefined,
        res.cout_usd ?? IMAGE_PRICES[modele] ?? 0.04,
        Number(process.hrtime.bigint() - depart) / 1e9,
      );
      this.logger.log(
        `visuel auto ${contenuId} : ${gabarit ? `gabarit « ${gabarit.nom} »` : 'sans gabarit'}, ${choisies.length} inspiration(s), scène : ${(d.scene || d.commande).slice(0, 120)}`,
      );
      await this.notificationService.notifierCle(
        telegramId,
        contenuId,
        c.reseau_cible,
        'visuel_pret',
        'visuelPret',
        { titre: titre || '—' },
      );
    } catch (e) {
      this.logger.warn(
        `visuel auto ${contenuId}: ${e instanceof Error ? e.message : e}`,
      );
      await this.quotaService.refund(q);
      await this.notificationService.notifierCle(
        telegramId,
        contenuId,
        null,
        'visuel_echec',
        'visuelEchec',
        { titre: titre || '—' },
      );
    }
  }

  /** Les scènes des derniers visuels du compte, pour ne pas refaire la même photo. */
  private async scenesRecentes(telegramId: string, contenuId: string): Promise<string[]> {
    const rows = await this.prisma.contenu
      .findMany({
        where: { telegram_id: telegramId, id: { not: contenuId }, prompt_image: { not: null } },
        select: { prompt_image: true },
        orderBy: { created_at: 'desc' },
        take: 8,
      })
      .catch(() => [] as Array<{ prompt_image: string | null }>);
    return rows.map((r) => (r.prompt_image || '').trim().slice(0, 240)).filter(Boolean);
  }

  /** Claude voit les gabarits et les inspirations, choisit et écrit la commande. */
  private async direction(
    telegramId: string,
    u: Record<string, unknown>,
    c: {
      contenu: string | null;
      reseau_cible: string | null;
      type: string | null;
    },
    gabarits: Gabarit[],
    inspirations: Array<{ url: string; role: string }>,
    styleTexte: string,
    recentes: string[] = [],
  ): Promise<Direction> {
    const langue = typeof u.langue === 'string' ? u.langue.toLowerCase() : 'fr';
    const blocs: Anthropic.Messages.ContentBlockParam[] = [];
    if (gabarits.length) {
      blocs.push({ type: 'text', text: 'GABARITS DE MARQUE du client :' });
      gabarits.forEach((g, i) => {
        blocs.push({
          type: 'image',
          source: { type: 'url', url: vignette(g.images[0], 512) },
        });
        blocs.push({
          type: 'text',
          text: `Gabarit ${i + 1} — « ${g.nom} »${g.note ? ` — règles : ${g.note.slice(0, 3000)}` : ''}`,
        });
      });
    } else {
      blocs.push({
        type: 'text',
        text: "Le client n'a aucun gabarit de marque : gabarit = 0.",
      });
    }
    if (inspirations.length) {
      blocs.push({ type: 'text', text: "IMAGES D'INSPIRATION du client :" });
      inspirations.forEach((insp, i) => {
        blocs.push({
          type: 'image',
          source: { type: 'url', url: vignette(insp.url, 512) },
        });
        const role =
          insp.role === 'integrate'
            ? 'à intégrer telle quelle'
            : insp.role === 'ecran'
              ? "capture d'écran réelle"
              : 'style';
        blocs.push({ type: 'text', text: `Inspiration ${i + 1} (${role})` });
      });
    }
    if (recentes.length) {
      blocs.push({
        type: 'text',
        text:
          'SCÈNES DÉJÀ UTILISÉES dans les derniers visuels (ne pas refaire, ni rien de proche) :\n' +
          recentes.map((s) => `- ${s}`).join('\n'),
      });
    }
    blocs.push({
      type: 'text',
      text:
        `Post à illustrer (réseau ${c.reseau_cible || '—'}${c.type === 'Story' ? ', story verticale' : ''}) :\n\n` +
        `${(c.contenu || '').slice(0, 4000)}\n\nDonne le JSON.`,
    });

    const contexte =
      `\n\nLANGUE de la commande et des textes affichés : ${LANGUES[langue] ?? 'français'}.` +
      `\nStyle d'image du client (si tu n'utilises pas de gabarit) : ${styleTexte}` +
      this.marqueService.contexteMarqueCourt(u, { ecriture: false });
    const resp = await this.claude.messagesCreate({
      model: MODELE_REDACTION,
      max_tokens: 900,
      system: ROLE_DIRECTION + contexte,
      messages: [{ role: 'user', content: blocs }],
    });
    await this.usageService.log(
      telegramId,
      'visuel_direction',
      MODELE_REDACTION,
      this.claude.usage(resp),
      0,
    );
    const d = lireDirection(
      this.claude.texte(resp),
      gabarits.length,
      inspirations.length,
    );
    if (!d) throw new Error('direction artistique illisible');
    return d;
  }
}
