import { Diagnostic } from './diagnostic.service';
import { PlanService, phraseSure, reglesPlan, sujetsSurs } from './plan.service';

const evo = (reseau: string, o: { posts?: number; abonnes?: number } = {}) => ({
  reseau,
  actuel: { posts: o.posts ?? 0, impressions: 0, vues: 0, interactions: 0, taux_engagement: null, abonnes: o.abonnes ?? null, abonnes_gagnes: null },
  precedent: null,
  variations: { posts: null, impressions: null, interactions: null, taux_engagement_points: null, abonnes_gagnes: null },
});

type DiagTest = Omit<Partial<Diagnostic>, 'volume' | 'fiche_google'> & { volume?: Partial<Diagnostic['volume']>; fiche_google?: unknown };
function diag(o: DiagTest = {}): Diagnostic {
  return {
    version: 1, mois: '2026-09-01', fuseau: 'Europe/Paris', seuils: {} as Diagnostic['seuils'],
    evolution: [evo('tous'), evo('instagram', { abonnes: 60 }), evo('linkedin', { abonnes: 1200 })],
    formats: [],
    creneaux: null,
    top_posts: { meilleurs: [], plus_vu: null },
    fiche_google: null,
    ...(o as Partial<Diagnostic>),
    volume: {
      posts: 8, posts_mois_precedent: 8, par_reseau: {}, posts_par_semaine: 1.9, semaines_actives: 4, semaines_du_mois: 5,
      plus_long_silence_jours: 5, regulier: true, cadences: [], ...(o.volume || {}),
    },
  } as Diagnostic;
}

describe('plan : règles', () => {
  it('aucun réseau connecté : une seule recommandation, connecter ses réseaux', () => {
    const r = reglesPlan(diag({ evolution: [evo('tous')], volume: { posts: 0 } }));
    expect(r.map((x) => x.type)).toEqual(['connecter_reseaux']);
  });

  it('rien publié : reprise sur le réseau principal (le plus d\'abonnés), au rythme de la meilleure cadence', () => {
    const r = reglesPlan(diag({ volume: { posts: 0, cadences: [{ reseau: 'linkedin', posts_par_semaine_actuel: 0, meilleure_cadence: { posts_par_semaine: 3, taux_engagement: 3.1, semaines: 8 } }] } }));
    expect(r[0]).toMatchObject({ type: 'volume_reprise', reseau: 'linkedin', chiffres: { cible: 3 }, action: { genre: 'post', reseau: 'linkedin', quantite: 12 } });
    expect(r[0].texte_standard).toContain('septembre');
    expect(r.some((x) => x.type === 'cadence')).toBe(false); // déjà couverte par la reprise
  });

  it('chute de volume : de 26 à 1 publication', () => {
    const r = reglesPlan(diag({ volume: { posts: 1, posts_mois_precedent: 26 } }));
    expect(r[0]).toMatchObject({ type: 'volume_chute', chiffres: { avant: 26, maintenant: 1, cible: 2 } });
  });

  it('format nettement meilleur : action sur ce format, chiffres repris', () => {
    const r = reglesPlan(diag({
      formats: [{ reseau: 'instagram', periode: { debut: '2026-07-01', fin: '2026-09-01' },
        formats: [{ format: 'image', posts: 10, impressions: 100, vues: 0, taux_engagement: 5.88 }, { format: 'reel', posts: 4, impressions: 400, vues: 0, taux_engagement: 0.77 }],
        meilleur: { format: 'image', fois_plus_que_suivant: 7.6, fois_plus_que_dernier: 7.6, dernier: 'reel' } }],
    }));
    const f = r.find((x) => x.type === 'format')!;
    expect(f.action).toEqual({ genre: 'post', reseau: 'instagram', quantite: 3 });
    expect(f.texte_standard).toBe("Sur Instagram, tes posts image font 7,6 fois l'engagement de tes reels (5,9 % contre 0,8 %). Fais-en davantage.");
  });

  it('fiche Google en baisse : 2 actualités ; stable : entretien, moins prioritaire', () => {
    const g = (vr: number) => ({ actuel: { appels: 40, itineraires: 50, vues_recherche: 195 }, precedent: { appels: 28, itineraires: 23, vues_recherche: 319 }, variations: { appels: 42.9, vues_recherche: vr }, mots_cles: null });
    const baisse = reglesPlan(diag({ fiche_google: g(-38.9) })).find((x) => x.reseau === 'googlebusiness')!;
    expect(baisse).toMatchObject({ type: 'fiche_google_baisse', chiffres: { baisse: 38.9, actuel: 195, precedent: 319 }, action: { genre: 'actualite_google', quantite: 2 } });
    const stable = reglesPlan(diag({ fiche_google: g(5) })).find((x) => x.reseau === 'googlebusiness')!;
    expect(stable.type).toBe('fiche_google_entretien');
  });

  it('au plus 4 recommandations, les plus prioritaires d\'abord', () => {
    const r = reglesPlan(diag({
      volume: { posts: 1, posts_mois_precedent: 26 },
      creneaux: [{ jour: 0, heure: 9, engagement: 3.6, posts: 7 }],
      top_posts: { meilleurs: [{ zernio_id: 'z', contenu_id: null, titre: 'Mon post', reseau: 'linkedin', format: 'image', publie_le: '2026-09-10T10:00:00Z', impressions: 238, vues: 0, interactions: 3, taux_engagement: 1.26, url: null }], plus_vu: null },
      fiche_google: { actuel: { appels: 4, itineraires: 2, vues_recherche: 10 }, precedent: null, variations: {}, mots_cles: null },
      formats: [{ reseau: 'instagram', periode: { debut: '', fin: '' }, formats: [{ format: 'image', posts: 5, impressions: 1, vues: 0, taux_engagement: 6 }, { format: 'reel', posts: 4, impressions: 1, vues: 0, taux_engagement: 1 }], meilleur: { format: 'image', fois_plus_que_suivant: 6, fois_plus_que_dernier: 6, dernier: 'reel' } }],
    }));
    expect(r).toHaveLength(4);
    expect(r.map((x) => x.type)).toEqual(['volume_chute', 'format', 'top_post', 'creneau']);
    expect(r.find((x) => x.type === 'creneau')!.texte_standard).toContain('lundi vers 9 h');
  });
});

