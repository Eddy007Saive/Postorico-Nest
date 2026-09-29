import { IsIn, IsOptional, IsString } from 'class-validator';

const QUALITES = ['rapide', 'equilibre', 'premium'] as const;

export class RedigerPhotoDto {
  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsIn(QUALITES)
  qualite?: (typeof QUALITES)[number];
}
