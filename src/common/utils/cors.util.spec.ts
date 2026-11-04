import { origineAcceptee, originesAutorisees } from './cors.util';

describe('CORS', () => {
  const liste = originesAutorisees(
    'https://dev.exemple.vercel.app/, https://admin.postorico.com',
    'https://postorico.com/',
  );

  it('accepte les sites listés, FRONTEND_URL avec et sans www, et l’appli mobile', () => {
    for (const o of [
      'https://dev.exemple.vercel.app',
      'https://admin.postorico.com',
      'https://postorico.com',
      'https://www.postorico.com',
      'https://localhost',
      'capacitor://localhost',
      'http://localhost:3000',
    ]) {
      expect(origineAcceptee(o, liste)).toBe(true);
    }
  });

  it('accepte toujours le site de production, même absent de CORS_ORIGINS', () => {
    const dev = originesAutorisees('https://dev.exemple.vercel.app', 'https://dev.exemple.vercel.app');
    expect(origineAcceptee('https://postorico.com', dev)).toBe(true);
    expect(origineAcceptee('https://www.postorico.com', dev)).toBe(true);
  });

  it('refuse un site tiers', () => {
    expect(origineAcceptee('https://pirate.exemple', liste)).toBe(false);
    expect(origineAcceptee('https://postorico.com.pirate.exemple', liste)).toBe(
      false,
    );
  });

  it('laisse passer les appels serveur à serveur (sans Origin)', () => {
    expect(origineAcceptee(undefined, liste)).toBe(true);
  });

  it('reste ouverte quand CORS_ORIGINS est vide', () => {
    const vide = originesAutorisees('', 'https://postorico.com');
    expect(vide.size).toBe(0);
    expect(origineAcceptee('https://pirate.exemple', vide)).toBe(true);
  });
});
