const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const db = require('../config/database');
const pteroService = require('../services/pterodactyl');
const emailService = require('../services/email');
const affiliateService = require('../services/affiliateService');
const debugLogger = require('../services/debugLogger');
const crypto = require('crypto');

// Helper function to get SQL interval based on billing period
function getBillingInterval(billing_period) {
    switch (billing_period) {
        case 'weekly': return '7 DAY';
        case 'quarterly': return '90 DAY';
        case 'yearly': return '365 DAY';
        case 'monthly':
        default: return '30 DAY';
    }
}

// Helper function to get human-readable days for billing period
function getBillingDays(billing_period) {
    switch (billing_period) {
        case 'weekly': return 7;
        case 'quarterly': return 90;
        case 'yearly': return 365;
        case 'monthly':
        default: return 30;
    }
}

// Dashboard Home
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const conn = await db.getConnection();
        const servers = await conn.query("SELECT * FROM active_servers WHERE user_id = ?", [req.session.user.id]);

        // Get generic user data/balance if needed
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        conn.release();

        res.render('dashboard/index', {
            servers: servers,
            balance: user[0].balance
        });
    } catch (err) {
        console.error(err);
        res.redirect('/auth/login');
    }
});

// Set Currency Preference
router.post('/set-currency', ensureAuthenticated, (req, res) => {
    const { currency } = req.body;
    if (currency) {
        req.session.currency = currency;
    }
    const referer = req.get('Referer') || '/dashboard/store';
    res.redirect(referer);
});

