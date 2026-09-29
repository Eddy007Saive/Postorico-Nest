import { IsOptional, IsString } from 'class-validator';

export class ResilierDto {
  @IsOptional()
  @IsString()
  raison?: string;

  @IsOptional()
  @IsString()
  commentaire?: string;

  @IsOptional()
  @IsString()
  parcours?: string;
}
