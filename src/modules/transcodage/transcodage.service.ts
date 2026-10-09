import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Semaphore } from '../../common/utils/semaphore.util';

const execFileP = promisify(execFile);

/**
 * Passage par ffmpeg d'une vidéo importée, AVANT son envoi à Cloudinary.
 *
 * Un clip de téléphone (HEVC, .mov, 50 Mo et plus) est ramené en MP4 H.264 + AAC, lecture
 * progressive (faststart), plus grand côté borné : l'envoi est plusieurs fois plus léger
 * (fini les délais dépassés), le format est celui que lisent partout le montage, Remotion et
 * les réseaux. Une vidéo déjà propre (H.264 en MP4, assez petite, débit raisonnable) part telle
 * quelle.
 *
 * Ne fait JAMAIS échouer un import : ffmpeg absent, erreur, délai ou file d'attente trop
 * longue -> on garde l'original. Conversions simultanées bornées (le processeur est partagé
 * avec l'API).
 */

export interface SondeVideo {
  codec: string | null;
  largeur: number;
  hauteur: number;
  duree: number;
  debitKbps: number | null;
  conteneur: string;
}

export interface ResultatTranscodage {
  data: Buffer;
  transcode: boolean;
  raison: string;
  octetsAvant: number;
  octetsApres: number;
  duree?: number;
}

/** Débit au-delà duquel un H.264 « propre » est quand même recompressé (un téléphone filme à 15-20 Mb/s). */
const DEBIT_MAX_KBPS = 8000;

/** Faut-il convertir ? (fonction pure, testée) */
export function doitTranscoder(s: SondeVideo, coteMax: number): { oui: boolean; raison: string } {
  if (s.codec !== 'h264') return { oui: true, raison: `codec ${s.codec ?? 'inconnu'}` };
  if (!/mp4|mov/.test(s.conteneur)) return { oui: true, raison: `conteneur ${s.conteneur}` };
  if (Math.max(s.largeur, s.hauteur) > coteMax) return { oui: true, raison: `${s.largeur}x${s.hauteur} > ${coteMax}` };
  if (s.debitKbps !== null && s.debitKbps > DEBIT_MAX_KBPS) return { oui: true, raison: `débit ${Math.round(s.debitKbps)} kb/s` };
  return { oui: false, raison: 'déjà propre' };
}

/** Arguments ffmpeg (fonction pure, testée). Plus grand côté ramené à `coteMax`, dimensions paires. */
export function argumentsFfmpeg(entree: string, sortie: string, coteMax: number, crf: number): string[] {
  const l = `trunc(min(${coteMax}\\,iw)/2)*2`;
  const h = `trunc(min(${coteMax}\\,ih)/2)*2`;
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', entree,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Paysage : on borne la largeur ; portrait : la hauteur (la rotation du téléphone est
    // appliquée par ffmpeg avant le filtre).
    '-vf', `scale='if(gte(iw,ih),${l},-2)':'if(gte(iw,ih),-2,${h})'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    sortie,
  ];
}

export function lireSonde(json: string): SondeVideo {
  const d = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const v = (d.streams || [])[0] || {};
  const n = (x: unknown) => (x === undefined || x === null || x === 'N/A' ? null : Number(x));
  const debit = n(v.bit_rate) ?? n(d.format?.bit_rate);
  return {
    codec: (v.codec_name as string) || null,
    largeur: n(v.width) || 0,
    hauteur: n(v.height) || 0,
    duree: n(d.format?.duration) || 0,
    debitKbps: debit === null ? null : debit / 1000,
    conteneur: String(d.format?.format_name || ''),
  };
}

@Injectable()
export class TranscodageService {
  private readonly logger = new Logger(TranscodageService.name);
  private readonly file: Semaphore;
  private ffmpegAbsent = false;

  constructor(config: ConfigService) {
    const max = config.get<number>('app.transcodageSimultanes') || 2;
    this.file = new Semaphore(max, () => new Error('file de conversion pleine'));
  }

  /**
   * @param coteMax plus grand côté en sortie (1280 = 720p, 1920 = 1080p)
   * @param crf qualité x264 (plus bas = meilleure qualité, plus lourd)
   */
  async preparer(data: Buffer, opts: { coteMax: number; crf?: number }): Promise<ResultatTranscodage> {
    const garder = (raison: string, duree?: number): ResultatTranscodage => ({ data, transcode: false, raison, octetsAvant: data.length, octetsApres: data.length, duree });
    if (this.ffmpegAbsent) return garder('ffmpeg absent');

    const base = path.join(os.tmpdir(), `transco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const entree = `${base}_in`;
    const sortie = `${base}_out.mp4`;
    let jeton = false;
    try {
      await fs.promises.writeFile(entree, data);
      let sonde: SondeVideo;
      try {
        const { stdout } = await execFileP('ffprobe', [
          '-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,width,height,bit_rate:format=duration,bit_rate,format_name',
          '-of', 'json', entree,
        ], { timeout: 30_000 });
        sonde = lireSonde(stdout);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.ffmpegAbsent = true;
          this.logger.warn('ffprobe/ffmpeg introuvables : vidéos envoyées sans conversion');
          return garder('ffmpeg absent');
        }
        return garder(`sonde impossible (${e instanceof Error ? e.message.slice(0, 120) : e})`);
      }

      const decision = doitTranscoder(sonde, opts.coteMax);
      if (!decision.oui) return garder(decision.raison, sonde.duree);

      try {
        await this.file.acquire(5 * 60_000);
        jeton = true;
      } catch {
        return garder('file de conversion pleine', sonde.duree);
      }
      const delai = Math.max(180_000, sonde.duree * 4000);
      const debut = Date.now();
      await execFileP('ffmpeg', argumentsFfmpeg(entree, sortie, opts.coteMax, opts.crf ?? 23), { timeout: delai, maxBuffer: 4 * 1024 * 1024 });
      const converti = await fs.promises.readFile(sortie);
      // Une conversion qui grossit le fichier n'apporte rien si l'original était déjà en H.264.
      if (sonde.codec === 'h264' && converti.length >= data.length) return garder('conversion plus lourde', sonde.duree);
      this.logger.log(
        `vidéo convertie (${decision.raison}) : ${(data.length / 1e6).toFixed(1)} Mo -> ${(converti.length / 1e6).toFixed(1)} Mo en ${((Date.now() - debut) / 1000).toFixed(1)} s`,
      );
      return { data: converti, transcode: true, raison: decision.raison, octetsAvant: data.length, octetsApres: converti.length, duree: sonde.duree };
    } catch (e) {
      this.logger.warn(`conversion vidéo impossible, envoi de l'original : ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      return garder('erreur ffmpeg');
    } finally {
      if (jeton) this.file.release();
      fs.unlink(entree, () => undefined);
      fs.unlink(sortie, () => undefined);
    }
  }
}
