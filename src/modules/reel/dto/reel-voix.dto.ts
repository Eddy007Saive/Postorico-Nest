import { IsOptional, IsString } from 'class-validator';

/** POST /reels/voix : refaire seulement la voix off d'un reel (même scénario). */
export class ReelVoixDto {
  @IsString()
  reel_id!: string;

  @IsOptional()
  @IsString()
  voix?: string | null; // absent = la voix déjà choisie pour ce reel
}