// Store / Plans
router.get('/store', ensureAuthenticated, async (req, res) => {
    try {
        const conn = await db.getConnection();
        const categories = await conn.query("SELECT * FROM categories");
        const plans = await conn.query("SELECT * FROM Plans WHERE is_visible = 1");

        // Regional Pricing Logic
        const userCurrency = req.session.currency || 'USD';
        let currencyRate = 1.0;
        let currencySymbol = '$';

        if (userCurrency !== 'USD') {
            const currencyData = await conn.query("SELECT * FROM currencies WHERE code = ?", [userCurrency]);
            if (currencyData.length > 0) {
                currencyRate = currencyData[0].rate_to_usd;
                currencySymbol = currencyData[0].symbol;

                // Fetch overrides
                const overrides = await conn.query("SELECT plan_id, price FROM plan_prices WHERE currency_code = ?", [userCurrency]);

                // Merge Logic
                plans.forEach(plan => {
                    const override = overrides.find(o => o.plan_id === plan.id);
                    if (override) {
                        plan.displayPrice = override.price;
                    } else {
                        plan.displayPrice = (plan.price * currencyRate).toFixed(2);
                    }
                    plan.displaySymbol = currencySymbol;
                });
            } else {
                // Fallback
                plans.forEach(p => { p.displayPrice = p.price; p.displaySymbol = '$'; });
            }
        } else {
            plans.forEach(p => { p.displayPrice = p.price; p.displaySymbol = '$'; });
        }

        conn.release();

        res.render('dashboard/store', {
            categories: categories,
            plans: plans
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

// Checkout Page
router.get('/checkout/:id', ensureAuthenticated, async (req, res) => {
    try {
        const conn = await db.getConnection();
        const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [req.params.id]);

        // Get Regional Pricing from Locations Table logic
        let regions = await conn.query("SELECT * FROM locations WHERE is_public = 1");

        if (regions.length === 0) {
            // Fallback
            regions = [{ id: 1, short: 'DEF', long: 'Default Location', multiplier: 1.0, currency_symbol: '$', currency_code: 'USD', exchange_rate: 1.0, is_public: true, is_sold_out: false }];
        } else {
            // Map view compatibility - include currency data
            regions = regions.map(r => ({
                ...r,
                long: r.long_name || r.short,
                multiplier: parseFloat(r.multiplier) || 1.0,
                currency_symbol: r.currency_symbol || '$',
                currency_code: r.currency_code || 'USD',
                exchange_rate: parseFloat(r.exchange_rate) || 1.0
            }));
        }

        if (plan.length === 0) {
            conn.release();
            return res.redirect('/dashboard/store');
        }

        // Get user for balance display
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);

        // Currency Logic - Use user's preferred_currency from database
        const userCurrency = user[0].preferred_currency || req.session.currency || 'USD';
        let currencyRate = 1.0;

        // Currency symbol map for common currencies
        const currencySymbols = {
            'USD': '$', 'INR': '₹', 'EUR': '€', 'GBP': '£',
            'JPY': '¥', 'AUD': 'A$', 'CAD': 'C$', 'CNY': '¥',
            'SGD': 'S$', 'AED': 'د.إ', 'BRL': 'R$', 'MXN': 'MX$'
        };
        let currencySymbol = currencySymbols[userCurrency] || '$';

        console.log('[Checkout] User currency:', userCurrency, 'Symbol:', currencySymbol);

        if (userCurrency !== 'USD') {
            const currencyData = await conn.query("SELECT * FROM currencies WHERE code = ?", [userCurrency]);
            if (currencyData.length > 0) {
                currencyRate = currencyData[0].rate_to_usd;
                currencySymbol = currencyData[0].symbol || currencySymbol;

                // Check Override
                const priceOverride = await conn.query("SELECT price FROM plan_prices WHERE plan_id = ? AND currency_code = ?", [plan[0].id, userCurrency]);
                if (priceOverride.length > 0) {
                    plan[0].price = priceOverride[0].price; // Override base price
                    // Note: Multipliers will apply to this new base
                } else {
                    plan[0].price = (plan[0].price * currencyRate).toFixed(2);
                }
            }
        }

        // Pass symbols to view for JS
        plan[0].currencySymbol = currencySymbol;

        // Get Tax Info
        const taxSettings = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate', 'tax_name')");
        const taxRate = parseFloat(taxSettings.find(s => s.setting_key === 'tax_rate')?.setting_value || 0);
        const taxName = taxSettings.find(s => s.setting_key === 'tax_name')?.setting_value || 'Tax';

        // Fetch Gateways
        const gateways = await conn.query("SELECT * FROM payment_gateways WHERE enabled = 1");

        conn.release();

        // Check for success flag
        let successData = null;
        if (req.query.success) {
            console.log('[Checkout View] Success query param detected.');
            if (req.session.checkoutSuccess) {
                console.log('[Checkout View] Session success data found:', req.session.checkoutSuccess);
                successData = req.session.checkoutSuccess;
                delete req.session.checkoutSuccess;
            } else {
                console.log('[Checkout View] Session success data MISSING');
            }
        }

        // Check for failure flag
        let failureData = null;
        if (req.query.failure) {
            console.log('[Checkout View] Failure query param detected.');
            if (req.session.checkoutFailure) {
                console.log('[Checkout View] Session failure data found:', req.session.checkoutFailure);
                failureData = req.session.checkoutFailure;
                delete req.session.checkoutFailure;
            } else {
                console.log('[Checkout View] Session failure data MISSING');
            }
        }

        res.render('dashboard/checkout', {
            plan: plan[0],
            regions: regions,
            user: user[0],
            taxRate,
            taxName,
            gateways,
            currentCurrency: userCurrency,
            success: successData,
            failure: failureData,
            allowEggSelection: plan[0].allow_egg_selection  // Use plan setting
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard/store');
    }
});


// API: Get Nests for User (Checkout)
router.get('/api/nests', ensureAuthenticated, async (req, res) => {
    try {
        const nests = await pteroService.getNests();
        res.json(nests);
    } catch (err) {
        console.error('Error fetching nests:', err.message);
        res.status(500).json({ error: 'Failed to fetch server categories' });
    }
});

// API: Get Eggs for User (Checkout)
router.get('/api/eggs/:nestId', ensureAuthenticated, async (req, res) => {
    try {
        const eggs = await pteroService.getEggs(req.params.nestId);
        res.json(eggs);
    } catch (err) {
        console.error('Error fetching eggs:', err.message);
        res.status(500).json({ error: 'Failed to fetch server types' });
    }
});

// API: Validate Coupon
router.post('/api/validate-coupon', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const { code } = req.body;
        conn = await db.getConnection();
        const coupon = await conn.query("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [code]);

        if (coupon.length === 0) {
            conn.release();
            return res.json({ valid: false, message: 'Invalid code.' });
        }

        const maxUses = Number(coupon[0].max_uses);
        const currentUses = Number(coupon[0].uses);
        if (maxUses > 0 && currentUses >= maxUses) {
            conn.release();
            return res.json({ valid: false, message: 'Coupon usage limit reached.' });
        }
        conn.release();
        res.json({ valid: true, discount: coupon[0].discount_percent });
    } catch (err) {
        console.error(err);
        res.status(500).json({ valid: false, message: 'Server error.' });
        if (conn) conn.release();
    }
});

// Process Checkout
router.post('/checkout/:id', ensureAuthenticated, async (req, res) => {
    const planId = req.params.id;
    const { region, server_name, billing_address, gst_number, coupon_code, user_nest_id, user_egg_id } = req.body;

    let conn;
    try {
        conn = await db.getConnection();
        const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [planId]);
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);

        // Get Tax Settings
        const settings = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate', 'tax_name')");
        const taxRate = parseFloat(settings.find(s => s.setting_key === 'tax_rate')?.setting_value || 0);

        if (plan.length === 0) throw new Error('Invalid Plan');

        // Fetch Region
        const regionData = await conn.query("SELECT * FROM locations WHERE id = ?", [region]);

        if (regionData.length === 0 || !regionData[0].is_public || regionData[0].is_sold_out) {
            throw new Error("Invalid or Sold Out Region");
        }
        const selectedRegion = regionData[0];

        // Financials Logic (Currency Aware)
        const userCurrency = user[0].preferred_currency || req.session.currency || 'USD';
        let currencyRate = 1.0;
        let basePlanPrice = plan[0].price;
        const originalPlanPrice = plan[0].price; // Keep original for logging

        console.log('[Checkout POST] ========== PRICING DEBUG ==========');
        console.log('[Checkout POST] User currency:', userCurrency);
        console.log('[Checkout POST] Original plan price (USD):', originalPlanPrice);

        // Determine Base Price based on Currency
        let priceOverrideUsed = false;
        if (userCurrency !== 'USD') {
            const currencyData = await conn.query("SELECT * FROM currencies WHERE code = ?", [userCurrency]);
            if (currencyData.length > 0) {
                currencyRate = currencyData[0].rate_to_usd;
                console.log('[Checkout POST] Currency rate (1 USD =', currencyRate, userCurrency + ')');

                // Check Price Override
                const priceOverride = await conn.query("SELECT price FROM plan_prices WHERE plan_id = ? AND currency_code = ?", [planId, userCurrency]);
                if (priceOverride.length > 0) {
                    basePlanPrice = priceOverride[0].price;
                    priceOverrideUsed = true;
                    console.log('[Checkout POST] Using price OVERRIDE:', basePlanPrice, userCurrency);
                } else {
                    basePlanPrice = (basePlanPrice * currencyRate).toFixed(2);
                    console.log('[Checkout POST] Converted price (auto):', basePlanPrice, userCurrency);
                }
            }
        } else {
            console.log('[Checkout POST] User is using USD, no conversion needed');
        }

        // Apply Region Multiplier to Base Price (in user currency)
        console.log('[Checkout POST] Region multiplier:', selectedRegion.multiplier || 1.0);
        let subtotal = basePlanPrice * (selectedRegion.multiplier || 1.0);
        console.log('[Checkout POST] Subtotal after multiplier:', subtotal, userCurrency);

        // Handle Coupon logic
        let discountPercent = 0;
        let couponId = null;
        if (coupon_code) {
            const coupon = await conn.query("SELECT * FROM coupons WHERE code = ? AND is_active = 1", [coupon_code]);
            if (coupon.length > 0) {
                const maxUses = Number(coupon[0].max_uses);
                const currentUses = Number(coupon[0].uses);
                if (maxUses === 0 || currentUses < maxUses) {
                    discountPercent = Number(coupon[0].discount_percent);
                    couponId = coupon[0].id;
                }
            }
        }

        const discountAmount = subtotal * (discountPercent / 100);
        subtotal = subtotal - discountAmount; // Apply Discount

        const taxAmount = subtotal * (taxRate / 100);
        const finalPrice = subtotal + taxAmount; // In User Currency

        console.log('[Checkout POST] Tax rate:', taxRate, '% | Tax amount:', taxAmount.toFixed(2));
        console.log('[Checkout POST] Final price:', finalPrice.toFixed(2), userCurrency);
        console.log('[Checkout POST] ====================================');

        // Check Balance if paying with Credits
        const paymentMethod = req.body.payment_method || 'credits';
        // Calculate USD price for balance operations (used later after successful server creation)
        const priceInUSD = finalPrice / currencyRate;


        if (paymentMethod === 'credits') {
            if (parseFloat(user[0].balance) < priceInUSD) {
                req.flash('error_msg', `Insufficient Balance. Total is $${priceInUSD.toFixed(2)} USD (${finalPrice.toFixed(2)} ${userCurrency}) incl. tax. Please add funds.`);
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }
            // NOTE: Balance deduction moved to AFTER successful server creation to prevent losing money on failures
        } else if (paymentMethod === 'phonepe') {
            // PhonePe Payment Gateway Integration using Official SDK
            console.log('[PhonePe] Starting payment initiation...');
            debugLogger.phonepe('REQUEST', 'Starting PhonePe payment initiation', { planId, finalPrice, userCurrency });

            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe' AND enabled = 1");
            console.log('[PhonePe] Gateway query result:', gateway.length > 0 ? 'Found' : 'Not found');

            if (gateway.length === 0) {
                debugLogger.phonepe('ERROR', 'PhonePe gateway not enabled');
                req.flash('error_msg', 'PhonePe payment method is not available.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            console.log('[PhonePe] Raw gateway config:', gateway[0].config);
            console.log('[PhonePe] Config type:', typeof gateway[0].config);

            let gatewayConfig;
            // Handle both object and string config formats
            if (typeof gateway[0].config === 'object' && gateway[0].config !== null) {
                gatewayConfig = gateway[0].config;
                console.log('[PhonePe] Config is already an object');
            } else {
                try {
                    gatewayConfig = JSON.parse(gateway[0].config || '{}');
                    console.log('[PhonePe] Parsed config from JSON string');
                } catch (e) {
                    console.error('[PhonePe] Config parse error:', e.message);
                    debugLogger.phonepe('ERROR', 'Failed to parse gateway config', { error: e.message });
                    gatewayConfig = {};
                }
            }
            console.log('[PhonePe] Parsed config keys:', Object.keys(gatewayConfig));

            console.log('[PhonePe] Config check - clientId:', gatewayConfig.clientId ? 'SET' : 'MISSING');
            console.log('[PhonePe] Config check - clientSecret:', gatewayConfig.clientSecret ? 'SET (hidden)' : 'MISSING');
            console.log('[PhonePe] Config check - clientVersion:', gatewayConfig.clientVersion || 'DEFAULT (1)');
            console.log('[PhonePe] Config check - environment:', gatewayConfig.environment || 'sandbox');

            if (!gatewayConfig.clientId || !gatewayConfig.clientSecret) {
                console.error('[PhonePe] ERROR: Missing clientId or clientSecret!');
                debugLogger.phonepe('ERROR', 'Missing clientId or clientSecret in config');
                req.flash('error_msg', 'PhonePe is not properly configured. Please contact support.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            // Store pending payment details in session for callback
            const merchantOrderId = 'ORD' + Date.now() + user[0].id;
            req.session.pendingPayment = {
                merchantOrderId,
                planId,
                server_name,
                region,
                billing_address,
                gst_number,
                coupon_code,
                finalPrice,
                currencyRate,
                userCurrency,
                taxRate,
                taxAmount: subtotal * (taxRate / 100),
                subtotal,
                couponId,
                selectedRegion,
                userEnvOverrides: {}
            };

            // Build user env overrides
            for (const key in req.body) {
                if (key.startsWith('env_')) {
                    req.session.pendingPayment.userEnvOverrides[key.substring(4)] = req.body[key];
                }
            }

            conn.release();

            // Use PhonePe Official SDK
            try {
                const { StandardCheckoutClient, Env, MetaInfo, CreateSdkOrderRequest } = require('pg-sdk-node');

                const merchantId = gatewayConfig.clientId;
                let saltKey = gatewayConfig.clientSecret;
                let saltIndex = parseInt(gatewayConfig.clientVersion) || 1;

                // Smart Salt Detection: Check if key has ### index suffix
                if (saltKey && saltKey.includes('###')) {
                    const parts = saltKey.split('###');
                    saltKey = parts[0];
                    saltIndex = parseInt(parts[1]) || saltIndex;
                    console.log(`[PhonePe SDK] Detected salt index from key: ${saltIndex}`);
                }

                const env = gatewayConfig.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;

                console.log('[PhonePe SDK] Initializing with:');
                console.log('[PhonePe SDK]   - merchantId:', merchantId);
                console.log('[PhonePe SDK]   - saltIndex:', saltIndex);
                console.log('[PhonePe SDK]   - environment:', gatewayConfig.environment === 'production' ? 'PRODUCTION' : 'SANDBOX');
                // Mask salt key for logs
                const maskedKey = saltKey ? `${saltKey.substring(0, 4)}...${saltKey.substring(saltKey.length - 4)}` : 'MISSING';
                console.log('[PhonePe SDK]   - saltKey:', maskedKey);

                const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);
                console.log('[PhonePe SDK] Client initialized successfully');

                // PhonePe requires amount in paise (INR smallest unit)
                // Convert from user's currency to INR
                let amountInINR = finalPrice;
                if (userCurrency === 'INR') {
                    // Already in INR
                    amountInINR = finalPrice;
                } else {
                    // Convert from USD to INR (finalPrice is in user currency, get USD first then INR)
                    const priceInUSD = finalPrice / currencyRate;
                    const inrRateData = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = 'INR'");
                    if (inrRateData.length > 0 && inrRateData[0].rate_to_usd) {
                        amountInINR = priceInUSD * parseFloat(inrRateData[0].rate_to_usd);
                    } else {
                        // Fallback: assume 1 USD = 83 INR
                        amountInINR = priceInUSD * 83;
                    }
                }

                const amountInPaise = Math.round(amountInINR * 100);
                const callbackUrl = `${req.protocol}://${req.get('host')}/dashboard/phonepe/callback`;

                console.log('[PhonePe SDK] Order details:');
                console.log('[PhonePe SDK]   - merchantOrderId:', merchantOrderId);
                console.log(`[PhonePe SDK]   - ${userCurrency} ${finalPrice} → INR ${amountInINR.toFixed(2)} → ${amountInPaise} paise`);
                console.log('[PhonePe SDK]   - redirectUrl:', callbackUrl);

                const orderRequest = CreateSdkOrderRequest.StandardCheckoutBuilder()
                    .merchantOrderId(merchantOrderId)
                    .amount(amountInPaise)
                    .redirectUrl(callbackUrl)
                    .build();

                console.log('[PhonePe SDK] Calling client.pay()...');
                const response = await client.pay(orderRequest);
                console.log('[PhonePe SDK] Response:', JSON.stringify(response, null, 2));

                if (response && response.redirectUrl) {
                    console.log('[PhonePe SDK] Payment initiated, redirecting to:', response.redirectUrl);
                    return res.redirect(response.redirectUrl);
                } else {
                    console.error('[PhonePe SDK] No redirect URL in response:', response);
                    req.flash('error_msg', 'Failed to initiate PhonePe payment. Please try again.');
                    return res.redirect('/dashboard/checkout/' + planId);
                }
            } catch (phonepeErr) {
                console.error('[PhonePe SDK] Error:', phonepeErr);
                console.error('[PhonePe SDK] Error message:', phonepeErr.message);
                console.error('[PhonePe SDK] Error stack:', phonepeErr.stack);
                req.flash('error_msg', 'PhonePe payment error: ' + (phonepeErr.message || 'Unknown error'));
                return res.redirect('/dashboard/checkout/' + planId);
            }
        } else if (paymentMethod === 'stripe') {
            // Stripe Payment Gateway Integration
            console.log('[Stripe] Starting payment initiation for checkout...');

            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'Stripe payment method is not available.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

            if (!config.secretKey) {
                console.error('[Stripe] ERROR: Missing secret key!');
                req.flash('error_msg', 'Stripe is not properly configured. Please contact support.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            const stripe = require('stripe')(config.secretKey);

            // Store pending payment details in session for callback
            const merchantOrderId = 'ORD' + Date.now() + user[0].id;
            req.session.pendingPayment = {
                merchantOrderId,
                planId,
                server_name,
                region,
                billing_address,
                gst_number,
                coupon_code,
                finalPrice,
                currencyRate,
                userCurrency,
                taxRate,
                taxAmount: subtotal * (taxRate / 100),
                subtotal,
                couponId,
                selectedRegion,
                userEnvOverrides: {}
            };

            // Build user env overrides
            for (const key in req.body) {
                if (key.startsWith('env_')) {
                    req.session.pendingPayment.userEnvOverrides[key.substring(4)] = req.body[key];
                }
            }

            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data: {
                            currency: userCurrency.toLowerCase(),
                            product_data: {
                                name: plan[0].name,
                                description: `Server: ${server_name}`,
                            },
                            unit_amount: Math.round(finalPrice * 100),
                        },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    success_url: `${req.protocol}://${req.get('host')}/dashboard/stripe/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${req.protocol}://${req.get('host')}/dashboard/checkout/${planId}`,
                    metadata: {
                        order_id: merchantOrderId,
                        plan_id: planId,
                        user_id: user[0].id,
                        type: 'checkout'
                    }
                });

                console.log('[Stripe] Checkout session created:', session.id);
                conn.release();
                return res.redirect(session.url);
            } catch (stripeErr) {
                console.error('[Stripe] Error:', stripeErr);
                req.flash('error_msg', 'Stripe payment error: ' + (stripeErr.message || 'Unknown error'));
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }
        } else if (paymentMethod === 'paypal') {
            // PayPal Payment Gateway Integration
            console.log('[PayPal] Starting payment initiation for checkout...');
            debugLogger.paypal('REQUEST', 'Starting PayPal payment initiation', { planId, finalPrice, userCurrency });

            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal' AND enabled = 1");
            if (gateway.length === 0) {
                debugLogger.paypal('ERROR', 'PayPal gateway not enabled');
                req.flash('error_msg', 'PayPal payment method is not available.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            const paypalConfig = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

            if (!paypalConfig.clientId || !paypalConfig.secret) {
                console.error('[PayPal] ERROR: Missing clientId or secret!');
                debugLogger.paypal('ERROR', 'Missing PayPal credentials');
                req.flash('error_msg', 'PayPal is not properly configured. Please contact support.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }

            // Store pending payment details in session for callback
            const paypalOrderId = 'ORD' + Date.now() + user[0].id;
            req.session.pendingPayment = {
                merchantOrderId: paypalOrderId,
                planId,
                server_name,
                region,
                billing_address,
                gst_number,
                coupon_code,
                finalPrice,
                currencyRate,
                userCurrency,
                taxRate,
                taxAmount: subtotal * (taxRate / 100),
                subtotal,
                couponId,
                selectedRegion,
                userEnvOverrides: {}
            };

            // Build user env overrides
            for (const key in req.body) {
                if (key.startsWith('env_')) {
                    req.session.pendingPayment.userEnvOverrides[key.substring(4)] = req.body[key];
                }
            }

            try {
                const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

                // Initialize PayPal client
                const paypalClient = new Client({
                    clientCredentialsAuthCredentials: {
                        oAuthClientId: paypalConfig.clientId,
                        oAuthClientSecret: paypalConfig.secret
                    },
                    environment: paypalConfig.environment === 'production' ? Environment.Production : Environment.Sandbox
                });

                const ordersController = new OrdersController(paypalClient);

                // Convert price to USD for PayPal (PayPal works best with USD)
                let paypalAmount = finalPrice;
                let paypalCurrency = userCurrency;

                // Determine PayPal supported currency
                const supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'BRL', 'MXN', 'SGD', 'HKD'];
                if (!supportedCurrencies.includes(userCurrency)) {
                    // Convert to USD
                    paypalAmount = finalPrice / currencyRate;
                    paypalCurrency = 'USD';
                }

                const returnUrl = `${req.protocol}://${req.get('host')}/dashboard/paypal/checkout-success`;
                const cancelUrl = `${req.protocol}://${req.get('host')}/dashboard/checkout/${planId}`;

                console.log('[PayPal] Creating order:', {
                    amount: paypalAmount.toFixed(2),
                    currency: paypalCurrency,
                    merchantOrderId: paypalOrderId
                });

                const orderRequest = {
                    body: {
                        intent: 'CAPTURE',
                        purchaseUnits: [{
                            referenceId: paypalOrderId,
                            amount: {
                                currencyCode: paypalCurrency,
                                value: paypalAmount.toFixed(2)
                            },
                            description: `${plan[0].name} - Server: ${server_name}`
                        }],
                        applicationContext: {
                            brandName: 'Plexa',
                            landingPage: 'BILLING',
                            userAction: 'PAY_NOW',
                            returnUrl: returnUrl,
                            cancelUrl: cancelUrl
                        }
                    }
                };

                const orderResponse = await ordersController.createOrder(orderRequest);
                console.log('[PayPal] Order created:', orderResponse.result.id);
                debugLogger.paypal('RESPONSE', 'PayPal order created', { orderId: orderResponse.result.id });

                // Store PayPal order ID in session
                req.session.pendingPayment.paypalOrderId = orderResponse.result.id;

                // Find the approval URL
                const approvalLink = orderResponse.result.links.find(link => link.rel === 'approve');
                if (!approvalLink) {
                    throw new Error('No approval URL found in PayPal response');
                }

                conn.release();
                return res.redirect(approvalLink.href);
            } catch (paypalErr) {
                console.error('[PayPal] Error:', paypalErr);
                debugLogger.paypal('ERROR', 'PayPal payment error', { error: paypalErr.message });
                req.flash('error_msg', 'PayPal payment error: ' + (paypalErr.message || 'Unknown error'));
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }
        } else {
            // Check if gateway is enabled (for other gateways)
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = ? AND enabled = 1", [paymentMethod]);
            if (gateway.length === 0) {
                req.flash('error_msg', 'Selected payment method is not available.');
                if (conn) conn.release();
                return res.redirect('/dashboard/checkout/' + planId);
            }
            // Other gateways not yet implemented
            req.flash('error_msg', 'This payment method is not yet implemented.');
            if (conn) conn.release();
            return res.redirect('/dashboard/checkout/' + planId);
        }


        // UPDATE USER BILLING INFO
        await conn.query("UPDATE users SET billing_address = ?, gst_number = ? WHERE id = ?", [billing_address, gst_number, user[0].id]);

        // Increment Coupon Usage
        if (couponId) {
            await conn.query("UPDATE coupons SET uses = uses + 1 WHERE id = ?", [couponId]);
        }

        // Balance will be deducted AFTER successful server creation

        // HANDLE PTERODACTYL USER
        let pteroId = user[0].ptero_id;
        let pteroPass = null;

        if (!pteroId) {
            // Check if user already exists on Pterodactyl (by email)
            const existingPteroUser = await pteroService.getUser(user[0].email);

            if (existingPteroUser) {
                console.log("Found existing Ptero user:", existingPteroUser.id);
                pteroId = existingPteroUser.id;
            } else {
                // Create new Ptero User
                pteroPass = crypto.randomBytes(8).toString('hex');
                const pteroUser = await pteroService.createUser({
                    email: user[0].email,
                    username: user[0].username
                }, pteroPass);

                pteroId = pteroUser.id;
            }

            // Save Ptero ID to DB
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [pteroId, user[0].id]);
        }

        // Build environment overrides from form (env_VARNAME inputs)
        let userEnvOverrides = {};
        for (const key in req.body) {
            if (key.startsWith('env_')) {
                const envVar = key.substring(4); // Remove 'env_' prefix
                userEnvOverrides[envVar] = req.body[key];
            }
        }

        // Determine egg/nest to use (user selection or plan default)
        const selectedNestId = user_nest_id || plan[0].nest_id;
        const selectedEggId = user_egg_id || plan[0].egg_id;

        // Fetch egg details from Pterodactyl for docker image and startup
        let dockerImage = plan[0].docker_image;
        let startupCmd = plan[0].startup_cmd;
        let eggEnvConfig = plan[0].environment_config;

        // If user selected a different egg, fetch its details from Pterodactyl
        if (user_egg_id && (user_egg_id !== String(plan[0].egg_id) || user_nest_id !== String(plan[0].nest_id))) {
            try {
                const eggDetails = await pteroService.getEggDetails(selectedNestId, selectedEggId);
                if (eggDetails) {
                    // Get first docker image
                    if (eggDetails.docker_images) {
                        const images = Object.values(eggDetails.docker_images);
                        if (images.length > 0) dockerImage = images[0];
                    }
                    if (eggDetails.startup) startupCmd = eggDetails.startup;

                    // Build environment config from egg variables
                    const variables = eggDetails.relationships?.variables?.data || [];
                    const envConfig = {};
                    variables.forEach(v => {
                        envConfig[v.attributes.env_variable] = {
                            value: v.attributes.default_value || '',
                            user_visible: v.attributes.user_viewable
                        };
                    });
                    eggEnvConfig = JSON.stringify(envConfig);
                }
            } catch (eggErr) {
                console.error('[Checkout] Error fetching egg details:', eggErr.message);
                // Fall back to plan defaults
            }
        }

        // CREATE SERVER
        const serverData = {
            name: server_name || `${user[0].username}'s ${plan[0].name}`,
            user_id: pteroId,
            egg_id: selectedEggId,
            nest_id: selectedNestId,
            docker_image: dockerImage,
            startup_cmd: startupCmd,
            // Pass environment config and user overrides
            environment_config: eggEnvConfig,
            user_env_overrides: userEnvOverrides,
            ram: plan[0].ram,
            swap: 0,
            disk: plan[0].disk,
            cpu: plan[0].cpu,
            location_id: selectedRegion.id,
            db_count: plan[0].db_count,
            allocations: plan[0].allocations,
            backups: plan[0].backups
        };

        const pteroServer = await pteroService.createServer(serverData);

        // Save Active Server with server name from Pterodactyl
        const billingInterval = getBillingInterval(plan[0].billing_period);
        const serverInsertResult = await conn.query(`INSERT INTO active_servers 
            (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, renewal_date) 
            VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ${billingInterval}))`,
            [user[0].id, plan[0].id, pteroServer.id, pteroServer.identifier, pteroServer.name, selectedRegion.id]
        );

        // NOW deduct balance for credits payment (only after server created successfully)
        if (paymentMethod === 'credits') {
            await conn.query("UPDATE users SET balance = balance - ? WHERE id = ?", [priceInUSD, user[0].id]);
            console.log(`[Checkout] Balance deducted: $${priceInUSD.toFixed(2)} USD from user ${user[0].id}`);
        }

        // Get the local server ID for invoice linking
        const localServerId = Number(serverInsertResult.insertId);

        // Generate transaction ID for credits payment
        const transactionId = 'TXN_' + Date.now() + '_' + user[0].id;

        // Create Invoice
        // amount = USD equivalent
        // currency_amount = User's currency value
        await conn.query(`INSERT INTO invoices 
            (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
             subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
            VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user[0].id, localServerId, plan[0].id, finalPrice / currencyRate,
                userCurrency,
                finalPrice,
            `${plan[0].name} - ${selectedRegion.long_name || selectedRegion.short}`,
                subtotal, taxRate, taxAmount, billing_address, gst_number, 'credits', transactionId]
        );

        // Store success data for popup on checkout page
        req.session.checkoutSuccess = {
            serverName: pteroServer.name,
            planName: plan[0].name,
            pteroPass,
            transactionId,
            paymentMethod: 'credits'
        };

        // Discord notification
        try {
            const discord = require('../services/discord');
            await discord.planPurchased(plan[0], { username: req.session.user.username }, { server_name: pteroServer.name });
        } catch (e) { console.error('[Discord]', e.message); }

        req.session.save(() => {
            res.redirect('/dashboard/checkout/' + planId + '?success=1');
        });

    } catch (err) {
        console.error("[CHECKOUT ERROR]", err);
        if (err.response) {
            console.error("[CHECKOUT API RESPONSE]", JSON.stringify(err.response.data, null, 2));
        }
        req.flash('error_msg', 'Error processing order: ' + err.message);
        res.redirect('/dashboard/checkout/' + planId);
    } finally {
        if (conn) conn.release();
    }
});

// My Servers
router.get('/servers', ensureAuthenticated, async (req, res) => {
    try {
        const conn = await db.getConnection();
        const servers = await conn.query(`
            SELECT active_servers.*, Plans.name as plan_name, locations.short as location_name
            FROM active_servers 
            LEFT JOIN Plans ON active_servers.plan_id = Plans.id
            LEFT JOIN locations ON active_servers.location_id = locations.id
            WHERE active_servers.user_id = ?
        `, [req.session.user.id]);

        // Get panel URL from settings
        const settings = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'ptero_url'");
        const panelUrl = settings.length > 0 ? settings[0].setting_value : '';
        conn.release();

        res.render('dashboard/servers', { servers, panelUrl });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

// User: Manage Server
router.get('/servers/manage/:id', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const server = await conn.query(`
            SELECT active_servers.*, Plans.name as plan_name, users.username
            FROM active_servers 
            LEFT JOIN Plans ON active_servers.plan_id = Plans.id
            LEFT JOIN users ON active_servers.user_id = users.id
            WHERE active_servers.id = ? AND active_servers.user_id = ?
        `, [req.params.id, req.session.user.id]);

        if (server.length === 0) {
            req.flash('error_msg', 'Server not found.');
            return res.redirect('/dashboard/servers');
        }

        const settings = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'ptero_url'");
        const panelUrl = settings.length > 0 ? settings[0].setting_value : '';

        res.render('dashboard/server_manage', { server: server[0], panelUrl });
    } catch (err) {
        console.error(err);
        require('fs').appendFileSync('debug_error.log', `[Manage Route Error] ${err.message}\n${err.stack}\n\n`);
        res.redirect('/dashboard/servers');
    } finally {
        if (conn) conn.release();
    }
});

// User: Cancel Server
router.post('/servers/cancel/:id', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const server = await conn.query("SELECT * FROM active_servers WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);

        if (server.length === 0) {
            req.flash('error_msg', 'Server not found.');
            return res.redirect('/dashboard/servers');
        }

        // Only update local status to cancelled
        await conn.query("UPDATE active_servers SET status = 'cancelled' WHERE id = ?", [req.params.id]);

        req.flash('success_msg', 'Service cancelled. It will not renew at the end of the billing period.');
        res.redirect('/dashboard/servers/manage/' + req.params.id);
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to cancel service.');
        res.redirect('/dashboard/servers');
    } finally {
        if (conn) conn.release();
    }
});

// User: Retry Failed Server Creation
router.post('/servers/:id/retry', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const serverId = req.params.id;

        // Get the failed server
        const server = await conn.query(`
            SELECT s.id as server_id, s.server_name, s.user_id, s.plan_id, s.status, s.failure_reason, s.location_id,
                   p.egg_id, p.nest_id, p.docker_image, p.startup_cmd, p.environment_config,
                   p.ram, p.disk, p.cpu, p.db_count, p.allocations, p.backups
            FROM active_servers s
            JOIN Plans p ON s.plan_id = p.id
            WHERE s.id = ? AND s.user_id = ? AND s.status = 'failed'
        `, [serverId, req.session.user.id]);

        if (server.length === 0) {
            req.flash('error_msg', 'Server not found or not in failed state.');
            return res.redirect('/dashboard/servers');
        }

        const failedServer = server[0];
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);

        if (user.length === 0) {
            req.flash('error_msg', 'User not found.');
            return res.redirect('/dashboard/servers');
        }

        // Ensure user has Pterodactyl account
        let pteroId = user[0].ptero_id;
        let pteroPass = null;

        if (!pteroId) {
            const existingPteroUser = await pteroService.getUser(user[0].email);
            if (existingPteroUser) {
                pteroId = existingPteroUser.id;
            } else {
                pteroPass = crypto.randomBytes(8).toString('hex');
                const pteroUser = await pteroService.createUser({
                    email: user[0].email,
                    username: user[0].username
                }, pteroPass);
                pteroId = pteroUser.id;
            }
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [pteroId, user[0].id]);
        }

        // Try to create server again
        const serverData = {
            name: failedServer.server_name,
            user_id: pteroId,
            egg_id: failedServer.egg_id,
            nest_id: failedServer.nest_id,
            docker_image: failedServer.docker_image,
            startup_cmd: failedServer.startup_cmd,
            environment_config: failedServer.environment_config,
            ram: failedServer.ram,
            swap: 0,
            disk: failedServer.disk,
            cpu: failedServer.cpu,
            location_id: failedServer.location_id,
            db_count: failedServer.db_count,
            allocations: failedServer.allocations,
            backups: failedServer.backups
        };

        const pteroServer = await pteroService.createServer(serverData);

        // Update server record with new Pterodactyl info
        await conn.query(`
            UPDATE active_servers 
            SET ptero_server_id = ?, ptero_identifier = ?, status = 'active', failure_reason = NULL
            WHERE id = ?
        `, [pteroServer.id, pteroServer.identifier, serverId]);

        req.flash('success_msg', 'Server created successfully!');
        res.redirect('/dashboard/servers/manage/' + serverId);
    } catch (err) {
        console.error('[Retry Server Error]', err);

        // Update failure reason
        if (conn) {
            try {
                await conn.query("UPDATE active_servers SET failure_reason = ? WHERE id = ?",
                    [err.message, req.params.id]);
            } catch (e) { console.error('Error updating failure reason:', e); }
        }

        req.flash('error_msg', 'Retry failed: ' + err.message);
        res.redirect('/dashboard/servers/manage/' + req.params.id);
    } finally {
        if (conn) conn.release();
    }
});

// My Invoices
router.get('/invoices', ensureAuthenticated, async (req, res) => {
    try {
        const conn = await db.getConnection();

        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const offset = (page - 1) * limit;

        // Get total count for this user
        const countResult = await conn.query('SELECT COUNT(*) as total FROM invoices WHERE user_id = ?', [req.session.user.id]);
        const totalItems = countResult[0].total;
        const totalPages = Math.ceil(totalItems / limit);

        const invoices = await conn.query(`
            SELECT invoices.*, Plans.name as plan_name
            FROM invoices 
            LEFT JOIN Plans ON invoices.plan_id = Plans.id
            WHERE invoices.user_id = ?
            ORDER BY invoices.created_at DESC
            LIMIT ? OFFSET ?
        `, [req.session.user.id, limit, offset]);
        conn.release();

        // Add currency symbols
        const currencySymbols = {
            'USD': '$', 'INR': '₹', 'EUR': '€', 'GBP': '£',
            'JPY': '¥', 'AUD': 'A$', 'CAD': 'C$', 'CNY': '¥',
            'SGD': 'S$', 'AED': 'د.إ', 'BRL': 'R$', 'MXN': 'MX$'
        };

        invoices.forEach(inv => {
            inv.currency_symbol = currencySymbols[inv.currency_code] || '$';
        });

        res.render('dashboard/invoices', {
            invoices,
            pagination: {
                currentPage: page,
                totalPages,
                totalItems,
                limit,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

// View Single Invoice (Printable/Downloadable)
router.get('/invoices/:id', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const invoice = await conn.query(`
            SELECT invoices.*, Plans.name as plan_name
            FROM invoices 
            LEFT JOIN Plans ON invoices.plan_id = Plans.id
            WHERE invoices.id = ? AND invoices.user_id = ?
        `, [req.params.id, req.session.user.id]);

        if (invoice.length === 0) {
            return res.redirect('/dashboard/invoices');
        }

        // Get company settings
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name', 'company_address', 'company_gst', 'tax_name')");
        const company = {};
        settingsRows.forEach(row => {
            company[row.setting_key.replace('company_', '')] = row.setting_value;
        });
        company.tax_name = settingsRows.find(r => r.setting_key === 'tax_name')?.setting_value || 'Tax';

        res.render('dashboard/invoice_view', {
            invoice: invoice[0],
            company
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Invoice Payment Page
router.get('/invoices/:id/pay', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Get invoice
        const invoiceRows = await conn.query(`
            SELECT invoices.*, Plans.name as plan_name
            FROM invoices 
            LEFT JOIN Plans ON invoices.plan_id = Plans.id
            WHERE invoices.id = ? AND invoices.user_id = ?
        `, [req.params.id, req.session.user.id]);

        if (invoiceRows.length === 0) {
            req.flash('error_msg', 'Invoice not found');
            return res.redirect('/dashboard/invoices');
        }

        const invoice = invoiceRows[0];

        if (invoice.status !== 'pending') {
            req.flash('info_msg', 'This invoice has already been processed');
            return res.redirect('/dashboard/invoices');
        }

        // Get currency info
        const currencyCode = invoice.currency_code || 'USD';
        const currencyRows = await conn.query("SELECT * FROM currencies WHERE code = ?", [currencyCode]);
        const currency = currencyRows[0] || { code: 'USD', symbol: '$', rate_to_usd: 1 };

        // Calculate invoice amount in USD for balance comparison
        const invoiceLocalAmount = parseFloat(invoice.currency_amount || invoice.amount);
        let invoiceAmountUSD = invoiceLocalAmount;
        if (currencyCode !== 'USD' && currency.rate_to_usd) {
            invoiceAmountUSD = invoiceLocalAmount / parseFloat(currency.rate_to_usd);
        }

        // Get available payment gateways
        const gateways = await conn.query("SELECT * FROM payment_gateways WHERE enabled = 1");

        // Get user's balance (stored in USD)
        const userRows = await conn.query("SELECT balance FROM users WHERE id = ?", [req.session.user.id]);
        const userBalance = parseFloat(userRows[0]?.balance || 0);

        res.render('dashboard/invoice_pay', {
            invoice,
            currency,
            gateways,
            userBalance,
            invoiceAmountUSD: invoiceAmountUSD.toFixed(2)
        });
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to load invoice');
        res.redirect('/dashboard/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Process Invoice Payment
router.post('/invoices/:id/pay', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { payment_method } = req.body;

        // Get invoice
        const invoiceRows = await conn.query(`
            SELECT * FROM invoices WHERE id = ? AND user_id = ?
        `, [req.params.id, req.session.user.id]);

        if (invoiceRows.length === 0) {
            req.flash('error_msg', 'Invoice not found');
            return res.redirect('/dashboard/invoices');
        }

        const invoice = invoiceRows[0];

        if (invoice.status !== 'pending') {
            req.flash('info_msg', 'This invoice has already been processed');
            return res.redirect('/dashboard/invoices');
        }

        const amountToPay = parseFloat(invoice.currency_amount || invoice.amount);
        const currencyCode = invoice.currency_code || 'USD';

        // Handle payment by credits/balance
        if (payment_method === 'credits') {
            const userRows = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
            const userBalance = parseFloat(userRows[0]?.balance || 0);

            // User balance is stored in USD, so we need to convert the invoice amount to USD for comparison
            let amountInUSD = amountToPay;
            if (currencyCode !== 'USD') {
                const currencyData = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = ?", [currencyCode]);
                if (currencyData.length > 0 && currencyData[0].rate_to_usd) {
                    amountInUSD = amountToPay / currencyData[0].rate_to_usd;
                }
            }

            console.log(`[Credits Payment] Invoice amount: ${amountToPay} ${currencyCode}, USD equivalent: ${amountInUSD.toFixed(2)}, User balance: $${userBalance}`);

            if (userBalance < amountInUSD) {
                req.flash('error_msg', `Insufficient balance. You need $${amountInUSD.toFixed(2)} USD but have $${userBalance.toFixed(2)}`);
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            // Deduct the USD equivalent from balance and mark invoice as paid
            const txnId = 'CREDIT_' + Date.now() + '_' + req.session.user.id;
            await conn.query("UPDATE users SET balance = balance - ? WHERE id = ?", [amountInUSD, req.session.user.id]);
            await conn.query("UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'credits', transaction_id = ? WHERE id = ?", [txnId, req.params.id]);

            // Award Commission
            await affiliateService.processCommission(req.params.id, conn);

            // Handle Server Renewal / Unsuspension
            let serverRenewed = false;
            let billingPeriod = 'monthly'; // default
            console.log(`[Payment] Invoice data:`, JSON.stringify(invoice, null, 2));
            console.log(`[Payment] Invoice server_id value: "${invoice.server_id}" (type: ${typeof invoice.server_id})`);
            if (invoice.server_id) {
                console.log(`[Payment] Processing renewal for server #${invoice.server_id}`);
                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [invoice.server_id]);
                console.log(`[Payment] Found server rows: ${serverRow.length}`);
                if (serverRow.length > 0) {
                    billingPeriod = serverRow[0].billing_period || 'monthly';
                    const billingInterval = getBillingInterval(billingPeriod);
                    console.log(`[Payment] Server current renewal_date: ${serverRow[0].renewal_date}, billing_period: ${billingPeriod}`);
                    // Update Renewal Date based on plan's billing period
                    const updateResult = await conn.query(`UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`, [invoice.server_id]);
                    console.log(`[Payment] Update result - affectedRows: ${updateResult.affectedRows}`);
                    serverRenewed = true;

                    // Unsuspend on Pterodactyl if currently suspended
                    if (serverRow[0].ptero_server_id) {
                        try {
                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                            console.log(`[Payment] Unsuspended Ptero server ${serverRow[0].ptero_server_id}`);
                        } catch (pteroErr) {
                            console.error(`[Payment] Failed to unsuspend Ptero server:`, pteroErr.message);
                        }
                    }
                } else {
                    console.log(`[Payment] WARNING: No server found with id ${invoice.server_id}`);
                }
            } else {
                console.log(`[Payment] WARNING: Invoice has no server_id, cannot update renewal date`);
            }

            // Get currency for success page
            const currencyRows = await conn.query("SELECT * FROM currencies WHERE code = ?", [currencyCode]);
            const currency = currencyRows[0] || { code: 'USD', symbol: '$', rate_to_usd: 1 };

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.invoicePaid(invoice, userRows[0], 'credits', txnId);
            } catch (e) { console.error('[Discord]', e.message); }

            conn.release();

            return res.render('dashboard/invoice_success', {
                invoice,
                currency,
                paymentMethod: 'credits',
                transactionId: txnId,
                serverRenewed,
                billingPeriod
            });
        }


        // Handle Stripe payment
        if (payment_method === 'stripe') {
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'Stripe is not available');
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
            const stripe = require('stripe')(config.secretKey);

            // Store invoice ID in session for callback
            req.session.pendingInvoicePayment = {
                invoiceId: req.params.id,
                amount: amountToPay,
                currency: currencyCode
            };

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: currencyCode.toLowerCase(),
                        product_data: {
                            name: invoice.description || `Invoice #${invoice.id}`,
                        },
                        unit_amount: Math.round(amountToPay * 100),
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${req.protocol}://${req.get('host')}/dashboard/invoice-payment/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${req.protocol}://${req.get('host')}/dashboard/invoices/${req.params.id}/pay`,
                metadata: {
                    invoice_id: req.params.id,
                    user_id: req.session.user.id
                }
            });

            conn.release();
            return res.redirect(session.url);
        }

        // Handle PhonePe payment
        if (payment_method === 'phonepe') {
            // PhonePe PG supports multi-currency if merchant account is configured for international payments
            // Amount is always sent in paise (INR smallest unit)

            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'PhonePe is not available');
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
            const { StandardCheckoutClient, Env, CreateSdkOrderRequest } = require('pg-sdk-node');

            const merchantId = config.clientId;
            let saltKey = config.clientSecret;
            let saltIndex = parseInt(config.clientVersion) || 1;

            if (saltKey && saltKey.includes('###')) {
                const parts = saltKey.split('###');
                saltKey = parts[0];
                saltIndex = parseInt(parts[1]) || saltIndex;
            }

            const env = config.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;
            const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

            const merchantOrderId = 'INV' + req.params.id + '_' + Date.now();
            req.session.pendingInvoicePayment = {
                merchantOrderId,
                invoiceId: req.params.id,
                amount: amountToPay
            };

            // PhonePe requires amount in paise (INR smallest unit)
            // Convert the invoice USD amount to INR first
            let amountInINR = parseFloat(invoice.amount); // Start with USD amount
            if (currencyCode === 'INR') {
                // If already INR, use currency_amount
                amountInINR = amountToPay;
            } else {
                // Convert USD to INR using rate from currencies table
                const inrRate = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = 'INR'");
                if (inrRate.length > 0 && inrRate[0].rate_to_usd) {
                    amountInINR = parseFloat(invoice.amount) * parseFloat(inrRate[0].rate_to_usd);
                }
            }

            const amountInPaise = Math.round(amountInINR * 100);
            console.log(`[PhonePe] Invoice payment: ${currencyCode} ${amountToPay} → INR ${amountInINR.toFixed(2)} → ${amountInPaise} paise`);

            const redirectUrl = `${req.protocol}://${req.get('host')}/dashboard/invoice-payment/phonepe-callback`;
            const webhookUrl = `${req.protocol}://${req.get('host')}/dashboard/phonepe/webhook`;

            const orderRequest = CreateSdkOrderRequest.StandardCheckoutBuilder()
                .merchantOrderId(merchantOrderId)
                .amount(amountInPaise)
                .redirectUrl(redirectUrl)
                .build();

            const response = await client.pay(orderRequest);
            conn.release();

            if (response && response.redirectUrl) {
                return res.redirect(response.redirectUrl);
            } else {
                req.flash('error_msg', 'Failed to initiate PhonePe payment');
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }
        }

        // Handle PayPal payment
        if (payment_method === 'paypal') {
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'PayPal is not available');
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

            if (!config.clientId || !config.secret) {
                req.flash('error_msg', 'PayPal is not properly configured');
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

            const paypalClient = new Client({
                clientCredentialsAuthCredentials: {
                    oAuthClientId: config.clientId,
                    oAuthClientSecret: config.secret
                },
                environment: config.environment === 'production' ? Environment.Production : Environment.Sandbox
            });

            const ordersController = new OrdersController(paypalClient);

            // PayPal supported currencies
            const supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'BRL', 'MXN', 'SGD', 'HKD'];
            let paypalAmount = amountToPay;
            let paypalCurrency = currencyCode;

            if (!supportedCurrencies.includes(currencyCode)) {
                // Convert to USD
                paypalAmount = parseFloat(invoice.amount);
                paypalCurrency = 'USD';
            }

            const merchantOrderId = 'INV' + req.params.id + '_' + Date.now();
            req.session.pendingInvoicePayment = {
                merchantOrderId,
                invoiceId: req.params.id,
                amount: amountToPay,
                paypalOrderId: null
            };

            const returnUrl = `${req.protocol}://${req.get('host')}/dashboard/invoice-payment/paypal-success`;
            const cancelUrl = `${req.protocol}://${req.get('host')}/dashboard/invoices/${req.params.id}/pay`;

            const orderRequest = {
                body: {
                    intent: 'CAPTURE',
                    purchaseUnits: [{
                        referenceId: merchantOrderId,
                        amount: {
                            currencyCode: paypalCurrency,
                            value: paypalAmount.toFixed(2)
                        },
                        description: invoice.description || `Invoice #${invoice.id}`
                    }],
                    applicationContext: {
                        brandName: 'Plexa',
                        landingPage: 'BILLING',
                        userAction: 'PAY_NOW',
                        returnUrl: returnUrl,
                        cancelUrl: cancelUrl
                    }
                }
            };

            const orderResponse = await ordersController.createOrder(orderRequest);
            req.session.pendingInvoicePayment.paypalOrderId = orderResponse.result.id;

            const approvalLink = orderResponse.result.links.find(link => link.rel === 'approve');
            if (!approvalLink) {
                req.flash('error_msg', 'Failed to initiate PayPal payment');
                conn.release();
                return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);
            }

            conn.release();
            return res.redirect(approvalLink.href);
        }

        // Unknown payment method
        req.flash('error_msg', 'Invalid payment method');
        conn.release();
        return res.redirect(`/dashboard/invoices/${req.params.id}/pay`);

    } catch (err) {
        console.error('Invoice payment error:', err);
        req.flash('error_msg', 'Payment failed: ' + err.message);
        if (conn) conn.release();
        return res.redirect('/dashboard/invoices');
    }
});

