const crypto = require("crypto");

const generateApiKey = () => {
   return `proj_${crypto.randomBytes(24).toString("base64url")}`;
};

module.exports = generateApiKey;
