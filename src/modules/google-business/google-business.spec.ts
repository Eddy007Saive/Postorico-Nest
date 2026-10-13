import { donneesGoogle, verifierOptionsGoogle } from './google-options.util';
import {
  ErreurFicheGoogle,
  GoogleBusinessService,
} from './google-business.service';
import {
  avisDepuisGoogle,
  horairesDepuisGoogle,
  horairesSpeciauxDepuisGoogle,
  horairesSpeciauxVersGoogle,
  horairesVersGoogle,
  photoDepuisGoogle,
  verifierHoraires,
} from './google-business.util';

const TID = '11111111-1111-1111-1111-111111111111';
const COMPTE = 'acc_gbp';

describe('fiche Google : options des posts', () => {
  it('sans options : rien à vérifier ni à envoyer', () => {
    expect(verifierOptionsGoogle(null)).toBeNull();
    expect(donneesGoogle(null)).toBeNull();
  });

  it("bouton d'action : lien https obligatoire sauf « Appeler »", () => {
    expect(
      verifierOptionsGoogle({ bouton: { type: 'BOOK', url: 'http://x.fr' } }),
    ).toContain('https');
    expect(
      verifierOptionsGoogle({
        bouton: { type: 'BOOK', url: 'https://x.fr/rdv' },
      }),
    ).toBeNull();
    expect(verifierOptionsGoogle({ bouton: { type: 'CALL' } })).toBeNull();
    expect(
      donneesGoogle({ bouton: { type: 'CALL', url: 'https://ignore' } }),
    ).toEqual({ topicType: 'STANDARD', callToAction: { type: 'CALL' } });
  });

  it('événement : titre et date de début obligatoires, dates converties au format Google', () => {
    expect(
      verifierOptionsGoogle({
        type: 'EVENT',
        evenement: { debut: '2026-12-24' },
      }),
    ).toContain('titre');
    expect(
      verifierOptionsGoogle({
        type: 'EVENT',
        evenement: { titre: 'Soirée', debut: '2026-12-24', fin: '2026-12-20' },
      }),
    ).toContain('avant');
    const o = {
      type: 'EVENT' as const,
      evenement: {
        titre: 'Soirée de Noël',
        debut: '2026-12-24T18:30',
        fin: '2026-12-24T23:00',
      },
    };
    expect(verifierOptionsGoogle(o)).toBeNull();
    expect(donneesGoogle(o)).toEqual({
      topicType: 'EVENT',
      event: {
        title: 'Soirée de Noël',
        schedule: {
          startDate: { year: 2026, month: 12, day: 24 },
          endDate: { year: 2026, month: 12, day: 24 },
          startTime: { hours: 18, minutes: 30 },
          endTime: { hours: 23, minutes: 0 },
        },
      },
    });
  });

  it('offre : il faut au moins un code, un lien ou des conditions ; le titre par défaut vient du contenu', () => {
    expect(verifierOptionsGoogle({ type: 'OFFER' })).toContain('code');
    const o = {
      type: 'OFFER' as const,
      offre: { code: 'NOEL10', conditions: 'Hors promotions' },
      evenement: { debut: '2026-12-01', fin: '2026-12-31' },
    };
    expect(verifierOptionsGoogle(o)).toBeNull();
    expect(donneesGoogle(o, '-10 % en décembre')).toMatchObject({
      topicType: 'OFFER',
      offer: { couponCode: 'NOEL10', termsConditions: 'Hors promotions' },
      event: { title: '-10 % en décembre' },
    });
  });
});

