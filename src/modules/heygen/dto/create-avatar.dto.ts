import { IsOptional, IsString } from 'class-validator';

export class CreateAvatarDto {
  @IsOptional()
  @IsString()
  description?: string;
}