// Invoice Payment Success (Stripe)
router.get('/invoice-payment/success', ensureAuthenticated, async (req, res) => {
    console.log('[Stripe Invoice] Callback received, session_id:', req.query.session_id);
    let conn;
    try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
            console.log('[Stripe Invoice] No session_id provided');
            req.flash('error_msg', 'Invalid payment session');
            return res.redirect('/dashboard/invoices');
        }

        // Get gateway config
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe'");
        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
        const stripe = require('stripe')(config.secretKey);

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const invoiceId = session.metadata.invoice_id;
            await conn.query("UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'stripe', transaction_id = ? WHERE id = ?",
                [session.payment_intent, invoiceId]);

            // Handle Server Renewal
            let serverRenewed = false;
            let billingPeriod = 'monthly';
            const paidInvoice = await conn.query("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
            if (paidInvoice.length > 0 && paidInvoice[0].server_id) {
                const serverId = paidInvoice[0].server_id;
                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [serverId]);
                if (serverRow.length > 0) {
                    billingPeriod = serverRow[0].billing_period || 'monthly';
                    const billingInterval = getBillingInterval(billingPeriod);
                    await conn.query(`UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`, [serverId]);
                    serverRenewed = true;
                    if (serverRow[0].ptero_server_id) {
                        try {
                            const pteroService = require('../services/pterodactyl');
                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                        } catch (e) { console.error('Stripe Unsuspension Error:', e.message); }
                    }
                }
            }

            // Get invoice and currency for success page
            const invoice = paidInvoice[0];
            const currencyCode = invoice.currency_code || 'USD';
            const currencyRows = await conn.query("SELECT * FROM currencies WHERE code = ?", [currencyCode]);
            const currency = currencyRows[0] || { code: 'USD', symbol: '$', rate_to_usd: 1 };

            // Discord notification
            try {
                const discord = require('../services/discord');
                const user = await conn.query("SELECT * FROM users WHERE id = ?", [invoice.user_id]);
                await discord.invoicePaid(invoice, user[0], 'stripe', session.payment_intent);
            } catch (e) { console.error('[Discord]', e.message); }

            conn.release();
            return res.render('dashboard/invoice_success', {
                invoice,
                currency,
                paymentMethod: 'stripe',
                transactionId: session.payment_intent,
                serverRenewed,
                billingPeriod
            });
        } else {
            req.flash('error_msg', 'Payment was not completed');
            conn.release();
            return res.redirect('/dashboard/invoices');
        }
    } catch (err) {
        console.error('Stripe invoice callback error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify payment');
        res.redirect('/dashboard/invoices');
    }
});


