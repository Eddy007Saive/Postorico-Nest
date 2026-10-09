import { argumentsFfmpeg, doitTranscoder, formatDuree, lireSonde, SondeVideo, TranscodageService, VideoTropLongue } from './transcodage.service';

const sonde = (o: Partial<SondeVideo> = {}): SondeVideo => ({ codec: 'h264', largeur: 720, hauteur: 1280, duree: 12, debitKbps: 3000, conteneur: 'mov,mp4,m4a,3gp,3g2,mj2', ...o });

describe('transcodage : décision', () => {
  it('garde une vidéo déjà propre (H.264, MP4, 720p, débit raisonnable)', () => {
    expect(doitTranscoder(sonde(), 1280)).toEqual({ oui: false, raison: 'déjà propre' });
  });

  it('convertit le HEVC des iPhone, le webm, le trop grand et le trop lourd', () => {
    expect(doitTranscoder(sonde({ codec: 'hevc' }), 1280).oui).toBe(true);
    expect(doitTranscoder(sonde({ conteneur: 'matroska,webm', codec: 'vp9' }), 1280).oui).toBe(true);
    expect(doitTranscoder(sonde({ largeur: 1080, hauteur: 1920 }), 1280)).toMatchObject({ oui: true, raison: '1080x1920 > 1280' });
    expect(doitTranscoder(sonde({ largeur: 1080, hauteur: 1920 }), 1920).oui).toBe(false);
    expect(doitTranscoder(sonde({ debitKbps: 18000 }), 1280).oui).toBe(true);
  });

  it('arguments : H.264 + AAC, faststart, plus grand côté borné, dimensions paires', () => {
    const a = argumentsFfmpeg('in', 'out.mp4', 1280, 23);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', '-map', '0:a:0?']));
    expect(a[a.indexOf('-vf') + 1]).toBe("scale='if(gte(iw,ih),trunc(min(1280\\,iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(1280\\,ih)/2)*2)'");
    expect(a[a.length - 1]).toBe('out.mp4');
  });

  it('lit la sonde ffprobe (débit du flux, sinon du conteneur)', () => {
    const json = JSON.stringify({ streams: [{ codec_name: 'hevc', width: 1920, height: 1080, bit_rate: 'N/A' }], format: { duration: '14.5', bit_rate: '16000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } });
    expect(lireSonde(json)).toEqual({ codec: 'hevc', largeur: 1920, hauteur: 1080, duree: 14.5, debitKbps: 16000, conteneur: 'mov,mp4,m4a,3gp,3g2,mj2' });
  });
});

describe('durée maximale', () => {
  it('formatDuree : minutes et secondes lisibles', () => {
    expect(formatDuree(300)).toBe('5 min');
    expect(formatDuree(432)).toBe('7 min 12 s');
    expect(formatDuree(45)).toBe('45 s');
  });

  it('VideoTropLongue : message prêt à afficher', () => {
    expect(new VideoTropLongue(432, 300).message).toBe('Vidéo trop longue : 7 min 12 s (5 min maximum).');
  });
});

describe('TranscodageService', () => {
  it("ne fait jamais échouer l'import : sans ffmpeg, l'original repart tel quel", async () => {
    const service = new TranscodageService({ get: () => 2 } as never);
    (service as unknown as { ffmpegAbsent: boolean }).ffmpegAbsent = true;
    const data = Buffer.from('video');
    const r = await service.preparer(data, { coteMax: 1280 });
    expect(r).toMatchObject({ transcode: false, raison: 'ffmpeg absent' });
    expect(r.data).toBe(data);
  });
});
