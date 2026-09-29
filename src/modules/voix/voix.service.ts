import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaService } from '../../config/prisma.service';
import { QuotaService } from '../quota/quota.service';

const execFileP = promisify(execFile);

/** Erreur présentable au client (équivalent du `ValueError` levé partout dans
 * voix_service.py : consentement manquant, fichier trop lourd/court, clonage refusé…). */
export class VoixClientError extends Error {}

/**
 * Voix off des reels (ElevenLabs) — port direct de backend/services/voix_service.py.
 * Le scénariste (reel.service, à venir) écrit une PHRASE PARLÉE par plan (`voix_texte`),
 * distincte du texte affiché : un texte karaoké de trois mots ne s'entend pas. On la fait
 * dire par une voix du catalogue (trois voix natives par langue) ou par le clone de la voix
 * du client, on dépose le MP3 sur Cloudinary et on pose sur le plan `voix = {src, dur}` :
 * Remotion étire le plan sur la voix et passe la musique en fond (ReelSequence.tsx).
 *
 * Tout se fait dans le worker de rendu, jamais dans la requête : six appels ElevenLabs
 * prennent une dizaine de secondes.
 *
 * Clonage : une à deux minutes d'audio du client, consentement explicite horodaté,
 * suppression possible (chez nous ET chez ElevenLabs). Réservé au forfait payé.
 */

const API = 'https://api.elevenlabs.io/v1';
const MODELE = 'eleven_v3'; // le plus expressif ; multilingual_v2 en repli
const MODELE_REPLI = 'eleven_multilingual_v2';
const TAILLE_MAX_MO = 25;
const DUREE_MIN_S = 45; // en dessous, le clone est mauvais : on refuse

interface VoixCatalogueEntree {
  voice_id: string;
  genre: 'homme' | 'femme';
  apercu: string;
  langue: string;
}

const APERCU = (id: string) => `https://res.cloudinary.com/dy9gp5pim/video/upload/brand/voix-apercus/${id}.mp3`;

// Voix natives de la bibliothèque ElevenLabs, ajoutées au compte le 2026-09-04, par langue
// du compte (users.langue) : un client anglais ou espagnol entend des voix natives, pas un
// Français qui lit de l'anglais. Deux hommes, une femme par langue. Les libellés (nom,
// description) sont dans les locales du front (voixOff.voix.<id>).
export const CATALOGUE_PAR_LANGUE: Record<string, Record<string, VoixCatalogueEntree>> = {
  fr: {
    victor: { voice_id: 'GPAQQPp9dazaB2bl4zg9', genre: 'homme', apercu: APERCU('victor'), langue: 'fr' },
    yann: { voice_id: 'nr2EGJNe96rzn9FRlTId', genre: 'homme', apercu: APERCU('yann'), langue: 'fr' },
    adina: { voice_id: 'FvmvwvObRqIHojkEGh5N', genre: 'femme', apercu: APERCU('adina'), langue: 'fr' },
  },
  en: {
    mark: { voice_id: 'WTUK291rZZ9CLPCiFTfh', genre: 'homme', apercu: APERCU('mark'), langue: 'en' },
    drew: { voice_id: 'q0IMILNRPxOgtBTS4taI', genre: 'homme', apercu: APERCU('drew'), langue: 'en' },
    elise: { voice_id: 'EST9Ui6982FZPSi7gCHi', genre: 'femme', apercu: APERCU('elise'), langue: 'en' },
  },
  es: {
    // latino-américain
    sam: { voice_id: '18GZPpJvaVG53Nt3H52N', genre: 'homme', apercu: APERCU('sam'), langue: 'es' },
    // castillan neutre
    ginyin: { voice_id: 'nMPrFLO7QElx9wTR0JGo', genre: 'homme', apercu: APERCU('ginyin'), langue: 'es' },
    // castillan
    sara: { voice_id: 'gD1IexrzCvsXPHUuT0s3', genre: 'femme', apercu: APERCU('sara'), langue: 'es' },
  },
};

// Toutes les voix, quelle que soit la langue (résolution d'un choix déjà enregistré).
export const CATALOGUE: Record<string, VoixCatalogueEntree> = Object.fromEntries(
  Object.values(CATALOGUE_PAR_LANGUE).flatMap((voix) => Object.entries(voix)),
);
export const VOIX_DEFAUT_PAR_LANGUE: Record<string, string> = { fr: 'victor', en: 'mark', es: 'sam' };
export const VOIX_DEFAUT = VOIX_DEFAUT_PAR_LANGUE.fr;
export const CLONE = 'moi';

