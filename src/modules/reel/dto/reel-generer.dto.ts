import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ReelImageDto } from './reel-image.dto';

export class ReelGenererDto {
  @IsString()
  contenu_id!: string;

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsString()
  duree?: string | null;

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
  voix?: string | null;

  @IsOptional()
  @IsBoolean()
  montage_ia?: boolean;
}
