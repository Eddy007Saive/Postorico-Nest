import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

const QUALITES = ['rapide', 'equilibre', 'premium'] as const;

export class RedigerDto {
  @IsString()
  @IsNotEmpty()
  sujet!: string;

  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsIn(QUALITES)
  qualite?: (typeof QUALITES)[number];

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  save?: boolean;
}
