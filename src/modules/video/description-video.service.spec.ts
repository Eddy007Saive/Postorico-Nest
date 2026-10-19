import { DescriptionVideoService } from './description-video.service';

const contenuBase = {
  id: 'c1',
  titre: 'Mon montage',
  contenu: '',
  script: null,
  reseau_cible: 'Instagram',
  video_url: 'https://res.cloudinary.com/x/video/upload/v1/a.mp4',
  submagic_project_id: null,
  reel_data: null,
};

function monter(opts: { contenu?: Record<string, unknown> | null; montage?: Record<string, unknown> | null; source?: string; transcript?: string[]; whisper?: string[] }) {
  const prompts: string[] = [];
  const prisma = {
    contenu: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'c1') return opts.contenu === undefined ? contenuBase : opts.contenu;
        if (where.id === 'src1') return { contenu: opts.source ?? '' };
        return null;
      }),
    },
    montages: { findFirst: jest.fn(async () => opts.montage ?? null) },
  };
  const claude = {
    messagesCreate: jest.fn(async (p: { messages: Array<{ content: string }> }) => {
      prompts.push(p.messages[0].content);
      return { texte: '« Ta description »' };
    }),
    texte: (r: { texte: string }) => r.texte,
  };
  const marque = {
    chargerMarque: jest.fn(async () => ({ langue: 'es' })),
    langueSortie: () => 'espagnol (Español)',
    contexteMarqueCourt: () => '\n<brand_context>x</brand_context>',
    consigneLangueFinale: () => '\n\nWrite every text in espagnol (Español).',
  };
  const montagePoc = {
    getTranscript: jest.fn(async () => ({ ok: true, words: (opts.transcript || []).map((text) => ({ text })) })),
    transcrireUrl: jest.fn(async () => ({ ok: true, words: (opts.whisper || []).map((text) => ({ text, start: 0, end: 1 })) })),
  };
  const svc = new DescriptionVideoService(prisma as never, claude as never, marque as never, montagePoc as never);
  return { svc, prompts, montagePoc };
}

describe('DescriptionVideoService', () => {
  it('se base sur les sous-titres, les textes à l\'écran et le post d\'origine du montage, sans écouter la vidéo', async () => {
    const { svc, prompts, montagePoc } = monter({
      montage: {
        projet: {},
        projet_rendu: { elements: [
          { type: 'soustitre', texte: 'deuxième phrase', debut: 2 },
          { type: 'soustitre', texte: 'première phrase', debut: 0 },
          { type: 'texte', texte: 'Titre à l\'écran', debut: 1 },
          { type: 'video', debut: 0 },
        ] },
        source_contenu_id: 'src1',
      },
      source: 'Le post source',
    });
    const r = await svc.generer('u1', 'c1');
    expect(r.texte).toBe('Ta description');
    expect(prompts[0]).toContain('première phrase deuxième phrase');
    expect(prompts[0]).toContain("Titre à l'écran");
    expect(prompts[0]).toContain('Le post source');
    expect(prompts[0]).toContain('espagnol');
    expect(prompts[0].trimEnd().endsWith('Write every text in espagnol (Español).')).toBe(true);
    expect(montagePoc.transcrireUrl).not.toHaveBeenCalled();
  });

  it('reprend la transcription du Studio Vidéo', async () => {
    const { svc, prompts } = monter({ contenu: { ...contenuBase, submagic_project_id: 'job1' }, transcript: ['bonjour', 'à', 'tous'] });
    await svc.generer('u1', 'c1');
    expect(prompts[0]).toContain('bonjour à tous');
  });

  it("écoute la vidéo finale en dernier recours (import direct)", async () => {
    const { svc, prompts, montagePoc } = monter({ whisper: ['on', 'parle', 'ici'] });
    await svc.generer('u1', 'c1');
    expect(montagePoc.transcrireUrl).toHaveBeenCalled();
    expect(prompts[0]).toContain('on parle ici');
  });

  it('refuse une vidéo pas encore prête et un contenu inconnu', async () => {
    await expect(monter({ contenu: { ...contenuBase, video_url: null } }).svc.generer('u1', 'c1')).rejects.toThrow('pas_de_video');
    await expect(monter({ contenu: null }).svc.generer('u1', 'c1')).rejects.toThrow('not_found');
  });

  it('signale une vidéo sans parole ni texte ni titre', async () => {
    const { svc } = monter({ contenu: { ...contenuBase, titre: null } });
    await expect(svc.generer('u1', 'c1')).rejects.toThrow('rien_a_decrire');
  });
});
