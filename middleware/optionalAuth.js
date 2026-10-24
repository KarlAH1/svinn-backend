const jwt = require("jsonwebtoken");

// Som requireAuth, men slipper forespørselen gjennom uten bruker hvis token mangler.
module.exports = function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {
      // ugyldig token behandles som anonym
    }
  }
  next();
};
