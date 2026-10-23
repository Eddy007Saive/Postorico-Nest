import { InspirationReelService, normaliserAnalyse, normaliserScript, scriptEnTexte, SEUIL_QUALITE } from './inspiration-reel.service';

const ANALYSE = {
  duree_s: 32,
  accroche: { texte: 'Arrête de faire ça avec tes clés', mots: 7, pourquoi: 'Interdiction + objet concret' },
  transcription: [{ t: 0, texte: 'Arrête de faire ça avec tes clés' }],
  structure: [{ debut: 0, fin: 3, role: 'accroche', resume: 'interdiction' }, { debut: 3, fin: 28, role: 'astuce', resume: 'la méthode' }],
  rythme: { plans: 9, coupe_toutes_s: 3.5, texte_ecran: 'toujours' },
  textes_ecran: [{ t: 0, texte: 'STOP' }],
  plans: [{ t: 0, type: 'face camera', description: 'Gros plan visage' }],
  langage: { phrase_moyenne_mots: 7, adresse: 'tu', style: 'direct' },
  appel_action: 'Abonne-toi',
  technique_cle: 'Une interdiction en accroche, puis la solution en deux gestes.',
};
const SCRIPT = {
  accroche: 'Personne ne prépare une arrivée comme ça',
  lignes: [
    { debut: 0, fin: 3, voix: 'Personne ne prépare une arrivée comme ça', texte_ecran: 'ARRIVÉE', plan: 'Porte qui s’ouvre' },
    { debut: 3, fin: 35, voix: 'Deux gestes changent tout.', texte_ecran: '', plan: 'Lit fait' },
  ],
  legende: 'Deux gestes.\nAbonne-toi.',
  mot_cle: 'guide pdf',
  duree_s: 35,
};

describe('normalisation', () => {
  it('nettoie une analyse et refuse une analyse vide', () => {
    const a = normaliserAnalyse({ ...ANALYSE, structure: 'pas une liste', plans: [{ t: 'x', type: 'b-roll' }] } as never);
    expect(a.structure).toEqual([]);
    expect(a.plans[0]).toEqual({ t: 0, type: 'b-roll', description: '' });
    expect(() => normaliserAnalyse({})).toThrow('analyse vide');
  });

  it('normalise le script : mot-clé en un mot majuscule, durée par défaut, script vide refusé', () => {
    const s = normaliserScript({ ...SCRIPT, duree_s: undefined } as never);
    expect(s.mot_cle).toBe('GUIDEPDF');
    expect(s.duree_s).toBe(35);
    expect(normaliserScript({ ...SCRIPT, mot_cle: null } as never).mot_cle).toBeNull();
    expect(() => normaliserScript({ lignes: [] })).toThrow('script vide');
  });

  it('met le script en texte lisible pour Contenus', () => {
    const t = scriptEnTexte(normaliserScript(SCRIPT as never));
    expect(t).toContain('[0-3 s] Personne ne prépare une arrivée comme ça');
    expect(t).toContain("À l'écran : ARRIVÉE");
    expect(t).toContain('Plan : Lit fait');
  });
});

describe('InspirationReelService', () => {
  const messagesCreate = jest.fn().mockResolvedValue({});
  const texte = jest.fn();
  const marque = { chargerMarque: jest.fn().mockResolvedValue({ langue: 'fr' }), contexteMarqueCourt: jest.fn().mockReturnValue('') };
  const config = { get: (k: string) => ({ 'app.openrouterApiKey': 'cle-or', 'app.openrouterVideoModel': 'google/gemini-x', 'app.claudeModel': 'claude-sonnet' } as Record<string, string>)[k] };
  const service = new InspirationReelService({ messagesCreate, texte } as never, marque as never, config as never);
  const fetchMock = jest.fn();
  const analyse = normaliserAnalyse(ANALYSE as never);

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('analyser : envoie la vidéo encodée au modèle vidéo et renvoie l’analyse nettoyée', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `Voici :\n${JSON.stringify(ANALYSE)}` } }] }) });
    const a = await service.analyser('u1', Buffer.from('video'), 'video/quicktime');
    expect(a.accroche.mots).toBe(7);
    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.model).toBe('google/gemini-x');
    expect(corps.messages[0].content[1].video_url.url).toBe(`data:video/quicktime;base64,${Buffer.from('video').toString('base64')}`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer cle-or');
  });

  it('analyser : une erreur du modèle remonte (le contrôleur rend le quota)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'video too large' } }) });
    await expect(service.analyser('u1', Buffer.from('v'))).rejects.toThrow('analyse Gemini 400');
  });

  it('ecrireScript : réécrit tant que la note est sous le seuil, 3 versions au plus', async () => {
    texte
      .mockReturnValueOnce(JSON.stringify(SCRIPT)) // v1
      .mockReturnValueOnce('{"score": 60, "violations": ["L’accroche commence par Je"]}')
      .mockReturnValueOnce(JSON.stringify(SCRIPT)) // v2
      .mockReturnValueOnce('{"score": 80, "violations": ["Trois idées"]}')
      .mockReturnValueOnce(JSON.stringify(SCRIPT)) // v3
      .mockReturnValueOnce('{"score": 85, "violations": []}');
    const r = await service.ecrireScript('u1', analyse, 'Préparer une arrivée');
    expect(r.passes).toBe(3);
    expect(r.controle.score).toBe(85);
    // la 2e rédaction reçoit les problèmes à corriger
    expect(messagesCreate.mock.calls[2][0].messages[0].content).toContain('L’accroche commence par Je');
  });

  it('ecrireScript : s’arrête dès que la note atteint le seuil ; la transcription n’est pas transmise au rédacteur', async () => {
    texte.mockReturnValueOnce(JSON.stringify(SCRIPT)).mockReturnValueOnce(`{"score": ${SEUIL_QUALITE}, "details": {"structure": 28}, "violations": []}`);
    const r = await service.ecrireScript('u1', analyse, 'sujet');
    expect(r.passes).toBe(1);
    expect(r.controle.details).toEqual({ structure: 28 });
    const demande = messagesCreate.mock.calls[0][0].messages[0].content as string;
    expect(demande).not.toContain('"transcription"');
    expect(messagesCreate.mock.calls[0][0].model).toBe('claude-sonnet');
  });

  it('contrôle illisible : ne bloque pas le client', async () => {
    texte.mockReturnValueOnce('pas de json');
    const c = await service.controler('French', analyse, 'sujet', normaliserScript(SCRIPT as never));
    expect(c).toEqual({ score: SEUIL_QUALITE, details: {}, violations: [] });
  });
});
