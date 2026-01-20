const db = require('../config/database');

/**
 * Calculate and award commission to an affiliate when an invoice is paid.
 * @param {number} invoiceId - The ID of the paid invoice.
 * @param {object} conn - Optional database connection to use within a transaction.
 */
async function processCommission(invoiceId, conn) {
    let connection = conn;
    let shouldRelease = false;

    try {
        if (!connection) {
            connection = await db.getConnection();
            shouldRelease = true;
        }

        // 1. Get invoice and user details
        const [invoice] = await connection.query(`
            SELECT i.*, u.referred_by 
            FROM invoices i 
            JOIN users u ON i.user_id = u.id 
            WHERE i.id = ? AND i.status = 'paid'
        `, [invoiceId]);

        if (!invoice || !invoice.referred_by) {
            console.log(`[Affiliate] No commission for invoice #${invoiceId} (No referrer)`);
            return;
        }

        // 2. Get affiliate details
        const [affiliate] = await connection.query("SELECT * FROM affiliates WHERE id = ? AND is_active = 1", [invoice.referred_by]);
        if (!affiliate) {
            console.log(`[Affiliate] Referrer for invoice #${invoiceId} is not an active affiliate`);
            return;
        }

        // 3. Determine commission rate
        let commissionRate = parseFloat(affiliate.commission_rate);
        if (commissionRate === 0) {
            const [defaultRateSetting] = await connection.query("SELECT setting_value FROM settings WHERE setting_key = 'affiliate_default_commission'");
            commissionRate = parseFloat(defaultRateSetting?.setting_value || 10);
        }

        // 4. Calculate commission amount (based on invoice amount in USD)
        const commissionAmount = (parseFloat(invoice.amount) * commissionRate) / 100;

        if (commissionAmount <= 0) return;

        // 5. Update affiliate balance
        await connection.query("UPDATE affiliates SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?",
            [commissionAmount, commissionAmount, affiliate.id]);

        console.log(`[Affiliate] Awarded $${commissionAmount.toFixed(2)} commission to affiliate #${affiliate.id} for invoice #${invoiceId}`);

    } catch (err) {
        console.error(`[Affiliate] Error processing commission for invoice #${invoiceId}:`, err);
    } finally {
        if (shouldRelease && connection) connection.release();
    }
}

module.exports = {
    processCommission
};