// Invoice Payment PhonePe Callback
router.get('/invoice-payment/phonepe-callback', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const pending = req.session.pendingInvoicePayment;
        console.log('[PhonePe Invoice] Callback received, pending session:', pending ? 'exists' : 'missing');

        if (!pending || !pending.invoiceId) {
            console.log('[PhonePe Invoice] Missing session data');
            req.flash('error_msg', 'Invalid payment session. Please try again.');
            return res.redirect('/dashboard/invoices');
        }

        // Verify with PhonePe
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe'");
        if (gateway.length === 0) {
            console.log('[PhonePe Invoice] Gateway not found');
            req.flash('error_msg', 'PhonePe gateway configuration error');
            conn.release();
            return res.redirect('/dashboard/invoices');
        }

        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

        const { StandardCheckoutClient, Env } = require('pg-sdk-node');
        const merchantId = config.clientId;
        let saltKey = config.clientSecret;
        let saltIndex = parseInt(config.clientVersion) || 1;

        if (saltKey && saltKey.includes('###')) {
            const parts = saltKey.split('###');
            saltKey = parts[0];
            saltIndex = parseInt(parts[1]) || saltIndex;
        }

        const env = config.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;
        const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

        console.log('[PhonePe Invoice] Checking status for order:', pending.merchantOrderId);
        const statusResponse = await client.getOrderStatus(pending.merchantOrderId);
        console.log('[PhonePe Invoice] Status response:', JSON.stringify(statusResponse, null, 2));

        // PhonePe SDK may return status in different properties depending on version
        const isCompleted = statusResponse && (
            statusResponse.state === 'COMPLETED' ||
            statusResponse.status === 'COMPLETED' ||
            statusResponse.code === 'PAYMENT_SUCCESS' ||
            (statusResponse.data && statusResponse.data.state === 'COMPLETED')
        );

        if (isCompleted) {
            console.log('[PhonePe Invoice] Payment completed, updating invoice:', pending.invoiceId);
            await conn.query("UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'phonepe', transaction_id = ? WHERE id = ?",
                [pending.merchantOrderId, pending.invoiceId]);

            // Award Commission
            await affiliateService.processCommission(pending.invoiceId, conn);

            // Handle Server Renewal
            let serverRenewed = false;
            let billingPeriod = 'monthly';
            const paidInvoice = await conn.query("SELECT * FROM invoices WHERE id = ?", [pending.invoiceId]);
            if (paidInvoice.length > 0 && paidInvoice[0].server_id) {
                const serverId = paidInvoice[0].server_id;
                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [serverId]);
                if (serverRow.length > 0) {
                    billingPeriod = serverRow[0].billing_period || 'monthly';
                    const billingInterval = getBillingInterval(billingPeriod);
                    await conn.query(`UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`, [serverId]);
                    serverRenewed = true;
                    if (serverRow[0].ptero_server_id) {
                        try {
                            const pteroService = require('../services/pterodactyl');
                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                        } catch (e) { console.error('PhonePe Unsuspension Error:', e.message); }
                    }
                }
            }

            // Get invoice and currency for success page
            const invoice = paidInvoice[0];
            const currencyCode = invoice.currency_code || 'USD';
            const currencyRows = await conn.query("SELECT * FROM currencies WHERE code = ?", [currencyCode]);
            const currency = currencyRows[0] || { code: 'USD', symbol: '$', rate_to_usd: 1 };

            // Discord notification
            try {
                const discord = require('../services/discord');
                const user = await conn.query("SELECT * FROM users WHERE id = ?", [invoice.user_id]);
                await discord.invoicePaid(invoice, user[0], 'phonepe', pending.merchantOrderId);
            } catch (e) { console.error('[Discord]', e.message); }

            delete req.session.pendingInvoicePayment;
            conn.release();

            return res.render('dashboard/invoice_success', {
                invoice,
                currency,
                paymentMethod: 'phonepe',
                transactionId: pending.merchantOrderId,
                serverRenewed,
                billingPeriod
            });
        } else {
            console.log('[PhonePe Invoice] Payment not completed. Status:', statusResponse?.state || statusResponse?.status);
            req.flash('error_msg', 'Payment was not completed. Please try again.');
            conn.release();
            return res.redirect('/dashboard/invoices');
        }
    } catch (err) {
        console.error('PhonePe invoice callback error:', err);
        console.error('PhonePe invoice callback stack:', err.stack);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify payment: ' + err.message);
        res.redirect('/dashboard/invoices');
    }
});


