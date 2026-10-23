import { blocStructure, CLES_STRUCTURES } from './structures.util';
import { premierCommentaireAPublier } from '../late/late.service';

describe('blocStructure', () => {
  it('ne change rien en automatique ou pour une clé inconnue', () => {
    expect(blocStructure('auto')).toBe('');
    expect(blocStructure(undefined)).toBe('');
    expect(blocStructure('inconnue')).toBe('');
    expect(blocStructure(42)).toBe('');
  });

  it('impose la structure choisie sans en écrire les étiquettes', () => {
    const bloc = blocStructure('pas');
    expect(bloc).toContain('MANDATORY POST STRUCTURE');
    expect(bloc).toContain('Problem');
    expect(bloc).toContain('without writing their names or labels');
  });

  it('expose les 5 structures plus automatique', () => {
    expect(CLES_STRUCTURES).toEqual(['auto', 'aida', 'pas', 'bab', 'star', 'slay']);
  });
});

describe('premierCommentaireAPublier', () => {
  const base = { premier_commentaire: '  Et vous, quel est votre rituel ?  ', premier_commentaire_auto: true, type: 'Post' };

  it('renvoie le commentaire nettoyé quand tout est réuni', () => {
    expect(premierCommentaireAPublier(base, 'linkedin')).toBe('Et vous, quel est votre rituel ?');
  });

  it('ne publie rien si le client ne l’a pas demandé ou si le texte est vide', () => {
    expect(premierCommentaireAPublier({ ...base, premier_commentaire_auto: false }, 'linkedin')).toBeNull();
    expect(premierCommentaireAPublier({ ...base, premier_commentaire: '   ' }, 'linkedin')).toBeNull();
    expect(premierCommentaireAPublier({ ...base, premier_commentaire: null }, 'linkedin')).toBeNull();
  });

  it('ignore les réseaux sans premier commentaire et les stories', () => {
    expect(premierCommentaireAPublier(base, 'tiktok')).toBeNull();
    expect(premierCommentaireAPublier(base, 'googlebusiness')).toBeNull();
    expect(premierCommentaireAPublier({ ...base, type: 'Story' }, 'instagram')).toBeNull();
  });

  it('coupe à la limite du réseau', () => {
    const long = { ...base, premier_commentaire: 'a'.repeat(3000) };
    expect(premierCommentaireAPublier(long, 'linkedin')).toHaveLength(1250);
    expect(premierCommentaireAPublier(long, 'instagram')).toHaveLength(2200);
    expect(premierCommentaireAPublier(long, 'facebook')).toHaveLength(3000);
  });
});
