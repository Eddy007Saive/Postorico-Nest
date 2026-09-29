import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

const QUALITES = ['rapide', 'equilibre', 'premium'] as const;

export class CarrouselDto {
  @IsString()
  @IsNotEmpty()
  sujet!: string;

  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  nb_slides?: number;

  @IsOptional()
  @IsIn(QUALITES)
  qualite?: (typeof QUALITES)[number];

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contenu_id?: string;
}
