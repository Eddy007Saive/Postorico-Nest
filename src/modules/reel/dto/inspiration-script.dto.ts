import { IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

/** Script adapté d'un reel de référence déjà analysé. */
export class InspirationScriptDto {
  /** L'analyse renvoyée par POST /reels/inspiration/analyser, telle quelle. */
  @IsObject()
  analyse!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  sujet!: string;
}
