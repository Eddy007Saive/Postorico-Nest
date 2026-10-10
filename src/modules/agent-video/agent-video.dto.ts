import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class RushDto {
  @IsString()
  url!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  debut?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fin?: number | null;
}

/** Demande d'un client : ses rushes + ce qu'il attend du montage. */
export class AgentVideoCreerDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RushDto)
  clips!: RushDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  consignes?: string | null;

  @IsOptional()
  @IsString()
  reseau?: string | null;

  @IsOptional()
  @IsIn(['9:16', '16:9', '1:1'])
  format?: string | null;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  duree_cible_s?: number | null;

  @IsOptional()
  @IsString()
  musique?: string | null;
}

export class BattementDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  progression?: string | null;
}

export class TerminerDto {
  @IsOptional()
  @IsNumber()
  duree_s?: number | null;

  @IsOptional()
  @IsNumber()
  cout_usd?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resume?: string | null;
}

export class EchecDto {
  @IsString()
  @MaxLength(500)
  erreur!: string;

  @IsOptional()
  @IsNumber()
  cout_usd?: number | null;
}
