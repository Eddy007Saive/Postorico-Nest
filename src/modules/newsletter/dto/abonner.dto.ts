import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';

export class AbonnementDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  nom?: string;

  /** Langue de la page d'inscription (fr/en/es) : la lettre arrive dans cette langue. */
  @IsOptional()
  @IsIn(['fr', 'en', 'es'])
  langue?: string;
}