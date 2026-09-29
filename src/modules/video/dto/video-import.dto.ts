import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class VideoImportDto {
  @IsString()
  video_url!: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  contenu_id?: string;

  @IsOptional()
  @IsBoolean()
  as_story?: boolean;

  @IsOptional()
  @IsArray()
  reseaux?: string[];

  @IsOptional()
  @IsString()
  reseau?: string;
}
