import { erreurDeCompte } from './erreur-compte.util';

describe('erreurDeCompte', () => {
  it('reconnaît des crédits épuisés (Anthropic, OpenRouter)', () => {
    expect(
      erreurDeCompte(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
    ).toBe('credits');
    expect(erreurDeCompte(402, '{"error":{"message":"Insufficient credits"}}')).toBe('credits');
  });

  it('reconnaît une clé refusée', () => {
    expect(erreurDeCompte(401, '{"type":"authentication_error","message":"invalid x-api-key"}')).toBe('cle');
  });

  it('ignore une surcharge ou une erreur passagère', () => {
    expect(erreurDeCompte(529, 'Overloaded')).toBeNull();
    expect(erreurDeCompte(429, 'rate limit')).toBeNull();
    expect(erreurDeCompte(undefined, 'socket hang up')).toBeNull();
  });
});
