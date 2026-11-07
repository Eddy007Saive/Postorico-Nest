import { All, Controller, HttpException, HttpStatus, Logger, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AccountsService } from '../accounts/accounts.service';
import { AuthService, JwtPayload } from '../auth/auth.service';
import type { RoleEquipe } from '../../common/utils/acces-equipe.util';
import { ClesApiService, TitulaireCle } from './cles-api.service';
import { Appel, ErreurOutil, OUTILS } from './mcp-outils';
import { lirePrompt, listePrompts } from './mcp-prompts';
import { OUTIL_SUIVI, TachesMcp } from './taches-mcp';
import { lireRessource, listeRessources } from './mcp-ressources';
import { adresseServeur, commandeEnvoi, lireEnvoi, signerEnvoi, TAILLE_MAX_IMAGE, typeImage, VALIDITE_ENVOI_MS } from './envoi-image';
import type { ContexteOutil } from './outils/commun';

/** Versions du protocole MCP comprises (la plus récente d'abord). */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXTE = 60_000;
const APPELS_PAR_MINUTE = 60;

const INSTRUCTIONS =
  "Postorico est le studio de contenu du client : ses posts sont rédigés dans la voix de sa marque, validés par lui, puis publiés sur ses réseaux. " +
  'Commence par get_brand_profile pour comprendre la marque. Circuit : idée (get_content_ideas) → post rédigé en brouillon (generate_social_post) → A valider → approuvé (approve_content) → publié. ' +
  "Règle absolue : fais relire et accepter explicitement chaque texte par le client avant tout outil qui publie en son nom (approve_content, schedule_publication, publish_content, publish_google_business_post, reply_to_comment, reply_to_google_review, create_social_post avec programmer). " +
  'Les outils generate_* consomment son quota mensuel (get_quota) ; les retouches de texte et create_social_post sont gratuits. ' +
  "Plusieurs comptes (marques) : list_accounts donne le compte principal, ses sous-comptes et les comptes gérés en équipe ; passe compte: <id> à n'importe quel outil pour agir sur l'un d'eux (sinon, c'est le compte de la clé). Dis toujours au client sur quel compte tu travailles. " +
  "Vidéo : get_video_options d'abord, puis generate_reel (reel animé, quelques minutes) ou generate_ai_video (montage par l'agent IA, 5 à 20 minutes, quota le plus serré) ; les deux tournent en arrière-plan, suis-les avec get_video_status.";

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
/** Compte sur lequel un appel d'outil agit. */
interface Cible {
  telegram_id: string;
  email: string | null;
  password_hash: string | null;
  nom: string | null;
  origine?: string;
  masterId?: string | null;
  equipe?: RoleEquipe;
}

