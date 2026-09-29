import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

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
