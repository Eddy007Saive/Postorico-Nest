import { ErreurPublicite, PubliciteService } from './publicite.service';
import {
  comptePubDepuisZernio,
  corpsBoost,
  DemandeBoost,
  memeComptePub,
  pubDepuisZernio,
  verifierBoost,
} from './publicite.util';

const TID = 'u1';
const AUJ = '2026-10-14';
const base: DemandeBoost = {
  contenu_id: 'c1',
  compte_pub: 'act_1',
  objectif: 'engagement',
  budget: 5,
  type_budget: 'daily',
  debut: AUJ,
  fin: '2026-10-20',
};

describe('publicité : vérification du boost', () => {
  it('une demande correcte passe', () => {
    expect(verifierBoost(base, AUJ)).toBeNull();
  });

  it('refuse une date passée, une fin avant le début et plus de 90 jours', () => {
    expect(verifierBoost({ ...base, debut: '2026-10-01' }, AUJ)).toMatch(
      /passée/,
    );
    expect(verifierBoost({ ...base, fin: '2026-10-13' }, AUJ)).toMatch(/avant/);
    expect(verifierBoost({ ...base, fin: '2027-03-01' }, AUJ)).toMatch(
      /90 jours/,
    );
  });

  it('budget : minimum du compte, total exige une date de fin', () => {
    expect(verifierBoost({ ...base, budget: 1 }, AUJ, 2)).toMatch(/minimum/);
    expect(
      verifierBoost({ ...base, type_budget: 'lifetime', fin: null }, AUJ),
    ).toMatch(/date de fin/);
    expect(
      verifierBoost({ ...base, type_budget: 'lifetime', budget: 3 }, AUJ),
    ).toMatch(/trop faible/);
  });

  it('visites du site : lien https obligatoire', () => {
    expect(verifierBoost({ ...base, objectif: 'traffic' }, AUJ)).toMatch(
      /lien/,
    );
    expect(
      verifierBoost(
        { ...base, objectif: 'traffic', lien: 'https://x.fr' },
        AUJ,
      ),
    ).toBeNull();
  });

  it('âges et villes contrôlés', () => {
    expect(verifierBoost({ ...base, age_min: 16 }, AUJ)).toMatch(/18 et 65/);
    expect(verifierBoost({ ...base, villes: [{ id: 'Annecy' }] }, AUJ)).toMatch(
      /Ville invalide/,
    );
  });
});

describe('publicité : requête Zernio', () => {
  it('villes avec rayon, sinon la France ; mentions DSA ; lien seulement pour les visites', () => {
    const c = corpsBoost(
      { ...base, villes: [{ id: '733103', rayon_km: 15 }] },
      {
        accountId: 'fb1',
        postId: 'p1',
        nom: 'Postorico · Test',
        beneficiaire: 'Cledici',
      },
    );
    expect(c).toMatchObject({
      accountId: 'fb1',
      adAccountId: 'act_1',
      postId: 'p1',
      goal: 'engagement',
      budgetAmount: 5,
      budgetType: 'daily',
      startDate: AUJ,
      endDate: '2026-10-20',
      dsaBeneficiary: 'Cledici',
      dsaPayor: 'Cledici',
      targeting: {
        ageMin: 18,
        ageMax: 65,
        cities: [{ key: '733103', radius: 15, distance_unit: 'kilometer' }],
      },
    });
    expect(c).not.toHaveProperty('linkUrl');
    const sansVille = corpsBoost(base, {
      accountId: 'fb1',
      postId: 'p1',
      nom: 'x',
      beneficiaire: 'B',
    });
    expect(sansVille.targeting).toMatchObject({ countries: ['FR'] });
  });

  it('pub Zernio et compte pub mis au format écran', () => {
    const p = pubDepuisZernio({
      _id: 'a1',
      name: 'Pub',
      status: 'pending_review',
      configuredStatus: 'ACTIVE',
      budget: { daily: 5 },
      metrics: { spend: 3.2, reach: 900, clicks: 12, cpc: 0.27 },
    });
    expect(p).toMatchObject({
      id: 'a1',
      statut: 'validation',
      allumee: true,
      budget: { montant: 5, type: 'daily' },
    });
    expect(p.stats).toMatchObject({ depense: 3.2, portee: 900, clics: 12 });
    const cp = comptePubDepuisZernio({
      id: 'act_235726368',
      currency: 'EUR',
      accountStatus: 1,
      timezoneName: 'America/Los_Angeles',
      minimumDailyBudget: 0.9,
      billingStatus: 'missing',
      selectable: true,
    });
    expect(cp).toMatchObject({ utilisable: true, budget_min_jour: 1 });
    expect(cp.alertes).toEqual(['sans_carte', 'fuseau']);
    expect(memeComptePub('act_1', '1')).toBe(true);
  });
});

