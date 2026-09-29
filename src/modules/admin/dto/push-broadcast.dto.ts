import { IsOptional, IsString } from 'class-validator';

export class PushBroadcastDto {
  @IsString()
  title!: string;

  @IsString()
  body!: string;

  @IsOptional()
  @IsString()
  telegram_id?: string;
}
