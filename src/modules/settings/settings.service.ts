import { dbService } from '../../database/db';
import { AuditService } from '../audit/audit.service';

/**
 * Older databases (provisioned by src/database/mysql_migrator.ts) store the same
 * settings under lower-case names. Reads fall back to these aliases so the app
 * works against either generation of the settings table without rewriting data.
 */
const KEY_ALIASES: Record<string, string> = {
  BUSINESS_NAME: 'restaurant_name',
  CURRENCY_SYMBOL: 'currency_symbol',
  TAX_PERCENTAGE: 'tax_rate_percentage',
  BUSINESS_GSTIN: 'tax_identification_number',
  RECEIPT_HEADER: 'receipt_header_title',
  RECEIPT_FOOTER: 'receipt_footer_note',
  BUSINESS_PHONE: 'receipt_phone',
  BUSINESS_ADDRESS: 'receipt_address',
  RECEIPT_PAPER_WIDTH: 'thermal_printer_paper_width',
};

/**
 * The Printer / Notification / Invoice settings screens each persist one JSON
 * row. These maps spread that row back out over flat keys on the public
 * settings payload, so a consumer can read `PRINTER_RECEIPT_WIDTH` without
 * having to know it lives inside `system_printer`.
 */
const EXTENDED_MODULE_FIELDS: Record<string, Record<string, string>> = {
  system_printer: {
    receiptEnabled: 'PRINTER_RECEIPT_ENABLED',
    receiptName: 'PRINTER_RECEIPT_NAME',
    receiptPaperWidth: 'PRINTER_RECEIPT_WIDTH',
    receiptAutoPrint: 'PRINTER_RECEIPT_AUTO',
    receiptCopies: 'PRINTER_RECEIPT_COPIES',
    kitchenEnabled: 'PRINTER_KITCHEN_ENABLED',
    kitchenName: 'PRINTER_KITCHEN_NAME',
    kitchenPaperWidth: 'PRINTER_KITCHEN_WIDTH',
    kitchenAutoPrint: 'PRINTER_KITCHEN_AUTO',
    kitchenCopies: 'PRINTER_KITCHEN_COPIES',
    barEnabled: 'PRINTER_BAR_ENABLED',
    barName: 'PRINTER_BAR_NAME',
    barPaperWidth: 'PRINTER_BAR_WIDTH',
    barAutoPrint: 'PRINTER_BAR_AUTO',
    barCopies: 'PRINTER_BAR_COPIES',
    connection: 'PRINTER_CONNECTION',
    deviceIp: 'PRINTER_DEVICE_IP',
    devicePort: 'PRINTER_DEVICE_PORT',
    charset: 'PRINTER_CHARSET',
    density: 'PRINTER_DENSITY',
    autoCut: 'PRINTER_AUTO_CUT',
    cashDrawer: 'PRINTER_CASH_DRAWER',
    buzzer: 'PRINTER_BUZZER',
    feedLines: 'PRINTER_FEED_LINES',
  },
  system_notification: {
    newOrder: 'NOTIFY_NEW_ORDER',
    orderReady: 'NOTIFY_ORDER_READY',
    billVoided: 'NOTIFY_BILL_VOID',
    lowStock: 'NOTIFY_LOW_STOCK',
    lowStockThreshold: 'NOTIFY_LOW_STOCK_THRESHOLD',
    dayClose: 'NOTIFY_DAY_CLOSE',
    channelInApp: 'NOTIFY_CHANNEL_INAPP',
    channelDesktop: 'NOTIFY_CHANNEL_DESKTOP',
    channelEmail: 'NOTIFY_CHANNEL_EMAIL',
    emailRecipients: 'NOTIFY_EMAIL_RECIPIENTS',
    channelSms: 'NOTIFY_CHANNEL_SMS',
    smsRecipients: 'NOTIFY_SMS_RECIPIENTS',
    sound: 'NOTIFY_SOUND',
    soundTone: 'NOTIFY_SOUND_TONE',
    quietStart: 'NOTIFY_QUIET_START',
    quietEnd: 'NOTIFY_QUIET_END',
    dailySummary: 'NOTIFY_DAILY_SUMMARY',
    dailySummaryTime: 'NOTIFY_DAILY_SUMMARY_TIME',
  },
  system_invoice: {
    prefix: 'INVOICE_PREFIX',
    nextNumber: 'INVOICE_NEXT_NUMBER',
    padLength: 'INVOICE_PAD_LENGTH',
    resetCycle: 'INVOICE_RESET_CYCLE',
    title: 'INVOICE_TITLE',
    paperSize: 'INVOICE_PAPER_SIZE',
    dateFormat: 'INVOICE_DATE_FORMAT',
    decimals: 'INVOICE_DECIMALS',
    currencyPosition: 'INVOICE_CURRENCY_POSITION',
    showLogo: 'INVOICE_SHOW_LOGO',
    showTaxBreakdown: 'INVOICE_SHOW_TAX_BREAKDOWN',
    showQr: 'INVOICE_SHOW_QR',
    upiId: 'INVOICE_UPI_ID',
    showSignature: 'INVOICE_SHOW_SIGNATURE',
    signatory: 'INVOICE_SIGNATORY',
    dueDays: 'INVOICE_DUE_DAYS',
    terms: 'INVOICE_TERMS',
    footerNote: 'INVOICE_FOOTER_NOTE',
  },
};

