const db = require('../config/database');

module.exports = {
    ensureAuthenticated: (req, res, next) => {
        if (req.session.user) {
            return next();
        }
        req.flash('error_msg', 'Please log in to view that resource');
        res.redirect('/auth/login');
    },
    ensureAdmin: (req, res, next) => {
        // Allow if user is admin OR if there's an originalAdmin in session (impersonating)
        if (req.session.user && (req.session.user.is_admin || req.session.originalAdmin)) {
            return next();
        }
        req.flash('error_msg', 'Access denied');
        res.redirect('/dashboard');
    },
    checkSuspended: async (req, res, next) => {
        // Skip suspension check for certain routes (tickets for appeal)
        const allowedPaths = ['/suspended', '/tickets', '/logout', '/auth/logout'];

        // Check if current path starts with any allowed path
        const isAllowed = allowedPaths.some(path => {
            // The full URL path for dashboard routes would be without /dashboard prefix
            // since this middleware runs on /dashboard routes
            return req.path === path || req.path.startsWith(path + '/');
        });

        if (isAllowed) {
            return next();
        }

        if (!req.session.user) {
            return next();
        }

        // Don't check if impersonating (admin bypasses suspension)
        if (req.session.originalAdmin) {
            return next();
        }

        let conn;
        try {
            conn = await db.getConnection();
            const user = await conn.query("SELECT is_suspended, suspension_reason FROM users WHERE id = ?", [req.session.user.id]);

            if (user.length > 0 && user[0].is_suspended) {
                // Debug mode shows logout button
                const debugMode = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';
                return res.render('suspended', {
                    suspensionReason: user[0].suspension_reason,
                    debugMode: debugMode
                });
            }

            next();
        } catch (err) {
            console.error('Error checking suspension status:', err);
            next();
        } finally {
            if (conn) conn.release();
        }
    }
};
