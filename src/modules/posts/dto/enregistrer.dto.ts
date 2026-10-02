import { IsOptional, IsString } from 'class-validator';

export class EnregistrerDto {
  @IsString()
  contenu!: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsString()
  type?: string;

  /** Texte IA tel que généré (mémoire d'évaluation H2). */
  @IsOptional()
  @IsString()
  contenu_original?: string;

  /** Brouillon du Studio déjà en base : promu (même ligne) au lieu d'en créer une nouvelle. */
  @IsOptional()
  @IsString()
  contenu_id?: string;
}
