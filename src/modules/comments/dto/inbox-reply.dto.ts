import { IsOptional, IsString } from 'class-validator';

export class InboxReplyDto {
  @IsString()
  post_id!: string;

  @IsString()
  account_id!: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  comment_id?: string;
}
