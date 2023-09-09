const crypto = require("crypto");

function checkToken(id, queryToken, realToken, maxTimeStampAge, logger) {
    const tokens = queryToken.split("-");
    if (tokens.length < 2) {
        return false
    }
    const now = Date.now()/1000;
    const sign = tokens[0];
    const tsStr = tokens[1];
    const ts = Number(tsStr);
    if (ts < now - maxTimeStampAge || ts > now + maxTimeStampAge) {
        logger.warn(`ts expired for ${now - ts}`)
        return false;
    }
    const hmac = crypto.createHmac("md5", realToken);
    const up = hmac.update(tsStr + id);
    const realSign = (up.digest("hex")).substring(0, 8);
    if (sign !== realSign) {
        logger.warn(`token not match`);
        return false;
    }
}

function readJson(res, cb, err) {
    let buffer;
    /* Register data cb */
    res.onData((ab, isLast) => {
        let chunk = Buffer.from(ab);
        if (isLast) {
            let json;
            if (buffer) {
                try {
                    json = JSON.parse(Buffer.concat([buffer, chunk]));
                } catch (e) {
                    /* res.close calls onAborted */
                    res.close();
                    return;
                }
                cb(json);
            } else {
                try {
                    json = JSON.parse(chunk);
                } catch (e) {
                    /* res.close calls onAborted */
                    res.close();
                    return;
                }
                cb(json);
            }
        } else {
            if (buffer) {
                buffer = Buffer.concat([buffer, chunk]);
            } else {
                buffer = Buffer.concat([chunk]);
            }
        }
    });

    /* Register error cb */
    res.onAborted(err);
}

function setCorsHeaders(response) {
    // You can change the below headers as they're just examples
    response.writeHeader("Access-Control-Allow-Origin", "*");
    response.writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.writeHeader("Content-Type", "application/json");
}

module.exports = {
    checkToken,
    readJson,
    setCorsHeaders,
}
