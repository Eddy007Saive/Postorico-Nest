import { Type } from 'class-transformer';
import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { StoryColorsDto } from './story-colors.dto';

class StoryPointDto {
  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  desc?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

/** Body de POST /contenus/:id/story — mêmes champs que StoryApercuDto, plus `image`
 * (le PNG déjà rendu par /story/apercu, réutilisé sans re-render). */
export class StoryDeclinerDto {
  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsString()
  accroche?: string | null;

  @IsOptional()
  @IsString()
  sous?: string | null;

  @IsOptional()
  @IsString()
  cta?: string | null;

  @IsOptional()
  @IsString()
  image?: string | null;

  @IsOptional()
  @IsString()
  image_source?: string | null;

  @IsOptional()
  @IsString()
  rico_pose?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StoryPointDto)
  points?: StoryPointDto[] | null;

  @IsOptional()
  @IsString()
  baseline?: string | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => StoryColorsDto)
  colors?: StoryColorsDto;
}