// Invoice Payment Success (PayPal)
router.get('/invoice-payment/paypal-success', ensureAuthenticated, async (req, res) => {
    console.log('[PayPal Invoice] Callback received, token:', req.query.token);
    let conn;
    try {
        const { token } = req.query;
        const pending = req.session.pendingInvoicePayment;

        if (!pending || !pending.invoiceId || !token) {
            req.flash('error_msg', 'Invalid PayPal payment session');
            return res.redirect('/dashboard/invoices');
        }

        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal'");
        if (gateway.length === 0) {
            throw new Error('PayPal gateway not found');
        }

        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

        const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

        const paypalClient = new Client({
            clientCredentialsAuthCredentials: {
                oAuthClientId: config.clientId,
                oAuthClientSecret: config.secret
            },
            environment: config.environment === 'production' ? Environment.Production : Environment.Sandbox
        });

        const ordersController = new OrdersController(paypalClient);

        // Capture the payment
        const captureResponse = await ordersController.captureOrder({ id: token });

        if (captureResponse.result.status === 'COMPLETED') {
            const transactionId = captureResponse.result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id || token;

            await conn.query("UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'paypal', transaction_id = ? WHERE id = ?",
                [transactionId, pending.invoiceId]);

            // Award Commission
            await affiliateService.processCommission(pending.invoiceId, conn);

            // Handle Server Renewal
            let serverRenewed = false;
            let billingPeriod = 'monthly';
            const paidInvoice = await conn.query("SELECT * FROM invoices WHERE id = ?", [pending.invoiceId]);
            if (paidInvoice.length > 0 && paidInvoice[0].server_id) {
                const serverId = paidInvoice[0].server_id;
                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [serverId]);
                if (serverRow.length > 0) {
                    billingPeriod = serverRow[0].billing_period || 'monthly';
                    const billingInterval = getBillingInterval(billingPeriod);
                    await conn.query(`UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`, [serverId]);
                    serverRenewed = true;
                    if (serverRow[0].ptero_server_id) {
                        try {
                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                        } catch (e) { console.error('PayPal Unsuspension Error:', e.message); }
                    }
                }
            }

            // Get invoice and currency for success page
            const invoice = paidInvoice[0];
            const currencyCode = invoice.currency_code || 'USD';
            const currencyRows = await conn.query("SELECT * FROM currencies WHERE code = ?", [currencyCode]);
            const currency = currencyRows[0] || { code: 'USD', symbol: '$', rate_to_usd: 1 };

            // Discord notification
            try {
                const discord = require('../services/discord');
                const user = await conn.query("SELECT * FROM users WHERE id = ?", [invoice.user_id]);
                await discord.invoicePaid(invoice, user[0], 'paypal', transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            delete req.session.pendingInvoicePayment;
            conn.release();

            return res.render('dashboard/invoice_success', {
                invoice,
                currency,
                paymentMethod: 'paypal',
                transactionId,
                serverRenewed,
                billingPeriod
            });
        } else {
            req.flash('error_msg', 'PayPal payment was not completed');
            conn.release();
            return res.redirect('/dashboard/invoices');
        }
    } catch (err) {
        console.error('PayPal invoice callback error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify PayPal payment: ' + err.message);
        res.redirect('/dashboard/invoices');
    }
});


// ================== TOPUP ROUTES ==================

// GET Topup Page
router.get('/topup', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        const gateways = await conn.query("SELECT * FROM payment_gateways WHERE enabled = 1");
        conn.release();

        res.render('dashboard/topup', {
            user: user[0],
            gateways
        });
    } catch (err) {
        console.error('Topup page error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to load topup page');
        res.redirect('/dashboard');
    }
});

// POST Topup - Process Payment
router.post('/topup', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const { amount, payment_method } = req.body;
        const topupAmount = parseFloat(amount);

        // Validation
        if (isNaN(topupAmount) || topupAmount < 5 || topupAmount > 1000) {
            req.flash('error_msg', 'Invalid amount. Please enter between $5 and $1000.');
            return res.redirect('/dashboard/topup');
        }

        conn = await db.getConnection();
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);

        // Generate unique order ID
        const merchantOrderId = 'TOPUP_' + req.session.user.id + '_' + Date.now();

        // Store pending topup in session
        req.session.pendingTopup = {
            merchantOrderId,
            amount: topupAmount,
            userId: req.session.user.id
        };

        // Handle Stripe
        if (payment_method === 'stripe') {
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'Stripe is not available');
                conn.release();
                return res.redirect('/dashboard/topup');
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
            const stripe = require('stripe')(config.secretKey);

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Account Top Up',
                            description: `Add $${topupAmount.toFixed(2)} to your account balance`,
                        },
                        unit_amount: Math.round(topupAmount * 100),
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${req.protocol}://${req.get('host')}/dashboard/topup/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${req.protocol}://${req.get('host')}/dashboard/topup`,
                metadata: {
                    order_id: merchantOrderId,
                    user_id: user[0].id,
                    type: 'topup',
                    amount: topupAmount.toString()
                }
            });

            console.log('[Stripe Topup] Session created:', session.id);
            conn.release();
            return res.redirect(session.url);
        }

        // Handle PayPal
        if (payment_method === 'paypal') {
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'PayPal is not available');
                conn.release();
                return res.redirect('/dashboard/topup');
            }

            const paypalConfig = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
            const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

            const paypalClient = new Client({
                clientCredentialsAuthCredentials: {
                    oAuthClientId: paypalConfig.clientId,
                    oAuthClientSecret: paypalConfig.secret
                },
                environment: paypalConfig.environment === 'production' ? Environment.Production : Environment.Sandbox
            });

            const ordersController = new OrdersController(paypalClient);

            const returnUrl = `${req.protocol}://${req.get('host')}/dashboard/topup/paypal-success`;
            const cancelUrl = `${req.protocol}://${req.get('host')}/dashboard/topup`;

            const orderRequest = {
                body: {
                    intent: 'CAPTURE',
                    purchaseUnits: [{
                        referenceId: merchantOrderId,
                        amount: {
                            currencyCode: 'USD',
                            value: topupAmount.toFixed(2)
                        },
                        description: `Account Top Up - $${topupAmount.toFixed(2)}`
                    }],
                    applicationContext: {
                        brandName: 'Plexa',
                        landingPage: 'BILLING',
                        userAction: 'PAY_NOW',
                        returnUrl: returnUrl,
                        cancelUrl: cancelUrl
                    }
                }
            };

            const orderResponse = await ordersController.createOrder(orderRequest);
            console.log('[PayPal Topup] Order created:', orderResponse.result.id);

            req.session.pendingTopup.paypalOrderId = orderResponse.result.id;

            const approvalLink = orderResponse.result.links.find(link => link.rel === 'approve');
            if (!approvalLink) {
                throw new Error('No PayPal approval URL found');
            }

            conn.release();
            return res.redirect(approvalLink.href);
        }

        // Handle PhonePe
        if (payment_method === 'phonepe') {
            const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe' AND enabled = 1");
            if (gateway.length === 0) {
                req.flash('error_msg', 'PhonePe is not available');
                conn.release();
                return res.redirect('/dashboard/topup');
            }

            const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
            const { StandardCheckoutClient, Env, CreateSdkOrderRequest } = require('pg-sdk-node');

            const merchantId = config.clientId;
            let saltKey = config.clientSecret;
            let saltIndex = parseInt(config.clientVersion) || 1;

            if (saltKey && saltKey.includes('###')) {
                const parts = saltKey.split('###');
                saltKey = parts[0];
                saltIndex = parseInt(parts[1]) || saltIndex;
            }

            const env = config.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;
            const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

            // Convert USD to INR for PhonePe
            const inrRate = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = 'INR'");
            let amountInINR = topupAmount * 83; // Fallback
            if (inrRate.length > 0 && inrRate[0].rate_to_usd) {
                amountInINR = topupAmount * parseFloat(inrRate[0].rate_to_usd);
            }
            const amountInPaise = Math.round(amountInINR * 100);

            console.log(`[PhonePe Topup] $${topupAmount} USD = ₹${amountInINR.toFixed(2)} INR = ${amountInPaise} paise`);

            const redirectUrl = `${req.protocol}://${req.get('host')}/dashboard/topup/phonepe-callback`;
            const webhookUrl = `${req.protocol}://${req.get('host')}/dashboard/phonepe/webhook`;

            const orderRequest = CreateSdkOrderRequest.StandardCheckoutBuilder()
                .merchantOrderId(merchantOrderId)
                .amount(amountInPaise)
                .redirectUrl(redirectUrl)
                .build();

            const response = await client.pay(orderRequest);
            conn.release();

            if (response && response.redirectUrl) {
                return res.redirect(response.redirectUrl);
            } else {
                req.flash('error_msg', 'Failed to initiate PhonePe payment');
                return res.redirect('/dashboard/topup');
            }
        }

        // Unknown payment method
        req.flash('error_msg', 'Invalid payment method');
        conn.release();
        res.redirect('/dashboard/topup');

    } catch (err) {
        console.error('Topup payment error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Payment failed: ' + err.message);
        res.redirect('/dashboard/topup');
    }
});

// Stripe Topup Success Callback
router.get('/topup/stripe-success', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
            req.flash('error_msg', 'Invalid payment session');
            return res.redirect('/dashboard/topup');
        }

        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe'");
        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
        const stripe = require('stripe')(config.secretKey);

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const amount = parseFloat(session.metadata.amount);
            const userId = session.metadata.user_id;

            // Credit the balance
            await conn.query("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, userId]);

            // Get user details
            const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
            const newBalance = user[0].balance;

            const transactionId = session.payment_intent;

            // Insert Invoice
            await conn.query(`INSERT INTO invoices 
                (user_id, amount, currency_code, currency_amount, status, payment_method, transaction_id, description, created_at, paid_at) 
                VALUES (?, ?, 'USD', ?, 'paid', 'stripe', ?, 'Account Topup', NOW(), NOW())`,
                [userId, amount, amount, transactionId]
            );

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.fundsAdded(user[0], amount, 'Stripe', transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            console.log(`[Stripe Topup] Credited $${amount} to user ${userId}. New balance: $${newBalance}`);

            delete req.session.pendingTopup;
            conn.release();

            return res.render('dashboard/topup_success', {
                amount,
                newBalance,
                paymentMethod: 'stripe',
                transactionId
            });
        } else {
            req.flash('error_msg', 'Payment was not completed');
            conn.release();
            return res.redirect('/dashboard/topup');
        }
    } catch (err) {
        console.error('Stripe topup callback error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify payment');
        res.redirect('/dashboard/topup');
    }
});

// PayPal Topup Success Callback
router.get('/topup/paypal-success', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const { token } = req.query;
        const pending = req.session.pendingTopup;

        if (!pending || !token) {
            req.flash('error_msg', 'Invalid PayPal session');
            return res.redirect('/dashboard/topup');
        }

        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal'");
        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

        const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

        const paypalClient = new Client({
            clientCredentialsAuthCredentials: {
                oAuthClientId: config.clientId,
                oAuthClientSecret: config.secret
            },
            environment: config.environment === 'production' ? Environment.Production : Environment.Sandbox
        });

        const ordersController = new OrdersController(paypalClient);
        const captureResponse = await ordersController.captureOrder({ id: token });

        if (captureResponse.result.status === 'COMPLETED') {
            const amount = pending.amount;
            const transactionId = captureResponse.result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id || token;

            // Credit the balance
            await conn.query("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, pending.userId]);

            // Get user details
            const user = await conn.query("SELECT * FROM users WHERE id = ?", [pending.userId]);
            const newBalance = user[0].balance;

            // Insert Invoice
            await conn.query(`INSERT INTO invoices 
                (user_id, amount, currency_code, currency_amount, status, payment_method, transaction_id, description, created_at, paid_at) 
                VALUES (?, ?, 'USD', ?, 'paid', 'paypal', ?, 'Account Topup', NOW(), NOW())`,
                [pending.userId, amount, amount, transactionId]
            );

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.fundsAdded(user[0], amount, 'PayPal', transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            console.log(`[PayPal Topup] Credited $${amount} to user ${pending.userId}. New balance: $${newBalance}`);

            delete req.session.pendingTopup;
            conn.release();

            return res.render('dashboard/topup_success', {
                amount,
                newBalance,
                paymentMethod: 'paypal',
                transactionId
            });
        } else {
            req.flash('error_msg', 'PayPal payment was not completed');
            conn.release();
            return res.redirect('/dashboard/topup');
        }
    } catch (err) {
        console.error('PayPal topup callback error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify PayPal payment');
        res.redirect('/dashboard/topup');
    }
});

