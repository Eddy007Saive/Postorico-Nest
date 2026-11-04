export interface ImageStyle {
  photo: boolean;
  texte: string;
}

export interface GenererPromptResult {
  prompt: string;
  style: string;
}

export interface GenererImageResult {
  lien_visuel: string;
  /** Coût réel facturé par OpenRouter (usage.cost, en $), absent s'il n'a pas été renvoyé. */
  cout_usd?: number;
}