export class SettingsService {
  /** Reads a setting by its canonical key, falling back to the legacy alias. */
  static async getValue(canonicalKey: string): Promise<string | null> {
    const alias = KEY_ALIASES[canonicalKey];
    const keys = alias ? [canonicalKey, alias] : [canonicalKey];
    const placeholders = keys.map(() => '?').join(', ');
    const rows = await dbService.query<{ key: string; value: string }>(
      `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` IN (${placeholders})`,
      keys
    );
    // Canonical key wins when both are present.
    const exact = rows.find((r) => r.key === canonicalKey);
    return (exact ?? rows[0])?.value ?? null;
  }

  /** Adds canonical aliases onto a settings map so lookups find either spelling. */
  static applyKeyAliases(map: Record<string, string>): Record<string, string> {
    for (const [canonical, alias] of Object.entries(KEY_ALIASES)) {
      if (map[canonical] === undefined && map[alias] !== undefined) {
        map[canonical] = map[alias];
      }
    }
    return map;
  }

  /**
   * Categories for the legacy lower-case keys. Without these the prefix rules
   * below classify every legacy key as GENERAL, and getAll() would rewrite the
   * stored category on read.
   */
  private static readonly LEGACY_CATEGORIES: Record<string, 'GENERAL' | 'TAX' | 'RECEIPT' | 'POS' | 'THEME'> = {
    restaurant_name: 'GENERAL',
    currency_symbol: 'GENERAL',
    tax_rate_percentage: 'TAX',
    tax_identification_number: 'TAX',
    receipt_header_title: 'RECEIPT',
    receipt_tagline: 'RECEIPT',
    receipt_footer_note: 'RECEIPT',
    receipt_phone: 'RECEIPT',
    receipt_address: 'RECEIPT',
    thermal_printer_paper_width: 'RECEIPT',
  };

  /** Helper to determine the standard category based on setting key naming conventions */
  public static getCategoryForKey(key: string): 'GENERAL' | 'TAX' | 'RECEIPT' | 'POS' | 'THEME' {
    if (this.LEGACY_CATEGORIES[key]) return this.LEGACY_CATEGORIES[key];
    if (
      key === 'system_theme' ||
      key === 'SYSTEM_THEME' ||
      key.startsWith('THEME_') ||
      ['theme', 'primaryColor', 'primaryHover', 'background', 'surface', 'text', 'secondaryText', 'border', 'icon', 'logoUrl', 'favicon'].includes(key)
    ) {
      return 'THEME';
    }
    if (key === 'system_toast' || key === 'SYSTEM_TOAST' || key.startsWith('TOAST_')) return 'POS';
    if (key === 'system_notification' || key === 'SYSTEM_NOTIFICATION' || key.startsWith('NOTIFY_')) return 'POS';
    if (key === 'system_printer' || key === 'SYSTEM_PRINTER' || key.startsWith('PRINTER_')) return 'RECEIPT';
    if (key === 'system_invoice' || key === 'SYSTEM_INVOICE' || key.startsWith('INVOICE_')) return 'RECEIPT';
    if (key === 'system_hardware' || key === 'SYSTEM_HARDWARE' || key.startsWith('RECEIPT_')) return 'RECEIPT';
    if (key === 'system_business' || key === 'SYSTEM_BUSINESS' || key.startsWith('TAX_') || key.startsWith('BUSINESS_') || key.startsWith('CURRENCY_')) return 'GENERAL';
    if (key.startsWith('POS_')) return 'POS';
    return 'GENERAL';
  }

  /** Objects/arrays (e.g. the `system_theme` palette) are stored as JSON text, everything else as a plain string. */
  private static serialize(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  static async getAll() {
    const rows = await dbService.query<any>('SELECT * FROM settings ORDER BY category ASC, `key` ASC');
    const grouped: Record<string, Record<string, string>> = {
      GENERAL: {},
      THEME: {},
      POS: {},
      TAX: {},
      RECEIPT: {},
    };

    for (const r of rows) {
      const correctCategory = this.getCategoryForKey(r.key);
      if (r.category !== correctCategory) {
        r.category = correctCategory;
        try {
          await dbService.execute('UPDATE settings SET category = ? WHERE id = ?', [correctCategory, r.id]);
        } catch (_) {}
      }

      if (!grouped[r.category]) {
        grouped[r.category] = {};
      }
      grouped[r.category][r.key] = r.value;
    }

    return grouped;
  }

  static async getPublicSettings() {
    const rows = await dbService.query<any>(
      "SELECT `key`, `value`, category FROM settings"
    );
    const settingsMap: Record<string, string> = {};
    for (const r of rows) {
      settingsMap[r.key] = r.value;
    }

    // Unpack system_business JSON onto settingsMap for legacy/computed compatibility
    if (settingsMap['system_business']) {
      try {
        const b = typeof settingsMap['system_business'] === 'string'
          ? JSON.parse(settingsMap['system_business'])
          : settingsMap['system_business'];
        if (b && typeof b === 'object') {
          const name = b.restaurant_name || b.businessName || '';
          const phone = b.receipt_phone || b.businessPhone || '';
          const email = b.businessEmail || '';
          const address = b.receipt_address || b.businessAddress || '';
          const gstin = b.tax_identification_number || b.businessGstin || '';
          const currency = b.currency_symbol || b.currencySymbol || '₹';
          const taxRate = b.tax_rate_percentage !== undefined ? b.tax_rate_percentage : (b.taxPercentage !== undefined ? b.taxPercentage : 5);
          const header = b.receipt_header_title || b.receiptHeader || name;
          const tagline = b.receipt_tagline || b.receiptTagline || '';
          const footer = b.receipt_footer_note || b.receiptFooter || 'Thank you for dining with us! Come again.';

          if (name) {
            settingsMap['BUSINESS_NAME'] = name;
            settingsMap['restaurant_name'] = name;
          }
          if (phone) {
            settingsMap['BUSINESS_PHONE'] = phone;
            settingsMap['receipt_phone'] = phone;
          }
          if (email) settingsMap['BUSINESS_EMAIL'] = email;
          if (address) {
            settingsMap['BUSINESS_ADDRESS'] = address;
            settingsMap['receipt_address'] = address;
          }
          if (gstin) {
            settingsMap['BUSINESS_GSTIN'] = gstin;
            settingsMap['tax_identification_number'] = gstin;
          }
          if (currency) {
            settingsMap['CURRENCY_SYMBOL'] = currency;
            settingsMap['currency_symbol'] = currency;
          }
          if (taxRate !== undefined) {
            settingsMap['TAX_PERCENTAGE'] = String(taxRate);
            settingsMap['tax_rate_percentage'] = String(taxRate);
          }
          if (header) {
            settingsMap['RECEIPT_HEADER'] = header;
            settingsMap['receipt_header_title'] = header;
          }
          if (tagline) {
            settingsMap['RECEIPT_TAGLINE'] = tagline;
            settingsMap['receipt_tagline'] = tagline;
          }
          if (footer) {
            settingsMap['RECEIPT_FOOTER'] = footer;
            settingsMap['receipt_footer_note'] = footer;
          }
          if (b.taxEnabled !== undefined) settingsMap['TAX_ENABLED'] = String(b.taxEnabled);
          if (b.taxName) settingsMap['TAX_NAME'] = b.taxName;
          if (b.allowNegativeStock !== undefined) settingsMap['POS_ALLOW_NEGATIVE_STOCK'] = String(b.allowNegativeStock);
          if (b.defaultOrderType) settingsMap['POS_DEFAULT_ORDER_TYPE'] = b.defaultOrderType;
        }
      } catch (_) {}
    }


    // Unpack system_branding JSON (brand logo, login image, favicon, window title)
    if (settingsMap['system_branding']) {
      try {
        const br = typeof settingsMap['system_branding'] === 'string'
          ? JSON.parse(settingsMap['system_branding'])
          : settingsMap['system_branding'];
        if (br && typeof br === 'object') {
          if (br.logo) settingsMap['BRANDING_LOGO'] = br.logo;
          if (br.loginImage) settingsMap['BRANDING_LOGIN_IMAGE'] = br.loginImage;
          if (br.favicon) settingsMap['BRANDING_FAVICON'] = br.favicon;
          if (br.appTitle) settingsMap['BRANDING_APP_TITLE'] = br.appTitle;
        }
      } catch (_) {}
    }
    // Unpack system_hardware JSON onto settingsMap
    if (settingsMap['system_hardware']) {
      try {
        const h = typeof settingsMap['system_hardware'] === 'string'
          ? JSON.parse(settingsMap['system_hardware'])
          : settingsMap['system_hardware'];
        if (h && typeof h === 'object') {
          if (h.receiptHeader || h.receipt_header_title) {
            settingsMap['RECEIPT_HEADER'] = h.receiptHeader || h.receipt_header_title;
            settingsMap['receipt_header_title'] = settingsMap['RECEIPT_HEADER'];
          }
          if (h.receiptTagline || h.receipt_tagline) {
            settingsMap['RECEIPT_TAGLINE'] = h.receiptTagline || h.receipt_tagline;
            settingsMap['receipt_tagline'] = settingsMap['RECEIPT_TAGLINE'];
          }
          if (h.receiptFooter || h.receipt_footer_note) {
            settingsMap['RECEIPT_FOOTER'] = h.receiptFooter || h.receipt_footer_note;
            settingsMap['receipt_footer_note'] = settingsMap['RECEIPT_FOOTER'];
          }
          if (h.receiptPaperWidth || h.thermal_printer_paper_width) {
            settingsMap['RECEIPT_PAPER_WIDTH'] = h.receiptPaperWidth || h.thermal_printer_paper_width;
            settingsMap['thermal_printer_paper_width'] = settingsMap['RECEIPT_PAPER_WIDTH'];
          }
          if (h.receiptShowCustomer !== undefined) settingsMap['RECEIPT_SHOW_CUSTOMER'] = String(h.receiptShowCustomer);
          if (h.posSoundEffects !== undefined) settingsMap['POS_SOUND_EFFECTS'] = String(h.posSoundEffects);
        }
      } catch (_) {}
    }

    // Unpack system_toast JSON onto settingsMap
    if (settingsMap['system_toast']) {
      try {
        const t = typeof settingsMap['system_toast'] === 'string'
          ? JSON.parse(settingsMap['system_toast'])
          : settingsMap['system_toast'];
        if (t && typeof t === 'object') {
          if (t.position) settingsMap['TOAST_POSITION'] = t.position;
          if (t.duration) settingsMap['TOAST_DURATION'] = String(t.duration);
          if (t.maxVisible) settingsMap['TOAST_MAX_VISIBLE'] = String(t.maxVisible);
          if (t.showClose !== undefined) settingsMap['TOAST_SHOW_CLOSE'] = String(t.showClose);
          if (t.pauseOnHover !== undefined) settingsMap['TOAST_PAUSE_HOVER'] = String(t.pauseOnHover);
          if (t.animation) settingsMap['TOAST_ANIMATION'] = t.animation;
        }
      } catch (_) {}
    }

    // Unpack system_theme JSON onto settingsMap
    if (settingsMap['system_theme'] || settingsMap['SYSTEM_THEME']) {
      try {
        const raw = settingsMap['system_theme'] || settingsMap['SYSTEM_THEME'];
        const th = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (th && typeof th === 'object') {
          const themeName = th.activePresetKey || th.theme || 'purple';
          const primaryColor = th.primary || th.primaryColor || '#7E22CE';
          const primaryHover = th.primaryHover || '#9333EA';
          const sidebarBg = th.sidebarBg || '#2E1065';
          const sidebarText = th.sidebarText || '#FAF5FF';
          const sidebarActiveAccent = th.sidebarActiveAccent || th.icon || '#C084FC';
          const background = th.bgApp || th.background || '#FAF5FF';
          const surface = th.cardBg || th.surface || '#FFFFFF';
          const cardBorder = th.cardBorder || th.border || '#E9D5FF';
          const text = th.textMain || th.text || '#2E1065';
          const secondaryText = th.sidebarText || th.secondaryText || '#FAF5FF';
          const success = th.success || '#16A34A';
          const danger = th.danger || '#DC2626';
          const warning = th.warning || '#EA580C';
          const logoUrl = th.logoUrl || settingsMap['logoUrl'] || settingsMap['THEME_LOGO_URL'] || '';
          const favicon = th.favicon || settingsMap['favicon'] || settingsMap['THEME_FAVICON'] || '';

          settingsMap['theme'] = themeName;
          settingsMap['primaryColor'] = primaryColor;
          settingsMap['primaryHover'] = primaryHover;
          settingsMap['background'] = background;
          settingsMap['surface'] = surface;
          settingsMap['text'] = text;
          settingsMap['secondaryText'] = secondaryText;
          settingsMap['border'] = cardBorder;
          settingsMap['icon'] = sidebarActiveAccent;
          if (logoUrl) settingsMap['logoUrl'] = logoUrl;
          if (favicon) settingsMap['favicon'] = favicon;

          settingsMap['THEME_PRIMARY_COLOR'] = primaryColor;
          settingsMap['THEME_PRIMARY_HOVER'] = primaryHover;
          settingsMap['THEME_SIDEBAR_BG'] = sidebarBg;
          settingsMap['THEME_SIDEBAR_TEXT'] = sidebarText;
          settingsMap['THEME_SIDEBAR_ACCENT'] = sidebarActiveAccent;
          settingsMap['THEME_APP_BG'] = background;
          settingsMap['THEME_CARD_BG'] = surface;
          settingsMap['THEME_CARD_BORDER'] = cardBorder;
          settingsMap['THEME_TEXT_MAIN'] = text;
          settingsMap['THEME_SUCCESS_COLOR'] = success;
          settingsMap['THEME_DANGER_COLOR'] = danger;
          settingsMap['THEME_WARNING_COLOR'] = warning;
        }
      } catch (_) {}
    }

    // Unpack the Printer / Notification / Invoice JSON rows onto their flat keys
    for (const [rawKey, fields] of Object.entries(EXTENDED_MODULE_FIELDS)) {
      const raw = settingsMap[rawKey] || settingsMap[rawKey.toUpperCase()];
      if (!raw) continue;
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object') continue;
        for (const [jsonKey, flatKey] of Object.entries(fields)) {
          if (parsed[jsonKey] !== undefined && parsed[jsonKey] !== null) {
            settingsMap[flatKey] = String(parsed[jsonKey]);
          }
        }
      } catch (_) {}
    }

    // Serve canonical key names alongside legacy ones
    return this.applyKeyAliases(settingsMap);
  }

  static async updateBulk(settings: Record<string, any>, userId: number, tabName?: string) {
    const flatSettings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !['system_theme', 'system_toast', 'system_business', 'system_hardware', 'system_dining_layout', 'system_dish_layout', 'system_pos_design', 'system_category_layout', 'system_stock_layout', 'system_customer_layout', 'system_staff_layout', 'system_sidebar_layout', 'system_customization', 'system_printer', 'system_notification', 'system_invoice'].includes(k) && ['GENERAL', 'THEME', 'POS', 'TAX', 'RECEIPT'].includes(k)) {
        Object.assign(flatSettings, v);
      } else {
        flatSettings[k] = v;
      }
    }

    const entries = Object.entries(flatSettings).filter(([_, v]) => v !== undefined && v !== null);
    const tabLabel = tabName ? ` [Tab: ${tabName.toUpperCase()}]` : '';

    console.log(`\n========================================================================`);
    console.log(`⚙️  [SETTINGS SAVE REQUEST]${tabLabel} | User ID: ${userId} | ${entries.length} setting(s) received`);
    console.log(`========================================================================`);

    const results: { key: string; action: 'UPDATE' | 'INSERT'; category: string; value: string }[] = [];

    await dbService.transaction(async () => {
      for (const [key, value] of entries) {
        const category = this.getCategoryForKey(key);
        const serializedValue = this.serialize(value);

        // 1. Check if the setting key already exists in the settings table
        const existing = await dbService.queryOne<{ id: number; key: string; value: string; category: string }>(
          'SELECT id, `key`, `value`, category FROM settings WHERE `key` = ?',
          [key]
        );

        if (existing) {
          // 2. If the key already exists, UPDATE the existing record
          await dbService.execute(
            'UPDATE settings SET `value` = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE `key` = ?',
            [serializedValue, category, key]
          );
          results.push({ key, action: 'UPDATE', category, value: serializedValue });
          console.log(`  🔄 [DB UPDATE] Key: "${key}" (Category: ${category})`);
          console.log(`     ├─ Previous: "${existing.value}"`);
          console.log(`     └─ New:      "${serializedValue.length > 80 ? serializedValue.substring(0, 77) + '...' : serializedValue}"`);
        } else {
          // 3. If the key does not exist, INSERT a new record (prevents duplicates)
          let description = `${category} Configuration Setting`;
          if (key === 'system_theme') description = 'Full UI theme palette stored as JSON';
          else if (key === 'system_toast') description = 'Toast notification configuration stored as JSON';
          else if (key === 'system_business') description = 'Business, tax & store profile stored as JSON';
          else if (key === 'system_hardware') description = 'Thermal printer & hardware settings stored as JSON';
          else if (key === 'system_branding') description = 'Brand logo, login image, favicon & window title stored as JSON';
          else if (key === 'system_dining_layout') description = 'Dining floor plan design and customization stored as JSON';
          else if (key === 'system_category_layout') description = 'Category page design and customization stored as JSON';
          else if (key === 'system_stock_layout') description = 'Stock Ledger page design and customization stored as JSON';
          else if (key === 'system_customer_layout') description = 'Customer Directory page design and customization stored as JSON';
          else if (key === 'system_staff_layout') description = 'Staff Accounts & Roles page design and customization stored as JSON';
          else if (key === 'system_sidebar_layout') description = 'Sidebar navigation rail template and customization stored as JSON';
          else if (key === 'system_customization') description = 'Per-page customization on/off switches stored as JSON';
          else if (key === 'system_printer') description = 'Print stations, device connection & paper behaviour stored as JSON';
          else if (key === 'system_notification') description = 'Operational alert triggers, channels & quiet hours stored as JSON';
          else if (key === 'system_invoice') description = 'Invoice numbering, document format & printed blocks stored as JSON';

          await dbService.execute(
            "INSERT INTO settings (`key`, `value`, category, description, is_system) VALUES (?, ?, ?, ?, 0)",
            [key, serializedValue, category, description]
          );
          results.push({ key, action: 'INSERT', category, value: serializedValue });
          console.log(`  ➕ [DB INSERT] Key: "${key}" (Category: ${category})`);
          console.log(`     └─ Value:    "${serializedValue.length > 80 ? serializedValue.substring(0, 77) + '...' : serializedValue}"`);
        }

        // When saving system_* JSON keys, purge any legacy individual rows so the database table remains ultra clean
        if (key === 'system_theme' || key === 'SYSTEM_THEME') {
          try {
            await dbService.execute("DELETE FROM settings WHERE `key` LIKE 'THEME_%'");
            console.log(`  🧹 [DB CLEANUP] Purged legacy individual THEME_% rows.`);
          } catch (_) {}
        } else if (key === 'system_toast' || key === 'SYSTEM_TOAST') {
          try {
            await dbService.execute("DELETE FROM settings WHERE `key` LIKE 'TOAST_%'");
            console.log(`  🧹 [DB CLEANUP] Purged legacy individual TOAST_% rows.`);
          } catch (_) {}
        } else if (key === 'system_business' || key === 'SYSTEM_BUSINESS') {
          try {
            await dbService.execute("DELETE FROM settings WHERE `key` LIKE 'BUSINESS_%' OR `key` LIKE 'TAX_%' OR `key` LIKE 'CURRENCY_%' OR `key` IN ('restaurant_name', 'currency_symbol', 'tax_rate_percentage', 'tax_identification_number')");
            console.log(`  🧹 [DB CLEANUP] Purged legacy individual BUSINESS_% & TAX_% rows.`);
          } catch (_) {}
        } else if (key === 'system_hardware' || key === 'SYSTEM_HARDWARE') {
          try {
            await dbService.execute("DELETE FROM settings WHERE `key` LIKE 'RECEIPT_%' OR `key` LIKE 'POS_%' OR `key` IN ('thermal_printer_paper_width', 'receipt_header_title', 'receipt_footer_note', 'receipt_phone', 'receipt_address')");
            console.log(`  🧹 [DB CLEANUP] Purged legacy individual RECEIPT_% & POS_% rows.`);
          } catch (_) {}
        }
      }

      await AuditService.log({
        userId,
        action: 'SETTINGS_UPDATED',
        module: 'SETTINGS',
        newValues: flatSettings,
      });
    });

    // 4. Verify the save landed (MySQL commits on transaction end)
    const verifiedCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM settings');
    const updateCount = results.filter((r) => r.action === 'UPDATE').length;
    const insertCount = results.filter((r) => r.action === 'INSERT').length;

    console.log(`------------------------------------------------------------------------`);
    console.log(`💾 [DB PERSIST VERIFIED] Persisted successfully: ${updateCount} UPDATED, ${insertCount} INSERTED.`);
    console.log(`📊 [DB STATUS] Total settings records in database: ${verifiedCount?.count ?? 0}`);
    console.log(`========================================================================\n`);

    // 5. Return freshly queried grouped settings map to ensure frontend receives updated values
    return await this.getAll();
  }

  static async saveTabSettings(tabName: string | undefined, payload: any, userId: number) {
    const settings = (payload && typeof payload === 'object' && payload.settings) ? payload.settings : payload;
    return await this.updateBulk(settings, userId, tabName);
  }
}
