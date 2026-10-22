import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ReelImageDto } from './reel-image.dto';

export class ReelRegenererDto {
  @IsString()
  reel_id!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReelImageDto)
  images?: ReelImageDto[] | null;

  @IsOptional()
  @IsString()
  brief?: string | null;

  @IsOptional()
  @IsString()
  style?: string | null;

  @IsOptional()
  @IsString()
  musique?: string | null;

  @IsOptional()
  @IsString()
  voix?: string | null; // absent (undefined) = garder celle du reel ; "none" = retirer

  @IsOptional()
  @IsBoolean()
  montage_ia?: boolean | null; // absent = garder le choix précédent

  /** Plans vidéo réels (Pexels) pour les passages concrets ; absent = oui. */
  @IsOptional()
  @IsBoolean()
  plans_video?: boolean;
}
