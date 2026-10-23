import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from '../claude/claude.service';
import { MarqueService } from '../marque/marque.service';

const LANGUES: Record<string, string> = { fr: 'French', en: 'English', es: 'Spanish' };
/** Note minimale du contrôle qualité ; en dessous, le script est réécrit (2 fois au plus). */
export const SEUIL_QUALITE = 90;

export interface AnalyseReel {
  duree_s: number;
  accroche: { texte: string; mots: number; pourquoi: string };
  transcription: Array<{ t: number; texte: string }>;
  structure: Array<{ debut: number; fin: number; role: string; resume: string }>;
  rythme: { plans: number; coupe_toutes_s: number; texte_ecran: string };
  textes_ecran: Array<{ t: number; texte: string }>;
  plans: Array<{ t: number; type: string; description: string }>;
  langage: { phrase_moyenne_mots: number; adresse: string; style: string };
  appel_action: string;
  technique_cle: string;
}

export interface ScriptReel {
  accroche: string;
  lignes: Array<{ debut: number; fin: number; voix: string; texte_ecran: string; plan: string }>;
  legende: string;
  mot_cle: string | null;
  duree_s: number;
}

export interface Controle {
  score: number;
  details: Record<string, number>;
  violations: string[];
}

const PROMPT_ANALYSE =
  'You are a short-form video strategist. Watch this reference Reel in full and break down WHY it works, ' +
  'so its STRUCTURE (not its content) can be reused by another brand. Be precise and factual: only what you see and hear. ' +
  'Return STRICT JSON with this exact shape:\n' +
  '{"duree_s": number, ' +
  '"accroche": {"texte": "the exact first spoken words (or on-screen words if silent)", "mots": number of words, "pourquoi": "what stops the scroll"}, ' +
  '"transcription": [{"t": seconds, "texte": "what is said"}], ' +
  '"structure": [{"debut": s, "fin": s, "role": "one of: accroche, probleme, contexte, preuve, bascule, astuce, demonstration, appel", "resume": "one line"}], ' +
  '"rythme": {"plans": number of shots/cuts, "coupe_toutes_s": average seconds between cuts, "texte_ecran": "toujours | souvent | rare | jamais"}, ' +
  '"textes_ecran": [{"t": seconds, "texte": "on-screen text as written"}], ' +
  '"plans": [{"t": seconds, "type": "face camera | gros plan | b-roll | ecran | texte seul | autre", "description": "what is filmed"}], ' +
  '"langage": {"phrase_moyenne_mots": number, "adresse": "who it talks to: tu / vous / nous / impersonnel", "style": "one line"}, ' +
  '"appel_action": "the call to action, or empty", ' +
  '"technique_cle": "the single most reusable technique, one or two sentences"}';

/**
 * « M'inspirer d'un reel qui marche » : Gemini (vidéo) décortique un reel de référence importé par
 * le client (accroche, structure minutée, rythme, textes à l'écran, plans, technique clé), puis
 * Claude écrit un script ADAPTÉ à la marque qui en reprend la structure, jamais le contenu, et un
 * contrôle qualité noté le fait réécrire s'il est sous le seuil. Méthode inspirée de la skill
 * reels-scripting (charlie947/social-media-skills, MIT), complétée des textes à l'écran et plans.
 * La vidéo n'est jamais stockée : elle part directement dans la requête à Gemini.
 */
@Injectable()
export class InspirationReelService {
  private readonly logger = new Logger(InspirationReelService.name);
  private readonly cleOpenrouter: string;
  private readonly modeleVideo: string;
  private readonly modeleScript: string;

  constructor(
    private readonly claude: ClaudeService,
    private readonly marqueService: MarqueService,
    config: ConfigService,
  ) {
    this.cleOpenrouter = config.get<string>('app.openrouterApiKey') || '';
    this.modeleVideo = config.get<string>('app.openrouterVideoModel') || 'google/gemini-3.8-flash';
    this.modeleScript = config.get<string>('app.claudeModel') || 'claude-sonnet-4-6';
  }

  get actif(): boolean {
    return Boolean(this.cleOpenrouter);
  }

  private json<T>(raw: string): T {
    const debut = raw.indexOf('{');
    const fin = raw.lastIndexOf('}');
    if (debut === -1 || fin <= debut) throw new Error('réponse sans JSON');
    return JSON.parse(raw.slice(debut, fin + 1)) as T;
  }

