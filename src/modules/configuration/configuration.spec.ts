import { ConfigurationService } from './configuration.service';
import { ConfigurationController } from './configuration.controller';
import { TranscriptionService } from './transcription.service';

describe('ConfigurationService', () => {
  const create = jest.fn().mockResolvedValue({});
  const usersUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    brand_audits: { create, findFirst: jest.fn() },
    users: { findUnique: jest.fn().mockResolvedValue({ studio_config: null, studio_config_le: null }), update: usersUpdate },
  };
  const texte = jest.fn();
  const claude = { messagesCreate: jest.fn().mockResolvedValue({}), texte };
  const marque = {
    fiche: jest.fn().mockResolvedValue({ secteur: 'Ancien secteur' }),
    enregistrer: jest.fn(async (_t: string, v: Record<string, unknown>) => v),
  };
  const service = new ConfigurationService(prisma as never, claude as never, marque as never);
  beforeEach(() => jest.clearAllMocks());

  it('signale les réponses dictées à l’IA et ignore les champs vides', () => {
    const t = ConfigurationService.texteReponses({ pitch: 'On gère vos locations', personne: 'Bah moi je tutoie tout le monde', zone: '  ', _vocal: ['personne'] });
    expect(t).toContain('- pitch: On gère vos locations');
    expect(t).toContain('- personne [SPOKEN ANSWER, transcribed word for word]: Bah moi je tutoie');
    expect(t).not.toContain('zone');
  });

  it('écrit la fiche : textes de l’IA, exemples tels quels, couleurs valides, ancienne fiche gardée', async () => {
    texte.mockReturnValue('Voici : {"secteur": "Conciergerie à Nice", "voix_marque": "Tutoiement, phrases courtes", "audience": "", "piliers": "Ménage: les coulisses"}');
    const champs = await service.configurerDepuisFormulaire('u1', 'a@b.fr', {
      pitch: 'Conciergerie', ex_linkedin_linkedin: 'Mon post LinkedIn', col1: '#112233', col2: 'rouge', charte: 'https://res.cloudinary.com/x/image/upload/logo.png',
    }, 'recap');
    expect(champs.sort()).toEqual(['couleur_principale', 'exemples_linkedin', 'logo_url', 'piliers', 'secteur', 'voix_marque'].sort());
    expect(create.mock.calls[0][0].data.answers._fiche_precedente).toEqual({ secteur: 'Ancien secteur' });
    expect(create.mock.calls[0][0].data.status).toBe('traite');
    expect(usersUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ studio_config: 'seul' }) }));
  });

  it('réponses vides : refus sans appel IA', async () => {
    await expect(service.configurerDepuisFormulaire('u1', null, { zone: '' }, '')).rejects.toThrow('reponses_vides');
    expect(claude.messagesCreate).not.toHaveBeenCalled();
  });

  it('réponse IA illisible : erreur, fiche intacte', async () => {
    texte.mockReturnValue('désolé');
    await expect(service.configurerDepuisFormulaire('u1', null, { pitch: 'x' }, '')).rejects.toThrow('synthese_illisible');
    expect(marque.enregistrer).not.toHaveBeenCalled();
  });
});

describe('ConfigurationController.choisir', () => {
  const etat = jest.fn();
  const poser = jest.fn().mockResolvedValue(undefined);
  const sendEmail = jest.fn().mockResolvedValue({});
  const controller = new ConfigurationController(
    { etat, poser } as never,
    {} as never,
    {} as never,
    {} as never,
    { auditReplyHtml: jest.fn().mockReturnValue('<p>'), sendEmail } as never,
    { users: { findUnique: jest.fn().mockResolvedValue({ nom: 'Léa', email: 'lea@x.fr' }) } } as never,
    {} as never,
    { get: jest.fn().mockReturnValue('admin@x.fr') } as never,
  );
  const req = { user: { telegram_id: 'u1' } } as never;
  beforeEach(() => jest.clearAllMocks());

  it('« déjà pris » : studio aux mains de l’équipe, équipe prévenue', async () => {
    etat.mockResolvedValue({ etat: null });
    await controller.choisir({ choix: 'deja_pris' }, req);
    expect(poser).toHaveBeenCalledWith('u1', 'equipe');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('un studio livré ne repasse jamais en cours', async () => {
    etat.mockResolvedValue({ etat: 'livre' });
    await controller.choisir({ choix: 'deja_pris' }, req);
    await controller.choisir({ choix: 'seul' }, req);
    expect(poser).not.toHaveBeenCalled();
  });

  it('« seul » ne remplace pas un studio déjà confié à l’équipe', async () => {
    etat.mockResolvedValue({ etat: 'equipe' });
    await controller.choisir({ choix: 'seul' }, req);
    expect(poser).not.toHaveBeenCalled();
  });

  it('choix inconnu refusé', async () => {
    await expect(controller.choisir({ choix: 'autre' }, req)).rejects.toThrow('Choix invalide');
  });
});

describe('TranscriptionService.typeAccepte', () => {
  it('accepte les enregistrements du navigateur, codec compris', () => {
    expect(TranscriptionService.typeAccepte('audio/webm;codecs=opus')).toBe('video/webm');
    expect(TranscriptionService.typeAccepte('audio/mp4')).toBe('video/mp4');
    expect(TranscriptionService.typeAccepte('image/png')).toBeNull();
  });
});
