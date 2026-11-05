import { TachesMcp } from './taches-mcp';

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TachesMcp', () => {
  it('une tâche rapide répond directement', async () => {
    const t = new TachesMcp();
    await expect(t.lancer('a', 'outil', Promise.resolve(42), 50)).resolves.toEqual({ fini: true, resultat: 42 });
  });

  it('une tâche lente répond « en cours » puis donne son résultat', async () => {
    const t = new TachesMcp();
    const issue = await t.lancer('a', 'outil', attendre(80).then(() => 'fait'), 20);
    expect(issue.fini).toBe(false);
    const id = (issue as { tacheId: string }).tacheId;
    expect(t.etat('a', id)?.statut).toBe('en_cours');
    await attendre(100);
    expect(t.etat('a', id)).toMatchObject({ statut: 'terminee', resultat: 'fait' });
  });

  it("l'échec d'une tâche lente est gardé, sans rejet non traité", async () => {
    const nonTraites: unknown[] = [];
    const ecoute = (e: unknown) => nonTraites.push(e);
    process.on('unhandledRejection', ecoute);
    const t = new TachesMcp();
    const issue = await t.lancer('a', 'outil', attendre(40).then(() => { throw new Error('boum'); }), 10);
    await attendre(80);
    process.off('unhandledRejection', ecoute);
    expect(t.etat('a', (issue as { tacheId: string }).tacheId)).toMatchObject({ statut: 'echec', erreur: 'boum' });
    expect(nonTraites).toEqual([]);
  });

  it("un autre client ne voit pas la tâche", async () => {
    const t = new TachesMcp();
    const issue = await t.lancer('a', 'outil', attendre(50), 10);
    expect(t.etat('b', (issue as { tacheId: string }).tacheId)).toBeNull();
  });
});