const REGLAGES = { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1.05 };
const PHRASE_APERCU: Record<string, string> = {
  fr: "Bonjour, c'est bien ma voix. Elle dira mes reels : direct, chaleureux, sans jargon. On en parle quand tu veux.",
  en: "Hi, yes, that's my voice. It will speak my reels: direct, warm, no jargon. Let's talk whenever you want.",
  es: 'Hola, sí, esta es mi voz. Dirá mis reels: directa, cálida, sin jerga. Hablamos cuando quieras.',
};

export interface CloneStatut {
  migration: boolean;
  existe: boolean;
  cree_le?: Date | null;
  consentement_le?: Date | null;
  apercu?: string | null;
  duree_s?: number | null;
  defaut?: string | null;
}

export interface VoixSegment {
  voix_texte?: string;
  texte?: string;
  voix?: { src: string; dur: number };
  [k: string]: unknown;
}

@Injectable()
export class VoixService {
  private readonly logger = new Logger(VoixService.name);
  private readonly apiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotaService: QuotaService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('app.elevenlabsApiKey') || '';
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  disponible(): boolean {
    return Boolean(this.apiKey);
  }

  async langueDuCompte(telegramId: string): Promise<string> {
    try {
      const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { langue: true } });
      const l = (u?.langue || 'fr').toLowerCase().slice(0, 2);
      return l in CATALOGUE_PAR_LANGUE ? l : 'fr';
    } catch {
      return 'fr';
    }
  }

  /** Un MP3 (44,1 kHz, 128 kb/s) pour une phrase. Repli sur multilingual_v2 si le modèle
   * v3 refuse (indisponible, texte trop long…). */
  async synthese(texte: string, voiceId: string, modele: string = MODELE, langue = 'fr'): Promise<Buffer> {
    if (!this.disponible()) throw new Error('ELEVENLABS_API_KEY absente');
    const corps: Record<string, unknown> = { text: texte, model_id: modele, voice_settings: REGLAGES };
    if (modele !== MODELE) corps.language_code = langue in CATALOGUE_PAR_LANGUE ? langue : 'fr';
    const resp = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      if (modele === MODELE) {
        this.logger.warn(`voix: ${MODELE} a refusé (${resp.status}), repli ${MODELE_REPLI}`);
        return this.synthese(texte, voiceId, MODELE_REPLI, langue);
      }
      const text = await resp.text().catch(() => '');
      throw new Error(`ElevenLabs ${resp.status} : ${text.slice(0, 200)}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Durée en secondes via ffprobe ; à défaut, estimation grossière. */
  async dureeAudio(data: Buffer, suffixe = '.mp3'): Promise<number> {
    const chemin = path.join(os.tmpdir(), `voix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffixe}`);
    try {
      await fs.promises.writeFile(chemin, data);
      const { stdout } = await execFileP(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', chemin],
        { timeout: 30_000 },
      );
      const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
      const d = parseFloat(parsed.format?.duration || '');
      if (!Number.isNaN(d)) return d;
    } catch (e) {
      this.logger.warn(`voix: ffprobe indisponible (${e instanceof Error ? e.message : e})`);
    } finally {
      fs.unlink(chemin, () => undefined);
    }
    return Math.max(1.0, data.length / 16000); // ~128 kb/s -> 16 Ko par seconde
  }

  private phrase(seg: VoixSegment): string {
    let p = (seg.voix_texte || seg.texte || '').trim();
    if (p && !'.!?…'.includes(p[p.length - 1])) p += '.';
    return p;
  }

  /** Pose `voix = {src, dur}` sur chaque plan du scénario (props Remotion). Idempotent :
   * un plan qui a déjà sa voix est laissé tel quel (nouvelle tentative du worker sans
   * re-payer la synthèse). Lève si la voix est introuvable. */
  async appliquer(telegramId: string, props: { segments?: VoixSegment[] }, voix: string): Promise<{ segments?: VoixSegment[] }> {
    const voiceId = await this.resoudre(telegramId, voix);
    if (!voiceId) throw new Error(`voix introuvable : ${voix}`);
    const langue = await this.langueDuCompte(telegramId);
    const segments = props.segments || [];
    for (const seg of segments) {
      if (seg.voix?.src) continue;
      const phrase = this.phrase(seg);
      if (!phrase) continue;
      const data = await this.synthese(phrase, voiceId, MODELE, langue);
      const dur = await this.dureeAudio(data);
      const up = await cloudinary.uploader.upload(`data:audio/mpeg;base64,${data.toString('base64')}`, {
        resource_type: 'video',
        folder: `voix/${telegramId}`,
        public_id: cryptoRandomId(),
      });
      seg.voix = { src: up.secure_url, dur: Math.round(dur * 100) / 100 };
    }
    return props;
  }

  // ------------------------------------------------------------------ catalogue / clone

  /** Colonnes du clone sur la fiche marque. */
  private async fiche(telegramId: string): Promise<{
    voix_clone_id: string | null;
    voix_clone_le: Date | null;
    voix_consentement_le: Date | null;
    voix_clone_apercu: string | null;
    voix_clone_duree_s: number | null;
    voix_defaut: string | null;
  } | null> {
    try {
      return await this.prisma.marques.findUnique({
        where: { telegram_id: telegramId },
        select: {
          voix_clone_id: true,
          voix_clone_le: true,
          voix_consentement_le: true,
          voix_clone_apercu: true,
          voix_clone_duree_s: true,
          voix_defaut: true,
        },
      });
    } catch (e) {
      this.logger.warn(`voix fiche: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  async statutClone(telegramId: string): Promise<CloneStatut> {
    const f = await this.fiche(telegramId);
    if (!f) return { migration: true, existe: false, defaut: null };
    return {
      migration: true,
      existe: Boolean(f.voix_clone_id),
      cree_le: f.voix_clone_le,
      consentement_le: f.voix_consentement_le,
      apercu: f.voix_clone_apercu,
      duree_s: f.voix_clone_duree_s,
      defaut: f.voix_defaut,
    };
  }

  async catalogue(telegramId: string): Promise<{
    disponible: boolean;
    langue: string;
    voix: Array<{ id: string; genre: string; apercu: string }>;
    clone: CloneStatut;
    clone_autorise: boolean;
    defaut: string;
  }> {
    const clone = await this.statutClone(telegramId);
    const langue = await this.langueDuCompte(telegramId);
    const voix = CATALOGUE_PAR_LANGUE[langue];
    // Un défaut mémorisé dans une autre langue (compte passé du français à l'anglais) ne se
    // propose plus : la voix par défaut de la nouvelle langue prend le relais.
    let defaut = clone.defaut;
    if (defaut && defaut !== CLONE && !(defaut in voix)) defaut = null;
    return {
      disponible: this.disponible(),
      langue,
      voix: Object.entries(voix).map(([k, v]) => ({ id: k, genre: v.genre, apercu: v.apercu })),
      clone,
      clone_autorise: await this.quotaService.isPaid(telegramId), // clonage : forfait payé uniquement
      defaut: defaut || VOIX_DEFAUT_PAR_LANGUE[langue],
    };
  }

  /** id de choix (victor|yann|adina|moi) -> voice_id ElevenLabs, ou null. */
  async resoudre(telegramId: string, voix: string): Promise<string | null> {
    if (voix in CATALOGUE) return CATALOGUE[voix].voice_id;
    if (voix === CLONE) {
      const f = await this.fiche(telegramId);
      return f?.voix_clone_id ?? null;
    }
    return null;
  }

  /** Garde des routes : lève avec un message client si le choix est impossible. */
  async validerChoix(telegramId: string, voix: string): Promise<void> {
    if (!this.disponible()) throw new VoixClientError("La voix off n'est pas disponible pour le moment.");
    if (voix in CATALOGUE) return;
    if (voix === CLONE) {
      if (!(await this.resoudre(telegramId, voix))) {
        throw new VoixClientError('Crée d\'abord ta voix dans Paramètres › Voix de marque.');
      }
      return;
    }
    throw new VoixClientError('Voix inconnue.');
  }

  async choisirDefaut(telegramId: string, voix: string | null): Promise<CloneStatut> {
    if (voix !== null && !(voix in CATALOGUE) && voix !== CLONE) throw new VoixClientError('Voix inconnue.');
    await this.prisma.marques.update({ where: { telegram_id: telegramId }, data: { voix_defaut: voix } });
    return this.statutClone(telegramId);
  }

  /** Clone instantané ElevenLabs à partir de l'audio du client. Consentement obligatoire
   * (horodaté). Un clone précédent est remplacé (supprimé chez ElevenLabs). */
  async creerClone(telegramId: string, data: Buffer, nomFichier: string, consentement: boolean): Promise<CloneStatut> {
    if (!consentement) throw new VoixClientError('Le consentement est obligatoire pour cloner une voix.');
    if (!this.disponible()) throw new VoixClientError("La voix off n'est pas disponible pour le moment.");
    if (data.length > TAILLE_MAX_MO * 1024 * 1024) throw new VoixClientError(`Fichier trop lourd (max ${TAILLE_MAX_MO} Mo).`);
    const suffixe = (path.extname(nomFichier || '').toLowerCase() || '.webm');
    const duree = await this.dureeAudio(data, suffixe);
    if (duree < DUREE_MIN_S) {
      throw new VoixClientError(`Il faut au moins ${DUREE_MIN_S} secondes d'audio (là : ${Math.trunc(duree)} s). Une à deux minutes, c'est l'idéal.`);
    }
    const ficheAvant = await this.fiche(telegramId);
    if (ficheAvant === null) throw new VoixClientError("La voix personnalisée n'est pas encore activée sur ce serveur.");

    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { nom: true, user_name: true } });
    const nom = (u?.nom || u?.user_name || telegramId.slice(0, 8)) as string;
    const ancien = ficheAvant.voix_clone_id;

    const mime: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.webm': 'audio/webm',
      '.aac': 'audio/aac',
    };
    const form = new FormData();
    form.append('name', `Postorico · ${nom}`.slice(0, 100));
    form.append('remove_background_noise', 'true');
    form.append('description', `Clone client Postorico ${telegramId}`);
    form.append('files', new Blob([new Uint8Array(data)], { type: mime[suffixe] || 'application/octet-stream' }), `voix${suffixe}`);

    const resp = await fetch(`${API}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      this.logger.error(`voix: clonage refusé (${resp.status}) : ${text.slice(0, 300)}`);
      if (resp.status === 402 || text.includes('paid_plan')) {
        throw new VoixClientError('Le clonage n\'est pas disponible pour le moment (forfait du prestataire).');
      }
      throw new VoixClientError("Le clonage a échoué. Vérifie que l'audio est net et réessaie.");
    }
    const voiceId = ((await resp.json()) as { voice_id?: string }).voice_id;
    if (!voiceId) throw new VoixClientError('Le clonage a échoué (réponse invalide).');

    // Extrait d'écoute : la même phrase pour tout le monde, comparable au catalogue.
    let apercu: string | null = null;
    try {
      const langue = await this.langueDuCompte(telegramId);
      const audio = await this.synthese(PHRASE_APERCU[langue], voiceId, MODELE, langue);
      const up = await cloudinary.uploader.upload(`data:audio/mpeg;base64,${audio.toString('base64')}`, {
        resource_type: 'video',
        public_id: `voix/${telegramId}/apercu`,
        overwrite: true,
        invalidate: true,
      });
      apercu = up.secure_url;
    } catch (e) {
      this.logger.warn(`voix: extrait du clone non généré : ${e instanceof Error ? e.message : e}`);
    }

    const now = new Date();
    await this.prisma.marques.update({
      where: { telegram_id: telegramId },
      data: {
        voix_clone_id: voiceId,
        voix_clone_le: now,
        voix_consentement_le: now,
        voix_clone_apercu: apercu,
        voix_clone_duree_s: Math.trunc(duree),
        voix_defaut: CLONE,
      },
    });

    if (ancien && ancien !== voiceId) await this.supprimerChezEleven(ancien);
    this.logger.log(`voix: clone créé pour ${telegramId} (${Math.trunc(duree)} s d'audio)`);
    return this.statutClone(telegramId);
  }

  private async supprimerChezEleven(voiceId: string): Promise<void> {
    try {
      const resp = await fetch(`${API}/voices/${voiceId}`, { method: 'DELETE', headers: { 'xi-api-key': this.apiKey }, signal: AbortSignal.timeout(60_000) });
      if (resp.status !== 200 && resp.status !== 404) {
        this.logger.warn(`voix: suppression ElevenLabs ${voiceId} -> ${resp.status}`);
      }
    } catch (e) {
      this.logger.warn(`voix: suppression ElevenLabs ${voiceId} : ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Droit à l'oubli : la voix disparaît chez nous et chez ElevenLabs. */
  async supprimerClone(telegramId: string): Promise<CloneStatut> {
    const f = await this.fiche(telegramId);
    if (f?.voix_clone_id) await this.supprimerChezEleven(f.voix_clone_id);
    const maj: Record<string, unknown> = {
      voix_clone_id: null,
      voix_clone_le: null,
      voix_consentement_le: null,
      voix_clone_apercu: null,
      voix_clone_duree_s: null,
    };
    if (f?.voix_defaut === CLONE) maj.voix_defaut = null;
    await this.prisma.marques.update({ where: { telegram_id: telegramId }, data: maj });
    try {
      await cloudinary.uploader.destroy(`voix/${telegramId}/apercu`, { resource_type: 'video', invalidate: true });
    } catch {
      // silencieux, comme côté Python
    }
    return this.statutClone(telegramId);
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(16).slice(2, 14) + Date.now().toString(16).slice(-6);
}
