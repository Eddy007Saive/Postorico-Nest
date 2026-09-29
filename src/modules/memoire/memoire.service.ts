import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../../config/prisma.service';
import { UsageService } from '../usage/usage.service';
import { ExempleVoix } from './interfaces/exemple-voix.interface';

/**
 * Mémoire de voix (RAG phase 1) — port direct de backend/services/memoire_service.py :
 * la RÉCUPÉRATION à la rédaction (embed + exemples_voix + bloc_exemples) ET l'INDEXATION
 * (indexerContenu, appelée à chaque validation/modification de contenu — voir
 * ContenuService.updateContenu ; reindexerCompte, rattrapage manuel comme
 * backend/scripts/backfill_embeddings.py côté Python, jamais exposé en route côté Python
 * non plus). Complété le 2026-09-29 (comparaison systématique Python/NestJS) — jusque-là
 * cette mémoire restait en lecture seule sur les vecteurs indexés par le backend Python.
 */
const MAX_EXEMPLE = 1200; // caractères d'un exemple injecté dans le prompt
const MAX_TEXTE = 2000; // caractères indexés par contenu
/** Statuts de contenu considérés « indexés » côté mémoire de voix — même liste que
 * `demarrage_service._validation` côté Python pour compter les publications validées.
 * Aucun des trois ne contient d'espace, donc identique en libellé brut ET en nom d'enum
 * Prisma (voir contenu-enum.util.ts) — comparable directement à `row.statut`. */
export const STATUTS_INDEXES = ['Valider', 'Planifie', 'Publie'] as const;
const GENRE_LABEL: Record<string, string> = { post: 'POSTS', carrousel: 'CAROUSELS', script: 'VIDEO SCRIPTS' };
const PRIX_PAR_M_TOKENS = 0.02;

export interface ContenuMemoireRow {
  id: string;
  telegram_id: string | null;
  type?: string | null;
  statut?: string | null;
  reseau_cible?: string | null;
  contenu?: string | null;
  script?: string | null;
  carrousel_data?: unknown;
}

/** 'post' | 'carrousel' | 'script' | null (non indexé, ex. Story). Port de `genre_de`.
 * Même remarque que STATUTS_INDEXES : "Post_court"/"Reel"/"Carrousel" (noms d'enum
 * Prisma) matchent ces comparaisons aussi bien que leurs libellés bruts ("Post court"). */
export function genreDe(row: Pick<ContenuMemoireRow, 'type' | 'script'>): 'post' | 'carrousel' | 'script' | null {
  const t = (row.type || '').trim();
  if (!t || t.toLowerCase().startsWith('post')) return 'post';
  if (t === 'Carrousel') return 'carrousel';
  if (['Reel', 'Video', 'Short'].includes(t) && (row.script || '').trim()) return 'script';
  return null;
}

/** Le texte qui représente un contenu pour l'indexation — port de `texte_de`. */
export function texteDe(row: ContenuMemoireRow): string {
  const g = genreDe(row);
  if (g === 'carrousel') {
    const cd = row.carrousel_data as { hook?: unknown; slides?: unknown; cta?: unknown } | null;
    if (cd && typeof cd === 'object' && (cd.hook || cd.slides)) {
      const parts: string[] = [];
      if (cd.hook) parts.push(String(cd.hook));
      const slides = Array.isArray(cd.slides) ? cd.slides : [];
      for (const s of slides as Array<Record<string, unknown>>) {
        for (const k of ['titre', 'texte', 'pro_tip']) {
          if (s?.[k]) parts.push(String(s[k]));
        }
      }
      const cta = cd.cta;
      if (cta && typeof cta === 'object') {
        const ct = cta as Record<string, unknown>;
        for (const k of ['titre', 'texte']) {
          if (ct[k]) parts.push(String(ct[k]));
        }
      } else if (cta) {
        parts.push(String(cta));
      }
      return parts.join('\n').slice(0, MAX_TEXTE);
    }
    return (row.contenu || '').slice(0, MAX_TEXTE);
  }
  if (g === 'script') return (row.script || row.contenu || '').slice(0, MAX_TEXTE);
  return (row.contenu || '').slice(0, MAX_TEXTE);
}

// Valeurs de contenu.reseau_cible (enum capitalisé) depuis la clé réseau du front.
const RESEAU_CIBLE: Record<string, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  googlebusiness: 'GoogleBusiness',
};

