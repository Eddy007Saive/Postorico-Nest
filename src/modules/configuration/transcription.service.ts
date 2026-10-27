import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Formats que le navigateur enregistre (MediaRecorder) : webm/opus (Chrome, Firefox), mp4/aac (Safari). */
const FORMATS_AUDIO: Record<string, string> = {
  'audio/webm': 'video/webm',
  'video/webm': 'video/webm',
  'audio/mp4': 'video/mp4',
  'video/mp4': 'video/mp4',
  'audio/x-m4a': 'video/mp4',
  'audio/ogg': 'audio/ogg',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
};
export const AUDIO_MAX_OCTETS = 12 * 1024 * 1024; // environ 10 min de voix en opus

/**
 * Réponse dictée au micro dans le formulaire de configuration : transcrite mot pour mot
 * (Gemini via OpenRouter, qui lit directement l'enregistrement du navigateur). La façon de
 * parler est gardée telle quelle : c'est elle qui sert ensuite d'exemple de ton à l'IA.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly cle: string;
  private readonly modele: string;

  constructor(config: ConfigService) {
    this.cle = config.get<string>('app.openrouterApiKey') || '';
    this.modele = config.get<string>('app.openrouterVideoModel') || 'google/gemini-3.8-flash';
  }

  get actif(): boolean {
    return Boolean(this.cle);
  }

  /** Le type MIME envoyé à Gemini pour ce fichier, ou null s'il n'est pas un enregistrement audio connu. */
  static typeAccepte(mime: string | undefined): string | null {
    const base = String(mime || '').split(';')[0].trim().toLowerCase();
    return FORMATS_AUDIO[base] ?? null;
  }

  async transcrire(audio: Buffer, mime: string, langue = 'fr'): Promise<string> {
    const type = TranscriptionService.typeAccepte(mime);
    if (!type) throw new Error('format_audio');
    const langueNom = { fr: 'French', en: 'English', es: 'Spanish' }[langue] || 'the language spoken';
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cle}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: this.modele,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Transcribe this voice recording word for word (it is most likely in ${langueNom}). Keep the speaker's own words, ` +
                  'expressions and turns of phrase exactly; only remove hesitations (euh, hum) and false starts, and add punctuation. ' +
                  'Return only the transcription, no comment. If nothing is said, return an empty string.',
              },
              { type: 'video_url', video_url: { url: `data:${type};base64,${audio.toString('base64')}` } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      this.logger.error(`transcription ${resp.status}: ${corps.slice(0, 200)}`);
      throw new Error('transcription_indisponible');
    }
    const d = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return String(d.choices?.[0]?.message?.content || '')
      .replace(/^["«\s]+|["»\s]+$/g, '')
      .trim();
  }
}
