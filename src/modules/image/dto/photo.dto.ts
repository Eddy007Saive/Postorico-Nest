import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PhotoDto {
  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsString()
  modele?: string;
}
