import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

const TYPES_VIDEO = ['Reel', 'Short', 'Video', 'Interview'] as const;

export class EnregistrerScriptDto {
  @IsString()
  @IsNotEmpty()
  script!: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsIn(TYPES_VIDEO)
  type_video?: (typeof TYPES_VIDEO)[number];
}
