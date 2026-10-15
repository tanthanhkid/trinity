import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { NEWSFEED_CATEGORIES, NewsfeedCategory } from './create-post.dto';

export class QueryPostsDto {
  @ApiPropertyOptional({ enum: NEWSFEED_CATEGORIES })
  @IsOptional()
  @IsIn(NEWSFEED_CATEGORIES as unknown as string[])
  category?: NewsfeedCategory;

  @ApiPropertyOptional({ description: 'ID bài cuối cùng để lấy trang tiếp' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cursor?: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
