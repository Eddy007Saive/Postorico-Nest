import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Consigne libre sur une miniature déjà faite (« titre plus court », « enlève la casquette »). */
export class MiniatureRetoucheDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  instruction!: string;

  @IsOptional()
  @IsString()
  modele?: string;
}
