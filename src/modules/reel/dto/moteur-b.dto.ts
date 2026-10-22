import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Reel « moteur B » (test A/B) : depuis un contenu, ou depuis un brief libre. */
export class MoteurBDto {
  @IsOptional()
  @IsString()
  contenu_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  brief?: string | null;

  @IsOptional()
  @IsString()
  reseau?: string | null;
}
