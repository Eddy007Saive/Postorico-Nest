import { coutAnthropic } from './usage.service';

// Tarifs officiels (platform.claude.com/docs/en/about-claude/pricing, novembre 2026)
describe('coutAnthropic', () => {
  it('Sonnet 4.6 : 3 $ en entrée, 15 $ en sortie par million', () => {
    expect(coutAnthropic('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(18, 6);
  });

  it('Haiku 4.5 : 1 $ / 5 $ ; Opus 5 : 5 $ / 25 $', () => {
    expect(coutAnthropic('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(6, 6);
    expect(coutAnthropic('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(30, 6);
  });

  it('cache : écriture 5 min 1,25 x, 1 h 2 x, lecture 0,1 x', () => {
    const u = { cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 }, cache_read_input_tokens: 1_000_000 };
    expect(coutAnthropic('claude-sonnet-4-6', u)).toBeCloseTo(3 * 1.25 + 3 * 2 + 3 * 0.1, 6);
    // Sans le détail, l'écriture globale compte au tarif 5 min
    expect(coutAnthropic('claude-sonnet-4-6', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(3.75, 6);
  });

  it('recherche web : 10 $ les 1 000', () => {
    expect(coutAnthropic('claude-sonnet-4-6', { server_tool_use: { web_search_requests: 3 } })).toBeCloseTo(0.03, 6);
  });
});
