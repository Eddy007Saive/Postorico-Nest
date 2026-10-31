import {
  bornerParHeure,
  envoisParPassage,
  lireRedactions,
  nettoyerContacts,
  plafondJour,
  texteMessage,
} from './campagnes-email.util';

describe('campagnes email — règles', () => {
  it('garde les adresses valides, sans doublon, en minuscules', () => {
    const { gardes, ecartes } = nettoyerContacts(
      [
        { email: ' Jean@Exemple.fr ', prenom: ' Jean ' },
        { email: 'jean@exemple.fr' },
        { email: 'pas-une-adresse' },
        { email: 'deja@exemple.fr' },
        { email: 'marie@societe.com', entreprise: 'Société' },
      ],
      ['DEJA@exemple.fr'],
    );
    expect(gardes.map((g) => g.email)).toEqual([
      'jean@exemple.fr',
      'marie@societe.com',
    ]);
    expect(gardes[0].prenom).toBe('Jean');
    expect(ecartes).toBe(3);
  });

  it('respecte la place restante', () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({
      email: `p${i}@ex.fr`,
    }));
    expect(nettoyerContacts(contacts, [], 4).gardes).toHaveLength(4);
  });

  it('plafond quotidien selon la boîte', () => {
    expect(plafondJour('microsoft', 'a@b.com')).toBe(1000);
    expect(plafondJour('google', 'moi@gmail.com')).toBe(200);
    expect(plafondJour('google', 'moi@societe.fr')).toBe(500);
  });

  it("étale les envois sur l'heure et borne le rythme", () => {
    expect(envoisParPassage(30)).toBe(1);
    expect(envoisParPassage(40)).toBe(2);
    expect(bornerParHeure(500)).toBe(40);
    expect(bornerParHeure(1)).toBe(5);
    expect(bornerParHeure('x')).toBe(30);
  });

  it("lit la réponse JSON de l'IA, même entourée de texte", () => {
    const r = lireRedactions(
      'Voici :\n```json\n[{"email":"A@b.fr","objet":"Bonjour","corps":"Texte"},{"email":"c@d.fr","objet":""}]\n```',
    );
    expect(r).toEqual([{ email: 'a@b.fr', objet: 'Bonjour', corps: 'Texte' }]);
    expect(lireRedactions('pas de json')).toEqual([]);
  });

  it("extrait le texte d'un message HTML", () => {
    expect(
      texteMessage({
        html: '<p>Bonjour&nbsp;Jean</p><p>À bientôt<br>Marc</p>',
      }),
    ).toBe('Bonjour Jean\nÀ bientôt\nMarc');
    expect(texteMessage({ text: ' brut ', html: '<b>x</b>' })).toBe('brut');
  });
});
