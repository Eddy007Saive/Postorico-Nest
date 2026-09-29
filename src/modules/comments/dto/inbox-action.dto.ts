import { IsIn, IsString } from 'class-validator';

export class InboxActionDto {
  @IsIn(['like', 'unlike', 'hide', 'unhide', 'delete'])
  kind!: string;

  @IsString()
  post_id!: string;

  @IsString()
  comment_id!: string;

  @IsString()
  account_id!: string;
}
