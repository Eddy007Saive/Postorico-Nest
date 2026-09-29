import { IsOptional, IsString } from 'class-validator';

export class SubmagicThemeUpdateDto {
  @IsOptional()
  @IsString()
  submagic_theme_id?: string;

  @IsOptional()
  @IsString()
  submagic_theme_label?: string;
}
