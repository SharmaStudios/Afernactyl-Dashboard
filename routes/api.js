const router = require('express').Router();
const db = require('../config/database');

/**
 * GET /api/plans
 * Public API to get all available plans with locations and categories
 * 
 * Query params:
 *   - location: Filter by location ID (pre-selects this location on checkout)
 *   - category: Filter by category ID
 *   - visible_only: If 'true', only show visible plans (default: true)
 */
router.get('/plans', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const { location, category, visible_only } = req.query;

        // Build query with optional filters
        let query = `
            SELECT 
                p.id,
                p.name,
                p.description,
                p.price,
                p.ram,
                p.cpu,
                p.disk,
                p.allocations,
                p.backups,
                p.db_count,
                p.is_out_of_stock,
                p.is_visible,
                p.billing_period,
                p.category_id,
                c.name AS category_name
            FROM Plans p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;
        const params = [];

        // Filter by category
        if (category) {
            query += ' AND p.category_id = ?';
            params.push(category);
        }

        // Filter visibility (default: only visible)
        if (visible_only !== 'false') {
            query += ' AND p.is_visible = 1';
        }

        query += ' ORDER BY c.name ASC, p.price ASC';

        const plans = await conn.query(query, params);

        // Get all public locations
        let locationQuery = `
            SELECT 
                id,
                short,
                long_name,
                multiplier,
                is_sold_out,
                region,
                country_code,
                fqdn,
                processor_name
            FROM locations
            WHERE is_public = 1
            ORDER BY region ASC, long_name ASC
        `;
        const locations = await conn.query(locationQuery);

        // Get categories
        const categories = await conn.query(`
            SELECT id, name
            FROM categories
            ORDER BY name ASC
        `);

        conn.release();

        // Build response
        const response = {
            success: true,
            plans: plans.map(plan => ({
                id: plan.id,
                name: plan.name,
                description: plan.description,
                price: parseFloat(plan.price),
                specs: {
                    ram_mb: plan.ram,
                    ram_gb: plan.ram / 1024,
                    cpu_percent: plan.cpu,
                    cpu_cores: plan.cpu / 100,
                    disk_mb: plan.disk,
                    disk_gb: plan.disk / 1024
                },
                features: {
                    allocations: plan.allocations || 0,
                    backups: plan.backups || 0,
                    databases: plan.db_count || 0
                },
                is_out_of_stock: !!plan.is_out_of_stock,
                is_visible: !!plan.is_visible,
                billing_period: plan.billing_period || 'monthly',
                category: plan.category_id ? {
                    id: plan.category_id,
                    name: plan.category_name
                } : null
            })),
            locations: locations.map(loc => ({
                id: loc.id,
                name: loc.long_name || loc.short,
                short: loc.short,
                region: loc.region,
                country_code: loc.country_code,
                fqdn: loc.fqdn,
                processor: loc.processor_name,
                multiplier: parseFloat(loc.multiplier),
                is_sold_out: !!loc.is_sold_out
            })),
            categories: categories.map(cat => ({
                id: cat.id,
                name: cat.name
            })),
            filters: {
                location: location ? parseInt(location) : null,
                category: category ? parseInt(category) : null
            },
            checkout_url_template: '/dashboard/checkout/{plan_id}' + (location ? `?location=${location}` : '')
        };

        res.json(response);

    } catch (err) {
        console.error('[API] Error fetching plans:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch plans',
            details: err.message
        });
    }
});

/**
 * GET /api/locations
 * Public API to get all available locations
 */
router.get('/locations', async (req, res) => {
    try {
        const conn = await db.getConnection();

        const locations = await conn.query(`
            SELECT 
                id,
                short,
                long_name,
                multiplier,
                is_sold_out,
                region,
                country_code,
                fqdn,
                processor_name
            FROM locations
            WHERE is_public = 1
            ORDER BY region ASC, long_name ASC
        `);

        conn.release();

        res.json({
            success: true,
            locations: locations.map(loc => ({
                id: loc.id,
                name: loc.long_name || loc.short,
                short: loc.short,
                region: loc.region,
                country_code: loc.country_code,
                fqdn: loc.fqdn,
                processor: loc.processor_name,
                multiplier: parseFloat(loc.multiplier),
                is_sold_out: !!loc.is_sold_out
            }))
        });

    } catch (err) {
        console.error('[API] Error fetching locations:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch locations'
        });
    }
});

/**
 * GET /api/categories
 * Public API to get all categories
 */
router.get('/categories', async (req, res) => {
    try {
        const conn = await db.getConnection();

        const categories = await conn.query(`
            SELECT id, name
            FROM categories
            ORDER BY name ASC
        `);

        conn.release();

        res.json({
            success: true,
            categories: categories.map(cat => ({
                id: cat.id,
                name: cat.name
            }))
        });

    } catch (err) {
        console.error('[API] Error fetching categories:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch categories'
        });
    }
});

module.exports = router;
