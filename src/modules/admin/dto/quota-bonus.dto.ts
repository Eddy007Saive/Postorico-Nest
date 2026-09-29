import { IsInt, IsString, Min } from 'class-validator';

export class QuotaBonusDto {
  @IsString()
  action_type!: string;

  @IsInt()
  @Min(0)
  extra_quantity!: number;
}
