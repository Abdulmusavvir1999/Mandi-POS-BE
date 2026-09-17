import { z } from 'zod';

/**
 * Request validation for the create endpoints.
 *
 * These schemas are deliberately minimal: they require only the columns the
 * database itself declares NOT NULL without a default, and pass every other
 * field through untouched. The goal is to turn malformed requests into a 422
 * naming the offending field instead of letting them reach the driver and
 * surface as a generic 500 — not to add new business rules.
 */

const nonEmpty = (label: string) => z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`);

export const createCategorySchema = z
  .object({ name: nonEmpty('Category name') })
  .passthrough();

export const createCustomerSchema = z
  .object({
    name: nonEmpty('Customer name'),
    phone: nonEmpty('Customer phone'),
  })
  .passthrough();

export const createProductSchema = z
  .object({
    name: nonEmpty('Product name'),
    sku: nonEmpty('SKU'),
    categoryId: z.coerce.number({ required_error: 'Category is required' }).int().positive('Category is required'),
    sellingPrice: z.coerce.number({ required_error: 'Selling price is required' }).nonnegative('Selling price must be zero or more'),
  })
  .passthrough();

export const createUserSchema = z
  .object({
    username: nonEmpty('Username'),
    email: nonEmpty('Email').email('Email must be a valid address'),
    password: z.string({ required_error: 'Password is required' }).min(6, 'Password must be at least 6 characters'),
    name: nonEmpty('Full name'),
    roleId: z.coerce.number({ required_error: 'Role is required' }).int().positive('Role is required'),
  })
  .passthrough();

export const createDiningTableSchema = z
  .object({
    tableNumber: nonEmpty('Table number'),
    name: nonEmpty('Table name'),
  })
  .passthrough();

export const createStockItemSchema = z
  .object({
    name: nonEmpty('Stock item name'),
    stockCode: z.string().optional(),
    unitType: z.enum(['piece', 'kg', 'liter', 'gram', 'box', 'packet', 'portion', 'other']).optional(),
    minStockAlert: z.coerce.number().nonnegative().optional(),
    productId: z.coerce.number().int().positive().optional().nullable(),
    initialQuantity: z.coerce.number().nonnegative().optional(),
    initialPrice: z.coerce.number().nonnegative().optional(),
  })
  .passthrough();

export const updateStockItemSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    unitType: z.enum(['piece', 'kg', 'liter', 'gram', 'box', 'packet', 'portion', 'other']).optional(),
    minStockAlert: z.coerce.number().nonnegative().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .passthrough();

export const createStockEntrySchema = z
  .object({
    stockItemId: z.coerce.number({ required_error: 'Stock item is required' }).int().positive('Stock item is required'),
    quantity: z.coerce.number({ required_error: 'Quantity is required' }).positive('Quantity must be greater than 0'),
    multiplier: z.coerce.number().positive('Multiplier must be greater than 0').optional().default(1),
    totalPrice: z.coerce.number({ required_error: 'Total price is required' }).nonnegative('Total price must be zero or more'),
    supplier: z.string().optional(),
    invoiceNumber: z.string().optional(),
    notes: z.string().optional(),
    entryDate: z.string().optional(),
  })
  .passthrough();

export const stockInSchema = z
  .object({
    productId: z.coerce.number().int().positive().optional(),
    stockItemId: z.coerce.number().int().positive().optional(),
    quantity: z.coerce.number({ required_error: 'Quantity is required' }).positive('Quantity must be greater than 0'),
    multiplier: z.coerce.number().positive().optional(),
    totalPrice: z.coerce.number().nonnegative().optional(),
    supplier: z.string().optional(),
    invoiceNumber: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export const stockAdjustSchema = z
  .object({
    stockItemId: z.coerce.number().int().positive().optional(),
    productId: z.coerce.number().int().positive().optional(),
    adjustmentType: z.enum(['INCREASE', 'DECREASE', 'adjustment', 'wastage', 'return', 'in', 'out'], {
      required_error: 'Adjustment type is required',
    }),
    quantity: z.coerce.number({ required_error: 'Quantity is required' }).positive('Quantity must be greater than 0'),
    reason: nonEmpty('Adjustment reason'),
  })
  .passthrough();
