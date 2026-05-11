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
  if (req.body)   req.body   = sanitize(req.body);
  if (req.query)  req.query  = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
}

module.exports = sanitizeMiddleware;
