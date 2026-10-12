import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { PrismaService } from '../../config/prisma.service';
import { envoyerGrosFichier } from '../../common/utils/cloudinary-envoi.util';
import {
  normStatutContenu,
  normTypeContenu,
} from '../../common/utils/contenu-enum.util';
import { MarqueService } from '../marque/marque.service';
import { NotificationService } from '../notifications/notification.service';
import { PlanningService } from '../planning/planning.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';
import { MontagePocService } from '../video/montage-poc.service';
import { ClaudeService } from '../claude/claude.service';
import { MusicLibraryService } from '../music/music-library.service';
import { VoixService } from '../voix/voix.service';
import {
  consigneClassement,
  lireClassement,
  motifSuspect,
} from './consignes.util';
import {
  consigneMoments,
  contexte,
  Illustration,
  lireChoix,
  meilleurFichier,
} from './illustrations.util';
import { Mot, motsRecales, segmentsGardes } from './pretraitement.util';

/** Choix des moments à illustrer : petite tâche, modèle rapide (même choix que le POC). */
const MODELE_ILLUSTRATIONS = 'claude-haiku-4-5';

/** Le service POC n'a pas transcrit la vidéo : le montage ne part pas sans transcription. */
export class TranscriptionIndisponible extends Error {}

/**
 * Montage par l'agent IA du VPS (Claude Code + HyperFrames, serveur `vps-agent-video/serveur-agent.mjs`).
 *
 * Le client confie sa vidéo et sa consigne : Postorico crée le contenu « en cours », prépare les
 * rushes (transcription par le service POC + coupe des silences), envoie la vidéo coupée et sa
 * transcription au serveur du VPS (POST /montages), puis une boucle suit l'avancement (GET
 * /montages/:id). Quand le montage est terminé, Postorico télécharge le MP4 et l'envoie sur
 * Cloudinary : le VPS ne connaît ni Cloudinary ni la base. Le contenu suit le même cycle que les
 * reels : `video_status` en_traitement -> ready | echec.
 *
 * Quota `video_agent` : consommé à la demande, rendu si le montage échoue.
 */

export const ACTION_QUOTA = 'video_agent';
/** Au-delà, un montage toujours pas fini est abandonné (le VPS en coupe un à 45 min, plus la file). */
export const ABANDON_MIN = 120;
/** Transcription + coupe des silences : au-delà, la préparation est considérée comme perdue. */
export const PREPARATION_MAX_MIN = 30;
const SUIVI_MS = 20_000;
/** Au-delà, le suivi passe aux autres montages ; la récupération sera retentée au passage suivant. */
const RECUPERATION_MAX_MS = 15 * 60_000;
const FORMATS = ['9:16', '16:9', '1:1'] as const;
const RESEAUX: Record<string, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
};

export interface Rush {
  url: string;
}

export interface DemandeMontage {
  /** « video » : montage de la vidéo du client ; « motion » : vidéo animée sans tournage, sur une voix off. */
  mode?: 'video' | 'motion' | null;
  clips?: Rush[] | null;
  /** Motion : texte lu par la voix off (ElevenLabs). */
  script?: string | null;
  /** Motion : voix choisie (victor, yann, adina… ou « moi » pour le clone du client). */
  voix?: string | null;
  consignes?: string | null;
  reseau?: string | null;
  format?: string | null;
  duree_max_s?: number | null;
  /** Plans d'illustration (b-roll) cherchés par Postorico et placés par l'agent. Oui par défaut. */
  illustrations?: boolean | null;
  /** Logo de la marque posé par l'agent. Oui par défaut (s'il existe dans la charte). */
  logo?: boolean | null;
  /** Photos du client (sa banque Postorico), placées par l'agent sur les bons moments. */
  images?: ImageClient[] | null;
  /** Musique de fond : id d'une piste de la bibliothèque ou du client (absent / « none » = sans musique). */
  musique?: string | null;
  /** Volume de la musique sous la voix, en % (25 par défaut). */
  musique_volume?: number | null;
}

export interface ImageClient {
  url: string;
  description?: string | null;
}

/** Une image n'est acceptée que si elle vient de la banque du client sur le Cloudinary de Postorico. */
export function imageAutorisee(
  url: string,
  cloud: string,
  telegramId: string,
): boolean {
  return (
    typeof url === 'string' &&
    url.startsWith(`https://res.cloudinary.com/${cloud}/image/upload/`) &&
    url.includes(`/banque/${telegramId}/`)
  );
}

/** Corrections gratuites par montage ; au-delà, chacune compte comme un montage. */
export const CORRECTIONS_GRATUITES = 2;

export interface EtatVps {
  statut?: string;
  progression?: string;
  erreur?: string | null;
  cout_usd?: number | null;
  duree_s?: number | null;
  resume?: string | null;
  /** Montages devant celui-ci sur le VPS (en cours ou en file). */
  avant?: number;
}

/** Un rush n'est accepté que s'il vient du Cloudinary de Postorico ET du dossier du client. */
export function rushAutorise(
  url: string,
  cloud: string,
  telegramId: string,
): boolean {
  if (
    typeof url !== 'string' ||
    !url.startsWith(`https://res.cloudinary.com/${cloud}/video/upload/`)
  )
    return false;
  return (
    url.includes(`/banque/${telegramId}/`) ||
    url.includes(`/videos_raw/${telegramId}/`)
  );
}

