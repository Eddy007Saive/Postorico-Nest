import { IsIn, IsOptional, IsString } from 'class-validator';
import { CLES_STRUCTURES } from '../structures.util';

const QUALITES = ['rapide', 'equilibre', 'premium'] as const;

export class RedigerPhotoDto {
  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsIn(QUALITES)
  qualite?: (typeof QUALITES)[number];

  @IsOptional()
  @IsIn(CLES_STRUCTURES)
  structure?: string;
}
