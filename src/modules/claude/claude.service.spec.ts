import { ClaudeService, GenerationError } from './claude.service';

// `essais: 1` : appel public dont on borne le coût (analyse de site de l'onboarding) —
// une surcharge 529 ne doit PAS déclencher de nouvel essai payant.
describe('ClaudeService.messagesCreate — nombre d’essais', () => {
  function service(create: jest.Mock) {
    const s = new ClaudeService({ get: () => 'cle-factice' } as never);
    (s as unknown as { client: unknown }).client = { messages: { create } };
    return s;
  }
  const params = { model: 'claude-haiku-4-5', max_tokens: 10, messages: [{ role: 'user' as const, content: 'x' }] };

  it('essais: 1 → un seul appel, même sur une erreur réessayable', async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    await expect(service(create).messagesCreate(params, { essais: 1 })).rejects.toBeInstanceOf(GenerationError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('par défaut, réessaie une erreur réessayable', async () => {
    jest.useFakeTimers();
    const ok = { content: [] };
    const create = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      .mockResolvedValueOnce(ok);
    const p = service(create).messagesCreate(params);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(ok);
    expect(create).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