  /** Analyse du reel de référence (vidéo envoyée telle quelle à Gemini). */
  async analyser(telegramId: string, video: Buffer, mime = 'video/mp4'): Promise<AnalyseReel> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const langue = LANGUES[String(u.langue || 'fr').toLowerCase()] || 'French';
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cleOpenrouter}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://postorico.com',
        'X-Title': 'Postorico inspiration reel',
      },
      body: JSON.stringify({
        model: this.modeleVideo,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${PROMPT_ANALYSE}\n\nKeep "transcription", "accroche.texte" and "textes_ecran" in the ORIGINAL language of the video. Write every other text field (pourquoi, resume, style, technique_cle, description) in ${langue.toUpperCase()}.`,
              },
              { type: 'video_url', video_url: { url: `data:${mime};base64,${video.toString('base64')}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
    if (!resp.ok || j.error) throw new Error(`analyse Gemini ${resp.status} ${JSON.stringify(j.error || '').slice(0, 200)}`);
    return normaliserAnalyse(this.json<Record<string, unknown>>(j.choices?.[0]?.message?.content || ''));
  }

  /** Script adapté à la marque, contrôlé et réécrit au besoin. */
  async ecrireScript(
    telegramId: string,
    analyse: AnalyseReel,
    sujet: string,
  ): Promise<{ script: ScriptReel; controle: Controle; passes: number }> {
    const u = await this.marqueService.chargerMarque(telegramId);
    const langue = LANGUES[String(u.langue || 'fr').toLowerCase()] || 'French';
    let script = await this.rediger(u, langue, analyse, sujet, null);
    let controle = await this.controler(langue, analyse, sujet, script);
    let passes = 1;
    while (controle.score < SEUIL_QUALITE && passes < 3) {
      script = await this.rediger(u, langue, analyse, sujet, { script, violations: controle.violations });
      controle = await this.controler(langue, analyse, sujet, script);
      passes += 1;
    }
    return { script, controle, passes };
  }

  private async rediger(
    u: Record<string, unknown>,
    langue: string,
    analyse: AnalyseReel,
    sujet: string,
    correction: { script: ScriptReel; violations: string[] } | null,
  ): Promise<ScriptReel> {
    const motsAccroche = analyse.accroche.mots || 8;
    const resp = await this.claude.messagesCreate({
      model: this.modeleScript,
      max_tokens: 1800,
      system:
        `You adapt the STRUCTURE of a reference Reel to a new subject for a small business owner, in ${langue.toUpperCase()}. ` +
        'Reuse the reference rhythm, sections, hook mechanism and on-screen text habits; NEVER reuse its words, claims or music. ' +
        'RULES: the hook never starts with "I" / "Je" / "Yo"; the hook has about the same number of words as the reference hook ' +
        `(${motsAccroche}, plus or minus 2) and creates curiosity in the first 3 seconds; 30 to 45 seconds spoken in total ` +
        '(about 2.5 words per second); short spoken sentences; at most TWO points; never state the conclusion outright, let the viewer get it; ' +
        'no em dash, no semicolon, no emoji in the voice lines; only claims the brand could make (no invented numbers). ' +
        'The call to action invites a follow, a save or a comment; give a one-word comment keyword (mot_cle, uppercase) ONLY if the subject mentions a free resource to send, else null. ' +
        'For each line give: debut and fin in seconds, voix (what is said), texte_ecran (short on-screen text, or empty), plan (what to film or show, concrete). ' +
        'The caption (legende) matches the script, 2 to 4 short lines, no hashtags. ' +
        'Return STRICT JSON: {"accroche": "...", "lignes": [{"debut": 0, "fin": 3, "voix": "...", "texte_ecran": "...", "plan": "..."}], "legende": "...", "mot_cle": null, "duree_s": number}' +
        this.marqueService.contexteMarqueCourt(u, { ctas: true }),
      messages: [
        {
          role: 'user',
          content:
            `Reference analysis:\n${JSON.stringify(sansTranscription(analyse)).slice(0, 6000)}\n\nNew subject:\n${sujet.slice(0, 3000)}` +
            (correction
              ? `\n\nYour previous script:\n${JSON.stringify(correction.script)}\n\nFix every one of these problems and return the full corrected JSON:\n- ${correction.violations.join('\n- ')}`
              : ''),
        },
      ],
    });
    return normaliserScript(this.json<Record<string, unknown>>(this.claude.texte(resp)));
  }

  /** Contrôle qualité noté sur 100 (grille de la skill reels-scripting, adaptée). */
  async controler(langue: string, analyse: AnalyseReel, sujet: string, script: ScriptReel): Promise<Controle> {
    const mots = script.lignes.map((l) => l.voix).join(' ').split(/\s+/).filter(Boolean).length;
    const resp = await this.claude.messagesCreate({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system:
        `You are a strict reviewer of a short video script written in ${langue.toUpperCase()}. Score it out of 100: ` +
        'fidelity to the reference STRUCTURE (sections, rhythm, hook mechanism) 30, fit with the new subject and brand 25, hook and structure quality 20, ' +
        'spoken duration and clarity (30 to 45 s, short sentences, at most two points) 15, caption and call-to-action consistency 10. ' +
        'List every concrete violation, for example: the hook starts with I/Je; the hook word count differs from the reference by more than 2; ' +
        'three or more points; the conclusion is stated outright; duration outside 30 to 45 s; em dash or semicolon; invented numbers; caption not matching the script; ' +
        'a multi-word comment keyword. Return STRICT JSON: {"score": number, "details": {"structure": n, "sujet": n, "accroche": n, "duree": n, "legende": n}, "violations": ["..."]}',
      messages: [
        {
          role: 'user',
          content:
            `Reference: hook "${analyse.accroche.texte}" (${analyse.accroche.mots} words); structure ${JSON.stringify(analyse.structure)}; rhythm ${JSON.stringify(analyse.rythme)}.\n` +
            `Subject: ${sujet.slice(0, 1500)}\n\nScript (${mots} spoken words, declared ${script.duree_s} s):\n${JSON.stringify(script)}`,
        },
      ],
    });
    try {
      const d = this.json<Record<string, unknown>>(this.claude.texte(resp));
      const details = (d.details && typeof d.details === 'object' ? d.details : {}) as Record<string, unknown>;
      return {
        score: Math.max(0, Math.min(100, Math.round(Number(d.score) || 0))),
        details: Object.fromEntries(Object.entries(details).map(([k, v]) => [k, Number(v) || 0])),
        violations: (Array.isArray(d.violations) ? d.violations : []).map((v) => String(v).slice(0, 200)).filter(Boolean).slice(0, 10),
      };
    } catch {
      // Contrôle illisible : on ne bloque pas le client sur un échec du correcteur.
      return { score: SEUIL_QUALITE, details: {}, violations: [] };
    }
  }
}

