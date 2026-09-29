import { Type } from 'class-transformer';
import { IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { StoryColorsDto } from './story-colors.dto';

export class StoryAnimeeDto {
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
  mot_accent?: string | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StoryColorsDto)
  colors?: StoryColorsDto;
}
