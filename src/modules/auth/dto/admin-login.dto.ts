import { IsEmail, IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/auth.py::AdminLogin. */
export class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  appareil?: string;
}