describe('fiche Google : horaires', () => {
  it('lit le format Google ({} = 00:00, {hours: 24} = minuit)', () => {
    expect(
      horairesDepuisGoogle([
        {
          openDay: 'MONDAY',
          openTime: { hours: 9 },
          closeDay: 'MONDAY',
          closeTime: { hours: 12, minutes: 30 },
        },
        {
          openDay: 'MONDAY',
          openTime: { hours: 14 },
          closeDay: 'MONDAY',
          closeTime: { hours: 18 },
        },
        {
          openDay: 'SUNDAY',
          openTime: {},
          closeDay: 'SUNDAY',
          closeTime: { hours: 24 },
        },
      ]),
    ).toEqual({
      MONDAY: [
        { debut: '09:00', fin: '12:30' },
        { debut: '14:00', fin: '18:00' },
      ],
      SUNDAY: [{ debut: '00:00', fin: '24:00' }],
    });
  });

  it('écrit le format Google ; une plage de nuit se ferme le lendemain', () => {
    expect(
      horairesVersGoogle({
        FRIDAY: [{ debut: '19:00', fin: '02:00' }],
        SUNDAY: [{ debut: '10:00', fin: '24:00' }],
      }),
    ).toEqual({
      periods: [
        {
          openDay: 'FRIDAY',
          openTime: { hours: 19 },
          closeDay: 'SATURDAY',
          closeTime: { hours: 2 },
        },
        {
          openDay: 'SUNDAY',
          openTime: { hours: 10 },
          closeDay: 'SUNDAY',
          closeTime: { hours: 24 },
        },
      ],
    });
  });

  it('refuse les heures mal formées', () => {
    expect(
      verifierHoraires({ MONDAY: [{ debut: '9h', fin: '18:00' }] }),
    ).toContain('HH:MM');
    expect(
      verifierHoraires({ MONDAY: [{ debut: '24:30', fin: '18:00' }] }),
    ).toContain('HH:MM');
    expect(
      verifierHoraires({ MONDAY: [{ debut: '09:00', fin: '18:00' }] }),
    ).toBeNull();
  });

  it('horaires exceptionnels : fermeture ou horaires spéciaux, dans les deux sens', () => {
    const liste = [
      { date: '2026-12-25', ferme: true },
      { date: '2026-12-24', ferme: false, debut: '09:00', fin: '13:00' },
    ];
    const g = horairesSpeciauxVersGoogle(liste);
    expect(g.specialHourPeriods[0]).toEqual({
      startDate: { year: 2026, month: 12, day: 25 },
      closed: true,
    });
    expect(horairesSpeciauxDepuisGoogle(g.specialHourPeriods)).toEqual(liste);
  });
});

describe('fiche Google : avis et photos (format écran)', () => {
  it('avis : note, auteur (masqué si anonyme), réponse', () => {
    expect(
      avisDepuisGoogle({
        id: 'AbF1',
        reviewer: { displayName: 'Marie', isAnonymous: false },
        rating: 4,
        comment: 'Très bon accueil',
        createTime: '2026-10-01T10:00:00Z',
        reviewReply: {
          comment: 'Merci Marie',
          updateTime: '2026-10-02T10:00:00Z',
        },
      }),
    ).toMatchObject({
      id: 'AbF1',
      auteur: 'Marie',
      note: 4,
      texte: 'Très bon accueil',
      reponse: { texte: 'Merci Marie' },
    });
    expect(
      avisDepuisGoogle({
        name: 'accounts/1/locations/2/reviews/XYZ',
        reviewer: { isAnonymous: true },
        starRating: 'TWO',
        reviewReply: null,
      }),
    ).toMatchObject({
      id: 'XYZ',
      auteur: null,
      note: 2,
      reponse: null,
    });
  });

  it("photo : l'identifiant est la fin du nom de ressource Google", () => {
    expect(
      photoDepuisGoogle({
        name: 'accounts/1/locations/2/media/AF1Qip',
        googleUrl: 'https://lh3/x',
        locationAssociation: { category: 'COVER' },
      }),
    ).toMatchObject({ id: 'AF1Qip', url: 'https://lh3/x', categorie: 'COVER' });
  });
});

function make(compte: string | null = COMPTE) {
  const prisma = {
    comptes_sociaux: {
      findFirst: jest
        .fn()
        .mockResolvedValue(compte ? { late_account_id: compte } : null),
    },
  };
  const zernio = {
    listGmbReviews: jest.fn(),
    replyGmbReview: jest.fn().mockResolvedValue({ success: true }),
    deleteGmbReviewReply: jest.fn().mockResolvedValue({ success: true }),
    listGmbMedia: jest.fn(),
    createGmbMedia: jest.fn().mockResolvedValue({
      name: 'accounts/1/locations/2/media/NEW',
      googleUrl: 'https://lh3/new',
    }),
    deleteGmbMedia: jest.fn().mockResolvedValue({ success: true }),
    getGmbLocationDetails: jest.fn(),
    updateGmbLocationDetails: jest.fn().mockResolvedValue({ success: true }),
  };
  const claude = {
    messagesCreate: jest.fn().mockResolvedValue({}),
    texte: jest.fn().mockReturnValue('Merci beaucoup Marie !'),
  };
  const marque = {
    chargerMarque: jest.fn().mockResolvedValue({ voix_marque: 'chaleureuse' }),
    contexteMarqueCourt: jest.fn().mockReturnValue(''),
  };
  const config = {
    get: (k: string) => (k === 'app.cloudinaryCloudName' ? 'demo' : undefined),
  };
  const service = new GoogleBusinessService(
    prisma as never,
    zernio as never,
    claude as never,
    marque as never,
    config as never,
  );
  return { service, zernio, claude };
}

