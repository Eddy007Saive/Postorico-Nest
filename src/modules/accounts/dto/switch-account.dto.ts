import { IsString } from 'class-validator';

export class SwitchAccountDto {
  @IsString()
  telegram_id!: string;
}
