import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class ImageDto {
  @IsOptional()
  @IsString()
  prompt?: string;

  @IsOptional()
  @IsBoolean()
  template_mode?: boolean;

  @IsOptional()
  @IsString()
  contenu_id?: string;

  @IsOptional()
  @IsString()
  modele?: string;

  @IsOptional()
  @IsBoolean()
  avec_photo?: boolean;

  @IsOptional()
  @IsArray()
  refs?: string[];

  @IsOptional()
  @IsArray()
  integrate_refs?: string[];

  @IsOptional()
  @IsArray()
  ecran_refs?: string[];

  @IsOptional()
  @IsString()
  style_note?: string;

  @IsOptional()
  @IsString()
  style?: string;
}
