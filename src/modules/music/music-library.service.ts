import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

/**
 * Bibliothèque musicale PARTAGÉE (Studio Vidéo Submagic ET reels Remotion) — port direct
 * de backend/services/music_library.py. Chaque piste est hébergée sur Cloudinary (preview
 * + source du mix Remotion) et pré-enregistrée chez Submagic (user_media_id). `category`
 * regroupe les pistes dans les sélecteurs ; "none" = pas de musique.
 */

export interface MusicTrack {
  id: string;
  label: string;
  category: string | null;
  user_media_id: string | null;
  url: string | null;
  debut_s?: number | null;
  duree_s?: number | null;
}

export const MUSIC_CATEGORIES = [
  { id: 'studio', label: 'Studio Motion' },
  { id: 'calme', label: 'Calme' },
  { id: 'optimiste', label: 'Optimiste' },
  { id: 'funky', label: 'Funky / Groove' },
  { id: 'epique', label: 'Épique' },
  { id: 'emotion', label: 'Émotion' },
  { id: 'country', label: 'Country' },
];

const MUS = 'https://res.cloudinary.com/dy9gp5pim/video/upload/submagic_music';

export const MUSIC_LIBRARY: MusicTrack[] = [
  { id: 'none', label: 'Aucune musique', category: null, user_media_id: null, url: null },
  { id: 'calme', label: 'Calme', category: 'calme', user_media_id: '638c9a7f-2cb9-41ff-bb99-fae4e0c73c1d', url: `${MUS}/calme.mp3` },
  { id: 'in-the-morning', label: 'In The Morning', category: 'calme', user_media_id: '16624be5-3758-4293-9291-92c3106f4c7d', url: `${MUS}/in-the-morning.mp3` },
  {
    id: 'visible-invisible',
    label: 'Make The Visible Invisible',
    category: 'calme',
    user_media_id: 'b9114ed4-d11e-4118-a3af-9a1049fa741e',
    url: `${MUS}/visible-invisible.mp3`,
  },
  { id: 'optimiste', label: 'Optimiste', category: 'optimiste', user_media_id: 'ac12a379-88a9-4c99-add1-f826a92c5cd8', url: `${MUS}/optimiste.mp3` },
  { id: 'butterfly', label: 'Butterfly', category: 'optimiste', user_media_id: '7c9a8720-84e2-407e-a062-2ca79a44997a', url: `${MUS}/butterfly.mp3` },
  { id: 'funky', label: 'Funky', category: 'funky', user_media_id: 'be0ae396-bed5-4f8a-b721-d741521c6371', url: `${MUS}/funky.mp3` },
  { id: 'claim-to-fame', label: 'Claim To Fame', category: 'funky', user_media_id: 'dce42cc3-510c-44f1-83d1-98949f7fa3d9', url: `${MUS}/claim-to-fame.mp3` },
  { id: 'drop-of-a-hat', label: 'Drop Of A Hat', category: 'funky', user_media_id: '3ca88017-c9b2-4320-977a-58968ba9d3b7', url: `${MUS}/drop-of-a-hat.mp3` },
  { id: 'frame-dragging', label: 'Frame-Dragging', category: 'epique', user_media_id: '8e8fd1f4-0ff6-47c8-9290-c35daf7f3004', url: `${MUS}/frame-dragging.mp3` },
  { id: 'level', label: 'Level', category: 'epique', user_media_id: '631d3eb3-21f2-401e-9f86-eac664866bf7', url: `${MUS}/level.mp3` },
  { id: 'dyin-breed', label: "A Dyin' Breed", category: 'emotion', user_media_id: 'ec851863-3887-43cd-a0f5-a4ea781caa30', url: `${MUS}/dyin-breed.mp3` },
  { id: 'missed-my-chance', label: 'Missed My Chance', category: 'emotion', user_media_id: '8a4ae600-4586-4926-85ae-a7dd16c7ba23', url: `${MUS}/missed-my-chance.mp3` },
  { id: 'triste', label: 'Triste', category: 'emotion', user_media_id: '0cfc6fdf-a29e-4f49-8d74-e821b29d2b7a', url: `${MUS}/triste.mp3` },
  { id: 'country', label: 'Country', category: 'country', user_media_id: '96d986ed-e831-4f5c-b0fc-7f360eeb2e85', url: `${MUS}/country.mp3` },
  // Pistes « Studio Motion » (pack MIT huashu-design), enregistrées chez Submagic le
  // 14/08/2026 -> disponibles dans les DEUX studios.
  { id: 'studio-pub', label: 'Pub énergique', category: 'studio', user_media_id: 'f010a5ac-f4b4-4fd8-983a-a60c2b162b3c', url: `${MUS}/bgm-ad.mp3` },
  { id: 'studio-tech', label: 'Tech', category: 'studio', user_media_id: '2b2797b3-b838-4d62-8d58-579b9f1e15f6', url: `${MUS}/bgm-tech.mp3` },
  { id: 'studio-edu', label: 'Éducatif', category: 'studio', user_media_id: 'b69d530c-0602-4693-ab85-7d8122b8b760', url: `${MUS}/bgm-educational.mp3` },
  { id: 'studio-edu-2', label: 'Éducatif II', category: 'studio', user_media_id: 'ed2f60ff-aa30-4a38-9629-b5006aa66a5e', url: `${MUS}/bgm-educational-alt.mp3` },
  { id: 'studio-tuto', label: 'Tutoriel', category: 'studio', user_media_id: '02979dd6-2a18-4729-9d3f-42ba25a9c01d', url: `${MUS}/bgm-tutorial.mp3` },
  { id: 'studio-tuto-2', label: 'Tutoriel II', category: 'studio', user_media_id: '86e67102-210d-4085-9af9-19d235caeb1a', url: `${MUS}/bgm-tutorial-alt.mp3` },
];

