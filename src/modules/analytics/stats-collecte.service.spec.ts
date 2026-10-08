import { ConfigService } from '@nestjs/config';
import {
  abonnesParMois,
  agregerMois,
  decalerMois,
  ficheGoogleParMois,
  formatDe,
  moisParis,
  postDepuisZernio,
  StatsCollecteService,
  tauxEngagement,
} from './stats-collecte.service';

const postZernio = (o: Record<string, unknown> = {}) => ({
  _id: 'z1',
  latePostId: 'lp1',
  platform: 'instagram',
  publishedAt: '2026-09-15T10:00:00.000Z',
  mediaType: 'video',
  mediaProductType: 'REELS',
  platforms: [{ platform: 'instagram', platformPostId: '1789', accountId: 'acc1', platformPostUrl: 'https://instagram.com/reel/x' }],
  analytics: { impressions: 100, reach: 80, likes: 6, comments: 2, shares: 1, saves: 1, clicks: 0, views: 120, igReelsAvgWatchTime: 4900, follows: null, impressionSources: {}, lastUpdated: '2026-10-05 23:06:17' },
  ...o,
});

describe('stats-collecte : fonctions de calcul', () => {
  it('moisParis range une publication du 31 au soir (UTC) dans le mois suivant à Paris', () => {
    expect(moisParis(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01');
    expect(moisParis(new Date('2026-09-30T21:30:00Z'))).toBe('2026-09-01');
  });

  it('decalerMois passe les années', () => {
    expect(decalerMois('2026-10-01', -11)).toBe('2025-11-01');
    expect(decalerMois('2026-12-01', 1)).toBe('2027-01-01');
  });

  it('formatDe classe les formats Zernio', () => {
    expect(formatDe('instagram', 'video', 'REELS')).toBe('reel');
    expect(formatDe('instagram', 'video', null)).toBe('reel');
    expect(formatDe('linkedin', 'video', null)).toBe('video');
    expect(formatDe('facebook', 'carousel', null)).toBe('carrousel');
    expect(formatDe('instagram', 'image', 'STORY')).toBe('story');
    expect(formatDe('linkedin', 'image', null)).toBe('image');
    expect(formatDe('linkedin', null, null)).toBe('texte');
  });

  it('tauxEngagement se base sur les impressions, sinon les vues, sinon rien', () => {
    expect(tauxEngagement({ impressions: 200, vues: 0, likes: 8, commentaires: 1, partages: 1, enregistrements: 0 })).toBe(5);
    expect(tauxEngagement({ impressions: 0, vues: 50, likes: 5, commentaires: 0, partages: 0, enregistrements: 0 })).toBe(10);
    expect(tauxEngagement({ impressions: 0, vues: 0, likes: 5, commentaires: 0, partages: 0, enregistrements: 0 })).toBeNull();
  });

  it('postDepuisZernio range les compteurs en colonnes et le reste dans details', () => {
    const p = postDepuisZernio(postZernio())!;
    expect(p).toMatchObject({
      zernio_id: 'z1', late_post_id: 'lp1', plateforme_post_id: '1789', compte_id: 'acc1', reseau: 'instagram', format: 'reel',
      impressions: 100, portee: 80, vues: 120, likes: 6, commentaires: 2, partages: 1, enregistrements: 1, taux_engagement: 10, externe: false,
      url: 'https://instagram.com/reel/x',
    });
    expect(p.details).toEqual({ igReelsAvgWatchTime: 4900, mediaType: 'video', mediaProductType: 'REELS' });
    expect(p.maj_zernio?.toISOString()).toBe('2026-10-05T23:06:17.000Z');
  });

  it('postDepuisZernio : sans latePostId, le post est externe ; sans _id, il est ignoré', () => {
    expect(postDepuisZernio(postZernio({ latePostId: null }))!.externe).toBe(true);
    expect(postDepuisZernio(postZernio({ _id: undefined }))).toBeNull();
  });

  it('agregerMois : totaux par format, par réseau et tous réseaux, hors mois non retenus', () => {
    const posts = [
      postDepuisZernio(postZernio({ _id: 'a' }))!,
      postDepuisZernio(postZernio({ _id: 'b', mediaType: 'carousel', mediaProductType: null }))!,
      postDepuisZernio(postZernio({ _id: 'c', platform: 'linkedin', mediaType: 'image', mediaProductType: null }))!,
      postDepuisZernio(postZernio({ _id: 'd', platform: 'googlebusiness', mediaType: 'image', mediaProductType: null }))!,
      postDepuisZernio(postZernio({ _id: 'e', publishedAt: '2026-07-10T10:00:00Z' }))!, // mois non retenu
    ];
    const l = agregerMois(posts, ['2026-09-01', '2026-10-01'], ['instagram', 'linkedin', 'facebook']);
    expect(l.get('2026-09-01|instagram|reel')!.posts).toBe(1);
    expect(l.get('2026-09-01|instagram|carrousel')!.posts).toBe(1);
    expect(l.get('2026-09-01|instagram|tous')).toMatchObject({ posts: 2, impressions: 200, likes: 12, taux_engagement: 10 });
    expect(l.get('2026-09-01|tous|tous')!.posts).toBe(3); // la fiche Google n'y entre pas
    expect(l.get('2026-09-01|googlebusiness|tous')!.posts).toBe(1);
    expect(l.get('2026-10-01|facebook|tous')!.posts).toBe(0); // mois vide mais réseau connecté
    expect([...l.keys()].some((k) => k.startsWith('2026-07'))).toBe(false);
  });

  it('abonnesParMois : fin de mois = 1er du mois suivant, valeur actuelle pour le mois en cours', () => {
    const series = { ig: [{ date: '2026-08-01', followers: 32 }, { date: '2026-09-01', followers: 56 }, { date: '2026-10-01', followers: 61 }] };
    const comptes = [{ _id: 'ig', platform: 'instagram', currentFollowers: 62 }];
    const r = abonnesParMois(series, comptes, ['2026-08-01', '2026-09-01', '2026-10-01'], '2026-10-01');
    expect(r.get('2026-08-01|instagram')).toEqual({ abonnes: 56, gagnes: 24 });
    expect(r.get('2026-09-01|instagram')).toEqual({ abonnes: 61, gagnes: 5 });
    expect(r.get('2026-10-01|instagram')).toEqual({ abonnes: 62, gagnes: 1 });
    expect(r.get('2026-10-01|tous')).toEqual({ abonnes: 62, gagnes: 1 });
  });

  it("abonnesParMois ignore la fiche Google (pas d'abonnés)", () => {
    const r = abonnesParMois({}, [{ _id: 'g', platform: 'googlebusiness', currentFollowers: 0 }], ['2026-10-01'], '2026-10-01');
    expect(r.size).toBe(0);
  });

  it('ficheGoogleParMois additionne les jours et regroupe Recherche / Maps', () => {
    const r = ficheGoogleParMois({
      BUSINESS_IMPRESSIONS_MOBILE_SEARCH: { values: [{ date: '2026-09-01', value: 3 }, { date: '2026-09-02', value: 2 }] },
      BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: { values: [{ date: '2026-09-01', value: 1 }] },
      CALL_CLICKS: { values: [{ date: '2026-10-01', value: 4 }] },
    });
    expect(r.get('2026-09-01')).toMatchObject({ vues_recherche: 6, appels: 0 });
    expect(r.get('2026-10-01')).toMatchObject({ appels: 4, vues_recherche: 0 });
  });
});

describe('StatsCollecteService.collecterClient', () => {
  function make() {
    const prisma = {
      users: { findUnique: jest.fn().mockResolvedValue({ late_profile_id: 'prof1' }), count: jest.fn().mockResolvedValue(0) },
      contenu: { findMany: jest.fn().mockResolvedValue([{ id: 'c-ig', late_post_id: 'lp1', reseau_cible: 'Instagram' }]) },
      analytics_performance: { upsert: jest.fn().mockResolvedValue({}) },
      stats_mensuelles: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const zernio = {
      isConfigured: true,
      getAnalyticsPage: jest.fn().mockResolvedValue({ posts: [postZernio()], pagination: { page: 1, pages: 1 } }),
      getFollowerStatsMensuel: jest.fn().mockResolvedValue({ accounts: [{ _id: 'acc1', platform: 'instagram', currentFollowers: 62 }], stats: { acc1: [{ date: '2026-09-01', followers: 56 }, { date: '2026-10-01', followers: 61 }] } }),
      listAccounts: jest.fn().mockResolvedValue({ accounts: [{ _id: 'acc1', platform: 'instagram', isActive: true }] }),
      getGoogleBusinessPerformance: jest.fn(),
      getGoogleBusinessKeywords: jest.fn(),
    };
    const config = { get: jest.fn().mockReturnValue(0) } as unknown as ConfigService;
    const diagnostic = { diagnostiquerClient: jest.fn().mockResolvedValue({ ok: true }) };
    const plan = { planifierSiAbsent: jest.fn().mockResolvedValue(true) };
    const service = new StatsCollecteService(prisma as never, zernio as never, config, diagnostic as never, plan as never);
    return { service, prisma, zernio, diagnostic, plan };
  }
  const maintenant = new Date('2026-10-07T12:00:00Z');

  it("test à blanc : calcule tout et n'écrit rien", async () => {
    const { service, prisma, zernio } = make();
    const r = await service.collecterClient('u1', { nbMois: 2, ecrire: false, maintenant });
    expect(zernio.getAnalyticsPage).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'prof1', fromDate: '2026-08-31', toDate: '2026-10-07' }));
    expect(r).toMatchObject({ ok: true, ecrit: false, posts: 1, posts_relies: 1, fenetre: { debut: '2026-09-01', fin: '2026-10-07' } });
    expect(r.apercu!.mois.find((m) => m.mois === '2026-09-01' && m.reseau === 'instagram' && m.format === 'tous')).toMatchObject({ posts: 1, abonnes: 61, abonnes_gagnes: 5 });
    expect(prisma.analytics_performance.upsert).not.toHaveBeenCalled();
    expect(prisma.stats_mensuelles.upsert).not.toHaveBeenCalled();
  });

  it('écrit par upsert (jamais de suppression), en rattachant le contenu Postorico', async () => {
    const { service, prisma } = make();
    const r = await service.collecterClient('u1', { nbMois: 2, maintenant });
    expect(r.ecrit).toBe(true);
    expect(prisma.analytics_performance.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { zernio_id: 'z1' }, create: expect.objectContaining({ contenu_id: 'c-ig', telegram_id: 'u1' }) }));
    expect(prisma.stats_mensuelles.upsert).toHaveBeenCalledTimes(r.lignes_mois!);
  });

  it('client sans profil Zernio : ignoré sans appel externe', async () => {
    const { service, prisma, zernio } = make();
    prisma.users.findUnique.mockResolvedValue({ late_profile_id: null });
    expect(await service.collecterClient('u1')).toEqual({ ok: true, telegram_id: 'u1', ignore: 'aucun_profil_zernio' });
    expect(zernio.getAnalyticsPage).not.toHaveBeenCalled();
  });

  it('profil Zernio partagé avec un autre compte : ignoré, rien écrit', async () => {
    const { service, prisma, zernio } = make();
    prisma.users.count.mockResolvedValue(1);
    expect(await service.collecterClient('u1', { maintenant })).toEqual({ ok: true, telegram_id: 'u1', ignore: 'profil_zernio_partage' });
    expect(zernio.getAnalyticsPage).not.toHaveBeenCalled();
    expect(prisma.analytics_performance.upsert).not.toHaveBeenCalled();
  });

  it('collecterTous recalcule le diagnostic du mois précédent après une collecte écrite', async () => {
    const { service, prisma, diagnostic } = make();
    (prisma.users as Record<string, jest.Mock>).findMany = jest.fn().mockResolvedValue([{ telegram_id: 'u1' }]);
    const r = await service.collecterTous(2);
    expect(r).toEqual({ ok: true, clients: 1, erreurs: 0 });
    expect(diagnostic.diagnostiquerClient).toHaveBeenCalledWith('u1');
  });

  it("collecterTous : pas de diagnostic pour un client ignoré (sans profil)", async () => {
    const { service, prisma, diagnostic } = make();
    (prisma.users as Record<string, jest.Mock>).findMany = jest.fn().mockResolvedValue([{ telegram_id: 'u1' }]);
    prisma.users.findUnique.mockResolvedValue({ late_profile_id: null });
    await service.collecterTous(2);
    expect(diagnostic.diagnostiquerClient).not.toHaveBeenCalled();
  });

  it("nbMois est borné à 12 (Zernio refuse plus d'un an)", async () => {
    const { service } = make();
    const r = await service.collecterClient('u1', { nbMois: 40, ecrire: false, maintenant });
    expect(r.fenetre!.debut).toBe('2025-11-01');
  });
});
