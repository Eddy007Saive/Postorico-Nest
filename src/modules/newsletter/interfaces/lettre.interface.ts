export interface LettreSection {
  titre: string;
  corps: string;
  astuce: string;
}

export interface LettreActu {
  reseau: string;
  titre: string;
  resume: string;
  source: string;
}

export interface LettreData {
  sujet: string;
  preheader: string;
  titre: string;
  edito: string;
  sections: LettreSection[];
  actus: LettreActu[];
  action: string;
  signature: string;
  numero?: number;
  date?: string;
  _rappel_le?: string;
  [key: string]: unknown;
}

export interface VeilleSource {
  url: string;
  titre?: string;
}

export interface VeilleResult {
  texte: string;
  sources: VeilleSource[];
}