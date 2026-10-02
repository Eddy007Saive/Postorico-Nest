import { IsOptional, IsString } from 'class-validator';

export class VideoDraftDto {
  @IsOptional()
  @IsString()
  script?: string | null;

  @IsOptional()
  @IsString()
  titre?: string | null;

  @IsOptional()
  @IsString()
  reseau?: string | null;

  /** Script du Studio déjà en base (statut Brouillon) : promu « A tourner » (même ligne). */
  @IsOptional()
  @IsString()
  contenu_id?: string | null;
}
