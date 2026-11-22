
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';

import {
  StoreStatus,
  ProductStatus,
} from '../generated/prisma/client.js';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // Generate a unique product slug.
  private createSlug(name: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  // Create a new product.
  async createProduct(userId: string, dto: CreateProductDto) {
    const store = await this.prisma.store.findFirst({
      where: { ownerId: userId },
    });

    if (!store) {
      throw new NotFoundException('Store not found.');
    }

    if (
      store.status === StoreStatus.SUSPENDED ||
      store.status === StoreStatus.CLOSED
    ) {
      throw new ForbiddenException(
        'Your store cannot create products at this time.',
      );
    }

    if (dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: {
          id: dto.categoryId,
          isActive: true,
        },
      });

      if (!category) {
        throw new BadRequestException(
          'Invalid or inactive product category.',
        );
      }
    }

    const existingSku = await this.prisma.product.findUnique({
      where: { sku: dto.sku.trim() },
    });

    if (existingSku) {
      throw new BadRequestException(
        'This SKU is already in use.',
      );
    }

    if (dto.barcode) {
      const existingBarcode = await this.prisma.product.findUnique({
        where: { barcode: dto.barcode.trim() },
      });

      if (existingBarcode) {
        throw new BadRequestException(
          'This barcode is already in use.',
        );
      }
    }

    if (
      dto.compareAtPrice !== undefined &&
      dto.compareAtPrice <= dto.price
    ) {
      throw new BadRequestException(
        'Compare-at price must be greater than the selling price.',
      );
    }

    const product = await this.prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: dto.categoryId,
        name: dto.name.trim(),
        slug: this.createSlug(dto.name),
        description: dto.description,
        sku: dto.sku.trim(),
        barcode: dto.barcode?.trim(),
        price: dto.price,
        compareAtPrice: dto.compareAtPrice,
        weight: dto.weight,
        status: ProductStatus.DRAFT,
        isPublished: false,

        inventory: {
          create: {
            quantity: dto.stockQuantity ?? 0,
            lowStockThreshold: dto.lowStockThreshold ?? 5,
          },
        },

        images: dto.imageUrl
          ? {
              create: {
                imageUrl: dto.imageUrl,
                isPrimary: true,
                sortOrder: 0,
              },
            }
          : undefined,
      },
      include: {
        inventory: true,
        images: true,
      },
    });

    return {
      message: 'Product created successfully.',
      product,
    };
  }

  // Get all active (not deleted) products belonging to the vendor.
  async getMyProducts(userId: string) {
    const products = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        store: {
          ownerId: userId,
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        sku: true,
        barcode: true,
        price: true,
        compareAtPrice: true,
        weight: true,
        status: true,
        isPublished: true,
        images: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        inventory: {
          select: {
            quantity: true,
            reserved: true,
            lowStockThreshold: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      message: 'Products retrieved successfully.',
      total: products.length,
      products,
    };
  }

  // Get one active product, checking vendor ownership.
  async getProductById(userId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
        store: {
          ownerId: userId,
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        sku: true,
        barcode: true,
        price: true,
        compareAtPrice: true,
        weight: true,
        status: true,
        isFeatured: true,
        isPublished: true,
        images: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        inventory: {
          select: {
            quantity: true,
            reserved: true,
            lowStockThreshold: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    return {
      message: 'Product retrieved successfully.',
      product,
    };
  }

  // Update an active product belonging to the authenticated vendor.
  async updateProduct(
    userId: string,
    productId: string,
    dto: UpdateProductDto,
  ) {
    // Verify product ownership and retrieve current prices.
    const existingProduct = await this.prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
        store: {
          ownerId: userId,
        },
      },
      select: {
        id: true,
        price: true,
        compareAtPrice: true,
      },
    });

    if (!existingProduct) {
      throw new NotFoundException('Product not found.');
    }

    // Validate category if supplied.
    if (dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: {
          id: dto.categoryId,
          isActive: true,
        },
      });

      if (!category) {
        throw new BadRequestException(
          'Invalid or inactive product category.',
        );
      }
    }

    // Check SKU uniqueness, excluding this product.
    if (dto.sku !== undefined) {
      const existingSku = await this.prisma.product.findFirst({
        where: {
          sku: dto.sku.trim(),
          NOT: { id: productId },
        },
      });

      if (existingSku) {
        throw new BadRequestException(
          'This SKU is already in use.',
        );
      }
    }

    // Check barcode uniqueness, excluding this product.
    if (dto.barcode !== undefined && dto.barcode.trim()) {
      const existingBarcode = await this.prisma.product.findFirst({
        where: {
          barcode: dto.barcode.trim(),
          NOT: { id: productId },
        },
      });

      if (existingBarcode) {
        throw new BadRequestException(
          'This barcode is already in use.',
        );
      }
    }

    // Validate the effective selling and compare-at prices.
    const effectivePrice =
      dto.price ?? Number(existingProduct.price);

    const effectiveCompareAtPrice =
      dto.compareAtPrice !== undefined
        ? dto.compareAtPrice
        : existingProduct.compareAtPrice === null
          ? null
          : Number(existingProduct.compareAtPrice);

    if (
      effectiveCompareAtPrice !== null &&
      effectiveCompareAtPrice <= effectivePrice
    ) {
      throw new BadRequestException(
        'Compare-at price must be greater than the selling price.',
      );
    }

    // Update only the permitted fields.
    const updatedProduct = await this.prisma.product.update({
      where: {
        id: existingProduct.id,
      },
      data: {
        ...(dto.name !== undefined && {
          name: dto.name.trim(),
          slug: this.createSlug(dto.name),
        }),
        ...(dto.description !== undefined && {
          description: dto.description,
        }),
        ...(dto.categoryId !== undefined && {
          categoryId: dto.categoryId,
        }),
        ...(dto.sku !== undefined && {
          sku: dto.sku.trim(),
        }),
        ...(dto.barcode !== undefined && {
          barcode: dto.barcode.trim() || null,
        }),
        ...(dto.price !== undefined && {
          price: dto.price,
        }),
        ...(dto.compareAtPrice !== undefined && {
          compareAtPrice: dto.compareAtPrice,
        }),
        ...(dto.weight !== undefined && {
          weight: dto.weight,
        }),
        ...(dto.imageUrl !== undefined && {
          images: {
            create: {
              imageUrl: dto.imageUrl,
              isPrimary: false,
            },
          },
        }),
      },
      include: {
        images: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        inventory: true,
      },
    });

    return {
      message: 'Product updated successfully.',
      product: updatedProduct,
    };
  }

  // Soft-delete a product without permanently removing its data.
  async deleteProduct(userId: string, productId: string) {
    const result = await this.prisma.product.updateMany({
      where: {
        id: productId,
        deletedAt: null,
        store: {
          ownerId: userId,
        },
      },
      data: {
        deletedAt: new Date(),
        isPublished: false,
        status: ProductStatus.INACTIVE,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Product not found.');
    }

    return {
      message: 'Product deleted successfully.',
      productId,
      deleted: true,
    };
  }

  // Get deleted products belonging to the authenticated vendor.
  async getDeletedProducts(userId: string) {
    const products = await this.prisma.product.findMany({
      where: {
        deletedAt: {
          not: null,
        },
        store: {
          ownerId: userId,
        },
      },
      include: {
        images: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        inventory: true,
      },
      orderBy: {
        deletedAt: 'desc',
      },
    });

    return {
      message: 'Deleted products retrieved successfully.',
      total: products.length,
      products,
    };
  }

  // Restore a deleted product.
  async restoreProduct(userId: string, productId: string) {
    const result = await this.prisma.product.updateMany({
      where: {
        id: productId,
        deletedAt: {
          not: null,
        },
        store: {
          ownerId: userId,
        },
      },
      data: {
        deletedAt: null,
        status: ProductStatus.DRAFT,
        isPublished: false,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException(
        'Deleted product not found.',
      );
    }

    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
        store: {
          ownerId: userId,
        },
      },
      include: {
        images: {
          orderBy: {
            sortOrder: 'asc',
          },
        },
        inventory: true,
      },
    });

    if (!product) {
      throw new NotFoundException(
        'Restored product could not be retrieved.',
      );
    }

    return {
      message: 'Product restored successfully.',
      product,
    };
  }
}
