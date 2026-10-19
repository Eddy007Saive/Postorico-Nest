import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService, MODELE_REDACTION } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { MontagePocService } from './montage-poc.service';

/** Longueur visée de la description par réseau (le texte publié au-dessus de la vidéo). */
const CONSIGNE_RESEAU: Record<string, string> = {
  instagram: 'Instagram Reel caption: 3 to 6 short lines, a strong first line (the hook shown before "more"), 3 to 5 relevant hashtags at the end.',
  tiktok: 'TikTok caption: 1 to 3 short lines, punchy, 3 to 5 relevant hashtags at the end.',
  facebook: 'Facebook video post: 3 to 6 short lines, conversational, 0 to 2 hashtags.',
  linkedin: 'LinkedIn video post: 4 to 8 short lines, professional and concrete, a question or call to action at the end, 0 to 3 hashtags.',
  youtube: 'YouTube Shorts description: 2 to 4 short lines, 2 to 3 relevant hashtags at the end.',
};

type Contenu = {
  id: string;
  titre: string | null;
  contenu: string | null;
  script: string | null;
  reseau_cible: string | null;
  video_url: string | null;
  submagic_project_id: string | null;
  reel_data: unknown;
};

/**
 * « Générer la description » d'une vidéo montée : ce que dit la vidéo (transcription,
 * sous-titres, textes à l'écran ou script, selon le parcours qui l'a produite) + la fiche
 * de marque -> une description prête à publier, dans la langue du compte. Rien n'est
 * enregistré ici : le client la relit et la valide dans Contenus.
 */
@Injectable()
export class DescriptionVideoService {
  private readonly logger = new Logger(DescriptionVideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marque: MarqueService,
    private readonly montagePoc: MontagePocService,
  ) {}

  async generer(telegramId: string, contenuId: string): Promise<{ texte: string }> {
    const c = (await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } })) as Contenu | null;
    if (!c) throw new Error('not_found');
    if (!c.video_url) throw new Error('pas_de_video');

    const matiere = await this.matiere(telegramId, c);
    if (!matiere.trim() && !c.titre) throw new Error('rien_a_decrire');

    const u = await this.marque.chargerMarque(telegramId);
    const reseau = String(c.reseau_cible || 'instagram').toLowerCase().replace(/\s+/g, '');
    const consigne =
      `Write the text published with this short video on ${c.reseau_cible || 'Instagram'}, in ${this.marque.langueSortie(u)}. ` +
      `${CONSIGNE_RESEAU[reseau] || CONSIGNE_RESEAU.instagram} ` +
      'Base it ONLY on what the video says and shows (below): do not invent facts, numbers, offers or promises. ' +
      'Do not describe the video ("in this video…"): speak to the viewer, as the brand. No title, no quotation marks, ' +
      'no markdown. Output only the text to publish.' +
      (c.titre ? `\nVideo title: ${c.titre}` : '') +
      (matiere.trim() ? `\n<video_content>\n${matiere.trim().slice(0, 6000)}\n</video_content>` : '') +
      this.marque.contexteMarqueCourt(u, { ctas: true }) +
      this.marque.consigneLangueFinale(u);
    const rep = await this.claude.messagesCreate({
      model: MODELE_REDACTION,
      max_tokens: 700,
      messages: [{ role: 'user', content: consigne }],
    });
    const texte = this.claude.texte(rep).trim().replace(/^["«]\s*|\s*["»]$/g, '');
    if (!texte) throw new Error('vide');
    return { texte: texte.slice(0, 2200) };
  }

  /** Ce que dit la vidéo, de la source la plus fidèle à la moins fidèle. La transcription
   * Whisper de la vidéo finale ne sert qu'en dernier recours (lente, ~1 min). */
  private async matiere(telegramId: string, c: Contenu): Promise<string> {
    const morceaux: string[] = [];
    const rd = (c.reel_data && typeof c.reel_data === 'object' ? c.reel_data : {}) as Record<string, unknown>;

    // Studio Vidéo (face caméra) : la transcription du montage.
    if (c.submagic_project_id) {
      try {
        const d = await this.montagePoc.getTranscript(c.submagic_project_id);
        const mots = (d.ok ? (d.words as Array<{ text?: string; word?: string }>) : []) || [];
        const t = mots.map((w) => String(w.text ?? w.word ?? '').trim()).filter(Boolean).join(' ');
        if (t) morceaux.push(`Spoken words:\n${t}`);
      } catch (e) {
        this.logger.warn(`transcription montage ${c.id}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Éditeur manuel : sous-titres et textes posés sur la timeline, + le post d'origine.
    const m = await this.prisma.montages.findFirst({
      where: { contenu_id: c.id, telegram_id: telegramId },
      orderBy: { updated_at: 'desc' },
      select: { projet: true, projet_rendu: true, source_contenu_id: true },
    });
    if (m) {
      const projet = ((m.projet_rendu || m.projet) as { elements?: Array<{ type?: string; texte?: string; debut?: number }> }) || {};
      const els = (projet.elements || []).filter((e) => (e.type === 'soustitre' || e.type === 'texte') && e.texte);
      els.sort((a, b) => (a.debut || 0) - (b.debut || 0));
      const sous = els.filter((e) => e.type === 'soustitre').map((e) => e.texte!.trim()).join(' ');
      const ecran = els.filter((e) => e.type === 'texte').map((e) => e.texte!.trim()).join('\n');
      if (sous) morceaux.push(`Spoken words (subtitles):\n${sous}`);
      if (ecran) morceaux.push(`On-screen text:\n${ecran}`);
      if (m.source_contenu_id) {
        const src = await this.prisma.contenu.findFirst({
          where: { id: m.source_contenu_id, telegram_id: telegramId },
          select: { contenu: true },
        });
        if (src?.contenu?.trim()) morceaux.push(`Original post this video comes from:\n${src.contenu.trim()}`);
      }
    }

    // Studio Reel : textes des plans ; montage par l'IA : son résumé.
    const segments = (rd.segments as Array<{ texte?: string }> | undefined) || [];
    const txtSeg = segments.map((s) => String(s.texte || '').trim()).filter(Boolean).join('\n');
    if (txtSeg) morceaux.push(`On-screen text:\n${txtSeg}`);
    const resume = (rd.agent as { resume?: string } | undefined)?.resume;
    if (resume) morceaux.push(`Summary of the edit:\n${resume}`);

    // Script (vidéo animée, script de reel tourné face caméra).
    if (c.script?.trim()) morceaux.push(`Script:\n${c.script.trim()}`);

    if (morceaux.length) return morceaux.join('\n\n');

    // Rien de tout ça (import direct…) : on écoute la vidéo finale.
    if (c.video_url) {
      const r = await this.montagePoc.transcrireUrl(c.video_url, 150);
      const t = (r.words || []).map((w) => String(w.text || '').trim()).filter(Boolean).join(' ');
      if (t) return `Spoken words:\n${t}`;
    }
    return '';
  }
}
