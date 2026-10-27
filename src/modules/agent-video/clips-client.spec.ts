import { consigneMoments, lireChoix, placerClipsRestants } from './illustrations.util';
import { estVideoBanque, imageAutorisee } from './agent-video.service';

// Vidéos de la banque du client utilisées en plans de coupe par l'agent vidéo.
describe('agent vidéo : vidéos du client en plan de coupe', () => {
  const mots = Array.from({ length: 60 }, (_, k) => ({ text: `mot${k}`, start: k * 0.5, end: k * 0.5 + 0.4 }));
  const clips = [{ url: 'https://res.cloudinary.com/n/video/upload/v1/banque/u1/a.mp4', description: 'cuisine du restaurant' }, { url: 'https://res.cloudinary.com/n/video/upload/v1/banque/u1/b.mp4', description: 'équipe en salle' }];

  it('la consigne liste les vidéos du client ; sans illustrations, rien d’autre que ses vidéos', () => {
    expect(consigneMoments(mots, 'fr', 5, { clips })).toContain('1. cuisine du restaurant');
    const seul = consigneMoments(mots, 'fr', 5, { clips, stock: false });
    expect(seul).toContain('"type":"client"');
    expect(seul).not.toContain('Pexels');
  });

  it('lit les choix « client » : numéro valide, une seule fois chacun, jamais coupés par le plafond', () => {
    const texte = JSON.stringify({ picks: [
      { i: 10, type: 'client', clip: 1, query: 'la cuisine' },
      { i: 25, type: 'client', clip: 1, query: 'encore la cuisine' },
      { i: 35, type: 'client', clip: 7, query: 'clip inconnu' },
      { i: 45, type: 'broll', query: 'office team' },
      { i: 55, type: 'schema', query: '3 étapes' },
    ] });
    // Plafond à 1 : la vidéo du client passe avant le plan Pexels ; la 2e utilisation et le clip 7 sont écartés.
    expect(lireChoix(texte, mots, 1, clips.length)).toEqual([{ i: 10, type: 'client', clip: 1, query: 'la cuisine' }]);
    expect(lireChoix(texte, mots, 5, clips.length).map((x) => `${x.type}:${x.i}`)).toEqual(['client:10', 'broll:45', 'schema:55']);
  });

  it('pose les vidéos oubliées par l’IA sur des moments libres, hors accroche et fin', () => {
    const c = placerClipsRestants([{ i: 20, type: 'broll', query: 'x' }], mots, 2);
    const poses = c.filter((x) => x.type === 'client');
    expect(poses.map((x) => x.clip).sort()).toEqual([1, 2]);
    for (const p of poses) {
      const t = mots[p.i].start;
      expect(t).toBeGreaterThanOrEqual(30 * 0.15 - 1);
      expect(t).toBeLessThanOrEqual(30 * 0.85);
      expect(Math.abs(t - mots[20].start)).toBeGreaterThanOrEqual(4);
    }
  });

  it('accepte les vidéos de SA banque, refuse celles d’un autre compte', () => {
    expect(imageAutorisee('https://res.cloudinary.com/n/video/upload/v1/banque/u1/a.mp4', 'n', 'u1')).toBe(true);
    expect(imageAutorisee('https://res.cloudinary.com/n/video/upload/v1/banque/u2/a.mp4', 'n', 'u1')).toBe(false);
    expect(estVideoBanque('https://res.cloudinary.com/n/video/upload/v1/banque/u1/a.mp4')).toBe(true);
    expect(estVideoBanque('https://res.cloudinary.com/n/image/upload/v1/banque/u1/a.jpg')).toBe(false);
  });
});
