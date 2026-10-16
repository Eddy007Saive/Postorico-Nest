import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** « Améliorer la voix » d'un plan vidéo ou audio de l'éditeur. */
export class MontageVoixDto {
  @IsString()
  element_id!: string;

  /** Force du nettoyage, 0 à 100 (60 par défaut). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  force?: number;

  /** Ramène le volume au niveau attendu par les réseaux (-14 LUFS). */
  @IsOptional()
  @IsBoolean()
  normaliser?: boolean;
}