export const MAX_MUSIQUES = 12; // par compte — garde-fou de stockage
export const TAILLE_MAX_MO = 15;

@Injectable()
export class MusicLibraryService {
  private readonly logger = new Logger(MusicLibraryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Les MP3 importés par le client, présentés comme la bibliothèque partagée.
   * `debut_s`/`duree_s` : passage retenu par le client (voir decouper()). */
  async musiquesDuCompte(telegramId: string): Promise<MusicTrack[]> {
    try {
      const rows = await this.prisma.brand_musiques.findMany({
        where: { telegram_id: telegramId },
        select: { id: true, url: true, label: true, debut_s: true, duree_s: true, created_at: true },
        orderBy: { created_at: 'desc' },
      });
      return rows.map((m) => ({
        id: m.id,
        label: m.label,
        category: 'perso',
        user_media_id: null,
        url: m.url,
        debut_s: m.debut_s == null ? null : Number(m.debut_s),
        duree_s: m.duree_s == null ? null : Number(m.duree_s),
      }));
    } catch (e) {
      this.logger.error(`musiques du compte ${telegramId}: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Enregistre le passage retenu d'une musique importée. Les deux à null = piste entière. */
  async decouper(telegramId: string, musiqueId: string, debutS?: number | null, dureeS?: number | null): Promise<MusicTrack | { error: string }> {
    const borne = (v: number | null | undefined, mini = 0): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : Math.max(mini, Math.round(n * 100) / 100);
    };
    const d = borne(debutS);
    const du = borne(dureeS, 0.5);
    try {
      const res = await this.prisma.brand_musiques.updateMany({
        where: { id: musiqueId, telegram_id: telegramId },
        data: { debut_s: d, duree_s: du },
      });
      if (!res.count) return { error: 'Musique introuvable.' };
      const m = await this.prisma.brand_musiques.findUnique({ where: { id: musiqueId } });
      if (!m) return { error: 'Musique introuvable.' };
      return { id: m.id, label: m.label, url: m.url, category: 'perso', user_media_id: null, debut_s: d, duree_s: du };
    } catch (e) {
      this.logger.error(`decoupage musique ${musiqueId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Découpage impossible.' };
    }
  }

  /** [catégories, pistes] — la bibliothèque partagée + les MP3 du client en tête. */
  async bibliotheque(telegramId?: string): Promise<[Array<{ id: string; label: string }>, MusicTrack[]]> {
    const perso = telegramId ? await this.musiquesDuCompte(telegramId) : [];
    const cats = [...(perso.length ? [{ id: 'perso', label: 'Mes musiques' }] : []), ...MUSIC_CATEGORIES];
    return [cats, [...perso, ...MUSIC_LIBRARY]];
  }

  /** Version allégée d'une piste pour le rendu Remotion (ré-encodée 128kbps, coupée au
   * passage retenu par le client). Le fichier d'origine n'est pas touché. */
  pourRendu(url: string | null | undefined, debutS?: number | null, dureeS?: number | null): string | null {
    if (!url || !url.includes('res.cloudinary.com') || !url.includes('/upload/')) return url ?? null;
    const [base, , finRaw] = url.includes('/upload/') ? [url.split('/upload/')[0], '', url.split('/upload/')[1]] : [url, '', ''];
    let fin = finRaw;
    if (fin.startsWith('ac_') || fin.startsWith('so_')) return url; // déjà transformée
    if (fin.startsWith('q_auto/')) fin = fin.slice('q_auto/'.length);
    let coupe = '';
    if (debutS !== null && debutS !== undefined && debutS !== 0) coupe += `so_${debutS},`;
    if (dureeS !== null && dureeS !== undefined) coupe += `du_${dureeS},`;
    return `${base}/upload/${coupe}ac_mp3,br_128k/${fin}`;
  }

  /** URL d'une piste, qu'elle vienne de la bibliothèque partagée ou du client. `rendu=true` :
   * version allégée, limitée au passage retenu par le client. */
  async urlDe(musicId: string | null | undefined, telegramId?: string, rendu = false): Promise<string | null> {
    const u = this.musiqueUrl(musicId);
    if (u) return rendu ? this.pourRendu(u) : u;
    if (!musicId || !telegramId) return null;
    const m = (await this.musiquesDuCompte(telegramId)).find((x) => x.id === musicId);
    if (!m) return null;
    return rendu ? this.pourRendu(m.url, m.debut_s, m.duree_s) : m.url;
  }

  /** La piste correspondant à l'id, ou null (inclut l'entrée « none » : url null). */
  piste(musicId: string | null | undefined): MusicTrack | null {
    if (!musicId) return null;
    return MUSIC_LIBRARY.find((m) => m.id === musicId) ?? null;
  }

  /** URL Cloudinary de la piste, ou null si inconnue / « none ». */
  musiqueUrl(musicId: string | null | undefined): string | null {
    return this.piste(musicId)?.url ?? null;
  }
}
