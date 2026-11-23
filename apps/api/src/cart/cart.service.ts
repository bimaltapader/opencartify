import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  CartStatus,
  Prisma,
  ProductStatus,
  StoreStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves or creates an active cart for the customer safely under concurrent requests.
   * Recovers specifically from Prisma P2002 unique-constraint collisions on the partial unique index.
   */
  async getOrCreateActiveCart(customerId: string) {
    const existingCart = await this.prisma.cart.findFirst({
      where: {
        customerId,
        status: CartStatus.ACTIVE,
      },
    });

    if (existingCart) {
      return existingCart;
    }

    try {
      return await this.prisma.cart.create({
        data: {
          customerId,
          status: CartStatus.ACTIVE,
        },
      });
    } catch (error: any) {
      // Specifically handle unique constraint collision (P2002) from concurrent active-cart creation
      const isUniqueCollision =
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002') ||
        error?.code === 'P2002';

      if (isUniqueCollision) {
        const concurrentCart = await this.prisma.cart.findFirst({
          where: {
            customerId,
            status: CartStatus.ACTIVE,
          },
        });

        if (concurrentCart) {
          return concurrentCart;
        }
      }

      // Propagate any unexpected or non-unique database errors
      throw error;
    }
  }

  /**
   * Returns customer's active cart with current prices, available stock, and warnings.
   */
  async getCart(customerId: string) {
    const cart = await this.getOrCreateActiveCart(customerId);

    const fullCart = await this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                slug: true,
                sku: true,
                price: true,
                compareAtPrice: true,
                status: true,
                isPublished: true,
                deletedAt: true,
                store: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                    status: true,
                  },
                },
                images: {
                  where: { isPrimary: true },
                  select: { imageUrl: true, altText: true },
                  take: 1,
                },
                inventory: {
                  select: {
                    quantity: true,
                    reserved: true,
                    lowStockThreshold: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!fullCart) {
      throw new NotFoundException('Cart not found.');
    }

    let subtotal = 0;
    let hasUnavailableItems = false;

    const items = fullCart.items.map((item) => {
      const product = item.product;
      const isDeleted = product.deletedAt !== null;
      const isStoreActive = product.store.status === StoreStatus.ACTIVE;
      const isProductActive =
        product.status === ProductStatus.ACTIVE && product.isPublished;
      const availableStock = Math.max(
        0,
        (product.inventory?.quantity ?? 0) - (product.inventory?.reserved ?? 0),
      );
      const hasSufficientStock = availableStock >= item.quantity;
      const isAvailable =
        !isDeleted && isStoreActive && isProductActive && availableStock > 0;

      let warning: string | null = null;
      if (isDeleted) {
        warning = 'Product is no longer available.';
      } else if (!isStoreActive) {
        warning = 'Store is currently inactive.';
      } else if (!isProductActive) {
        warning = 'Product is currently not available for purchase.';
      } else if (availableStock < 1) {
        warning = 'Product is out of stock.';
      } else if (!hasSufficientStock) {
        warning = `Only ${availableStock} units available.`;
      }

      if (!isAvailable || !hasSufficientStock) {
        hasUnavailableItems = true;
      }

      const unitPrice = Number(product.price);
      const itemTotal = unitPrice * item.quantity;

      if (isAvailable && hasSufficientStock) {
        subtotal += itemTotal;
      }

      return {
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        product: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          sku: product.sku,
          price: unitPrice,
          compareAtPrice: product.compareAtPrice
            ? Number(product.compareAtPrice)
            : null,
          status: product.status,
          isPublished: product.isPublished,
          isDeleted,
          primaryImage: product.images[0] ?? null,
          store: product.store,
        },
        availableStock,
        hasSufficientStock,
        isAvailable,
        warning,
        unitPrice,
        itemTotal,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    });

    return {
      message: 'Cart retrieved successfully.',
      cart: {
        id: fullCart.id,
        status: fullCart.status,
        items,
        summary: {
          totalItems: items.length,
          totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
          subtotal: Math.round(subtotal * 100) / 100,
          hasUnavailableItems,
        },
        updatedAt: fullCart.updatedAt,
      },
    };
  }

  /**
   * Adds an item to the customer's active cart or increases its quantity.
   * Uses an interactive transaction with PostgreSQL row locking on the Cart row
   * to guarantee no lost updates under concurrent additions for the same product.
   * Advisory stock check only; does NOT reserve or modify inventory.
   */
  async addItem(customerId: string, dto: AddCartItemDto) {
    if (!Number.isInteger(dto.quantity) || dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }

    const cart = await this.getOrCreateActiveCart(customerId);

    return this.prisma.$transaction(async (tx) => {
      // 1. Acquire an exclusive row lock on the customer's Cart row.
      // This serializes concurrent item additions for the same cart while allowing
      // additions for different customers to proceed in parallel without blocking.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "Cart"
        WHERE "id" = ${cart.id}::uuid
        FOR UPDATE
      `);

      // 2. Query product and inventory within the transaction to obtain latest stock & status
      const product = await tx.product.findFirst({
        where: {
          id: dto.productId,
          deletedAt: null,
        },
        include: {
          store: true,
          inventory: true,
        },
      });

      if (!product) {
        throw new NotFoundException('Product not found.');
      }

      if (product.status !== ProductStatus.ACTIVE || !product.isPublished) {
        throw new BadRequestException(
          'Product is currently not available for purchase.',
        );
      }

      if (product.store.status !== StoreStatus.ACTIVE) {
        throw new BadRequestException('Store is currently inactive.');
      }

      const availableStock = Math.max(
        0,
        (product.inventory?.quantity ?? 0) - (product.inventory?.reserved ?? 0),
      );

      if (availableStock < 1) {
        throw new BadRequestException('Product is out of stock.');
      }

      // 3. Re-read the existing cart item under the Cart row lock
      const existingItem = await tx.cartItem.findUnique({
        where: {
          cartId_productId: {
            cartId: cart.id,
            productId: dto.productId,
          },
        },
      });

      // 4. Calculate the combined target quantity using the latest database value
      const targetQuantity = existingItem
        ? existingItem.quantity + dto.quantity
        : dto.quantity;

      // 5. Reject additions that would exceed currently available stock
      if (targetQuantity > availableStock) {
        throw new BadRequestException(
          `Requested quantity (${targetQuantity}) exceeds available stock (${availableStock}).`,
        );
      }

      // 6. Upsert the cart item atomically
      const item = await tx.cartItem.upsert({
        where: {
          cartId_productId: {
            cartId: cart.id,
            productId: dto.productId,
          },
        },
        create: {
          cartId: cart.id,
          productId: dto.productId,
          quantity: dto.quantity,
        },
        update: {
          quantity: targetQuantity,
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              price: true,
            },
          },
        },
      });

      return {
        message: 'Item added to cart successfully.',
        item: {
          id: item.id,
          cartId: item.cartId,
          productId: item.productId,
          quantity: item.quantity,
          product: {
            id: item.product.id,
            name: item.product.name,
            sku: item.product.sku,
            price: Number(item.product.price),
          },
          itemTotal: Number(item.product.price) * item.quantity,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        },
      };
    });
  }

  /**
   * Updates the quantity of a cart item with customer ownership check and Cart row lock.
   */
  async updateItem(
    customerId: string,
    itemId: string,
    dto: UpdateCartItemDto,
  ) {
    if (!Number.isInteger(dto.quantity) || dto.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer.');
    }

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.cartItem.findFirst({
        where: {
          id: itemId,
          cart: {
            customerId,
            status: CartStatus.ACTIVE,
          },
        },
        include: {
          cart: { select: { id: true } },
          product: {
            include: {
              store: true,
              inventory: true,
            },
          },
        },
      });

      if (!item) {
        throw new NotFoundException('Cart item not found.');
      }

      // Lock the cart row for this update
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "Cart"
        WHERE "id" = ${item.cart.id}::uuid
        FOR UPDATE
      `);

      if (
        item.product.deletedAt !== null ||
        item.product.status !== ProductStatus.ACTIVE ||
        !item.product.isPublished ||
        item.product.store.status !== StoreStatus.ACTIVE
      ) {
        throw new BadRequestException(
          'Product is no longer available for purchase.',
        );
      }

      const availableStock = Math.max(
        0,
        (item.product.inventory?.quantity ?? 0) -
          (item.product.inventory?.reserved ?? 0),
      );

      if (dto.quantity > availableStock) {
        throw new BadRequestException(
          `Requested quantity (${dto.quantity}) exceeds available stock (${availableStock}).`,
        );
      }

      const updated = await tx.cartItem.update({
        where: { id: itemId },
        data: { quantity: dto.quantity },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              price: true,
            },
          },
        },
      });

      return {
        message: 'Cart item updated successfully.',
        item: {
          id: updated.id,
          cartId: updated.cartId,
          productId: updated.productId,
          quantity: updated.quantity,
          product: {
            id: updated.product.id,
            name: updated.product.name,
            sku: updated.product.sku,
            price: Number(updated.product.price),
          },
          itemTotal: Number(updated.product.price) * updated.quantity,
          updatedAt: updated.updatedAt,
        },
      };
    });
  }

  /**
   * Removes an item from the customer's active cart.
   */
  async removeItem(customerId: string, itemId: string) {
    const item = await this.prisma.cartItem.findFirst({
      where: {
        id: itemId,
        cart: {
          customerId,
          status: CartStatus.ACTIVE,
        },
      },
    });

    if (!item) {
      throw new NotFoundException('Cart item not found.');
    }

    await this.prisma.cartItem.delete({
      where: { id: itemId },
    });

    return {
      message: 'Cart item removed successfully.',
      itemId,
    };
  }

  /**
   * Clears all items from the customer's active cart.
   */
  async clearCart(customerId: string) {
    const cart = await this.prisma.cart.findFirst({
      where: {
        customerId,
        status: CartStatus.ACTIVE,
      },
    });

    if (!cart) {
      return {
        message: 'Cart cleared successfully.',
        clearedCount: 0,
      };
    }

    const result = await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });

    return {
      message: 'Cart cleared successfully.',
      clearedCount: result.count,
    };
  }
}
