import { lireDirection } from './visuel-auto.util';
import { vignette } from './image.service';

describe('lireDirection', () => {
  it('lit un JSON entouré de texte et de clôture', () => {
    const d = lireDirection(
      'Voici :\n```json\n{"gabarit": 2, "inspirations": [1, 3], "commande": "Quiche lorraine, texte « QUICHE »"}\n```',
      4,
      5,
    );
    expect(d).toEqual({
      gabarit: 2,
      inspirations: [1, 3],
      commande: 'Quiche lorraine, texte « QUICHE »',
    });
  });

  it('écarte les numéros hors limites et les doublons', () => {
    const d = lireDirection(
      '{"gabarit": 9, "inspirations": [0, 2, 2, 7, "1"], "commande": "x"}',
      4,
      3,
    );
    expect(d).toEqual({ gabarit: 0, inspirations: [2, 1], commande: 'x' });
  });

  it('garde au plus 3 inspirations', () => {
    expect(
      lireDirection(
        '{"gabarit": 1, "inspirations": [1,2,3,4], "commande": "x"}',
        1,
        4,
      )?.inspirations,
    ).toEqual([1, 2, 3]);
  });

  it('refuse une réponse sans commande ou illisible', () => {
    expect(lireDirection('{"gabarit": 1, "commande": "  "}', 2, 0)).toBeNull();
    expect(lireDirection('pas de json', 2, 0)).toBeNull();
    expect(lireDirection('{gabarit: 1}', 2, 0)).toBeNull();
  });
});

describe('vignette', () => {
  it('réduit une image Cloudinary', () => {
    expect(
      vignette('https://res.cloudinary.com/x/image/upload/v1/a/b.png', 512),
    ).toBe(
      'https://res.cloudinary.com/x/image/upload/w_512,c_limit,q_auto,f_jpg/v1/a/b.png',
    );
    expect(
      vignette(
        'https://res.cloudinary.com/x/image/upload/v1/a/b.png',
        1024,
        'png',
      ),
    ).toContain('f_png');
  });

  it('laisse passer les autres URLs', () => {
    expect(vignette('https://exemple.fr/a.png', 512)).toBe(
      'https://exemple.fr/a.png',
    );
  });
});