describe('PubliciteService', () => {
  function make() {
    const prisma = {
      comptes_sociaux: {
        findFirst: jest.fn().mockResolvedValue({ late_account_id: 'fb1' }),
      },
      contenu: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          titre: 'Mon post',
          contenu: 'Texte',
          reseau_cible: 'Facebook',
          statut: 'Publie',
          late_post_id: 'p1',
          video_url: null,
        }),
      },
      users: { findUnique: jest.fn().mockResolvedValue({ nom: 'Cledici' }) },
    };
    const zernio = {
      listAdAccounts: jest.fn().mockResolvedValue({
        accounts: [
          {
            id: 'act_1',
            currency: 'EUR',
            accountStatus: 1,
            timezoneName: 'Europe/Paris',
            minimumDailyBudget: 1,
            selectable: true,
          },
        ],
      }),
      boostPost: jest
        .fn()
        .mockResolvedValue({ ad: { _id: 'ad1', status: 'pending_review' } }),
      getAd: jest
        .fn()
        .mockResolvedValue({ _id: 'ad1', platformAdAccountId: 'act_999' }),
      updateAdStatus: jest.fn(),
    };
    const quota = { exigerAbonnement: jest.fn().mockResolvedValue(undefined) };
    const service = new PubliciteService(
      prisma as never,
      zernio as never,
      {} as never,
      {} as never,
      quota as never,
    );
    return { service, prisma, zernio, quota };
  }

  it('booste un post publié, avec une clé anti-doublon stable', async () => {
    const { service, zernio, quota } = make();
    const r = await service.booster(TID, { ...base, debut: null, fin: null });
    expect(quota.exigerAbonnement).toHaveBeenCalledWith(TID);
    expect(r).toMatchObject({ id: 'ad1', statut: 'validation' });
    await service.booster(TID, { ...base, debut: null, fin: null });
    const [corps, cle] = zernio.boostPost.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(corps).toMatchObject({
      accountId: 'fb1',
      postId: 'p1',
      dsaBeneficiary: 'Cledici',
    });
    expect((zernio.boostPost.mock.calls[1] as unknown[])[1]).toBe(cle);
  });

  it('refuse un post non publié et un compte pub sans carte', async () => {
    const { service, prisma, zernio } = make();
    prisma.contenu.findFirst.mockResolvedValueOnce({
      id: 'c1',
      reseau_cible: 'Facebook',
      statut: 'Planifie',
      late_post_id: 'p1',
    });
    await expect(service.booster(TID, base)).rejects.toBeInstanceOf(
      ErreurPublicite,
    );
    zernio.listAdAccounts.mockResolvedValueOnce({
      accounts: [
        {
          id: 'act_1',
          accountStatus: 1,
          billingStatus: 'missing',
          selectable: true,
        },
      ],
    });
    await expect(service.booster(TID, base)).rejects.toThrow(
      /moyen de paiement/,
    );
    expect(zernio.boostPost).not.toHaveBeenCalled();
  });

  it("ne met jamais en pause la pub d'un autre compte publicitaire", async () => {
    const { service, zernio } = make();
    await expect(service.changerStatut(TID, 'ad1', false)).rejects.toThrow(
      /introuvable/,
    );
    expect(zernio.updateAdStatus).not.toHaveBeenCalled();
  });

  it('sans page Facebook : état « page non connectée » au lieu d’une erreur', async () => {
    const { service, prisma } = make();
    prisma.comptes_sociaux.findFirst.mockResolvedValueOnce(null);
    await expect(service.etat(TID)).resolves.toEqual({
      page_connectee: false,
      comptes: [],
    });
  });
});
