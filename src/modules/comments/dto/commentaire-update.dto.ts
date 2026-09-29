import { IsOptional, IsString } from 'class-validator';

export class CommentaireUpdateDto {
  @IsOptional()
  @IsString()
  statut?: string;

  @IsOptional()
  @IsString()
  reponse_ia?: string;
}