const nombre = (v: unknown, defaut = 0): number => (Number.isFinite(Number(v)) ? Number(v) : defaut);
const texte = (v: unknown, max = 400): string => String(v ?? '').trim().slice(0, max);
const liste = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');

export function normaliserAnalyse(d: Record<string, unknown>): AnalyseReel {
  const acc = (d.accroche && typeof d.accroche === 'object' ? d.accroche : {}) as Record<string, unknown>;
  const ry = (d.rythme && typeof d.rythme === 'object' ? d.rythme : {}) as Record<string, unknown>;
  const la = (d.langage && typeof d.langage === 'object' ? d.langage : {}) as Record<string, unknown>;
  const accTexte = texte(acc.texte, 300);
  if (!accTexte && !liste(d.structure).length) throw new Error('analyse vide');
  return {
    duree_s: nombre(d.duree_s),
    accroche: { texte: accTexte, mots: nombre(acc.mots, accTexte.split(/\s+/).filter(Boolean).length), pourquoi: texte(acc.pourquoi) },
    transcription: liste(d.transcription).slice(0, 80).map((x) => ({ t: nombre(x.t), texte: texte(x.texte, 300) })),
    structure: liste(d.structure).slice(0, 12).map((x) => ({ debut: nombre(x.debut), fin: nombre(x.fin), role: texte(x.role, 30), resume: texte(x.resume, 200) })),
    rythme: { plans: nombre(ry.plans), coupe_toutes_s: nombre(ry.coupe_toutes_s), texte_ecran: texte(ry.texte_ecran, 20) },
    textes_ecran: liste(d.textes_ecran).slice(0, 30).map((x) => ({ t: nombre(x.t), texte: texte(x.texte, 120) })),
    plans: liste(d.plans).slice(0, 30).map((x) => ({ t: nombre(x.t), type: texte(x.type, 30), description: texte(x.description, 160) })),
    langage: { phrase_moyenne_mots: nombre(la.phrase_moyenne_mots), adresse: texte(la.adresse, 40), style: texte(la.style, 200) },
    appel_action: texte(d.appel_action, 200),
    technique_cle: texte(d.technique_cle, 500),
  };
}

export function normaliserScript(d: Record<string, unknown>): ScriptReel {
  const lignes = liste(d.lignes)
    .slice(0, 20)
    .map((x) => ({ debut: nombre(x.debut), fin: nombre(x.fin), voix: texte(x.voix, 400), texte_ecran: texte(x.texte_ecran, 120), plan: texte(x.plan, 200) }))
    .filter((l) => l.voix || l.texte_ecran);
  if (!lignes.length) throw new Error('script vide');
  const mot = texte(d.mot_cle, 30).replace(/\s+/g, '');
  return {
    accroche: texte(d.accroche, 300) || lignes[0].voix,
    lignes,
    legende: texte(d.legende, 1200),
    mot_cle: mot ? mot.toUpperCase() : null,
    duree_s: nombre(d.duree_s, lignes[lignes.length - 1].fin),
  };
}

/** La transcription intégrale ne sert pas à l'écriture : on la retire pour ne pas inviter à copier. */
function sansTranscription(a: AnalyseReel): Omit<AnalyseReel, 'transcription'> {
  const { transcription: _t, ...reste } = a;
  return reste;
}

/** Le script en texte simple, pour l'enregistrer comme script dans Contenus. */
export function scriptEnTexte(s: ScriptReel): string {
  const lignes = s.lignes.map((l) => {
    const t = `${l.debut.toFixed(0)}-${l.fin.toFixed(0)} s`;
    return [`[${t}] ${l.voix}`, l.texte_ecran ? `  À l'écran : ${l.texte_ecran}` : '', l.plan ? `  Plan : ${l.plan}` : ''].filter(Boolean).join('\n');
  });
  return lignes.join('\n\n');
}
