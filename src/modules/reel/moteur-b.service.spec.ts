import { v2 as cloudinary } from 'cloudinary';
import { MoteurBService } from './moteur-b.service';

jest.mock('cloudinary', () => {
  const upload_stream = jest.fn((_opts: unknown, cb: (e: unknown, r: unknown) => void) => ({
    end: () => cb(null, { secure_url: 'https://res.cloudinary.com/n/video/upload/v1/reels/u1/c1.mp4' }),
  }));
  return { v2: { config: jest.fn(), uploader: { upload_stream } } };
});

const cfg = (comptes: string[] = ['u1']) => ({
  get: (k: string) =>
    ({ 'app.moteurBUrl': 'http://vps:8790', 'app.moteurBCle': 'cle', 'app.moteurBComptes': comptes } as Record<string, unknown>)[k],
});

describe('MoteurBService', () => {
  const prisma = {
    contenu: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  };
  const claude = { messagesCreate: jest.fn().mockResolvedValue({}), texte: jest.fn() };
  const marque = { chargerMarque: jest.fn().mockResolvedValue({ langue: 'fr' }), contexteMarqueCourt: jest.fn().mockReturnValue('') };
  const quota = { consume: jest.fn(), confirm: jest.fn(), refund: jest.fn(), refundByUser: jest.fn() };
  const notifications = { notifierCle: jest.fn() };
  const planning = { prochainCreneau: jest.fn().mockResolvedValue(null) };
  const fetchMock = jest.fn();
  const service = (comptes?: string[]) =>
    new MoteurBService(prisma as never, claude as never, marque as never, quota as never, notifications as never, planning as never, cfg(comptes) as never);

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    quota.consume.mockResolvedValue({ ok: true });
    claude.texte.mockReturnValue('{"script": "Tu crois que c est simple ? Abonne-toi.", "termes": ["hotel room"], "titre": "Conciergerie"}');
  });

  it('refuse un compte qui n’est pas dans la liste, sans consommer de quota', async () => {
    const res = await service(['autre']).lancer('u1', { brief: 'sujet' });
    expect(res).toEqual({ error: "Le moteur B n'est pas activé pour ce compte.", status: 403 });
    expect(quota.consume).not.toHaveBeenCalled();
  });

  it('lance : script Claude envoyé au moteur, reel créé « en_traitement » marqué moteur b, quota confirmé', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { task_id: 't-42' } }) });
    prisma.contenu.create.mockResolvedValueOnce({ id: 'c1' });

    const res = await service().lancer('u1', { brief: 'Conciergerie à 200 logements' });

    expect(res).toEqual({ id: 'c1', video_status: 'en_traitement' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vps:8790/api/v1/videos');
    expect(init.headers['X-Cle-Moteur']).toBe('cle');
    const corps = JSON.parse(init.body);
    expect(corps).toMatchObject({ video_script: 'Tu crois que c est simple ? Abonne-toi.', video_terms: ['hotel room'], video_aspect: '9:16', voice_name: 'fr-FR-DeniseNeural-Female', bgm_type: '' });
    const donnees = prisma.contenu.create.mock.calls[0][0].data;
    expect(donnees.video_status).toBe('en_traitement');
    expect(donnees.reel_data).toMatchObject({ moteur: 'b', tache: 't-42' });
    expect(quota.confirm).toHaveBeenCalled();
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it('moteur injoignable : aucun reel créé, quota rendu', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await service().lancer('u1', { brief: 'sujet' });
    expect(res).toMatchObject({ status: 502 });
    expect(prisma.contenu.create).not.toHaveBeenCalled();
    expect(quota.refund).toHaveBeenCalled();
  });

  const reel = (age = 60_000) => ({ id: 'c1', telegram_id: 'u1', reseau_cible: 'Instagram', reel_data: { moteur: 'b', tache: 't-42' }, created_at: new Date(Date.now() - age) });

  it('suivi : tâche terminée → vidéo copiée sur Cloudinary, reel prêt, notification', async () => {
    prisma.contenu.findMany.mockResolvedValueOnce([reel()]);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { state: 1, videos: ['http://194.5.159.17:8790/tasks/t-42/final-1.mp4'] } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });

    await service().suivre();

    expect(fetchMock.mock.calls[1][0]).toBe('http://vps:8790/tasks/t-42/final-1.mp4');
    expect(cloudinary.uploader.upload_stream).toHaveBeenCalled();
    const maj = prisma.contenu.update.mock.calls[0][0].data;
    expect(maj.video_status).toBe('ready');
    expect(maj.video_url).toContain('reels/u1/c1.mp4');
    expect(notifications.notifierCle).toHaveBeenCalledWith('u1', 'c1', 'Instagram', 'reel.ready', 'reelPret');
  });

  it('suivi : tâche en échec ou perdue → reel en échec, quota rendu', async () => {
    prisma.contenu.findMany.mockResolvedValueOnce([reel()]);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { state: -1 } }) });
    await service().suivre();
    expect(prisma.contenu.update.mock.calls[0][0].data.video_status).toBe('echec');
    expect(quota.refundByUser).toHaveBeenCalledWith('u1', 'reel');

    jest.clearAllMocks();
    prisma.contenu.findMany.mockResolvedValueOnce([reel()]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await service().suivre();
    expect(prisma.contenu.update.mock.calls[0][0].data.video_status).toBe('echec');
  });

  it('suivi : encore en cours → rien ne bouge, sauf au-delà de 30 minutes', async () => {
    prisma.contenu.findMany.mockResolvedValueOnce([reel()]);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { state: 4, progress: 40 } }) });
    await service().suivre();
    expect(prisma.contenu.update).not.toHaveBeenCalled();

    prisma.contenu.findMany.mockResolvedValueOnce([reel(31 * 60_000)]);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { state: 4, progress: 40 } }) });
    await service().suivre();
    expect(prisma.contenu.update.mock.calls[0][0].data.video_status).toBe('echec');
  });
});
