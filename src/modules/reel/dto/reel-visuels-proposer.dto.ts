import { IsInt, IsOptional, IsString } from 'class-validator';

export class ReelVisuelsProposerDto {
  @IsString()
  texte!: string;

  @IsOptional()
  @IsString()
  brief?: string | null;

  @IsOptional()
  @IsInt()
  maximum?: number;
}
