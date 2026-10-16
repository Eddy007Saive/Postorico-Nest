import { argumentsVoix, chaineVoix } from './voix-nette.util';

describe('améliorer la voix', () => {
  it('dose la chaîne selon le curseur', () => {
    expect(chaineVoix(0)).toBe('highpass=f=80,afftdn=nr=6:nf=-25,acompressor=threshold=-18dB:ratio=2:attack=5:release=80,loudnorm=I=-14:TP=-1.5:LRA=11');
    const fort = chaineVoix(100, false);
    expect(fort).toContain('afftdn=nr=24');
    expect(fort).toContain('deesser');
    expect(fort).toContain('ratio=4');
    expect(fort.endsWith('alimiter=limit=0.95')).toBe(true);
  });

  it('borne les valeurs absurdes', () => {
    expect(chaineVoix(500)).toBe(chaineVoix(100));
    expect(chaineVoix('abc')).toBe(chaineVoix(0));
  });

  it("recopie l'image d'une vidéo sans la réencoder", () => {
    const a = argumentsVoix('in', 'out.mp4', true, 60, true);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'copy', '-map', '0:a:0']));
    expect(argumentsVoix('in', 'out.m4a', false, 60, true)).toContain('-vn');
  });
});
