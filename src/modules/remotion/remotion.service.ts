import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Semaphore } from '../../common/utils/semaphore.util';
import { UsageService } from '../usage/usage.service';

const execFileP = promisify(execFile);

/**
 * Rendu Remotion partagé (Reels + Story animée) — port direct de
 * backend/services/remotion_service.py. Deux chemins, selon que `REMOTION_RENDER_URL`
 * est configuré :
 * - service : POST vers le service Node persistant déjà présent dans
 *   `backend/remotion/server` (bundle une seule fois, 2-3x plus rapide) — chemin
 *   recommandé, celui que ce port utilise en pratique.
 * - subprocess : `npx remotion render`, qui re-bundle à chaque appel (chemin historique,
 *   gardé pour fidélité et comme repli).
 */

export class AtelierSatureError extends Error {}

const REMOTION_RENDUS_SIMULTANES_DEFAUT = 2;
const REMOTION_ATTENTE_MAX_S_DEFAUT = 150;

@Injectable()
export class RemotionService {
  private readonly logger = new Logger(RemotionService.name);
  private readonly remotionDir: string;
  private readonly remotionBrowser: string;
  private readonly renderUrl: string;
  private readonly crf: number;
  private readonly coutMinuteUsd: number;
  private readonly attenteMaxS: number;
  private readonly atelier: Semaphore;

  constructor(
    private readonly usageService: UsageService,
    config: ConfigService,
  ) {
    // <postorico>/../backend/remotion — même projet Remotion que le backend Python,
    // rien n'est dupliqué (voir backend/remotion/server/render.service.ts).
    this.remotionDir = config.get<string>('app.remotionDir') || path.join(__dirname, '..', '..', '..', '..', 'backend', 'remotion');
    this.remotionBrowser = config.get<string>('app.remotionBrowser') || '';
    this.renderUrl = config.get<string>('app.remotionRenderUrl') || '';
    this.crf = config.get<number>('app.remotionCrf') ?? 23;
    this.coutMinuteUsd = config.get<number>('app.remotionCoutMinuteUsd') ?? 0.0014;
    this.attenteMaxS = config.get<number>('app.remotionAttenteMaxS') ?? REMOTION_ATTENTE_MAX_S_DEFAUT;
    const rendusSimultanes = config.get<number>('app.remotionRendusSimultanes') ?? REMOTION_RENDUS_SIMULTANES_DEFAUT;
    this.atelier = new Semaphore(rendusSimultanes, () => new AtelierSatureError());
  }

