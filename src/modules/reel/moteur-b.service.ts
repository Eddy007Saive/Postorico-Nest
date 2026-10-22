import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';
import { NotificationService } from '../notifications/notification.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';

const SUIVI_MS = 20_000;
/** Au-delà, une tâche toujours « en cours » est tenue pour perdue (le moteur B garde ses tâches en mémoire). */
const ABANDON_MS = 30 * 60_000;
const ACTION_QUOTA = 'reel';
const VOIX: Record<string, string> = {
  fr: 'fr-FR-DeniseNeural-Female',
  en: 'en-US-JennyNeural-Female',
  es: 'es-ES-ElviraNeural-Female',
};
const LANGUES: Record<string, string> = { fr: 'French', en: 'English', es: 'Spanish' };

interface TacheMoteurB {
  state?: number;
  progress?: number;
  videos?: string[];
}

/**
 * Moteur B (test A/B) : MoneyPrinterTurbo, installé sur le VPS derrière un proxy à clé.
 * Postorico écrit le script et les mots-clés (Claude, voix de la marque) ; le moteur B cherche
 * les plans (Pexels), fait la voix (Edge TTS), les sous-titres et l'assemblage. Le reel arrive
 * dans Contenus comme les autres, marqué reel_data.moteur = 'b' pour la comparaison.
 *
 * Réservé aux comptes listés dans MOTEUR_B_COMPTES. Suivi par interrogation toutes les 20 s
 * (même principe que l'agent de montage) : ready -> vidéo copiée sur Cloudinary ; échec ou
 * tâche perdue -> echec + quota rendu.
 */