// PhonePe Topup Callback
router.get('/topup/phonepe-callback', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        const pending = req.session.pendingTopup;
        if (!pending || !pending.merchantOrderId) {
            req.flash('error_msg', 'Invalid payment session');
            return res.redirect('/dashboard/topup');
        }

        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe'");
        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

        const { StandardCheckoutClient, Env } = require('pg-sdk-node');

        const merchantId = config.clientId;
        let saltKey = config.clientSecret;
        let saltIndex = parseInt(config.clientVersion) || 1;

        if (saltKey && saltKey.includes('###')) {
            const parts = saltKey.split('###');
            saltKey = parts[0];
            saltIndex = parseInt(parts[1]) || saltIndex;
        }

        const env = config.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;
        const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

        const statusResponse = await client.getOrderStatus(pending.merchantOrderId);
        console.log('[PhonePe Topup] Status:', JSON.stringify(statusResponse, null, 2));

        const isCompleted = statusResponse && (
            statusResponse.state === 'COMPLETED' ||
            statusResponse.status === 'COMPLETED' ||
            statusResponse.code === 'PAYMENT_SUCCESS' ||
            (statusResponse.data && statusResponse.data.state === 'COMPLETED')
        );

        if (isCompleted) {
            const amount = pending.amount;

            // Extract Transaction ID from Payment Details
            const transactionId = statusResponse.paymentDetails?.[0]?.transactionId || pending.merchantOrderId;
            const paidAmountPaise = statusResponse.amount || (amount * 83 * 100);
            const paidAmount = paidAmountPaise / 100;

            // Credit the balance
            await conn.query("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, pending.userId]);

            // Get user details
            const user = await conn.query("SELECT * FROM users WHERE id = ?", [pending.userId]);
            const newBalance = user[0].balance;

            // Insert Invoice
            await conn.query(`INSERT INTO invoices 
                (user_id, amount, currency_code, currency_amount, status, payment_method, transaction_id, description, created_at, paid_at) 
                VALUES (?, ?, 'INR', ?, 'paid', 'phonepe', ?, 'Account Topup', NOW(), NOW())`,
                [pending.userId, amount, paidAmount, transactionId]
            );

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.fundsAdded(user[0], amount, 'PhonePe', transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            console.log(`[PhonePe Topup] Credited $${amount} to user ${pending.userId}. New balance: $${newBalance}`);

            delete req.session.pendingTopup;
            conn.release();

            return res.render('dashboard/topup_success', {
                amount,
                newBalance,
                paymentMethod: 'phonepe',
                transactionId
            });
        } else {
            req.flash('error_msg', 'PhonePe payment was not completed');
            conn.release();
            return res.redirect('/dashboard/topup');
        }
    } catch (err) {
        console.error('PhonePe topup callback error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to verify PhonePe payment');
        res.redirect('/dashboard/topup');
    }
});

// ================== PROFILE ROUTES ==================


// GET Profile Page
router.get('/profile', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const userData = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);

        res.render('dashboard/profile', {
            profileData: userData[0]
        });
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to load profile');
        res.redirect('/dashboard');
    } finally {
        if (conn) conn.release();
    }
});

// POST Change Password
router.post('/profile/change-password', ensureAuthenticated, async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const bcrypt = require('bcrypt');

    if (new_password !== confirm_password) {
        req.flash('error_msg', 'New passwords do not match');
        return res.redirect('/dashboard/profile');
    }

    if (new_password.length < 6) {
        req.flash('error_msg', 'Password must be at least 6 characters');
        return res.redirect('/dashboard/profile');
    }

    let conn;
    try {
        conn = await db.getConnection();
        const user = await conn.query("SELECT password FROM users WHERE id = ?", [req.session.user.id]);

        const match = await bcrypt.compare(current_password, user[0].password);
        if (!match) {
            req.flash('error_msg', 'Current password is incorrect');
            return res.redirect('/dashboard/profile');
        }

        const hashedPassword = await bcrypt.hash(new_password, 10);
        await conn.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, req.session.user.id]);

        req.flash('success_msg', 'Password updated successfully');
        res.redirect('/dashboard/profile');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update password');
        res.redirect('/dashboard/profile');
    } finally {
        if (conn) conn.release();
    }
});

// POST Update Name
router.post('/profile/update-name', ensureAuthenticated, async (req, res) => {
    const { first_name, last_name } = req.body;

    if (!first_name || !last_name) {
        req.flash('error_msg', 'Please provide both first and last name');
        return res.redirect('/dashboard/profile');
    }

    let conn;
    try {
        conn = await db.getConnection();
        await conn.query("UPDATE users SET first_name = ?, last_name = ? WHERE id = ?",
            [first_name.trim(), last_name.trim(), req.session.user.id]);

        // Update session
        req.session.user.first_name = first_name.trim();
        req.session.user.last_name = last_name.trim();

        req.flash('success_msg', 'Name updated successfully');
        res.redirect('/dashboard/profile');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update name');
        res.redirect('/dashboard/profile');
    } finally {
        if (conn) conn.release();
    }
});

// POST Update Currency Preference
router.post('/profile/update-currency', ensureAuthenticated, async (req, res) => {
    const { currency } = req.body;

    let conn;
    try {
        conn = await db.getConnection();
        await conn.query("UPDATE users SET preferred_currency = ? WHERE id = ?", [currency, req.session.user.id]);
        req.session.currency = currency;

        req.flash('success_msg', 'Currency preference updated');
        res.redirect('/dashboard/profile');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update currency');
        res.redirect('/dashboard/profile');
    } finally {
        if (conn) conn.release();
    }
});

// POST Reset Panel Password
router.post('/profile/reset-panel-password', ensureAuthenticated, async (req, res) => {
    const { panel_password, panel_password_confirm } = req.body;
    const pteroService = require('../services/pterodactyl');

    if (panel_password !== panel_password_confirm) {
        req.flash('error_msg', 'Panel passwords do not match');
        return res.redirect('/dashboard/profile');
    }

    if (panel_password.length < 8) {
        req.flash('error_msg', 'Panel password must be at least 8 characters');
        return res.redirect('/dashboard/profile');
    }

    let conn;
    try {
        conn = await db.getConnection();
        const user = await conn.query("SELECT ptero_id FROM users WHERE id = ?", [req.session.user.id]);
        conn.release();

        if (!user[0] || !user[0].ptero_id) {
            req.flash('error_msg', 'No Pterodactyl account linked to your profile');
            return res.redirect('/dashboard/profile');
        }

        await pteroService.updateUserPassword(user[0].ptero_id, panel_password);

        req.flash('success_msg', 'Panel password updated successfully! Use your new password to login to the game panel.');
        res.redirect('/dashboard/profile');
    } catch (err) {
        console.error('Reset Panel Password Error:', err);
        req.flash('error_msg', 'Failed to update panel password. Please try again.');
        res.redirect('/dashboard/profile');
    }
});

// POST Request Account Closure
router.post('/profile/request-closure', ensureAuthenticated, async (req, res) => {
    const { confirmation } = req.body;

    if (confirmation !== 'DELETE') {
        req.flash('error_msg', 'Please type DELETE to confirm');
        return res.redirect('/dashboard/profile');
    }

    let conn;
    try {
        conn = await db.getConnection();

        // Check for active subscriptions
        const activeServers = await conn.query("SELECT id FROM active_servers WHERE user_id = ? AND status NOT IN ('cancelled', 'terminated')", [req.session.user.id]);

        if (activeServers.length > 0) {
            req.flash('error_msg', 'Cannot close account while you have active subscriptions. Please cancel your servers first.');
            return res.redirect('/dashboard/profile');
        }

        const ticketSubject = 'Account Closure Request';
        const ticketMessage = `Hello,

I would like to request the closure of my account. I have cancelled all my active subscriptions and have no outstanding dues.

Please proceed with closing my account at your earliest convenience.

Thank you for your services.

Best regards,
${req.session.user.username}`;

        // Insert the ticket
        const result = await conn.query("INSERT INTO tickets (user_id, subject) VALUES (?, ?)",
            [req.session.user.id, ticketSubject]);
        const ticketId = Number(result.insertId);

        // Insert the initial message
        await conn.query("INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)",
            [ticketId, req.session.user.id, ticketMessage]);

        req.flash('success_msg', 'Account closure request submitted. A support ticket has been created and our team will process your request shortly.');
        res.redirect('/dashboard/tickets/' + ticketId);
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to request account closure');
        res.redirect('/dashboard/profile');
    } finally {
        if (conn) conn.release();
    }
});

// ================== AFFILIATE SYSTEM ROUTES ==================

// Affiliate Dashboard
router.get('/affiliates', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Check if affiliate program is enabled
        const [enabledSetting] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'affiliate_enabled'");
        if (!enabledSetting || enabledSetting.setting_value !== 'true') {
            req.flash('error_msg', 'Affiliate program is currently disabled');
            return res.redirect('/dashboard');
        }

        // Check if user is an affiliate
        const affiliateRows = await conn.query("SELECT * FROM affiliates WHERE user_id = ?", [req.session.user.id]);

        // Get settings
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('affiliate_default_commission', 'affiliate_min_payout', 'site_url')");
        const settings = {};
        settingsRows.forEach(row => settings[row.setting_key] = row.setting_value);

        const siteUrl = (settings.site_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

        if (affiliateRows.length === 0) {
            // Not an affiliate yet - show welcome/join page
            return res.render('dashboard/affiliates_join', {
                defaultCommission: settings.affiliate_default_commission || 10
            });
        }

        const affiliate = affiliateRows[0];

        // Get referral stats
        const referrals = await conn.query(`
            SELECT r.*, u.username, u.created_at as user_created_at
            FROM referrals r
            JOIN users u ON r.referred_user_id = u.id
            WHERE r.affiliate_id = ?
            ORDER BY r.created_at DESC
        `, [affiliate.id]);

        // Get payout history
        const payouts = await conn.query("SELECT * FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC", [affiliate.id]);

        res.render('dashboard/affiliates', {
            affiliate,
            referrals,
            payouts,
            referralLink: `${siteUrl}/?ref=${affiliate.referral_code}`,
            minPayout: settings.affiliate_min_payout || 10,
            defaultCommission: settings.affiliate_default_commission || 10
        });
    } catch (err) {
        console.error('[Affiliate Dashboard Error]', err);
        req.flash('error_msg', 'Failed to load affiliate dashboard');
        res.redirect('/dashboard');
    } finally {
        if (conn) conn.release();
    }
});

// Join Affiliate Program
router.post('/affiliates/join', ensureAuthenticated, async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Check if affiliate program is enabled
        const [enabledSetting] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'affiliate_enabled'");
        if (!enabledSetting || enabledSetting.setting_value !== 'true') {
            req.flash('error_msg', 'Affiliate program is currently disabled');
            return res.redirect('/dashboard');
        }

        // Check if already an affiliate
        const existing = await conn.query("SELECT id FROM affiliates WHERE user_id = ?", [req.session.user.id]);
        if (existing.length > 0) {
            return res.redirect('/dashboard/affiliates');
        }

        // Generate a unique referral code
        let referralCode;
        let codeExists = true;
        while (codeExists) {
            referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
            const [check] = await conn.query("SELECT id FROM affiliates WHERE referral_code = ?", [referralCode]);
            if (!check) codeExists = false;
        }

        const [defaultRateSetting] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'affiliate_default_commission'");
        const commissionRate = parseFloat(defaultRateSetting?.setting_value || 10);

        await conn.query("INSERT INTO affiliates (user_id, referral_code, commission_rate) VALUES (?, ?, ?)",
            [req.session.user.id, referralCode, commissionRate]);

        req.flash('success_msg', 'Welcome! You are now part of our affiliate program.');
        res.redirect('/dashboard/affiliates');
    } catch (err) {
        console.error('[Affiliate Join Error]', err);
        req.flash('error_msg', 'Failed to join affiliate program');
        res.redirect('/dashboard/affiliates');
    } finally {
        if (conn) conn.release();
    }
});

// Request Payout
router.post('/affiliates/payout', ensureAuthenticated, async (req, res) => {
    const { amount, payment_method } = req.body;
    let conn;
    try {
        conn = await db.getConnection();

        const affiliateRows = await conn.query("SELECT * FROM affiliates WHERE user_id = ?", [req.session.user.id]);
        if (affiliateRows.length === 0) return res.redirect('/dashboard/affiliates');

        const affiliate = affiliateRows[0];
        const requestedAmount = parseFloat(amount);

        // Get min payout setting
        const [minPayoutSetting] = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'affiliate_min_payout'");
        const minPayout = parseFloat(minPayoutSetting?.setting_value || 10);

        if (requestedAmount < minPayout) {
            req.flash('error_msg', `Minimum payout amount is $${minPayout.toFixed(2)}`);
            return res.redirect('/dashboard/affiliates');
        }

        if (requestedAmount > parseFloat(affiliate.balance)) {
            req.flash('error_msg', 'Insufficient balance');
            return res.redirect('/dashboard/affiliates');
        }

        // Use transaction for payout request
        await conn.beginTransaction();

        // Deduct balance
        await conn.query("UPDATE affiliates SET balance = balance - ? WHERE id = ?", [requestedAmount, affiliate.id]);

        // Log payout request
        await conn.query("INSERT INTO affiliate_payouts (affiliate_id, amount, status, payment_method) VALUES (?, ?, 'pending', ?)",
            [affiliate.id, requestedAmount, payment_method]);

        await conn.commit();

        req.flash('success_msg', 'Payout request submitted successfully!');
        res.redirect('/dashboard/affiliates');
    } catch (err) {
        if (conn) await conn.rollback();
        console.error('[Affiliate Payout Error]', err);
        req.flash('error_msg', 'Failed to submit payout request');
        res.redirect('/dashboard/affiliates');
    } finally {
        if (conn) conn.release();
    }
});

// ================== END AFFILIATE SYSTEM ROUTES ==================


// ================== PHONEPE PAYMENT ROUTES ==================

