import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarqueService } from '../marque/marque.service';
import { UsageService } from '../usage/usage.service';
import { EFFETS, GUIDES_STYLE, LANGUES, REVEALS, VisuelPool, estClip, imgRendu } from './reel-common.util';

const execFileP = promisify(execFile);

/**
 * Montage à partir des VIDÉOS du client : un modèle qui regarde les rushes — port direct de
 * backend/services/montage_service.py.
 *
 * Le scénariste habituel des reels (reel.service, Claude Haiku) ne voit pas les vidéos : il
 * lit une description faite sur une vignette et coupe chaque clip depuis la seconde 0. Dès
 * qu'un plan repose sur un clip, on passe ici : Gemini (via OpenRouter) REGARDE chaque clip
 * en entier et choisit le meilleur moment (début/fin) pour chaque plan, comme un monteur.
 *
 * Ce que ça change pour le reste du système : rien. La sortie a exactement la forme d'un
 * scénario Séquence (segments typo/image/cta, voix_texte…) ; le clip d'un plan devient une
 * URL Cloudinary découpée (so_/du_) que Remotion lit telle quelle. Toute erreur ici fait
 * retomber le scénariste sur Haiku (repli — géré côté appelant : cette méthode retourne null).
 *
 * Leçons du test grandeur nature (pub Villa Horizon, 2026-09-05) :
 * - une phrase parlée de 7 à 12 mots, sinon le plan s'étire au-delà du clip ;
 * - le plan CTA garde une vidéo (un fond noir à la fin casse la pub) ;
 * - les rushes sont envoyés en proxy 360p sans son : coût ~1 c par minute de clip.
 */

const MAX_CLIP_S = 90; // au-delà, on ne montre au modèle que les 90 premières secondes
const MAX_PROXY_MO = 18; // garde-fou : un proxy trop lourd fait exploser la requête

interface Rush {
  n: number;
  url: string;
  dur: number | null;
  desc?: string;
}

export interface MontageSegment {
  type: string;
  dur: number;
  texte: string;
  accents: string[];
  video?: string;
  image?: string;
  image_id?: string;
  effet?: string;
  reveal?: string;
  tilt?: number;
  bar?: string;
  label?: string;
  voix_texte?: string;
}

export interface MontageScenario {
  recette: 'montage';
  angle: string;
  brief?: string | null;
  segments: MontageSegment[];
}

const ROLE =
  'You are the editor and copywriter of short vertical social videos (15-25 s). The client gives ' +
  'you his own FOOTAGE (numbered clips you can watch in full) and sometimes photos, plus the text ' +
  "of a post or a brief. You write the SCENARIO of the reel AND choose the exact moments to keep.\n\n" +
  'OUTPUT LANGUAGE — ABSOLUTE RULE. These instructions are in English; every word you WRITE for ' +
  "the audience (texte, accents, bar, label, voix) must be in the client's language, given below. " +
  'Flawless spelling and accents.\n\n' +
  'EDITING RULES:\n' +
  '- 5 to 7 shots, the last one is ALWAYS type cta and MUST also carry a clip (never a plain background).\n' +
  '- Pick the BEST moment of each clip: good light, a clear subject, a smooth camera move, a gesture, ' +
  'a detail. Skip shaky starts, black frames, people looking for the camera.\n' +
  '- Shots last 2.5 to 4.5 s. debut/fin are seconds INSIDE the chosen clip (fin - debut = dur).\n' +
  '- Use every clip at least once when it is usable; a clip can be used twice at different moments. ' +
  'Photos (image ids) can fill a shot when no footage fits.\n' +
  '- Order the shots for the story, not the order of the clips.\n' +
  "- Shot types: 'image' (a clip or a photo + short on-screen text), 'typo' (full-screen text, use " +
  "sparingly, at most one), 'cta' (last shot, clip + call to action).\n\n" +
  'WRITING RULES:\n' +
  '- texte: 2 to 6 words on screen per shot, punchy, concrete, sensory. No jargon, no tutorial tone.\n' +
  '- accents: 1 or 2 words of that text to highlight (copied exactly as written).\n' +
  '- bar (cta shot): 2 to 5 words (brand, website or action).\n' +
  '- vary effet: zoomIn, zoomOut, panLeft, panRight ; reveal: carte, lamelles, portes, stores, iris.\n' +
  "- THE CLIENT'S OWN INSTRUCTIONS OUTRANK EVERYTHING: if he dictates a sentence, copy it as-is on the " +
  'shot he asks for.\n\n' +
  'Answer with STRICT JSON only:\n' +
  '{"angle": "the idea in one sentence", "segments": [{"type": "image|typo|cta", "clip": 1, ' +
  '"image_id": "...or null", "debut": 0.0, "fin": 3.5, "texte": "...", "accents": ["..."], ' +
  '"effet": "zoomIn", "reveal": "carte", "bar": "...if cta", "voix": "...if asked"}]}';

