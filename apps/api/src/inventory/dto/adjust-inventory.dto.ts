import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  NotEquals,
} from 'class-validator';

export class AdjustInventoryDto {
  @IsInt()
  @NotEquals(0)
  quantityChange: number;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
