import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Montage vidéo IA via Studio Montage (submagic-poc), self-hosted (Railway séparé) — port
 * direct de backend/services/montage_poc_service.py. Remplace Submagic (payant) : même
 * flux — vidéo brute (Cloudinary) -> POST /process -> rendu async (whisper + ffmpeg local,
 * pas de webhook côté submagic-poc, polling only) -> le MP4 monté est DÉJÀ sur Cloudinary
 * (studio-montage/{job_id}/video, même compte) quand le job passe à "done".
 *
 * Le vrai `submagic_service.py` (SaaS Submagic payant, API `x-api-key`) existe encore côté
 * Python mais n'est plus appelé par routes/video.py — seul le webhook hérité y fait
 * référence, jamais déclenché en pratique (submagic-poc n'a pas de webhook). Non porté ici :
 * scope réduit délibéré, cohérent avec le flux réellement actif.
 */

// submagic-poc tourne en un seul worker (thread whisper/ffmpeg partageant le GIL avec la
// boucle asyncio) : sous charge, répondre à une requête peut prendre largement plus de 30s
// même si le job démarre bien côté serveur -> CREATE_TIMEOUT généreux pour ne pas rater un
// job_id pourtant créé. POLL_TIMEOUT reste modeste : _finalize() tolère déjà un échec de
// polling (retente au prochain cycle).
const CREATE_TIMEOUT_MS = 90_000;
const POLL_TIMEOUT_MS = 20_000;
export const DONE = 'done';
export const FAILED = 'error';

// Les 12 presets réels de submagic-poc (pipeline.py::PRESETS).
export const PRESETS = ['classic', 'hormozi', 'neon', 'leon', 'molly', 'caleb', 'william', 'beast', 'duo', 'noah', 'brandin', 'bahn'];

// step (fine, ~12 valeurs) -> stage (3 paliers : processing|transcribing|exporting).
const STEP_TO_STAGE: Record<string, string> = {
  "file d'attente": 'processing',
  transcription: 'processing',
  correction: 'transcribing',
  hook: 'transcribing',
  emojis: 'transcribing',
  brolls: 'transcribing',
  analyse: 'transcribing',
  musique: 'exporting',
  rendu: 'exporting',
  miniature: 'exporting',
  stockage: 'exporting',
  fini: 'exporting',
};

export interface CreateProjectOpts {
  title: string; // sans équivalent poc (pas de "titre" de projet) — ignoré
  videoUrl: string;
  templateName?: string;
  magicBrolls?: boolean;
  magicBrollsPercentage?: number | null;
  magicZooms?: boolean;
  removeSilencePace?: string | null; // "natural"|"fast"|"extra-fast"
  cleanAudio?: boolean;
  musicId?: string | null;
  musicVolume?: number;
  hook?: string;
  hookAuto?: boolean;
  hookPosition?: string;
  hookFontscale?: number;
  emojis?: boolean;
  font?: string | null;
  hlColor?: string | null;
  fontscale?: number;
  position?: number;
  uppercase?: boolean;
  brollUrls?: string[] | null;
}

export interface CreateProjectResult {
  ok: boolean;
  id?: string;
  status?: string;
  error?: string;
}

export interface ProjectStatus {
  status: string;
  download_url: string | null;
  direct_url: string | null;
  preview_url: string | null;
  meta: { error?: string; warnings?: unknown; thumb_url?: string };
}

@Injectable()
export class MontagePocService {
  private readonly logger = new Logger(MontagePocService.name);
  private readonly baseUrl: string;
  private readonly internalKey: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('app.montagePocUrl') || '';
    this.internalKey = config.get<string>('app.montagePocInternalKey') || '';
  }

  enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  private headers(): Record<string, string> {
    return this.internalKey ? { 'X-Internal-Key': this.internalKey } : {};
  }

  /** 0-100 (curseur densité StudioVideo) -> 1-8 (brolls_count poc), linéaire. */
  private brollsCount(pct: number | null | undefined): number {
    if (pct === null || pct === undefined) return 4;
    return Math.max(1, Math.min(8, Math.round(1 + (Math.max(0, Math.min(100, pct)) / 100) * 7)));
  }

  /** Démarre un montage. Retourne {ok, id, status} ou {ok:false, error}. */
  async createProject(opts: CreateProjectOpts): Promise<CreateProjectResult> {
    if (!this.enabled()) return { ok: false, error: 'Montage vidéo indisponible (service non configuré).' };
    const options: Record<string, unknown> = {
      preset: opts.templateName && PRESETS.includes(opts.templateName) ? opts.templateName : 'classic',
      music_id: opts.musicId || 'none',
      music_volume: Math.max(1, Math.min(100, opts.musicVolume ?? 25)),
      brolls: Boolean(opts.magicBrolls ?? true),
      brolls_count: opts.magicBrolls ?? true ? this.brollsCount(opts.magicBrollsPercentage) : 4,
      zoom: Boolean(opts.magicZooms ?? true),
      cuts: Boolean(opts.removeSilencePace),
      cuts_pace: opts.removeSilencePace && ['natural', 'fast', 'extra-fast'].includes(opts.removeSilencePace) ? opts.removeSilencePace : 'natural',
      audio_clean: Boolean(opts.cleanAudio),
      hook: (opts.hook || '').trim().slice(0, 80),
      hook_auto: Boolean(opts.hookAuto),
      hook_position: opts.hookPosition && ['top', 'center', 'bottom'].includes(opts.hookPosition) ? opts.hookPosition : 'top',
      hook_fontscale: Math.max(0.5, Math.min(1.6, opts.hookFontscale || 1.0)),
      emojis: Boolean(opts.emojis),
      fontscale: Math.max(0.7, Math.min(1.4, opts.fontscale || 1.0)),
      position: Math.max(0.1, Math.min(0.45, opts.position ?? 0.3)),
      uppercase: opts.uppercase ?? true,
    };
    // font/hl_color : seulement si fournis -> sinon on laisse les DEFAULTS du poc s'appliquer.
    if (opts.font) options.font = opts.font;
    if (opts.hlColor) options.hl_color = opts.hlColor;
    if (opts.brollUrls?.length) options.broll_urls = opts.brollUrls.filter(Boolean).slice(0, 8);

    const form = new FormData();
    form.append('video_url', opts.videoUrl);
    form.append('options', JSON.stringify(options));
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/process`, { method: 'POST', body: form, headers: this.headers(), signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
    } catch (e) {
      this.logger.error(`montage-poc create exception: ${e instanceof Error ? e.constructor.name + ': ' + e.message : e}`);
      return { ok: false, error: 'Service de montage injoignable, réessaie.' };
    }
    if (resp.status >= 300) {
      const text = await resp.text().catch(() => '');
      this.logger.error(`montage-poc create error ${resp.status}: ${text.slice(0, 200)}`);
      return { ok: false, error: "Le montage n'a pas pu démarrer." };
    }
    const d = (await resp.json()) as { job_id?: string };
    return { ok: true, id: d.job_id, status: 'processing' };
  }

  /** Transcription mot à mot + réglages d'un montage terminé (édition après rendu). */
  async getTranscript(jobId: string): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const resp = await fetch(`${this.baseUrl}/jobs/${jobId}/transcript`, { headers: this.headers(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (resp.status === 404) return { ok: false, error: 'Montage introuvable.' };
    if (!resp.ok) throw new Error(`montage-poc transcript ${resp.status}`);
    const d = (await resp.json()) as Record<string, unknown>;
    return { ok: true, ...d };
  }

  /** Re-rend la même vidéo, sur place : mots corrigés, passages supprimés, réglages modifiés. */
  async rerender(jobId: string, options?: Record<string, unknown>, words?: unknown[] | null, removed?: unknown[] | null): Promise<{ ok: boolean; id?: string; status?: string; error?: string }> {
    const form = new FormData();
    form.append('options', JSON.stringify(options || {}));
    form.append('removed', JSON.stringify(removed || []));
    if (words !== undefined && words !== null) form.append('words', JSON.stringify(words));
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/jobs/${jobId}/rerender`, { method: 'POST', body: form, headers: this.headers(), signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
    } catch {
      return { ok: false, error: 'Service de montage injoignable, réessaie.' };
    }
    if (resp.status !== 200) {
      let msg: string | undefined;
      try {
        msg = ((await resp.json()) as { error?: string }).error;
      } catch {
        msg = undefined;
      }
      return { ok: false, error: msg || "Le re-rendu n'a pas pu démarrer." };
    }
    const d = (await resp.json()) as { job_id?: string };
    return { ok: true, id: d.job_id || jobId, status: 'processing' };
  }

  /** État d'un job + URL de sortie quand `done` (déjà sur Cloudinary). */
  async getProject(jobId: string): Promise<ProjectStatus> {
    const resp = await fetch(`${this.baseUrl}/jobs/${jobId}`, { headers: this.headers(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`montage-poc job ${resp.status}`);
    const d = (await resp.json()) as { status?: string; step?: string; video_url?: string; error?: string; warnings?: unknown; thumb_url?: string };
    let status: string;
    if (d.status === 'done') status = DONE;
    else if (d.status === 'error') status = FAILED;
    else status = STEP_TO_STAGE[d.step || ''] || 'processing';
    const videoUrl = d.video_url || null;
    return {
      status,
      download_url: videoUrl,
      direct_url: videoUrl,
      preview_url: null,
      meta: { error: d.error, warnings: d.warnings, thumb_url: d.thumb_url },
    };
  }

  /** Transcrit la vidéo (upload direct) et propose 3 accroches. */
  async suggestHooks(fileBuffer: Buffer, filename: string, contentType: string | undefined): Promise<{ ok: boolean; hooks?: string[]; error?: string }> {
    if (!this.enabled()) return { ok: false, error: 'Service de montage indisponible.' };
    try {
      const form = new FormData();
      form.append('video', new Blob([new Uint8Array(fileBuffer)], { type: contentType || 'video/mp4' }), filename);
      const resp = await fetch(`${this.baseUrl}/suggest_hooks`, { method: 'POST', body: form, headers: this.headers(), signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
      if (resp.status >= 300) {
        const text = await resp.text().catch(() => '');
        this.logger.error(`montage-poc suggest_hooks error ${resp.status}: ${text.slice(0, 200)}`);
        return { ok: false, error: 'Suggestion indisponible.' };
      }
      const jobId = ((await resp.json()) as { job_id?: string }).job_id;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const jr = await fetch(`${this.baseUrl}/jobs/${jobId}`, { headers: this.headers(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        const jd = (await jr.json()) as { status?: string; hooks?: string[]; error?: string };
        if (jd.status === 'done') return { ok: true, hooks: jd.hooks || [] };
        if (jd.status === 'error') return { ok: false, error: jd.error || 'Échec de la transcription.' };
      }
      return { ok: false, error: 'Délai dépassé, réessaie.' };
    } catch (e) {
      this.logger.error(`montage-poc suggest_hooks exception: ${e instanceof Error ? e.constructor.name + ': ' + e.message : e}`);
      return { ok: false, error: 'Service de montage injoignable, réessaie.' };
    }
  }

  /** Transcription seule d'une vidéo en ligne (éditeur manuel : sous-titres d'un plan). */
  async transcrireUrl(videoUrl: string, attenteS = 420): Promise<{ ok: boolean; words?: Array<{ text: string; start: number; end: number }>; language?: string; error?: string }> {
    if (!this.enabled()) return { ok: false, error: 'Service de montage indisponible.' };
    try {
      const form = new FormData();
      form.append('video_url', videoUrl);
      const resp = await fetch(`${this.baseUrl}/transcribe`, { method: 'POST', body: form, headers: this.headers(), signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
      if (resp.status >= 300) {
        const text = await resp.text().catch(() => '');
        this.logger.error(`montage-poc transcribe error ${resp.status}: ${text.slice(0, 200)}`);
        return { ok: false, error: 'Transcription indisponible.' };
      }
      const jobId = ((await resp.json()) as { job_id?: string }).job_id;
      const deadline = Date.now() + attenteS * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const jr = await fetch(`${this.baseUrl}/jobs/${jobId}`, { headers: this.headers(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        const jd = (await jr.json()) as { status?: string; words?: Array<{ text: string; start: number; end: number }>; language?: string; error?: string };
        if (jd.status === 'done') return { ok: true, words: jd.words || [], language: jd.language };
        if (jd.status === 'error') return { ok: false, error: jd.error || 'Échec de la transcription.' };
      }
      return { ok: false, error: 'Délai dépassé, réessaie.' };
    } catch (e) {
      this.logger.error(`montage-poc transcribe exception: ${e instanceof Error ? e.constructor.name + ': ' + e.message : e}`);
      return { ok: false, error: 'Transcription indisponible.' };
    }
  }
}
