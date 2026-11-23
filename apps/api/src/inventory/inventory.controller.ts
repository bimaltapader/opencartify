import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UserRole } from '../generated/prisma/client.js';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto.js';
import { InventoryMovementsQueryDto } from './dto/inventory-movements-query.dto.js';
import { InventoryService } from './inventory.service.js';

interface AuthenticatedRequest {
  user: {
    sub: string;
    role: string;
  };
}

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.VENDOR)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('my')
  getMyInventory(@Req() request: AuthenticatedRequest) {
    return this.inventoryService.getMyInventory(request.user.sub);
  }

  @Get(':productId/movements')
  getMovements(
    @Req() request: AuthenticatedRequest,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: InventoryMovementsQueryDto,
  ) {
    return this.inventoryService.getMovements(
      request.user.sub,
      productId,
      query,
    );
  }

  @Post(':productId/adjust')
  adjustInventory(
    @Req() request: AuthenticatedRequest,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AdjustInventoryDto,
  ) {
    return this.inventoryService.adjustInventory(
      request.user.sub,
      productId,
      dto,
    );
  }
}
