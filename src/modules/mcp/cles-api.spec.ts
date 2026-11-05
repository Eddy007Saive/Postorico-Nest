import { cleToujoursValide } from './cles-api.service';

describe('cleToujoursValide', () => {
  it('reste valide tant que le mot de passe ne change pas', () => {
    expect(cleToujoursValide({ empreinte: 'abc' }, 'abc')).toBe(true);
  });

  it('est révoquée dès que le mot de passe change', () => {
    expect(cleToujoursValide({ empreinte: 'abc' }, 'def')).toBe(false);
  });

  it("une clé créée avant l'empreinte reste valable", () => {
    expect(cleToujoursValide({ empreinte: null }, 'def')).toBe(true);
  });
});
