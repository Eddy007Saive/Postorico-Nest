import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

class RafaleItemDto {
  @IsString()
  sujet!: string;

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, unknown>;

  @IsString()
  reseau!: string;

  @IsOptional()
  @IsIn(['rapide', 'equilibre', 'premium'])
  qualite?: string;

  @IsOptional()
  @IsString()
  format?: string;
}

export class RafaleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RafaleItemDto)
  items!: RafaleItemDto[];

  @IsInt()
  year!: number;

  @IsInt()
  month!: number;
}
