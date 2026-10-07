import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Le graphe (nodes / edges) est transmis tel quel à Zernio, qui le valide lui-même et
 * renvoie un message précis en cas d'erreur (bloc manquant, mauvais enchaînement…). */
export class CreateWorkflowDto {
  @IsString()
  accountId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  nodes!: Record<string, unknown>[];

  @IsArray()
  edges!: Record<string, unknown>[];
}

export class UpdateWorkflowDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  nodes?: Record<string, unknown>[];

  @IsOptional()
  @IsArray()
  edges?: Record<string, unknown>[];
}