describe('plan : garde-fous sur la formulation IA', () => {
  const reco = reglesPlan(diag({ volume: { posts: 1, posts_mois_precedent: 26 } }))[0];

  it('garde la phrase IA si ses nombres viennent de la reco', () => {
    expect(phraseSure('De 26 publications à 1 seule : reviens à 2 par semaine !', reco)).toBe('De 26 publications à 1 seule : reviens à 2 par semaine !');
  });

  it('arrondi correct accepté, arrondi faux rejeté (1,26 → 1,3 oui ; 1,2 et 1,24 non)', () => {
    const top = { ...reco, chiffres: { taux: 1.26 }, texte_standard: "Ton post a fait 1,3 % d'engagement." };
    expect(phraseSure("Ton post a fait 1,3 % d'engagement, bravo.", top)).toContain('1,3');
    expect(phraseSure("Ton post a fait 1,26 % d'engagement.", top)).toContain('1,26');
    expect(phraseSure("Ton post a fait 1,2 % d'engagement.", top)).toBe(top.texte_standard);
    expect(phraseSure("Ton post a fait 1,24 % d'engagement.", top)).toBe(top.texte_standard);
  });

  it('rejette une phrase IA qui invente un nombre (ou vide, ou trop longue)', () => {
    expect(phraseSure('Tu as perdu 87 % de visibilité.', reco)).toBe(reco.texte_standard);
    expect(phraseSure('', reco)).toBe(reco.texte_standard);
    expect(phraseSure('x'.repeat(500), reco)).toBe(reco.texte_standard);
  });

  it('sujet trop long : coupé à un mot entier', () => {
    const long = `${'mot '.repeat(60)}fin`;
    const [s] = sujetsSurs([long], reco);
    expect(s.endsWith('mot…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(161);
  });

  it('cadence : une marche de +3 au plus', () => {
    const r = reglesPlan(diag({ volume: { cadences: [{ reseau: 'instagram', posts_par_semaine_actuel: 2.3, meilleure_cadence: { posts_par_semaine: 7, taux_engagement: 8, semaines: 3 } }] } }));
    const c = r.find((x) => x.type === 'cadence')!;
    expect(c.chiffres).toMatchObject({ meilleure: 7, cible: 6 });
    expect(c.texte_standard).toContain('monte à 6 ce mois-ci');
  });

  it('sujets : texte seulement, 3 au plus, aucun sans action', () => {
    expect(sujetsSurs(['Sujet un', 'Sujet deux', 'Sujet trois', 'Sujet quatre', 3], reco)).toEqual(['Sujet un', 'Sujet deux', 'Sujet trois']);
    expect(sujetsSurs(['Sujet'], { ...reco, action: null })).toEqual([]);
  });
});

describe('PlanService.planifier', () => {
  function make(diagEnBase: Diagnostic | null) {
    const prisma = {
      diagnostics_mensuels: { findUnique: jest.fn().mockResolvedValue(diagEnBase ? { constats: diagEnBase } : null) },
      plans_mensuels: { upsert: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
    };
    const diagnostic = { diagnostiquerClient: jest.fn().mockResolvedValue({ ok: true, ignore: 'aucune_stat_collectee' }) };
    const claude = { isConfigured: true, messagesCreate: jest.fn().mockRejectedValue(new Error('api')), system: jest.fn(), usage: jest.fn(), texte: jest.fn() };
    const marque = { chargerMarque: jest.fn().mockResolvedValue({}), contexteMarque: jest.fn().mockReturnValue('') };
    const offers = { nomsOffres: jest.fn().mockResolvedValue('') };
    const usage = { log: jest.fn() };
    return { service: new PlanService(prisma as never, diagnostic as never, claude as never, marque as never, offers as never, usage as never), prisma, claude };
  }

  it("plan d'octobre tiré du diagnostic de septembre ; échec IA = phrases standard, plan quand même écrit", async () => {
    const { service, prisma } = make(diag({ volume: { posts: 1, posts_mois_precedent: 26 } }));
    const r = await service.planifier('u1', { mois: '2026-10' });
    expect(prisma.diagnostics_mensuels.findUnique).toHaveBeenCalledWith({ where: { telegram_id_mois: { telegram_id: 'u1', mois: new Date('2026-09-01T00:00:00Z') } } });
    expect(r.plan!.modele).toBeNull();
    expect(r.plan!.recommandations[0].texte).toBe(r.plan!.recommandations[0].texte_standard);
    expect(prisma.plans_mensuels.upsert).toHaveBeenCalled();
  });

  it('test à blanc sans IA : rien écrit, aucun appel IA', async () => {
    const { service, prisma, claude } = make(diag());
    await service.planifier('u1', { mois: '2026-10', ecrire: false, formuler: false });
    expect(prisma.plans_mensuels.upsert).not.toHaveBeenCalled();
    expect(claude.messagesCreate).not.toHaveBeenCalled();
  });

  it("écran : sans plan, rien d'autre n'est lu", async () => {
    const { service, prisma } = make(null);
    prisma.plans_mensuels.findFirst.mockResolvedValue(null);
    expect(await service.ecran('u1')).toEqual({ plan: null, diagnostic: null, serie: [] });
  });

  it('écran : la courbe démarre au premier mois actif et finit au mois du diagnostic', async () => {
    const { service, prisma } = make(null);
    const plan = { mois: new Date('2026-10-01T00:00:00Z'), diagnostic_mois: new Date('2026-09-01T00:00:00Z') };
    prisma.plans_mensuels.findFirst.mockResolvedValue(plan);
    (prisma.diagnostics_mensuels as Record<string, jest.Mock>).findUnique = jest.fn().mockResolvedValue({ constats: { mois: '2026-09-01' }, calcule_le: new Date('2026-10-08T00:00:00Z') });
    const ligne = (m: string, posts: number, impressions: number, abonnes: number | null) => ({ mois: new Date(`${m}-01T00:00:00Z`), posts, impressions, vues: 0, abonnes });
    (prisma as Record<string, unknown>).stats_mensuelles = { findMany: jest.fn().mockResolvedValue([ligne('2026-03', 0, 0, null), ligne('2026-04', 4, 301, 1042), ligne('2026-09', 1, 238, 1251)]) };
    const r = await service.ecran('u1');
    expect(r.serie.map((x) => x.mois)).toEqual(['2026-04', '2026-09']);
    expect(r.diagnostic).toMatchObject({ mois: '2026-09-01' });
  });

  it('sans diagnostic ni stats : ignoré', async () => {
    const { service, prisma } = make(null);
    expect(await service.planifier('u1', { mois: '2026-10' })).toEqual({ ok: true, ignore: 'aucune_stat_collectee' });
    expect(prisma.plans_mensuels.upsert).not.toHaveBeenCalled();
  });
});
