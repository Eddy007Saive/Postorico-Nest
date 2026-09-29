import { IsOptional, IsString } from 'class-validator';

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  old_password?: string;

  @IsOptional()
  @IsString()
  new_password?: string;
}
