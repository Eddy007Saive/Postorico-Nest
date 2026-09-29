import { IsOptional, IsString } from 'class-validator';

export class DemandeDto {
  @IsOptional()
  @IsString()
  nom?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  iban?: string;

  @IsOptional()
  @IsString()
  audience?: string;
}
