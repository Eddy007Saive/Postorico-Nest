export interface CarrouselSlide {
  titre: string;
  texte: string;
  pills: string[];
  pro_tip: string;
  icon: string;
}

export interface CarrouselCta {
  titre: string;
  texte: string;
}

export interface CarrouselContent {
  hook: string;
  legende: string;
  slides: CarrouselSlide[];
  cta: CarrouselCta;
}
