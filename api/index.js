// api/index.js
const serverless = require('serverless-http');
// `app.js` now default-exports the Express app (module.exports = app)
// so require the module directly instead of destructuring a named export.
const app = require('../app');

module.exports = serverless(app);
