import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { StoryColorsDto } from './story-colors.dto';

class StorySerieEcranDto {
  @IsString()
  accroche!: string;

  @IsOptional()
  @IsString()
  sous?: string | null;

  @IsOptional()
  @IsString()
  cta?: string | null;

  @IsOptional()
  @IsString()
  image_source?: string | null;
}

export class StorySerieDto {
  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StoryColorsDto)
  colors?: StoryColorsDto;

  @IsOptional()
  @IsBoolean()
  anime?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StorySerieEcranDto)
  ecrans!: StorySerieEcranDto[];
}
