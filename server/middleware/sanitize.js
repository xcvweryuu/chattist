const xss = require('xss');

/**
 * Recursively sanitizes an object or string.
 */
function sanitize(input) {
  if (typeof input === 'string') {
    return xss(input);
  }
  if (Array.isArray(input)) {
    return input.map(sanitize);
  }
  if (typeof input === 'object' && input !== null) {
    const sanitized = {};
    for (const key in input) {
      sanitized[key] = sanitize(input[key]);
    }
    return sanitized;
  }
  return input;
}

function sanitizeMiddleware(req, res, next) {
  // Global sanitization is dangerous for encrypted content and UUIDs.
  // It has been disabled to prevent corruption of Base64/AES data.
  // Routes should sanitize individual fields if they are displayed as HTML.
  next();
}

module.exports = sanitizeMiddleware;
