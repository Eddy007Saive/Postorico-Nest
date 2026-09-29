import { IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/auth.py::GoogleLogin. */
export class GoogleLoginDto {
  // Jeton d'accès Google obtenu dans le navigateur ; le serveur le vérifie auprès de
  // Google, jamais le contraire.
  @IsString()
  access_token: string;

  @IsOptional()
  @IsString()
  langue?: string;

  @IsOptional()
  @IsString()
  fuseau?: string;

  @IsOptional()
  @IsString()
  ref?: string;
}
