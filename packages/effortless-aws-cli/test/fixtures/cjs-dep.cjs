// Simulates a CJS dependency that uses require() for a Node.js builtin
const util = require("util");
module.exports.inspect = util.inspect;
