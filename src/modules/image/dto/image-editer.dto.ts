import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class ImageEditerDto {
  @IsString()
  @IsNotEmpty()
  image_url!: string;

  @IsString()
  @MinLength(3)
  instruction!: string;

  @IsOptional()
  @IsString()
  contenu_id?: string;

  @IsOptional()
  @IsString()
  modele?: string;
}
