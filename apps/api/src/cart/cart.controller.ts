import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UserRole } from '../generated/prisma/client.js';
import { CartService } from './cart.service.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';

interface AuthenticatedRequest {
  user: {
    sub: string;
    role: string;
  };
}

@Controller('cart')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@Req() request: AuthenticatedRequest) {
    return this.cartService.getCart(request.user.sub);
  }

  @Post('items')
  addItem(@Req() request: AuthenticatedRequest, @Body() dto: AddCartItemDto) {
    return this.cartService.addItem(request.user.sub, dto);
  }

  @Patch('items/:itemId')
  updateItem(
    @Req() request: AuthenticatedRequest,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(request.user.sub, itemId, dto);
  }

  @Delete('items/:itemId')
  removeItem(
    @Req() request: AuthenticatedRequest,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.cartService.removeItem(request.user.sub, itemId);
  }

  @Delete()
  clearCart(@Req() request: AuthenticatedRequest) {
    return this.cartService.clearCart(request.user.sub);
  }
}
