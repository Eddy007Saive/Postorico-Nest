import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GabaritAutoDto {
  @IsString()
  @IsNotEmpty()
  gabarit!: string;

  @IsOptional()
  @IsString()
  texte?: string;

  @IsOptional()
  @IsString()
  bg_image?: string;

  @IsOptional()
  @IsString()
  contenu_id?: string;
}