describe('fiche Google : service', () => {
  it('fiche non connectée : erreur claire (404)', async () => {
    const { service } = make(null);
    await expect(service.avis(TID)).rejects.toMatchObject({ statut: 404 });
  });

  it('avis : moyenne arrondie, total, page suivante', async () => {
    const { service, zernio } = make();
    zernio.listGmbReviews.mockResolvedValueOnce({
      reviews: [{ id: 'A', rating: 5, reviewer: { displayName: 'Paul' } }],
      averageRating: 4.66,
      totalReviewCount: 12,
      nextPageToken: 'p2',
    });
    expect(await service.avis(TID)).toMatchObject({
      moyenne: 4.7,
      total: 12,
      suite: 'p2',
      avis: [{ id: 'A', note: 5 }],
    });
  });

  it('réponse : texte obligatoire, envoyée à Zernio', async () => {
    const { service, zernio } = make();
    await expect(service.repondre(TID, 'A', '  ')).rejects.toBeInstanceOf(
      ErreurFicheGoogle,
    );
    await service.repondre(TID, 'A', 'Merci !');
    expect(zernio.replyGmbReview).toHaveBeenCalledWith(COMPTE, 'A', 'Merci !');
  });

  it("fiche non vérifiée : message explicite au lieu de l'erreur brute", async () => {
    const { service, zernio } = make();
    zernio.listGmbReviews.mockRejectedValueOnce(
      new Error('Location is not verified'),
    );
    await expect(service.avis(TID)).rejects.toMatchObject({
      statut: 409,
      message: expect.stringContaining('vérifiée') as unknown,
    });
  });

  it("suggestion de réponse : l'avis critique demande des excuses, le texte de l'avis reste une donnée", async () => {
    const { service, claude } = make();
    const r = await service.suggererReponse(TID, {
      auteur: 'Marie',
      note: 2,
      texte: 'Attente trop longue',
    });
    expect(r.texte).toBe('Merci beaucoup Marie !');
    const appel = claude.messagesCreate.mock.calls[0] as [
      { messages: Array<{ content: string }> },
    ];
    const consigne = appel[0].messages[0].content;
    expect(consigne).toContain('critical review');
    expect(consigne).toContain('<review>\nAttente trop longue\n</review>');
  });

  it('photo : seulement depuis le Cloudinary du client, envoyée en JPEG avec sa catégorie', async () => {
    const { service, zernio } = make();
    await expect(
      service.ajouterPhoto(TID, { url: 'https://exemple.com/x.jpg' }),
    ).rejects.toBeInstanceOf(ErreurFicheGoogle);
    const url = `https://res.cloudinary.com/demo/image/upload/v1/banque/${TID}/photo.webp`;
    const r = await service.ajouterPhoto(TID, { url, categorie: 'COVER' });
    expect((zernio.createGmbMedia.mock.calls[0] as unknown[])[1]).toEqual({
      sourceUrl: `https://res.cloudinary.com/demo/image/upload/f_jpg,q_auto:good,w_1600,c_limit/v1/banque/${TID}/photo.webp`,
      category: 'COVER',
    });
    expect(r).toMatchObject({ id: 'NEW', categorie: 'COVER' });
  });

  it('infos : seuls les champs envoyés sont modifiés (updateMask), puis la fiche est relue', async () => {
    const { service, zernio } = make();
    zernio.getGmbLocationDetails.mockResolvedValue({
      title: 'Chez Paul',
      profile: { description: 'Nouvelle' },
      regularHours: { periods: [] },
    });
    const r = await service.majInfos(TID, {
      description: 'Nouvelle',
      horaires: { MONDAY: [{ debut: '09:00', fin: '18:00' }] },
    });
    const corps = (
      zernio.updateGmbLocationDetails.mock.calls[0] as [
        string,
        { updateMask: string; regularHours: { periods: unknown[] } },
      ]
    )[1];
    expect(corps.updateMask).toBe('profile.description,regularHours');
    expect(corps.regularHours.periods[0]).toMatchObject({
      openDay: 'MONDAY',
      openTime: { hours: 9 },
    });
    expect(r).toMatchObject({ nom: 'Chez Paul', description: 'Nouvelle' });
  });

  it('infos : description trop longue refusée avant tout appel', async () => {
    const { service, zernio } = make();
    await expect(
      service.majInfos(TID, { description: 'x'.repeat(751) }),
    ).rejects.toBeInstanceOf(ErreurFicheGoogle);
    expect(zernio.updateGmbLocationDetails).not.toHaveBeenCalled();
  });
});