const CONSIGNE_VOIX =
  '\n\nVOICE-OVER. A narrator reads this reel. For EVERY shot add "voix": one SPOKEN sentence of ' +
  "7 to 12 words in the client's language, natural oral phrasing, a real verb, no hashtags, no emoji. " +
  'It carries the same idea as the on-screen text without repeating it word for word. Never longer: ' +
  'a long sentence outlasts the footage. On the cta shot the voice says the call to action plainly.';

@Injectable()
export class MontageService {
  private readonly logger = new Logger(MontageService.name);
  private readonly apiKey: string;
  private readonly modele: string;

  constructor(
    private readonly marqueService: MarqueService,
    private readonly usageService: UsageService,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('app.openrouterApiKey') || '';
    this.modele = config.get<string>('app.openrouterVideoModel') || 'google/gemini-3.8-flash';
  }

  /** Le clip SANS transformation : un plan déjà découpé (so_/du_, c_fill…) que le client
   * réutilise doit être regardé et recoupé depuis l'original. */
  urlBrute(url: string): string {
    const idx = url.indexOf('/upload/');
    if (idx === -1) return url;
    const base = url.slice(0, idx);
    let fin = url.slice(idx + '/upload/'.length);
    const premier = fin.split('/')[0];
    if (premier.includes('_') && !/^v\d+$/.test(premier)) fin = fin.split('/').slice(1).join('/');
    return `${base}/upload/${fin}`;
  }

  private urlProxy(url: string): string {
    const idx = this.urlBrute(url).indexOf('/upload/');
    const brute = this.urlBrute(url);
    const base = brute.slice(0, idx);
    const fin = brute.slice(idx + '/upload/'.length);
    return `${base}/upload/w_360,ac_none,q_auto:low,du_${MAX_CLIP_S}/${fin}`;
  }

  /** URL Cloudinary recadrée 9:16, 720p, qui DÉMARRE au moment choisi. On sert plus long
   * que le plan (+4 s) : si la voix off étire le plan, la vidéo continue. */
  clipRendu(url: string, debut: number, dur: number, durClip?: number | null): string {
    const brute = this.urlBrute(url);
    const idx = brute.indexOf('/upload/');
    if (idx === -1) return url;
    const base = brute.slice(0, idx);
    const fin = brute.slice(idx + '/upload/'.length);
    if (!fin) return url;
    let d = Math.max(0.0, Number(debut) || 0);
    let marge = Number(dur) + 4.0;
    if (durClip) {
      d = Math.min(d, Math.max(0.0, durClip - Number(dur)));
      marge = Math.min(marge, Math.max(1.0, durClip - d));
    }
    return `${base}/upload/so_${d.toFixed(1)},du_${marge.toFixed(1)},c_fill,ar_9:16,w_720,q_auto/${fin}`;
  }

