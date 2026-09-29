import { IsOptional, IsString } from 'class-validator';

export class LienPackDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  telegram_id?: string;

  @IsOptional()
  @IsString()
  affilie?: string;

  @IsOptional()
  @IsString()
  devise?: string;

  @IsOptional()
  @IsString()
  langue?: string;
}
