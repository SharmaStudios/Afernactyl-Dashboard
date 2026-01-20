const SettingsService = require('../services/settings');

/**
 * Middleware to inject theme settings into res.locals
 * enabling dynamic CSS variables in views
 */
const themeMiddleware = async (req, res, next) => {
    try {
        // Fetch all settings starting with 'theme_'
        // We're keeping the 'theme_' prefix in the db, and passing it to the view
        // The view will handle mapping these to CSS variables
        const themeSettings = await SettingsService.getPrivilegedSettings('theme_');

        // Pass to locals so it's available in all views (like header.ejs)
        res.locals.theme = themeSettings;

        next();
    } catch (err) {
        console.error('Theme Middleware Error:', err);
        // Don't block the app if theme fails, just proceed with defaults
        res.locals.theme = {};
        next();
    }
};

module.exports = themeMiddleware;
