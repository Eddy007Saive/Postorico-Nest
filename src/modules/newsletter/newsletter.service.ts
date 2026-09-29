import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../config/prisma.service';
import { ClaudeService } from '../claude/claude.service';
import { MailService } from '../mail/mail.service';
import { LettreActu, LettreData, LettreSection, VeilleResult, VeilleSource } from './interfaces/lettre.interface';

/**
 * Newsletter hebdomadaire « La lettre de Rico » — port direct de
 * backend/services/newsletter_service.py (+ le cron backend/server.py::_newsletter_cron).
 *
 * Cycle complet, sans intervention :
 *   1. VEILLE    — Claude cherche sur le web (outil de recherche natif de l'API) ce qui a
 *                  bougé cette semaine sur les réseaux sociaux, complété par Perplexity.
 *   2. REDACTION — Claude écrit la lettre, toujours à la voix de Rico (JSON structuré).
 *   3. VALIDATION— Martin reçoit la lettre par email avec deux boutons :
 *                  « Envoyer aux abonnés » / « Ne pas envoyer ». Rien ne part sans ce clic.
 *   4. ENVOI     — à la validation, envoi à tous les abonnés actifs (Resend), en tâche de
 *                  fond, avec un lien de désinscription personnel dans chaque email.
 *
 * Les abonnés sont synchronisés depuis les clients (users) et les leads de l'audit de
 * marque (brand_audits) ; une désinscription est définitive (jamais réactivée).
 */

// Recherche web : le modèle lit le web au moment de la veille (pas de clé tierce).
// web_search_20260209 (filtrage dynamique) exige Opus/Sonnet récents, d'où Opus 5, appelé
// une fois par semaine : la qualité prime sur le coût à cette fréquence.
const MODEL = 'claude-opus-5';
const WEB_SEARCH: Anthropic.Messages.WebSearchTool20260209 = { type: 'web_search_20260209', name: 'web_search' };