  private async telecharger(url: string, tentatives = 8): Promise<Buffer | null> {
    for (let i = 0; i < tentatives; i++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (resp.status === 200) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length) return buf;
        }
        if (![423, 425, 429].includes(resp.status)) {
          this.logger.warn(`montage proxy ${resp.status} : ${url.slice(0, 120)}`);
          return null;
        }
      } catch (e) {
        this.logger.warn(`montage proxy essai ${i + 1} : ${e instanceof Error ? e.message : e}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(2000 + 2000 * i, 10_000)));
    }
    return null;
  }

  /** Repli : on télécharge l'original et ffmpeg fait le proxy. */
  private async proxyLocal(url: string): Promise<Buffer | null> {
    const data = await this.telecharger(url, 3);
    if (!data) return null;
    const src = path.join(os.tmpdir(), `montage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    const out = `${src}.proxy.mp4`;
    try {
      await fs.promises.writeFile(src, data);
      await execFileP(
        'ffmpeg',
        ['-y', '-v', 'error', '-t', String(MAX_CLIP_S), '-i', src, '-vf', 'scale=360:-2', '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-an', out],
        { timeout: 180_000 },
      );
      return await fs.promises.readFile(out);
    } catch (e) {
      this.logger.warn(`montage proxy ffmpeg : ${e instanceof Error ? e.message : e}`);
      return null;
    } finally {
      for (const p of [src, out]) fs.unlink(p, () => undefined);
    }
  }

  private async duree(data: Buffer): Promise<number | null> {
    const chemin = path.join(os.tmpdir(), `montage_dur_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
    try {
      await fs.promises.writeFile(chemin, data);
      const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', chemin], { timeout: 30_000 });
      const d = parseFloat((JSON.parse(stdout).format || {}).duration);
      return Number.isNaN(d) ? null : d;
    } catch {
      return null;
    } finally {
      fs.unlink(chemin, () => undefined);
    }
  }

  private async proxy(url: string): Promise<[Buffer | null, number | null]> {
    const data = (await this.telecharger(this.urlProxy(url))) ?? (await this.proxyLocal(url));
    if (!data || data.length > MAX_PROXY_MO * 1024 * 1024) return [null, null];
    return [data, await this.duree(data)];
  }

  private guideStyle(style?: string | null): string {
    return style && style in GUIDES_STYLE ? `\n\n${GUIDES_STYLE[style]}` : '';
  }

  /** Scénario Séquence écrit en REGARDANT les clips du pool. Retourne null si le montage
   * n'a pas pu se faire (le scénariste texte prend le relais). */
  async scenariser(
    texte: string,
    marque: Record<string, unknown>,
    pool: VisuelPool[],
    opts: { brief?: string | null; style?: string | null; avecVoix?: boolean; telegramId?: string; consigneVoix?: string | null } = {},
  ): Promise<MontageScenario | null> {
    if (!this.apiKey) return null;
    const { brief, style, avecVoix = false, telegramId, consigneVoix } = opts;
    const clips = pool.filter((p) => estClip(p.url));
    const photos = pool.filter((p) => !estClip(p.url));
    if (!clips.length) return null;

    // 1. proxies (l'analyse ne lit jamais l'original)
    const parts: Array<Record<string, unknown>> = [];
    const rushes: Rush[] = [];
    for (const p of clips) {
      const [data, dur] = await this.proxy(p.url);
      if (!data) {
        this.logger.warn(`montage : clip illisible, ignoré : ${p.url.slice(0, 100)}`);
        continue;
      }
      const n = rushes.length + 1;
      rushes.push({ n, url: p.url, dur, desc: p.desc });
      parts.push({ type: 'text', text: `CLIP ${n}${dur ? ` (${dur.toFixed(0)} s)` : ''}${p.desc ? ` : ${p.desc}` : ''}` });
      parts.push({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${data.toString('base64')}` } });
    }
    if (!rushes.length) return null;
    for (const p of photos) {
      parts.push({ type: 'text', text: `PHOTO image_id=${p.id}${p.desc ? ` : ${p.desc}` : ''}` });
      parts.push({ type: 'image_url', image_url: { url: imgRendu(p.url) } });
    }

    // 2. la demande
    const langue = LANGUES[String(marque.langue || 'fr').toLowerCase()] || 'French';
    const role =
      ROLE +
      `\n\nCLIENT'S LANGUAGE — write every audience-facing word in ${langue.toUpperCase()}.` +
      this.guideStyle(style) +
      (consigneVoix ? '' : this.marqueService.contexteMarqueCourt(marque, { ctas: true })) +
      (avecVoix ? consigneVoix || CONSIGNE_VOIX : '');
    let demande = '';
    if (brief) demande += `### CLIENT'S OWN INSTRUCTIONS — FOLLOW THEM TO THE LETTER\n${brief.slice(0, 1500).trim()}\n### end of instructions\n\n`;
    if (texte && texte.trim() !== (brief || '').trim()) demande += `Post / subject:\n\n${texte.slice(0, 3000)}\n\n`;
    demande += `Brand: ${marque.nom || ''}. Sector: ${marque.secteur || ''}. Tone: ${marque.voix_marque || ''}.\nThere are ${rushes.length} clip(s). Watch them in full, then return the JSON.`;

    const body = {
      model: this.modele,
      temperature: 0.6,
      usage: { include: true },
      messages: [
        { role: 'system', content: role },
        { role: 'user', content: [{ type: 'text', text: demande }, ...parts] },
      ],
    };
    const t0 = Date.now();
    let data: { angle?: string; segments?: Array<Record<string, unknown>> };
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://postorico.com',
          'X-Title': 'Postorico montage',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      if (!resp.ok || j.error) {
        this.logger.error(`montage OpenRouter ${resp.status} : ${JSON.stringify(j).slice(0, 300)}`);
        return null;
      }
      const raw = j.choices?.[0]?.message?.content || '';
      data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      this.journal(telegramId, j.usage, (Date.now() - t0) / 1000);
    } catch (e) {
      this.logger.error(`montage Gemini : ${e instanceof Error ? e.message : e}`);
      return null;
    }

    // 3. vers un scénario Séquence
    const idsPhoto = new Map(photos.map((p) => [p.id, p.url]));
    const segs: MontageSegment[] = [];
    for (const s of (data.segments || []).slice(0, 7)) {
      const t = ['typo', 'image', 'cta'].includes(String(s.type)) ? (s.type as string) : 'image';
      const texteS = String(s.texte || '').slice(0, 80).trim();
      if (!texteS) continue;
      const seg: MontageSegment = { type: t, dur: 3.0, texte: texteS, accents: (Array.isArray(s.accents) ? s.accents : []).slice(0, 2).map((a) => String(a).slice(0, 30)) };
      let debut = 0;
      let fin = 0;
      try {
        debut = Number(s.debut) || 0;
        fin = Number(s.fin) || 0;
      } catch {
        debut = 0;
        fin = 0;
      }
      seg.dur = fin > debut ? Math.round(Math.max(2.5, Math.min(4.5, fin - debut)) * 10) / 10 : 3.0;
      const n = s.clip;
      const rush = typeof n === 'number' ? rushes.find((x) => x.n === n) : undefined;
      if (t !== 'typo') {
        if (rush) {
          seg.video = this.clipRendu(rush.url, debut, seg.dur, rush.dur);
          seg.image_id = `clip_${rush.n}`;
        } else if (typeof s.image_id === 'string' && idsPhoto.has(s.image_id)) {
          seg.image = imgRendu(idsPhoto.get(s.image_id));
          seg.image_id = s.image_id;
        } else if (t === 'image') {
          seg.type = 'typo'; // ni clip ni photo connue : jamais d'URL inventée
        }
        if (seg.video || seg.image) {
          seg.effet = (EFFETS as readonly string[]).includes(String(s.effet)) ? (s.effet as string) : EFFETS[segs.length % 4];
          if ((REVEALS as readonly string[]).includes(String(s.reveal))) seg.reveal = s.reveal as string;
          seg.tilt = [-3, 2, -2, 3][segs.length % 4];
        }
      }
      if (t === 'cta') seg.bar = String(s.bar || marque.nom || '').slice(0, 40);
      if (s.label) seg.label = String(s.label).slice(0, 40);
      if (avecVoix) seg.voix_texte = String(s.voix || texteS).slice(0, consigneVoix ? 400 : 200).trim();
      segs.push(seg);
    }
    if (segs.length < 4) {
      this.logger.warn(`montage : scénario trop court (${segs.length} plans), repli texte`);
      return null;
    }
    if (segs[segs.length - 1].type !== 'cta') {
      segs[segs.length - 1].type = 'cta';
      if (!segs[segs.length - 1].bar) segs[segs.length - 1].bar = String(marque.nom || '').slice(0, 40);
    }
    if (!segs[segs.length - 1].video) {
      // Le CTA garde une vidéo : la fin du premier clip, en écho au début.
      const r0 = rushes[0];
      const last = segs[segs.length - 1];
      last.video = this.clipRendu(r0.url, Math.max(0.0, (r0.dur || 8) - last.dur - 1), last.dur, r0.dur);
      last.image_id = `clip_${r0.n}`;
      if (!last.effet) last.effet = 'zoomOut';
    }
    return { recette: 'montage', angle: String(data.angle || '').slice(0, 200), brief: brief ?? null, segments: segs };
  }

  /** Coût réel renvoyé par OpenRouter (usage.cost, en $) dans usage_log. */
  private journal(telegramId: string | undefined, usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined, dureeS: number): void {
    if (!telegramId) return;
    this.usageService
      .log(
        telegramId,
        'reel_montage',
        this.modele,
        { input: usage?.prompt_tokens || 0, output: usage?.completion_tokens || 0 },
        0,
        undefined,
        Number(usage?.cost || 0),
        dureeS,
      )
      .catch((e) => this.logger.warn(`montage journal : ${e instanceof Error ? e.message : e}`));
  }
}
