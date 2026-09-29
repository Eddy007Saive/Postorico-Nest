import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { normStatutContenu, normTypeContenu } from '../../common/utils/contenu-enum.util';
import { BanqueService } from '../banque/banque.service';
import { MontagePocService } from '../video/montage-poc.service';
import { MusicLibraryService } from '../music/music-library.service';
import { QuotaService } from '../quota/quota.service';
import { RenderQueueService } from '../render-queue/render-queue.service';
import { VoixClientError, VoixService } from '../voix/voix.service';

/**
 * Éditeur vidéo manuel (façon CapCut) : projets de montage — port direct de
 * backend/services/editeur_service.py. Un projet est un JSON (schéma :
 * backend/remotion/src/montage/schema.js) que le navigateur prévisualise avec
 * @remotion/player et que le worker de rendu passe tel quel à la composition Remotion
 * « Montage ». Ce service ne connaît que la table `montages`, les médias mobilisables
 * (banque, vidéos du compte, musiques) et le départ d'un rendu ; le rendu lui-même est
 * fait par RenderQueueService.
 */

const TYPES_PISTE = new Set(['texte', 'soustitres', 'image', 'video', 'audio']);
const TYPES_ELEMENT = new Set(['texte', 'soustitre', 'image', 'video', 'audio']);
const MAX_ELEMENTS = 300;
const MAX_DUREE_S = 600.0;
const URL_OK = /^https:\/\//i;
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
const MAX_AUDIO_MO = 25;

export const INTENSITES_SILENCE: Record<string, [number, number]> = {
  naturel: [0.4, 0.22],
  rythme: [0.25, 0.15],
  serre: [0.12, 0.08],
};

export interface ProjetPiste {
  id: string;
  type: string;
  nom: string;
  muet: boolean;
  verrou: boolean;
}

