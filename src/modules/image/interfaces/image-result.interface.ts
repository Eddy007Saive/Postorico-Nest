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
}
