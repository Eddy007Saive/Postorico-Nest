import {
  constatCreneaux,
  constatEvolution,
  constatFicheGoogle,
  constatFormats,
  constatTopPosts,
  constatVolume,
  DiagnosticService,
  LigneStats,
  PostAnalyse,
} from './diagnostic.service';

const ligne = (o: Partial<LigneStats>): LigneStats => ({
  mois: '2026-09-01', reseau: 'tous', format: 'tous', posts: 0, impressions: 0, vues: 0, likes: 0, commentaires: 0,
  partages: 0, enregistrements: 0, abonnes: null, abonnes_gagnes: null, details: {}, ...o,
});
const post = (o: Partial<PostAnalyse>): PostAnalyse => ({
  zernio_id: 'z', contenu_id: null, titre: null, reseau: 'instagram', format: 'image', publie_le: new Date('2026-09-10T10:00:00Z'),
  impressions: 100, vues: 0, interactions: 5, taux_engagement: 5, url: null, ...o,
});

describe('diagnostic : constats', () => {
  it("évolution : variations vs mois précédent, fiche Google à part, 'tous' en premier", () => {
    const stats = [
      ligne({ mois: '2026-08-01', posts: 26, impressions: 2300, likes: 30, commentaires: 4, abonnes_gagnes: 53 }),
      ligne({ mois: '2026-09-01', posts: 1, impressions: 238, likes: 3, abonnes_gagnes: 42 }),
      ligne({ mois: '2026-09-01', reseau: 'linkedin', posts: 1, impressions: 238, likes: 3 }),
      ligne({ mois: '2026-09-01', reseau: 'googlebusiness' }),
    ];
    const ev = constatEvolution(stats, '2026-09-01');
    expect(ev.map((e) => e.reseau)).toEqual(['tous', 'linkedin']);
    expect(ev[0].variations).toMatchObject({ posts: -96.2, impressions: -89.7, abonnes_gagnes: -11 });
    expect(ev[1].precedent).toBeNull();
    expect(ev[1].variations.impressions).toBeNull();
  });

  it('formats : comparés sur 3 mois, seulement à partir de 3 posts par format', () => {
    const stats = [
      ligne({ mois: '2026-07-01', reseau: 'instagram', format: 'image', posts: 2, impressions: 40, likes: 2 }),
      ligne({ mois: '2026-08-01', reseau: 'instagram', format: 'image', posts: 8, impressions: 80, likes: 4 }),
      ligne({ mois: '2026-08-01', reseau: 'instagram', format: 'reel', posts: 4, impressions: 400, likes: 3 }),
      ligne({ mois: '2026-08-01', reseau: 'instagram', format: 'carrousel', posts: 2, impressions: 40, likes: 10 }), // trop peu de posts
      ligne({ mois: '2026-05-01', reseau: 'instagram', format: 'reel', posts: 9, impressions: 900, likes: 90 }), // hors fenêtre
    ];
    const [f] = constatFormats(stats, '2026-09-01');
    expect(f.formats.map((x) => x.format)).toEqual(['image', 'reel']);
    expect(f.formats[0]).toMatchObject({ posts: 10, taux_engagement: 5 });
    expect(f.meilleur).toMatchObject({ format: 'image', fois_plus_que_dernier: 6.7, dernier: 'reel' });
  });

  it("formats : pas de 'meilleur' quand l'écart est sous le seuil, rien sous 2 formats", () => {
    const proches = [
      ligne({ reseau: 'linkedin', format: 'image', posts: 5, impressions: 100, likes: 5 }),
      ligne({ reseau: 'linkedin', format: 'video', posts: 5, impressions: 100, likes: 5 }),
    ];
    expect(constatFormats(proches, '2026-09-01')[0].meilleur).toBeNull();
    expect(constatFormats([proches[0]], '2026-09-01')).toEqual([]);
  });

  it('volume : semaines actives, plus long silence, cadence Zernio', () => {
    const posts = [post({ publie_le: new Date('2026-09-02T10:00:00Z') }), post({ publie_le: new Date('2026-09-03T10:00:00Z') }), post({ publie_le: new Date('2026-09-20T10:00:00Z'), reseau: 'linkedin' })];
    const freq = [
      { platform: 'instagram', postsParSemaine: 1, tauxEngagement: 2, semaines: 4 },
      { platform: 'instagram', postsParSemaine: 3, tauxEngagement: 4.5, semaines: 3 },
      { platform: 'instagram', postsParSemaine: 6, tauxEngagement: 9, semaines: 1 }, // trop peu de semaines
    ];
    const v = constatVolume([ligne({ mois: '2026-08-01', posts: 26 })], posts, '2026-09-01', 'Europe/Paris', freq);
    expect(v).toMatchObject({ posts: 3, posts_mois_precedent: 26, par_reseau: { instagram: 2, linkedin: 1 }, semaines_actives: 2, semaines_du_mois: 5, plus_long_silence_jours: 16, regulier: false });
    expect(v.cadences).toEqual([{ reseau: 'instagram', posts_par_semaine_actuel: 0.5, meilleure_cadence: { posts_par_semaine: 3, taux_engagement: 4.5, semaines: 3 } }]);
  });

  it("volume : un post publié le 30 à 23h30 heure de Paris compte dans le mois local", () => {
    const v = constatVolume([], [post({ publie_le: new Date('2026-09-30T21:30:00Z') })], '2026-09-01', 'Europe/Paris', []);
    expect(v.plus_long_silence_jours).toBe(29);
  });

  it('créneaux : seulement ceux nourris par assez de publications, 3 au plus', () => {
    const c = [{ jour: 3, heure: 18, engagement: 9, posts: 1 }, { jour: 1, heure: 9, engagement: 5, posts: 4 }, { jour: 2, heure: 12, engagement: 4, posts: 3 }];
    expect(constatCreneaux(c)).toEqual([c[1], c[2]]);
    expect(constatCreneaux([c[0]])).toBeNull();
  });

  it('top posts : classés par engagement au-dessus du minimum de vues, plus le plus vu', () => {
    const t = constatTopPosts([
      post({ zernio_id: 'a', taux_engagement: 30, impressions: 10 }), // trop peu vu
      post({ zernio_id: 'b', taux_engagement: 8, impressions: 50 }),
      post({ zernio_id: 'c', taux_engagement: 2, impressions: 900 }),
      post({ zernio_id: 'g', reseau: 'googlebusiness', taux_engagement: 50, impressions: 5000 }),
    ]);
    expect(t.meilleurs.map((p) => p.zernio_id)).toEqual(['b', 'c']);
    expect(t.plus_vu!.zernio_id).toBe('c');
  });

  it('fiche Google : variations vs mois précédent, absente sans données', () => {
    const stats = [
      ligne({ mois: '2026-08-01', reseau: 'googlebusiness', details: { fiche: { appels: 28, itineraires: 23 } } }),
      ligne({ mois: '2026-09-01', reseau: 'googlebusiness', details: { fiche: { appels: 40, itineraires: 50 }, mots_cles: [{ keyword: 'taxi', impressions: 25 }] } }),
    ];
    expect(constatFicheGoogle(stats, '2026-09-01')).toMatchObject({ variations: { appels: 42.9, itineraires: 117.4 }, mots_cles: [{ keyword: 'taxi', impressions: 25 }] });
    expect(constatFicheGoogle([], '2026-09-01')).toBeNull();
  });
});

