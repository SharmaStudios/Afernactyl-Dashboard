const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../middleware/auth');
const db = require('../config/database');
const pteroService = require('../services/pterodactyl');
const debugLogger = require('../services/debugLogger');
const authService = require('../services/authService');


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

// Admin Middleware
router.use(ensureAdmin);

// Overview
router.get('/', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const userCount = await conn.query("SELECT count(*) as count FROM users");
        const serverCount = await conn.query("SELECT count(*) as count FROM active_servers");
        const income = await conn.query("SELECT sum(price) as total FROM Plans JOIN active_servers ON Plans.id = active_servers.plan_id");
        const [affiliateCount] = await conn.query("SELECT count(*) as count FROM affiliates");
        const [pendingPayouts] = await conn.query("SELECT sum(amount) as total FROM affiliate_payouts WHERE status = 'pending'");
        conn.release();

        res.render('admin/index', {
            userCount: userCount[0].count,
            serverCount: serverCount[0].count,
            income: income[0].total || 0,
            affiliateCount: affiliateCount[0].count,
            pendingPayouts: pendingPayouts[0].total || 0
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

// API: Check for updates (proxy to avoid CORS)
router.get('/api/version', async (req, res) => {
    try {
        const response = await fetch('https://sharmastudios.github.io/Afernactyl/');
        const text = await response.text();
        console.log('[Version API] Raw response:', text);

        // Try to parse as JSON
        try {
            const data = JSON.parse(text);
            res.json(data);
        } catch (parseErr) {
            // If parsing fails, try to extract JSON from any wrapper
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                res.json(data);
            } else {
                res.status(500).json({ error: 'Invalid response format' });
            }
        }
    } catch (err) {
        console.error('Error checking version:', err.message);
        res.status(500).json({ error: 'Failed to check for updates' });
    }
});

// API: Get Nests from Pterodactyl
router.get('/api/nests', async (req, res) => {
    try {
        const nests = await pteroService.getNests();
        res.json(nests);
    } catch (err) {
        console.error('Error fetching nests:', err.message);
        res.status(500).json({ error: 'Failed to fetch nests' });
    }
});

// API: Get Eggs for a Nest (with variables)
router.get('/api/eggs/:nestId', async (req, res) => {
    try {
        const eggs = await pteroService.getEggs(req.params.nestId);
        res.json(eggs);
    } catch (err) {
        console.error('Error fetching eggs:', err.message);
        res.status(500).json({ error: 'Failed to fetch eggs' });
    }
});

// API: Get Egg Variables
router.get('/api/egg/:nestId/:eggId/variables', async (req, res) => {
    try {
        const egg = await pteroService.getEggDetails(req.params.nestId, req.params.eggId);
        // Variables are in egg.relationships.variables.data
        const variables = egg.relationships?.variables?.data || [];
        const formatted = variables.map(v => ({
            name: v.attributes.name,
            env_variable: v.attributes.env_variable,
            default_value: v.attributes.default_value,
            user_viewable: v.attributes.user_viewable,
            user_editable: v.attributes.user_editable,
            rules: v.attributes.rules
        }));
        res.json({
            startup: egg.startup,
            docker_images: egg.docker_images,
            variables: formatted
        });
    } catch (err) {
        console.error('Error fetching egg variables:', err.message);
        res.status(500).json({ error: 'Failed to fetch egg variables' });
    }
});

// Plans List
router.get('/plans', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const plans = await conn.query(`
            SELECT Plans.*, categories.name as category_name,
                   (SELECT COUNT(*) FROM active_servers WHERE active_servers.plan_id = Plans.id) as server_count
            FROM Plans 
            LEFT JOIN categories ON Plans.category_id = categories.id
            ORDER BY Plans.id DESC
        `);
        conn.release();
        res.render('admin/plans', { plans });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Create Plan Page
router.get('/plans/create', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const categories = await conn.query("SELECT * FROM categories");
        const currencies = await conn.query("SELECT * FROM currencies WHERE is_active = 1");
        conn.release();

        res.render('admin/plan_form', { categories, currencies, plan: null, nests: [] });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/plans');
    }
});

// Create Plan Logic
router.post('/plans/create', async (req, res) => {
    const { name, price, ram, cpu, disk, docker_image, startup_cmd, description, is_out_of_stock, is_visible, allocations, db_count, backups, environment_config, processor_name, billing_period, category_id, allow_egg_selection } = req.body;
    // Support both new (final) and old field names for nest/egg IDs
    let egg_id = req.body.egg_id_final || req.body.egg_id;
    let nest_id = req.body.nest_id_final || req.body.nest_id;

    // Handle "Let User Choose" option - set to NULL when user mode
    if (nest_id === 'user') nest_id = null;
    if (egg_id === 'user') egg_id = null;

    try {
        const conn = await db.getConnection();

        // Convert Resources
        const ramMB = parseInt(ram) * 1024;
        const diskMB = parseInt(disk) * 1024;
        const cpuPercent = parseFloat(cpu) * 100;

        const result = await conn.query(`INSERT INTO Plans 
            (name, price, ram, cpu, disk, egg_id, nest_id, category_id, docker_image, startup_cmd, description, is_out_of_stock, is_visible, allocations, db_count, backups, environment_config, processor_name, billing_period, allow_egg_selection) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name, price, ramMB, cpuPercent, diskMB, egg_id, nest_id, category_id, docker_image,
                startup_cmd || '',
                description, is_out_of_stock ? 1 : 0,
                is_visible !== undefined ? (is_visible ? 1 : 0) : 1,
                allocations || 0, db_count || 0, backups || 0,
                environment_config || '{}',
                processor_name || null,
                billing_period || 'monthly',
                allow_egg_selection == '1' ? 1 : 0
            ]
        );

        // Save Regional Prices
        const planId = Number(result.insertId);
        const { prices } = req.body; // e.g., { 'EUR': '5.50', 'INR': '400' }
        if (prices) {
            for (const [code, p] of Object.entries(prices)) {
                if (p && !isNaN(parseFloat(p))) {
                    await conn.query("INSERT INTO plan_prices (plan_id, currency_code, price) VALUES (?, ?, ?)", [planId, code, parseFloat(p)]);
                }
            }
        }
        conn.release();
        req.flash('success_msg', 'Plan created');
        res.redirect('/admin/plans');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error creating plan');
        res.redirect('/admin/plans/create');
    }
});

// Edit Plan Page
router.get('/plans/:id/edit', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const plan = await conn.query("SELECT * FROM Plans WHERE id = ?", [req.params.id]);
        const categories = await conn.query("SELECT * FROM categories");
        const currencies = await conn.query("SELECT * FROM currencies WHERE is_active = 1");

        // Fetch existing regional prices for this plan
        const planPrices = await conn.query("SELECT currency_code, price FROM plan_prices WHERE plan_id = ?", [req.params.id]);
        conn.release();

        if (plan.length === 0) return res.redirect('/admin/plans');

        // Convert back for View (MB -> GB, % -> Cores)
        plan[0].ram = plan[0].ram / 1024;
        plan[0].disk = plan[0].disk / 1024;
        plan[0].cpu = plan[0].cpu / 100;

        // Convert regional prices to a map for easy access in the view
        plan[0].prices = {};
        planPrices.forEach(pp => {
            plan[0].prices[pp.currency_code] = pp.price;
        });

        res.render('admin/plan_form', { categories, currencies, plan: plan[0], nests: [] });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/plans');
    }
});

// Edit Plan Logic
router.post('/plans/:id/edit', async (req, res) => {
    const { name, price, ram, cpu, disk, docker_image, startup_cmd, description, is_out_of_stock, is_visible, allocations, db_count, backups, environment_config, processor_name, billing_period, category_id, allow_egg_selection } = req.body;
    // Support both new (final) and old field names for nest/egg IDs
    let egg_id = req.body.egg_id_final || req.body.egg_id;
    let nest_id = req.body.nest_id_final || req.body.nest_id;

    // Handle "Let User Choose" option - set to NULL when user mode
    if (nest_id === 'user') nest_id = null;
    if (egg_id === 'user') egg_id = null;

    try {
        const conn = await db.getConnection();

        // Convert Resources
        const ramMB = parseInt(ram) * 1024;
        const diskMB = parseInt(disk) * 1024;
        const cpuPercent = parseFloat(cpu) * 100;

        await conn.query(`UPDATE Plans SET 
            name=?, price=?, ram=?, cpu=?, disk=?, egg_id=?, nest_id=?, category_id=?, docker_image=?, startup_cmd=?, description=?, is_out_of_stock=?, is_visible=?, allocations=?, db_count=?, backups=?, environment_config=?, processor_name=?, billing_period=?, allow_egg_selection=?
            WHERE id=?`,
            [
                name, price, ramMB, cpuPercent, diskMB, egg_id, nest_id, category_id, docker_image,
                startup_cmd || '',
                description, is_out_of_stock ? 1 : 0,
                is_visible ? 1 : 0,
                allocations || 0, db_count || 0, backups || 0,
                environment_config || '{}',
                processor_name || null,
                billing_period || 'monthly',
                allow_egg_selection == '1' ? 1 : 0,
                req.params.id
            ]
        );

        // Update Regional Prices
        const planId = req.params.id;
        // First delete existing
        await conn.query("DELETE FROM plan_prices WHERE plan_id = ?", [planId]);

        const { prices } = req.body;
        if (prices) {
            for (const [code, p] of Object.entries(prices)) {
                if (p && !isNaN(parseFloat(p))) {
                    await conn.query("INSERT INTO plan_prices (plan_id, currency_code, price) VALUES (?, ?, ?)", [planId, code, parseFloat(p)]);
                }
            }
        }
        conn.release();
        req.flash('success_msg', 'Plan updated successfully');
        res.redirect('/admin/plans');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error updating plan');
        res.redirect('/admin/plans/' + req.params.id + '/edit');
    }
});

// Delete Plan
router.post('/plans/:id/delete', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const planId = req.params.id;

        // Check if there are any servers using this plan
        const servers = await conn.query("SELECT COUNT(*) as count FROM active_servers WHERE plan_id = ?", [planId]);
        if (servers[0].count > 0) {
            req.flash('error_msg', `Cannot delete plan: ${servers[0].count} server(s) are still using it. Please migrate or delete these servers first.`);
            return res.redirect('/admin/plans/' + planId + '/edit');
        }

        // Delete regional prices first (foreign key constraint)
        await conn.query("DELETE FROM plan_prices WHERE plan_id = ?", [planId]);

        // Now delete the plan
        await conn.query("DELETE FROM Plans WHERE id = ?", [planId]);

        req.flash('success_msg', 'Plan deleted successfully');
        res.redirect('/admin/plans');
    } catch (err) {
        console.error('Error deleting plan:', err);
        req.flash('error_msg', 'Error deleting plan: ' + (err.message || 'Unknown error'));
        res.redirect('/admin/plans/' + req.params.id + '/edit');
    } finally {
        if (conn) conn.release();
    }
});

// Toggle Single Plan Stock Status
router.post('/plans/:id/stock', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const planId = req.params.id;

        // Get current stock status and toggle it
        const plan = await conn.query("SELECT is_out_of_stock FROM Plans WHERE id = ?", [planId]);
        if (plan.length === 0) {
            req.flash('error_msg', 'Plan not found');
            return res.redirect('/admin/plans');
        }

        const newStatus = plan[0].is_out_of_stock ? 0 : 1;
        await conn.query("UPDATE Plans SET is_out_of_stock = ? WHERE id = ?", [newStatus, planId]);

        req.flash('success_msg', `Plan marked as ${newStatus ? 'out of stock' : 'in stock'}`);
        res.redirect('/admin/plans');
    } catch (err) {
        console.error('Error toggling plan stock:', err);
        req.flash('error_msg', 'Error updating plan stock status');
        res.redirect('/admin/plans');
    } finally {
        if (conn) conn.release();
    }
});

// Mass Toggle All Plans Stock Status
router.post('/plans/mass-stock', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const action = req.body.action;

        if (action === 'out_of_stock') {
            await conn.query("UPDATE Plans SET is_out_of_stock = 1");
            req.flash('success_msg', 'All plans marked as out of stock');
        } else if (action === 'in_stock') {
            await conn.query("UPDATE Plans SET is_out_of_stock = 0");
            req.flash('success_msg', 'All plans marked as in stock');
        } else {
            req.flash('error_msg', 'Invalid action');
        }

        res.redirect('/admin/plans');
    } catch (err) {
        console.error('Error mass updating plan stock:', err);
        req.flash('error_msg', 'Error updating plan stock status');
        res.redirect('/admin/plans');
    } finally {
        if (conn) conn.release();
    }
});

// Users Management
router.get('/users', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const users = await conn.query("SELECT * FROM users");
        conn.release();

        // Add gravatar to each user
        const crypto = require('crypto');
        users.forEach(u => {
            u.gravatar = 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update((u.email || '').trim().toLowerCase()).digest('hex') + '?d=mp&s=40';
        });

        res.render('admin/users', { users });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Edit User Page
router.get('/users/:id/edit', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [req.params.id]);
        conn.release();

        if (user.length === 0) return res.redirect('/admin/users');

        res.render('admin/user_form', { editUser: user[0] });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/users');
    }
});

//Edit User Logic
router.post('/users/:id/edit', async (req, res) => {
    const { first_name, last_name, username, email, balance, is_admin, password } = req.body;
    try {
        const conn = await db.getConnection();

        let query = "UPDATE users SET first_name=?, last_name=?, username=?, email=?, balance=?, is_admin=? WHERE id=?";
        let params = [first_name || null, last_name || null, username, email, balance, is_admin ? 1 : 0, req.params.id];

        if (password && password.trim().length > 0) {
            const bcrypt = require('bcrypt');
            const hashedPassword = await bcrypt.hash(password, 10);
            query = "UPDATE users SET first_name=?, last_name=?, username=?, email=?, balance=?, is_admin=?, password=? WHERE id=?";
            params = [first_name || null, last_name || null, username, email, balance, is_admin ? 1 : 0, hashedPassword, req.params.id];
        }

        await conn.query(query, params);
        conn.release();
        req.flash('success_msg', 'User updated');
        res.redirect('/admin/users');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error updating user');
        res.redirect('/admin/users/' + req.params.id + '/edit');
    }
});

// Refresh Pterodactyl Account Data
router.post('/users/:id/refresh-ptero', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;
        conn = await db.getConnection();

        const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            conn.release();
            return res.redirect('/admin/users');
        }

        const userData = user[0];
        const pteroService = require('../services/pterodactyl');

        // Check if user has a ptero_id and verify it exists in panel
        if (userData.ptero_id) {
            try {
                const client = await pteroService.getClient();
                await client.get(`/users/${userData.ptero_id}`);
                // User exists in panel
                req.flash('success_msg', `Pterodactyl account verified (ID: ${userData.ptero_id})`);
                conn.release();
                return res.redirect('/admin/users/' + userId + '/edit');
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    console.log(`[Refresh Ptero] User ${userId} not found in panel (ptero_id: ${userData.ptero_id}), will recreate`);
                } else {
                    throw error;
                }
            }
        }

        // User doesn't exist in panel or ptero_id is null - create new account
        // First check if user already exists by email
        const existingPteroUser = await pteroService.getUser(userData.email);

        if (existingPteroUser) {
            // User exists by email, just link it
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [existingPteroUser.id, userId]);
            req.flash('success_msg', `Linked existing Pterodactyl account (ID: ${existingPteroUser.id})`);
        } else {
            // Create new Pterodactyl user
            const crypto = require('crypto');
            const tempPassword = crypto.randomBytes(16).toString('hex');

            const newPteroUser = await pteroService.createUser(userData, tempPassword);
            await conn.query("UPDATE users SET ptero_id = ? WHERE id = ?", [newPteroUser.id, userId]);
            req.flash('success_msg', `Created new Pterodactyl account (ID: ${newPteroUser.id})`);
        }

        conn.release();
        res.redirect('/admin/users/' + userId + '/edit');
    } catch (err) {
        console.error('Refresh Ptero Error:', err);
        if (conn) conn.release();
        req.flash('error_msg', 'Failed to refresh Pterodactyl account: ' + (err.message || 'Unknown error'));
        res.redirect('/admin/users/' + req.params.id + '/edit');
    }
});

// ================== USER MANAGEMENT ROUTES ==================

// Suspend User
router.post('/users/:id/suspend', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;
        const reason = req.body.reason || 'Suspicious activity detected';

        conn = await db.getConnection();

        // Check if user exists and is not admin
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/users');
        }
        if (user[0].is_admin) {
            req.flash('error_msg', 'Cannot suspend an admin user');
            return res.redirect('/admin/users');
        }

        // Suspend user
        await conn.query("UPDATE users SET is_suspended = TRUE, suspension_reason = ? WHERE id = ?", [reason, userId]);

        // Also suspend all their servers in Pterodactyl
        const servers = await conn.query("SELECT ptero_server_id FROM active_servers WHERE user_id = ?", [userId]);
        for (const server of servers) {
            try {
                await pteroService.suspendServer(server.ptero_server_id);
            } catch (e) {
                console.error('Error suspending server in Pterodactyl:', e.message);
            }
        }

        req.flash('success_msg', 'User has been suspended');
        res.redirect('/admin/users');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error suspending user');
        res.redirect('/admin/users');
    } finally {
        if (conn) conn.release();
    }
});

// Unsuspend User
router.post('/users/:id/unsuspend', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;

        conn = await db.getConnection();

        // Unsuspend user
        await conn.query("UPDATE users SET is_suspended = FALSE, suspension_reason = NULL WHERE id = ?", [userId]);

        // Also unsuspend all their servers in Pterodactyl
        const servers = await conn.query("SELECT ptero_server_id FROM active_servers WHERE user_id = ?", [userId]);
        for (const server of servers) {
            try {
                await pteroService.unsuspendServer(server.ptero_server_id);
            } catch (e) {
                console.error('Error unsuspending server in Pterodactyl:', e.message);
            }
        }

        req.flash('success_msg', 'User has been unsuspended');
        res.redirect('/admin/users');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error unsuspending user');
        res.redirect('/admin/users');
    } finally {
        if (conn) conn.release();
    }
});

// Delete User
router.post('/users/:id/delete', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;

        conn = await db.getConnection();

        // Check if user exists and is not admin
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/users');
        }
        if (user[0].is_admin) {
            req.flash('error_msg', 'Cannot delete an admin user');
            return res.redirect('/admin/users');
        }

        // Delete all user's servers from Pterodactyl
        const servers = await conn.query("SELECT ptero_server_id FROM active_servers WHERE user_id = ?", [userId]);
        for (const server of servers) {
            try {
                await pteroService.deleteServer(server.ptero_server_id);
            } catch (e) {
                console.error('Error deleting server in Pterodactyl:', e.message);
            }
        }

        // Delete Pterodactyl user if exists
        if (user[0].ptero_id) {
            try {
                await pteroService.deleteUser(user[0].ptero_id);
            } catch (e) {
                console.error('Error deleting Pterodactyl user:', e.message);
            }
        }

        // Delete user from database (cascades to servers, tickets, etc.)
        await conn.query("DELETE FROM users WHERE id = ?", [userId]);

        req.flash('success_msg', 'User and all their servers have been deleted');
        res.redirect('/admin/users');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error deleting user');
        res.redirect('/admin/users');
    } finally {
        if (conn) conn.release();
    }
});

// Login As User (Impersonation)
router.post('/users/:id/login-as', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;

        conn = await db.getConnection();

        const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/users');
        }
        if (user[0].is_admin) {
            req.flash('error_msg', 'Cannot impersonate an admin user');
            return res.redirect('/admin/users');
        }

        // Store original admin session
        req.session.originalAdmin = {
            id: req.session.user.id,
            username: req.session.user.username,
            email: req.session.user.email,
            is_admin: true
        };

        // Switch to impersonated user
        req.session.user = {
            id: user[0].id,
            username: user[0].username,
            email: user[0].email,
            is_admin: false,
            is_impersonating: true
        };

        req.flash('success_msg', `You are now logged in as ${user[0].username}`);
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error impersonating user');
        res.redirect('/admin/users');
    } finally {
        if (conn) conn.release();
    }
});

// Return from Impersonation
router.post('/return-to-admin', async (req, res) => {
    if (!req.session.originalAdmin) {
        req.flash('error_msg', 'Not impersonating any user');
        return res.redirect('/dashboard');
    }

    // Restore admin session
    req.session.user = req.session.originalAdmin;
    delete req.session.originalAdmin;

    req.flash('success_msg', 'Returned to admin account');
    res.redirect('/admin/users');
});

// User Details Page
router.get('/users/:id/details', async (req, res) => {
    let conn;
    try {
        const userId = req.params.id;

        conn = await db.getConnection();

        const user = await conn.query("SELECT * FROM users WHERE id = ?", [userId]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/users');
        }

        // Get user's servers
        const servers = await conn.query(`
            SELECT s.*, p.name as plan_name, p.price 
            FROM active_servers s 
            JOIN Plans p ON s.plan_id = p.id 
            WHERE s.user_id = ?
            ORDER BY s.created_at DESC
        `, [userId]);

        // Get user's invoices
        const invoices = await conn.query(`
            SELECT * FROM invoices 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 50
        `, [userId]);

        // Add gravatar to user object
        const crypto = require('crypto');
        user[0].gravatar = 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update((user[0].email || '').trim().toLowerCase()).digest('hex') + '?d=identicon&s=200';

        res.render('admin/user_details', {
            targetUser: user[0],
            servers,
            invoices
        });
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error loading user details');
        res.redirect('/admin/users');
    } finally {
        if (conn) conn.release();
    }
});

router.get('/categories', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const categories = await conn.query("SELECT * FROM categories");
        conn.release();
        res.render('admin/categories', { categories });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Create Category
router.post('/categories', async (req, res) => {
    const { name } = req.body;
    try {
        const conn = await db.getConnection();
        await conn.query("INSERT INTO categories (name) VALUES (?)", [name]);
        conn.release();
        req.flash('success_msg', 'Category created');
        res.redirect('/admin/categories');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error creating category');
        res.redirect('/admin/categories');
    }
});

// Delete Category
router.post('/categories/:id/delete', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Check if any plans use this category
        const plans = await conn.query("SELECT COUNT(*) as count FROM Plans WHERE category_id = ?", [req.params.id]);
        if (plans[0].count > 0) {
            req.flash('error_msg', `Cannot delete: ${plans[0].count} plan(s) are using this category`);
            return res.redirect('/admin/categories');
        }

        await conn.query("DELETE FROM categories WHERE id = ?", [req.params.id]);
        req.flash('success_msg', 'Category deleted');
        res.redirect('/admin/categories');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error deleting category');
        res.redirect('/admin/categories');
    } finally {
        if (conn) conn.release();
    }
});

// Locations Management
router.get('/locations', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const locations = await conn.query("SELECT * FROM locations ORDER BY id ASC");
        conn.release();
        res.render('admin/locations', { locations });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

router.post('/locations/sync', async (req, res) => {
    try {
        const pteroLocations = await pteroService.getLocations();
        const pteroNodes = await pteroService.getNodes();
        const conn = await db.getConnection();

        // Country code mapping from common location names
        const countryMap = {
            'india': 'IN', 'singapore': 'SG', 'germany': 'DE', 'usa': 'US',
            'uk': 'GB', 'france': 'FR', 'netherlands': 'NL', 'japan': 'JP',
            'australia': 'AU', 'canada': 'CA', 'brazil': 'BR', 'russia': 'RU',
            'korea': 'KR', 'poland': 'PL', 'spain': 'ES', 'italy': 'IT',
            'sweden': 'SE', 'finland': 'FI', 'norway': 'NO', 'denmark': 'DK'
        };

        // Upsert locations
        for (let pl of pteroLocations) {
            // Find a node in this location to get fqdn
            const node = pteroNodes.find(n => n.location_id === pl.id);
            const fqdn = node ? node.fqdn : null;
            const nodeId = node ? node.id : null;

            // Try to detect country code from location short name
            const shortLower = (pl.short || '').toLowerCase();
            let countryCode = null;
            for (const [key, code] of Object.entries(countryMap)) {
                if (shortLower.includes(key)) {
                    countryCode = code;
                    break;
                }
            }

            await conn.query(`
                INSERT INTO locations (id, short, long_name, multiplier, is_public, is_sold_out, node_id, fqdn, country_code)
                VALUES (?, ?, ?, 1.00, true, false, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                short = VALUES(short),
                long_name = VALUES(long_name),
                node_id = COALESCE(VALUES(node_id), node_id),
                fqdn = COALESCE(VALUES(fqdn), fqdn),
                country_code = COALESCE(VALUES(country_code), country_code)
             `, [pl.id, pl.short, pl.long, nodeId, fqdn, countryCode]);
        }

        conn.release();
        req.flash('success_msg', `Synced ${pteroLocations.length} locations and ${pteroNodes.length} nodes from Pterodactyl`);
        res.redirect('/admin/locations');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to sync locations: ' + err.message);
        res.redirect('/admin/locations');
    }
});

router.post('/locations/update', async (req, res) => {
    const { id, multiplier } = req.body;
    try {
        const conn = await db.getConnection();

        let ids = [];
        if (Array.isArray(id)) ids = id;
        else if (id) ids = [id];

        let multipliers = [];
        if (Array.isArray(multiplier)) multipliers = multiplier;
        else if (multiplier) multipliers = [multiplier];

        for (let i = 0; i < ids.length; i++) {
            const locId = ids[i];
            const mult = multipliers[i];
            const isPublic = req.body[`public_${locId}`] ? 1 : 0;
            const isSoldOut = req.body[`soldout_${locId}`] ? 1 : 0;
            const region = req.body[`region_${locId}`] || 'Other';
            const processorName = req.body[`processor_${locId}`] || null;

            await conn.query("UPDATE locations SET multiplier = ?, is_public = ?, is_sold_out = ?, region = ?, processor_name = ? WHERE id = ?",
                [mult, isPublic, isSoldOut, region, processorName, locId]);
        }

        conn.release();
        req.flash('success_msg', 'Locations updated');
        res.redirect('/admin/locations');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error updating locations');
        res.redirect('/admin/locations');
    }
});



// Jobs Management
router.get('/jobs', async (req, res) => {
    const jobs = [
        {
            id: 'generate_invoices',
            name: 'Generate Invoices',
            description: 'Generates invoices for servers expiring in 5 days',
            schedule: 'Daily at 00:00',
            script: 'tasks/generate_invoices.js'
        },
        {
            id: 'cleanup_suspended',
            name: 'Cleanup Suspended Servers',
            description: 'Deletes servers suspended for > 7 days',
            schedule: 'Daily at 00:00',
            script: 'tasks/cleanup_suspended.js'
        },
        {
            id: 'suspend_overdue',
            name: 'Suspend Overdue Servers',
            description: 'Suspends active servers that are past their renewal date',
            schedule: 'Daily at 00:05',
            script: 'tasks/suspend_overdue.js'
        }
    ];

    res.render('admin/jobs', { jobs });
});

router.post('/jobs/run', async (req, res) => {
    const { job_id } = req.body;

    // Map job IDs to require paths
    const jobMap = {
        'generate_invoices': require('../tasks/generate_invoices'),
        'cleanup_suspended': require('../tasks/cleanup_suspended'),
        'suspend_overdue': require('../tasks/suspend_overdue')
    };

    const taskFunction = jobMap[job_id];

    if (!taskFunction) {
        req.flash('error_msg', 'Invalid job ID');
        return res.redirect('/admin/jobs');
    }

    try {
        // Run asynchronously without waiting
        taskFunction()
            .then(() => console.log(`[Manual Job] ${job_id} completed successfully.`))
            .catch(err => console.error(`[Manual Job] ${job_id} failed:`, err));

        req.flash('success_msg', `Job "${job_id}" has been started in the background.`);
        res.redirect('/admin/jobs');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to start job');
        res.redirect('/admin/jobs');
    }
});

// Settings Page

router.get('/settings', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT * FROM settings");
        conn.release();

        const settingsMap = {};
        settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);

        // Fallback for UI visibility
        if (!settingsMap.site_url) settingsMap.site_url = process.env.SITE_URL || '';

        // Check if radar feature exists
        const fs = require('fs');
        const path = require('path');
        const radarEnabled = fs.existsSync(path.join(__dirname, '../views/admin/radar.ejs'));

        res.render('admin/settings', { settings: settingsMap, radarEnabled });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});


// Update Settings
router.post('/settings', async (req, res) => {
    const { alert_message, alert_type, ptero_url, ptero_key, ptero_client_api_key, site_name, site_logo, site_url } = req.body;

    try {
        const conn = await db.getConnection();

        // Branding Settings
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('site_name', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [site_name || 'Afernactyl', site_name || 'Afernactyl']);
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('site_logo', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [site_logo || '', site_logo || '']);
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('site_url', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [site_url || '', site_url || '']);

        // Maintenance Mode
        const maintenance = req.body.maintenance ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('maintenance', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [maintenance, maintenance]);

        // Debug Mode
        const debugMode = req.body.debug_mode ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('debug_mode', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [debugMode, debugMode]);

        // Affiliate Settings
        const affiliateEnabled = req.body.affiliate_enabled ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('affiliate_enabled', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [affiliateEnabled, affiliateEnabled]);

        const affiliateCommission = req.body.affiliate_default_commission || '10';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('affiliate_default_commission', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [affiliateCommission, affiliateCommission]);

        const affiliateMinPayout = req.body.affiliate_min_payout || '10';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('affiliate_min_payout', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [affiliateMinPayout, affiliateMinPayout]);

        // Email Verification
        const enableEmailVerification = req.body.enable_email_verification ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('enable_email_verification', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [enableEmailVerification, enableEmailVerification]);


        // Global Alert
        if (req.body.clear_alert) {
            await conn.query("DELETE FROM settings WHERE setting_key = 'global_alert'");
        } else {
            const alertVal = alert_message ? JSON.stringify({ message: alert_message, type: alert_type }) : null;
            if (alertVal) {
                await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('global_alert', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [alertVal, alertVal]);
            }
        }

        // Ptero Config
        if (ptero_url) await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('ptero_url', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [ptero_url, ptero_url]);
        if (ptero_key) await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('ptero_key', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [ptero_key, ptero_key]);
        if (ptero_client_api_key) await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('ptero_client_api_key', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [ptero_client_api_key, ptero_client_api_key]);

        // Discord Webhook
        const discordWebhook = req.body.discord_webhook_url || '';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('discord_webhook_url', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [discordWebhook, discordWebhook]);

        // OAuth Settings
        const saveOAuth = async (key, val) => {
            await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?", [key, val || '', val || '']);
        };

        await saveOAuth('oauth_github_enabled', req.body.oauth_github_enabled ? 'true' : 'false');
        await saveOAuth('oauth_github_client_id', req.body.oauth_github_client_id);
        await saveOAuth('oauth_github_client_secret', req.body.oauth_github_client_secret);

        await saveOAuth('oauth_discord_enabled', req.body.oauth_discord_enabled ? 'true' : 'false');
        await saveOAuth('oauth_discord_client_id', req.body.oauth_discord_client_id);
        await saveOAuth('oauth_discord_client_secret', req.body.oauth_discord_client_secret);

        await saveOAuth('oauth_google_enabled', req.body.oauth_google_enabled ? 'true' : 'false');
        await saveOAuth('oauth_google_client_id', req.body.oauth_google_client_id);
        await saveOAuth('oauth_google_client_secret', req.body.oauth_google_client_secret);

        await saveOAuth('oauth_apple_enabled', req.body.oauth_apple_enabled ? 'true' : 'false');
        await saveOAuth('oauth_apple_client_id', req.body.oauth_apple_client_id);
        await saveOAuth('oauth_apple_client_secret', req.body.oauth_apple_client_secret);

        await authService.loadStrategies();

        conn.release();
        req.flash('success_msg', 'Settings updated.');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error updating settings');
        res.redirect('/admin/settings');
    }
});

// Test Discord Webhook
router.post('/test-discord-webhook', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const rows = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'discord_webhook_url'");
        conn.release();

        const webhookUrl = rows.length > 0 ? rows[0].setting_value : null;

        if (!webhookUrl) {
            return res.json({ success: false, error: 'No webhook URL configured. Please save settings first.' });
        }

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'Afernactyl',
                avatar_url: 'https://www.iconarchive.com/download/i112250/fa-team/fontawesome/FontAwesome-Dragon.ico',
                embeds: [{
                    title: '✅ Webhook Test Successful!',
                    description: 'Your Discord webhook is working correctly.',
                    color: 0x10b981,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'Afernactyl Dashboard' }
                }]
            })
        });

        if (response.ok) {
            res.json({ success: true, message: 'Test notification sent!' });
        } else {
            const text = await response.text();
            res.json({ success: false, error: `Discord returned ${response.status}: ${text}` });
        }
    } catch (err) {
        console.error('[Discord Test]', err);
        res.json({ success: false, error: err.message });
    }
});

// Email Broadcast Page
router.get('/broadcast', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const userCountResult = await conn.query("SELECT COUNT(*) as count FROM users");
        const logs = await conn.query("SELECT * FROM broadcast_logs ORDER BY created_at DESC LIMIT 20");
        conn.release();
        res.render('admin/broadcast', { userCount: userCountResult[0].count, logs });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Send Email Broadcast
router.post('/broadcast', async (req, res) => {
    const { subject, recipient_type, email_type, content, send_test } = req.body;
    let conn;

    try {
        conn = await db.getConnection();
        const emailService = require('../services/email');
        const ejs = require('ejs');
        const path = require('path');

        // Get site settings
        const settings = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('site_name', 'site_url')");
        const settingsMap = {};
        settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
        const siteName = settingsMap.site_name || 'Afernactyl';
        const siteUrl = settingsMap.site_url || process.env.SITE_URL || 'http://localhost:3000';

        // Render email template
        const templatePath = path.join(__dirname, '../views/emails/broadcast.ejs');
        const emailHtml = await ejs.renderFile(templatePath, {
            subject,
            content,
            emailType: email_type,
            siteName,
            siteUrl
        });

        // Test email mode - checkbox sends "on" when checked, undefined when not
        console.log('[Broadcast] send_test value:', send_test, typeof send_test);
        if (send_test === 'on' || send_test === true) {
            await emailService.sendEmail(req.session.user.email, subject, null, null, emailHtml);
            req.flash('success_msg', `Test email sent to ${req.session.user.email}`);
            return res.redirect('/admin/broadcast');
        }

        // Get recipients based on type
        let recipientQuery;
        if (recipient_type === 'all') {
            // Include all users (verified or not, but not suspended)
            recipientQuery = "SELECT email, username FROM users WHERE is_suspended = 0 OR is_suspended IS NULL";
        } else if (recipient_type === 'active') {
            recipientQuery = "SELECT DISTINCT u.email, u.username FROM users u JOIN active_servers s ON u.id = s.user_id WHERE s.status = 'active'";
        } else if (recipient_type === 'admins') {
            recipientQuery = "SELECT email, username FROM users WHERE is_admin = 1";
        }

        const recipients = await conn.query(recipientQuery);
        console.log(`[Broadcast] Found ${recipients.length} recipients for type: ${recipient_type}`);
        console.log(`[Broadcast] Recipients:`, recipients.map(r => r.email));

        // Send emails (with small delay to avoid rate limiting)
        let sent = 0;
        let failed = 0;

        for (const recipient of recipients) {
            try {
                console.log(`[Broadcast] Sending to ${recipient.email}...`);
                await emailService.sendEmail(recipient.email, subject, null, null, emailHtml);
                sent++;
                console.log(`[Broadcast] Successfully sent to ${recipient.email}`);
            } catch (err) {
                console.error(`[Broadcast] Failed to send to ${recipient.email}:`, err.message);
                failed++;
            }
            // Small delay between emails
            await new Promise(r => setTimeout(r, 100));
        }

        // Log to database
        await conn.query(
            `INSERT INTO broadcast_logs (admin_id, admin_username, subject, email_type, recipient_type, recipients_count, sent_count, failed_count) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.username, subject, email_type, recipient_type, recipients.length, sent, failed]
        );

        // Discord notification
        try {
            const discord = require('../services/discord');
            await discord.broadcastSent(
                { username: req.session.user.username },
                subject,
                recipient_type,
                sent,
                failed
            );
        } catch (e) { console.error('[Discord Broadcast]', e.message); }

        console.log(`[Broadcast] Sent by ${req.session.user.username}: ${sent} delivered, ${failed} failed`);
        req.flash('success_msg', `Broadcast sent! ${sent} emails delivered, ${failed} failed.`);
        res.redirect('/admin/broadcast');

    } catch (err) {
        console.error('[Broadcast Error]', err);
        req.flash('error_msg', 'Error sending broadcast: ' + err.message);
        res.redirect('/admin/broadcast');
    } finally {
        if (conn) conn.release();
    }
});

// Debug Logs Page
router.get('/debug', (req, res) => {
    try {
        // Combine Pterodactyl logs with centralized debug logs (Payment Gateways, etc)
        const pteroLogs = pteroService.getLogs().map(log => ({
            ...log,
            source: 'PTERO'
        }));
        const pgLogs = debugLogger.getLogs();

        // Combine and sort by timestamp (newest first)
        const allLogs = [...pteroLogs, ...pgLogs].sort((a, b) => b.timestamp - a.timestamp);

        res.render('admin/debug', { logs: allLogs });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Tickets Management
router.get('/tickets', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const tickets = await conn.query(`
            SELECT t.*, u.username, u.email 
            FROM tickets t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC
        `);
        conn.release();
        res.render('admin/tickets', { tickets });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// SMTP Settings
router.get('/smtp', async (req, res) => {
    try {
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT * FROM settings WHERE setting_key LIKE 'smtp_%' OR setting_key = 'enable_email_verification'");
        conn.release();

        const settingsMap = {};
        settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);

        res.render('admin/smtp', { settings: settingsMap });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

router.post('/smtp', async (req, res) => {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, enable_email_verification } = req.body;
    try {
        const conn = await db.getConnection();

        const updates = {
            'smtp_host': smtp_host,
            'smtp_port': smtp_port,
            'smtp_user': smtp_user,
            'smtp_pass': smtp_pass,
            'smtp_secure': smtp_secure,
            'smtp_from': smtp_from,
            'enable_email_verification': enable_email_verification ? 'true' : 'false'
        };

        for (const [key, value] of Object.entries(updates)) {
            await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?", [key, value, value]);
        }

        conn.release();
        req.flash('success_msg', 'SMTP Settings updated successfully.');
        res.redirect('/admin/smtp');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update SMTP settings.');
        res.redirect('/admin/smtp');
    }
});

router.post('/smtp/test', async (req, res) => {
    try {
        const user = req.session.user;
        if (!user || !user.email) {
            return res.status(400).json({ message: 'User email not found in session' });
        }

        const emailService = require('../services/email');
        await emailService.sendEmail(user.email, 'SMTP Test - Afernactyl', 'test-email', {
            user: user,
            date: new Date().toLocaleString()
        });

        res.json({ message: `Test email sent to ${user.email}` });
    } catch (err) {
        console.error("Test Email Error:", err);
        res.status(500).json({ message: err.message });
    }
});

// Admin: All Servers
router.get('/servers', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const servers = await conn.query(`
            SELECT active_servers.*, Plans.name as plan_name, users.username
            FROM active_servers 
            LEFT JOIN Plans ON active_servers.plan_id = Plans.id
            LEFT JOIN users ON active_servers.user_id = users.id
            ORDER BY active_servers.id DESC
        `);
        const settings = await conn.query("SELECT setting_value FROM settings WHERE setting_key = 'ptero_url'");
        const panelUrl = settings.length > 0 ? settings[0].setting_value : '';
        res.render('admin/servers', { servers, panelUrl });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

router.get('/servers/edit/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const server = await conn.query("SELECT * FROM active_servers WHERE id = ?", [req.params.id]);
        if (server.length === 0) return res.redirect('/admin/servers');

        const plans = await conn.query("SELECT * FROM Plans");
        res.render('admin/server_edit', { server: server[0], plans });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

router.post('/servers/edit/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { user_id, plan_id, status, renewal_date } = req.body;

        await conn.query(
            "UPDATE active_servers SET user_id = ?, plan_id = ?, status = ?, renewal_date = ? WHERE id = ?",
            [user_id, plan_id, status, renewal_date || null, req.params.id]
        );

        req.flash('success_msg', 'Server updated successfully.');
        res.redirect('/admin/servers');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update server.');
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Cancel Server Subscription
router.post('/servers/cancel/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Get server info first
        const server = await conn.query("SELECT * FROM active_servers WHERE id = ?", [req.params.id]);

        if (server.length === 0) {
            req.flash('error_msg', 'Server not found.');
            return res.redirect('/admin/servers');
        }

        await conn.query("UPDATE active_servers SET status = 'cancelled' WHERE id = ?", [req.params.id]);

        // Send cancellation email to user
        try {
            const userRows = await conn.query("SELECT email, username FROM users WHERE id = ?", [server[0].user_id]);
            if (userRows.length > 0) {
                const emailService = require('../services/email');
                await emailService.sendServerCancelledEmail(
                    { email: userRows[0].email, username: userRows[0].username },
                    { server_name: server[0].server_name },
                    req.body.reason || 'Subscription cancelled by administrator'
                );
                console.log('[CANCEL SERVER] Cancellation email sent to:', userRows[0].email);
            }
        } catch (emailErr) {
            console.error('[CANCEL SERVER] Failed to send cancellation email:', emailErr.message);
        }

        req.flash('success_msg', 'Subscription cancelled.');
        res.redirect('/admin/servers');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to cancel subscription.');
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Delete Server (from Pterodactyl + DB)
router.post('/servers/delete/:id', async (req, res) => {
    console.log('[DELETE SERVER] Request received for ID:', req.params.id, 'Force:', req.query.force);
    let conn;
    try {
        conn = await db.getConnection();
        const server = await conn.query("SELECT * FROM active_servers WHERE id = ?", [req.params.id]);
        console.log('[DELETE SERVER] Server found:', server.length > 0 ? server[0].server_name : 'NOT FOUND');

        if (server.length === 0) {
            req.flash('error_msg', 'Server not found.');
            return res.redirect('/admin/servers');
        }

        // Allow force delete via query param ?force=true
        const forceDelete = req.query.force === 'true';

        // Delete from Pterodactyl
        const pteroService = require('../services/pterodactyl');
        try {
            await pteroService.deleteServer(server[0].ptero_server_id);
        } catch (pteroErr) {
            console.error('Pterodactyl delete error:', pteroErr.message);

            if (!forceDelete) {
                // If not forcing, we stop here and warn the user
                req.flash('error_msg', `Failed to delete from Pterodactyl: ${pteroErr.message}. The server still exists on the panel. Try again or use Force Delete.`);
                return res.redirect('/admin/servers');
            }
        }

        // Delete from local DB
        await conn.query("DELETE FROM active_servers WHERE id = ?", [req.params.id]);

        // Send cancellation email to user
        try {
            const userRows = await conn.query("SELECT email, username FROM users WHERE id = ?", [server[0].user_id]);
            if (userRows.length > 0) {
                const emailService = require('../services/email');
                await emailService.sendServerCancelledEmail(
                    { email: userRows[0].email, username: userRows[0].username },
                    { server_name: server[0].server_name },
                    req.body.reason || 'Deleted by administrator'
                );
                console.log('[DELETE SERVER] Cancellation email sent to:', userRows[0].email);
            }
        } catch (emailErr) {
            console.error('[DELETE SERVER] Failed to send cancellation email:', emailErr.message);
        }

        req.flash('success_msg', 'Server deleted successfully.');
        res.redirect('/admin/servers');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to delete server.');
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Suspend Server
router.post('/servers/suspend/:id', async (req, res) => {
    let conn;
    try {
        const serverId = req.params.id;
        conn = await db.getConnection();

        const server = await conn.query("SELECT * FROM active_servers WHERE id = ?", [serverId]);
        if (server.length === 0) {
            req.flash('error_msg', 'Server not found');
            return res.redirect('/admin/servers');
        }

        // Suspend in Pterodactyl
        if (server[0].ptero_server_id) {
            try {
                const pteroService = require('../services/pterodactyl');
                await pteroService.suspendServer(server[0].ptero_server_id);
            } catch (err) {
                console.error('Error suspending server in Pterodactyl:', err);
                req.flash('error_msg', 'Failed to suspend server in panel: ' + err.message);
                return res.redirect('/admin/servers');
            }
        }

        // Update status in database
        await conn.query("UPDATE active_servers SET status = 'suspended' WHERE id = ?", [serverId]);

        req.flash('success_msg', 'Server suspended successfully');
        res.redirect('/admin/servers');
    } catch (err) {
        console.error('Suspend server error:', err);
        req.flash('error_msg', 'Error suspending server: ' + err.message);
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Unsuspend Server
router.post('/servers/unsuspend/:id', async (req, res) => {
    let conn;
    try {
        const serverId = req.params.id;
        conn = await db.getConnection();

        const server = await conn.query("SELECT * FROM active_servers WHERE id = ?", [serverId]);
        if (server.length === 0) {
            req.flash('error_msg', 'Server not found');
            return res.redirect('/admin/servers');
        }

        // Unsuspend in Pterodactyl
        if (server[0].ptero_server_id) {
            try {
                const pteroService = require('../services/pterodactyl');
                await pteroService.unsuspendServer(server[0].ptero_server_id);
            } catch (err) {
                console.error('Error unsuspending server in Pterodactyl:', err);
                req.flash('error_msg', 'Failed to unsuspend server in panel: ' + err.message);
                return res.redirect('/admin/servers');
            }
        }

        // Update status in database
        await conn.query("UPDATE active_servers SET status = 'active' WHERE id = ?", [serverId]);

        req.flash('success_msg', 'Server unsuspended successfully');
        res.redirect('/admin/servers');
    } catch (err) {
        console.error('Unsuspend server error:', err);
        req.flash('error_msg', 'Error unsuspending server: ' + err.message);
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Sync Server Names
router.post('/servers/sync', async (req, res) => {
    let conn;
    try {
        const pteroService = require('../services/pterodactyl');
        const pteroServers = await pteroService.getAllServers();

        conn = await db.getConnection();
        const localServers = await conn.query("SELECT id, ptero_server_id, server_name FROM active_servers");

        let updateCount = 0;

        for (const local of localServers) {
            const remote = pteroServers.find(p => p.id === local.ptero_server_id);
            if (remote && remote.name !== local.server_name) {
                await conn.query("UPDATE active_servers SET server_name = ? WHERE id = ?", [remote.name, local.id]);
                updateCount++;
            }
        }

        req.flash('success_msg', `Synced ${updateCount} server names from Pterodactyl.`);
        res.redirect('/admin/servers');
    } catch (err) {
        console.error("Sync Error:", err);
        req.flash('error_msg', 'Failed to sync servers: ' + err.message);
        res.redirect('/admin/servers');
    } finally {
        if (conn) conn.release();
    }
});

// Theme Management
router.get('/theme', async (req, res) => {
    try {
        // Fetch current theme settings
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'theme_%'");
        conn.release();

        const adminTheme = {};
        settings.forEach(s => {
            adminTheme[s.setting_key] = s.setting_value;
        });

        res.render('admin/theme', { adminTheme });
    } catch (err) {
        console.error("Theme Page Error:", err);
        res.redirect('/admin');
    }
});

router.post('/theme', async (req, res) => {
    try {
        const conn = await db.getConnection();

        // Helper to upsert theme setting
        const saveSetting = async (key, value) => {
            await conn.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [key, value, value]
            );
        };

        const keys = [
            'theme_color_primary',
            'theme_color_bg_base',
            'theme_color_bg_surface',
            'theme_color_bg_elevated',
            'theme_text_primary',
            'theme_text_secondary',
            // Extended Day/Night Keys
            'theme_glass_bg',
            'theme_glass_border',
            'theme_border_subtle',
            'theme_border_default',
            // Extended Shadow Keys
            'theme_shadow_sm',
            'theme_shadow_card',
            'theme_shadow_glow'
        ];

        for (const key of keys) {
            if (req.body[key]) {
                await saveSetting(key, req.body[key]);
            }
        }

        conn.release();
        req.flash('success_msg', 'Theme updated successfully');
        res.redirect('/admin/theme');
    } catch (err) {
        console.error("Theme Update Error:", err);
        req.flash('error_msg', 'Failed to update theme');
        res.redirect('/admin/theme');
    }
});

router.post('/theme/reset', async (req, res) => {
    try {
        const conn = await db.getConnection();
        // Delete all custom theme settings to revert to CSS defaults
        await conn.query("DELETE FROM settings WHERE setting_key LIKE 'theme_%'");
        conn.release();

        req.flash('success_msg', 'Theme reset to default (Dark Blue)');
        res.redirect('/admin/theme');
    } catch (err) {
        console.error("Theme Reset Error:", err);
        req.flash('error_msg', 'Failed to reset theme');
        res.redirect('/admin/theme');
    }
});

// Admin: All Invoices
router.get('/invoices', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const offset = (page - 1) * limit;

        // Get total count
        const countResult = await conn.query('SELECT COUNT(*) as total FROM invoices');
        const totalItems = Number(countResult[0].total);
        const totalPages = Math.ceil(totalItems / limit);

        const invoices = await conn.query(`
            SELECT invoices.*, Plans.name as plan_name, users.username
            FROM invoices 
            LEFT JOIN Plans ON invoices.plan_id = Plans.id
            LEFT JOIN users ON invoices.user_id = users.id
            ORDER BY invoices.created_at DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        const users = await conn.query("SELECT id, username, email FROM users ORDER BY username ASC");
        const servers = await conn.query(`
            SELECT active_servers.id, active_servers.server_name, active_servers.user_id, users.username 
            FROM active_servers 
            LEFT JOIN users ON active_servers.user_id = users.id
            ORDER BY active_servers.server_name ASC
        `);

        res.render('admin/invoices', {
            invoices,
            users,
            servers,
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
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Create Custom Invoice
router.post('/invoices/create', async (req, res) => {
    const { user_id, amount, description, currency_code, due_date, no_due_date, server_id } = req.body;
    let conn;
    try {
        conn = await db.getConnection();

        // Check if user exists
        const user = await conn.query("SELECT * FROM users WHERE id = ?", [user_id]);
        if (user.length === 0) {
            req.flash('error_msg', 'User not found');
            return res.redirect('/admin/invoices');
        }

        // Determine due date
        const invoiceDueDate = no_due_date ? null : (due_date || null);

        // Calculate USD amount from currency amount
        let amountUSD = parseFloat(amount);
        const currencyAmountLocal = parseFloat(amount);
        const selectedCurrency = currency_code || 'USD';

        if (selectedCurrency !== 'USD') {
            // Get currency rate and convert to USD
            const currencyData = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = ?", [selectedCurrency]);
            if (currencyData.length > 0 && currencyData[0].rate_to_usd) {
                // rate_to_usd is how many local units = 1 USD, so divide to get USD
                amountUSD = currencyAmountLocal / parseFloat(currencyData[0].rate_to_usd);
            }
        }

        // Resolve server_id (can link invoice to a server for renewal)
        const linkedServerId = server_id && server_id !== '' ? parseInt(server_id) : null;

        // Insert new invoice (amount = USD, currency_amount = local currency)
        await conn.query(`INSERT INTO invoices 
            (user_id, server_id, amount, currency_code, currency_amount, status, type, description, subtotal, tax_rate, tax_amount, billing_address, gst_number, due_date) 
            VALUES (?, ?, ?, ?, ?, 'pending', 'custom', ?, ?, 0, 0, '', '', ?)`,
            [user_id, linkedServerId, amountUSD.toFixed(2), selectedCurrency, currencyAmountLocal, description, currencyAmountLocal, invoiceDueDate]
        );

        const invoiceResult = await conn.query("SELECT LAST_INSERT_ID() as id");
        const invoiceId = invoiceResult[0].id;

        // Send email notification
        try {
            const emailService = require('../services/email');
            await emailService.sendInvoiceCreatedEmail(user[0], {
                id: invoiceId,
                amount: amount,
                currency_code: currency_code || 'USD',
                description: description,
                due_date: invoiceDueDate
            });
        } catch (emailErr) {
            console.error('Failed to send invoice email:', emailErr.message);
        }

        req.flash('success_msg', 'Custom invoice created successfully.');
        res.redirect('/admin/invoices');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to create invoice: ' + err.message);
        res.redirect('/admin/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: View Single Invoice
router.get('/invoices/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const invoice = await conn.query(`
            SELECT invoices.*, Plans.name as plan_name, users.username, users.email
            FROM invoices 
            LEFT JOIN Plans ON invoices.plan_id = Plans.id
            LEFT JOIN users ON invoices.user_id = users.id
            WHERE invoices.id = ?
        `, [req.params.id]);

        if (invoice.length === 0) {
            return res.redirect('/admin/invoices');
        }

        // Get company settings
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name', 'company_address', 'company_gst', 'tax_name')");
        const company = {};
        settingsRows.forEach(row => {
            company[row.setting_key.replace('company_', '')] = row.setting_value;
        });
        company.tax_name = settingsRows.find(r => r.setting_key === 'tax_name')?.setting_value || 'Tax';

        res.render('dashboard/invoice_view', { invoice: invoice[0], company });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Update Invoice Status
router.post('/invoices/:id/status', async (req, res) => {
    let conn;
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'paid', 'cancelled', 'refunded'];

        if (!validStatuses.includes(status)) {
            req.flash('error_msg', 'Invalid status');
            return res.redirect('/admin/invoices');
        }

        conn = await db.getConnection();

        // Get the invoice first to check for server_id and payment method
        const invoiceRows = await conn.query("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
        if (invoiceRows.length === 0) {
            req.flash('error_msg', 'Invoice not found');
            return res.redirect('/admin/invoices');
        }
        const invoice = invoiceRows[0];

        // Handle marking as PAID
        if (status === 'paid') {
            // When admin marks as paid, set payment_method = 'admin'
            await conn.query("UPDATE invoices SET status = ?, paid_at = NOW(), payment_method = 'admin' WHERE id = ?", [status, req.params.id]);

            // Handle Server Renewal / Unsuspension if this invoice has a server_id
            if (invoice.server_id) {
                console.log(`[Admin Payment] Processing renewal for server #${invoice.server_id}`);
                const serverRow = await conn.query("SELECT s.*, p.billing_period FROM active_servers s LEFT JOIN Plans p ON s.plan_id = p.id WHERE s.id = ?", [invoice.server_id]);
                if (serverRow.length > 0) {
                    const billingInterval = getBillingInterval(serverRow[0].billing_period);
                    await conn.query(`UPDATE active_servers SET status = 'active', renewal_date = DATE_ADD(renewal_date, INTERVAL ${billingInterval}) WHERE id = ?`, [invoice.server_id]);
                    console.log(`[Admin Payment] Updated renewal_date for server #${invoice.server_id} (${serverRow[0].billing_period || 'monthly'})`);

                    if (serverRow[0].ptero_server_id) {
                        try {
                            await pteroService.unsuspendServer(serverRow[0].ptero_server_id);
                            console.log(`[Admin Payment] Unsuspended Ptero server ${serverRow[0].ptero_server_id}`);
                        } catch (pteroErr) {
                            console.error(`[Admin Payment] Failed to unsuspend Ptero server:`, pteroErr.message);
                        }
                    }
                }
            }
        }
        // Handle marking as REFUNDED
        else if (status === 'refunded') {
            // Only process refund if invoice was previously paid
            if (invoice.status !== 'paid') {
                req.flash('error_msg', 'Cannot refund an invoice that is not paid');
                return res.redirect('/admin/invoices');
            }

            let refundMessage = '';

            // Handle credits refund - return money to user balance
            if (invoice.payment_method === 'credits') {
                const amountToRefund = parseFloat(invoice.amount); // USD amount
                await conn.query("UPDATE users SET balance = balance + ? WHERE id = ?", [amountToRefund, invoice.user_id]);
                refundMessage = `Refunded $${amountToRefund.toFixed(2)} to user's balance.`;
                console.log(`[Admin Refund] Credits refund: $${amountToRefund} to user #${invoice.user_id}`);
                debugLogger.system('REFUND', `Credits refund: $${amountToRefund.toFixed(2)} to user #${invoice.user_id}`, { invoiceId: invoice.id });
            }
            // Handle PhonePe refund via API
            else if (invoice.payment_method === 'phonepe') {
                if (!invoice.transaction_id) {
                    debugLogger.phonepe('ERROR', 'Refund failed - No transaction_id stored', { invoiceId: invoice.id });
                    req.flash('error_msg', 'Cannot refund: No transaction ID stored for this invoice');
                    return res.redirect('/admin/invoices');
                }

                try {
                    debugLogger.phonepe('REQUEST', 'Initiating PhonePe refund', {
                        invoiceId: invoice.id,
                        transactionId: invoice.transaction_id,
                        amount: invoice.currency_amount
                    });

                    const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'phonepe'");
                    if (gateway.length > 0) {
                        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');
                        const { StandardCheckoutClient, Env, RefundRequest } = require('pg-sdk-node');

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

                        // Convert USD amount to INR paise for refund (same as payment)
                        // invoice.amount is in USD, need to convert to INR
                        const amountUSD = parseFloat(invoice.amount);

                        // Get INR exchange rate
                        const inrCurrency = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = 'INR'");
                        const inrRate = inrCurrency.length > 0 ? parseFloat(inrCurrency[0].rate_to_usd) : 83.0;

                        // Convert: USD → INR → paise
                        const amountINR = amountUSD * inrRate;
                        const refundAmountPaise = Math.round(amountINR * 100);

                        console.log(`[Admin Refund] USD ${amountUSD.toFixed(2)} → INR ${amountINR.toFixed(2)} → ${refundAmountPaise} paise`);

                        const refundRequest = RefundRequest.builder()
                            .merchantRefundId('REF_' + invoice.id + '_' + Date.now())
                            .originalMerchantOrderId(invoice.transaction_id)
                            .amount(refundAmountPaise)
                            .build();

                        const refundResponse = await client.refund(refundRequest);
                        console.log(`[Admin Refund] PhonePe refund response:`, JSON.stringify(refundResponse, null, 2));
                        debugLogger.phonepe('RESPONSE', 'PhonePe refund response', refundResponse);

                        // Handle the response state
                        const refundState = refundResponse.state || 'UNKNOWN';
                        const refundId = refundResponse.refundId || 'N/A';
                        const refundAmt = refundResponse.amount ? (refundResponse.amount / 100).toFixed(2) : invoice.currency_amount;

                        if (refundState === 'PENDING') {
                            refundMessage = `PhonePe refund initiated (PENDING). Refund ID: ${refundId}, Amount: ₹${refundAmt}. Refund will be processed within 5-7 business days.`;
                        } else if (refundState === 'SUCCESS') {
                            refundMessage = `PhonePe refund successful! Refund ID: ${refundId}, Amount: ₹${refundAmt}`;
                        } else {
                            refundMessage = `PhonePe refund status: ${refundState}. Refund ID: ${refundId}`;
                        }
                    } else {
                        debugLogger.phonepe('ERROR', 'PhonePe gateway not found in database');
                        throw new Error('PhonePe gateway configuration not found');
                    }
                } catch (refundErr) {
                    console.error(`[Admin Refund] PhonePe refund error:`, refundErr.message);
                    debugLogger.phonepe('ERROR', 'PhonePe refund failed', { error: refundErr.message, stack: refundErr.stack });
                    req.flash('error_msg', 'PhonePe refund failed: ' + refundErr.message);
                    return res.redirect('/admin/invoices');
                }
            }
            // Handle Stripe refund via API
            else if (invoice.payment_method === 'stripe') {
                if (!invoice.transaction_id) {
                    debugLogger.stripe('ERROR', 'Refund failed - No transaction_id stored', { invoiceId: invoice.id });
                    req.flash('error_msg', 'Cannot refund: No transaction ID stored for this invoice');
                    return res.redirect('/admin/invoices');
                }

                try {
                    debugLogger.stripe('REQUEST', 'Initiating Stripe refund', {
                        invoiceId: invoice.id,
                        transactionId: invoice.transaction_id,
                        amount: invoice.currency_amount
                    });

                    const gateway = await conn.query("SELECT * FROM payment_gateways WHERE name = 'stripe'");
                    if (gateway.length > 0) {
                        const config = typeof gateway[0].config === 'object' ? gateway[0].config : JSON.parse(gateway[0].config || '{}');

                        if (!config.secretKey) {
                            throw new Error('Stripe secret key not configured');
                        }

                        const stripe = require('stripe')(config.secretKey);

                        // The transaction_id stores the payment_intent ID from Stripe
                        const paymentIntentId = invoice.transaction_id;

                        // Create refund using payment_intent
                        const refund = await stripe.refunds.create({
                            payment_intent: paymentIntentId,
                            reason: 'requested_by_customer'
                        });

                        console.log(`[Admin Refund] Stripe refund response:`, JSON.stringify(refund, null, 2));
                        debugLogger.stripe('RESPONSE', 'Stripe refund response', refund);

                        // Handle the response
                        const refundStatus = refund.status;
                        const refundAmount = (refund.amount / 100).toFixed(2);
                        const refundCurrency = refund.currency.toUpperCase();

                        if (refundStatus === 'succeeded') {
                            refundMessage = `Stripe refund successful! Refund ID: ${refund.id}, Amount: ${refundAmount} ${refundCurrency}`;
                        } else if (refundStatus === 'pending') {
                            refundMessage = `Stripe refund initiated (PENDING). Refund ID: ${refund.id}, Amount: ${refundAmount} ${refundCurrency}. Refund will be processed within 5-10 business days.`;
                        } else {
                            refundMessage = `Stripe refund status: ${refundStatus}. Refund ID: ${refund.id}`;
                        }
                    } else {
                        debugLogger.stripe('ERROR', 'Stripe gateway not found in database');
                        throw new Error('Stripe gateway configuration not found');
                    }
                } catch (refundErr) {
                    console.error(`[Admin Refund] Stripe refund error:`, refundErr.message);
                    debugLogger.stripe('ERROR', 'Stripe refund failed', { error: refundErr.message, stack: refundErr.stack });
                    req.flash('error_msg', 'Stripe refund failed: ' + refundErr.message);
                    return res.redirect('/admin/invoices');
                }
            }
            // Admin payment or unknown
            else if (invoice.payment_method === 'admin') {
                refundMessage = 'Admin-marked payment - no automatic refund processed.';
            }

            await conn.query("UPDATE invoices SET status = 'refunded' WHERE id = ?", [req.params.id]);

            if (refundMessage) {
                req.flash('success_msg', `Invoice #${req.params.id} marked as refunded. ${refundMessage}`);
            } else {
                req.flash('success_msg', `Invoice #${req.params.id} marked as refunded.`);
            }
            conn.release();
            return res.redirect('/admin/invoices');
        }
        // Handle other statuses (pending, cancelled)
        else {
            await conn.query("UPDATE invoices SET status = ?, paid_at = NULL WHERE id = ?", [status, req.params.id]);
        }

        req.flash('success_msg', `Invoice #${req.params.id} status updated to ${status}`);
        res.redirect('/admin/invoices');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update invoice status');
        res.redirect('/admin/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Delete Invoice
router.post('/invoices/:id/delete', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        await conn.query("DELETE FROM invoices WHERE id = ?", [req.params.id]);

        req.flash('success_msg', `Invoice #${req.params.id} deleted successfully`);
        res.redirect('/admin/invoices');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to delete invoice');
        res.redirect('/admin/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Clear All Invoices
router.post('/invoices/clear-all', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        const result = await conn.query("DELETE FROM invoices");
        const deletedCount = result.affectedRows || 0;

        console.log(`[Admin] All invoices cleared by admin: ${req.session.user.username}, count: ${deletedCount}`);
        req.flash('success_msg', `Successfully deleted ${deletedCount} invoice(s)`);
        res.redirect('/admin/invoices');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to clear invoices');
        res.redirect('/admin/invoices');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Tax & Company Settings
router.get('/taxes', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settingsRows = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_name', 'company_address', 'company_gst', 'tax_rate', 'tax_name')");

        const settings = {};
        settingsRows.forEach(row => {
            settings[row.setting_key] = row.setting_value;
        });

        res.render('admin/taxes', { settings });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

router.post('/taxes', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { company_name, company_address, company_gst, tax_rate, tax_name } = req.body;

        await conn.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'company_name'", [company_name || '']);
        await conn.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'company_address'", [company_address || '']);
        await conn.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'company_gst'", [company_gst || '']);
        await conn.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'tax_rate'", [tax_rate || '0']);
        await conn.query("UPDATE settings SET setting_value = ? WHERE setting_key = 'tax_name'", [tax_name || 'GST']);

        req.flash('success_msg', 'Tax & Company settings saved successfully.');
        res.redirect('/admin/taxes');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to save settings.');
        res.redirect('/admin/taxes');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Coupons List
router.get('/coupons', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const coupons = await conn.query("SELECT * FROM coupons ORDER BY created_at DESC");
        res.render('admin/coupons', { coupons });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Create Coupon
router.post('/coupons/create', async (req, res) => {
    let conn;
    try {
        const { code, discount, max_uses } = req.body;
        conn = await db.getConnection();
        await conn.query("INSERT INTO coupons (code, discount_percent, max_uses) VALUES (?, ?, ?)", [code, discount, max_uses || 0]);
        req.flash('success_msg', 'Coupon created successfully.');
        res.redirect('/admin/coupons');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to create coupon.');
        res.redirect('/admin/coupons');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Delete Coupon
router.post('/coupons/delete/:id', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        await conn.query("DELETE FROM coupons WHERE id = ?", [req.params.id]);
        req.flash('success_msg', 'Coupon deleted.');
        res.redirect('/admin/coupons');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to delete coupon.');
        res.redirect('/admin/coupons');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Gateways List
router.get('/gateways', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const gateways = await conn.query("SELECT * FROM payment_gateways");
        // Parse config JSON safely
        gateways.forEach(g => {
            if (typeof g.config === 'string') {
                try { g.config = JSON.parse(g.config || '{}'); } catch (e) { g.config = {}; }
            } else if (!g.config) {
                g.config = {};
            }
        });
        res.render('admin/gateways', { gateways });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Update Gateway
router.post('/gateways/update', async (req, res) => {
    let conn;
    try {
        const { id, enabled } = req.body;

        conn = await db.getConnection();

        // Get existing config first
        const existing = await conn.query("SELECT name, config FROM payment_gateways WHERE id = ?", [id]);
        let configObj = {};
        if (existing[0] && existing[0].config) {
            try {
                configObj = typeof existing[0].config === 'string' ? JSON.parse(existing[0].config) : existing[0].config;
            } catch (e) {
                configObj = {};
            }
        }

        const gatewayName = existing[0]?.name || '';
        console.log('[Gateway Update] ID:', id, 'Name:', gatewayName);
        console.log('[Gateway Update] Body:', req.body);

        // Merge new values based on gateway type
        if (gatewayName === 'stripe') {
            if (req.body.stripe_public_key !== undefined) configObj.publicKey = req.body.stripe_public_key;
            if (req.body.stripe_secret_key !== undefined) configObj.secretKey = req.body.stripe_secret_key;
        } else if (gatewayName === 'paypal') {
            if (req.body.paypal_client_id !== undefined) configObj.clientId = req.body.paypal_client_id;
            if (req.body.paypal_secret !== undefined) configObj.secret = req.body.paypal_secret;
        } else if (gatewayName === 'phonepe') {
            console.log('[Gateway Update] PhonePe detected. Updating config...');
            if (req.body.phonepe_client_id !== undefined) configObj.clientId = req.body.phonepe_client_id;
            if (req.body.phonepe_client_secret !== undefined) configObj.clientSecret = req.body.phonepe_client_secret;
            if (req.body.phonepe_client_version !== undefined) configObj.clientVersion = parseInt(req.body.phonepe_client_version) || 1;
            if (req.body.phonepe_env !== undefined) configObj.environment = req.body.phonepe_env;
            if (req.body.phonepe_webhook_username !== undefined) configObj.webhookUsername = req.body.phonepe_webhook_username;
            if (req.body.phonepe_webhook_password !== undefined) configObj.webhookPassword = req.body.phonepe_webhook_password;
        }

        console.log('[Gateway Update] Final Config:', configObj);

        await conn.query("UPDATE payment_gateways SET enabled = ?, config = ? WHERE id = ?", [enabled === 'on' ? 1 : 0, JSON.stringify(configObj), id]);

        req.flash('success_msg', 'Gateway updated.');
        res.redirect('/admin/gateways');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update gateway.');
        res.redirect('/admin/gateways');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Currencies List
router.get('/currencies', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const currencies = await conn.query("SELECT * FROM currencies");
        res.render('admin/currencies', { currencies });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Add Currency
router.post('/currencies/add', async (req, res) => {
    let conn;
    try {
        const { code, symbol, rate } = req.body;
        conn = await db.getConnection();
        await conn.query("INSERT INTO currencies (code, symbol, rate_to_usd) VALUES (?, ?, ?)", [code.toUpperCase(), symbol, rate]);
        req.flash('success_msg', 'Currency added.');
        res.redirect('/admin/currencies');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to add currency.');
        res.redirect('/admin/currencies');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Edit Rate
router.post('/currencies/edit-rate', async (req, res) => {
    let conn;
    try {
        const { code, rate } = req.body;
        conn = await db.getConnection();
        await conn.query("UPDATE currencies SET rate_to_usd = ? WHERE code = ?", [rate, code]);
        req.flash('success_msg', 'Rate updated.');
        res.redirect('/admin/currencies');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update rate.');
        res.redirect('/admin/currencies');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Toggle Currency Status
router.post('/currencies/update', async (req, res) => {
    let conn;
    try {
        const { code, is_active } = req.body; // is_active will be '1' or '0'
        conn = await db.getConnection();
        await conn.query("UPDATE currencies SET is_active = ? WHERE code = ?", [is_active, code]);
        req.flash('success_msg', 'Status updated.');
        res.redirect('/admin/currencies');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update status.');
        res.redirect('/admin/currencies');
    } finally {
        if (conn) conn.release();
    }
});

// Theme Management
router.get('/theme', async (req, res) => {
    try {
        const SettingsService = require('../services/settings');
        const adminTheme = await SettingsService.getPrivilegedSettings('theme_');

        res.render('admin/theme', {
            adminTheme: adminTheme || {},
            path: '/admin/theme',
            user: req.session.user
        });
    } catch (err) {
        console.error("Theme Route Error:", err);
        res.redirect('/admin');
    }
});

router.post('/theme', async (req, res) => {
    try {
        const SettingsService = require('../services/settings');
        // Filter body for keys starting with theme_
        const updates = [];
        for (const [key, value] of Object.entries(req.body)) {
            if (key.startsWith('theme_') && value) {
                updates.push(SettingsService.set(key, value));
            }
        }
        await Promise.all(updates);
        req.flash('success_msg', 'Theme updated successfully');
        res.redirect('/admin/theme');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error updating theme');
        res.redirect('/admin/theme');
    }
});

router.post('/theme/reset', async (req, res) => {
    try {
        const SettingsService = require('../services/settings');
        // Delete all theme settings
        const currentTheme = await SettingsService.getPrivilegedSettings('theme_');
        const deletions = [];
        for (const key of Object.keys(currentTheme)) {
            deletions.push(SettingsService.delete(key));
        }
        await Promise.all(deletions);

        req.flash('success_msg', 'Theme reset to default');
        res.redirect('/admin/theme');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Error resetting theme');
        res.redirect('/admin/theme');
    }
});



// Admin: Radar Dashboard
router.get('/radar', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const servers = await conn.query(`
            SELECT active_servers.*, users.username
            FROM active_servers 
            LEFT JOIN users ON active_servers.user_id = users.id
            ORDER BY active_servers.radar_status = 'danger' DESC, active_servers.radar_status = 'warning' DESC, active_servers.id DESC
        `);

        // Get all radar settings
        const settingsResult = await conn.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'radar_%' OR setting_key = 'ptero_url'");
        const radarSettings = {};
        settingsResult.forEach(r => radarSettings[r.setting_key] = r.setting_value);

        res.render('admin/radar', {
            servers,
            radarInterval: radarSettings.radar_scan_interval || '30',
            radarEnabled: radarSettings.radar_enabled !== 'false' ? 'true' : 'false',
            radarSuspiciousFiles: radarSettings.radar_suspicious_files || 'xmrig, minerd, cpuminer, .sh.x, wallet.dat, mining',
            radarIgnoreFiles: radarSettings.radar_ignore_files || '',
            radarDiscordAlerts: radarSettings.radar_discord_alerts || 'false',
            pteroUrl: radarSettings.ptero_url || ''
        });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Save Radar Settings
router.post('/radar/settings', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        // Radar Enabled
        const radarEnabled = req.body.radar_enabled ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('radar_enabled', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [radarEnabled, radarEnabled]);

        // Scan Interval
        const radarInterval = parseInt(req.body.radar_scan_interval) || 30;
        const clampedInterval = Math.min(Math.max(radarInterval, 5), 1440);
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('radar_scan_interval', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [String(clampedInterval), String(clampedInterval)]);

        // Discord Alerts
        const discordAlerts = req.body.radar_discord_alerts ? 'true' : 'false';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('radar_discord_alerts', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [discordAlerts, discordAlerts]);

        // Suspicious Files
        const suspiciousFiles = req.body.radar_suspicious_files || 'xmrig, minerd, cpuminer, .sh.x, wallet.dat, mining';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('radar_suspicious_files', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [suspiciousFiles, suspiciousFiles]);

        // Ignore Patterns
        const ignoreFiles = req.body.radar_ignore_files || '';
        await conn.query("INSERT INTO settings (setting_key, setting_value) VALUES ('radar_ignore_files', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
            [ignoreFiles, ignoreFiles]);

        req.flash('success_msg', 'Radar settings saved successfully. Restart the server to apply interval changes.');
        res.redirect('/admin/radar');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to save radar settings.');
        res.redirect('/admin/radar');
    } finally {
        if (conn) conn.release();
    }
});

// Admin: Manual Radar Scan
router.post('/radar/scan', async (req, res) => {
    try {
        const radar = require('../services/radar');
        // Run scan asynchronously to not block UI
        radar.scanAll();
        req.flash('success_msg', 'Radar scan initiated. Refresh the page in a few moments.');
        res.redirect('/admin/radar');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to start scan.');
        res.redirect('/admin/radar');
    }
});
// ================== AFFILIATE MANAGEMENT ==================

// Affiliates List
router.get('/affiliates', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const affiliates = await conn.query(`
            SELECT a.*, u.username, u.email,
            (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_id = a.id) as referral_count
            FROM affiliates a
            JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
        `);
        conn.release();
        res.render('admin/affiliates', { affiliates });
    } catch (err) {
        console.error(err);
        res.redirect('/admin');
    }
});

// Update Affiliate Status/Rate
router.post('/affiliates/:id/update', async (req, res) => {
    const { commission_rate, is_active } = req.body;
    let conn;
    try {
        conn = await db.getConnection();
        await conn.query("UPDATE affiliates SET commission_rate = ?, is_active = ? WHERE id = ?",
            [commission_rate, is_active ? 1 : 0, req.params.id]);
        conn.release();
        req.flash('success_msg', 'Affiliate updated successfully');
        res.redirect('/admin/affiliates');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to update affiliate');
        res.redirect('/admin/affiliates');
    }
});

// Payouts Management
router.get('/payouts', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const payouts = await conn.query(`
            SELECT p.*, a.referral_code, u.username
            FROM affiliate_payouts p
            JOIN affiliates a ON p.affiliate_id = a.id
            JOIN users u ON a.user_id = u.id
            ORDER BY p.created_at DESC
        `);
        conn.release();
        res.render('admin/payouts', { payouts });
    } catch (err) {
        console.error(err);
        res.redirect('/admin/affiliates');
    }
});

// Process Payout (Approve/Reject)
router.post('/payouts/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    let conn;
    try {
        conn = await db.getConnection();

        const [payout] = await conn.query("SELECT * FROM affiliate_payouts WHERE id = ?", [id]);
        if (!payout) {
            req.flash('error_msg', 'Payout not found');
            return res.redirect('/admin/payouts');
        }

        if (payout.status !== 'pending') {
            req.flash('error_msg', 'Payout is already processed');
            return res.redirect('/admin/payouts');
        }

        if (action === 'approve') {
            await conn.query("UPDATE affiliate_payouts SET status = 'paid', paid_at = NOW() WHERE id = ?", [id]);
            req.flash('success_msg', 'Payout marked as paid');
        } else if (action === 'reject') {
            // Transaction to refund the affiliate balance if rejected
            await conn.beginTransaction();
            await conn.query("UPDATE affiliate_payouts SET status = 'rejected' WHERE id = ?", [id]);
            await conn.query("UPDATE affiliates SET balance = balance + ? WHERE id = ?", [payout.amount, payout.affiliate_id]);
            await conn.commit();
            req.flash('success_msg', 'Payout rejected and balance refunded');
        }

        res.redirect('/admin/payouts');
    } catch (err) {
        if (conn) await conn.rollback();
        console.error(err);
        req.flash('error_msg', 'Failed to process payout');
        res.redirect('/admin/payouts');
    } finally {
        if (conn) conn.release();
    }
});

// ============================================================

// Admin: Global Settings (Branding, Maintenance, OAuth)
router.post('/settings', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const authService = require('../services/authService');

        // Helper to upsert
        const saveSetting = async (key, value) => {
            await conn.query(
                "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?",
                [key, value, value]
            );
        };

        // Branding & System
        if (req.body.site_name) await saveSetting('site_name', req.body.site_name);
        if (req.body.site_logo) await saveSetting('site_logo', req.body.site_logo);
        await saveSetting('maintenance', req.body.maintenance ? 'true' : 'false');
        await saveSetting('debug_mode', req.body.debug_mode ? 'true' : 'false');

        // Global Alert
        if (req.body.clear_alert) {
            await conn.query("DELETE FROM settings WHERE setting_key = 'global_alert'");
        } else if (req.body.alert_message) {
            const alertObj = {
                message: req.body.alert_message,
                type: req.body.alert_type || 'info'
            };
            await saveSetting('global_alert', JSON.stringify(alertObj));
        }

        // Pterodactyl
        if (req.body.ptero_url) await saveSetting('ptero_url', req.body.ptero_url);
        if (req.body.ptero_key) await saveSetting('ptero_key', req.body.ptero_key);
        if (req.body.ptero_client_api_key) await saveSetting('ptero_client_api_key', req.body.ptero_client_api_key);

        // Discord Webhook
        if (req.body.discord_webhook_url !== undefined) await saveSetting('discord_webhook_url', req.body.discord_webhook_url);

        // Regional Pricing JSON
        if (req.body.regional_pricing) await saveSetting('locations_config', req.body.regional_pricing);

        // OAuth Settings
        const oauthKeys = [
            'oauth_github_client_id', 'oauth_github_client_secret', 'oauth_github_enabled',
            'oauth_discord_client_id', 'oauth_discord_client_secret', 'oauth_discord_enabled',
            'oauth_google_client_id', 'oauth_google_client_secret', 'oauth_google_enabled',
            'oauth_apple_client_id', 'oauth_apple_enabled'
            // Skipping complex apple keys for now or handle if posted
        ];

        // Affiliate Settings
        if (req.body.affiliate_default_commission !== undefined) await saveSetting('affiliate_default_commission', req.body.affiliate_default_commission);
        if (req.body.affiliate_min_payout !== undefined) await saveSetting('affiliate_min_payout', req.body.affiliate_min_payout);

        for (const key of oauthKeys) {
            // checkboxes are 'true' if present, handle unchecked checkboxes for 'enabled' keys?
            // Actually checkboxes send value if checked, nothing if not.
            // For 'enabled' keys we should default to false if not in body, BUT only if we are processing a form that includes them.
            // Since this is a monolithic settings form, we can assume if they are missing it means false (unchecked).

            if (key.endsWith('_enabled')) {
                await saveSetting(key, req.body[key] === 'true' ? 'true' : 'false');
            } else {
                // Only update if present to avoid wiping existing secrets if field is empty (good practice for secrets)
                // But here we might want to allow clearing.
                // For now, let's just save whatever is sent.
                if (req.body[key] !== undefined) {
                    await saveSetting(key, req.body[key]);
                }
            }
        }

        conn.release();

        // Reload Strategies
        await authService.loadStrategies();

        req.flash('success_msg', 'Settings saved successfully.');
        res.redirect('/admin/settings');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Failed to save settings.');
        res.redirect('/admin/settings');
    } finally {
        if (conn) conn.release();
    }
});

module.exports = router;
