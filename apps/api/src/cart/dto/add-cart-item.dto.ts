import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsUUID, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID('4', { message: 'productId must be a valid UUID' })
  @IsNotEmpty({ message: 'productId is required' })
  productId: string;

  @Type(() => Number)
  @IsInt({ message: 'quantity must be an integer' })
  @Min(1, { message: 'quantity must be at least 1' })
  quantity: number;
}
