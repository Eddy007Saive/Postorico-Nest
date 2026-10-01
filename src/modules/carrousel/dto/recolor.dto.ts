import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class RecolorDto {
  @IsString()
  @IsNotEmpty()
  contenu_id!: string;

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsObject()
  colors?: { p?: string; s?: string; a?: string };

  @IsOptional()
  @IsString()
  font?: string;

  @IsOptional()
  @IsString()
  font_corps?: string;

  /** Texte des slides retouché à la main par le client (même forme que la rédaction IA) ;
   * normalisé côté serveur, jamais régénéré. Ajouté le 2026-10-01. */
  @IsOptional()
  @IsObject()
  carrousel_data?: Record<string, unknown>;
}
