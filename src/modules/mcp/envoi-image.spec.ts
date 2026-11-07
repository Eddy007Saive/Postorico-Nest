import { adresseServeur, lireEnvoi, signerEnvoi, typeImage } from './envoi-image';

const A = { cle: 'cle-1', compte: 'compte-1', contenu: 'contenu-1', position: 2, expire: Date.now() + 60_000 };

describe('envoi direct d’une image dans un post', () => {
  it('autorisation signée : relue telle quelle', () => {
    expect(lireEnvoi('s', signerEnvoi('s', A))).toEqual(A);
  });

  it('refusée si modifiée, signée avec un autre secret ou expirée', () => {
    const jeton = signerEnvoi('s', A);
    const [charge, sig] = jeton.split('.');
    const autre = Buffer.from(JSON.stringify(['cle-1', 'compte-2', 'contenu-1', 2, A.expire])).toString('base64url');
    expect(lireEnvoi('s', `${autre}.${sig}`)).toHaveProperty('refus');
    expect(lireEnvoi('autre', jeton)).toHaveProperty('refus');
    expect(lireEnvoi('s', `${charge}.`)).toHaveProperty('refus');
    const expiree = lireEnvoi('s', signerEnvoi('s', { ...A, expire: Date.now() - 1 }));
    expect(expiree).toEqual({ refus: expect.stringContaining('expirée') });
  });

  it('type réel du fichier, pas son nom', () => {
    expect(typeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(typeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(typeImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(typeImage(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(typeImage(Buffer.from('GIF89a'))).toBeNull();
  });

  it('adresse publique derrière le proxy', () => {
    expect(adresseServeur({ 'x-forwarded-proto': 'https', host: 'api.exemple.fr' }, 'http')).toBe('https://api.exemple.fr');
    expect(adresseServeur({ host: 'localhost:8000' }, 'http')).toBe('http://localhost:8000');
  });
});