const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function dateFr(d: Date): string {
  return `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const ROLE_VEILLE =
  "Tu es le veilleur de Postorico, un logiciel qui pilote la présence sociale des " +
  "entrepreneurs et des PME. Ta mission : repérer ce qui a RÉELLEMENT bougé ces 7 derniers " +
  "jours sur les réseaux sociaux (LinkedIn, Instagram, TikTok, YouTube, Facebook, X).\n" +
  "Fais plusieurs recherches web ciblées et ne retiens que :\n" +
  "- les nouveautés produit et changements d'algorithme annoncés par les plateformes\n" +
  "- les évolutions de formats (durées, ratios, fonctionnalités) et ce qui performe\n" +
  "- les bonnes pratiques et stratégies documentées par des sources sérieuses\n" +
  "- les chiffres et études récents, avec leur source\n" +
  "Ignore les rumeurs, le sensationnalisme et tout ce qui date de plus d'un mois.\n" +
  "Rends un compte rendu factuel et dense, en français, organisé par réseau, chaque " +
  "information suivie de sa source entre parenthèses. Pas d'introduction, pas de " +
  "conclusion : uniquement la matière brute.\n" +
  "Écris un français typographiquement irréprochable : tous les accents (é, è, ê, à, ç, ô, ù), " +
  "les majuscules accentuées et les apostrophes. Un texte sans accents est un texte fautif.";

// Perplexity prend « faire la veille » au sens « outils de veille » : on lui dit
// précisément quoi chercher (des ACTUALITÉS datées) et où.
const QUESTION_PERPLEXITY_SUFFIX =
  "\n\nCherche UNIQUEMENT des actualités DATÉES de cette semaine : nouvelles fonctionnalités, " +
  "changements d'algorithme ou de règles, nouveaux formats, chiffres officiels, annonces, sur " +
  "LinkedIn, Instagram, Facebook, TikTok, YouTube et X. Sources à privilégier : newsrooms officielles " +
  "(Meta, TikTok, LinkedIn, YouTube), Social Media Today, Blog du Modérateur, Later, Hootsuite, " +
  "Buffer, Search Engine Journal, TechCrunch, The Verge. Ignore les guides généraux, les listes " +
  "d'outils et les articles non datés. Pour chaque actualité : réseau, date, ce qui change, ce que " +
  "ça implique concrètement pour un dirigeant de PME qui publie lui-même, et l'URL de la source.";

const ROLE_RICO =
  "Tu es RICO, la voix de Postorico. Tu écris chaque semaine à des entrepreneurs, " +
  "artisans, commerçants et indépendants francophones qui gèrent eux-mêmes leur " +
  "présence sur les réseaux, ils n'ont ni agence ni temps à perdre.\n" +
  "Ta voix : directe, chaleureuse, concrète. Tu tutoies. Tu parles comme un ami qui " +
  "connaît le sujet, jamais comme un consultant. Zéro jargon marketing, zéro " +
  "superlatif creux, aucun emoji. Des phrases courtes.\n" +
  "Ta règle d'or : chaque paragraphe doit apprendre quelque chose d'utilisable cette " +
  "semaine. Si une information ne change rien pour le lecteur, tu la coupes.\n" +
  "Tu ne vends jamais Postorico frontalement : tu aides, et l'outil se devine.\n" +
  "TYPOGRAPHIE, non négociable : français impeccable, tous les accents (é, è, ê, à, ç, ô, û), " +
  "majuscules accentuées comprises, apostrophes courbes ', espaces insécables avant : ; ! ?, " +
  "guillemets français « ». Un texte sans accents est un texte fautif : relis-toi avant de rendre.\n" +
  "PONCTUATION : jamais de tiret cadratin ni de demi-cadratin, ni comme séparateur ni comme " +
  "incise. Utilise la virgule, le deux-points, le point ou les parenthèses. Le trait d'union (-) reste " +
  "réservé aux mots composés.";

const SCHEMA_LETTRE = {
  type: 'object',
  properties: {
    sujet: { type: 'string', description: "Objet de l'email, 5 à 9 mots, donne envie d'ouvrir, sans point final, accents inclus" },
    preheader: { type: 'string', description: "Texte de prévisualisation, 8 à 14 mots, complète l'objet sans le répéter" },
    titre: { type: 'string', description: 'Titre de la lettre, 4 à 8 mots' },
    edito: { type: 'string', description: 'L\'accroche de Rico, 2 à 3 phrases, pose le sujet de la semaine' },
    sections: {
      type: 'array',
      description: '2 à 3 sujets de fond : bonnes pratiques, stratégie, format par réseau',
      items: {
        type: 'object',
        properties: {
          titre: { type: 'string', description: '3 à 7 mots' },
          corps: { type: 'string', description: '2 à 4 phrases, concret et applicable' },
          astuce: { type: 'string', description: 'Le geste précis à faire, une phrase' },
        },
        required: ['titre', 'corps', 'astuce'],
        additionalProperties: false,
      },
    },
    actus: {
      type: 'array',
      description: '2 à 4 nouveautés de la semaine, tirées de la veille, avec leur source',
      items: {
        type: 'object',
        properties: {
          reseau: { type: 'string', description: 'LinkedIn, Instagram, TikTok, YouTube, Facebook ou X' },
          titre: { type: 'string', description: '4 à 8 mots' },
          resume: { type: 'string', description: '1 à 2 phrases : ce que ça change concrètement' },
          source: { type: 'string', description: 'URL exacte issue de la veille, ou chaîne vide' },
        },
        required: ['reseau', 'titre', 'resume', 'source'],
        additionalProperties: false,
      },
    },
    action: { type: 'string', description: 'L\'unique action à faire cette semaine, une phrase impérative' },
    signature: { type: 'string', description: 'Une phrase de fin, chaleureuse, signée Rico (sans répéter « Rico »)' },
  },
  required: ['sujet', 'preheader', 'titre', 'edito', 'sections', 'actus', 'action', 'signature'],
  additionalProperties: false,
};

// Ce que Postorico sait faire AUJOURD'HUI. La lettre ne doit jamais recommander un geste que
// l'outil ne permet pas. Mettre à jour à chaque nouvelle fonctionnalité livrée en prod.
const CAPACITES_POSTORICO =
  "- Studio IA : sujets, posts (LinkedIn, Instagram, Facebook, TikTok, YouTube, Google Business), " +
  "visuels IA à la charte, carrousels (une image par slide, texte dessiné dans l'image, UNE légende " +
  "pour tout le post), stories, reels animés.\n" +
  "- Plan éditorial (rafale), calendrier, publication et programmation via Zernio, boîte de " +
  "commentaires unifiée, statistiques de performance, fiche Google Business.\n" +
  "- Pas encore : légende différente par slide de carrousel, publication de sondages, " +
  "messages vocaux, stickers ou fonctions natives d'une appli, modification d'un post déjà publié, " +
  "réponse automatique aux DM.";

const ACCENT = '#3AFFA3';
const G1 = '#5B6CFF';
const G2 = '#8A6CFF';
const LOGO = 'https://res.cloudinary.com/dy9gp5pim/image/upload/brand/postorico-logo.png';
const HERO = 'https://res.cloudinary.com/dy9gp5pim/image/upload/brand/newsletter-hero.jpg';
const COULEUR_RESEAU: Record<string, string> = {
  linkedin: '#0A66C2', instagram: '#E1306C', tiktok: '#00F2EA',
  youtube: '#FF0000', facebook: '#1877F2', x: '#e2e8f0', twitter: '#e2e8f0',
};

const MOTS_VIDES = new Set([
  'cette', 'votre', 'notre', 'leurs', 'comme', 'avant', 'après', 'toutes', 'depuis', 'chaque', 'encore',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class NewsletterService implements OnApplicationBootstrap {
  private readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly mailService: MailService,
  ) {}

  onApplicationBootstrap() {
    // Petit délai initial pour ne pas charger au boot, puis premier passage du cron.
    setTimeout(() => void this.pollHebdo(), 120_000);
  }

  // ---------------------------------------------------------------------- Cron (poll 30 min)
  /** Newsletter hebdomadaire : chaque jour de semaine configuré (défaut mardi), heure locale
   * (défaut 9h), on prépare l'édition et on l'envoie à Martin pour validation. Rien ne part aux
   * abonnés sans son clic. Vérifie toutes les 30 min (fenêtre de 2h, robuste à un redémarrage). */
  @Interval(30 * 60 * 1000)
  async pollHebdo(): Promise<void> {
    if (!this.config.get<boolean>('app.newsletterCronActive')) return;
    try {
      const tz = this.config.get<string>('app.newsletterTz')!;
      const jourCible = this.config.get<number>('app.newsletterJour')!;
      const heureCible = this.config.get<number>('app.newsletterHeure')!;
      const { jourSemaine, heure } = this.maintenantDans(tz);

      if (jourSemaine === jourCible && heure >= heureCible && heure < heureCible + 2) {
        const recente = await this.derniereDuCycle(5);
        if (!recente) {
          this.logger.log("Newsletter hebdo : préparation de l'édition…");
          const res = await this.preparer();
          this.logger.log(`Newsletter hebdo : ${JSON.stringify(res)}`);
        }
      }
      // Une lettre préparée mais jamais validée depuis 20h : on rappelle Martin (une fois).
      for (const nl of await this.brouillonsEnAttente(20)) {
        await this.rappeler(nl);
      }
    } catch (e) {
      this.logger.error(`newsletter cron loop: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Jour de semaine (0=lundi … 6=dimanche, convention Python) et heure locale dans `tz`. */
  private maintenantDans(tz: string): { jourSemaine: number; heure: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Monday';
    let hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const noms = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const jourSemaine = noms.indexOf(weekdayName);
    let heure = parseInt(hourStr, 10);
    if (heure === 24) heure = 0; // Intl rend parfois "24" pour minuit en hour12:false
    return { jourSemaine: jourSemaine === -1 ? 0 : jourSemaine, heure };
  }

  // ----------------------------------------------------------------------------- 1. Veille
  /** Seconde source de veille : Perplexity (sonar-pro, via OpenRouter) lit le web en direct
   * et renvoie ses citations. Complète la recherche de Claude : deux moteurs, deux index,
   * moins de trous. Coût ≈ 3 à 5 centimes par appel. Ne lève jamais : {texte:"", sources:[]}. */
  private async veillePerplexity(question: string): Promise<VeilleResult> {
    const apiKey = this.config.get<string>('app.openrouterApiKey');
    const model = this.config.get<string>('app.newsletterPerplexityModel');
    if (!apiKey || !model) return { texte: '', sources: [] };
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://postorico.com',
          'X-Title': 'Postorico newsletter',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 2500,
          // Perplexity : ne lire que la semaine écoulée, avec un contexte de recherche large.
          search_recency_filter: 'week',
          web_search_options: { search_context_size: 'high' },
          messages: [
            { role: 'system', content: ROLE_VEILLE },
            { role: 'user', content: question + QUESTION_PERPLEXITY_SUFFIX },
          ],
        }),
      });
      const j = await resp.json();
      if (resp.status !== 200 || j.error) {
        this.logger.warn(`veille perplexity ${resp.status}: ${JSON.stringify(j).slice(0, 200)}`);
        return { texte: '', sources: [] };
      }
      const texte = String(j.choices?.[0]?.message?.content || '').trim();
      const urls: string[] = Array.isArray(j.citations) ? [...j.citations] : [];
      // les annotations url_citation (format OpenAI) portent parfois le titre
      for (const a of j.choices?.[0]?.message?.annotations || []) {
        const uc = a?.url_citation;
        if (uc?.url && !urls.includes(uc.url)) urls.push(uc.url);
      }
      const sources: VeilleSource[] = urls
        .filter((u) => typeof u === 'string' && u.startsWith('http'))
        .map((u) => ({ url: u, titre: '' }));
      const usage = j.usage || {};
      this.logger.log(`veille perplexity : ${sources.length} sources, coût ${usage.cost} $`);
      return { texte, sources };
    } catch (e) {
      this.logger.warn(`veille perplexity: ${e instanceof Error ? e.message : e}`);
      return { texte: '', sources: [] };
    }
  }

  /** Recherche web via l'outil natif de l'API, puis une passe Perplexity. */
  private async veille(): Promise<VeilleResult> {
    const aujourdhui = new Date();
    const debut = new Date(aujourdhui.getTime() - 7 * 24 * 60 * 60 * 1000);
    const question =
      `Nous sommes le ${dateFr(aujourdhui)}. Fais la veille des réseaux sociaux ` +
      `pour la semaine du ${dateFr(debut)} au ${dateFr(aujourdhui)}. ` +
      'Cible : entrepreneurs, artisans, PME et indépendants qui publient eux-mêmes.';

    let messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: question }];
    const textes: string[] = [];
    const sources: VeilleSource[] = [];
    const vus = new Set<string>();

    for (let i = 0; i < 4; i++) {
      // au plus 4 relances (pause_turn)
      const resp = await this.claude.messagesCreate({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        system: ROLE_VEILLE,
        tools: [WEB_SEARCH],
        messages,
      });
      if (resp.stop_reason === 'refusal') throw new Error('veille refusee par le modele');
      for (const b of resp.content) {
        if (b.type === 'text' && (b.text || '').trim()) {
          textes.push(b.text);
        } else if (b.type === 'web_search_tool_result') {
          const res = b.content;
          for (const r of Array.isArray(res) ? res : []) {
            if (r.url && !vus.has(r.url)) {
              vus.add(r.url);
              sources.push({ url: r.url, titre: (r.title || '').slice(0, 160) });
            }
          }
        }
      }
      if (resp.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: resp.content }];
    }

    let texte = textes.join('\n\n').trim();
    // Perplexity en complément : son texte est ajouté sous un intertitre, ses sources dédoublonnées.
    const px = await this.veillePerplexity(question);
    if (px.texte) {
      texte = `${texte}\n\n### Veille complémentaire (Perplexity)\n\n${px.texte}`.trim();
      for (const src of px.sources) {
        if (!vus.has(src.url)) {
          vus.add(src.url);
          sources.push(src);
        }
      }
    }
    const sourcesLimitees = sources.slice(0, 40);
    // La liste des adresses, en clair, à la fin : le rédacteur doit recopier l'URL exacte
    // d'une source pour chaque actu, il faut donc qu'il les voie.
    if (sourcesLimitees.length) {
      texte +=
        "\n\n### SOURCES (recopier l'URL exacte dans le champ source de chaque actu)\n" +
        sourcesLimitees.map((s) => `- ${s.url}${s.titre ? ` — ${s.titre}` : ''}`).join('\n');
    }
    return { texte, sources: sourcesLimitees };
  }

  // -------------------------------------------------------------------------- 2. Redaction
  /** Les mots porteurs d'un titre (5 lettres et plus, sans les mots-outils). */
  private motsCles(texte: string): string[] {
    const matches = (texte || '').toLowerCase().match(/[a-zà-ü0-9]{5,}/g) || [];
    return matches.filter((m) => !MOTS_VIDES.has(m));
  }

  /** La source de veille dont le titre ou l'adresse partage le plus de mots avec l'actu
   * (réseau compris) ; vide si rien ne colle vraiment. */
  private sourceParTitre(actu: LettreActu, sources: VeilleSource[]): string {
    const mots = new Set(this.motsCles(`${actu.reseau || ''} ${actu.titre || ''} ${actu.resume || ''}`));
    let meilleur = '';
    let score = 0;
    for (const s of sources) {
      const cible = `${s.titre || ''} ${s.url || ''}`.toLowerCase();
      let n = 0;
      for (const m of mots) if (cible.includes(m)) n++;
      if (n > score) {
        meilleur = s.url || '';
        score = n;
      }
    }
    return score >= 2 ? meilleur : '';
  }

  /** Remplace les tirets longs dans tout texte généré : « A, B » au lieu de « A — B », le
   * modèle a la consigne mais une lettre qui part est définitive. */
  private sansTirets<T>(valeur: T): T {
    if (typeof valeur === 'string') {
      let v = valeur.replace(/\s*[—–]\s*/g, ', ');
      v = v.replace(/^, /, '');                 // pas de virgule en tête de texte
      v = v.replace(/([.!?»]) *, /g, '$1 ');     // ni en début de phrase
      v = v.replace(/,\s*,/g, ',').replace(/ ,/g, ',');
      return v as unknown as T;
    }
    if (Array.isArray(valeur)) {
      return valeur.map((x) => this.sansTirets(x)) as unknown as T;
    }
    if (valeur && typeof valeur === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(valeur as Record<string, unknown>)) out[k] = this.sansTirets(x);
      return out as unknown as T;
    }
    return valeur;
  }

  /** Garde-fous après rédaction : on n'invente rien. Une actu est gardée si la veille en parle
   * (les mots de son titre et de son résumé apparaissent dans le texte de veille) ; sa source
   * doit être une URL de la veille, sinon on prend l'URL la plus proche du passage qui en
   * parle, sinon vide. Une actu que la veille ne mentionne pas est retirée. */
  private verifierLettre(data: LettreData, veilleRes: VeilleResult): LettreData {
    const texte = veilleRes.texte || '';
    const bas = texte.toLowerCase();
    const urls = (veilleRes.sources || []).map((s) => s.url).filter(Boolean);
    const urlsTexte: Array<[number, string]> = [];
    const re = /https?:\/\/[^\s)\]]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(texte))) {
      urlsTexte.push([m.index, m[0].replace(/[).,;]+$/, '')]);
    }

    const actus: LettreActu[] = [];
    for (const a of data.actus || []) {
      const mots = this.motsCles(`${a.titre || ''} ${a.resume || ''}`);
      const presents = mots.filter((mm) => bas.includes(mm));
      if (mots.length >= 3 && presents.length < Math.max(2, Math.floor(mots.length / 3))) {
        this.logger.log(`newsletter : actu absente de la veille, retirée « ${a.titre} »`);
        continue;
      }
      let src = (a.source || '').trim();
      if (!(src.startsWith('http') && urls.some((u) => src.replace(/\/$/, '').includes(u!.replace(/\/$/, '')) || u!.replace(/\/$/, '').includes(src.replace(/\/$/, ''))))) {
        // URL absente de la veille (générique ou inventée) : la plus proche du passage
        // concerné, sinon une source de la veille dont le titre parle du même sujet.
        let pos = -1;
        for (const mm of presents) {
          const idx = bas.indexOf(mm);
          if (idx >= 0 && (pos === -1 || idx < pos)) pos = idx;
        }
        src = '';
        if (pos >= 0 && urlsTexte.length) {
          src = urlsTexte.reduce((best, cur) => (Math.abs(cur[0] - pos) < Math.abs(best[0] - pos) ? cur : best))[1];
        }
        a.source = src || this.sourceParTitre(a, veilleRes.sources || []);
      }
      actus.push(a);
    }
    data.actus = actus.length >= 2 ? actus.slice(0, 4) : [];
    return data;
  }

  /** Claude écrit la lettre à la voix de Rico. Sortie JSON validée par schéma. */
  private async rediger(veilleRes: VeilleResult, numero: number): Promise<LettreData> {
    const consigne =
      `Voici la veille des réseaux sociaux de la semaine (numéro ${numero} de la lettre, ` +
      `nous sommes le ${dateFr(new Date())}) :\n\n` +
      `${veilleRes.texte.slice(0, 40000)}\n\n` +
      "Écris la lettre de cette semaine. Contraintes :\n" +
      "- 2 à 3 sections de fond (bonnes pratiques, stratégie, formats par réseau)\n" +
      "- 2 à 4 actus tirées STRICTEMENT de la veille ci-dessus (n'invente aucune information, " +
      "aucune date, aucun chiffre) ; recopie l'URL source exacte quand elle existe\n" +
      "- une seule action à faire cette semaine, réalisable en moins de 30 minutes\n" +
      "- si la veille est pauvre sur un réseau, ne parle pas de ce réseau\n" +
      "- accentuation parfaite : aucun mot français ne doit perdre ses accents.\n\n" +
      "CE QUE POSTORICO PERMET (vérité produit, à respecter à la lettre) :\n" +
      `${CAPACITES_POSTORICO}\n` +
      "RÈGLE : l'action de la semaine et les astuces ne recommandent que des gestes réalisables " +
      "dans Postorico avec les fonctions ci-dessus, ou des gestes de fond (répondre aux " +
      "commentaires, choisir un thème, régularité). Une nouveauté d'un réseau que Postorico ne " +
      "propose pas encore se RACONTE dans les actus, mais ne devient jamais l'action ni une " +
      "astuce, et on ne laisse jamais croire qu'elle se fait dans Postorico.";

    const resp = await this.claude.messagesCreate({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA_LETTRE } },
      system: ROLE_RICO,
      messages: [{ role: 'user', content: consigne }],
    });
    if (resp.stop_reason === 'refusal') throw new Error('redaction refusee par le modele');
    const brut = resp.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')?.text || '';
    let data = JSON.parse(brut) as LettreData;
    data = this.sansTirets(data);
    data = this.verifierLettre(data, veilleRes);
    data.numero = numero;
    data.date = dateFr(new Date());
    return data;
  }

  // ------------------------------------------------------------------------------ 3. Rendu
  private e(t: unknown): string {
    return String(t ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\n/g, '<br>');
  }

  private lienDesinscription(token: string): string {
    return `${this.config.get<string>('app.backendUrl')}/api/newsletter/desinscription?token=${token}`;
  }

  /** La lettre en HTML email (tables + styles inline : compatible tous clients). */
  renduHtml(dataIn: LettreData, unsubUrl = '#', apercuUrl = ''): string {
    const data = this.sansTirets(dataIn);
    const sections = (data.sections || [])
      .map(
        (s: LettreSection) => `
      <tr><td style="padding:0 34px 26px;">
        <h2 style="margin:0 0 10px;color:#ffffff;font-size:18px;font-weight:bold;line-height:1.35;">${this.e(s.titre)}</h2>
        <p style="margin:0 0 14px;color:#c3ccdb;font-size:15px;line-height:1.65;">${this.e(s.corps)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="background:rgba(58,255,163,0.07);border-left:3px solid ${ACCENT};padding:12px 16px;">
            <span style="color:${ACCENT};font-size:11px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;">Le geste</span><br>
            <span style="color:#e2e8f0;font-size:14px;line-height:1.6;">${this.e(s.astuce)}</span>
          </td>
        </tr></table>
      </td></tr>`,
      )
      .join('');

    let actus = '';
    for (const a of data.actus || []) {
      const reseau = String(a.reseau || '');
      const couleur = COULEUR_RESEAU[reseau.toLowerCase().trim()] || '#94a3b8';
      const src = String(a.source || '').trim();
      const lien = src.startsWith('http')
        ? `<a href="${this.e(src)}" target="_blank" style="color:#8A6CFF;font-size:12px;text-decoration:underline;">Lire la source</a>`
        : '';
      actus += `
          <tr><td style="padding:0 0 18px;">
            <span style="display:inline-block;background:${couleur}1f;color:${couleur};font-size:11px;font-weight:bold;
                         padding:3px 10px;border-radius:99px;letter-spacing:.04em;">${this.e(reseau)}</span>
            <div style="color:#ffffff;font-size:15px;font-weight:bold;margin:8px 0 4px;">${this.e(a.titre)}</div>
            <div style="color:#a8b3c5;font-size:14px;line-height:1.6;">${this.e(a.resume)}</div>
            <div style="margin-top:6px;">${lien}</div>
          </td></tr>`;
    }
    const blocActus = actus
      ? `
      <tr><td style="padding:6px 34px 8px;">
        <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:24px;"></div>
        <h2 style="margin:0 0 18px;color:#ffffff;font-size:18px;font-weight:bold;">Ce qui a bougé cette semaine</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${actus}</table>
      </td></tr>`
      : '';

    const voirEnLigne = apercuUrl
      ? `<a href="${this.e(apercuUrl)}" target="_blank" style="color:#64748b;text-decoration:underline;">Lire dans le navigateur</a> · `
      : '';

    return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this.e(data.sujet)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${this.e(data.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:28px 14px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:600px;background:#0f172a;border:1px solid rgba(0,0,0,0.08);border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.12);">

        <!-- En-tete -->
        <tr><td style="padding:30px 34px 6px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td>
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="background:#ffffff;border-radius:11px;padding:6px;line-height:0;">
                  <img src="${LOGO}" width="34" height="34" alt="Postorico" style="display:block;width:34px;height:34px;border:0;">
                </td>
                <td style="padding-left:11px;color:#ffffff;font-size:17px;font-weight:bold;letter-spacing:-.01em;">Postorico</td>
              </tr></table>
            </td>
            <td align="right" style="color:#64748b;font-size:11.5px;">
              N°${this.e(data.numero)} · ${this.e(data.date)}
            </td>
          </tr></table>
        </td></tr>

        <!-- Bandeau Rico -->
        <tr><td style="padding:16px 0 0;line-height:0;">
          <img src="${HERO}" width="600" alt="Postorico" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
        </td></tr>

        <!-- Titre + edito -->
        <tr><td style="padding:22px 34px 4px;">
          <span style="display:inline-block;color:${ACCENT};font-size:11px;font-weight:bold;letter-spacing:.18em;text-transform:uppercase;">La lettre de Rico</span>
          <h1 style="margin:10px 0 14px;color:#ffffff;font-size:27px;line-height:1.25;font-weight:bold;letter-spacing:-.02em;">${this.e(data.titre)}</h1>
          <p style="margin:0 0 26px;color:#c3ccdb;font-size:15.5px;line-height:1.7;">${this.e(data.edito)}</p>
        </td></tr>

        ${sections}
        ${blocActus}

        <!-- Action de la semaine -->
        <tr><td style="padding:10px 34px 30px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:linear-gradient(135deg,${G1},${G2});border-radius:14px;">
            <tr><td style="padding:22px 24px;">
              <span style="color:rgba(255,255,255,0.72);font-size:11px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;">Ton action de la semaine</span>
              <div style="color:#ffffff;font-size:16.5px;line-height:1.55;font-weight:bold;margin-top:9px;">${this.e(data.action)}</div>
            </td></tr>
          </table>
        </td></tr>

        <!-- Signature -->
        <tr><td style="padding:0 34px 30px;">
          <p style="margin:0 0 6px;color:#c3ccdb;font-size:15px;line-height:1.65;">${this.e(data.signature)}</p>
          <p style="margin:0;color:#ffffff;font-size:15px;font-weight:bold;">Rico</p>
          <p style="margin:2px 0 0;color:#64748b;font-size:12.5px;">Postorico, ta présence sociale pilotée par l'IA</p>
        </td></tr>

        <!-- Pied -->
        <tr><td style="padding:20px 34px 26px;border-top:1px solid rgba(255,255,255,0.06);">
          <p style="margin:0 0 8px;color:#64748b;font-size:11.5px;line-height:1.6;">
            Une question, un sujet à traiter&nbsp;? Réponds simplement à cet email, Rico lit tout.
          </p>
          <p style="margin:0;color:#475569;font-size:11px;">
            ${voirEnLigne}<a href="${this.e(unsubUrl)}" target="_blank" style="color:#475569;text-decoration:underline;">Se désinscrire</a>
            · © ${new Date().getUTCFullYear()} Postorico
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  // ---------------------------------------------------------------------------- 4. Abonnes
  /** Ajoute les nouveaux emails (clients + leads d'audit). Ne ressuscite JAMAIS une
   * désinscription : l'index unique sur lower(email) protège des doublons. */
  async syncAbonnes(): Promise<number> {
    try {
      const connus = new Set(
        (await this.prisma.newsletter_abonnes.findMany({ select: { email: true } })).map((a) => a.email.toLowerCase()),
      );
      const candidats = new Map<string, { email: string; nom: string | null; source: string }>();
      for (const row of await this.prisma.users.findMany({ select: { email: true, nom: true } })) {
        const email = (row.email || '').trim();
        if (email && email.includes('@') && !connus.has(email.toLowerCase())) {
          candidats.set(email.toLowerCase(), { email, nom: row.nom, source: 'app' });
        }
      }
      for (const row of await this.prisma.brand_audits.findMany({ select: { email: true, marque: true } })) {
        const email = (row.email || '').trim();
        if (email && email.includes('@') && !connus.has(email.toLowerCase()) && !candidats.has(email.toLowerCase())) {
          candidats.set(email.toLowerCase(), { email, nom: row.marque, source: 'audit' });
        }
      }
      if (candidats.size) {
        await this.prisma.newsletter_abonnes.createMany({ data: [...candidats.values()] });
      }
      return candidats.size;
    } catch (e) {
      this.logger.error(`newsletter sync abonnes: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  /** Inscription publique. Une désinscription passée est respectée (pas de réactivation
   * silencieuse) : on renvoie simplement 'ok' sans rien changer. */
  async abonner(email: string, nom?: string | null, source = 'site'): Promise<{ ok?: boolean; deja?: boolean; error?: string }> {
    const em = (email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(em)) return { error: 'Email invalide.' };
    try {
      const existant = await this.prisma.newsletter_abonnes.findFirst({
        where: { email: { equals: em, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existant) return { ok: true, deja: true };
      await this.prisma.newsletter_abonnes.create({ data: { email: em, nom: nom || null, source } });
      return { ok: true };
    } catch (e) {
      this.logger.error(`newsletter abonner: ${e instanceof Error ? e.message : e}`);
      return { error: 'Inscription impossible.' };
    }
  }

  async desabonner(token: string): Promise<{ ok?: boolean; email?: string; error?: string }> {
    try {
      const updated = await this.prisma.newsletter_abonnes.updateMany({
        where: { token },
        data: { statut: 'desinscrit', unsubscribed_at: new Date() },
      });
      if (!updated.count) return { error: 'Lien de désinscription inconnu.' };
      const row = await this.prisma.newsletter_abonnes.findUnique({ where: { token }, select: { email: true } });
      return { ok: true, email: row?.email };
    } catch (e) {
      this.logger.error(`newsletter desabonner: ${e instanceof Error ? e.message : e}`);
      return { error: 'Désinscription impossible.' };
    }
  }

  async abonnesActifs(): Promise<Array<{ email: string; nom: string | null; token: string }>> {
    try {
      return await this.prisma.newsletter_abonnes.findMany({
        where: { statut: 'actif' },
        select: { email: true, nom: true, token: true },
      });
    } catch (e) {
      this.logger.error(`newsletter abonnes actifs: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  // ------------------------------------------------------------------ 5. Preparation + validation
  private async numeroSuivant(): Promise<number> {
    try {
      const r = await this.prisma.newsletters.findFirst({
        where: { numero: { not: null } },
        orderBy: { numero: 'desc' },
        select: { numero: true },
      });
      return (r?.numero || 0) + 1;
    } catch {
      return 1;
    }
  }

  /** Une édition préparée dans les N derniers jours ? (anti-doublon du cron). */
  private async derniereDuCycle(jours = 5) {
    const depuis = new Date(Date.now() - jours * 24 * 60 * 60 * 1000);
    try {
      return await this.prisma.newsletters.findFirst({
        where: { created_at: { gte: depuis } },
        orderBy: { created_at: 'desc' },
        select: { id: true, statut: true, created_at: true },
      });
    } catch (e) {
      this.logger.error(`newsletter derniere: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Lettres préparées depuis plus de N heures, toujours en brouillon et jamais rappelées. */
  private async brouillonsEnAttente(heures = 20) {
    const limite = new Date(Date.now() - heures * 60 * 60 * 1000);
    // Pas de rappel pour une lettre de plus d'une semaine : son cycle est passé.
    const plancher = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    try {
      const rows = await this.prisma.newsletters.findMany({
        where: { statut: 'brouillon', created_at: { lte: limite, gte: plancher } },
        orderBy: { created_at: 'desc' },
        take: 3,
      });
      return rows.filter((nl) => !(nl.data as LettreData | null)?._rappel_le);
    } catch (e) {
      this.logger.error(`newsletter brouillons: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Renvoie l'email de validation d'une lettre restée en brouillon (une seule fois). Le mardi,
   * un email de validation se perd facilement : sans clic, rien ne part, et la semaine passe. */
  private async rappeler(nl: { id: string; numero: number | null; data: unknown; token: string }): Promise<void> {
    const data = { ...(nl.data as LettreData) };
    const { id: nid, token } = nl;
    const base = `${this.config.get<string>('app.backendUrl')}/api/newsletter`;
    const total = (await this.abonnesActifs()).length;
    let html = this.htmlValidation(data, nid, token, total, 0, 0, this.renduHtml(data, `${base}/desinscription?token=apercu`, `${base}/apercu/${nid}?token=${token}`));
    html = html.replace('En attente de ta validation', 'Rappel : lettre toujours en attente de ta validation');
    try {
      await this.mailService.sendEmail(
        this.config.get<string>('app.adminNotifEmail')!,
        `Rappel, à valider : ${data.sujet}`,
        html,
      );
    } catch (e) {
      this.logger.error(`newsletter rappel ${nid}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    data._rappel_le = new Date().toISOString();
    await this.prisma.newsletters.update({ where: { id: nid }, data: { data: data as unknown as Prisma.InputJsonValue } });
    this.logger.log(`newsletter n°${nl.numero} : rappel de validation envoyé`);
  }

  /** Veille -> redaction -> brouillon en base -> email de validation à l'admin. */
  async preparer(): Promise<{ id?: string; numero?: number; sujet?: string; abonnes?: number; error?: string }> {
    const numero = await this.numeroSuivant();
    this.logger.log(`newsletter n°${numero} : veille en cours…`);
    const veilleRes = await this.veille();
    if (veilleRes.texte.length < 200) {
      return { error: 'Veille trop pauvre cette semaine : rien à publier.' };
    }
    this.logger.log(`newsletter n°${numero} : rédaction (${veilleRes.sources.length} sources)`);
    const data = await this.rediger(veilleRes, numero);

    const nl = await this.prisma.newsletters.create({
      data: {
        numero,
        sujet: data.sujet,
        preheader: data.preheader,
        data: data as unknown as Prisma.InputJsonValue,
        sources: veilleRes.sources as unknown as Prisma.InputJsonValue,
        statut: 'brouillon',
      },
    });
    const { id: nid, token } = nl;

    const nb = await this.syncAbonnes();
    const total = (await this.abonnesActifs()).length;
    const base = `${this.config.get<string>('app.backendUrl')}/api/newsletter`;
    const apercu = `${base}/apercu/${nid}?token=${token}`;
    const corps = this.renduHtml(data, `${base}/desinscription?token=apercu`, apercu);

    try {
      await this.mailService.sendEmail(
        this.config.get<string>('app.adminNotifEmail')!,
        `À valider : ${data.sujet}`,
        this.htmlValidation(data, nid, token, total, nb, veilleRes.sources.length, corps),
      );
    } catch (e) {
      this.logger.error(`newsletter email validation: ${e instanceof Error ? e.message : e}`);
    }
    this.logger.log(`newsletter n°${numero} prête (id ${nid}) — en attente de validation`);
    return { id: nid, numero, sujet: data.sujet, abonnes: total };
  }

  /** Email interne : la lettre complète + les deux boutons de décision. */
  private htmlValidation(
    data: LettreData,
    nid: string,
    token: string,
    total: number,
    nouveaux: number,
    nbSources: number,
    corps: string,
  ): string {
    const base = `${this.config.get<string>('app.backendUrl')}/api/newsletter`;
    const valider = `${base}/valider/${nid}?token=${token}`;
    const refuser = `${base}/refuser/${nid}?token=${token}`;
    const entete = `
<div style="max-width:600px;margin:0 auto 18px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#0b1322;border:1px solid rgba(255,255,255,0.09);border-radius:14px;">
    <tr><td style="padding:22px 24px;">
      <div style="color:#fbbf24;font-size:11px;font-weight:bold;letter-spacing:.16em;text-transform:uppercase;">En attente de ta validation</div>
      <div style="color:#ffffff;font-size:19px;font-weight:bold;margin:8px 0 4px;">Lettre n°${this.e(data.numero)} : ${this.e(data.sujet)}</div>
      <div style="color:#94a3b8;font-size:13px;line-height:1.6;">
        ${total} abonné(s) actifs${nouveaux ? ` · ${nouveaux} nouveau(x) cette semaine` : ''} · ${nbSources} sources de veille<br>
        Rien ne part tant que tu n'as pas cliqué. Aperçu complet ci-dessous.
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr>
        <td style="background:#3AFFA3;border-radius:10px;">
          <a href="${valider}" target="_blank" style="display:inline-block;padding:13px 26px;color:#05261a;font-size:14.5px;font-weight:bold;text-decoration:none;">
            Envoyer aux ${total} abonnés
          </a>
        </td>
        <td style="width:10px;"></td>
        <td style="border:1px solid rgba(255,255,255,0.16);border-radius:10px;">
          <a href="${refuser}" target="_blank" style="display:inline-block;padding:12px 22px;color:#94a3b8;font-size:14px;text-decoration:none;">
            Ne pas envoyer
          </a>
        </td>
      </tr></table>
    </td></tr>
  </table>
</div>`;
    // On injecte le bandeau juste après <body …> de la lettre rendue.
    return corps.replace(/(<body[^>]*>)/, `$1${entete}`);
  }

  /** Petite page de confirmation (retour navigateur après un clic dans l'email). */
  page(titre: string, message: string, ok = true): string {
    const couleur = ok ? '#3AFFA3' : '#f87171';
    const frontendUrl = this.config.get<string>('app.frontendUrl');
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${this.e(titre)}</title></head>
<body style="margin:0;background:#020617;font-family:system-ui,-apple-system,Arial,sans-serif;">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div style="max-width:460px;text-align:center;">
      <img src="${LOGO}" width="46" height="46" alt="Postorico" style="border-radius:12px;background:#fff;padding:7px;">
      <h1 style="color:${couleur};font-size:22px;margin:22px 0 10px;">${this.e(titre)}</h1>
      <p style="color:#94a3b8;font-size:15px;line-height:1.7;margin:0 0 26px;">${this.e(message)}</p>
      <a href="${frontendUrl}" style="color:#8A6CFF;font-size:14px;text-decoration:none;">Retour sur Postorico</a>
    </div>
  </div>
</body></html>`;
  }

  async charger(nid: string, token: string) {
    try {
      return await this.prisma.newsletters.findFirst({ where: { id: nid, token } });
    } catch (e) {
      this.logger.error(`newsletter charger: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Clic sur « Envoyer » : fige le rendu et lance l'envoi en tâche de fond. */
  async valider(nid: string, token: string): Promise<string> {
    const nl = await this.charger(nid, token);
    if (!nl) return this.page('Lien invalide', "Cette lettre n'existe pas ou le lien a expiré.", false);
    if (nl.statut === 'envoyee') {
      return this.page('Déjà envoyée', `La lettre n°${nl.numero} est partie à ${nl.nb_envoyes} abonnés.`);
    }
    if (nl.statut === 'refusee') {
      return this.page('Lettre refusée', "Tu avais choisi de ne pas l'envoyer.", false);
    }

    await this.prisma.newsletters.update({ where: { id: nid }, data: { statut: 'validee' } });
    const total = (await this.abonnesActifs()).length;
    void this.envoyer(nid).catch((e) => this.logger.error(`newsletter envoi ${nid}: ${e instanceof Error ? e.message : e}`));
    return this.page(
      "C'est parti ✓",
      `La lettre n°${nl.numero} part vers ${total} abonnés. Tu recevras un récapitulatif dès que l'envoi est terminé.`,
    );
  }

  async refuser(nid: string, token: string): Promise<string> {
    const nl = await this.charger(nid, token);
    if (!nl) return this.page('Lien invalide', "Cette lettre n'existe pas ou le lien a expiré.", false);
    if (nl.statut === 'envoyee') {
      return this.page('Trop tard', 'Cette lettre a déjà été envoyée.', false);
    }
    await this.prisma.newsletters.update({ where: { id: nid }, data: { statut: 'refusee' } });
    return this.page('Lettre annulée', 'Elle ne sera pas envoyée. La prochaine sera préparée au prochain cycle.');
  }

  /** Envoi effectif, un email par abonné (lien de désinscription personnel). Cadence
   * volontairement lente : Resend limite le débit. */
  private async envoyer(nid: string): Promise<void> {
    try {
      const nl = await this.prisma.newsletters.findUnique({ where: { id: nid } });
      if (!nl || !['validee', 'echec'].includes(nl.statut)) return;
      const data = (nl.data as LettreData) || ({} as LettreData);
      const sujet = nl.sujet || data.sujet || 'La lettre de Rico';
      const apercu = `${this.config.get<string>('app.backendUrl')}/api/newsletter/apercu/${nid}?token=${nl.token}`;
      const abonnes = await this.abonnesActifs();
      let ok = 0;
      let ko = 0;
      for (const ab of abonnes) {
        const unsub = this.lienDesinscription(ab.token);
        const html = this.renduHtml(data, unsub, apercu);
        try {
          const res = await this.mailService.sendEmail(ab.email, sujet, html, undefined, unsub);
          if (res.error) ko++;
          else ok++;
        } catch (e) {
          ko++;
          this.logger.warn(`newsletter envoi ${ab.email}: ${e instanceof Error ? e.message : e}`);
        }
        await sleep(600); // ~1,6 envoi/s : sous la limite Resend
      }
      await this.prisma.newsletters.update({
        where: { id: nid },
        data: {
          statut: 'envoyee',
          nb_envoyes: ok,
          nb_erreurs: ko,
          html: this.renduHtml(data, '#', apercu),
          sent_at: new Date(),
        },
      });
      this.logger.log(`newsletter ${nid} envoyée : ${ok} ok / ${ko} erreurs`);
      try {
        await this.mailService.sendEmail(
          this.config.get<string>('app.adminNotifEmail')!,
          `Envoyée : ${sujet}`,
          `<p>Lettre n°${nl.numero} envoyée : ${ok} email(s) délivrés${ko ? ` · ${ko} échec(s)` : ''}. <a href="${apercu}">Revoir la lettre</a></p>`,
        );
      } catch (e) {
        this.logger.warn(`newsletter recap admin: ${e instanceof Error ? e.message : e}`);
      }
    } catch (e) {
      this.logger.error(`newsletter envoi ${nid}: ${e instanceof Error ? e.message : e}`);
      try {
        await this.prisma.newsletters.update({
          where: { id: nid },
          data: { statut: 'echec', erreur: String(e instanceof Error ? e.message : e).slice(0, 300) },
        });
      } catch {
        /* best-effort */
      }
    }
  }

  // -------------------------------------------------------------------------------- Admin
  async editions(limit = 30) {
    return this.prisma.newsletters.findMany({
      select: {
        id: true, numero: true, sujet: true, statut: true,
        nb_envoyes: true, nb_erreurs: true, created_at: true, sent_at: true, token: true,
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async abonnes() {
    const rows = await this.prisma.newsletter_abonnes.findMany({
      select: { email: true, nom: true, source: true, statut: true, created_at: true },
    });
    return {
      total: rows.length,
      actifs: rows.filter((a) => a.statut === 'actif').length,
      desinscrits: rows.filter((a) => a.statut === 'desinscrit').length,
      abonnes: rows,
    };
  }
}