import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

class ScheduleItemDto {
  @IsString()
  platform!: string;

  @IsOptional()
  @IsString()
  frequency?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  days_of_week?: number[];

  @IsOptional()
  @IsString()
  preferred_time?: string;

  // Validation fine (jour 0-6 présent dans days_of_week, format HH:MM) faite côté service,
  // comme days_of_week déjà — ici on ne vérifie que la forme générale.
  @IsOptional()
  @IsObject()
  preferred_times?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  carrousel_template?: string;

  @IsOptional()
  @IsString()
  mode_planification?: string;
}

export class ScheduleUpdateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules!: ScheduleItemDto[];
}
