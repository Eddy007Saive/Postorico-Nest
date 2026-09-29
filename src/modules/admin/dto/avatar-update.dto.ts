import { IsOptional, IsString } from 'class-validator';

export class AvatarUpdateDto {
  @IsOptional()
  @IsString()
  avatar_id?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  consent_url?: string;

  @IsOptional()
  @IsString()
  error_message?: string;
}
