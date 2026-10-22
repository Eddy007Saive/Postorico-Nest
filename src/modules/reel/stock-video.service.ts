import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ClaudeService } from '../claude/claude.service';
import { meilleurFichier } from '../agent-video/illustrations.util';
import { VisuelPool } from './reel-common.util';

interface VideoPexels {
  id?: number;
  duration?: number;
  width?: number;
  height?: number;
  video_files?: Array<{ link?: string; width?: number; height?: number; file_type?: string }>;
}

/**
 * Plans vidéo réels (Pexels) pour les reels Séquence : l'IA repère dans le texte les moments
 * concrets et filmables, on cherche pour chacun un plan vertical sur Pexels et on le copie
 * dans Cloudinary. Ils rejoignent les visuels disponibles du scénariste, qui les place comme
 * des clips du client (recadrage 9:16, coupe à la durée du plan : clipRenduSimple).
 *
 * Copie unique par vidéo Pexels (public_id stock/pexels-<id>, sans écrasement) : une même
 * vidéo utilisée par dix comptes n'est stockée qu'une fois. Tout est best-effort : un échec
 * (pas de clé, Pexels muet, Cloudinary refuse) donne simplement moins de plans, jamais une
 * erreur de génération.
 */
/** La promesse, ou null passé le délai (minuteur nettoyé dans les deux cas). */
function avecDelai<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<null>((r) => {
    minuteur = setTimeout(() => r(null), ms);
  });
  return Promise.race([p, delai]).finally(() => clearTimeout(minuteur));
}

@Injectable()
export class StockVideoService {
  private readonly logger = new Logger(StockVideoService.name);
  private readonly pexelsCle: string;

  constructor(
    private readonly claude: ClaudeService,
    config: ConfigService,
  ) {
    this.pexelsCle = config.get<string>('app.pexelsApiKey') || '';
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  get actif(): boolean {
    return Boolean(this.pexelsCle);
  }

  /** Jusqu'à `n` recherches Pexels (en anglais) pour les passages concrets du texte. */
  async requetes(texte: string, n = 3): Promise<string[]> {
    const resp = await this.claude.messagesCreate({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system:
        'You pick stock footage for a short vertical social video. From the text, find up to ' +
        `${n} CONCRETE, FILMABLE moments (a place, an object, a person doing something, a trade) ` +
        'that a real stock video clip could illustrate. Skip abstract ideas (growth, strategy, mindset). ' +
        'For each, write a short Pexels search query IN ENGLISH, 2 to 4 plain words, no brand names. ' +
        'Return STRICT JSON: {"queries": ["...", "..."]}. Return {"queries": []} if nothing is filmable.',
      messages: [{ role: 'user', content: texte.slice(0, 3000) }],
    });
    const raw = this.claude.texte(resp);
    try {
      const m = /\{[\s\S]*\}/.exec(raw);
      const d = JSON.parse(m ? m[0] : raw) as { queries?: unknown };
      return (Array.isArray(d.queries) ? d.queries : [])
        .map((q) => String(q).trim().slice(0, 60))
        .filter((q) => q.length >= 3)
        .slice(0, n);
    } catch {
      return [];
    }
  }

  /** Premier plan vertical d'au moins 4 s pour la recherche, ignorant les vidéos déjà prises. */
  async chercher(requete: string, deja: Set<number> = new Set()): Promise<{ id: number; lien: string } | null> {
    if (!this.pexelsCle) return null;
    try {
      const url = `https://api.pexels.com/videos/search?${new URLSearchParams({ query: requete, orientation: 'portrait', per_page: '8' })}`;
      const r = await fetch(url, { headers: { Authorization: this.pexelsCle }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const corps = (await r.json()) as { videos?: VideoPexels[] };
      for (const v of corps.videos || []) {
        if (!v.id || deja.has(v.id) || (v.duration || 0) < 4) continue;
        if (v.width && v.height && v.width > v.height) continue; // vertical seulement
        const lien = meilleurFichier(v.video_files || []);
        if (lien) return { id: v.id, lien };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Copie la vidéo dans Cloudinary (une fois par vidéo Pexels) ; renvoie l'URL Cloudinary. */
  async importer(video: { id: number; lien: string }): Promise<string | null> {
    const publicId = `stock/pexels-${video.id}`;
    try {
      const deja = (await cloudinary.api.resource(publicId, { resource_type: 'video' })) as { secure_url?: string };
      if (deja?.secure_url) return deja.secure_url;
    } catch {
      // absente : on l'importe
    }
    try {
      const up = (await cloudinary.uploader.upload(video.lien, {
        resource_type: 'video',
        public_id: publicId,
        overwrite: false,
      })) as { secure_url?: string };
      return up.secure_url || null;
    } catch (e) {
      this.logger.warn(`plan Pexels ${video.id} non importé : ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Les plans vidéo prêts pour le scénariste (VisuelPool), dans l'ordre des passages. */
  async pool(texte: string, n = 3): Promise<VisuelPool[]> {
    if (!this.actif || !texte.trim()) return [];
    let requetes: string[] = [];
    try {
      requetes = await this.requetes(texte, n);
    } catch (e) {
      this.logger.warn(`plans vidéo : recherches non proposées : ${e instanceof Error ? e.message : e}`);
      return [];
    }
    const deja = new Set<number>();
    const trouvees: Array<{ requete: string; id: number; lien: string }> = [];
    for (const requete of requetes) {
      const v = await this.chercher(requete, deja);
      if (v) {
        deja.add(v.id);
        trouvees.push({ requete, ...v });
      }
    }
    // Import plafonné : le client attend la réponse ; un plan trop long à copier est laissé de côté.
    const urls = await Promise.all(trouvees.map((v) => avecDelai(this.importer(v), 25_000)));
    return trouvees
      .map((v, i) => ({ v, url: urls[i] }))
      .filter((x): x is { v: (typeof trouvees)[number]; url: string } => Boolean(x.url))
      .map(({ v, url }, i) => ({ id: `stock_${i + 1}`, url, desc: `Real stock footage (Pexels): ${v.requete}` }));
  }
}
