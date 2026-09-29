import { IsOptional, IsString } from 'class-validator';

export class InspirationRoleDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  role?: string;
}
