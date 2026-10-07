import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ZernioError } from '../zernio/zernio-client.service';
import { WorkflowsService, versPostCompte } from './workflows.service';

describe('WorkflowsService', () => {
  function makeService(wf: Record<string, unknown> | null, zernioOverrides: Record<string, jest.Mock> = {}) {
    const prisma = {
      users: { findUnique: jest.fn().mockResolvedValue({ late_profile_id: 'profil-a' }) },
      comptes_sociaux: {
        findMany: jest.fn().mockResolvedValue([{ late_account_id: 'ig-1', plateforme: 'instagram' }]),
      },
    } as never;
    const zernio = {
      getWorkflow: jest.fn().mockResolvedValue({ workflow: wf }),
      pauseWorkflow: jest.fn().mockResolvedValue({}),
      activateWorkflow: jest.fn().mockResolvedValue({}),
      updateWorkflow: jest.fn().mockResolvedValue({ workflow: { id: 'w1', status: 'paused' } }),
      deleteWorkflow: jest.fn().mockResolvedValue({}),
      createWorkflow: jest.fn().mockResolvedValue({ workflow: { id: 'w2' } }),
      ...zernioOverrides,
    };
    return { service: new WorkflowsService(prisma, zernio as never), zernio };
  }

  it("refuse le workflow d'un autre profil Zernio (404, rien n'est supprimé)", async () => {
    const { service, zernio } = makeService({ id: 'w1', profileId: 'profil-b' });
    await expect(service.supprimer('u1', 'w1')).rejects.toBeInstanceOf(NotFoundException);
    expect(zernio.deleteWorkflow).not.toHaveBeenCalled();
  });

  it('modifie un workflow actif : pause, enregistrement, réactivation', async () => {
    const { service, zernio } = makeService({ id: 'w1', profileId: 'profil-a', status: 'active' });
    const r = await service.modifier('u1', 'w1', { name: 'Nouveau nom' });
    expect(zernio.pauseWorkflow).toHaveBeenCalledWith('w1');
    expect(zernio.updateWorkflow).toHaveBeenCalledWith('w1', { name: 'Nouveau nom' });
    expect(zernio.activateWorkflow).toHaveBeenCalledWith('w1');
    expect(r.workflow.status).toBe('active');
  });

  it("réactive le workflow et renvoie le message de Zernio si l'enregistrement est refusé", async () => {
    const { service, zernio } = makeService(
      { id: 'w1', profileId: 'profil-a', status: 'active' },
      { updateWorkflow: jest.fn().mockRejectedValue(new ZernioError('Graphe invalide : bloc orphelin', 400)) },
    );
    await expect(service.modifier('u1', 'w1', { nodes: [] })).rejects.toThrow('Graphe invalide : bloc orphelin');
    expect(zernio.activateWorkflow).toHaveBeenCalledWith('w1');
  });

  it("refuse de créer sur un compte qui n'appartient pas au client", async () => {
    const { service, zernio } = makeService(null);
    await expect(service.creer('u1', { accountId: 'ig-autre', name: 'x', nodes: [], edges: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(zernio.createWorkflow).not.toHaveBeenCalled();
  });

  it('crée avec le profil et la plateforme du compte, jamais ceux envoyés par le client', async () => {
    const { service, zernio } = makeService(null);
    await service.creer('u1', { accountId: 'ig-1', name: 'GUIDE', nodes: [{ id: 't' }], edges: [] });
    expect(zernio.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'profil-a', accountId: 'ig-1', platform: 'instagram' }));
  });
});

describe('versPostCompte', () => {
  it("prend l'id Instagram du post (platformPostId) et une miniature d'image", () => {
    const p = {
      content: '  Tu postes.\n Mais  pas toi ',
      mediaItems: [{ type: 'image', url: 'https://x/img.jpg' }],
      platforms: [{ accountId: { _id: 'ig-1' }, platformPostId: '1801', publishedAt: '2026-10-04T12:00:00Z', platformPostUrl: 'https://instagram.com/p/x' }],
    };
    expect(versPostCompte(p, 'ig-1')).toEqual({ platformPostId: '1801', texte: 'Tu postes. Mais pas toi', miniature: 'https://x/img.jpg', publieLe: '2026-10-04T12:00:00Z', url: 'https://instagram.com/p/x' });
  });

  it('prend la vignette fournie pour une vidéo, et ignore un post sans id plateforme', () => {
    const video = { mediaItems: [{ type: 'video', url: 'https://x/v.mp4', thumbnail: 'https://x/t.jpg' }], platforms: [{ accountId: 'ig-1', platformPostId: '9' }] };
    expect(versPostCompte(video, 'ig-1')?.miniature).toBe('https://x/t.jpg');
    expect(versPostCompte({ platforms: [{ accountId: 'ig-1', status: 'scheduled' }] }, 'ig-1')).toBeNull();
  });
});
