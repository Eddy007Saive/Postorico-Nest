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

interface VideoPixabay {
  id?: number;
  duration?: number;
  videos?: Record<string, { url?: string; width?: number; height?: number } | undefined>;
}

/** Un plan trouvé : `cle` unique toutes banques confondues (« pexels-12 », « pixabay-34 »). */
export interface PlanStock {
  source: 'Pexels' | 'Pixabay';
  cle: string;
  lien: string;
}

/**
 * Plans vidéo réels (Pexels, Pixabay en secours) pour les reels Séquence : l'IA repère dans le texte les moments
 * concrets et filmables, on cherche pour chacun un plan vertical sur Pexels et on le copie
 * dans Cloudinary. Ils rejoignent les visuels disponibles du scénariste, qui les place comme
 * des clips du client (recadrage 9:16, coupe à la durée du plan : clipRenduSimple).
 *
 * Pixabay ne sert que si Pexels n'a rien pour la recherche (ou pas de clé Pexels) ; ses plans
 * sont rarement verticaux : un plan horizontal y est accepté, recadré en 9:16 au rendu.
 *
 * Copie unique par vidéo (public_id stock/<banque>-<id>, sans écrasement) : une même
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
  private readonly pixabayCle: string;

  constructor(
    private readonly claude: ClaudeService,
    config: ConfigService,
  ) {
    this.pexelsCle = config.get<string>('app.pexelsApiKey') || '';
    this.pixabayCle = config.get<string>('app.pixabayApiKey') || '';
    cloudinary.config({
      cloud_name: config.get<string>('app.cloudinaryCloudName'),
      api_key: config.get<string>('app.cloudinaryApiKey'),
      api_secret: config.get<string>('app.cloudinaryApiSecret'),
    });
  }

  get actif(): boolean {
    return Boolean(this.pexelsCle || this.pixabayCle);
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
        'For each, write a short stock video search query IN ENGLISH, 2 to 4 plain words, no brand names. ' +
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

  /** Un plan pour la recherche : Pexels d'abord, Pixabay en secours ; ignore les plans déjà pris. */
  async chercher(requete: string, deja: Set<string> = new Set()): Promise<PlanStock | null> {
    return (await this.chercherPexels(requete, deja)) || (await this.chercherPixabay(requete, deja));
  }

  /** Premier plan Pexels vertical d'au moins 4 s. */
  async chercherPexels(requete: string, deja: Set<string> = new Set()): Promise<PlanStock | null> {
    if (!this.pexelsCle) return null;
    try {
      const url = `https://api.pexels.com/videos/search?${new URLSearchParams({ query: requete, orientation: 'portrait', per_page: '8' })}`;
      const r = await fetch(url, { headers: { Authorization: this.pexelsCle }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const corps = (await r.json()) as { videos?: VideoPexels[] };
      for (const v of corps.videos || []) {
        if (!v.id || deja.has(`pexels-${v.id}`) || (v.duration || 0) < 4) continue;
        if (v.width && v.height && v.width > v.height) continue; // vertical seulement
        const lien = meilleurFichier(v.video_files || []);
        if (lien) return { source: 'Pexels', cle: `pexels-${v.id}`, lien };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Plan Pixabay d'au moins 4 s : vertical de préférence, sinon le premier d'au moins 720 px de haut. */
  async chercherPixabay(requete: string, deja: Set<string> = new Set()): Promise<PlanStock | null> {
    if (!this.pixabayCle) return null;
    try {
      const url = `https://pixabay.com/api/videos/?${new URLSearchParams({ key: this.pixabayCle, q: requete.slice(0, 100), per_page: '15', safesearch: 'true' })}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const corps = (await r.json()) as { hits?: VideoPixabay[] };
      const candidats: Array<{ vertical: boolean; plan: PlanStock }> = [];
      for (const v of corps.hits || []) {
        if (!v.id || deja.has(`pixabay-${v.id}`) || (v.duration || 0) < 4) continue;
        // Le plus grand fichier jusqu'à 1920 px de haut (large ou medium selon la vidéo).
        const fichiers = Object.values(v.videos || {})
          .filter((f): f is { url: string; width: number; height: number } => Boolean(f?.url && f.width && f.height))
          .filter((f) => f.height >= 720 && Math.max(f.width, f.height) <= 2160)
          .sort((a, b) => b.width * b.height - a.width * a.height);
        const f = fichiers[0];
        if (f) candidats.push({ vertical: f.height > f.width, plan: { source: 'Pixabay', cle: `pixabay-${v.id}`, lien: f.url } });
      }
      return (candidats.find((c) => c.vertical) || candidats[0])?.plan || null;
    } catch {
      return null;
    }
  }

  /** Copie la vidéo dans Cloudinary (une fois par vidéo) ; renvoie l'URL Cloudinary. */
  async importer(video: Pick<PlanStock, 'cle' | 'lien'>): Promise<string | null> {
    const publicId = `stock/${video.cle}`;
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
      this.logger.warn(`plan ${video.cle} non importé : ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Clé banque d'une URL Cloudinary de plan (« …/stock/pexels-12.mp4 » -> « pexels-12 »), sinon null. */
  static cleDepuisUrl(url: string): string | null {
    const m = /\/stock\/((?:pexels|pixabay)-\d+)/.exec(url || '');
    return m ? m[1] : null;
  }

  /**
   * Un autre plan pour un passage du reel (« Autre plan » dans le Studio Reel) : nouvelles
   * recherches sur le texte du passage, en écartant les plans déjà utilisés. null si rien.
   */
  async autrePlan(texte: string, exclure: string[] = []): Promise<{ url: string; desc: string } | null> {
    if (!this.actif || !texte.trim()) return null;
    const deja = new Set(exclure.map((u) => StockVideoService.cleDepuisUrl(u)).filter((c): c is string => Boolean(c)));
    const requetes = await this.requetes(texte, 2);
    for (const requete of requetes) {
      const v = await this.chercher(requete, deja);
      if (!v) continue;
      const url = await avecDelai(this.importer(v), 25_000);
      if (url) return { url, desc: `Real stock footage (${v.source}): ${requete}` };
      deja.add(v.cle);
    }
    return null;
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
    const deja = new Set<string>();
    const trouvees: Array<{ requete: string } & PlanStock> = [];
    for (const requete of requetes) {
      const v = await this.chercher(requete, deja);
      if (v) {
        deja.add(v.cle);
        trouvees.push({ requete, ...v });
      }
    }
    // Import plafonné : le client attend la réponse ; un plan trop long à copier est laissé de côté.
    const urls = await Promise.all(trouvees.map((v) => avecDelai(this.importer(v), 25_000)));
    return trouvees
      .map((v, i) => ({ v, url: urls[i] }))
      .filter((x): x is { v: (typeof trouvees)[number]; url: string } => Boolean(x.url))
      .map(({ v, url }, i) => ({ id: `stock_${i + 1}`, url, desc: `Real stock footage (${v.source}): ${v.requete}` }));
  }
}
