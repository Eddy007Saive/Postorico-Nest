import { All, Controller, Logger, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { ClesApiService, TitulaireCle } from './cles-api.service';
import { Appel, ErreurOutil, OUTILS } from './mcp-outils';
import { lirePrompt, listePrompts } from './mcp-prompts';
import { OUTIL_SUIVI, TachesMcp } from './taches-mcp';
import { lireRessource, listeRessources } from './mcp-ressources';

/** Versions du protocole MCP comprises (la plus récente d'abord). */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXTE = 60_000;
const APPELS_PAR_MINUTE = 60;

const INSTRUCTIONS =
  "Postorico est le studio de contenu du client : ses posts sont rédigés dans la voix de sa marque, validés par lui, puis publiés sur ses réseaux. " +
  'Commence par get_brand_profile pour comprendre la marque. Circuit : idée (get_content_ideas) → post rédigé en brouillon (generate_social_post) → A valider → approuvé (approve_content) → publié. ' +
  "Règle absolue : fais relire et accepter explicitement chaque texte par le client avant tout outil qui publie en son nom (approve_content, schedule_publication, publish_content, publish_google_business_post, reply_to_comment, reply_to_google_review, create_social_post avec programmer). " +
  'Les outils generate_* consomment son quota mensuel (get_quota) ; les retouches de texte et create_social_post sont gratuits.';

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reponse = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const erreur = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Ce qu'on garde des paramètres d'un outil dans le journal : identifiants et choix, textes
 * coupés (le texte complet d'un post reste dans le contenu lui-même). */
function resumeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

/** Message lisible d'une réponse d'erreur Nest ({ message } texte, liste ou objet). */
function messageErreur(statut: number, corps: unknown): string {
  const m = corps && typeof corps === 'object' ? (corps as { message?: unknown; detail?: unknown }).message ?? (corps as { detail?: unknown }).detail : corps;
  if (typeof m === 'string' && m) return m;
  if (Array.isArray(m)) return m.join(' ; ');
  if (m && typeof m === 'object') {
    const t = (m as { message?: unknown }).message;
    if (typeof t === 'string') return t;
  }
  return `Erreur ${statut}`;
}

/**
 * Serveur MCP de Postorico (transport « Streamable HTTP », sans session) : POST /api/mcp avec
 * « Authorization: Bearer pst_… », ou POST /api/mcp/pst_… pour les clients qui ne savent
 * pas envoyer d'en-tête. Chaque outil rappelle l'API avec un jeton de 5 minutes du titulaire.
 */
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly debits = new Map<string, number[]>();
  private readonly taches = new TachesMcp();

  constructor(
    private readonly cles: ClesApiService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  avecEntete(@Req() req: Request, @Res() res: Response) {
    const entete = req.headers.authorization || '';
    return this.traiter(entete.startsWith('Bearer ') ? entete.slice(7).trim() : '', req, res);
  }

  @Post(':cle')
  avecChemin(@Param('cle') cle: string, @Req() req: Request, @Res() res: Response) {
    return this.traiter(cle, req, res);
  }

  /** Pas de flux SSE ni de session à fermer dans ce mode. */
  @All()
  autre(@Res() res: Response) {
    res.status(405).set('Allow', 'POST').json(erreur(null, -32000, 'Méthode non permise : utilise POST.'));
  }

  @All(':cle')
  autreChemin(@Res() res: Response) {
    this.autre(res);
  }

  /** Une panne passagère (base injoignable…) répond en JSON-RPC, pas par une page 500 brute. */
  private async traiter(cle: string, req: Request, res: Response) {
    try {
      await this.traiterSansFilet(cle, req, res);
    } catch (e) {
      this.logger.error(`MCP : ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) res.status(503).json(erreur(null, -32603, 'Postorico est momentanément indisponible : réessaie dans un instant.'));
    }
  }

  private async traiterSansFilet(cle: string, req: Request, res: Response) {
    const titulaire = await this.cles.verifier(cle);
    if (!titulaire) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json(erreur(null, -32001, 'Clé API absente, invalide ou révoquée (Paramètres › Connecteur IA).'));
      return;
    }
    if (!this.debitOk(titulaire.telegram_id)) {
      res.status(429).json(erreur(null, -32002, 'Trop d’appels : réessaie dans une minute.'));
      return;
    }
    const corps = req.body as Rpc | Rpc[] | undefined;
    const messages = Array.isArray(corps) ? corps : corps ? [corps] : [];
    if (!messages.length) {
      res.status(400).json(erreur(null, -32700, 'Message JSON-RPC attendu.'));
      return;
    }
    const sorties = (await Promise.all(messages.map((m) => this.message(m, titulaire)))).filter(Boolean);
    // Uniquement des notifications : rien à renvoyer
    if (!sorties.length) {
      res.status(202).end();
      return;
    }
    res.status(200).json(Array.isArray(corps) ? sorties : sorties[0]);
  }

  private async message(m: Rpc, titulaire: TitulaireCle): Promise<unknown> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return erreur(m?.id, -32600, 'Requête JSON-RPC invalide.');
    // Notification (pas d'id) ou réponse du client : rien à répondre
    if (m.id === undefined || m.id === null || !m.method) return null;
    switch (m.method) {
      case 'initialize': {
        const v = m.params?.protocolVersion;
        const demandee = typeof v === 'string' ? v : '';
        return reponse(m.id, {
          protocolVersion: VERSIONS.includes(demandee) ? demandee : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'postorico', title: 'Postorico', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reponse(m.id, {});
      case 'tools/list':
        return reponse(m.id, {
          tools: [
            ...OUTILS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })),
            OUTIL_SUIVI,
          ],
        });
      case 'tools/call':
        return reponse(m.id, await this.outil(m.params || {}, titulaire));
      case 'resources/list':
        return reponse(m.id, { resources: listeRessources() });
      case 'resources/templates/list':
        return reponse(m.id, { resourceTemplates: [] });
      case 'resources/read': {
        const uri = typeof m.params?.uri === 'string' ? m.params.uri : '';
        try {
          const contenu = await lireRessource(this.api(titulaire), uri);
          if (!contenu) return erreur(m.id, -32002, `Ressource inconnue : ${uri}`);
          return reponse(m.id, { contents: [contenu] });
        } catch (e) {
          return erreur(m.id, -32603, e instanceof Error ? e.message : String(e));
        }
      }
      case 'prompts/list':
        return reponse(m.id, { prompts: listePrompts() });
      case 'prompts/get': {
        const nom = typeof m.params?.name === 'string' ? m.params.name : '';
        const args = m.params?.arguments && typeof m.params.arguments === 'object' ? (m.params.arguments as Record<string, unknown>) : {};
        const p = lirePrompt(nom, args);
        return p ? reponse(m.id, p) : erreur(m.id, -32602, `Prompt inconnu : ${nom}`);
      }
      default:
        return erreur(m.id, -32601, `Méthode inconnue : ${m.method}`);
    }
  }

  private async outil(params: Record<string, unknown>, titulaire: TitulaireCle) {
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    if (params.name === OUTIL_SUIVI.name) {
      const etat = this.taches.etat(titulaire.telegram_id, typeof args.tache_id === 'string' ? args.tache_id : '');
      if (!etat) return { isError: true, content: [{ type: 'text', text: 'Tâche introuvable (identifiant inconnu, ou résultat expiré après une heure).' }] };
      // Terminée : la réponse de l'outil, telle quelle
      if (etat.statut === 'terminee') return etat.resultat;
      return { content: [{ type: 'text', text: JSON.stringify(etat, null, 1) }] };
    }
    const outil = OUTILS.find((o) => o.name === params.name);
    if (!outil) return { isError: true, content: [{ type: 'text', text: `Outil inconnu : ${String(params.name)}` }] };
    const issue = await this.taches.lancer(titulaire.telegram_id, outil.name, this.executer(outil, args, titulaire));
    if (issue.fini) return issue.resultat;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          en_cours: true,
          tache_id: issue.tacheId,
          note: `Le travail est long et continue côté Postorico. Appelle ${OUTIL_SUIVI.name} avec ce tache_id dans 20 à 30 secondes pour le résultat.`,
        }, null, 1),
      }],
    };
  }

  /** Exécute un outil et journalise ; ne lève jamais : une erreur devient une réponse isError. */
  private async executer(outil: (typeof OUTILS)[number], args: Record<string, unknown>, titulaire: TitulaireCle) {
    const details = resumeArgs(args);
    try {
      const resultat = await outil.executer(this.api(titulaire), args);
      const cree = resultat && typeof resultat === 'object' ? (resultat as { contenu_id?: unknown }).contenu_id : undefined;
      if (outil.journal) await this.cles.journaliser(titulaire, outil.name, true, typeof cree === 'string' ? { ...details, contenu_id: cree } : details);
      let texte = JSON.stringify(resultat, null, 1);
      if (texte.length > MAX_TEXTE) texte = `${texte.slice(0, MAX_TEXTE)}
… (réponse tronquée)`;
      return { content: [{ type: 'text', text: texte }] } as { content: Array<{ type: string; text: string }>; isError?: boolean };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ErreurOutil)) this.logger.warn(`outil ${outil.name} (${titulaire.telegram_id}) : ${message}`);
      if (outil.journal) await this.cles.journaliser(titulaire, outil.name, false, details, message);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  }


  /** Appel à l'API de ce même serveur, au nom du titulaire de la clé. */
  private api(titulaire: TitulaireCle): Appel {
    const base = `http://127.0.0.1:${process.env.PORT ?? 3000}/api`;
    return async (methode, chemin, corps) => {
      const jeton = this.auth.issueMcpToken(titulaire.telegram_id, titulaire.email, titulaire.password_hash);
      // Un FormData (envoi de fichier) part tel quel : fetch pose lui-même l'en-tête multipart
      const multipart = corps instanceof FormData;
      const r = await fetch(base + chemin, {
        method: methode,
        headers: { Authorization: `Bearer ${jeton}`, ...(corps !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: corps === undefined ? undefined : multipart ? corps : JSON.stringify(corps),
      });
      const brut = await r.text();
      let json: unknown = brut;
      try {
        json = brut ? JSON.parse(brut) : null;
      } catch {
        /* réponse texte */
      }
      if (!r.ok) throw new ErreurOutil(messageErreur(r.status, json));
      return json;
    };
  }

  private debitOk(telegramId: string): boolean {
    const maintenant = Date.now();
    const recents = (this.debits.get(telegramId) || []).filter((t) => maintenant - t < 60_000);
    if (recents.length >= APPELS_PAR_MINUTE) return false;
    recents.push(maintenant);
    this.debits.set(telegramId, recents);
    return true;
  }
}
