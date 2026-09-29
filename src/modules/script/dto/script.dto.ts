import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

const QUALITES = ['rapide', 'equilibre', 'premium'] as const;
const TYPES_VIDEO = ['Reel', 'Short', 'Video', 'Interview'] as const;

export class ScriptDto {
  @IsString()
  @IsNotEmpty()
  sujet!: string;

  @IsOptional()
  @IsIn(TYPES_VIDEO)
  type_video?: (typeof TYPES_VIDEO)[number];

  @IsOptional()
  @IsIn(QUALITES)
  qualite?: (typeof QUALITES)[number];

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;
}
