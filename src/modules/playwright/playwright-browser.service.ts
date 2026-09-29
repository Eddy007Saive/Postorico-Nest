import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';

/**
 * Lancement Chromium partagé par tous les rendus HTML→PNG (carrousels, gabarits, plus
 * tard stories/miniatures). Même repli que côté Python (`_launch` dans
 * carrousel_service.py / gabarit_service.py) : args sandbox-safe, puis `channel:
 * "chromium"` si le lancement direct échoue.
 */
@Injectable()
export class PlaywrightBrowserService {
  private readonly executablePath: string;

  constructor(config: ConfigService) {
    // Optionnel, dev uniquement : voir app.config.ts::chromiumExecutablePath.
    this.executablePath = config.get<string>('app.chromiumExecutablePath') || '';
  }

  async launch(): Promise<Browser> {
    const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    if (this.executablePath) {
      return chromium.launch({ executablePath: this.executablePath, args });
    }
    try {
      return await chromium.launch({ args });
    } catch {
      return chromium.launch({ channel: 'chromium', args });
    }
  }
}