// PhonePe Callback (User redirect after payment - PhonePe redirects via GET)
router.get('/phonepe/callback', ensureAuthenticated, async (req, res) => {
    console.log('[PhonePe] Callback received - query:', req.query);

    const pending = req.session.pendingPayment;
    if (!pending) {
        req.flash('error_msg', 'Payment session expired. Please try again.');
        return res.redirect('/dashboard/store');
    }

    let conn;
    try {
        // Get PhonePe gateway config
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe' AND enabled = 1");

        if (gateway.length === 0) {
            throw new Error('PhonePe gateway not configured');
        }

        // Handle both object and string config formats
        let gatewayConfig;
        if (typeof gateway[0].config === 'object' && gateway[0].config !== null) {
            gatewayConfig = gateway[0].config;
        } else {
            gatewayConfig = JSON.parse(gateway[0].config || '{}');
        }

        // Verify payment status with PhonePe SDK
        const { StandardCheckoutClient, Env } = require('pg-sdk-node');

        const merchantId = gatewayConfig.clientId;
        let saltKey = gatewayConfig.clientSecret;
        let saltIndex = parseInt(gatewayConfig.clientVersion) || 1;

        // Smart Salt Detection
        if (saltKey && saltKey.includes('###')) {
            const parts = saltKey.split('###');
            saltKey = parts[0];
            saltIndex = parseInt(parts[1]) || saltIndex;
        }

        const env = gatewayConfig.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;

        const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

        // Get order status using merchant order ID
        const statusResponse = await client.getOrderStatus(pending.merchantOrderId);

        console.log('[PhonePe SDK] Status response:', statusResponse);

        // Check for successful payment (state can be 'COMPLETED' or similar)
        const isSuccess = statusResponse && (
            statusResponse.state === 'COMPLETED' ||
            statusResponse.orderStatus === 'COMPLETED' ||
            (statusResponse.paymentDetails && statusResponse.paymentDetails[0]?.transactionState === 'COMPLETED')
        );

        if (isSuccess) {
            // Payment successful - create server
            const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
            const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [pending.planId]);

            if (plan.length === 0 || user.length === 0) {
                throw new Error('Invalid plan or user');
            }

            // Update billing info
            await conn.query("UPDATE users SET billing_address = ?, gst_number = ? WHERE id = ?",
                [pending.billing_address, pending.gst_number, user[0].id]);

            // Increment coupon usage
            if (pending.couponId) {
                await conn.query("UPDATE coupons SET uses = uses + 1 WHERE id = ?", [pending.couponId]);
            }

            // Create Pterodactyl user if needed
            let pteroId = user[0].ptero_id;
            let pteroPass = null;

            if (!pteroId) {
                const existingPteroUser = await pteroService.getUser(user[0].email);
                if (existingPteroUser) {
                    pteroId = existingPteroUser.id;
                } else {
                    pteroPass = crypto.randomBytes(8).toString('hex');
                    const pteroUser = await pteroService.createUser({
                        email: user[0].email,
                        username: user[0].username
                    }, pteroPass);
                    pteroId = pteroUser.id;
                }
                await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [pteroId, user[0].id]);
            }

            // Create server - wrapped in try/catch so we can create REFUNDED invoice if it fails
            let pteroServer = null;
            let serverCreationError = null;
            let localServerId = null;

            try {
                const serverData = {
                    name: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                    user_id: pteroId,
                    egg_id: plan[0].egg_id,
                    nest_id: plan[0].nest_id,
                    docker_image: plan[0].docker_image,
                    startup_cmd: plan[0].startup_cmd,
                    environment_config: plan[0].environment_config,
                    user_env_overrides: pending.userEnvOverrides,
                    ram: plan[0].ram,
                    swap: 0,
                    disk: plan[0].disk,
                    cpu: plan[0].cpu,
                    location_id: pending.selectedRegion.id,
                    db_count: plan[0].db_count,
                    allocations: plan[0].allocations,
                    backups: plan[0].backups
                };

                pteroServer = await pteroService.createServer(serverData);

                // Save active server with dynamic billing interval
                const billingInterval = getBillingInterval(plan[0].billing_period);
                const serverInsertResult = await conn.query(`INSERT INTO active_servers 
                    (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, renewal_date) 
                    VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ${billingInterval}))`,
                    [user[0].id, plan[0].id, pteroServer.id, pteroServer.identifier, pteroServer.name, pending.selectedRegion?.id || pending.region]
                );

                localServerId = Number(serverInsertResult.insertId);
            } catch (serverErr) {
                console.error('[PhonePe] Server creation failed after payment success:', serverErr.message);
                serverCreationError = serverErr.message;
            }

            // Use merchantOrderId as transaction_id for PhonePe
            const transactionId = pending.merchantOrderId;

            if (pteroServer && localServerId) {
                // SUCCESS: Server created - create PAID invoice
                await conn.query(`INSERT INTO invoices 
                    (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                     subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                    VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [user[0].id, localServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                    pending.userCurrency || 'INR',
                    pending.finalPrice,
                    `${plan[0].name} - ${pending.selectedRegion.long_name || pending.selectedRegion.short}`,
                    pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address, pending.gst_number, 'phonepe', transactionId]
                );

                // Clear pending payment
                delete req.session.pendingPayment;

                // Success popup
                req.session.checkoutSuccess = {
                    serverName: pteroServer.name,
                    planName: plan[0].name,
                    pteroPass,
                    transactionId,
                    paymentMethod: 'phonepe'
                };

                // Discord notification
                try {
                    const discord = require('../services/discord');
                    await discord.planPurchased(plan[0], { username: user[0].username }, { server_name: pteroServer.name });
                } catch (e) { console.error('[Discord]', e.message); }

                req.session.save(() => {
                    res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
                });
            } else {
                // FAILURE: Server creation failed - create failed server entry
                console.log('[PhonePe] Creating failed server entry for server creation failure');

                // Create server entry with 'failed' status using dynamic billing interval
                const failedBillingInterval = getBillingInterval(plan[0].billing_period);
                await conn.query(`INSERT INTO active_servers 
                    (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, failure_reason, renewal_date) 
                    VALUES (?, ?, NULL, NULL, ?, ?, 'failed', ?, DATE_ADD(NOW(), INTERVAL ${failedBillingInterval}))`,
                    [user[0].id, plan[0].id, pending.server_name || `${user[0].username}'s ${plan[0].name}`, pending.selectedRegion.id, serverCreationError]
                );

                // Create invoice (paid, but linked to failed server)
                const failedServerResult = await conn.query(`SELECT LAST_INSERT_ID() as id`);
                const failedServerId = Number(failedServerResult[0].id);

                await conn.query(`INSERT INTO invoices 
                    (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                     subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                    VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [user[0].id, failedServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                    pending.userCurrency || 'INR',
                    pending.finalPrice,
                    `${plan[0].name} - Provisioning Pending`,
                    pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address, pending.gst_number, 'phonepe', transactionId]
                );

                // Mark plan as out of stock
                await conn.query("UPDATE Plans SET is_out_of_stock = 1 WHERE id = ?", [plan[0].id]);
                console.log(`[PhonePe] Plan ${plan[0].id} marked as out of stock`);

                // Discord notification
                try {
                    const discord = require('../services/discord');
                    await discord.serverCreationFailed(user[0], plan[0], serverCreationError, transactionId);
                } catch (e) { console.error('[Discord]', e.message); }

                // Clear pending payment
                delete req.session.pendingPayment;

                // Success popup (server was "created" but is in failed state)
                req.session.checkoutSuccess = {
                    serverName: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                    planName: plan[0].name,
                    pteroPass: null,
                    transactionId,
                    paymentMethod: 'phonepe',
                    provisioningDelayed: true
                };

                req.session.save(() => {
                    res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
                });
            }

        } else {
            // Payment failed or pending
            console.log('[PhonePe] Payment failed or pending:', statusResponse);

            const failureMsg = statusResponse.message || statusResponse.errorCode || 'Payment failed or was cancelled.';

            req.session.checkoutFailure = {
                message: failureMsg
            };

            req.session.save(() => {
                res.redirect('/dashboard/checkout/' + pending.planId + '?failure=1');
            });
        }

    } catch (err) {
        console.error('[PhonePe Callback Error]', err);
        delete req.session.pendingPayment;
        req.flash('error_msg', 'Error processing payment: ' + err.message);
        res.redirect('/dashboard/store');
    } finally {
        if (conn) conn.release();
    }
});

// PhonePe Webhook (Server-to-server notification)
// Uses validateCallback() from pg-sdk-node as per official documentation
router.post('/phonepe/webhook', async (req, res) => {
    console.log('[PhonePe Webhook] Received');
    console.log('[PhonePe Webhook] Headers:', JSON.stringify(req.headers, null, 2));

    let conn;
    try {
        // Get PhonePe gateway config
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe'");
        if (gateway.length === 0) {
            console.error('[PhonePe Webhook] PhonePe gateway not found');
            return res.status(500).json({ error: 'Gateway not configured' });
        }

        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
        const { StandardCheckoutClient, Env } = require('pg-sdk-node');

        const merchantId = config.clientId;
        let saltKey = config.clientSecret;
        let saltIndex = parseInt(config.clientVersion) || 1;

        if (saltKey && saltKey.includes('###')) {
            const parts = saltKey.split('###');
            saltKey = parts[0];
            saltIndex = parseInt(parts[1]) || saltIndex;
        }

        const env = config.environment === 'production' ? Env.PRODUCTION : Env.SANDBOX;
        const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex, env);

        // Get authorization header and body
        const authorizationHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
        const bodyString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

        console.log('[PhonePe Webhook] Body:', bodyString);

        // Validate callback using SDK's validateCallback method
        // Note: username & password are configured in PhonePe Dashboard for webhook auth
        const webhookUsername = config.webhookUsername || '';
        const webhookPassword = config.webhookPassword || '';

        let callbackResponse;
        try {
            callbackResponse = client.validateCallback(
                webhookUsername,
                webhookPassword,
                authorizationHeader,
                bodyString
            );
            console.log('[PhonePe Webhook] Validated callback:', JSON.stringify(callbackResponse, null, 2));
        } catch (validationError) {
            console.error('[PhonePe Webhook] Validation failed:', validationError.message);
            // Continue processing even if validation fails (for development/testing)
            // In production, you should return 401 here
        }

        // Extract event data from the callback
        const eventType = callbackResponse?.type || req.body?.type;
        const payload = callbackResponse?.payload || req.body?.payload || req.body;

        console.log('[PhonePe Webhook] Event Type:', eventType);
        console.log('[PhonePe Webhook] Payload:', JSON.stringify(payload, null, 2));

        // Handle successful order completion
        if (eventType === 'CHECKOUT_ORDER_COMPLETED' || eventType === 'PG_ORDER_COMPLETED') {
            const merchantOrderId = payload.orderId || payload.merchantOrderId;
            const state = payload.state;

            if (state === 'COMPLETED' && merchantOrderId) {
                // Check if it's an invoice payment (starts with INV)
                if (merchantOrderId.startsWith('INV')) {
                    const parts = merchantOrderId.split('_');
                    const invoiceIdStr = parts[0].replace('INV', '');
                    const invoiceId = parseInt(invoiceIdStr);

                    if (invoiceId) {
                        const invoice = await conn.query("SELECT * FROM invoices WHERE id = ?", [invoiceId]);

                        if (invoice.length > 0 && invoice[0].status !== 'paid') {
                            const transactionId = payload.paymentDetails?.[0]?.transactionId || merchantOrderId;

                            await conn.query(
                                "UPDATE invoices SET status = 'paid', paid_at = NOW(), payment_method = 'phonepe', transaction_id = ? WHERE id = ?",
                                [transactionId, invoiceId]
                            );
                            console.log(`[PhonePe Webhook] Invoice #${invoiceId} marked as paid`);

                            // Handle Server Renewal
                            if (invoice[0].server_id) {
                                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [invoice[0].server_id]);
                                if (serverRow.length > 0) {
                                    const billingInterval = getBillingInterval(serverRow[0].billing_period);
                                    await conn.query(
                                        `UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`,
                                        [invoice[0].server_id]
                                    );
                                    if (serverRow[0].ptero_server_id) {
                                        try {
                                            const pteroService = require('../services/pterodactyl');
                                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                                            console.log(`[PhonePe Webhook] Server #${invoice[0].server_id} unsuspended`);
                                        } catch (e) {
                                            console.error('[PhonePe Webhook] Unsuspension Error:', e.message);
                                        }
                                    }
                                }
                            }
                        } else {
                            console.log(`[PhonePe Webhook] Invoice #${invoiceId} already paid or not found`);
                        }
                    }
                }
                // TODO: Handle checkout payments (non-invoice) if needed
            }
        }
    } catch (err) {
        console.error('[PhonePe Webhook Error]', err);
    } finally {
        if (conn) conn.release();
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ status: 'OK' });
});

// Success Page
router.get('/checkout/success', ensureAuthenticated, (req, res) => {
    const successData = req.session.paymentSuccess;
    if (!successData) {
        return res.redirect('/dashboard');
    }
    delete req.session.paymentSuccess;
    res.render('dashboard/payment_success', successData);
});