@Injectable()
export class MemoireService {
  private readonly logger = new Logger(MemoireService.name);
  private readonly client: OpenAI | null;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usageService: UsageService,
    private readonly config: ConfigService,
  ) {
    const apiKey = config.get<string>('app.openaiApiKey');
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.embeddingModel = config.get<string>('app.embeddingModel') ?? 'text-embedding-3-small';
  }

  /** Vecteurs des textes (même ordre). [] si pas de clé ou erreur — jamais d'exception. */
  async embed(textes: string[], telegramId?: string): Promise<number[][]> {
    const propres = textes.map((t) => (t && t.trim() ? t : ' '));
    if (!propres.length || !this.client) return [];
    const out: number[][] = [];
    try {
      for (let i = 0; i < propres.length; i += 100) {
        const lot = propres.slice(i, i + 100);
        const resp = await this.client.embeddings.create({ model: this.embeddingModel, input: lot });
        const tries = [...resp.data].sort((a, b) => a.index - b.index);
        out.push(...tries.map((d) => d.embedding));
        const tokens = resp.usage?.total_tokens ?? 0;
        if (tokens && telegramId) {
          try {
            await this.usageService.log(
              telegramId,
              'embedding',
              this.embeddingModel,
              { input: tokens },
              0,
              undefined,
              Math.round((tokens / 1e6) * PRIX_PAR_M_TOKENS * 1e8) / 1e8,
            );
          } catch (e) {
            this.logger.warn(`journal embedding: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      return out;
    } catch (e) {
      this.logger.warn(`embeddings OpenAI: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Les contenus validés du compte les plus proches de `requete` (sujet + angle).
   * [] si moins de 2 résultats au-dessus du seuil : démarrage à froid = pas d'exemples,
   * la rédaction se comporte exactement comme avant. */
  async exemplesVoix(
    telegramId: string,
    requete: string,
    genre: string,
    reseau?: string,
    n = 4,
    seuil = 0.3,
  ): Promise<ExempleVoix[]> {
    if (!(requete ?? '').trim()) return [];
    const vecs = await this.embed([requete.slice(0, 2000)], telegramId);
    if (!vecs.length) return [];
    // pgvector attend un littéral texte '[...]' casté ::vector — Prisma ne type pas la
    // colonne vector nativement (Unsupported("vector") dans le schéma introspecté).
    const vecLiteral = `[${vecs[0].join(',')}]`;
    let rows: ExempleVoix[];
    try {
      rows = await this.prisma.$queryRaw<ExempleVoix[]>`
        SELECT * FROM match_contenu_embeddings(${telegramId}::uuid, ${vecLiteral}::vector, ${genre}, ${reseau ?? null}, ${n}::int)
      `;
    } catch (e) {
      this.logger.warn(`mémoire recherche (${genre}): ${e instanceof Error ? e.message : e}`);
      return [];
    }
    const res = rows.filter((x) => (x.similarite ?? 0) >= seuil);
    return res.length >= 2 ? res : [];
  }

  /** Bloc à ajouter au system prompt (partie `extra`). "" si rien à montrer. */
  blocExemples(exemples: ExempleVoix[], genre: string, reseauLabel = ''): string {
    if (!exemples.length) return '';
    const vus = new Set<string>();
    const uniques: string[] = [];
    for (const e of exemples) {
      const t = (e.texte ?? '').trim();
      const cle = t.slice(0, 200);
      if (!t || vus.has(cle)) continue; // même texte recyclé sur plusieurs réseaux
      vus.add(cle);
      uniques.push(t.slice(0, MAX_EXEMPLE));
    }
    if (!uniques.length) return '';
    const label = GENRE_LABEL[genre] ?? 'POSTS';
    const ou = reseauLabel ? ` ${reseauLabel}` : '';
    const tete =
      `\n\n## THE CLIENT'S OWN VALIDATED${ou} ${label} CLOSEST TO THIS TOPIC\n` +
      "These were approved and published by the client: this is their real voice. " +
      "Mimic the voice, rhythm, sentence length, structure and level of detail. " +
      "Never copy a sentence, never reuse the same hook, never repeat their facts as if new.\n";
    const corps = uniques.map((t, i) => `\n### Example ${i + 1}\n${t}\n`).join('');
    return tete + corps;
  }

  /** Bloc « exemples de la voix réelle » prêt à ajouter à la partie `extra` du system
   * prompt d'un générateur (post/carrousel/script) — port direct de `_exemples_memoire`
   * (backend/services/agent_service.py). "" si désactivé (app.memoireVoixActive), compte
   * neuf, ou mémoire indisponible : la génération se comporte alors comme avant. */
  async blocPourGenre(
    telegramId: string,
    sujet: string,
    dimensions: Record<string, unknown> | undefined,
    genre: string,
    reseau?: string,
    reseauLabel = '',
  ): Promise<string> {
    if (!this.config.get<boolean>('app.memoireVoixActive')) return '';
    try {
      const d = dimensions ?? {};
      const requete = [sujet, d.angle, d.cible].filter(Boolean).join(' — ');
      const cible = RESEAU_CIBLE[(reseau ?? '').toLowerCase()];
      let ex = await this.exemplesVoix(telegramId, requete, genre, cible);
      let genreEffectif = genre;
      if (!ex.length && genre !== 'post') {
        // Peu de carrousels/scripts validés : la voix est la même dans les posts.
        ex = await this.exemplesVoix(telegramId, requete, 'post', cible);
        genreEffectif = 'post';
      }
      return this.blocExemples(ex, genreEffectif, reseauLabel);
    } catch (e) {
      this.logger.warn(`mémoire de voix (${genre}): ${e instanceof Error ? e.message : e}`);
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Indexation
  // ---------------------------------------------------------------------------
  private async retirer(contenuId: string): Promise<void> {
    try {
      await this.prisma.contenu_embeddings.deleteMany({ where: { contenu_id: contenuId } });
    } catch (e) {
      this.logger.warn(`mémoire retrait ${contenuId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** `embedding` est une colonne pgvector (`Unsupported("vector")` dans le schéma Prisma
   * introspecté) — écrite en SQL brut, comme sa lecture (`match_contenu_embeddings`) l'est
   * déjà juste au-dessus. */
  private async upsertEmbedding(
    contenuId: string,
    telegramId: string | null,
    genre: string,
    reseauCible: string | null,
    texte: string,
    vec: number[],
  ): Promise<void> {
    const vecLiteral = `[${vec.join(',')}]`;
    await this.prisma.$executeRaw`
      INSERT INTO contenu_embeddings (contenu_id, telegram_id, genre, reseau_cible, texte, embedding)
      VALUES (${contenuId}::uuid, ${telegramId}::uuid, ${genre}, ${reseauCible}, ${texte}, ${vecLiteral}::vector)
      ON CONFLICT (contenu_id) DO UPDATE SET
        telegram_id = EXCLUDED.telegram_id, genre = EXCLUDED.genre, reseau_cible = EXCLUDED.reseau_cible,
        texte = EXCLUDED.texte, embedding = EXCLUDED.embedding
    `;
  }

  /** (Ré)indexe un contenu s'il est validé/planifié/publié et d'un genre couvert ; sinon
   * retire son vecteur (contenu repassé « À valider »). Jamais d'exception — appelée en
   * best-effort à chaque validation/modification (voir ContenuService.updateContenu). */
  async indexerContenu(row: ContenuMemoireRow): Promise<boolean> {
    try {
      const cid = row.id;
      if (!cid) return false;
      const genre = genreDe(row);
      const texte = texteDe(row).trim();
      const statutsIndexes: readonly string[] = STATUTS_INDEXES;
      if (!row.statut || !statutsIndexes.includes(row.statut) || !genre || texte.length < 40) {
        await this.retirer(cid);
        return false;
      }
      const vecs = await this.embed([texte], row.telegram_id ?? undefined);
      if (!vecs.length) return false;
      await this.upsertEmbedding(cid, row.telegram_id ?? null, genre, row.reseau_cible ?? null, texte, vecs[0]);
      return true;
    } catch (e) {
      this.logger.warn(`mémoire indexation ${row.id}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** Rattrapage : tous les contenus éligibles (d'un compte, ou de tous si `telegramId`
   * omis), embeddings par lots — port de `reindexer_compte`. Comme côté Python
   * (backend/scripts/backfill_embeddings.py), un outil manuel : jamais exposé en route. */
  async reindexerCompte(
    telegramId?: string,
    lot = 50,
  ): Promise<{ indexes: number; ignores: number; par_genre: Record<string, number> }> {
    const rows: ContenuMemoireRow[] = [];
    const page = 1000;
    for (let skip = 0; ; skip += page) {
      const batch = await this.prisma.contenu.findMany({
        where: {
          statut: { in: [...STATUTS_INDEXES] as never },
          ...(telegramId ? { telegram_id: telegramId } : {}),
        },
        select: { id: true, telegram_id: true, type: true, statut: true, reseau_cible: true, contenu: true, script: true, carrousel_data: true },
        skip,
        take: page,
      });
      rows.push(...(batch as unknown as ContenuMemoireRow[]));
      if (batch.length < page) break;
    }

    const eligibles = rows
      .map((row): [ContenuMemoireRow, string] => [row, texteDe(row).trim()])
      .filter(([row, t]) => genreDe(row) && t.length >= 40);

    let indexes = 0;
    const parGenre: Record<string, number> = {};
    for (let i = 0; i < eligibles.length; i += lot) {
      const tranche = eligibles.slice(i, i + lot);
      // Comme côté Python : l'usage n'est attribué à un compte que sur un rattrapage
      // CIBLÉ (un seul client) — un rattrapage global n'impute son coût à personne.
      const vecs = await this.embed(
        tranche.map(([, t]) => t),
        telegramId ? tranche[0][0].telegram_id ?? undefined : undefined,
      );
      if (vecs.length !== tranche.length) {
        this.logger.warn("mémoire rattrapage : lot d'embeddings incomplet, lot ignoré");
        continue;
      }
      await Promise.all(
        tranche.map(async ([row, t], idx) => {
          const g = genreDe(row)!;
          parGenre[g] = (parGenre[g] || 0) + 1;
          await this.upsertEmbedding(row.id, row.telegram_id ?? null, g, row.reseau_cible ?? null, t, vecs[idx]);
        }),
      );
      indexes += tranche.length;
    }
    return { indexes, ignores: rows.length - eligibles.length, par_genre: parGenre };
  }
}
