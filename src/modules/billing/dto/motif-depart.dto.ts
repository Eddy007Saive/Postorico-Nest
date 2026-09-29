import { IsOptional, IsString } from 'class-validator';

export class MotifDepartDto {
  @IsOptional()
  @IsString()
  raison?: string;

  @IsOptional()
  @IsString()
  commentaire?: string;
}
