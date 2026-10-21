import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Sujet à générer pour les miniatures (mascotte, personnage, objet), rangé dans la banque. */
export class MiniatureSujetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description!: string;

  @IsOptional()
  @IsIn(['photo', 'cinema', '3d', 'illustration', 'neon', 'pop'])
  style?: string;

  @IsOptional()
  @IsString()
  modele?: string;
}
