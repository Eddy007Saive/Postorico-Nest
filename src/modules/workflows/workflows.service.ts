import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ZernioClientService, ZernioError } from '../zernio/zernio-client.service';
import { CreateWorkflowDto, UpdateWorkflowDto } from './dto/workflow.dto';

/** Réseaux sur lesquels Zernio exécute des workflows ET que Postorico sait connecter.
 * (Zernio couvre aussi WhatsApp, Telegram, X, Bluesky, Reddit — pas LinkedIn.) */
export const PLATEFORMES_WORKFLOW = ['instagram', 'facebook'];

export interface CompteWorkflow {
  accountId: string;
  platform: string;
}

export interface PostCompte {
  platformPostId: string;
  texte: string;
  miniature: string | null;
  publieLe: string | null;
  url: string | null;
}

const idCompte = (v: unknown): string => (v && typeof v === 'object' ? String((v as Record<string, unknown>)._id ?? '') : String(v ?? ''));

/** Un post Zernio -> ce qu'il faut pour le choisir dans l'éditeur. L'identifiant utile au
 * déclencheur « commentaire » est le `platformPostId` (l'id du post chez Instagram/Facebook),
 * porté par l'entrée `platforms[]` du compte. */
export function versPostCompte(p: Record<string, unknown>, accountId: string): PostCompte | null {
  const plats = (p.platforms as Record<string, unknown>[]) || [];
  const pl = plats.find((x) => idCompte(x.accountId) === accountId) || (plats.length === 1 ? plats[0] : undefined);
  const id = pl?.platformPostId as string | undefined;
  if (!id) return null;
  const media = ((p.mediaItems as Record<string, unknown>[]) || [])[0] || {};
  const specifique = (pl?.platformSpecificData as Record<string, unknown>) || {};
  const miniature =
    (media.thumbnail as string) ||
    (specifique.instagramThumbnail as string) ||
    (media.type === 'image' || /\.(jpe?g|png|webp)(\?|$)/i.test(String(media.url || '')) ? (media.url as string) : null) ||
    null;
  return {
    platformPostId: id,
    texte: String(p.content || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    miniature,
    publieLe: (pl?.publishedAt as string) || (p.publishedAt as string) || (p.scheduledFor as string) || null,
    url: (pl?.platformPostUrl as string) || null,
  };
}

/**
 * Automatisations (« workflows » Zernio) des messages privés et commentaires.
 * Aucune table chez nous : Zernio stocke le graphe, et chaque workflow porte le profil
 * Zernio du client (`profileId`). Toute lecture ou écriture vérifie que ce profil est
 * bien celui de l'appelant — un id de workflow deviné ne donne accès à rien.
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
  ) {}

  /** Traduit une erreur Zernio en erreur HTTP lisible côté client. Le 400 de Zernio
   * explique précisément ce qui ne va pas dans le graphe : on le renvoie tel quel. */
  private traduire(e: unknown, action: string): never {
    if (e instanceof HttpException) throw e;
    if (e instanceof ZernioError) {
      if (e.statusCode === 400) throw new BadRequestException(e.message);
      if (e.statusCode === 404) throw new NotFoundException('Automatisation introuvable.');
      if (e.statusCode === 403) throw new ForbiddenException('Automatisations indisponibles pour le moment.');
    }
    this.logger.error(`workflows ${action}: ${e instanceof Error ? e.message : e}`);
    throw new BadGatewayException('Le service d’automatisation ne répond pas, réessaie dans un instant.');
  }

  private async profil(telegramId: string): Promise<string> {
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    if (!u?.late_profile_id) throw new BadRequestException('Connecte d’abord un compte Instagram ou Facebook.');
    return u.late_profile_id;
  }

  /** Comptes du client sur lesquels on peut poser une automatisation. */
  async comptes(telegramId: string): Promise<CompteWorkflow[]> {
    const rows = await this.prisma.comptes_sociaux.findMany({
      where: { telegram_id: telegramId, plateforme: { in: PLATEFORMES_WORKFLOW } },
      select: { late_account_id: true, plateforme: true },
    });
    return rows
      .filter((r) => r.late_account_id)
      .map((r) => ({ accountId: r.late_account_id as string, platform: String(r.plateforme) }));
  }

  private async compte(telegramId: string, accountId: string): Promise<CompteWorkflow> {
    const c = (await this.comptes(telegramId)).find((x) => x.accountId === accountId);
    if (!c) throw new BadRequestException('Ce compte n’est pas connecté à ta marque (Instagram ou Facebook uniquement).');
    return c;
  }

  /** Le workflow, après vérification qu'il appartient au profil Zernio de l'appelant. */
  private async possede(telegramId: string, workflowId: string): Promise<Record<string, unknown>> {
    const profileId = await this.profil(telegramId);
    let wf: Record<string, unknown> | undefined;
    try {
      wf = (await this.zernio.getWorkflow(workflowId)).workflow;
    } catch (e) {
      this.traduire(e, 'get');
    }
    if (!wf || wf.profileId !== profileId) throw new NotFoundException('Automatisation introuvable.');
    return wf;
  }

  async lister(telegramId: string): Promise<{ workflows: Record<string, unknown>[]; comptes: CompteWorkflow[] }> {
    const comptes = await this.comptes(telegramId);
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    if (!u?.late_profile_id) return { workflows: [], comptes };
    try {
      const r = await this.zernio.listWorkflows(u.late_profile_id);
      return { workflows: r.workflows || [], comptes };
    } catch (e) {
      this.traduire(e, 'list');
    }
  }

  async obtenir(telegramId: string, workflowId: string) {
    return { workflow: await this.possede(telegramId, workflowId), comptes: await this.comptes(telegramId) };
  }

  async creer(telegramId: string, dto: CreateWorkflowDto) {
    const profileId = await this.profil(telegramId);
    const c = await this.compte(telegramId, dto.accountId);
    try {
      const r = await this.zernio.createWorkflow({
        profileId,
        accountId: c.accountId,
        platform: c.platform,
        name: dto.name,
        description: dto.description,
        nodes: dto.nodes,
        edges: dto.edges,
      });
      return { workflow: r.workflow };
    } catch (e) {
      this.traduire(e, 'create');
    }
  }

  /** Zernio refuse de modifier un workflow actif : on le met en pause, on enregistre,
   * puis on le réactive. Si l'enregistrement échoue, on le réactive tel quel avant de
   * renvoyer l'erreur — le client ne doit pas retrouver son automatisation éteinte. */
  async modifier(telegramId: string, workflowId: string, dto: UpdateWorkflowDto) {
    const wf = await this.possede(telegramId, workflowId);
    if (dto.accountId) await this.compte(telegramId, dto.accountId);
    const etaitActif = wf.status === 'active';
    const body: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'nodes', 'edges', 'accountId'] as const) {
      if (dto[k] !== undefined) body[k] = dto[k];
    }
    try {
      if (etaitActif) await this.zernio.pauseWorkflow(workflowId);
      const r = await this.zernio.updateWorkflow(workflowId, body);
      if (etaitActif) await this.zernio.activateWorkflow(workflowId);
      return { workflow: { ...(r.workflow || {}), status: etaitActif ? 'active' : r.workflow?.status } };
    } catch (e) {
      if (etaitActif) await this.zernio.activateWorkflow(workflowId).catch(() => undefined);
      this.traduire(e, 'update');
    }
  }

  async activer(telegramId: string, workflowId: string) {
    await this.possede(telegramId, workflowId);
    try {
      return { workflow: (await this.zernio.activateWorkflow(workflowId)).workflow };
    } catch (e) {
      this.traduire(e, 'activate');
    }
  }

  async pause(telegramId: string, workflowId: string) {
    await this.possede(telegramId, workflowId);
    try {
      return { workflow: (await this.zernio.pauseWorkflow(workflowId)).workflow };
    } catch (e) {
      this.traduire(e, 'pause');
    }
  }

  async supprimer(telegramId: string, workflowId: string) {
    await this.possede(telegramId, workflowId);
    try {
      await this.zernio.deleteWorkflow(workflowId);
      return { success: true };
    } catch (e) {
      this.traduire(e, 'delete');
    }
  }

  /** Derniers posts publiés du compte (ceux faits via Postorico ET ceux publiés directement
   * sur la plateforme), pour choisir le post visé par un déclencheur « commentaire ». */
  async postsCompte(telegramId: string, accountId: string): Promise<{ posts: PostCompte[] }> {
    await this.compte(telegramId, accountId);
    const [externes, zernio] = await Promise.allSettled([
      this.zernio.listPosts({ accountId, source: 'external', limit: 30 }),
      this.zernio.listPosts({ accountId, source: 'zernio', status: 'published', limit: 30 }),
    ]);
    if (externes.status === 'rejected' && zernio.status === 'rejected') this.traduire(externes.reason, 'posts');
    const vus = new Set<string>();
    const posts: PostCompte[] = [];
    for (const r of [externes, zernio]) {
      if (r.status !== 'fulfilled') continue;
      for (const p of r.value.posts || []) {
        const pc = versPostCompte(p, accountId);
        if (pc && !vus.has(pc.platformPostId)) {
          vus.add(pc.platformPostId);
          posts.push(pc);
        }
      }
    }
    posts.sort((a, b) => String(b.publieLe || '').localeCompare(String(a.publieLe || '')));
    return { posts: posts.slice(0, 40) };
  }

  async executions(telegramId: string, workflowId: string) {
    await this.possede(telegramId, workflowId);
    try {
      return await this.zernio.listWorkflowExecutions(workflowId, 20);
    } catch (e) {
      this.traduire(e, 'executions');
    }
  }
}
