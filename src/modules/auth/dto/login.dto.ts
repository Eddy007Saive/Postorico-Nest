import { IsEmail, IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/auth.py::UserLogin.
 * `appareil` : secret « appareil de confiance » gardé par le navigateur (MFA — pas encore porté). */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  appareil?: string;
}
