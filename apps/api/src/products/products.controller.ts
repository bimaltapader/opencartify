
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

import { ProductsService } from './products.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';

interface AuthenticatedRequest {
  user: {
    sub: string;
    role: string;
  };
}

@Controller('products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.VENDOR)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
  ) {}

  // Create a new product.
  @Post()
  createProduct(
    @Req() request: AuthenticatedRequest,
    @Body() createProductDto: CreateProductDto,
  ) {
    return this.productsService.createProduct(
      request.user.sub,
      createProductDto,
    );
  }

  // Get all active vendor products.
  @Get('my')
  getMyProducts(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.productsService.getMyProducts(
      request.user.sub,
    );
  }

  // Get deleted products (Vendor Trash).
  @Get('trash')
  getDeletedProducts(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.productsService.getDeletedProducts(
      request.user.sub,
    );
  }

  // Restore a deleted product.
  @Patch(':id/restore')
  restoreProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) productId: string,
  ) {
    return this.productsService.restoreProduct(
      request.user.sub,
      productId,
    );
  }

  // Get one active product by ID.
  @Get(':id')
  getProductById(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) productId: string,
  ) {
    return this.productsService.getProductById(
      request.user.sub,
      productId,
    );
  }

  // Update one product.
  @Patch(':id')
  updateProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) productId: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    return this.productsService.updateProduct(
      request.user.sub,
      productId,
      updateProductDto,
    );
  }

  // Soft-delete one product.
  @Delete(':id')
  deleteProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) productId: string,
  ) {
    return this.productsService.deleteProduct(
      request.user.sub,
      productId,
    );
  }
}
