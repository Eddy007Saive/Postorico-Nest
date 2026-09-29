import { IsOptional, IsString } from 'class-validator';

export class VoixDefautDto {
  @IsOptional()
  @IsString()
  voix?: string | null;
}
