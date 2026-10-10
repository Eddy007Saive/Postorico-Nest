import { AgentVideoService, apercuDe, MAX_TENTATIVES, rushAutorise } from './agent-video.service';
import { jetonValide } from './agent-worker.guard';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    utils: { api_sign_request: jest.fn(() => 'signature-test') },
    api: { resource: jest.fn() },
  },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { v2: cloudinary } = require('cloudinary');

const TID = '11111111-1111-1111-1111-111111111111';
const CID = '22222222-2222-2222-2222-222222222222';
const JID = '33333333-3333-3333-3333-333333333333';
const RUSH = `https://res.cloudinary.com/demo/video/upload/v1/banque/${TID}/clip.mp4`;

function make(opts: { jeton?: string } = {}) {
  const prisma = {
    contenu: {
      create: jest.fn().mockResolvedValue({ id: CID }),
      findUnique: jest.fn().mockResolvedValue({ reel_data: {}, reseau_cible: 'Instagram' }),
      update: jest.fn().mockResolvedValue({}),
    },
    travaux_agent_video: {
      create: jest.fn().mockResolvedValue({ id: JID }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const q = { ok: true };
  const quota = {
    exigerAbonnement: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(q),
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
    refundByUser: jest.fn().mockResolvedValue(undefined),
  };
  const marque = { chargerMarque: jest.fn().mockResolvedValue({ nom: 'Goodtime', couleur_principale: '#003D2E' }) };
  const musique = { urlDe: jest.fn().mockResolvedValue(null) };
  const planning = { prochainCreneau: jest.fn().mockResolvedValue(null) };
  const notifications = { notifier: jest.fn().mockResolvedValue(undefined) };
  const usage = { log: jest.fn().mockResolvedValue(undefined) };
  const valeurs: Record<string, unknown> = {
    'app.agentVideoWorkerToken': opts.jeton ?? 'secret', 'app.agentVideoBudgetUsd': 3, 'app.agentVideoDureeMaxS': 180,
    'app.cloudinaryCloudName': 'demo', 'app.cloudinaryApiKey': 'cle', 'app.cloudinaryApiSecret': 'sec',
  };
  const config = { get: (k: string) => valeurs[k] };
  const service = new AgentVideoService(prisma as never, quota as never, marque as never, musique as never, planning as never, notifications as never, usage as never, config as never);
  return { service, prisma, quota, notifications, usage, q };
}

describe('agent vidéo : utilitaires', () => {
  it('jeton : temps constant, refuse tout si non configuré', () => {
    expect(jetonValide('abc', 'abc')).toBe(true);
    expect(jetonValide('abc', 'abd')).toBe(false);
    expect(jetonValide('abc', 'ab')).toBe(false);
    expect(jetonValide('', '')).toBe(false);
    expect(jetonValide('', 'x')).toBe(false);
  });

  it("rush : seulement le Cloudinary de Postorico et le dossier du client", () => {
    expect(rushAutorise(RUSH, 'demo', TID)).toBe(true);
    expect(rushAutorise(`https://res.cloudinary.com/demo/video/upload/videos_raw/${TID}/a.mp4`, 'demo', TID)).toBe(true);
    expect(rushAutorise(`https://res.cloudinary.com/demo/video/upload/banque/autre/a.mp4`, 'demo', TID)).toBe(false);
    expect(rushAutorise('https://exemple.com/a.mp4', 'demo', TID)).toBe(false);
    expect(rushAutorise(`https://res.cloudinary.com/autre/video/upload/banque/${TID}/a.mp4`, 'demo', TID)).toBe(false);
  });

  it('aperçu : image à 1 s de la vidéo', () => {
    expect(apercuDe('https://res.cloudinary.com/demo/video/upload/v1/reels/a/b.mp4')).toBe('https://res.cloudinary.com/demo/video/upload/so_1.00/v1/reels/a/b.jpg');
  });
});

describe('agent vidéo : création côté client', () => {
  it('sans jeton worker : indisponible, aucun quota consommé', async () => {
    const { service, quota } = make({ jeton: '' });
    expect(await service.creer(TID, { clips: [{ url: RUSH }] })).toMatchObject({ status: 503 });
    expect(quota.consume).not.toHaveBeenCalled();
  });

  it('rush étranger : refusé avant le quota', async () => {
    const { service, quota } = make();
    expect(await service.creer(TID, { clips: [{ url: 'https://exemple.com/a.mp4' }] })).toHaveProperty('error');
    expect(quota.consume).not.toHaveBeenCalled();
  });

  it('crée le contenu « en cours » + le travail avec la charte, quota consommé et confirmé', async () => {
    const { service, prisma, quota } = make();
    const r = await service.creer(TID, { clips: [{ url: RUSH }], consignes: 'Dynamique', reseau: 'tiktok', format: '9:16' });
    expect(r).toEqual({ id: CID, travail_id: JID, video_status: 'en_traitement' });
    expect(quota.consume).toHaveBeenCalledWith(TID, 'video_agent');
    expect(quota.confirm).toHaveBeenCalled();
    expect(prisma.contenu.create.mock.calls[0][0].data).toMatchObject({ video_status: 'en_traitement', reseau_cible: 'TikTok' });
    expect(prisma.travaux_agent_video.create.mock.calls[0][0].data.brief).toMatchObject({ format: '9:16', budget_usd: 3, duree_max_s: 180, charte: { nom: 'Goodtime' } });
  });

  it('quota épuisé : 402, rien de créé', async () => {
    const { service, prisma, quota } = make();
    quota.consume.mockResolvedValue({ ok: false, message: 'Quota atteint' });
    expect(await service.creer(TID, { clips: [{ url: RUSH }] })).toEqual({ error: 'Quota atteint', status: 402 });
    expect(prisma.contenu.create).not.toHaveBeenCalled();
  });
});

describe('agent vidéo : worker', () => {
  it('prendre : réservation atomique, le perdant passe au suivant', async () => {
    const { service, prisma } = make();
    prisma.travaux_agent_video.findMany
      .mockResolvedValueOnce([]) // rearmerPerimes
      .mockResolvedValueOnce([{ id: 'a', contenu_id: CID, brief: {}, tentatives: 0 }, { id: 'b', contenu_id: CID, brief: { x: 1 }, tentatives: 0 }]);
    prisma.travaux_agent_video.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    expect(await service.prendre()).toEqual({ id: 'b', contenu_id: CID, brief: { x: 1 }, tentative: 1 });
  });

  it('travail perdu (plus de battement) : relancé, ou en échec après le dernier essai', async () => {
    const { service, prisma, quota } = make();
    prisma.travaux_agent_video.findMany.mockResolvedValueOnce([{ id: 'a', tentatives: 1 }, { id: 'b', tentatives: MAX_TENTATIVES }]);
    prisma.travaux_agent_video.findFirst.mockResolvedValue({ id: 'b', contenu_id: CID, telegram_id: TID, tentatives: MAX_TENTATIVES });
    await service.rearmerPerimes(new Date());
    expect(prisma.travaux_agent_video.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a', statut: 'en_cours' }, data: expect.objectContaining({ statut: 'en_attente' }) }));
    expect(quota.refundByUser).toHaveBeenCalledWith(TID, 'video_agent');
  });

  it('signature : envoi Cloudinary signé sur reels/{client}/{contenu}', async () => {
    const { service, prisma } = make();
    prisma.travaux_agent_video.findFirst.mockResolvedValue({ telegram_id: TID, contenu_id: CID });
    const s = await service.signature(JID);
    expect(s).toMatchObject({ url: 'https://api.cloudinary.com/v1_1/demo/video/upload', api_key: 'cle', public_id: `reels/${TID}/${CID}`, signature: 'signature-test' });
  });

  it('terminer : vérifie Cloudinary, contenu prêt, notification, coût journalisé', async () => {
    const { service, prisma, notifications, usage } = make();
    prisma.travaux_agent_video.findFirst.mockResolvedValue({ id: JID, contenu_id: CID, telegram_id: TID, tentatives: 1 });
    cloudinary.api.resource.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/demo/video/upload/v1/reels/x/y.mp4', duration: 42 });
    expect(await service.terminer(JID, { cout_usd: 0.84, resume: 'Montage nerveux' })).toEqual({ ok: true });
    expect(prisma.contenu.update.mock.calls[0][0].data).toMatchObject({ video_status: 'ready', video_url: 'https://res.cloudinary.com/demo/video/upload/v1/reels/x/y.mp4' });
    expect(notifications.notifier).toHaveBeenCalledWith(TID, CID, 'Instagram', 'reel.ready', expect.any(String), expect.any(String));
    expect(usage.log).toHaveBeenCalledWith(TID, 'video_agent', 'claude-code', undefined, 0, undefined, 0.84);
  });

  it('terminer : vidéo trop longue = échec', async () => {
    const { service, prisma } = make();
    prisma.travaux_agent_video.findFirst.mockResolvedValue({ id: JID, contenu_id: CID, telegram_id: TID, tentatives: MAX_TENTATIVES });
    cloudinary.api.resource.mockResolvedValue({ secure_url: 'https://x/upload/a.mp4', duration: 400 });
    expect(await service.terminer(JID, {})).toEqual({ error: 'Vidéo trop longue.' });
    expect(prisma.contenu.update.mock.calls[0][0].data).toMatchObject({ video_status: 'echec' });
  });

  it('échec : nouvel essai tant que possible, sinon échec définitif et quota rendu', async () => {
    const { service, prisma, quota } = make();
    prisma.travaux_agent_video.findFirst.mockResolvedValueOnce({ id: JID, contenu_id: CID, telegram_id: TID, tentatives: 1 });
    expect(await service.echouer(JID, 'ffmpeg a planté')).toEqual({ relance: true });
    expect(quota.refundByUser).not.toHaveBeenCalled();
    prisma.travaux_agent_video.findFirst.mockResolvedValueOnce({ id: JID, contenu_id: CID, telegram_id: TID, tentatives: MAX_TENTATIVES });
    expect(await service.echouer(JID, 'encore')).toEqual({ relance: false });
    expect(quota.refundByUser).toHaveBeenCalledWith(TID, 'video_agent');
  });
});
