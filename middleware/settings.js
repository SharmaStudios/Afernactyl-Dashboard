const db = require('../config/database');

module.exports = async (req, res, next) => {
    // Default values to prevent ReferenceErrors in views
    res.locals.global_alert = null;
    res.locals.availableCurrencies = [];
    res.locals.currentCurrency = 'USD';
    res.locals.currentCurrencySymbol = '$';
    res.locals.site_name = 'Afernactyl';
    res.locals.site_logo = '';

    try {
        const conn = await db.getConnection();
        const settings = await conn.query("SELECT * FROM settings");

        const alertSetting = settings.find(s => s.setting_key === 'global_alert');
        res.locals.global_alert = alertSetting ? JSON.parse(alertSetting.setting_value) : null;

        // Load branding settings
        const siteNameSetting = settings.find(s => s.setting_key === 'site_name');
        const siteLogoSetting = settings.find(s => s.setting_key === 'site_logo');
        res.locals.site_name = siteNameSetting?.setting_value || 'Afernactyl';
        res.locals.site_logo = siteLogoSetting?.setting_value || '';

        // Reuse connection for currencies if possible, or just query again.
        // Since we didn't release yet... oh wait, original code released conn.
        // Let's just use same connection.
        const currencies = await conn.query("SELECT * FROM currencies WHERE is_active = 1");
        conn.release();

        res.locals.availableCurrencies = currencies;

        // Initialize Session Currency if valid, else default to USD
        if (!req.session.currency) {
            req.session.currency = 'USD';
        } else {
            // Validate that session currency is still active
            const isValid = currencies.find(c => c.code === req.session.currency);
            if (!isValid) req.session.currency = 'USD';
        }
        res.locals.currentCurrency = req.session.currency;
        res.locals.currentCurrencySymbol = currencies.find(c => c.code === req.session.currency)?.symbol || '$';

        next();
    } catch (err) {
        console.error('Settings Middleware Error:', err);
        next();
    }
};
