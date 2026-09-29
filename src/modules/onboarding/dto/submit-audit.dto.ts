import { IsObject, IsOptional, IsString } from 'class-validator';

export class SubmitAuditDto {
  @IsOptional()
  @IsString()
  _hp?: string; // honeypot anti-bot

  @IsOptional()
  @IsString()
  cf_turnstile_token?: string;

  @IsOptional()
  @IsString()
  turnstile_token?: string;

  @IsOptional()
  @IsObject()
  answers?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  marque?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  recap?: string;
}