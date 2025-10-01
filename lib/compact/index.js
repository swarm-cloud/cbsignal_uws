
const {
    AttributeRepalceMap,
    FieldReplaceMap,
    HashFuncMap,
    MediaConnectionAddressTypeMap,
    MediaConnectionIPMap,
    candidateEncode,
    mediaEncode,
} = require("./dict.js");
const FingerprintToBase64 = require( "./base64.js");

/**
 * Compact a RTCSessionDescription
 *
 * @param rtcSessionDesc The `RTCSessionDescriptionInit` to compact.
 * @returns The compacted `RTCSessionDescriptionInit` string.
 */
module.exports = (target) => {
    if (target.type === 'candidate') {
        if (!target.candidate) {
            return null
        }
        const { candidate } = target.candidate
        if (!candidate) {
            return null
        }
        const comp = compactCond(candidate);
        return "C" + comp;
    }
    const sdp = target.sdp;
    if (!sdp || !sdp.startsWith("v=0")) {
        return null
    }
    const comp = compactSDP(sdp);

    return (target.type === "offer" ? "O" : "A") + comp;
};

/**
 * Compact a Session Description Protocol (SDP) string
 *
 * @param sdpStr The SDP string to compact.
 * @param newOptions The options.
 * @returns The compacted SDP string.
 */
const compactSDP = (sdpStr) => {

    sdpStr = compactSDPStr(sdpStr);

    return sdpStr;
};

const compactCond = (condStr) => {

    condStr = compactCondStr(condStr);

    return condStr;
}

function compactCondStr(condStr) {
    const str = condStr.startsWith('a=candidate:') ? condStr.slice(12) : condStr.slice(10);
    return candidateEncode(str);
}

function compactSDPStr(sdpStr) {
    const sdp = sdpStr.split("\r\n");
    let compactSDP = [];

    sdp.forEach((line) => {
        if (line.startsWith("v=")) {
            return;
        }

        if (line.startsWith("s=")) {
            return;
        }

        if (line.startsWith("t=")) {
            return;
        }

        if (line.startsWith("a=extmap-allow-mixed")) {
            return;
        }

        if (line.startsWith("a=sctpmap:")) {
            return;
        }

        if (
            line.startsWith("a=msid-semantic:")
        ) {
            return;
        }

        if (line.startsWith("o=")) {
            // `o=<username> <sessID> <sessVersion> <netType> <addrType> <unicastAddress>`
            let origin = line.slice(2).split(" ");
            let newOrgin = [];

            // username
            // if (options.origin.username === undefined) {
            //   newOrgin.push(origin[0]);
            // }

            // sessID
            // if (options.origin.sessionId === undefined) {
            newOrgin.push(origin[1]);
            // }

            if (!line.endsWith('2 IN IP4 127.0.0.1')) {
                // sessVersion
                newOrgin.push(origin[2]);
                if (!line.endsWith('IN IP4 127.0.0.1')) {
                    // addrType
                    // if (options.origin.addrtype === undefined) {
                    newOrgin.push(origin[4]);
                    // }

                    // unicastAddress
                    // if (options.origin.unicastAddress === undefined) {
                    newOrgin.push(origin[5]);
                    // }
                }
            }

            compactSDP.push(`o=${newOrgin.join(" ")}`);
            return;
        }

        if (line.startsWith("a=group:")) {
            return;
        }

        if (line.startsWith("a=mid:")) {
            return;
        }

        if (line.startsWith("a=setup:")) {
            return;
        }

        if (
            line === "a=ice-options:trickle"
        ) {
            compactSDP.push("I");
            return;
        }

        if (
            line === "a=ice-options:ice2,trickle"
        ) {
            compactSDP.push("Z");
            return;
        }

        if (
            line === "a=sendrecv"
        ) {
            compactSDP.push("B");
            return;
        }

        if (line.startsWith("m=")) {
            line = mediaEncode(line);
            compactSDP.push(line);
            return;
        }

        if (
            line.startsWith("a=candidate:")
        ) {
            line = candidateEncode(line);
            compactSDP.push(line);
            return;
        }

        if (
            line.startsWith("a=fingerprint:")
        ) {
            let [hashMethod, fingerprint] = line.slice(14).split(" ");
            if (hashMethod in HashFuncMap) {
                hashMethod = HashFuncMap[hashMethod];
            }
            fingerprint = FingerprintToBase64.encode(fingerprint);
            compactSDP.push(`a=fingerprint:${hashMethod} ${fingerprint}`);
            return;
        }

        if (line.startsWith("c=")) {
            // network type (IN for Internet), address type (IP4), and the connection address (115.87.239.220)
            let [networkType, addressType, ip] = line.slice(2).split(" ");
            if (addressType in MediaConnectionAddressTypeMap) {
                addressType = MediaConnectionAddressTypeMap[addressType];
            }
            if (ip in MediaConnectionIPMap) {
                ip = MediaConnectionIPMap[ip];
            }
            compactSDP.push(`c=${addressType} ${ip}`);
            return;
        }

        compactSDP.push(line);
    });

    compactSDP = compactSDP.map((line) => {
        let field = line.slice(0, 2);
        let value = line.slice(2);

        // replace attributes
        if (field === "a=") {
            let [attr, ...subValue] = value.split(":");
            attr = attr + ":";

            if (attr in AttributeRepalceMap) {
                attr = AttributeRepalceMap[attr];
                value = attr + subValue.join(":");
            }
        }

        if (field in FieldReplaceMap) {
            field = FieldReplaceMap[field];
        }

        return field + value;
    });

    return compactSDP.join("~");
}
