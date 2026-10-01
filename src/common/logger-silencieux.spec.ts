import { ConsoleLogger } from '@nestjs/common';
import { LoggerSilencieux } from './logger-silencieux';

describe('LoggerSilencieux', () => {
  let sortie: jest.SpyInstance;
  beforeEach(() => {
    sortie = jest.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => sortie.mockRestore());

  it('tait les lignes de câblage du démarrage', () => {
    const l = new LoggerSilencieux('Nest');
    l.log('Mapped {/api/users/me, GET} route', 'RouterExplorer');
    l.log('UsersController {/api/users}:', 'RoutesResolver');
    l.log('UsersModule dependencies initialized', 'InstanceLoader');
    expect(sortie).not.toHaveBeenCalled();
  });

  it('laisse passer nos propres logs et le démarrage effectif', () => {
    const l = new LoggerSilencieux('Nest');
    l.log('impayés cron: {"comptes":0}', 'ImpayeService');
    l.log('Nest application successfully started', 'NestApplication');
    l.log('sans contexte');
    expect(sortie).toHaveBeenCalledTimes(3);
  });

  it('ne filtre jamais error/warn', () => {
    const err = jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => undefined);
    const l = new LoggerSilencieux('Nest');
    l.error('boom', undefined, 'InstanceLoader');
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