/** Aperçu (image) d'une vidéo Cloudinary : même dérivation que la file de rendu. */
export function apercuDe(videoUrl: string, couvertureS = 1): string {
  if (!videoUrl.includes('/upload/')) return videoUrl;
  return (
    videoUrl
      .replace('/upload/', `/upload/so_${couvertureS.toFixed(2)}/`)
      .replace(/\.[^./]+$/, '') + '.jpg'
  );
}

/** Consignes envoyées à l'agent : celles du client + le contexte de sa marque. */
export function composerConsignes(
  consignes: string,
  reseau: string,
  marque: Record<string, unknown>,
): string {
  const ligne = (label: string, valeurs: unknown[]) => {
    const v = valeurs
      .filter((x) => typeof x === 'string' && x.trim())
      .join(', ');
    return v ? `${label} : ${v}.` : '';
  };
  const contexte = [
    `Réseau de publication : ${reseau}.`,
    ligne('Marque', [marque.nom || marque.user_name]),
    ligne('Ton de la marque', [marque.ton || marque.tone]),
    ligne('Couleurs de la charte (principale, secondaire, accent)', [
      marque.couleur_principale,
      marque.couleur_secondaire,
      marque.couleur_accent,
    ]),
    ligne('Polices de la charte (titres, textes)', [
      marque.typo_primaire,
      marque.typo_secondaire,
    ]),
  ].filter(Boolean);
  return [
    consignes || 'Fais le meilleur montage possible pour ce réseau.',
    '',
    ...contexte,
  ]
    .join('\n')
    .slice(0, 2000);
}

