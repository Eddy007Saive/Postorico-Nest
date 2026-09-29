import { IsEmail, IsOptional, IsString } from 'class-validator';

export class AbonnementDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  nom?: string;
}