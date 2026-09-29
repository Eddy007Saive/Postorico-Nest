import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class RecolorDto {
  @IsString()
  @IsNotEmpty()
  contenu_id!: string;

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsObject()
  colors?: { p?: string; s?: string; a?: string };

  @IsOptional()
  @IsString()
  font?: string;

  @IsOptional()
  @IsString()
  font_corps?: string;
}
