import { normaliserCarrouselData } from './carrousel-data.util';
import { CarrouselContent } from './interfaces/carrousel-content.interface';

// Retouche du texte des slides par le client (2026-10-01) — port de
// agent_service.normaliser_carrousel_data et de ses tests.
const ANCIEN: CarrouselContent = {
  hook: 'Accroche',
  legende: 'Légende',
  slides: [
    { titre: 'Un', texte: 'a', pills: [], pro_tip: '', icon: 'rocket' },
    { titre: 'Deux', texte: 'b', pills: ['x'], pro_tip: '', icon: '' },
  ],
  cta: { titre: 'On en parle ?', texte: '' },
};

describe('normaliserCarrouselData', () => {
  it('retouche le texte, nettoie le Markdown et garde l\'icône d\'origine', () => {
    const out = normaliserCarrouselData(
      {
        hook: '**Nouvelle** accroche',
        legende: 'Légende',
        slides: [{ titre: 'Un bis', texte: 'a — b', pills: 'p1, p2', icon: 'inconnue' }, { titre: 'Deux', texte: 'b' }],
        cta: { titre: 'Écris-moi', texte: 'en DM' },
      },
      ANCIEN,
    );
    expect(out.hook).toBe('Nouvelle accroche');
    expect(out.slides[0]).toEqual({ titre: 'Un bis', texte: 'a, b', pills: ['p1', 'p2'], pro_tip: '', icon: 'rocket', chiffre: '' });
    expect(out.slides[1].icon).toBe('');
    expect(out.cta).toEqual({ titre: 'Écris-moi', texte: 'en DM' });
  });

  it('borne les longueurs et reprend l\'accroche d\'origine si absente', () => {
    const long = 'x'.repeat(500);
    const out = normaliserCarrouselData({ slides: [{ titre: long, texte: long, pills: Array(9).fill('a') }] }, ANCIEN);
    expect(out.slides[0].titre).toHaveLength(90);
    expect(out.slides[0].texte).toHaveLength(400);
    expect(out.slides[0].pills).toHaveLength(4);
    expect(out.hook).toBe('Accroche');
  });

  it('rend l\'ancien contenu tel quel si la retouche est vide ou inexploitable', () => {
    expect(normaliserCarrouselData({ slides: [] }, ANCIEN)).toBe(ANCIEN);
    expect(normaliserCarrouselData("n'importe quoi", ANCIEN)).toBe(ANCIEN);
    expect(normaliserCarrouselData(null, ANCIEN)).toBe(ANCIEN);
  });
});
