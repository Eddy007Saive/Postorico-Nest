import { ConfigService } from '@nestjs/config';
import { NewsletterService } from './newsletter.service';

// Ne couvre que la logique indépendante de la base (mêmes principes que
// auth.service.spec.ts) : filtrage des mots-clés, suppression des tirets, garde-fous
// anti-invention, rendu HTML. Les parcours avec Prisma/Claude (préparation, envoi réel)
// attendent une base de test dédiée.
describe('NewsletterService (logique pure)', () => {
  let service: NewsletterService;

  beforeEach(() => {
    const configStub = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'app.backendUrl': 'https://api.postorico.com',
          'app.frontendUrl': 'https://postorico.com',
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    service = new NewsletterService(configStub, {} as never, {} as never, {} as never);
  });

  describe('motsCles (privé)', () => {
    const motsCles = (texte: string): string[] => (service as never as { motsCles: (t: string) => string[] }).motsCles(texte);

    it('ne garde que les mots de 5 lettres et plus', () => {
      expect(motsCles('Un nouveau format de Reel sur TikTok')).toEqual(
        expect.arrayContaining(['nouveau', 'format', 'tiktok']),
      );
      expect(motsCles('Un nouveau format')).not.toContain('un');
    });

    it('exclut les mots-outils même longs', () => {
      const mots = motsCles('cette votre notre chaque encore nouveaute');
      expect(mots).not.toEqual(expect.arrayContaining(['cette', 'votre', 'notre', 'chaque', 'encore']));
      expect(mots).toContain('nouveaute');
    });

    it('met en minuscule avant extraction', () => {
      expect(motsCles('INSTAGRAM Reels')).toEqual(expect.arrayContaining(['instagram', 'reels']));
    });
  });

  describe('sansTirets (privé)', () => {
    const sansTirets = <T,>(v: T): T => (service as never as { sansTirets: <U>(x: U) => U }).sansTirets(v);

    it('remplace un tiret cadratin par une virgule', () => {
      expect(sansTirets('LinkedIn a changé son algorithme — les vidéos courtes progressent')).toBe(
        'LinkedIn a changé son algorithme, les vidéos courtes progressent',
      );
    });

    it('remplace un demi-cadratin', () => {
      expect(sansTirets('Une nouveauté – disponible cette semaine')).toBe('Une nouveauté, disponible cette semaine');
    });

    it('ne touche pas au trait d\'union des mots composés', () => {
      expect(sansTirets('un compte multi-utilisateur')).toBe('un compte multi-utilisateur');
    });

    it('descend récursivement dans les tableaux et objets', () => {
      const data = { sections: [{ titre: 'A — B', corps: 'texte normal' }] };
      expect(sansTirets(data)).toEqual({ sections: [{ titre: 'A, B', corps: 'texte normal' }] });
    });
  });

  describe('sourceParTitre (privé)', () => {
    const sourceParTitre = (
      actu: { reseau: string; titre: string; resume: string; source: string },
      sources: Array<{ url: string; titre?: string }>,
    ): string =>
      (
        service as never as {
          sourceParTitre: (a: typeof actu, s: typeof sources) => string;
        }
      ).sourceParTitre(actu, sources);

    it('trouve la source dont le titre partage au moins deux mots avec l\'actu', () => {
      const actu = { reseau: 'LinkedIn', titre: 'Nouveau format carrousel', resume: '', source: '' };
      const sources = [
        { url: 'https://a.com/1', titre: 'LinkedIn lance un nouveau format carrousel' },
        { url: 'https://b.com/2', titre: 'Actualité sans rapport' },
      ];
      expect(sourceParTitre(actu, sources)).toBe('https://a.com/1');
    });

    it('renvoie une chaîne vide si rien ne colle vraiment (score < 2)', () => {
      const actu = { reseau: 'TikTok', titre: 'Nouveau format', resume: '', source: '' };
      const sources = [{ url: 'https://a.com/1', titre: 'Article sans rapport' }];
      expect(sourceParTitre(actu, sources)).toBe('');
    });
  });

  describe('verifierLettre (privé)', () => {
    const verifierLettre = (
      data: { actus: Array<{ reseau: string; titre: string; resume: string; source: string }> },
      veille: { texte: string; sources: Array<{ url: string; titre?: string }> },
    ) =>
      (
        service as never as {
          verifierLettre: (d: typeof data, v: typeof veille) => typeof data;
        }
      ).verifierLettre(data, veille);

    it('garde une actu dont les mots apparaissent dans la veille, avec sa source recopiée', () => {
      const veille = {
        texte: 'LinkedIn lance un nouveau format de carrousel cette semaine (https://linkedin.com/news/123).',
        sources: [{ url: 'https://linkedin.com/news/123', titre: 'LinkedIn carrousel' }],
      };
      const data = {
        actus: [
          {
            reseau: 'LinkedIn',
            titre: 'Nouveau format carrousel',
            resume: 'LinkedIn lance un nouveau format de carrousel.',
            source: 'https://linkedin.com/news/123',
          },
          {
            reseau: 'TikTok',
            titre: 'Nouveau format carrousel',
            resume: 'LinkedIn lance un nouveau format de carrousel.',
            source: 'https://linkedin.com/news/123',
          },
        ],
      };
      const res = verifierLettre(data, veille);
      expect(res.actus).toHaveLength(2);
      expect(res.actus[0].source).toBe('https://linkedin.com/news/123');
    });

    it('retire une actu que la veille ne mentionne pas du tout', () => {
      const veille = { texte: 'Rien à signaler cette semaine sur les réseaux sociaux.', sources: [] };
      const data = {
        actus: [
          { reseau: 'YouTube', titre: 'Invention totalement hors sujet', resume: 'Ceci est inventé de toutes pièces.', source: '' },
        ],
      };
      // Une seule actu inventée : moins de 2 restent -> tableau vidé (garde-fou "au moins 2").
      expect(verifierLettre(data, veille).actus).toEqual([]);
    });

    it('vide une source inventée (absente de la veille) plutôt que de la garder telle quelle', () => {
      const veille = {
        texte: 'YouTube annonce un nouveau format Shorts vertical cette semaine.',
        sources: [{ url: 'https://youtube.com/blog/officiel', titre: 'YouTube Shorts' }],
      };
      const data = {
        actus: [
          { reseau: 'YouTube', titre: 'Nouveau format Shorts vertical', resume: 'YouTube annonce un nouveau format Shorts.', source: 'https://invente.example.com/faux' },
          { reseau: 'YouTube', titre: 'Nouveau format Shorts vertical bis', resume: 'YouTube annonce un nouveau format Shorts vertical.', source: '' },
        ],
      };
      const res = verifierLettre(data, veille);
      for (const a of res.actus) expect(a.source).not.toBe('https://invente.example.com/faux');
    });
  });

  describe('renduHtml (public)', () => {
    it('rend le sujet, le titre et une actu avec lien source', () => {
      const html = service.renduHtml({
        sujet: 'Objet de test',
        preheader: 'Preheader',
        titre: 'Titre de la lettre',
        edito: "L'édito de Rico",
        sections: [{ titre: 'Section 1', corps: 'Corps', astuce: 'Astuce' }],
        actus: [{ reseau: 'LinkedIn', titre: 'Actu 1', resume: 'Résumé', source: 'https://exemple.com/a' }],
        action: 'Fais ceci cette semaine',
        signature: 'Rico',
        numero: 5,
        date: '1 janvier 2026',
      });
      expect(html).toContain('Objet de test');
      expect(html).toContain("L'édito de Rico");
      expect(html).toContain('Fais ceci cette semaine');
      expect(html).toContain('https://exemple.com/a');
      expect(html).toContain('N°5');
    });

    it("n'affiche pas de lien source quand l'actu n'en a pas", () => {
      const html = service.renduHtml({
        sujet: 'S', preheader: 'P', titre: 'T', edito: 'E', sections: [],
        actus: [{ reseau: 'X', titre: 'Actu', resume: 'R', source: '' }],
        action: 'A', signature: 'Rico',
      });
      expect(html).not.toContain('Lire la source');
    });

    it('affiche le lien "Lire dans le navigateur" seulement si un aperçu est fourni', () => {
      const data = { sujet: 'S', preheader: 'P', titre: 'T', edito: 'E', sections: [], actus: [], action: 'A', signature: 'Rico' };
      expect(service.renduHtml(data)).not.toContain('Lire dans le navigateur');
      expect(service.renduHtml(data, '#', 'https://api.postorico.com/apercu/1')).toContain('Lire dans le navigateur');
    });
  });

  describe('page (public)', () => {
    it('affiche le titre et le message fournis', () => {
      const html = service.page('Titre', 'Message de test');
      expect(html).toContain('Titre');
      expect(html).toContain('Message de test');
      expect(html).toContain('https://postorico.com'); // lien retour (frontendUrl)
    });
  });
});