  /** Les ids de composition déclarés dans le projet Remotion de CETTE instance (Root.tsx).
   * La base est partagée entre le local et la prod : un worker ne doit réclamer que les
   * jobs qu'il sait rendre, sinon une composition nouvelle sur dev échoue en prod. */
  compositionsConnues(): string[] {
    try {
      const src = fs.readFileSync(path.join(this.remotionDir, 'src', 'Root.tsx'), 'utf-8');
      const ids = new Set<string>();
      for (const m of src.matchAll(/id="([A-Za-z0-9_-]+)"/g)) ids.add(m[1]);
      return [...ids].sort();
    } catch (e) {
      this.logger.warn(`compositions connues illisibles : ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Toutes les URLs de vidéos Cloudinary TRANSFORMÉES (so_/du_/c_fill…) présentes dans
   * les props, à n'importe quelle profondeur. */
  private urlsVideoCloudinary(obj: unknown, acc: string[] = []): string[] {
    if (obj && typeof obj === 'object') {
      for (const v of Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>)) {
        this.urlsVideoCloudinary(v, acc);
      }
    } else if (typeof obj === 'string' && obj.includes('res.cloudinary.com') && obj.includes('/video/upload/')) {
      const fin = obj.split('/video/upload/')[1] || '';
      const premierSegment = fin.split('/')[0] || '';
      if (!fin.startsWith('v1') && premierSegment.includes(',')) acc.push(obj);
    }
    return acc;
  }

  /** Cloudinary fabrique un extrait vidéo transformé à la première demande et répond 423
   * tant qu'il n'est pas prêt ; Remotion prend ce 423 pour une erreur. On demande donc
   * chaque extrait AVANT de lancer le rendu, et on attend qu'il réponde 200. */
  private async prechaufferMedias(props: Record<string, unknown>, attenteMaxS = 150): Promise<void> {
    const urls = [...new Set(this.urlsVideoCloudinary(props))];
    if (!urls.length) return;
    const depart = Date.now();
    const enAttente = new Set(urls);
    while (enAttente.size && (Date.now() - depart) / 1000 < attenteMaxS) {
      for (const u of [...enAttente]) {
        try {
          const r = await fetch(u, { headers: { Range: 'bytes=0-0' } });
          if (r.status === 200 || r.status === 206) enAttente.delete(u);
          else if (![423, 425, 429].includes(r.status)) {
            this.logger.warn(`préchauffage média ${r.status} : ${u.slice(0, 120)}`);
            enAttente.delete(u); // erreur franche : Remotion la signalera
          }
        } catch (e) {
          this.logger.warn(`préchauffage média : ${e instanceof Error ? e.message : e}`);
        }
      }
      if (enAttente.size) await new Promise((r) => setTimeout(r, 3000));
    }
    if (enAttente.size) {
      this.logger.warn(`préchauffage média : ${enAttente.size} extrait(s) toujours en préparation après ${attenteMaxS}s`);
    } else {
      this.logger.log(`préchauffage média : ${urls.length} extrait(s) prêt(s) en ${Math.round((Date.now() - depart) / 1000)}s`);
    }
  }

  /** Lance le rendu Remotion. Retourne le chemin du MP4 (temporaire — l'appelant doit le
   * supprimer après upload). Journalise le coût/durée dans usage_log si `telegramId` fourni. */
  async renderMp4(
    props: Record<string, unknown>,
    composition: string,
    opts: { telegramId?: string; etiquette?: string; prefix?: string } = {},
  ): Promise<string> {
    const prefix = opts.prefix || 'remotion';
    await this.prechaufferMedias(props); // avant de prendre l'atelier : c'est du réseau, pas du CPU
    await this.atelier.acquire(this.attenteMaxS * 1000);
    const depart = Date.now();
    let ok = false;
    try {
      const outPath = this.renderUrl
        ? await this.rendreViaService(props, composition, prefix)
        : await this.rendreViaSubprocess(props, composition, prefix);
      ok = true;
      return outPath;
    } finally {
      this.atelier.release();
      const dureeS = (Date.now() - depart) / 1000;
      if (opts.telegramId) {
        try {
          await this.usageService.log(
            opts.telegramId,
            ok ? `${prefix}_rendu` : `${prefix}_rendu_echec`,
            opts.etiquette || composition,
            undefined,
            0,
            undefined,
            Math.round(((dureeS / 60) * this.coutMinuteUsd + Number.EPSILON) * 1e6) / 1e6,
            dureeS,
          );
        } catch (e) {
          this.logger.warn(`journal du rendu ${composition}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  /** Chemin service : POST vers le service Node persistant (bundle unique au démarrage). */
  private async rendreViaService(props: Record<string, unknown>, composition: string, prefix: string): Promise<string> {
    const outPath = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    let resp: Response;
    try {
      resp = await fetch(`${this.renderUrl}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition, props, crf: this.crf }),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (e) {
      throw new Error(`service de rendu Remotion injoignable (${this.renderUrl}) : ${e instanceof Error ? e.message : e}`);
    }
    if (resp.status === 503) throw new AtelierSatureError();
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`rendu remotion (service, code ${resp.status}) : ${text.slice(0, 800)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    await fs.promises.writeFile(outPath, buf);
    return outPath;
  }

  /** Chemin historique : `npx remotion render`, qui re-bundle le projet à chaque appel. */
  private async rendreViaSubprocess(props: Record<string, unknown>, composition: string, prefix: string): Promise<string> {
    if (!fs.existsSync(path.join(this.remotionDir, 'node_modules'))) {
      throw new Error(`Remotion non installé (${this.remotionDir}) : lancer \`npm ci\` dans ce dossier.`);
    }
    const propsPath = path.join(os.tmpdir(), `remotion_props_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    await fs.promises.writeFile(propsPath, JSON.stringify(props), 'utf-8');
    const outPath = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const args = [
      'remotion',
      'render',
      'src/index.ts',
      composition,
      outPath,
      `--props=${propsPath}`,
      '--timeout=120000',
      `--crf=${this.crf}`,
    ];
    if (this.remotionBrowser) args.push(`--browser-executable=${this.remotionBrowser}`);
    try {
      await execFileP(npx, args, { cwd: this.remotionDir, timeout: 900_000, maxBuffer: 20 * 1024 * 1024 });
      if (!fs.existsSync(outPath)) throw new Error('rendu terminé sans fichier de sortie');
      return outPath;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const tail = (err.stderr || err.stdout || err.message || '').slice(-800);
      const tete = (err.stdout || '').slice(0, 500).replace(/\n/g, ' | ');
      this.logger.error(`rendu remotion échec — cwd=${this.remotionDir} cmd=${npx} ${args.slice(0, 4).join(' ')} | stdout: ${tete}`);
      throw new Error(`rendu remotion : ${tail}`);
    } finally {
      fs.unlink(propsPath, () => undefined);
    }
  }
}
