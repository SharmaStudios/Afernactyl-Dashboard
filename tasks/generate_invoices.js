/**
 * Scheduled Task: Auto-generate invoices 5 days before server due date
 * Run this via cron: node /path/to/tasks/generate_invoices.js
 * Recommended schedule: Daily at midnight (0 0 * * *)
 */

const db = require('../config/database');
const emailService = require('../services/email');

async function generateUpcomingInvoices() {
    let conn;
    try {
        conn = await db.getConnection();
        console.log('[Invoice Generator] Starting auto invoice generation...');

        // Find active servers with renewal_date within 5 days that don't have a pending invoice
        const upcomingServers = await conn.query(`
            SELECT 
                s.*, 
                p.name as plan_name, 
                p.price as plan_price,
                u.email,
                u.username,
                u.preferred_currency
            FROM active_servers s
            JOIN Plans p ON s.plan_id = p.id
            JOIN users u ON s.user_id = u.id
            WHERE s.status = 'active'
            AND s.renewal_date IS NOT NULL
            AND s.renewal_date <= DATE_ADD(NOW(), INTERVAL 5 DAY)
            AND s.renewal_date > NOW()
            AND NOT EXISTS (
                SELECT 1 FROM invoices i 
                WHERE i.user_id = s.user_id 
                AND i.plan_id = s.plan_id
                AND i.status = 'pending'
                AND i.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
            )
        `);

        console.log(`[Invoice Generator] Found ${upcomingServers.length} servers needing invoices.`);

        for (const server of upcomingServers) {
            try {
                // Get currency info for user
                let currencyCode = server.preferred_currency || 'USD';
                let currencyAmount = server.plan_price;

                if (currencyCode !== 'USD') {
                    const currencyData = await conn.query("SELECT rate_to_usd FROM currencies WHERE code = ?", [currencyCode]);
                    if (currencyData.length > 0) {
                        currencyAmount = (server.plan_price * currencyData[0].rate_to_usd).toFixed(2);
                    }
                }

                // Create invoice with due date = server renewal date
                const result = await conn.query(`
                    INSERT INTO invoices 
                    (user_id, server_id, plan_id, amount, currency_code, currency_amount, status, type, description, due_date, subtotal, tax_rate, tax_amount)
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'renewal', ?, ?, ?, 0, 0)
                `, [
                    server.user_id,
                    server.id,
                    server.plan_id,
                    server.plan_price,
                    currencyCode,
                    currencyAmount,
                    `Server Renewal - ${server.server_name} (${server.plan_name})`,
                    server.renewal_date,
                    currencyAmount
                ]);

                const invoiceId = result.insertId;
                console.log(`[Invoice Generator] Created invoice #${invoiceId} for server "${server.server_name}" (User: ${server.username})`);

                // Send email notification
                try {
                    await emailService.sendInvoiceCreatedEmail(
                        { email: server.email, username: server.username },
                        {
                            id: invoiceId,
                            amount: currencyAmount,
                            currency_code: currencyCode,
                            description: `Server Renewal - ${server.server_name} (${server.plan_name})`,
                            due_date: server.renewal_date
                        }
                    );
                    console.log(`[Invoice Generator] Email sent to ${server.email}`);
                } catch (emailErr) {
                    console.error(`[Invoice Generator] Failed to send email to ${server.email}:`, emailErr.message);
                }

            } catch (serverErr) {
                console.error(`[Invoice Generator] Failed to process server ${server.id}:`, serverErr.message);
            }
        }

        console.log('[Invoice Generator] Complete.');
    } catch (err) {
        console.error('[Invoice Generator] Error:', err);
    } finally {
        if (conn) conn.release();
        // Only exit if running standalone
        if (require.main === module) {
            process.exit(0);
        }
    }
}

// Run if called directly (node tasks/generate_invoices.js)
if (require.main === module) {
    generateUpcomingInvoices();
}

module.exports = generateUpcomingInvoices;