@Injectable()
export class MoteurBService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MoteurBService.name);
  private readonly url: string;
  private readonly cle: string;
  private readonly comptes: Set<string>;
  private suiviEnCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    private readonly quota: QuotaService,
    private readonly notifications: NotificationService,
    private readonly planningService: PlanningService,
    config: ConfigService,
  ) {
    this.url = config.get<string>('app.moteurBUrl') || '';
    this.cle = config.get<string>('app.moteurBCle') || '';
    this.comptes = new Set(config.get<string[]>('app.moteurBComptes') || []);
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  get actif(): boolean {
    return Boolean(this.url && this.cle && this.comptes.size);
  }

  autorise(telegramId: string): boolean {
    return this.actif && this.comptes.has(telegramId);
  }

  onApplicationBootstrap(): void {
    if (!this.actif) {
      this.logger.log('Moteur B (test) désactivé (MOTEUR_B_URL / MOTEUR_B_CLE / MOTEUR_B_COMPTES absents)');
      return;
    }
    setInterval(() => void this.suivre(), SUIVI_MS);
  }

  private moteur(chemin: string, init: RequestInit = {}, delaiMs = 20_000): Promise<Response> {
    return fetch(`${this.url}${chemin}`, {
      ...init,
      headers: { 'X-Cle-Moteur': this.cle, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(delaiMs),
    });
  }

  /** Script parlé (langue du compte, voix de la marque) + mots-clés de plans en anglais. */
  async ecrireScript(u: Record<string, unknown>, texte: string): Promise<{ script: string; termes: string[]; titre: string }> {
    const code = String(u.langue || 'fr').toLowerCase();
    const langue = LANGUES[code] || 'French';
    const resp = await this.claude.messagesCreate({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      system:
        `You write the voice-over of a 30 to 45 second vertical social video for a small business owner, in ${langue.toUpperCase()}. ` +
        'Spoken, natural, first person when it fits; 70 to 110 words; the first sentence is a hook; end with a short call to action. ' +
        'No emoji, no hashtags, no stage directions, no quotes. Also give 6 short stock-footage search terms IN ENGLISH ' +
        '(2 to 4 plain words, concrete and filmable, in the order of the script) and a short title (max 8 words, same language as the script). ' +
        'Return STRICT JSON: {"script": "...", "termes": ["...", "..."], "titre": "..."}' +
        this.marqueService.contexteMarqueCourt(u, { ctas: true }),
      messages: [{ role: 'user', content: texte.slice(0, 4000) }],
    });
    const raw = this.claude.texte(resp);
    let d: Record<string, unknown> = {};
    try {
      const m = /\{[\s\S]*\}/.exec(raw);
      d = JSON.parse(m ? m[0] : raw);
    } catch {
      d = {};
    }
    const script = String(d.script || '').trim().slice(0, 1500);
    if (!script) throw new Error('script vide');
    const termes = (Array.isArray(d.termes) ? d.termes : []).map((t) => String(t).trim().slice(0, 50)).filter(Boolean).slice(0, 8);
    return { script, termes, titre: String(d.titre || '').trim().slice(0, 80) };
  }

  /** Lance un reel moteur B depuis un contenu (son texte) ou un brief libre. */
  async lancer(
    telegramId: string,
    opts: { contenuId?: string | null; brief?: string | null; reseau?: string | null },
  ): Promise<{ id: string; video_status: string } | { error: string; status?: number }> {
    if (!this.autorise(telegramId)) return { error: "Le moteur B n'est pas activé pour ce compte.", status: 403 };
    let texte = (opts.brief || '').trim();
    let reseau = opts.reseau || 'Instagram';
    if (opts.contenuId) {
      const cur = await this.prisma.contenu.findFirst({ where: { id: opts.contenuId, telegram_id: telegramId } });
      if (!cur) return { error: 'Contenu introuvable.', status: 404 };
      texte = [texte, cur.contenu || cur.script || cur.titre || ''].filter(Boolean).join('\n\n');
      reseau = (cur.reseau_cible as string) || reseau;
    }
    if (!texte.trim()) return { error: 'Donne un sujet ou choisis un contenu.', status: 400 };

    const q = await this.quota.consume(telegramId, ACTION_QUOTA);
    if (!q.ok) return { error: q.message || 'Quota de reels atteint.', status: 402 };
    let id: string | null = null;
    try {
      const u = await this.marqueService.chargerMarque(telegramId);
      const { script, termes, titre } = await this.ecrireScript(u, texte);
      const code = String(u.langue || 'fr').toLowerCase();
      const r = await this.moteur('/api/v1/videos', {
        method: 'POST',
        body: JSON.stringify({
          video_subject: titre || texte.slice(0, 80),
          video_script: script,
          video_terms: termes.length ? termes : undefined,
          video_aspect: '9:16',
          video_source: 'pexels',
          video_concat_mode: 'sequential',
          video_clip_duration: 3,
          video_count: 1,
          voice_name: VOIX[code] || VOIX.fr,
          voice_rate: 1.0,
          bgm_type: '',
          subtitle_enabled: true,
          subtitle_position: 'bottom',
          font_name: 'BeVietnamPro-Bold.ttf',
          font_size: 64,
          text_fore_color: '#FFFFFF',
          stroke_color: '#000000',
          stroke_width: 2,
          n_threads: 2,
        }),
      });
      const corps = (await r.json().catch(() => ({}))) as { data?: { task_id?: string }; message?: string };
      const tache = corps.data?.task_id;
      if (!r.ok || !tache) throw new Error(`moteur B ${r.status} ${corps.message || ''}`.trim());

      const creneau = await this.planningService.prochainCreneau(telegramId, reseau, 'Reel');
      const ins = await this.prisma.contenu.create({
        data: {
          telegram_id: telegramId,
          titre: titre || texte.slice(0, 60),
          contenu: script,
          type: normTypeContenu('Reel'),
          reseau_cible: reseau,
          statut: normStatutContenu('A valider'),
          video_status: 'en_traitement',
          ...(creneau ? { date_publication: creneau } : {}),
          reel_data: { moteur: 'b', tache, termes, source_contenu_id: opts.contenuId || null } as never,
          created_at: new Date(),
        } as never,
      });
      id = ins.id;
      await this.quota.confirm(q);
      return { id, video_status: 'en_traitement' };
    } catch (e) {
      await this.quota.refund(q);
      this.logger.error(`moteur B lancement ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Le moteur B est indisponible pour le moment. Réessaie.', status: 502 };
    }
  }

  /** Une passe de suivi : termine, échoue ou laisse en cours chaque reel moteur B. */
  async suivre(maintenant = new Date()): Promise<void> {
    if (this.suiviEnCours) return;
    this.suiviEnCours = true;
    try {
      const enCours = await this.prisma.contenu.findMany({
        where: { video_status: 'en_traitement', reel_data: { path: ['moteur'], equals: 'b' } } as never,
        select: { id: true, telegram_id: true, reseau_cible: true, reel_data: true, created_at: true },
        take: 20,
      });
      for (const c of enCours) {
        const rd = (c.reel_data || {}) as Record<string, unknown>;
        const tache = String(rd.tache || '');
        const age = maintenant.getTime() - new Date(c.created_at as Date).getTime();
        try {
          const r = await this.moteur(`/api/v1/tasks/${encodeURIComponent(tache)}`);
          if (r.status === 404) {
            await this.echouer(c, 'tâche introuvable (moteur B redémarré ?)');
            continue;
          }
          const corps = (await r.json()) as { data?: TacheMoteurB };
          const t = corps.data || {};
          if (t.state === 1 && t.videos?.length) await this.terminer(c, t.videos[0]);
          else if (t.state === -1) await this.echouer(c, 'rendu en échec');
          else if (age > ABANDON_MS) await this.echouer(c, 'trop long');
        } catch (e) {
          if (age > ABANDON_MS) await this.echouer(c, 'moteur B injoignable');
          else this.logger.warn(`moteur B suivi ${c.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      this.suiviEnCours = false;
    }
  }

  /** Copie la vidéo du moteur B sur Cloudinary et passe le reel en ready. */
  private async terminer(
    c: { id: string; telegram_id: string | null; reseau_cible: unknown; reel_data: unknown },
    lien: string,
  ): Promise<void> {
    // Le lien rendu par le moteur B pointe vers lui-même : on passe par notre adresse (et la clé).
    const chemin = lien.replace(/^https?:\/\/[^/]+/, '');
    const r = await this.moteur(chemin, { method: 'GET' }, 120_000);
    if (!r.ok) throw new Error(`téléchargement ${r.status}`);
    const octets = Buffer.from(await r.arrayBuffer());
    const video = await new Promise<{ secure_url: string }>((ok, ko) => {
      cloudinary.uploader
        .upload_stream({ resource_type: 'video', public_id: `reels/${c.telegram_id}/${c.id}`, overwrite: true, invalidate: true }, (err, res) =>
          err || !res ? ko(err || new Error('upload vide')) : ok(res as { secure_url: string }),
        )
        .end(octets);
    });
    const apercu = video.secure_url.replace('/upload/', '/upload/so_1/').replace(/\.mp4$/, '.jpg');
    await this.prisma.contenu.update({
      where: { id: c.id },
      data: {
        video_url: video.secure_url,
        video_preview_url: apercu,
        lien_visuel: apercu,
        video_status: 'ready',
        reel_data: { ...((c.reel_data as Record<string, unknown>) || {}), statut_moteur: 'termine' } as never,
      },
    });
    await this.notifications.notifierCle(c.telegram_id, c.id, c.reseau_cible as string | null, 'reel.ready', 'reelPret');
  }

  private async echouer(
    c: { id: string; telegram_id: string | null; reseau_cible: unknown; reel_data: unknown },
    motif: string,
  ): Promise<void> {
    this.logger.warn(`moteur B ${c.id} en échec : ${motif}`);
    await this.prisma.contenu.update({
      where: { id: c.id },
      data: {
        video_status: 'echec',
        reel_data: { ...((c.reel_data as Record<string, unknown>) || {}), statut_moteur: 'echec', erreur: motif } as never,
      },
    });
    await this.notifications.notifierCle(c.telegram_id, c.id, c.reseau_cible as string | null, 'reel.echec', 'reelEchec');
    if (c.telegram_id) await this.quota.refundByUser(c.telegram_id, ACTION_QUOTA);
  }
}
