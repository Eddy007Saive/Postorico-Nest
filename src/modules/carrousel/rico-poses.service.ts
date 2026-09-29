import { Injectable, Logger } from '@nestjs/common';
import { ClaudeService } from '../claude/claude.service';

/**
 * Les poses de Rico, la mascotte de Postorico — port direct de
 * backend/services/rico_poses.py. Réservé aux gabarits maison
 * (« Rico Studio », « Rico Scène »).
 */

// rico-v4 : chemin neuf à chaque planche (cache CDN d'un an, jamais réécrit au même id).
// e_upscale (super-résolution IA) + e_background_removal (fond transparent réel) + f_png
// (fige le format, le Chromium headless qui rend nos carrousels ne négocie pas l'Accept).
const BASE =
  'https://res.cloudinary.com/dy9gp5pim/image/upload/e_upscale/e_background_removal/e_sharpen:30,q_auto:best,f_png/brand/rico-v4';

// id -> ce que la pose RACONTE (intention, pas anatomie) : lu par l'IA pour caster chaque slide.
export const POSES: Record<string, string> = {
  accueille: 'ailes grandes ouvertes, accueillant — une ouverture, une bienvenue, une bonne nouvelle',
  'pouce-leve': 'deux pouces levés — une validation, un résultat obtenu, une recommandation',
  annonce: "gros plan, les deux mains qui désignent, bouche grande ouverte — une annonce forte, le chiffre qui claque",
  'clin-oeil': "un clin d'œil en désignant du doigt — la complicité, l'astuce, le raccourci qu'on partage",
  idee: 'index levé — une idée, un point clé, la chose à retenir',
  'pointe-haut': "pointe vers le haut, l'autre aile croisée — ce qui monte, une tendance, un objectif",
  'presente-cote': 'présente sur le côté, main ouverte, souriant — introduit une idée, montre une direction',
  'presente-produit': 'présente quelque chose de la main, enthousiaste — met en avant un outil, une offre',
  'presente-calme': 'présente d\'un geste posé — une explication tranquille, un constat',
  'de-dos': "vu de dos, il se retourne — ce qu'on laisse derrière, l'avant/après, le changement de cap",
  curieux: 'penché, il regarde entre ses pattes — la recherche, le détail qu\'on ne voit pas, une note d\'humour',
};

export const DEFAUT = 'presente-cote';

const ROLE =
  'You cast a mascot in a social-media carousel. For EACH slide, pick the pose whose ' +
  'INTENTION matches what the slide says — a problem calls for the questioning pose, a ' +
  'result for the celebrating one, a figure for the data one.\n' +
  'Rules: never repeat the same pose on two consecutive slides; the cover should welcome ' +
  'or present; the final call-to-action should celebrate, approve or point. Use only the ' +
  'ids provided. Answer with STRICT JSON only: {"poses": ["id", "id", …]} — exactly ' +
  'one id per slide, in order.';

@Injectable()
export class RicoPosesService {
  private readonly logger = new Logger(RicoPosesService.name);

  constructor(private readonly claude: ClaudeService) {}

  /** URL Cloudinary d'une pose (retombe sur la pose neutre si l'id est inconnu). */
  url(poseId: string): string {
    return `${BASE}/${poseId in POSES ? poseId : DEFAUT}.png`;
  }

  /** Une pose par slide (couverture, étapes, CTA). Retombe sur une rotation fixe si
   * l'appel échoue : mieux vaut varier bêtement que répéter. */
  async choisir(
    hook: string,
    slides: Array<{ titre?: string; texte?: string }>,
    ctaTitre: string,
  ): Promise<string[]> {
    const textes = [`1. Couverture : ${hook}`];
    slides.forEach((sl, i) => {
      textes.push(`${i + 2}. ${sl.titre || ''} — ${(sl.texte || '').slice(0, 160)}`);
    });
    textes.push(`${slides.length + 2}. Appel à l'action : ${ctaTitre}`);
    const n = textes.length;

    const catalogue = Object.entries(POSES)
      .map(([k, v]) => `- ${k} : ${v}`)
      .join('\n');
    try {
      const resp = await this.claude.messagesCreate({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system: ROLE,
        messages: [
          {
            role: 'user',
            content: `Poses disponibles :\n${catalogue}\n\nLes ${n} slides :\n${textes.join('\n')}\n\nDonne exactement ${n} ids.`,
          },
        ],
      });
      const brut = this.claude.texte(resp);
      const m = brut.match(/\{[\s\S]*\}/);
      const parsed: unknown = JSON.parse(m ? m[0] : brut);
      const poses = Array.isArray((parsed as { poses?: unknown[] })?.poses)
        ? ((parsed as { poses: unknown[] }).poses.filter((p) => typeof p === 'string' && p in POSES) as string[])
        : [];
      if (poses.length >= n) return this.sansRepetition(poses.slice(0, n));
      this.logger.warn(`poses Rico : ${poses.length} choix pour ${n} slides — repli`);
    } catch (e) {
      this.logger.warn(`choix des poses Rico: ${e instanceof Error ? e.message : e}`);
    }
    // Repli : une rotation qui suit la dramaturgie d'un carrousel
    const rotation = [
      'presente-cote', 'idee', 'presente-calme', 'pointe-haut',
      'clin-oeil', 'presente-produit', 'annonce', 'de-dos',
    ];
    // NB : "celebre" n'est pas une pose du catalogue — comme côté Python, url() retombe
    // alors sur DEFAUT pour la dernière slide (repli déjà tolérant, gardé identique).
    const out = Array.from({ length: n - 1 }, (_, i) => rotation[i % rotation.length]);
    out.push('celebre');
    return this.sansRepetition(out);
  }

  /** Deux slides voisines ne montrent jamais la même pose. */
  private sansRepetition(poses: string[]): string[] {
    const dispo = Object.keys(POSES);
    const out: string[] = [];
    for (let p of poses) {
      if (out.length && p === out[out.length - 1]) {
        p = dispo.find((x) => x !== out[out.length - 1] && !out.includes(x)) ?? DEFAUT;
      }
      out.push(p);
    }
    return out;
  }
}
