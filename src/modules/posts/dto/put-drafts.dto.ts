import { IsArray } from 'class-validator';

export class PutDraftsDto {
  @IsArray()
  items!: unknown[];
}