@Injectable()
export class AgentVideoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentVideoService.name);
  private readonly url: string;
  private readonly jeton: string;
  private readonly dureeMaxS: number;
  private readonly cloud: string;
  private readonly pexelsCle: string;
  private suiviEnCours = false;
  private readonly recuperations = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly marque: MarqueService,
    private readonly planning: PlanningService,
    private readonly notifications: NotificationService,
    private readonly usage: UsageService,
    private readonly montagePoc: MontagePocService,
    private readonly claude: ClaudeService,
    private readonly musiques: MusicLibraryService,
    private readonly voix: VoixService,
    config: ConfigService,
  ) {
    this.url = (config.get<string>('app.agentVideoUrl') || '').replace(
      /\/+$/,
      '',
    );
    this.jeton = config.get<string>('app.agentVideoJeton') || '';
    this.dureeMaxS = config.get<number>('app.agentVideoDureeMaxS') || 180;
    this.cloud = config.get<string>('app.cloudinaryCloudName') || '';
    this.pexelsCle = config.get<string>('app.pexelsApiKey') || '';
    cloudinary.config({
      cloud_name: this.cloud,
      api_key: config.get<string>('app.cloudinaryApiKey') || '',
      api_secret: config.get<string>('app.cloudinaryApiSecret') || '',
    });
  }

  get actif(): boolean {
    return Boolean(this.url && this.jeton);
  }

  onApplicationBootstrap(): void {
    if (!this.actif) {
      this.logger.log(
        "Montage par l'agent IA désactivé (AGENT_VIDEO_URL / AGENT_VIDEO_JETON absents)",
      );
      return;
    }
    setInterval(() => void this.suivre(), SUIVI_MS);
  }

  private async vps(
    chemin: string,
    init: RequestInit = {},
    delaiMs = 20_000,
  ): Promise<Response> {
    return fetch(`${this.url}${chemin}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.jeton}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(delaiMs),
    });
  }

  // -------------------------------------------------------------------------------- client

  /** Valide la demande, consomme le quota, crée le contenu « en cours » et envoie au VPS. */
  async creer(
    telegramId: string,
    d: DemandeMontage,
  ): Promise<
    | { id: string; contenu_id: string; video_status: string }
    | { error: string; status?: number }
  > {
    if (!this.actif)
      return {
        error: "Le montage par l'IA est momentanément indisponible.",
        status: 503,
      };
    const motion = d.mode === 'motion';
    const clips = motion ? [] : (d.clips || []).slice(0, 10);
    const script = motion ? String(d.script || '').trim() : '';
    if (motion && script.length < 20)
      return {
        error:
          'Écris le texte que la voix off doit lire (au moins une phrase).',
      };
    if (motion && script.length > 3000)
      return {
        error:
          'Le texte de la voix off est trop long (3 000 caractères au maximum).',
      };
    if (!motion && !clips.length)
      return { error: 'Ajoute au moins une vidéo à monter.' };
    if (clips.some((c) => !rushAutorise(c.url, this.cloud, telegramId)))
      return { error: 'Une des vidéos ne vient pas de ton espace Postorico.' };
    const images = (d.images || []).slice(0, 10);
    if (images.some((im) => !imageAutorisee(im?.url, this.cloud, telegramId)))
      return { error: 'Une des images ne vient pas de ta banque Postorico.' };
    const format = FORMATS.includes(d.format as (typeof FORMATS)[number])
      ? (d.format as string)
      : '9:16';
    const reseau = RESEAUX[String(d.reseau || '').toLowerCase()] || 'Instagram';
    const consignes = String(d.consignes || '')
      .trim()
      .slice(0, 1500);
    const dureeMax = d.duree_max_s
      ? Math.max(5, Math.min(this.dureeMaxS, Math.round(Number(d.duree_max_s))))
      : this.dureeMaxS;

    // Garde-fou n°1 : la consigne ne doit parler que du montage (avant tout quota ou envoi)
    const refus = await this.consigneRefusee(consignes);
    if (refus) {
      this.logger.warn(
        `agent vidéo ${telegramId} : consigne refusée (${refus})`,
      );
      return {
        error:
          'Ta consigne doit décrire uniquement la vidéo voulue (style, rythme, textes, couleurs, illustrations…). Reformule-la sans demande technique.',
        status: 400,
      };
    }

    await this.quota.exigerAbonnement(telegramId);
    const q = await this.quota.consume(telegramId, ACTION_QUOTA);
    if (!q.ok)
      return {
        error: q.message || 'Quota de montages IA atteint.',
        status: 402,
      };

    let contenuId: string | null = null;
    try {
      const u = await this.marque.chargerMarque(telegramId);
      // Version allégée de la piste (passage retenu par le client) : le VPS la télécharge
      const musiqueUrl =
        d.musique && d.musique !== 'none'
          ? await this.musiques.urlDe(d.musique, telegramId, true)
          : null;
      const demande = {
        videos: clips.map((c) => c.url),
        consignes: composerConsignes(consignes, reseau, u),
        format,
        duree_max_s: dureeMax,
      };
      const creneau = await this.planning.prochainCreneau(
        telegramId,
        reseau,
        'Reel',
      );
      const contenu = await this.prisma.contenu.create({
        data: {
          telegram_id: telegramId,
          titre: (motion ? script : consignes || "Montage par l'IA").slice(
            0,
            60,
          ),
          contenu: (motion ? script : consignes) || null,
          type: normTypeContenu('Reel'),
          reseau_cible: reseau,
          statut: normStatutContenu('A valider'),
          video_status: 'en_traitement',
          reel_data: { agent: { statut: 'en_cours', format } },
          created_at: new Date(),
          ...(creneau ? { date_publication: creneau } : {}),
        } as never,
      });
      contenuId = contenu.id;

      // Préparation (transcription + coupe des silences) en arrière-plan, puis envoi au VPS
      const travail = await this.prisma.travaux_agent_video.create({
        data: {
          contenu_id: contenu.id,
          telegram_id: telegramId,
          statut: 'preparation',
          tentatives: 1,
          pris_le: new Date(),
          vu_le: new Date(),
          progression: motion
            ? 'Création de la voix off'
            : 'Transcription de la vidéo',
          brief: {
            ...demande,
            consignes_client: consignes,
            reseau,
            mode: motion ? 'motion' : 'video',
            ...(motion ? { script, voix: d.voix || null } : {}),
            illustrations: d.illustrations !== false,
            musique_url: musiqueUrl || '',
            musique_volume: Math.max(
              5,
              Math.min(100, Math.round(Number(d.musique_volume) || 25)),
            ),
            images: images.map((im) => ({
              url: im.url,
              description: String(im.description || '').slice(0, 200),
            })),
            logo_url:
              d.logo !== false &&
              typeof u.logo_url === 'string' &&
              /^https:\/\//.test(u.logo_url)
                ? u.logo_url
                : '',
          } as never,
        },
      });
      await this.quota.confirm(q);
      void this.preparerEtEnvoyer(travail.id);
      return {
        id: travail.id,
        contenu_id: contenu.id,
        video_status: 'en_traitement',
      };
    } catch (e) {
      await this.quota.refund(q);
      if (contenuId)
        await this.prisma.contenu
          .delete({ where: { id: contenuId } })
          .catch(() => undefined);
      this.logger.error(
        `agent vidéo création ${telegramId}: ${e instanceof Error ? e.message : e}`,
      );
      return {
        error: 'Impossible de lancer le montage, réessaie dans un instant.',
        status: 502,
      };
    }
  }

  /**
   * Avant le VPS, tout est prêt : chaque rush est transcrit par le service POC, Postorico calcule
   * les morceaux à garder (silences coupés) et recale la transcription, choisit les illustrations,
   * puis envoie le tout au VPS. Le serveur du VPS télécharge la vidéo d'origine et la coupe lui-même :
   * pas d'aller-retour de la vidéo par Postorico.
   */
  async preparerEtEnvoyer(id: string): Promise<void> {
    const t = await this.prisma.travaux_agent_video.findFirst({
      where: { id, statut: 'preparation' },
    });
    if (!t) return;
    const brief = (t.brief as Record<string, unknown>) || {};
    const motion = brief.mode === 'motion';
    let sources = (brief.videos as string[]) || [];
    const debut = Date.now();
    const aNettoyer: string[] = [];
    try {
      let voixUrl = '';
      if (motion) {
        await this.progression(id, 'Création de la voix off');
        voixUrl = await this.creerVoixOff(
          t.telegram_id,
          id,
          (brief.script as string) || '',
          (brief.voix as string) || null,
          aNettoyer,
        );
        sources = [voixUrl];
      }
      const coupes: Array<Array<[number, number]>> = [];
      const transcriptions: Array<{ language: string; words: Mot[] }> = [];
      for (const [i, url] of sources.entries()) {
        const n = sources.length > 1 ? ` ${i + 1}/${sources.length}` : '';
        await this.progression(
          id,
          motion
            ? 'Transcription de la voix off'
            : `Transcription de la vidéo${n}`,
        );
        // La transcription est le travail du service POC, jamais de l'agent : un essai de plus,
        // puis le montage s'arrête (quota rendu) plutôt que de partir sans elle
        let tr = await this.montagePoc.transcrireUrl(url);
        if (!tr.ok) {
          await this.progression(
            id,
            `Transcription de la vidéo${n} (nouvel essai)`,
          );
          tr = await this.montagePoc.transcrireUrl(url);
        }
        if (!tr.ok)
          throw new TranscriptionIndisponible(
            tr.error || 'service POC injoignable',
          );
        const mots = tr.words?.length ? tr.words : null;
        if (!mots) {
          // Le POC a bien répondu : la vidéo ne contient pas de parole, rien à couper
          coupes.push([]);
          transcriptions.push({ language: tr.language || 'fr', words: [] });
          continue;
        }
        if (motion) {
          // Voix de synthèse : rien à couper, les mots restent sur la voix telle quelle
          coupes.push([]);
          transcriptions.push({ language: tr.language || 'fr', words: mots });
          continue;
        }
        // Fin du dernier morceau : le serveur du VPS la ramène à la durée réelle de la vidéo
        const segs = segmentsGardes(mots, Number.POSITIVE_INFINITY);
        coupes.push(segs);
        transcriptions.push({
          language: tr.language || 'fr',
          words: motsRecales(mots, segs),
        });
      }

      const illustrations: Illustration[] = [];
      if (brief.illustrations !== false) {
        await this.progression(id, "Recherche des plans d'illustration");
        for (const [i, tr] of transcriptions.entries()) {
          if (tr.words.length)
            illustrations.push(
              ...(await this.illustrer(
                i,
                tr.words,
                tr.language,
                motion ? 7 : undefined,
              )),
            );
        }
      }
      this.logger.log(
        `agent vidéo ${id} : ${illustrations.length} illustration(s) (${illustrations.map((il) => il.type).join(', ') || 'aucune'})`,
      );

      await this.progression(id, 'Envoi au monteur IA');
      const demande = {
        ...(motion
          ? {
              mode: 'motion',
              voix_url: voixUrl,
              script: (brief.script as string) || '',
              videos: [],
            }
          : { videos: sources }),
        coupes,
        transcriptions,
        illustrations,
        images: (brief.images as unknown[]) || [],
        logo_url: (brief.logo_url as string) || '',
        musique_url: (brief.musique_url as string) || '',
        musique_volume: (brief.musique_volume as number) || 25,
        consignes: brief.consignes,
        format: brief.format,
        duree_max_s: brief.duree_max_s,
      };
      const r = await this.vps(
        '/montages',
        { method: 'POST', body: JSON.stringify(demande) },
        60_000,
      );
      const corps = (await r.json().catch(() => ({}))) as {
        id?: string;
        erreur?: string;
      };
      if (!r.ok || !corps.id)
        throw new Error(
          `VPS ${r.status} : ${corps.erreur || 'réponse sans id'}`,
        );
      await this.prisma.travaux_agent_video.update({
        where: { id },
        data: {
          statut: 'en_cours',
          vu_le: new Date(),
          progression: 'Envoyé au monteur IA',
          brief: {
            ...brief,
            vps_id: corps.id,
            version: 1,
            // Fichiers intermédiaires (voix off) supprimés de Cloudinary à la fin
            rushs_coupes: aNettoyer,
            // Ce qui est vraiment parti au VPS, pour comprendre un rendu sans illustration
            illustrations_envoyees: illustrations.map((il) => ({
              type: il.type,
              debut: il.debut,
              description: il.description.slice(0, 120),
            })),
            preparation_s: Math.round((Date.now() - debut) / 1000),
          } as never,
        },
      });
    } catch (e) {
      this.logger.error(
        `agent vidéo préparation ${id}: ${e instanceof Error ? e.message : e}`,
      );
      await this.nettoyerRushs({ rushs_coupes: aNettoyer });
      await this.echouer(
        id,
        e instanceof TranscriptionIndisponible
          ? "La transcription n'a pas pu être faite (service de transcription injoignable). Réessaie dans quelques minutes."
          : 'La préparation de la vidéo a échoué.',
      );
    }
  }

  /**
   * Plans d'illustration d'un rush : Claude Haiku choisit les moments concrets, Pexels donne un
   * plan vertical pour chacun. Jamais bloquant : en cas de souci, le montage part sans illustration.
   */
  async illustrer(
    rush: number,
    mots: Mot[],
    langue: string,
    max?: number,
  ): Promise<Illustration[]> {
    try {
      const rep = await this.claude.messagesCreate({
        model: MODELE_ILLUSTRATIONS,
        max_tokens: 600,
        messages: [
          { role: 'user', content: consigneMoments(mots, langue, max) },
        ],
      });
      const choix = lireChoix(this.claude.texte(rep), mots, max);
      const out: Illustration[] = [];
      for (const c of choix) {
        const passage = `« ${contexte(mots, c.i)} »`;
        if (c.type === 'schema') {
          // Dessiné par l'agent : pas de fichier, juste ce qu'il doit montrer
          out.push({
            type: 'schema',
            rush,
            debut: mots[c.i].start,
            duree: 3.5,
            description: `${c.query} — ${passage}`,
          });
          continue;
        }
        const url = this.pexelsCle ? await this.pexelsVideo(c.query) : null;
        if (!url) continue;
        out.push({
          type: 'broll',
          url,
          rush,
          debut: mots[c.i].start,
          duree: 2.5,
          description: `${c.query} — ${passage}`,
        });
      }
      return out;
    } catch (e) {
      this.logger.warn(
        `agent vidéo illustrations rush ${rush + 1}: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }
  }

  private async pexelsVideo(requete: string): Promise<string | null> {
    try {
      const url = `https://api.pexels.com/videos/search?${new URLSearchParams({ query: requete, orientation: 'portrait', per_page: '5' })}`;
      const r = await fetch(url, {
        headers: { Authorization: this.pexelsCle },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return null;
      const corps = (await r.json()) as {
        videos?: Array<{
          duration?: number;
          video_files?: Array<{
            link?: string;
            width?: number;
            height?: number;
            file_type?: string;
          }>;
        }>;
      };
      for (const v of corps.videos || []) {
        if ((v.duration || 0) < 3) continue;
        const lien = meilleurFichier(v.video_files || []);
        if (lien) return lien;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Raison du refus si la consigne sort du montage, sinon null (avis IA indisponible : on laisse passer). */
  async consigneRefusee(consignes: string): Promise<string | null> {
    if (!consignes) return null;
    const motif = motifSuspect(consignes);
    if (motif) return `motif « ${motif} »`;
    try {
      const rep = await this.claude.messagesCreate({
        model: MODELE_ILLUSTRATIONS,
        max_tokens: 100,
        messages: [{ role: 'user', content: consigneClassement(consignes) }],
      });
      const avis = lireClassement(this.claude.texte(rep));
      return avis.ok ? null : `IA : ${avis.raison || 'hors montage'}`;
    } catch (e) {
      this.logger.warn(
        `agent vidéo contrôle de consigne indisponible : ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  /** Voix off ElevenLabs du script, déposée sur Cloudinary (le POC la transcrit, le VPS l'anime). */
  async creerVoixOff(
    telegramId: string,
    travailId: string,
    script: string,
    voix: string | null,
    aNettoyer: string[],
  ): Promise<string> {
    const langue = await this.voix.langueDuCompte(telegramId);
    const choix = voix || (await this.voix.catalogue(telegramId)).defaut;
    const voiceId = await this.voix.resoudre(telegramId, choix);
    if (!voiceId) throw new Error(`voix inconnue : ${choix}`);
    const mp3 = await this.voix.synthese(script, voiceId, undefined, langue);
    const dossier = await mkdtemp(path.join(tmpdir(), 'agent-voix-'));
    try {
      const fichier = path.join(dossier, 'voix.mp3');
      await writeFile(fichier, mp3);
      const up = await envoyerGrosFichier(fichier, {
        resource_type: 'video',
        folder: `videos_raw/${telegramId}`,
        public_id: `agent_voix_${travailId}`,
        overwrite: true,
      });
      aNettoyer.push(up.public_id);
      return up.secure_url;
    } finally {
      await rm(dossier, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async progression(id: string, texte: string): Promise<void> {
    await this.prisma.travaux_agent_video
      .update({
        where: { id },
        data: { progression: texte, vu_le: new Date() },
      })
      .catch(() => undefined);
  }

  /** Supprime de Cloudinary les rushes coupés intermédiaires (le montage final est gardé). */
  private async nettoyerRushs(brief: unknown): Promise<void> {
    const ids =
      ((brief as Record<string, unknown>)?.rushs_coupes as string[]) || [];
    for (const pid of ids)
      await cloudinary.uploader
        .destroy(pid, { resource_type: 'video', invalidate: true })
        .catch(() => undefined);
  }

  /** Avancement d'un montage, pour l'écran d'attente du client. */
  async etat(telegramId: string, id: string) {
    const t = await this.prisma.travaux_agent_video.findFirst({
      where: { id, telegram_id: telegramId },
    });
    if (!t) return null;
    const c = await this.prisma.contenu.findUnique({
      where: { id: t.contenu_id },
      select: {
        video_url: true,
        video_preview_url: true,
        titre: true,
        reel_data: true,
      },
    });
    const agent =
      ((c?.reel_data as Record<string, unknown>)?.agent as Record<
        string,
        unknown
      >) || {};
    return {
      id: t.id,
      contenu_id: t.contenu_id,
      statut: t.statut,
      progression: t.progression,
      erreur: t.statut === 'echec' ? t.erreur : null,
      debut: t.pris_le || t.created_at,
      fin: t.fini_le,
      video_url: t.statut === 'termine' ? c?.video_url || null : null,
      video_preview_url:
        t.statut === 'termine' ? c?.video_preview_url || null : null,
      titre: c?.titre || null,
      resume: (agent.resume as string) || null,
      ...this.infosCorrections(t),
    };
  }

  /** Version, corrections faites et restantes, et si une correction est encore possible. */
  private infosCorrections(t: {
    statut: string;
    erreur: string | null;
    fini_le: Date | null;
    brief: unknown;
  }) {
    const brief = (t.brief as Record<string, unknown>) || {};
    const corrections =
      (brief.corrections as Array<Record<string, unknown>>) || [];
    const derniere = corrections[corrections.length - 1];
    // Les fichiers de travail restent 7 jours sur le VPS après la dernière version
    const recent = t.fini_le
      ? Date.now() - t.fini_le.getTime() < 6.5 * 24 * 3600_000
      : false;
    return {
      version: Number(brief.version) || 1,
      corrections: corrections.length,
      corrections_gratuites_restantes: Math.max(
        0,
        CORRECTIONS_GRATUITES - corrections.length,
      ),
      correction_possible:
        t.statut === 'termine' && Boolean(brief.vps_id) && recent,
      erreur_correction:
        t.statut === 'termine' && derniere?.echec
          ? (derniere.echec as string)
          : null,
    };
  }

  // -------------------------------------------------------------------------------- suivi

  /** Interroge le VPS pour chaque montage en cours ; récupère ceux qui sont finis. */
  async suivre(maintenant = new Date()): Promise<void> {
    if (this.suiviEnCours) return;
    this.suiviEnCours = true;
    try {
      // Préparation bloquée (serveur redémarré pendant la coupe, POC muet…) : abandon après 30 min
      const bloques = await this.prisma.travaux_agent_video.findMany({
        where: {
          statut: 'preparation',
          created_at: {
            lt: new Date(maintenant.getTime() - PREPARATION_MAX_MIN * 60_000),
          },
        },
        select: { id: true },
      });
      for (const b of bloques)
        await this.echouer(
          b.id,
          'La préparation de la vidéo a pris trop de temps.',
        );

      const enCours = await this.prisma.travaux_agent_video.findMany({
        where: { statut: 'en_cours' },
        orderBy: { created_at: 'asc' },
        take: 20,
      });
      for (const t of enCours) {
        const vpsId = (t.brief as Record<string, unknown>)?.vps_id as
          string | undefined;
        if (!vpsId) {
          await this.echouer(t.id, 'Montage sans identifiant VPS.');
          continue;
        }
        let e: EtatVps | null = null;
        try {
          const r = await this.vps(`/montages/${vpsId}`);
          if (r.status === 404) {
            await this.echouer(
              t.id,
              'Le monteur IA ne connaît plus ce montage.',
            );
            continue;
          }
          if (r.ok) e = (await r.json()) as EtatVps;
        } catch (err) {
          this.logger.warn(
            `agent vidéo suivi ${t.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
        if (!e) {
          // VPS injoignable : on patiente, puis on abandonne passé le délai
          if (
            maintenant.getTime() - t.created_at.getTime() >
            ABANDON_MIN * 60_000
          )
            await this.echouer(t.id, 'Le monteur IA ne répond plus.');
          continue;
        }
        if (e.statut === 'termine') {
          // Une récupération bloquée (envoi Cloudinary muet) ne doit pas figer le suivi des autres,
          // ni être lancée deux fois en parallèle pour le même montage
          if (this.recuperations.has(t.id)) continue;
          this.recuperations.add(t.id);
          const enCoursDe = this.recuperer(t.id, vpsId, e).finally(() =>
            this.recuperations.delete(t.id),
          );
          let minuteur: NodeJS.Timeout | undefined;
          const limite = new Promise<void>((resolve) => {
            minuteur = setTimeout(resolve, RECUPERATION_MAX_MS);
          });
          await Promise.race([enCoursDe, limite]);
          clearTimeout(minuteur);
        } else if (e.statut === 'echec')
          await this.echouer(
            t.id,
            e.erreur || 'Le montage a échoué.',
            e.cout_usd,
          );
        else if (
          maintenant.getTime() - t.created_at.getTime() >
          ABANDON_MIN * 60_000
        )
          await this.echouer(t.id, 'Montage trop long, abandonné.');
        else
          await this.prisma.travaux_agent_video.update({
            where: { id: t.id },
            data: {
              vu_le: maintenant,
              progression: (e.statut === 'en_attente' && e.avant
                ? `En file d'attente : ${e.avant} montage${e.avant > 1 ? 's' : ''} avant le tien`
                : e.progression || 'En cours'
              ).slice(0, 300),
            },
          });
      }
    } catch (err) {
      this.logger.error(
        `agent vidéo suivi: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.suiviEnCours = false;
    }
  }

  /** Télécharge le MP4 du VPS, l'envoie sur Cloudinary, puis le contenu passe « prêt ». */
  async recuperer(id: string, vpsId: string, e: EtatVps): Promise<void> {
    const t = await this.prisma.travaux_agent_video.findFirst({
      where: { id, statut: 'en_cours' },
    });
    if (!t) return;
    await this.prisma.travaux_agent_video.update({
      where: { id },
      data: { progression: 'Récupération de la vidéo' },
    });
    const dossier = await mkdtemp(path.join(tmpdir(), 'agent-video-'));
    try {
      const r = await this.vps(`/montages/${vpsId}/video`, {}, 10 * 60_000);
      if (!r.ok || !r.body) throw new Error(`téléchargement VPS ${r.status}`);
      const fichier = path.join(dossier, 'final.mp4');
      await pipeline(
        Readable.fromWeb(r.body as unknown as WebReadableStream),
        createWriteStream(fichier),
      );
      const video = await envoyerGrosFichier(fichier, {
        resource_type: 'video',
        public_id: `reels/${t.telegram_id}/${t.contenu_id}`,
        overwrite: true,
        invalidate: true,
      });
      const duree = Number(video.duration ?? e.duree_s ?? 0);
      const cout =
        typeof e.cout_usd === 'number' && Number.isFinite(e.cout_usd)
          ? e.cout_usd
          : null;
      const apercu = apercuDe(video.secure_url);
      const version =
        Number(((t.brief as Record<string, unknown>) || {}).version) || 1;
      // Le coût cumule montage et corrections
      const coutTotal =
        cout === null ? t.cout_usd : Number(t.cout_usd || 0) + cout;
      await this.prisma.travaux_agent_video.update({
        where: { id },
        data: {
          statut: 'termine',
          fini_le: new Date(),
          duree_s: duree || null,
          cout_usd: coutTotal,
          progression: 'Terminé',
          erreur: null,
        },
      });
      await this.nettoyerRushs(t.brief);
      const c = await this.prisma.contenu.findUnique({
        where: { id: t.contenu_id },
        select: { reel_data: true, reseau_cible: true },
      });
      if (c) {
        await this.prisma.contenu.update({
          where: { id: t.contenu_id },
          data: {
            video_url: video.secure_url,
            video_preview_url: apercu,
            lien_visuel: apercu,
            video_status: 'ready',
            reel_data: {
              ...((c.reel_data as Record<string, unknown>) || {}),
              agent: {
                statut: 'termine',
                version,
                resume: String(e.resume || '').slice(0, 1000) || null,
                cout_usd: coutTotal === null ? null : Number(coutTotal),
                duree_s: duree || null,
              },
            } as never,
          },
        });
        await this.notifications.notifier(
          t.telegram_id,
          t.contenu_id,
          c.reseau_cible,
          'reel.ready',
          version > 1
            ? 'Ta vidéo corrigée est prête 🎬'
            : 'Ton montage IA est prêt 🎬',
          'À valider dans Contenus.',
        );
      }
      if (cout !== null)
        await this.usage
          .log(
            t.telegram_id,
            ACTION_QUOTA,
            'claude-code',
            undefined,
            0,
            undefined,
            cout,
          )
          .catch(() => undefined);
    } catch (err) {
      // On réessaiera au prochain passage (le MP4 reste sur le VPS) ; abandon après le délai
      this.logger.error(
        `agent vidéo récupération ${id}: ${err instanceof Error ? err.message : err}`,
      );
      await this.prisma.travaux_agent_video
        .update({
          where: { id },
          data: { progression: 'Récupération de la vidéo (nouvel essai)' },
        })
        .catch(() => undefined);
    } finally {
      await rm(dossier, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /** Échec définitif : contenu en échec, quota rendu, client prévenu. */
  async echouer(
    id: string,
    erreur: string,
    coutUsd?: number | null,
  ): Promise<boolean> {
    const t = await this.prisma.travaux_agent_video.findFirst({
      where: { id, statut: { in: ['preparation', 'en_cours', 'en_attente'] } },
    });
    if (!t) return false;
    const briefT = (t.brief as Record<string, unknown>) || {};
    if (Number(briefT.version) > 1)
      return this.echouerCorrection(t, erreur, coutUsd);
    await this.nettoyerRushs(t.brief);
    const message = String(erreur || 'Erreur inconnue').slice(0, 500);
    const cout =
      typeof coutUsd === 'number' && Number.isFinite(coutUsd) ? coutUsd : null;
    if (cout !== null)
      await this.usage
        .log(
          t.telegram_id,
          ACTION_QUOTA,
          'claude-code',
          undefined,
          0,
          undefined,
          cout,
        )
        .catch(() => undefined);
    await this.prisma.travaux_agent_video.update({
      where: { id },
      data: {
        statut: 'echec',
        fini_le: new Date(),
        erreur: message,
        cout_usd: cout,
        progression: 'Échec',
      },
    });
    const c = await this.prisma.contenu.findUnique({
      where: { id: t.contenu_id },
      select: { reel_data: true, reseau_cible: true },
    });
    if (c) {
      await this.prisma.contenu.update({
        where: { id: t.contenu_id },
        data: {
          video_status: 'echec',
          reel_data: {
            ...((c.reel_data as Record<string, unknown>) || {}),
            agent: { statut: 'echec', erreur: message },
          } as never,
        },
      });
      await this.notifications.notifier(
        t.telegram_id,
        t.contenu_id,
        c.reseau_cible,
        'reel.echec',
        'Montage IA : échec ❌',
        "Le montage n'a pas abouti (montage rendu sur ton quota). Supprime-le et réessaie.",
      );
    }
    await this.quota.refundByUser(t.telegram_id, ACTION_QUOTA);
    return true;
  }

  // -------------------------------------------------------------------------------- corrections

  /**
   * Le client demande une correction du montage terminé (« enlève… », « rajoute… », nouvelles
   * images). L'agent reprend son script sur le VPS et refait le rendu : la nouvelle version remplace
   * la vidéo dans Contenus. CORRECTIONS_GRATUITES par montage, puis chacune compte comme un montage.
   */
  async corriger(
    telegramId: string,
    id: string,
    d: { consignes?: string | null; images?: ImageClient[] | null },
  ): Promise<
    | Awaited<ReturnType<AgentVideoService['etat']>>
    | { error: string; status?: number }
  > {
    if (!this.actif)
      return {
        error: "Le montage par l'IA est momentanément indisponible.",
        status: 503,
      };
    const t = await this.prisma.travaux_agent_video.findFirst({
      where: { id, telegram_id: telegramId },
    });
    if (!t) return { error: 'Montage introuvable.', status: 404 };
    const brief = (t.brief as Record<string, unknown>) || {};
    if (t.statut !== 'termine' || !brief.vps_id)
      return {
        error: 'Ce montage ne peut pas être corrigé pour le moment.',
        status: 409,
      };
    const consignes = String(d.consignes || '')
      .trim()
      .slice(0, 1500);
    if (!consignes) return { error: 'Décris la correction que tu veux.' };
    const images = (d.images || []).slice(0, 10);
    if (images.some((im) => !imageAutorisee(im?.url, this.cloud, telegramId)))
      return { error: 'Une des images ne vient pas de ta banque Postorico.' };
    // Même garde-fou que pour la consigne du montage
    const refus = await this.consigneRefusee(consignes);
    if (refus) {
      this.logger.warn(
        `agent vidéo ${telegramId} : correction refusée (${refus})`,
      );
      return {
        error:
          'Ta demande doit porter uniquement sur la vidéo (retirer, ajouter, déplacer, changer un texte…). Reformule-la.',
        status: 400,
      };
    }
    const faites = Array.isArray(brief.corrections)
      ? (brief.corrections as unknown[]).length
      : 0;
    const payante = faites >= CORRECTIONS_GRATUITES;
    const q = payante
      ? await this.quota.consume(telegramId, ACTION_QUOTA)
      : null;
    if (q && !q.ok)
      return {
        error: q.message || 'Quota de montages IA atteint.',
        status: 402,
      };

    const r = await this.vps(
      `/montages/${brief.vps_id as string}/corrections`,
      {
        method: 'POST',
        body: JSON.stringify({
          consignes,
          images: images.map((im) => ({
            url: im.url,
            description: String(im.description || '').slice(0, 200),
          })),
        }),
      },
    ).catch(() => null);
    const corps = r
      ? ((await r.json().catch(() => ({}))) as {
          version?: number;
          erreur?: string;
        })
      : {};
    if (!r || !r.ok) {
      if (q) await this.quota.refund(q);
      if (r && (r.status === 404 || r.status === 409))
        return {
          error:
            'Les fichiers de ce montage ne sont plus disponibles (7 jours après le montage). Lance un nouveau montage.',
          status: 409,
        };
      return {
        error: 'Impossible de joindre le monteur IA, réessaie dans un instant.',
        status: 502,
      };
    }
    if (q) await this.quota.confirm(q);
    const version = Number(corps.version) || faites + 2;
    await this.prisma.travaux_agent_video.update({
      where: { id },
      data: {
        statut: 'en_cours',
        vu_le: new Date(),
        fini_le: null,
        erreur: null,
        progression: 'Correction envoyée au monteur IA',
        brief: {
          ...brief,
          version,
          corrections: [
            ...((brief.corrections as unknown[]) || []),
            {
              version,
              consignes,
              images: images.length,
              payante,
              demandee: new Date().toISOString(),
            },
          ],
        } as never,
      },
    });
    const c = await this.prisma.contenu.findUnique({
      where: { id: t.contenu_id },
      select: { reel_data: true },
    });
    if (c)
      await this.prisma.contenu.update({
        where: { id: t.contenu_id },
        data: {
          video_status: 'en_traitement',
          reel_data: {
            ...((c.reel_data as Record<string, unknown>) || {}),
            agent: {
              ...((((c.reel_data as Record<string, unknown>) || {})
                .agent as object) || {}),
              statut: 'correction',
              version,
            },
          } as never,
        },
      });
    return this.etat(telegramId, id);
  }

  /** Correction ratée : la version précédente reste en place, quota rendu si la correction était payante. */
  private async echouerCorrection(
    t: { id: string; telegram_id: string; contenu_id: string; brief: unknown },
    erreur: string,
    coutUsd?: number | null,
  ): Promise<boolean> {
    const brief = (t.brief as Record<string, unknown>) || {};
    const message = String(erreur || 'Erreur inconnue').slice(0, 300);
    const cout =
      typeof coutUsd === 'number' && Number.isFinite(coutUsd) ? coutUsd : null;
    if (cout !== null)
      await this.usage
        .log(
          t.telegram_id,
          ACTION_QUOTA,
          'claude-code',
          undefined,
          0,
          undefined,
          cout,
        )
        .catch(() => undefined);
    const corrections = (
      (brief.corrections as Array<Record<string, unknown>>) || []
    ).slice();
    const derniere = corrections[corrections.length - 1];
    if (derniere) derniere.echec = message;
    await this.prisma.travaux_agent_video.update({
      where: { id: t.id },
      data: {
        statut: 'termine',
        fini_le: new Date(),
        erreur: message,
        progression: 'Correction impossible, version précédente conservée',
        brief: {
          ...brief,
          version: Math.max(1, Number(brief.version) - 1),
          corrections,
        } as never,
      },
    });
    const c = await this.prisma.contenu.findUnique({
      where: { id: t.contenu_id },
      select: { reel_data: true, reseau_cible: true },
    });
    if (c) {
      await this.prisma.contenu.update({
        where: { id: t.contenu_id },
        data: {
          video_status: 'ready',
          reel_data: {
            ...((c.reel_data as Record<string, unknown>) || {}),
            agent: {
              ...((((c.reel_data as Record<string, unknown>) || {})
                .agent as object) || {}),
              statut: 'termine',
              erreur_correction: message,
            },
          } as never,
        },
      });
      await this.notifications.notifier(
        t.telegram_id,
        t.contenu_id,
        c.reseau_cible,
        'reel.echec',
        'Correction impossible',
        'Ta vidéo précédente est conservée. Reformule la correction et réessaie.',
      );
    }
    if (derniere?.payante)
      await this.quota.refundByUser(t.telegram_id, ACTION_QUOTA);
    return true;
  }
}