/** Ajoute le paramètre « compte » au schéma d'un outil (sans modifier la définition partagée). */
function avecCompte(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown>) || {};
  return {
    ...schema,
    properties: {
      ...props,
      compte: { type: 'string', description: "Id du compte sur lequel agir (list_accounts). Absent : le compte de la clé." },
    },
  };
}

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly debits = new Map<string, number[]>();
  private readonly taches = new TachesMcp();

  constructor(
    private readonly cles: ClesApiService,
    private readonly auth: AuthService,
    private readonly comptes: AccountsService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('app.jwtSecret') || '';
  }

  private readonly secret: string;

  /** Envoi direct d'une image dans un post : POST multipart (champ « file ») sur l'adresse
   * rendue par create_social_post ou get_post_image_upload. Le fichier ne passe pas par le
   * protocole MCP. JPG, PNG ou WEBP (type vérifié sur le contenu), 10 Mo au plus. */
  @Post('image/:jeton')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: TAILLE_MAX_IMAGE * 2 } }))
  async envoiImage(@Param('jeton') jeton: string, @UploadedFile() file: Express.Multer.File | undefined) {
    const refus = (message: string, statut = HttpStatus.BAD_REQUEST) => new HttpException({ ok: false, erreur: message }, statut);
    const a = lireEnvoi(this.secret, jeton);
    if ('refus' in a) throw refus(a.refus, HttpStatus.UNAUTHORIZED);
    const titulaire = await this.cles.titulaireParId(a.cle);
    if (!titulaire) throw refus('Clé du connecteur révoquée ou invalide.', HttpStatus.UNAUTHORIZED);
    if (!this.debitOk(titulaire.telegram_id)) throw refus('Trop d’appels : réessaie dans une minute.', HttpStatus.TOO_MANY_REQUESTS);
    if (!file?.buffer?.length) throw refus('Aucun fichier reçu : envoie-le dans le champ « file » (curl -F "file=@photo.jpg").');
    if (file.size > TAILLE_MAX_IMAGE) throw refus(`Image trop lourde (${Math.round(file.size / 1e5) / 10} Mo) : 10 Mo au plus.`, HttpStatus.PAYLOAD_TOO_LARGE);
    const type = typeImage(file.buffer);
    if (!type) throw refus('Format non pris en charge : JPG, PNG ou WEBP seulement (un PDF ou une vidéo est refusé).', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    let cible: Cible;
    try {
      cible = await this.cible(titulaire, a.compte === titulaire.telegram_id ? '' : a.compte);
    } catch (e) {
      throw refus(e instanceof Error ? e.message : String(e), HttpStatus.FORBIDDEN);
    }
    const api = this.api(titulaire, cible);
    const details: Record<string, unknown> = { contenu_id: a.contenu, ...(a.position ? { position: a.position } : {}), ...(cible.nom && cible.telegram_id !== titulaire.telegram_id ? { compte: cible.nom } : {}) };
    try {
      const c = (await api('GET', `/contenus/${encodeURIComponent(a.contenu)}`)) as Record<string, unknown>;
      if (c.statut === 'Publie' || c.publish_status === 'publié') throw new ErreurOutil('Ce post est déjà publié : son image ne peut plus changer.');
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file.buffer)], { type }), `image.${type.split('/')[1].replace('jpeg', 'jpg')}`);
      const r = (await api('POST', a.position ? `/contenus/${encodeURIComponent(a.contenu)}/slides/${a.position}` : `/contenus/${encodeURIComponent(a.contenu)}/image`, form)) as Record<string, unknown>;
      await this.cles.journaliser(titulaire, 'post_image_upload', true, details);
      return {
        ok: true,
        contenu_id: a.contenu,
        ...(a.position ? { position: a.position, photos: r.slides_images, ...(r.carrousel_pdf ? { pdf_linkedin: r.carrousel_pdf } : {}) } : { visuel: r.lien_visuel }),
        statut: r.statut,
        note: 'Image jointe au post. Il reste « À valider » tant que le client ne l’a pas approuvé.',
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.cles.journaliser(titulaire, 'post_image_upload', false, details, message);
      throw refus(message);
    }
  }

  /** Adresse d'envoi direct d'une image pour un post (et une position de carrousel). */
  private contexte(titulaire: TitulaireCle, cible: Cible, base: string): ContexteOutil {
    return {
      lienEnvoiImage: (contenuId, position) => {
        const expire = Date.now() + VALIDITE_ENVOI_MS;
        const jeton = signerEnvoi(this.secret, { cle: titulaire.cle_id, compte: cible.telegram_id, contenu: contenuId, position, expire });
        const url = `${base}/api/mcp/image/${jeton}`;
        return { url, expire: new Date(expire).toISOString(), commande: commandeEnvoi(url) };
      },
    };
  }

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
    const base = adresseServeur(req.headers, req.protocol);
    const sorties = (await Promise.all(messages.map((m) => this.message(m, titulaire, base)))).filter(Boolean);
    // Uniquement des notifications : rien à renvoyer
    if (!sorties.length) {
      res.status(202).end();
      return;
    }
    res.status(200).json(Array.isArray(corps) ? sorties : sorties[0]);
  }

  private async message(m: Rpc, titulaire: TitulaireCle, base = ''): Promise<unknown> {
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
            ...OUTILS.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema: name === 'list_accounts' ? inputSchema : avecCompte(inputSchema),
              ...(annotations ? { annotations } : {}),
            })),
            OUTIL_SUIVI,
          ],
        });
      case 'tools/call':
        return reponse(m.id, await this.outil(m.params || {}, titulaire, base));
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

  private async outil(params: Record<string, unknown>, titulaire: TitulaireCle, base = '') {
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
    // « compte » : agir sur un sous-compte (ou un compte géré en équipe) plutôt que sur celui de la clé
    const { compte, ...argsOutil } = args;
    let cible: Cible;
    try {
      cible = await this.cible(titulaire, typeof compte === 'string' ? compte.trim() : '');
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
    }
    const issue = await this.taches.lancer(titulaire.telegram_id, outil.name, this.executer(outil, argsOutil, titulaire, cible, this.contexte(titulaire, cible, base)));
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
  private async executer(outil: (typeof OUTILS)[number], args: Record<string, unknown>, titulaire: TitulaireCle, cible: Cible, ctx: ContexteOutil) {
    const details = { ...resumeArgs(args), ...(cible?.nom && cible.telegram_id !== titulaire.telegram_id ? { compte: cible.nom } : {}) };
    try {
      const resultat = await outil.executer(this.api(titulaire, cible), args, ctx);
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


  /** Compte visé par un appel : celui de la clé, ou un compte de sa famille (master et
   * sous-comptes) ou de son équipe — mêmes contrôles que la bascule de l'application. */
  private async cible(titulaire: TitulaireCle, compte: string): Promise<Cible> {
    if (!compte || compte === titulaire.telegram_id) return { telegram_id: titulaire.telegram_id, email: titulaire.email, password_hash: titulaire.password_hash, nom: null };
    const moi = { telegram_id: titulaire.telegram_id, origine: titulaire.telegram_id } as JwtPayload;
    const equipe = (await this.comptes.comptesEquipe(titulaire.telegram_id)).find((c) => c.telegram_id === compte);
    if (equipe) {
      const u = await this.comptes.ficheCompte(compte);
      if (!u) throw new ErreurOutil('Compte introuvable : vérifie son id avec list_accounts.');
      return { ...u, origine: titulaire.telegram_id, equipe: equipe.role_equipe };
    }
    try {
      const { master, row } = await this.comptes.resoudreCible(moi, compte);
      return { telegram_id: row.telegram_id, email: row.email, password_hash: row.password_hash, nom: row.nom, origine: titulaire.telegram_id, masterId: row.telegram_id === master ? null : master };
    } catch {
      throw new ErreurOutil("Ce compte n'est pas accessible avec cette clé : list_accounts donne les comptes possibles.");
    }
  }

  /** Appel à l'API de ce même serveur, au nom du titulaire de la clé (ou du compte visé). */
  private api(titulaire: TitulaireCle, cible?: Cible): Appel {
    const base = `http://127.0.0.1:${process.env.PORT ?? 3000}/api`;
    return async (methode, chemin, corps) => {
      const jeton = cible && cible.telegram_id !== titulaire.telegram_id
        ? this.auth.issueMcpToken(cible.telegram_id, cible.email, cible.password_hash, { origine: cible.origine, masterId: cible.masterId, equipe: cible.equipe })
        : this.auth.issueMcpToken(titulaire.telegram_id, titulaire.email, titulaire.password_hash);
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
