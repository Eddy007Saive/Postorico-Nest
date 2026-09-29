import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Port direct de backend/models/auth.py::UserRegister.
 * `fuseau` : fuseau du navigateur (« Europe/Madrid », « America/Bogota ») — donne le PAYS,
 * ce que `langue` seule ne sait pas faire (un Espagnol et un Colombien écrivent tous deux "es").
 */
export class RegisterDto {
  @IsString()
  @MinLength(1)
  nom: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsIn(['fr', 'en', 'es'])
  langue?: string;

  @IsOptional()
  @IsString()
  ref?: string;

  @IsOptional()
  @IsString()
  fuseau?: string;
}
