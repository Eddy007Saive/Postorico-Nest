import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ImagePromptDto {
  @IsString()
  @IsNotEmpty()
  texte!: string;

  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsBoolean()
  avec_photo?: boolean;

  @IsOptional()
  @IsString()
  style?: string;

  @IsOptional()
  @IsString()
  contenu_id?: string;
}
