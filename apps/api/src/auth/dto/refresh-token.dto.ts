
import { IsString, MinLength, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @MinLength(32)
  @MaxLength(200)
  refreshToken: string;
}
