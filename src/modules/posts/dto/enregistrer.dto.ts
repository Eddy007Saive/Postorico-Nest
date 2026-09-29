import { IsOptional, IsString } from 'class-validator';

export class EnregistrerDto {
  @IsString()
  contenu!: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  reseau?: string;

  @IsOptional()
  @IsString()
  type?: string;
}
