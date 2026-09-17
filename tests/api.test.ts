import request from 'supertest';
import { createApp } from '../src/app';
import { dbService } from '../src/database/db';

const app = createApp();

let adminToken: string;
let cashierToken: string;

/**
 * These tests run against the MySQL database configured by LOC_DB_* and they
 * WRITE to it (orders, bills, stock movements). Point LOC_DB_NAME at a
 * dedicated test schema before running them — the schema and seed data must
 * already exist there (see src/database/mysql_migrator.ts); the suite no
 * longer creates them, because the previous SQLite DDL is not valid MySQL.
 */
beforeAll(async () => {
  await dbService.initialize();

  // Login as admin
  const adminRes = await request(app).post('/api/auth/login').send({
    username: 'admin',
    password: 'Super@123',
  });
  adminToken = adminRes.body.data.token;

  // Login as cashier
  const cashierRes = await request(app).post('/api/auth/login').send({
    username: 'cashier',
    password: 'Cashier@123',
  });
  cashierToken = cashierRes.body.data?.token;
});

describe('Mandi Shop POS API Suite', () => {
  describe('Authentication & Roles', () => {
    it('should return current user with permissions on /api/auth/me', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.role).toBe('ADMIN');
      expect(Array.isArray(res.body.data.permissions)).toBe(true);
    });

    it('should reject unauthenticated requests', async () => {
      const res = await request(app).get('/api/products');
      expect(res.status).toBe(401);
    });
  });

  describe('Products & Categories', () => {
    it('should list categories', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('should list products with category and stock info', async () => {
      const res = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty('selling_price');
      expect(res.body.data[0]).toHaveProperty('current_stock');
    });

    it('should create a new product and initialize stock record', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          categoryId: 1,
          name: 'Test Gourmet Mandi Platter',
          sku: 'TST-MND-PLT',
          costPrice: 500,
          sellingPrice: 850,
          initialStock: 25,
          lowStockThreshold: 5,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Test Gourmet Mandi Platter');
      expect(res.body.data.current_stock).toBe(25);
    });
  });

  describe('3-Tier Stock Architecture (Master, Entries, Movements)', () => {
    let chickenStockItemId: number;

    it('should create a new Stock Master item (e.g. Fresh Chicken)', async () => {
      const res = await request(app)
        .post('/api/stock/items')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Fresh Farm Chicken',
          stockCode: 'STK-CHK-TEST',
          unitType: 'piece',
          minStockAlert: 10,
          initialQuantity: 0,
          initialPrice: 0,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Fresh Farm Chicken');
      expect(res.body.data.stock_code).toBe('STK-CHK-TEST');
      expect(res.body.data.current_quantity).toBe(0);
      chickenStockItemId = res.body.data.id;
    });

    it('should execute Transaction 1: 5 x 4 = 20 pcs for ₹2,000 (Unit Price = ₹100)', async () => {
      const res = await request(app)
        .post('/api/stock/entries')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          stockItemId: chickenStockItemId,
          quantity: 5,
          multiplier: 4,
          totalPrice: 2000,
          supplier: 'Al-Watania Poultry Farms',
          invoiceNumber: 'INV-CHK-001',
          notes: 'First Chicken batch',
        });

      console.log('ENTRY 1 RES:', res.status, JSON.stringify(res.body));
      expect(res.status).toBe(201);
      expect(res.body.data.totalQuantity).toBe(20);
      expect(res.body.data.totalPrice).toBe(2000);
      expect(res.body.data.unitPrice).toBe(100);
      expect(res.body.data.newQuantity).toBe(20);
      expect(res.body.data.newValue).toBe(2000);
      expect(res.body.data.newAverageUnitPrice).toBe(100);
    });

    it('should execute Transaction 2: 5 x 5 = 25 pcs for ₹5,000 (Unit Price = ₹200) without mutating Entry 1', async () => {
      const res = await request(app)
        .post('/api/stock/entries')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          stockItemId: chickenStockItemId,
          quantity: 5,
          multiplier: 5,
          totalPrice: 5000,
          supplier: 'Al-Watania Poultry Farms',
          invoiceNumber: 'INV-CHK-002',
          notes: 'Second Chicken batch',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.totalQuantity).toBe(25);
      expect(res.body.data.totalPrice).toBe(5000);
      expect(res.body.data.unitPrice).toBe(200);
      expect(res.body.data.newQuantity).toBe(45);
      expect(res.body.data.newValue).toBe(7000);
      // 7000 / 45 = 155.5555...
      expect(res.body.data.newAverageUnitPrice).toBeCloseTo(155.5556, 2);
    });

    it('should verify Stock Master balance: 45 pcs, ₹7,000 value, ₹155.56 avg price', async () => {
      const res = await request(app)
        .get(`/api/stock/items/${chickenStockItemId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.current_quantity).toBe(45);
      expect(res.body.data.current_value).toBe(7000);
      expect(res.body.data.average_unit_price).toBeCloseTo(155.5556, 2);
      expect(res.body.data.entries.length).toBe(2);
      expect(res.body.data.movements.length).toBe(2);
    });

    it('should list all stock purchase entries in the ledger', async () => {
      const res = await request(app)
        .get(`/api/stock/entries?stockItemId=${chickenStockItemId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].total_quantity).toBe(25);
      expect(res.body.data[1].total_quantity).toBe(20);
    });

    it('should list all stock movements and audit trail', async () => {
      const res = await request(app)
        .get(`/api/stock/movements?stockItemId=${chickenStockItemId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].balance_quantity).toBe(45);
      expect(res.body.data[1].balance_quantity).toBe(20);
    });

    it('should perform a stock audit adjustment and record in movements', async () => {
      const res = await request(app)
        .post('/api/stock/adjust')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          stockItemId: chickenStockItemId,
          adjustmentType: 'wastage',
          quantity: 5,
          reason: 'Kitchen prep wastage',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.newQuantity).toBe(40);

      // Verify updated master
      const masterRes = await request(app)
        .get(`/api/stock/items/${chickenStockItemId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(masterRes.body.data.current_quantity).toBe(40);
      expect(masterRes.body.data.movements.length).toBe(3);
    });
  });

  describe('Transactional Checkout & Billing Engine', () => {
    it('should complete checkout, deduct stock, create order and bill in one transaction', async () => {
      // Find Chicken Mandi
      const prodRes = await request(app)
        .get('/api/products?search=MND-CHK-Q')
        .set('Authorization', `Bearer ${cashierToken}`);
      const item = prodRes.body.data[0];
      const stockBefore = item.current_stock;

      const checkoutRes = await request(app)
        .post('/api/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          orderType: 'WALK_IN',
          paymentMethod: 'CASH',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          items: [
            {
              productId: item.id,
              quantity: 2,
            },
          ],
        });

      expect(checkoutRes.status).toBe(201);
      expect(checkoutRes.body.data).toHaveProperty('bill_number');
      expect(checkoutRes.body.data).toHaveProperty('order_id');
      expect(checkoutRes.body.data.payment_status).toBe('PAID');

      // Verify stock was decremented
      const updatedProdRes = await request(app)
        .get(`/api/products/${item.id}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(updatedProdRes.body.data.current_stock).toBe(stockBefore - 2);
    });

    it('should reject checkout when requested quantity exceeds available stock', async () => {
      const prodRes = await request(app)
        .get('/api/products?search=MND-FSH-F')
        .set('Authorization', `Bearer ${cashierToken}`);
      const item = prodRes.body.data[0];

      const checkoutRes = await request(app)
        .post('/api/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          orderType: 'WALK_IN',
          paymentMethod: 'CASH',
          items: [
            {
              productId: item.id,
              quantity: item.current_stock + 100,
            },
          ],
        });

      expect(checkoutRes.status).toBe(400);
      expect(checkoutRes.body.success).toBe(false);
      expect(checkoutRes.body.message).toContain('Insufficient stock');
    });
  });

  describe('Dining Workflow & Table State Protection', () => {
    it('should occupy table during dining order and release upon billing', async () => {
      // Get Table 1
      const tablesRes = await request(app)
        .get('/api/dining-tables')
        .set('Authorization', `Bearer ${cashierToken}`);
      const table1 = tablesRes.body.data[0];

      const prodRes = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${cashierToken}`);
      const product = prodRes.body.data[0];

      // Checkout dining order
      const checkoutRes = await request(app)
        .post('/api/checkout')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          diningTableId: table1.id,
          orderType: 'DINING',
          paymentMethod: 'UPI',
          items: [{ productId: product.id, quantity: 1 }],
        });

      expect(checkoutRes.status).toBe(201);

      // Verify table is available after billing
      const tableCheck = await request(app)
        .get(`/api/dining-tables/${table1.id}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(tableCheck.body.data.status).toBe('AVAILABLE');
    });
  });

  describe('Queue Management', () => {
    it('should generate sequential token numbers and transition statuses', async () => {
      const token1 = await request(app)
        .post('/api/queue')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          customerName: 'Ahmad Al-Mansoor',
          customerPhone: '9845099999',
          tokenType: 'TAKEAWAY',
        });
      expect(token1.status).toBe(201);
      expect(token1.body.data.queue_number).toMatch(/^A\d{3}$/);

      // Transition to IN_PROGRESS
      const started = await request(app)
        .post(`/api/queue/${token1.body.data.id}/start`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('IN_PROGRESS');
    });
  });

  describe('Draft Bills (Hold & Resume)', () => {
    it('should create draft bill, resume it and remove draft', async () => {
      const prodRes = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${cashierToken}`);
      const prod = prodRes.body.data[0];

      const holdRes = await request(app)
        .post('/api/draft-bills')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({
          orderType: 'WALK_IN',
          items: [{ productId: prod.id, quantity: 2 }],
        });
      expect(holdRes.status).toBe(201);
      const draftId = holdRes.body.data.id;

      const resumeRes = await request(app)
        .post(`/api/draft-bills/${draftId}/resume`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.items.length).toBe(1);

      // Verify draft is deleted
      const checkRes = await request(app)
        .get(`/api/draft-bills/${draftId}`)
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(checkRes.status).toBe(404);
    });
  });

  describe('Analytics & Reports', () => {
    it('should return populated dashboard metrics', async () => {
      const res = await request(app)
        .get('/api/dashboard/metrics')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.kpis.todaySales).toBeGreaterThan(0);
      expect(res.body.data.categorySales.length).toBeGreaterThan(0);
    });

    it('should generate sales and stock reports', async () => {
      const salesRes = await request(app)
        .get('/api/reports/sales')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(salesRes.status).toBe(200);

      const stockRes = await request(app)
        .get('/api/reports/stock')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(stockRes.status).toBe(200);
      expect(stockRes.body.data.totals.total_items_in_stock).toBeGreaterThan(0);
    });
  });
});
