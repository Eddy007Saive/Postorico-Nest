import { ImageRefusee, ipInterne, telechargerImage } from './image-distante';

describe('ipInterne', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1'])(
    '%s est interne',
    (ip) => expect(ipInterne(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '151.101.1.140', '2606:4700::6810:84e5'])('%s est publique', (ip) => expect(ipInterne(ip)).toBe(false));
});

describe('telechargerImage', () => {
  it.each([
    ['http://example.com/a.png', 'https'],
    ['https://127.0.0.1/a.png', 'refusée'],
    ['https://169.254.169.254/latest/meta-data', 'refusée'],
    ['https://user:mdp@example.com/a.png', 'refusée'],
    ['pas une adresse', 'invalide'],
  ])('%s est refusée', async (url, motif) => {
    await expect(telechargerImage(url)).rejects.toThrow(ImageRefusee);
    await expect(telechargerImage(url)).rejects.toThrow(motif);
  });
});