describe('DiagnosticService.diagnostiquerClient', () => {
  function make(lignes: unknown[] = [{ mois: new Date('2026-09-01T00:00:00Z'), reseau: 'tous', format: 'tous', posts: 1, impressions: 100, vues: 0, likes: 5, commentaires: 0, partages: 0, enregistrements: 0, abonnes: null, abonnes_gagnes: null, details: {} }]) {
    const prisma = {
      users: { findUnique: jest.fn().mockResolvedValue({ late_profile_id: 'p1', timezone: 'Europe/Paris' }) },
      stats_mensuelles: { findMany: jest.fn().mockResolvedValue(lignes) },
      analytics_performance: { findMany: jest.fn().mockResolvedValue([]) },
      contenu: { findMany: jest.fn().mockResolvedValue([]) },
      diagnostics_mensuels: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const zernio = { isConfigured: true, getBestTimeToPost: jest.fn().mockRejectedValue(new Error('x')), getPostingFrequency: jest.fn().mockResolvedValue({ frequency: [] }) };
    return { service: new DiagnosticService(prisma as never, zernio as never), prisma };
  }

  it('mois par défaut = le mois précédent ; test à blanc sans écriture ; un échec Zernio retire seulement le constat', async () => {
    const { service, prisma } = make();
    const r = await service.diagnostiquerClient('u1', { ecrire: false, maintenant: new Date('2026-10-08T10:00:00Z') });
    expect(r.diagnostic!.mois).toBe('2026-09-01');
    expect(r.diagnostic!.creneaux).toBeNull();
    expect(prisma.diagnostics_mensuels.upsert).not.toHaveBeenCalled();
  });

  it('écrit par upsert sur (client, mois)', async () => {
    const { service, prisma } = make();
    await service.diagnostiquerClient('u1', { mois: '2026-09' });
    expect(prisma.diagnostics_mensuels.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { telegram_id_mois: { telegram_id: 'u1', mois: new Date('2026-09-01T00:00:00Z') } } }));
  });

  it('client sans stats collectées : ignoré', async () => {
    const { service, prisma } = make([]);
    expect(await service.diagnostiquerClient('u1', { mois: '2026-09' })).toEqual({ ok: true, ignore: 'aucune_stat_collectee' });
    expect(prisma.diagnostics_mensuels.upsert).not.toHaveBeenCalled();
  });
});
