import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

export class MiniatureRequestDto {
  @IsOptional()
  @IsString()
  gabarit?: string;

  @IsOptional()
  @IsObject()
  textes?: Record<string, string>;

  @IsOptional()
  @IsString()
  ratio?: string;

  @IsOptional()
  @IsString()
  modele?: string;

  @IsOptional()
  @IsBoolean()
  reutiliser_fond?: boolean;

  @IsOptional()
  @IsString()
  style?: string;

  @IsOptional()
  @IsString()
  police?: string | null;

  /** Image de la banque à intégrer comme sujet (remplace la photo du client). */
  @IsOptional()
  @IsString()
  ref?: string | null;
}