// ================== STRIPE CHECKOUT SUCCESS ROUTE ==================
// This handles the redirect after Stripe payment for new server purchases
router.get('/stripe/checkout-success', ensureAuthenticated, async (req, res) => {
    console.log('[Stripe Checkout] Success callback received');

    const { session_id } = req.query;
    if (!session_id) {
        req.flash('error_msg', 'Invalid payment session.');
        return res.redirect('/dashboard/store');
    }

    const pending = req.session.pendingPayment;
    if (!pending) {
        req.flash('error_msg', 'Payment session expired. Please try again.');
        return res.redirect('/dashboard/store');
    }

    let conn;
    try {
        // Get Stripe gateway config
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe'");
        if (gateway.length === 0) {
            throw new Error('Stripe gateway not found');
        }

        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
        const stripe = require('stripe')(config.secretKey);

        // Verify the session with Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        console.log('[Stripe Checkout] Session status:', session.payment_status);

        if (session.payment_status !== 'paid') {
            req.flash('error_msg', 'Payment was not completed. Please try again.');
            delete req.session.pendingPayment;
            conn.release();
            return res.redirect('/dashboard/checkout/' + pending.planId);
        }

        // Payment verified! Now create the server (matching PhonePe callback and Credits flow)
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [pending.planId]);

        if (user.length === 0 || plan.length === 0) {
            throw new Error('User or plan not found');
        }

        // Update billing info
        await conn.query("UPDATE users SET billing_address = ?, gst_number = ? WHERE id = ?",
            [pending.billing_address || '', pending.gst_number || '', user[0].id]);

        // Increment coupon usage
        if (pending.couponId) {
            await conn.query("UPDATE coupons SET uses = uses + 1 WHERE id = ?", [pending.couponId]);
        }

        // HANDLE PTERODACTYL USER
        let pteroId = user[0].ptero_id;
        let pteroPass = null;

        if (!pteroId) {
            const existingPteroUser = await pteroService.getUser(user[0].email);
            if (existingPteroUser) {
                pteroId = existingPteroUser.id;
            } else {
                pteroPass = require('crypto').randomBytes(8).toString('hex');
                const pteroUser = await pteroService.createUser({
                    email: user[0].email,
                    username: user[0].username
                }, pteroPass);
                pteroId = pteroUser.id;
            }
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [pteroId, user[0].id]);
        }

        // Create server - wrapped in try/catch so we can handle failures gracefully
        let pteroServer = null;
        let serverCreationError = null;
        let localServerId = null;

        try {
            // Use the correct field names matching the pterodactyl service and credit flow
            const serverData = {
                name: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                user_id: pteroId,
                egg_id: plan[0].egg_id,
                nest_id: plan[0].nest_id,
                docker_image: plan[0].docker_image,
                startup_cmd: plan[0].startup_cmd,
                environment_config: plan[0].environment_config,
                user_env_overrides: pending.userEnvOverrides || {},
                ram: plan[0].ram,
                swap: 0,
                disk: plan[0].disk,
                cpu: plan[0].cpu,
                location_id: pending.selectedRegion?.id || pending.region,
                db_count: plan[0].db_count,
                allocations: plan[0].allocations,
                backups: plan[0].backups
            };

            pteroServer = await pteroService.createServer(serverData);

            // Save active server with dynamic billing interval
            const billingInterval = getBillingInterval(plan[0].billing_period);
            const serverInsertResult = await conn.query(`INSERT INTO active_servers 
                (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, renewal_date) 
                VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ${billingInterval}))`,
                [user[0].id, plan[0].id, pteroServer.id, pteroServer.identifier, pteroServer.name, pending.selectedRegion?.id || pending.region]
            );

            localServerId = Number(serverInsertResult.insertId);
        } catch (serverErr) {
            console.error('[Stripe] Server creation failed after payment success:', serverErr.message);
            serverCreationError = serverErr.message;
        }

        // Use session payment_intent as transaction_id
        const transactionId = session.payment_intent;

        if (pteroServer && localServerId) {
            // SUCCESS: Server created - create PAID invoice
            await conn.query(`INSERT INTO invoices 
                (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                 subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user[0].id, localServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                pending.userCurrency || 'USD',
                pending.finalPrice,
                `${plan[0].name} - ${pending.selectedRegion?.long_name || pending.selectedRegion?.short || 'Server'}`,
                pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address || '', pending.gst_number || '', 'stripe', transactionId]
            );

            // Award Commission (Newly created invoice)
            const [newInvoice] = await conn.query("SELECT LAST_INSERT_ID() as id");
            if (newInvoice) {
                await affiliateService.processCommission(newInvoice.id, conn);
            }

            // Clear pending payment
            delete req.session.pendingPayment;

            // Success popup data - matching the credits and PhonePe flow
            req.session.checkoutSuccess = {
                serverName: pteroServer.name,
                planName: plan[0].name,
                pteroPass,
                transactionId,
                paymentMethod: 'stripe'
            };

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.planPurchased(plan[0], { username: user[0].username }, { server_name: pteroServer.name });
            } catch (e) { console.error('[Discord]', e.message); }

            conn.release();
            req.session.save(() => {
                res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
            });
        } else {
            // FAILURE: Server creation failed - create failed server entry
            console.log('[Stripe] Creating failed server entry for server creation failure');

            // Create server entry with 'failed' status using dynamic billing interval
            const failedBillingInterval = getBillingInterval(plan[0].billing_period);
            await conn.query(`INSERT INTO active_servers 
                (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, failure_reason, renewal_date) 
                VALUES (?, ?, NULL, NULL, ?, ?, 'failed', ?, DATE_ADD(NOW(), INTERVAL ${failedBillingInterval}))`,
                [user[0].id, plan[0].id, pending.server_name || `${user[0].username}'s ${plan[0].name}`, pending.selectedRegion?.id || pending.region, serverCreationError]
            );

            // Create invoice (paid, but linked to failed server)
            const failedServerResult = await conn.query(`SELECT LAST_INSERT_ID() as id`);
            const failedServerId = Number(failedServerResult[0].id);

            await conn.query(`INSERT INTO invoices 
                (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                 subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user[0].id, failedServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                pending.userCurrency || 'USD',
                pending.finalPrice,
                `${plan[0].name} - Provisioning Pending`,
                pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address || '', pending.gst_number || '', 'stripe', transactionId]
            );

            // Award Commission (Newly created invoice for failed server)
            const [newFailedInvoice] = await conn.query("SELECT LAST_INSERT_ID() as id");
            if (newFailedInvoice) {
                await affiliateService.processCommission(newFailedInvoice.id, conn);
            }

            // Mark plan as out of stock
            await conn.query("UPDATE Plans SET is_out_of_stock = 1 WHERE id = ?", [plan[0].id]);
            console.log(`[Stripe] Plan ${plan[0].id} marked as out of stock`);

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.serverCreationFailed(user[0], plan[0], serverCreationError, transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            // Clear pending payment
            delete req.session.pendingPayment;

            // Success popup (server was "created" but is in failed state)
            req.session.checkoutSuccess = {
                serverName: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                planName: plan[0].name,
                pteroPass: null,
                transactionId,
                paymentMethod: 'stripe',
                provisioningDelayed: true
            };

            conn.release();
            req.session.save(() => {
                res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
            });
        }

    } catch (err) {
        console.error('[Stripe Checkout Error]', err);
        delete req.session.pendingPayment;
        req.flash('error_msg', 'Error processing payment: ' + err.message);
        if (conn) conn.release();
        res.redirect('/dashboard/store');
    }
});

// PayPal Checkout Success Callback
router.get('/paypal/checkout-success', ensureAuthenticated, async (req, res) => {
    console.log('[PayPal Checkout] Success callback received');
    debugLogger.paypal('CALLBACK', 'PayPal checkout success callback', { query: req.query });

    const { token, PayerID } = req.query;
    if (!token) {
        req.flash('error_msg', 'Invalid PayPal payment session.');
        return res.redirect('/dashboard/store');
    }

    const pending = req.session.pendingPayment;
    if (!pending) {
        req.flash('error_msg', 'Payment session expired. Please try again.');
        return res.redirect('/dashboard/store');
    }

    let conn;
    try {
        // Get PayPal gateway config
        conn = await db.getConnection();
        const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'paypal'");
        if (gateway.length === 0) {
            throw new Error('PayPal gateway not found');
        }

        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

        const { Client, Environment, OrdersController } = require('@paypal/paypal-server-sdk');

        const paypalClient = new Client({
            clientCredentialsAuthCredentials: {
                oAuthClientId: config.clientId,
                oAuthClientSecret: config.secret
            },
            environment: config.environment === 'production' ? Environment.Production : Environment.Sandbox
        });

        const ordersController = new OrdersController(paypalClient);

        // Capture the order
        console.log('[PayPal] Capturing order:', token);
        const captureResponse = await ordersController.captureOrder({ id: token });
        console.log('[PayPal] Capture response status:', captureResponse.result.status);
        debugLogger.paypal('RESPONSE', 'PayPal order captured', { status: captureResponse.result.status });

        if (captureResponse.result.status !== 'COMPLETED') {
            req.flash('error_msg', 'Payment was not completed. Please try again.');
            delete req.session.pendingPayment;
            conn.release();
            return res.redirect('/dashboard/checkout/' + pending.planId);
        }

        // Payment verified! Now create the server
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [pending.planId]);

        if (user.length === 0 || plan.length === 0) {
            throw new Error('User or plan not found');
        }

        // Update billing info
        await conn.query("UPDATE users SET billing_address = ?, gst_number = ? WHERE id = ?",
            [pending.billing_address || '', pending.gst_number || '', user[0].id]);

        // Increment coupon usage
        if (pending.couponId) {
            await conn.query("UPDATE coupons SET uses = uses + 1 WHERE id = ?", [pending.couponId]);
        }

        // HANDLE PTERODACTYL USER
        let pteroId = user[0].ptero_id;
        let pteroPass = null;

        if (!pteroId) {
            const existingPteroUser = await pteroService.getUser(user[0].email);
            if (existingPteroUser) {
                pteroId = existingPteroUser.id;
            } else {
                pteroPass = require('crypto').randomBytes(8).toString('hex');
                const pteroUser = await pteroService.createUser({
                    email: user[0].email,
                    username: user[0].username
                }, pteroPass);
                pteroId = pteroUser.id;
            }
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [pteroId, user[0].id]);
        }

        // Create server
        let pteroServer = null;
        let serverCreationError = null;
        let localServerId = null;

        try {
            const serverData = {
                name: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                user_id: pteroId,
                egg_id: plan[0].egg_id,
                nest_id: plan[0].nest_id,
                docker_image: plan[0].docker_image,
                startup_cmd: plan[0].startup_cmd,
                environment_config: plan[0].environment_config,
                user_env_overrides: pending.userEnvOverrides || {},
                ram: plan[0].ram,
                swap: 0,
                disk: plan[0].disk,
                cpu: plan[0].cpu,
                location_id: pending.selectedRegion?.id || pending.region,
                db_count: plan[0].db_count,
                allocations: plan[0].allocations,
                backups: plan[0].backups
            };

            pteroServer = await pteroService.createServer(serverData);

            // Save active server with dynamic billing interval
            const billingInterval = getBillingInterval(plan[0].billing_period);
            const serverInsertResult = await conn.query(`INSERT INTO active_servers 
                (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, renewal_date) 
                VALUES (?, ?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(), INTERVAL ${billingInterval}))`,
                [user[0].id, plan[0].id, pteroServer.id, pteroServer.identifier, pteroServer.name, pending.selectedRegion?.id || pending.region]
            );

            localServerId = Number(serverInsertResult.insertId);
        } catch (serverErr) {
            console.error('[PayPal] Server creation failed after payment success:', serverErr.message);
            serverCreationError = serverErr.message;
        }

        // Get PayPal transaction ID
        const transactionId = captureResponse.result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id || token;

        if (pteroServer && localServerId) {
            // SUCCESS: Server created - create PAID invoice
            await conn.query(`INSERT INTO invoices 
                (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                 subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user[0].id, localServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                pending.userCurrency || 'USD',
                pending.finalPrice,
                `${plan[0].name} - ${pending.selectedRegion?.long_name || pending.selectedRegion?.short || 'Server'}`,
                pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address || '', pending.gst_number || '', 'paypal', transactionId]
            );

            // Award Commission (Newly created invoice)
            const [newInvoice] = await conn.query("SELECT LAST_INSERT_ID() as id");
            if (newInvoice) {
                await affiliateService.processCommission(newInvoice.id, conn);
            }

            // Clear pending payment
            delete req.session.pendingPayment;

            // Success popup data
            req.session.checkoutSuccess = {
                serverName: pteroServer.name,
                planName: plan[0].name,
                pteroPass,
                transactionId,
                paymentMethod: 'paypal'
            };

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.planPurchased(plan[0], { username: user[0].username }, { server_name: pteroServer.name });
            } catch (e) { console.error('[Discord]', e.message); }

            conn.release();
            req.session.save(() => {
                res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
            });
        } else {
            // FAILURE: Server creation failed - create failed server entry
            console.log('[PayPal] Creating failed server entry for server creation failure');

            // Create server entry with 'failed' status using dynamic billing interval
            const failedBillingInterval = getBillingInterval(plan[0].billing_period);
            await conn.query(`INSERT INTO active_servers 
                (user_id, plan_id, ptero_server_id, ptero_identifier, server_name, location_id, status, failure_reason, renewal_date) 
                VALUES (?, ?, NULL, NULL, ?, ?, 'failed', ?, DATE_ADD(NOW(), INTERVAL ${failedBillingInterval}))`,
                [user[0].id, plan[0].id, pending.server_name || `${user[0].username}'s ${plan[0].name}`, pending.selectedRegion?.id || pending.region, serverCreationError]
            );

            // Create invoice (paid, but linked to failed server)
            const failedServerResult = await conn.query(`SELECT LAST_INSERT_ID() as id`);
            const failedServerId = Number(failedServerResult[0].id);

            await conn.query(`INSERT INTO invoices 
                (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description,
                 subtotal, tax_rate, tax_amount, billing_address, gst_number, payment_method, transaction_id) 
                VALUES (?, ?, ?, ?, ?, ?, 'paid', 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user[0].id, failedServerId, plan[0].id, pending.finalPrice / pending.currencyRate,
                pending.userCurrency || 'USD',
                pending.finalPrice,
                `${plan[0].name} - Provisioning Pending`,
                pending.subtotal, pending.taxRate, pending.taxAmount, pending.billing_address || '', pending.gst_number || '', 'paypal', transactionId]
            );

            // Mark plan as out of stock
            await conn.query("UPDATE Plans SET is_out_of_stock = 1 WHERE id = ?", [plan[0].id]);
            console.log(`[PayPal] Plan ${plan[0].id} marked as out of stock`);

            // Discord notification
            try {
                const discord = require('../services/discord');
                await discord.serverCreationFailed(user[0], plan[0], serverCreationError, transactionId);
            } catch (e) { console.error('[Discord]', e.message); }

            // Clear pending payment
            delete req.session.pendingPayment;

            // Success popup (server was "created" but is in failed state)
            req.session.checkoutSuccess = {
                serverName: pending.server_name || `${user[0].username}'s ${plan[0].name}`,
                planName: plan[0].name,
                pteroPass: null,
                transactionId,
                paymentMethod: 'paypal',
                provisioningDelayed: true
            };

            conn.release();
            req.session.save(() => {
                res.redirect('/dashboard/checkout/' + pending.planId + '?success=1');
            });
        }

    } catch (err) {
        console.error('[PayPal Checkout Error]', err);
        debugLogger.paypal('ERROR', 'PayPal checkout callback error', { error: err.message });
        delete req.session.pendingPayment;
        req.flash('error_msg', 'Error processing PayPal payment: ' + err.message);
        if (conn) conn.release();
        res.redirect('/dashboard/store');
    }
});


// API: Ping Location Node
router.get('/api/locations/:id/ping', async (req, res) => {
    const { exec } = require('child_process');
    let conn;
    try {
        conn = await db.getConnection();
        const location = await conn.query("SELECT * FROM locations WHERE id = ?", [req.params.id]);

        if (location.length === 0) {
            return res.json({ error: 'Location not found', latency: null });
        }

        let fqdn = location[0].fqdn;

        // If no cached FQDN, fetch from Pterodactyl
        if (!fqdn && location[0].node_id) {
            try {
                const nodes = await pteroService.getNodes();
                const node = nodes.find(n => n.id === location[0].node_id);
                if (node && node.fqdn) {
                    fqdn = node.fqdn;
                    // Cache it for future use
                    await conn.query("UPDATE locations SET fqdn = ? WHERE id = ?", [fqdn, req.params.id]);
                }
            } catch (err) {
                console.error('[Ping API] Error fetching node:', err.message);
            }
        }

        if (!fqdn) {
            return res.json({ error: 'No FQDN available', latency: null });
        }

        // Ping the FQDN
        exec(`ping -c 1 -W 2 ${fqdn}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`[Ping API] Error pinging ${fqdn}:`, error.message);
                return res.json({ error: 'Ping failed', latency: null });
            }

            // Parse latency from ping output
            // Linux: time=45.2 ms
            const match = stdout.match(/time[=<](\d+\.?\d*)/);
            if (match) {
                const latency = Math.round(parseFloat(match[1]));
                return res.json({ latency, unit: 'ms' });
            }

            return res.json({ error: 'Could not parse latency', latency: null });
        });

    } catch (err) {
        console.error('[Ping API] Error:', err);
        res.json({ error: 'Server error', latency: null });
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;

