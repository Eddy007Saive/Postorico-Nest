import { v2 as cloudinary } from 'cloudinary';
import { envoyerGrosFichier } from './cloudinary-envoi.util';

describe('envoyerGrosFichier', () => {
  afterEach(() => jest.restoreAllMocks());

  it("attend la réponse finale du callback (pas le flux renvoyé d'office)", async () => {
    const spy = jest.spyOn(cloudinary.uploader, 'upload_large').mockImplementation(((_chemin: string, _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
      setTimeout(() => cb(undefined, { secure_url: 'https://res.cloudinary.com/x/video/upload/v1/a.mp4', duration: 5 }), 10);
      return {} as never; // le SDK rend un flux : il ne doit pas servir de résultat
    }) as never);
    const r = await envoyerGrosFichier('/tmp/a.mp4', { resource_type: 'video' });
    expect(r.duration).toBe(5);
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ chunk_size: 20 * 1024 * 1024, timeout: 600_000, resource_type: 'video' }));
  });

  it("rejette l'erreur de Cloudinary", async () => {
    jest.spyOn(cloudinary.uploader, 'upload_large').mockImplementation(((_c: string, _o: unknown, cb: (e: unknown) => void) => {
      cb({ message: 'All parts except EOF-chunk must be larger than 5mb', http_code: 400 });
      return {} as never;
    }) as never);
    await expect(envoyerGrosFichier('/tmp/a.mp4', {})).rejects.toEqual(expect.objectContaining({ http_code: 400 }));
  });
});
