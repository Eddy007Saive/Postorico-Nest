import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

export class ReelVisuelsProposerDto {
  @IsString()
  texte!: string;

  @IsOptional()
  @IsString()
  brief?: string | null;

  @IsOptional()
  @IsInt()
  maximum?: number;

  /** URLs déjà placées dans le reel : jamais reproposées depuis la banque. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  exclure?: string[];

  /** true = « Générer de nouvelles images » : la banque est ignorée, seules des idées d'images
   * à générer reviennent. */
  @IsOptional()
  @IsBoolean()
  nouvelles?: boolean;
}
