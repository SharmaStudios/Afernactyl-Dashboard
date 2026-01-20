const db = require('../config/database');

/**
 * Middleware to check for ?ref=CODE in the URL and set a cookie.
 */
async function referralTracker(req, res, next) {
    const refCode = req.query.ref;

    if (refCode) {
        try {
            const conn = await db.getConnection();
            const [affiliate] = await conn.query("SELECT id FROM affiliates WHERE referral_code = ? AND is_active = 1", [refCode]);
            conn.release();

            if (affiliate) {
                // Set cookie for 30 days (default)
                // We'll try to fetch the setting, but fallback to 30 if not found easily in this context
                // Setting cookies with a standard 30 day expiry
                const expiryDate = new Date();
                expiryDate.setDate(expiryDate.getDate() + 30);

                res.cookie('affiliate_ref', refCode, {
                    expires: expiryDate,
                    httpOnly: true,
                    path: '/'
                });

                console.log(`[Affiliate] Referral cookie set for code: ${refCode}`);
            }
        } catch (err) {
            console.error("[Affiliate] Error in referral tracker middleware:", err);
        }
    }

    next();
}

module.exports = referralTracker;
