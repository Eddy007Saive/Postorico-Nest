import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class PlanUpdateDto {
  @IsString()
  plan!: string;

  @IsOptional()
  @IsBoolean()
  reset_credits?: boolean;
}