export interface ProjetElement {
  id: string;
  piste: string;
  type: string;
  debut: number;
  duree: number;
  opacite?: number;
  src?: string;
  decalage?: number;
  volume?: number;
  vitesse?: number;
  fonduSortie?: number;
  cadre?: { x: number; y: number; w: number; h: number };
  rotation?: number;
  ajustement?: string;
  rayon?: number;
  animation?: string;
  recadre?: { zoom: number; x: number; y: number };
  transition?: { type: string; duree: number };
  texte?: string;
  mots?: Array<{ t: number; d: number; texte: string }>;
  style?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Projet {
  version: number;
  largeur: number;
  hauteur: number;
  fps: number;
  fond: string;
  pistes: ProjetPiste[];
  elements: ProjetElement[];
  soustitres: { style: Record<string, unknown> };
  couverture?: number;
}

function nombre(v: unknown, defaut = 0, mini?: number, maxi?: number): number {
  let x = typeof v === 'number' ? v : parseFloat(String(v));
  if (Number.isNaN(x)) x = defaut;
  if (mini !== undefined) x = Math.max(mini, x);
  if (maxi !== undefined) x = Math.min(maxi, x);
  return x;
}

/** Même forme que schema.projetVide() côté navigateur (source de vérité : le JS). */
export function projetVide(): Projet {
  return {
    version: 1,
    largeur: 1080,
    hauteur: 1920,
    fps: 30,
    fond: '#020617',
    pistes: [
      { id: 'p-texte', type: 'texte', nom: 'Textes', muet: false, verrou: false },
      { id: 'p-soustitres', type: 'soustitres', nom: 'Sous-titres', muet: false, verrou: false },
      { id: 'p-image', type: 'image', nom: 'Images', muet: false, verrou: false },
      { id: 'p-video', type: 'video', nom: 'Vidéo', muet: false, verrou: false },
      { id: 'p-audio', type: 'audio', nom: 'Audio', muet: false, verrou: false },
    ],
    elements: [],
    soustitres: { style: {} },
  };
}

/** Rend le projet sûr pour le rendu : types connus, nombres bornés, URLs https, éléments
 * orphelins rattachés à la piste de leur type. Ne lève pas : ce qui est inconnu est retiré,
 * jamais inventé. */
export function normaliser(projetIn: unknown): Projet {
  const base = projetVide();
  const p = (projetIn && typeof projetIn === 'object' ? (JSON.parse(JSON.stringify(projetIn)) as Record<string, unknown>) : {}) as Record<string, unknown>;
  const out: Projet = {
    version: 1,
    largeur: Math.round(nombre(p.largeur, 1080, 360, 2160)),
    hauteur: Math.round(nombre(p.hauteur, 1920, 360, 3840)),
    fps: Math.round(nombre(p.fps, 30, 24, 60)),
    fond: String(p.fond || '#020617').slice(0, 32),
    pistes: [],
    elements: [],
    soustitres: { style: { ...((p.soustitres as { style?: Record<string, unknown> } | undefined)?.style || {}) } },
  };
  const cv = p.couverture;
  if (typeof cv === 'number' && cv >= 0) out.couverture = Math.round(Math.min(cv, MAX_DUREE_S) * 100) / 100;

  const pistesIn = (Array.isArray(p.pistes) ? p.pistes : []) as Array<Record<string, unknown>>;
  const pistes = pistesIn.filter((x) => x && TYPES_PISTE.has(String(x.type)) && x.id);
  out.pistes = pistes.length
    ? pistes.map((x) => ({
        id: String(x.id).slice(0, 40),
        type: String(x.type),
        nom: String(x.nom || x.type).slice(0, 40),
        muet: Boolean(x.muet),
        verrou: Boolean(x.verrou),
      }))
    : base.pistes;
  const idsPistes = new Map(out.pistes.map((x) => [x.id, x.type]));
  const pisteParType = new Map<string, string>();
  for (const x of out.pistes) if (!pisteParType.has(x.type)) pisteParType.set(x.type, x.id);

  const elementsIn = (Array.isArray(p.elements) ? p.elements : []).slice(0, MAX_ELEMENTS) as Array<Record<string, unknown>>;
  for (const e of elementsIn) {
    if (!e || !TYPES_ELEMENT.has(String(e.type))) continue;
    const t = String(e.type);
    const tp = t === 'soustitre' ? 'soustitres' : t;
    const piste = idsPistes.get(String(e.piste)) === tp ? String(e.piste) : pisteParType.get(tp);
    if (!piste) continue;
    const src = e.src;
    if (['video', 'image', 'audio'].includes(t)) {
      if (!(typeof src === 'string' && URL_OK.test(src))) continue;
    }
    const el: ProjetElement = {
      id: String(e.id || `e${out.elements.length}`).slice(0, 40),
      piste,
      type: t,
      debut: Math.round(nombre(e.debut, 0, 0, MAX_DUREE_S) * 1000) / 1000,
      duree: Math.round(nombre(e.duree, 1, 0.05, MAX_DUREE_S) * 1000) / 1000,
      opacite: nombre(e.opacite, 1, 0, 1),
    };
    if (['video', 'image', 'audio'].includes(t)) el.src = src as string;
    if (['video', 'audio'].includes(t)) {
      el.decalage = Math.round(nombre(e.decalage, 0, 0, MAX_DUREE_S) * 1000) / 1000;
      el.volume = nombre(e.volume, 1, 0, 1);
      el.vitesse = nombre(e.vitesse, 1, 0.25, 4);
    }
    if (t === 'audio') el.fonduSortie = nombre(e.fonduSortie, 0, 0, 10);
    if (['video', 'image', 'texte'].includes(t)) {
      const c = (e.cadre as Record<string, unknown>) || {};
      el.cadre = { x: nombre(c.x, 0, -100, 200), y: nombre(c.y, 0, -100, 200), w: nombre(c.w, 100, 1, 300), h: nombre(c.h, 100, 1, 300) };
      el.rotation = nombre(e.rotation, 0, -360, 360);
      if (t !== 'texte') {
        el.ajustement = ['cover', 'contain'].includes(String(e.ajustement)) ? (e.ajustement as string) : 'cover';
        el.rayon = nombre(e.rayon, 0, 0, 400);
      }
    }
    if (t === 'image') el.animation = String(e.animation || 'aucune').slice(0, 16);
    if (['video', 'image'].includes(t) && e.recadre && typeof e.recadre === 'object') {
      const rc = e.recadre as Record<string, unknown>;
      const zoom = nombre(rc.zoom, 1, 1, 5);
      const rx = nombre(rc.x, 50, 0, 100);
      const ry = nombre(rc.y, 50, 0, 100);
      if (zoom !== 1 || rx !== 50 || ry !== 50) el.recadre = { zoom: Math.round(zoom * 1000) / 1000, x: Math.round(rx * 10) / 10, y: Math.round(ry * 10) / 10 };
    }
    if (['video', 'image'].includes(t) && e.transition && typeof e.transition === 'object') {
      const tr = e.transition as Record<string, unknown>;
      if (['fondu', 'glisser', 'zoom', 'volet', 'noir'].includes(String(tr.type))) {
        el.transition = { type: String(tr.type), duree: nombre(tr.duree, 0.5, 0.1, 2) };
      }
    }
    if (['texte', 'soustitre'].includes(t)) el.texte = String(e.texte || '').slice(0, 600);
    if (t === 'soustitre' && Array.isArray(e.mots)) {
      const mots = (e.mots as Array<Record<string, unknown>>)
        .slice(0, 40)
        .filter((m) => m && String(m.texte || '').trim())
        .map((m) => ({
          t: Math.round(nombre(m.t, 0, 0, MAX_DUREE_S) * 1000) / 1000,
          d: Math.round(nombre(m.d, 0.3, 0.05, 30) * 1000) / 1000,
          texte: String(m.texte).trim().slice(0, 60),
        }));
      if (mots.length) el.mots = mots;
    }
    if (t === 'texte') {
      const style: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((e.style as Record<string, unknown>) || {})) {
        if (typeof k !== 'string') continue;
        style[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
      }
      el.style = style;
    }
    out.elements.push(el);
  }
  return out;
}

export function dureeS(projet: Projet | null | undefined): number {
  const fins = (projet?.elements || []).map((e) => nombre(e.debut) + nombre(e.duree));
  const fin = fins.length ? Math.max(...fins) : 0;
  return Math.round(Math.max(1.0, fin) * 100) / 100;
}

export interface MontageRow {
  id: string;
  telegram_id: string;
  titre: string;
  projet: unknown;
  projet_rendu: unknown;
  source_contenu_id: string | null;
  contenu_id: string | null;
  statut: string;
  video_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MontageResume {
  id: string;
  apercu: string | null;
  titre: string;
  statut: string;
  duree_s: number;
  video_url: string | null;
  contenu_id: string | null;
  source_contenu_id: string | null;
  updated_at: Date;
  created_at: Date;
}

@Injectable()
export class EditeurService {
  private readonly logger = new Logger(EditeurService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly banqueService: BanqueService,
    private readonly musicLibraryService: MusicLibraryService,
    private readonly quotaService: QuotaService,
    private readonly renderQueueService: RenderQueueService,
    private readonly montagePoc: MontagePocService,
    private readonly voixService: VoixService,
    config: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  /** Petite image de reconnaissance d'un montage : le premier plan image ou vidéo. */
  private vignette(projet: Projet | null | undefined): string | null {
    const els = (projet?.elements || [])
      .filter((e) => ['image', 'video'].includes(e.type) && e.src)
      .sort((a, b) => (a.debut || 0) - (b.debut || 0));
    if (!els.length) return null;
    const src = els[0].src!;
    if (src.includes('/video/upload/')) return src.replace('/upload/', '/upload/so_1,w_240,h_426,c_fill,q_auto/').replace(/\.[^./]+$/, '') + '.jpg';
    if (src.includes('/image/upload/')) return src.replace('/upload/', '/upload/w_240,h_426,c_fill,q_auto/');
    return null;
  }

  private resume(row: MontageRow): MontageResume {
    const projet = (row.projet as Projet) || projetVide();
    return {
      id: row.id,
      apercu: this.vignette(projet),
      titre: row.titre || 'Montage',
      statut: row.statut || 'brouillon',
      duree_s: dureeS(projet),
      video_url: row.video_url,
      contenu_id: row.contenu_id,
      source_contenu_id: row.source_contenu_id,
      updated_at: row.updated_at,
      created_at: row.created_at,
    };
  }

  async lister(telegramId: string): Promise<MontageResume[]> {
    const rows = await this.prisma.montages.findMany({
      where: { telegram_id: telegramId },
      select: { id: true, titre: true, statut: true, video_url: true, contenu_id: true, source_contenu_id: true, projet: true, updated_at: true, created_at: true },
      orderBy: { updated_at: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.resume(r as MontageRow));
  }

  async creer(telegramId: string, titre?: string | null, projet?: unknown, sourceContenuId?: string | null): Promise<MontageRow> {
    const row = {
      telegram_id: telegramId,
      titre: (titre || 'Montage').trim().slice(0, 120),
      projet: (projet ? normaliser(projet) : projetVide()) as never,
      source_contenu_id: sourceContenuId || null,
      statut: 'brouillon',
    };
    return (await this.prisma.montages.create({ data: row })) as MontageRow;
  }

  private async maj(montageId: string, champs: Record<string, unknown>): Promise<MontageRow> {
    return (await this.prisma.montages.update({ where: { id: montageId }, data: { ...champs, updated_at: new Date() } as never })) as MontageRow;
  }

  async lire(telegramId: string, montageId: string): Promise<MontageRow | null> {
    let m = (await this.prisma.montages.findFirst({ where: { id: montageId, telegram_id: telegramId } })) as MontageRow | null;
    if (!m) return null;
    // Statut du rendu : la ligne Contenus fait foi (le worker n'écrit que là).
    if (m.contenu_id && m.statut === 'rendu_en_cours') {
      try {
        const c = await this.prisma.contenu.findUnique({ where: { id: m.contenu_id }, select: { video_status: true, video_url: true, render_job: true } });
        if (c && c.video_status === 'ready' && c.video_url && !c.render_job) {
          m = await this.maj(montageId, { statut: 'rendu', video_url: c.video_url });
        } else if (c && ['ready', 'echec'].includes(c.video_status || '') && (c.video_status === 'echec' || !c.video_url || (c.render_job as { erreur?: string } | null)?.erreur)) {
          // Le worker a abandonné (échec franc, ou restauration de la version précédente).
          m = await this.maj(montageId, { statut: 'echec' });
        } else if (!c) {
          m = await this.maj(montageId, { statut: 'brouillon', contenu_id: null });
        }
      } catch (e) {
        this.logger.warn(`editeur statut rendu ${montageId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return m as MontageRow;
  }

  async modifier(telegramId: string, montageId: string, projet?: unknown, titre?: string | null): Promise<MontageRow | null> {
    const m = await this.lire(telegramId, montageId);
    if (!m) return null;
    const champs: Record<string, unknown> = {};
    if (projet !== undefined && projet !== null) {
      champs.projet = normaliser(projet);
      // Une modification après un rendu : le montage redevient un brouillon (la vidéo
      // précédente reste dans Contenus jusqu'au prochain export).
      if (['rendu', 'echec'].includes(m.statut)) champs.statut = 'brouillon';
    }
    if (titre !== undefined && titre !== null) champs.titre = titre.trim().slice(0, 120) || 'Montage';
    if (!Object.keys(champs).length) return m;
    return this.maj(montageId, champs);
  }

  async supprimer(telegramId: string, montageId: string): Promise<boolean> {
    const res = await this.prisma.montages.deleteMany({ where: { id: montageId, telegram_id: telegramId } });
    return res.count > 0;
  }

  /** Tout ce que le client peut poser sur la timeline : sa banque, ses vidéos déjà
   * produites, la bibliothèque musicale. */
  async medias(telegramId: string) {
    let banque: unknown[] = [];
    try {
      banque = await this.banqueService.lister(telegramId);
    } catch (e) {
      this.logger.warn(`editeur medias banque: ${e instanceof Error ? e.message : e}`);
    }
    let videos: Array<{ id: string; titre: string; type: string | null; url: string; apercu_url: string | null; created_at: Date }> = [];
    try {
      const rows = await this.prisma.contenu.findMany({
        where: { telegram_id: telegramId, video_url: { not: null } },
        select: { id: true, titre: true, type: true, video_url: true, video_preview_url: true, lien_visuel: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 40,
      });
      videos = rows
        .filter((c) => c.video_url)
        .map((c) => ({ id: c.id, titre: c.titre || '', type: c.type, url: c.video_url as string, apercu_url: c.video_preview_url || c.lien_visuel, created_at: c.created_at as Date }));
    } catch (e) {
      this.logger.warn(`editeur medias videos: ${e instanceof Error ? e.message : e}`);
    }
    let cats: Array<{ id: string; label: string }> = [];
    let pistes: Array<{ id: string; label: string; category: string | null; url: string | null }> = [];
    try {
      [cats, pistes] = await this.musicLibraryService.bibliotheque(telegramId);
    } catch (e) {
      this.logger.warn(`editeur medias musiques: ${e instanceof Error ? e.message : e}`);
    }
    return {
      banque,
      videos,
      musiques: pistes.map((m) => ({ id: m.id, label: m.label, category: m.category, url: m.url })),
      categories: cats,
    };
  }

  /** Exporte le montage : une ligne Contenus (Reel, À valider, rendu en cours) reçoit le
   * job Remotion « Montage ». Un second export remplace la vidéo de la même ligne (la
   * précédente est restaurée si le rendu échoue). Consomme 1 reel de quota. */
  async rendre(telegramId: string, montageId: string, reseau?: string | null, titre?: string | null) {
    const m = await this.lire(telegramId, montageId);
    if (!m) return { error: 'Montage introuvable.' };
    const projet = normaliser(m.projet);
    if (!projet.elements.length) return { error: 'Le montage est vide : pose au moins une vidéo, une image ou un texte.' };
    if (m.statut === 'rendu_en_cours') return { error: 'Un rendu est déjà en cours pour ce montage.' };
    const q = await this.quotaService.consume(telegramId, 'reel');
    if (!q.ok) return { error_quota: q };
    const titreC = (titre || m.titre || 'Montage').trim().slice(0, 120);
    // Miniature : l'instant choisi par le client, sinon ~1 s.
    const dProjet = dureeS(projet);
    const cv = projet.couverture;
    const couv = cv !== undefined ? Math.round(Math.min(cv, Math.max(0, dProjet - 0.2)) * 100) / 100 : Math.round(Math.min(1.0, dProjet * 0.3) * 100) / 100;
    let restaurer: { video_url?: string | null; video_preview_url?: string | null } | undefined;
    let extra: Record<string, unknown> | undefined;
    let contenuId = m.contenu_id;
    try {
      if (contenuId) {
        const cur = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId }, select: { video_url: true, video_preview_url: true } });
        restaurer = { video_url: cur?.video_url ?? null, video_preview_url: cur?.video_preview_url ?? null };
        extra = { titre: titreC, reseau_cible: reseau || 'Instagram', video_url: null, video_preview_url: null };
      } else {
        const row = {
          telegram_id: telegramId,
          titre: titreC,
          contenu: '',
          type: normTypeContenu('Reel'),
          reseau_cible: reseau || 'Instagram',
          statut: normStatutContenu('A valider'),
          video_status: 'en_traitement',
          lien_visuel: null,
        };
        const ins = await this.prisma.contenu.create({ data: row as never });
        contenuId = ins.id;
      }
      await this.renderQueueService.enqueue(contenuId, telegramId, {
        composition: 'Montage',
        props: projet as unknown as Record<string, unknown>,
        prefix: 'montage',
        etiquette: 'montage',
        upload: { public_id: `montages/${telegramId}/${montageId}`, couverture_s: couv },
        actionType: 'reel',
        notif: 'reel',
        restaurer,
        extra,
      });
    } catch (e) {
      await this.quotaService.refund(q);
      this.logger.error(`editeur rendre ${montageId}: ${e instanceof Error ? e.message : e}`);
      return { error: 'Impossible de lancer le rendu, réessaie.' };
    }
    await this.quotaService.confirm(q);
    // `projet_rendu` fige l'état envoyé au rendu : un filet de secours pour revenir à cette
    // version après des modifications ultérieures (l'enregistrement automatique écrase `projet`).
    const updated = await this.maj(montageId, { statut: 'rendu_en_cours', contenu_id: contenuId, projet, projet_rendu: projet });
    return { montage: this.resume(updated), contenu_id: contenuId, quota: { action: 'reel', used: q.used, limit: q.limit } };
  }

  /** Remet le projet dans l'état où il était au moment du dernier export (réussi ou non).
   * Passe par modifier() pour garder la même logique de statut (retour en brouillon). */
  async restaurerRendu(telegramId: string, montageId: string): Promise<MontageRow | null> {
    const m = await this.lire(telegramId, montageId);
    if (!m || !m.projet_rendu) return null;
    return this.modifier(telegramId, montageId, m.projet_rendu);
  }

  /** Un fichier audio du client (musique perso, voix enregistrée...), posé directement sur
   * la piste Audio — pas de banque persistante ici (contrairement aux photos/clips) : on
   * l'upload et on renvoie l'URL, le client s'en sert une fois comme pour une voix générée. */
  async importerAudio(telegramId: string, file: { buffer: Buffer; mimetype?: string; originalname?: string }): Promise<{ url: string; duree_s: number | null } | { error: string }> {
    const ct = (file.mimetype || '').toLowerCase();
    const nom = (file.originalname || '').toLowerCase();
    if (!(ct.startsWith('audio/') || AUDIO_EXT.some((ext) => nom.endsWith(ext)))) {
      return { error: 'Le fichier doit être un audio (mp3, wav, m4a...).' };
    }
    if (file.buffer.length > MAX_AUDIO_MO * 1024 * 1024) {
      return { error: `Fichier trop lourd (max ${MAX_AUDIO_MO} Mo).` };
    }
    let up: { secure_url: string; duration?: number };
    try {
      const dataUri = `data:${ct || 'audio/mpeg'};base64,${file.buffer.toString('base64')}`;
      up = (await cloudinary.uploader.upload(dataUri, { folder: `editeur-audio/${telegramId}`, resource_type: 'video' })) as {
        secure_url: string;
        duration?: number;
      };
    } catch (e) {
      this.logger.error(`editeur importerAudio: ${e instanceof Error ? e.message : e}`);
      return { error: "Échec de l'import." };
    }
    const dureeS = Math.round((up.duration || 0) * 100) / 100;
    return { url: up.secure_url, duree_s: dureeS || null };
  }

  /** Ouvre un contenu vidéo dans l'éditeur : un reel Remotion devient une suite d'éléments
   * éditables ; une vidéo montée ou importée devient un plan vidéo. Réutilise le montage
   * déjà ouvert pour ce contenu s'il existe. */
  async depuisContenu(telegramId: string, contenuId: string): Promise<{ id: string; existant: boolean } | { error: string }> {
    const c = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!c) return { error: 'Contenu introuvable.' };
    const deja = await this.prisma.montages.findFirst({ where: { telegram_id: telegramId, source_contenu_id: contenuId }, orderBy: { updated_at: 'desc' }, select: { id: true } });
    if (deja) return { id: deja.id, existant: true };
    let projet: Projet;
    const sc = (c.reel_data as { segments?: unknown[]; musique?: string } | null) || {};
    if (sc.segments?.length) {
      projet = await this.projetDepuisReel(c as never, sc as never);
    } else if (c.video_url) {
      projet = await this.projetDepuisVideo(c as never);
    } else {
      return { error: "Ce contenu n'a pas de vidéo à ouvrir." };
    }
    const m = await this.creer(telegramId, (c.titre || 'Montage').slice(0, 120), projet, contenuId);
    return { id: m.id, existant: false };
  }

  /** Chaque plan du scénario : son visuel (photo ou clip, durée du plan) + son texte à
   * l'écran en élément texte ; la musique du reel en piste audio. */
  private async projetDepuisReel(
    c: { telegram_id: string },
    sc: { segments?: Array<{ video?: string; image?: string; texte?: string; dur?: number }>; musique?: string | null },
  ): Promise<Projet> {
    const p = projetVide();
    let t = 0;
    (sc.segments || []).forEach((sg, i) => {
      const dur = Number(sg.dur) || 3.0;
      if (sg.video && sg.video.startsWith('https://')) {
        p.elements.push({
          id: `v${i}`, piste: 'p-video', type: 'video', debut: t, duree: dur, src: sg.video,
          decalage: 0, volume: 0, vitesse: 1, cadre: { x: 0, y: 0, w: 100, h: 100 }, ajustement: 'cover', rotation: 0,
        });
      } else if (sg.image && sg.image.startsWith('https://')) {
        p.elements.push({
          id: `i${i}`, piste: 'p-image', type: 'image', debut: t, duree: dur, src: sg.image,
          cadre: { x: 0, y: 0, w: 100, h: 100 }, ajustement: 'cover', rotation: 0, animation: 'zoom',
        });
      }
      if (sg.texte) {
        p.elements.push({
          id: `t${i}`, piste: 'p-texte', type: 'texte', debut: t, duree: dur, texte: sg.texte,
          cadre: { x: 8, y: 38, w: 84, h: 24 }, rotation: 0,
          style: { police: 'Sora', taille: 84, couleur: '#FFFFFF', fond: 'transparent', gras: true, italique: false, align: 'center', ombre: true, contour: false, rayon: 0, marge: 0, animation: 'monter' },
        });
      }
      t += dur;
    });
    const musique = sc.musique ? await this.musicLibraryService.urlDe(sc.musique, c.telegram_id) : null;
    if (musique && t > 0) {
      p.elements.push({ id: 'm0', piste: 'p-audio', type: 'audio', debut: 0, duree: t, src: musique, decalage: 0, volume: 0.35, fonduSortie: 1.5 });
    }
    return p;
  }

  /** La vidéo entière en plan vidéo ; si Studio Montage a la transcription, une phrase de
   * sous-titre par groupe de mots (≈ 6 mots). */
  private async projetDepuisVideo(c: { id: string; video_url: string; submagic_project_id?: string | null }): Promise<Projet> {
    const p = projetVide();
    const duree = 30.0;
    p.elements.push({
      id: 'v0', piste: 'p-video', type: 'video', debut: 0, duree, src: c.video_url,
      decalage: 0, volume: 1, vitesse: 1, cadre: { x: 0, y: 0, w: 100, h: 100 }, ajustement: 'cover', rotation: 0,
    });
    if (c.submagic_project_id) {
      try {
        const tr = await this.montagePoc.getTranscript(c.submagic_project_id);
        const mots = (tr.words as Array<{ text?: string; word?: string; start?: number; end?: number }>) || [];
        let groupe: Array<{ text?: string; word?: string; start?: number; end?: number }> = [];
        let i = 0;
        for (const w of mots) {
          groupe.push(w);
          const texte = String(w.text || w.word || '');
          if (groupe.length >= 6 || /[.!?]$/.test(texte.trimEnd())) {
            p.elements.push(this.soustitre(groupe, i));
            groupe = [];
            i += 1;
          }
        }
        if (groupe.length) p.elements.push(this.soustitre(groupe, i));
        const fin = mots.length ? Math.max(...mots.map((w) => Number(w.end) || 0)) : 0;
        if (fin > 0) p.elements[0].duree = Math.round((fin + 0.3) * 100) / 100;
      } catch (e) {
        this.logger.warn(`editeur transcription ${c.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return p;
  }

  private soustitre(groupe: Array<{ text?: string; word?: string; start?: number; end?: number }>, i: number | string): ProjetElement {
    const debut = Number(groupe[0].start) || 0;
    const fin = Number(groupe[groupe.length - 1].end) || debut + 1;
    const mots = groupe.map((w) => ({
      t: Math.round(Math.max(0, (Number(w.start) || 0) - debut) * 1000) / 1000,
      d: Math.round(Math.max(0.08, (Number(w.end) || 0) - (Number(w.start) || 0)) * 1000) / 1000,
      texte: String(w.text || w.word || '').trim(),
    }));
    return {
      id: typeof i === 'number' ? `s${i}` : String(i),
      piste: 'p-soustitres',
      type: 'soustitre',
      debut: Math.round(debut * 1000) / 1000,
      duree: Math.round(Math.max(0.4, fin - debut) * 1000) / 1000,
      texte: mots.map((m) => m.texte).filter(Boolean).join(' ').trim(),
      mots: mots.filter((m) => m.texte),
    };
  }

  /** « Générer les sous-titres » sur un plan vidéo : transcription Whisper, mots recalés
   * sur la timeline, remplacent les sous-titres qui couvraient déjà ce plan. */
  async transcrire(telegramId: string, montageId: string, elementId: string) {
    const m = await this.lire(telegramId, montageId);
    if (!m) return { error: 'Montage introuvable.' };
    const projet = normaliser(m.projet);
    const el = projet.elements.find((e) => e.id === elementId);
    if (!el || el.type !== 'video') return { error: 'Choisis un plan vidéo à sous-titrer.' };
    const res = await this.montagePoc.transcrireUrl(el.src!);
    if (!res.ok) return { error: res.error || 'Transcription impossible.' };
    const mots = res.words || [];
    if (!mots.length) return { error: 'Aucune parole détectée dans ce plan.' };
    const debut = el.debut;
    const duree = el.duree;
    const dec = el.decalage || 0;
    const vit = el.vitesse || 1;
    const places: Array<{ text?: string; word?: string; start: number; end: number }> = [];
    for (const w of mots) {
      const t0 = debut + ((w.start || 0) - dec) / vit;
      const t1 = debut + ((w.end || 0) - dec) / vit;
      if (t1 <= debut || t0 >= debut + duree) continue;
      places.push({ ...w, start: Math.max(debut, t0), end: Math.min(debut + duree, t1) });
    }
    if (!places.length) return { error: 'Aucune parole dans la partie du clip utilisée.' };
    const finPlan = debut + duree;
    const reste = projet.elements.filter((e) => !(e.type === 'soustitre' && e.debut < finPlan && e.debut + e.duree > debut));
    const nouveaux: ProjetElement[] = [];
    let groupe: Array<{ text?: string; word?: string; start: number; end: number }> = [];
    let i = 0;
    for (const w of places) {
      groupe.push(w);
      const texte = String(w.text || w.word || '').trimEnd();
      if (groupe.length >= 6 || /[.!?]$/.test(texte)) {
        nouveaux.push(this.soustitre(groupe, `st${elementId.slice(0, 4)}${i}`));
        groupe = [];
        i += 1;
      }
    }
    if (groupe.length) nouveaux.push(this.soustitre(groupe, `st${elementId.slice(0, 4)}${i}`));
    projet.elements = [...reste, ...nouveaux];
    const m2 = await this.maj(montageId, { projet });
    return { projet: m2.projet || projet, nb: nouveaux.length, langue: res.language };
  }

  /** Fait dire UNE phrase par une voix du catalogue (ou le clone du client) et rend un clip
   * audio prêt à poser sur la piste Audio. */
  async genererVoixOff(telegramId: string, texteIn: string, voix: string) {
    const texte = (texteIn || '').trim().slice(0, 500);
    if (!texte) return { error: "Écris d'abord la phrase à faire dire." };
    try {
      await this.voixService.validerChoix(telegramId, voix);
    } catch (e) {
      if (e instanceof VoixClientError) return { error: e.message };
      throw e;
    }
    const q = await this.quotaService.consume(telegramId, 'voix');
    if (!q.ok) return { error_quota: q };
    try {
      const voiceId = await this.voixService.resoudre(telegramId, voix);
      const langue = await this.voixService.langueDuCompte(telegramId);
      const data = await this.voixService.synthese(texte, voiceId!, undefined, langue);
      const duree = await this.voixService.dureeAudio(data);
      const up = await cloudinary.uploader.upload(`data:audio/mpeg;base64,${data.toString('base64')}`, {
        resource_type: 'video',
        folder: `voix/${telegramId}`,
        public_id: crypto.randomBytes(6).toString('hex'),
      });
      await this.quotaService.confirm(q);
      return { url: up.secure_url, duree: Math.round(Math.max(0.3, duree) * 100) / 100 };
    } catch (e) {
      await this.quotaService.refund(q);
      this.logger.error(`editeur voix off: ${e instanceof Error ? e.message : e}`);
      return { error: 'Échec de la génération de la voix.' };
    }
  }

  /** Retire les silences d'un plan vidéo : transcrit (Whisper), calcule les passages
   * parlés, remplace le plan par la suite de ses sous-plans collés bout à bout. */
  async couperSilences(telegramId: string, montageId: string, elementId: string, intensite = 'naturel') {
    const m = await this.lire(telegramId, montageId);
    if (!m) return { error: 'Montage introuvable.' };
    const projet = normaliser(m.projet);
    const el = projet.elements.find((e) => e.id === elementId);
    if (!el || el.type !== 'video') return { error: 'Choisis un plan vidéo à nettoyer.' };
    const res = await this.montagePoc.transcrireUrl(el.src!);
    if (!res.ok) return { error: res.error || 'Transcription impossible.' };
    const mots = res.words || [];
    if (!mots.length) return { error: 'Aucune parole détectée dans ce plan.' };
    const debut = el.debut;
    const duree = el.duree;
    const dec = el.decalage || 0;
    const vit = el.vitesse || 1;
    const finSource = dec + duree * vit;
    const fenetre = mots.filter((w) => (w.end || 0) > dec && (w.start || 0) < finSource);
    if (!fenetre.length) return { error: 'Aucune parole dans la partie du clip utilisée.' };
    const [gapMin, gapKeep] = INTENSITES_SILENCE[intensite] || INTENSITES_SILENCE.naturel;
    const segs: Array<[number, number]> = [];
    let cur = Math.max(dec, fenetre[0].start - 0.3);
    for (let idx = 0; idx < fenetre.length - 1; idx++) {
      const a = fenetre[idx];
      const b = fenetre[idx + 1];
      const gap = b.start - a.end;
      if (gap > gapMin) {
        segs.push([cur, Math.min(finSource, a.end + gapKeep / 2)]);
        cur = Math.max(dec, b.start - gapKeep / 2);
      }
    }
    segs.push([cur, Math.min(finSource, fenetre[fenetre.length - 1].end + 0.6)]);
    const segsFiltres = segs.filter(([a, b]) => b - a > 0.15);
    if (!segsFiltres.length) return { error: 'Rien à couper : ce plan est déjà sans silence notable.' };
    const nouveaux: ProjetElement[] = [];
    let t = debut;
    segsFiltres.forEach(([a, b], idx) => {
      const dtl = (b - a) / vit;
      const piece: ProjetElement = { ...el, id: (idx === 0 ? elementId : `${elementId.slice(0, 34)}s${idx}`).slice(0, 40), debut: Math.round(t * 1000) / 1000, duree: Math.round(dtl * 1000) / 1000, decalage: Math.round(a * 1000) / 1000 };
      if (idx > 0) delete piece.transition;
      nouveaux.push(piece);
      t += dtl;
    });
    const gagne = Math.round((duree - (t - debut)) * 100) / 100;
    if (segsFiltres.length === 1 && gagne < 0.3) return { error: 'Rien à couper : ce plan est déjà sans silence notable.' };
    projet.elements = [...projet.elements.filter((x) => x.id !== elementId), ...nouveaux];
    const m2 = await this.maj(montageId, { projet });
    return { projet: m2.projet || projet, nb: nouveaux.length, gagne, premier_id: nouveaux[0].id, dernier_id: nouveaux[nouveaux.length - 1].id };
  }
}
