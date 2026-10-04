import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PexelsService } from '../pexels.service';
import { EXCLUSIFS, TEMPLATES } from './build-html';
import { STYLES_PARTAGES, stylePartage } from './style-partage.util';

describe('styles du générateur partagé', () => {
  it('le générateur est identique à celui du frontend (quand le dépôt du frontend est à côté)', () => {
    const front = join(process.cwd(), '..', 'frontend', 'src', 'lib', 'stylesCarrousel.js');
    if (!existsSync(front)) return;
    const nest = readFileSync(join(process.cwd(), 'assets', 'carrousel', 'styles_carrousel.js'), 'utf-8');
    expect(nest).toBe(readFileSync(front, 'utf-8'));
  });

  it('les styles sont proposés à tous', () => {
    for (const t of STYLES_PARTAGES) {
      expect(TEMPLATES).toContain(t);
      expect(EXCLUSIFS.has(t)).toBe(false);
    }
  });

  it('le contenu ne peut pas fermer la balise script', () => {
    const html = stylePartage('kraft', { hook: 'x </script><img src=x onerror=alert(1)>', slides: [], cta: {} } as any, '#000', '#111', '#222', 'M', '', null);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain('<\\/script>');
  });

  it('mêmes photos pour un même carrousel, autres photos pour un autre', async () => {
    const pexels = new PexelsService({ get: () => 'cle' } as unknown as ConfigService);
    const urls = Array.from({ length: 20 }, (_, i) => `https://images.pexels.com/${i}.jpg`);
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ photos: urls.map((u) => ({ src: { portrait: u } })) }) } as Response);
    const a = await pexels.photos('Coaching', 'contenu1');
    expect(a).toHaveLength(5);
    expect(new Set(a).size).toBe(5);
    expect(await pexels.photos('Coaching', 'contenu1')).toEqual(a);
    expect(await pexels.photos('Coaching', 'contenu2')).not.toEqual(a);
  });
});
