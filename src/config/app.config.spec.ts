// Scan Strix du 2026-09-28 : app.config.ts retombait silencieusement sur une valeur de
// secret JWT connue ('your-secret-key-change-in-production') quand JWT_SECRET était
// absent — un attaquant connaissant cette chaîne aurait pu forger n'importe quel JWT, y
// compris admin. Ces tests verrouillent le fail-fast au démarrage.
describe('appConfig — JWT_SECRET obligatoire', () => {
  const ORIGINAL_ENV = process.env.JWT_SECRET;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_ENV;
    jest.resetModules();
  });

  function loadFactory(): () => Record<string, unknown> {
    let factory!: () => Record<string, unknown>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      factory = require('./app.config').default;
    });
    return factory;
  }

  it("plante si JWT_SECRET est absent", () => {
    delete process.env.JWT_SECRET;
    const factory = loadFactory();
    expect(() => factory()).toThrow(/JWT_SECRET/);
  });

  it('plante si JWT_SECRET vaut la valeur par défaut interdite', () => {
    process.env.JWT_SECRET = 'your-secret-key-change-in-production';
    const factory = loadFactory();
    expect(() => factory()).toThrow(/JWT_SECRET/);
  });

  it('démarre normalement avec un vrai secret', () => {
    process.env.JWT_SECRET = 'un-secret-suffisamment-long-et-aleatoire';
    const factory = loadFactory();
    expect(factory().jwtSecret).toBe('un-secret-suffisamment-long-et-aleatoire');
  });
});
